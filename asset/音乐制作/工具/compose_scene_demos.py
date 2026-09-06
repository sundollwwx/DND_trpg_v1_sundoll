"""Original scene sketches, v001. Writes editable scores and standard MIDI, never audio.
Run from the project root with Python 3. Uses only the standard library.
"""
import json, random, struct
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'asset/音乐制作/通用'


def instrument(name, program, gain, pan=0, percussion=False):
    return dict(name=name, program=program, gain=gain, pan=pan, percussion=percussion)


def vlq(value):
    value = max(0, int(value)); data = [value & 127]; value >>= 7
    while value: data.insert(0, (value & 127) | 128); value >>= 7
    return bytes(data)


def write_midi(score, destination):
    ppq = 480
    tempo = round(60000000 / score['bpm'])
    meter = score['meter']
    chunks = [b'\x00\xff\x51\x03' + tempo.to_bytes(3, 'big') + b'\x00\xff\x58\x04' + bytes([meter,2,24,8]) + b'\x00\xff\x2f\x00']
    for i, inst in enumerate(score['instruments']):
        channel = 9 if inst['percussion'] else i
        events = [(0,0,bytes([0xc0|channel,inst['program']])), (0,0,bytes([0xb0|channel,10,round((inst['pan']+100)*127/200)])), (0,0,bytes([0xb0|channel,7,90]))]
        for note in score['notes']:
            if note['instrument'] != i: continue
            events += [(round(note['beat']*ppq),2,bytes([0x90|channel,note['pitch'],note['velocity']])),(round((note['beat']+note['duration'])*ppq),1,bytes([0x80|channel,note['pitch'],0]))]
        events.sort(key=lambda e:(e[0],e[1])); data=bytearray(); last=0
        for tick,_,message in events: data += vlq(tick-last)+message; last=tick
        data += vlq(max(0,round(score['lengthBeats']*ppq)-last))+b'\xff\x2f\x00';chunks.append(bytes(data))
    destination.write_bytes(b'MThd'+struct.pack('>IHHH',6,1,len(chunks),ppq)+b''.join(b'MTrk'+struct.pack('>I',len(c))+c for c in chunks))


def make_score(title, scene, bpm, meter, bars, instruments, brief, harmony, form, reverb, seed):
    score=dict(version='v001',title=title,scene=scene,bpm=bpm,meter=meter,lengthBeats=meter*bars,instruments=instruments,notes=[],brief=brief,harmony=harmony,form=form,reverb=reverb,seed=seed)
    rng=random.Random(seed)
    def add(inst,beat,pitch,duration,velocity):
        # A deterministic small timing/velocity variation. Boundary notes remain on the grid.
        beat=round(max(0,beat+(rng.uniform(-.013,.013) if beat%meter else 0)),5)
        duration=round(min(duration,score['lengthBeats']-beat-.02),5)
        if duration<=0:return
        score['notes'].append(dict(instrument=inst,beat=beat,pitch=pitch,duration=duration,velocity=max(12,min(110,velocity+rng.randint(-3,3)))))
    return score,add


def town():
    title='城镇·灯下旅人'
    s,n=make_score(title,'城镇',96,3,48,[instrument('尼龙弦吉他',24,-5,-24),instrument('竖琴',46,-15,30),instrument('长笛',73,-8,7),instrument('单簧管',71,-13,-10),instrument('大提琴',42,-14,-5),instrument('轻打击乐',0,-20,12,True)],
        '原创奇幻城镇背景音乐，纯器乐，D 大调，96 BPM，3/4。以尼龙弦吉他的分解和弦、温和长笛与单簧管呼应为核心，竖琴只作点缀，大提琴低声支撑，轻铃鼓不抢对白。旋律有八小节问答，第二段抬高音区，中段适当留白，最后回到开头。目标是灯火下有人来往的小酒馆与友善街道；不使用歌词、合唱、现成旋律或夸张高潮。',
        'D – G – D – A / Bm – G – Em – A','A 8小节 / B 8 / A变奏 8 / 间奏 8 / B变奏 8 / A回归 8',14,90501)
    chords=[[50,57,62,66],[43,55,59,62],[50,57,62,66],[45,57,61,64],[47,54,59,62],[43,55,59,62],[40,52,55,59],[45,57,61,64]]
    melody=[[(0,78,1),(1,76,.5),(1.5,74,.5),(2,69,.78)],[(0,71,.5),(.5,74,.5),(1,79,1),(2,78,.5),(2.5,76,.4)],[(0,78,1.5),(1.5,76,.5),(2,74,.8)],[(0,73,.5),(.5,76,.5),(1,81,1),(2,76,.72)],[(0,78,.5),(.5,78,.5),(1,81,1),(2,78,.72)],[(0,79,1),(1,78,.5),(1.5,76,.5),(2,74,.78)],[(0,76,.75),(1,74,.75),(2,71,.78)],[(0,73,1),(1,76,.75),(2,69,.65)]]
    bmel=[[(0,81,1),(1,78,.5),(1.5,76,.5),(2,74,.8)],[(0,79,1.5),(1.5,78,.5),(2,74,.8)],[(0,78,.5),(.5,81,.5),(1,83,1),(2,81,.8)],[(0,81,1),(1,76,.75),(2,73,.7)],[(0,78,1),(1,83,.5),(1.5,81,.5),(2,78,.8)],[(0,79,.75),(1,78,.75),(2,74,.8)],[(0,76,1.5),(1.5,74,.5),(2,71,.8)],[(0,73,1.5),(1.5,76,.75)]]
    for bar in range(48):
        block=bar//8; c=chords[bar%8]; base=bar*3
        for j,ix in enumerate([0,2,1,3,2,1]): n(0,base+j*.5,c[ix],.45,49 if j==0 else 40)
        n(4,base,c[0],2.65,38)
        if bar%2==0:
            n(1,base+.08,c[2]+12,1.1,36);n(1,base+1.65,c[3]+12,.9,32)
        if block!=3:
            pattern=(bmel if block in (1,4) else melody)[bar%8]
            for off,p,d in pattern: n(2 if block!=4 else 3,base+off,p if block!=4 else p-12,d*.91,61 if block in (1,4) else 56)
        elif bar%2==0:
            for off,p,d in melody[bar%8][::2]:n(3,base+off,p-12,d,47)
        if bar>=8 and block!=3:
            n(5,base+1,37,.09,32);n(5,base+2,54,.18,28)
    return s


def explore():
    s,n=make_score('探索·雾径微光','探索',80,4,32,[instrument('竖琴',46,-8,-24),instrument('弦乐群',48,-18,5),instrument('长笛',73,-12,9),instrument('钢片琴',8,-20,28),instrument('大提琴',42,-17,-12)],
        '原创奇幻探索背景音乐，纯器乐，E 小调色彩，80 BPM，4/4。稀疏竖琴、柔和弦乐、留有呼吸间隔的长笛，以及少量钢片琴光点。以 Em9、Cmaj7、Am 与 Bsus 的变化描绘雾中林径，情绪好奇、幽深但不过度恐怖。前后保留共同动机，中间降低配器密度，再缓慢回归。避免人声、突然重击、密集主旋律和电影式爆发，让玩家能交谈调查。',
        'Em9 – Cmaj7 – Am(add9) – Bsus / Em – Gmaj7 – Am – B','A 8小节 / A扩展 8 / 稀疏间奏 8 / A回归 8',26,90502)
    chords=[[40,52,59,66,67],[36,48,55,59,64],[33,45,52,59,60],[35,47,54,59,64],[40,52,59,64,67],[31,43,50,54,59],[33,45,52,57,60],[35,47,54,59,63]]
    patterns=[[(.5,76,1.4),(2.25,79,1.2)],[(1,78,1.25),(2.75,76,.7)],[(.5,71,1.75)],[(1.5,78,1.55)],[(0,79,1.5),(2,78,.9),(3.15,76,.65)],[(.75,74,1.8)],[(1,72,1.2),(2.5,71,.9)],[(.5,75,1.3),(2.5,78,.85)]]
    for bar in range(32):
        block=bar//8;c=chords[bar%8];base=bar*4
        for p in c[1:]:n(1,base+.035,p,3.81,34 if block!=1 else 39)
        n(4,base,c[0]+12,3.7,35)
        offsets=[0,1.5,3.25] if block!=2 else [0,2.5]
        for j,off in enumerate(offsets):n(0,base+off,c[2+j%3]+12,.68,40-j*3)
        if block!=2 or bar%4==1:
            for off,p,d in patterns[bar%8]:n(2,base+off,p+(12 if block==1 and bar%4==0 else 0),d,48 if block!=2 else 39)
        if bar%4==2:n(3,base+2,c[3]+24,.8,36)
    return s


def battle():
    s,n=make_score('战斗·铁火前行','战斗',128,4,48,[instrument('拨弦弦乐',45,-9,-25),instrument('弦乐群',48,-14,20),instrument('圆号',60,-9,-4),instrument('大提琴',42,-11,-10),instrument('定音鼓',47,-14,0),instrument('战鼓与军鼓',0,-14,8,True),instrument('小号呼应',56,-18,12)],
        '原创奇幻战斗背景音乐，纯器乐，D 小调，128 BPM，4/4。拨弦弦乐的八分音符推进，圆号奏清楚但不密集的战斗主题，大提琴与定音鼓稳住重心，军鼓和低鼓带来行动感。保留中段较稀疏的呼吸段，再回到主题；力度增强依靠配器与节奏而非突然增大音量。面向持续数分钟的常规遭遇战，无歌词、无合唱、无警报、无引用现有作品的旋律。',
        'Dm – Bb – Gm – A（属和弦使用 C#，回到 Dm）','节奏引入 8小节 / 主题 8 / 主题扩展 8 / 呼吸段 8 / 再推进 8 / 回归 8',17,90503)
    chords=[[38,50,57,62,65],[34,46,53,58,62],[31,43,50,55,58],[33,45,52,57,61]]
    theme=[[(0,62,1),(1.5,65,.5),(2,67,1),(3,69,.75)],[(0,70,1.4),(1.5,69,.5),(2.5,65,1)],[(0,67,1),(1,65,.5),(1.5,62,.5),(2.5,58,.9)],[(0,61,1),(1,64,.8),(2,69,1.6)],[(0,74,1),(1.5,72,.5),(2,69,.9),(3,65,.75)],[(0,65,.75),(1,62,.75),(2,70,1.6)],[(0,67,1.3),(1.5,65,.5),(2.5,62,1)],[(0,64,.75),(1,61,.75),(2,57,1.5)]]
    for bar in range(48):
        block=bar//8;c=chords[bar%4];base=bar*4
        rhythm=[0,2,1,2,0,2,1,3]
        for j,ix in enumerate(rhythm):
            if block==3 and j%2:continue
            n(0,base+j*.5,c[1+ix]+12,.32,61 if j%2==0 else 48)
        for off in [0,2]:n(3,base+off,c[0]+12,1.7,53)
        if block in (1,2,4,5):
            for p in c[2:]:n(1,base+.04,p+12,3.78,42 if block in (2,4) else 35)
            for off,p,d in theme[bar%8]:n(2,base+off,p,d*.9,67 if block==4 else 61)
        elif block==3 and bar%2==0:
            n(2,base+.5,c[3],2.6,46)
        if block==4 and bar%2==1:
            for off,p,d in theme[bar%8][-2:]:n(6,base+off,p+12,d*.75,44)
        n(4,base,c[0],.7,52 if bar%4==0 else 38)
        for off in ([0,2] if block==3 else [0,1.5,2,3.5]):n(5,base+off,36,.13,62 if off in (0,2) else 42)
        if block!=3:
            for off in [1,3]:n(5,base+off,38,.12,43)
            for off in [.5,1.5,2.5,3.5]:n(5,base+off,42,.07,23)
        if bar%8==7 and block!=3:
            for j,p in enumerate([45,43,41]):n(5,base+3+j*.25,p,.16,38+j*4)
    return s


def main():
    for score in (town(),explore(),battle()):
        directory=OUT/score['title'];directory.mkdir(parents=True,exist_ok=True)
        (directory/'候选').mkdir(exist_ok=True);(directory/'母带').mkdir(exist_ok=True)
        score['notes'].sort(key=lambda n:(n['beat'],n['instrument'],n['pitch']))
        (directory/'v001-乐谱.json').write_text(json.dumps(score,ensure_ascii=False,indent=2)+'\n')
        write_midi(score,directory/'v001-编曲.mid')
        (directory/'v001-创作简报.txt').write_text(score['brief']+'\n')
        print(json.dumps({'title':score['title'],'seconds':score['lengthBeats']*60/score['bpm'],'notes':len(score['notes'])},ensure_ascii=False))
if __name__=='__main__':main()
