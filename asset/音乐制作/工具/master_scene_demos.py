"""Master offline renders and install AAC outputs. Requires macOS afconvert + numpy.
Usage: python3 master_scene_demos.py /path/to/raw-render-directory [manifest.json] [version]

Manifest rows may add a fourth project-relative install path. Without it, a
track is installed in asset/音乐/通用/<scene>/ as before.
"""
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
SONGS = [('town', '城镇·灯下旅人', -22), ('explore', '探索·雾径微光', -24.5), ('battle', '战斗·铁火前行', -20.5)]


def read_float_wav(path):
    data = path.read_bytes()
    assert data[:4] == b'RIFF' and data[8:12] == b'WAVE'
    offset = 12
    fmt = pcm = None
    while offset + 8 <= len(data):
        name, size = struct.unpack_from('<4sI', data, offset)
        block = data[offset + 8:offset + 8 + size]
        if name == b'fmt ': fmt = struct.unpack_from('<HHIIHH', block)
        if name == b'data': pcm = block
        offset += 8 + size + (size % 2)
    assert fmt is not None and fmt[0] == 3 and fmt[1] == 2 and fmt[2] == 44100 and fmt[5] == 32
    assert pcm is not None
    return np.frombuffer(pcm, dtype='<f4').reshape(-1, 2).astype(np.float64)


def db(value):
    return round(20 * math.log10(max(float(value), 1e-12)), 3)


def metrics(audio):
    assert np.isfinite(audio).all()
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio ** 2)))
    assert rms > 1e-5 and peak < 1
    return dict(seconds=len(audio) / 44100, sampleRate=44100, channels=2,
                samplePeakDBFS=db(peak), rmsDBFS=db(rms), clippedSamples=int(np.sum(np.abs(audio) >= 1)),
                boundaryJump=float(np.max(np.abs(audio[-1] - audio[0]))))


def main():
    raw_root = Path(sys.argv[1])
    songs = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 else SONGS
    version = sys.argv[3] if len(sys.argv) > 3 else 'v001'
    assert version.startswith('v') and version[1:].isdigit()
    for item in songs:
        if len(item) not in (3, 4):
            raise ValueError('渲染清单每项必须是 [slug, title, target] 或 [slug, title, target, installPath]')
        slug, title, target = item[:3]
        install_path = item[3] if len(item) == 4 else ''
        folder = ROOT / 'asset/音乐制作/通用' / title
        score = json.loads((folder / (version + '-乐谱.json')).read_text())
        x = read_float_wav(raw_root / (slug + '.wav'))
        assert len(x) == round(score['lengthBeats'] * 60 / score['bpm'] * 44100)
        x -= x.mean(axis=0)
        # A 12 ms taper at both boundaries controls clicks without changing length.
        fade_in = round(float(score.get('fadeInSeconds', .012)) * 44100)
        fade_out = round(float(score.get('fadeOutSeconds', .012)) * 44100)
        assert 2 <= fade_in < len(x) and 2 <= fade_out < len(x)
        x[:fade_in] *= (np.sin(np.linspace(0, np.pi / 2, fade_in)) ** 2)[:, None]
        x[-fade_out:] *= (np.sin(np.linspace(0, np.pi / 2, fade_out)) ** 2)[::-1, None]
        gain = min(10 ** (target / 20) / np.sqrt(np.mean(x ** 2)),
                   10 ** (-2 / 20) / np.max(np.abs(x)))
        x *= gain
        rng = np.random.default_rng(score['seed'])
        dither = (rng.random(x.shape) - rng.random(x.shape)) / 32768
        quantized = np.rint((x + dither) * 32768).astype('<i2')
        quantized[0] = 0
        quantized[-1] = 0
        master = folder / ('母带/' + version + '-定稿.wav')
        with wave.open(str(master), 'wb') as out:
            out.setparams((2, 2, 44100, 0, 'NONE', 'not compressed'))
            out.writeframes(quantized.tobytes())
        final = (ROOT / install_path) if install_path else (
            ROOT / 'asset/音乐/通用' / score['scene'] / (title + '.m4a')
        )
        final = final.resolve()
        if ROOT.resolve() not in final.parents:
            raise ValueError('正式输出路径必须位于项目内：' + str(final))
        final.parent.mkdir(parents=True, exist_ok=True)
        candidate = folder / ('候选/' + version + '-a.m4a')
        subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac ', '-b', '256000', str(master), str(candidate)], check=True)
        decoded = raw_root / (slug + '-decoded.wav')
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16', str(candidate), str(decoded)], check=True)
        with wave.open(str(decoded), 'rb') as inp:
            assert inp.getframerate() == 44100 and inp.getnchannels() == 2
            aac_audio = np.frombuffer(inp.readframes(inp.getnframes()), dtype='<i2').reshape(-1, 2) / 32768
        report = dict(title=title, version=version, gainDB=db(gain), targetRMSDBFS=target,
                      master=metrics(quantized.astype(float) / 32768), decodedAAC=metrics(aac_audio),
                      finalBytes=candidate.stat().st_size, finalPath=str(final.relative_to(ROOT)))
        assert abs(report['decodedAAC']['seconds'] - report['master']['seconds']) < .1
        shutil.copyfile(candidate, final)
        (folder / (version + '-音频检查.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
