"""Six original one-shot cues matching the six existing rest scenes, in real seconds."""
import json
from compose_scene_demos import OUT, instrument, write_midi

CONFIGS = [
 ('short-outdoor','短休·林间整备',2.2,[46,73,42],[62,66,69,74],'D 大调竖琴上行与轻木管回应，林间停驻、整备后再出发。'),
 ('short-indoor','短休·炉边小憩',2.2,[24,71,42],[60,64,67,72],'C 大调尼龙吉他分解和弦、单簧管短句，温暖酒馆炉边。'),
 ('short-dungeon','短休·壁龛微灯',2.2,[8,70,48],[57,60,64,69],'A 小调钢片琴与低木管，谨慎而安定的地下城壁龛，结尾收于开放五度。'),
 ('long-outdoor','长休·星夜至晨',4.4,[46,73,48],[62,66,69,74],'D 大调缓慢竖琴、柔和长笛与弦乐，从星夜的疏朗和声向清晨落定。'),
 ('long-indoor','长休·雨窗安眠',4.4,[0,71,48],[60,64,67,72],'C 大调轻钢琴、低声单簧管与柔弦，旅店雨窗边安眠，温暖下行句。'),
 ('long-shelter','长休·雪外余温',4.4,[24,60,48],[55,58,62,67],'G 小调吉他、远处圆号与弦乐，风雪避难所内守火，最后引入大三度表示黎明与安全。'),
]


def main():
    manifest=[]
    for idx,(slug,title,seconds,programs,chord,intent) in enumerate(CONFIGS):
        folder=OUT/title
        assert not (folder/'v001-乐谱.json').exists()
        for sub in ['', '候选','母带']:(folder/sub).mkdir(parents=True,exist_ok=True)
        notes=[]
        def n(inst,t,p,d,v):notes.append(dict(instrument=inst,beat=t,pitch=p,duration=min(d,seconds-t-.05),velocity=v))
        long=seconds>3
        # 60 BPM means one score beat is one real second, matching the transition exactly.
        for j,p in enumerate(chord):n(0,.05+j*(.42 if long else .19),p,.9 if long else .48,46-j*2)
        if long:
            for p in [chord[0]-12,chord[1],chord[2]]:n(2,.08,p,3.6,32)
            pitches=[chord[2],chord[3],chord[1],chord[0]]
            if slug=='long-indoor':pitches=[chord[3],chord[2],chord[1],chord[0]]
            for j,p in enumerate(pitches):n(1,.55+j*.72,p,.62,40)
            last=chord[0]+4 if slug=='long-shelter' else chord[1]
            for p in [chord[0],last,chord[2]]:n(0,3.05,p,.68,38)
        else:
            n(2,.03,chord[0]-12,1.5,32)
            n(1,.55,chord[2],.4,41);n(1,1.03,chord[3],.53,39)
            n(0,1.35,chord[0],.42,37);n(0,1.35,chord[2],.42,32)
        brief=f'原创休息转场纯器乐，{intent}实际播放 {seconds} 秒，与现有'+('长休 4.4 秒动画（世界时间 +8 小时）' if long else '短休 2.2 秒动画（世界时间 +1 小时）')+'一致。无歌词、无重鼓、不引用现有旋律；开头轻起，最后预留自然衰减，单次播放。'
        score=dict(version='v001',title=title,scene='休息',restScene=slug,bpm=60,meter=4,lengthBeats=seconds,loop=False,reverb=22 if long else 15,seed=90630+idx,fadeInSeconds=.035,fadeOutSeconds=.65 if long else .4,brief=brief,
          instruments=[instrument('拨奏主奏',programs[0],-5,-15),instrument('旋律回应',programs[1],-11,18),instrument('低音与铺底',programs[2],-17,0)],notes=sorted(notes,key=lambda x:x['beat']))
        (folder/'v001-乐谱.json').write_text(json.dumps(score,ensure_ascii=False,indent=2)+'\n')
        (folder/'v001-创作简报.txt').write_text(brief+'\n');write_midi(score,folder/'v001-编曲.mid')
        manifest.append([
            slug, title, -24 if long else -23,
            'asset/界面/休息动画/音频/' + title + '.m4a',
        ])
        print(slug,title,seconds)
    (OUT.parent/'休息音频-渲染清单.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
