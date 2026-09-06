"""Reorchestrate the three finales after feedback: larger, more passionate.
Reads immutable v001 scores and writes only new v002 composition artifacts.
"""
import hashlib
import json
from pathlib import Path
from compose_scene_demos import OUT, instrument, make_score, write_midi

CONFIGS = [
    ('charge','决战·赤旗破阵',152,
     [[38,50,57,62,65],[36,50,57,62,65],[34,46,53,58,62],[33,48,53,57,60],[31,43,50,55,58],[41,50,57,62,65],[40,52,55,58,62],[33,45,52,57,61]],
     [[34,46,53,58,62],[41,53,57,60,65],[36,48,55,60,64],[38,50,57,62,65],[31,43,50,55,58],[34,46,53,58,62],[40,52,55,58,62],[33,45,52,57,61]],
     (8,2,0),(24,2,0), '正面决战与大军冲锋；保持短促战斗动机，加入高弦八度齐奏和铜管应答，十六分音符推进，重鼓以切分冲击推动。'),
    ('embers','决战·余烬不灭',132,
     [[35,47,54,59,62],[31,43,50,54,59],[30,42,50,57,62],[33,45,52,57,62],[28,40,47,55,59],[38,50,54,59,62],[37,49,52,55,59],[30,42,49,54,58]],
     [[38,50,57,62,66],[37,49,52,57,61],[35,47,54,59,62],[31,43,50,54,59],[28,40,47,55,59],[30,42,50,57,62],[31,43,50,54,59],[30,42,49,54,58]],
     (8,3,12),(40,2,0), '绝境中的英雄反击；把原来的大提琴低吟移交圆号和高弦，钢琴只保留为脉冲。反击段用明亮的大调色彩和上行旋律，鼓组持续推进，只留四小节短暂低潮。'),
    ('throne','决战·星陨王座',140,
     [[36,48,55,60,63],[32,44,51,56,60],[29,41,48,56,60],[31,43,50,55,59],[39,48,55,60,63],[37,49,56,61,65],[29,41,48,53,56],[31,43,50,55,59]],
     [[39,51,58,63,67],[34,46,53,58,62],[32,44,51,56,60],[31,43,50,55,59],[29,41,48,56,60],[37,49,56,61,65],[31,43,50,55,60],[31,43,50,55,59]],
     (8,2,12),(24,3,0), '终局首领战；从三拍阴沉仪式改成四拍强攻，保留降二级和声的威胁感。低铜管和高弦跨音区呼应，宽和弦、战鼓滚奏与镲的段落重击形成宏大高潮。')
]


def extract(score, start_bar, index, transpose):
    meter=score['meter'];result=[]
    for bar in range(start_bar,start_bar+8):
        notes=[x for x in score['notes'] if x['instrument']==index and bar*meter-.03<=x['beat']<(bar+1)*meter-.03]
        result.append([(max(0,(x['beat']-bar*meter)*4/meter),x['pitch']+transpose,min(x['duration']*4/meter,3.7)) for x in notes])
    assert all(result)
    return result


def create(config):
    slug,title,bpm,chords,bright,source_a,source_b,intent=config
    folder=OUT/title
    old=json.loads((folder/'v001-乐谱.json').read_text())
    theme=extract(old,*source_a); answer=extract(old,*source_b)
    brief=('修改依据：用户反馈“这几首决战的音乐感觉不够大气，激情”。'
           f'创作 v002，{bpm} BPM，4/4，72 小节，原创奇幻管弦决战纯音乐。{intent}'
           '主题从开头进入，铜管群与圆号齐奏，高弦加宽音域，低弦和定音鼓支撑低频，军鼓、通鼓、低鼓与镲形成有起伏的战鼓层。'
           '段落为主旨宣告8小节、主主题16、展开16、短低潮4、滚奏蓄势4、全奏高潮16、强势回环8。'
           '用旋律齐奏、配器密度、节奏细分和真实力度变化扩大气势；不只调大总音量。不加入歌词或合唱，不引用外部旋律。')
    s,n=make_score(title,'首领',bpm,4,72,[
        instrument('低弦节奏',45,-5,-32),instrument('宽弦乐群',48,-5,28),
        instrument('铜管群',61,-7,-20),instrument('圆号主旋律',60,-3,12),
        instrument('大提琴低音',42,-6,-8),instrument('定音鼓',47,-6,0),
        instrument('战鼓军鼓与镲',0,-7,5,True),instrument('高弦颤奏',44,-11,-28),
        instrument('钢琴脉冲',0,-15,25)],brief,old['harmony'],
        '宣告8 / 主题16 / 展开16 / 低潮4 / 蓄势4 / 全奏高潮16 / 强势回环8',19,90620+len(slug))
    s['version']='v002';s['previousVersion']='v001';s['feedback']='这几首决战的音乐感觉不够大气，激情'
    for bar in range(72):
        beat=bar*4;quiet=40<=bar<44;build=44<=bar<48;peak=48<=bar<64
        opening=bar<8;wide=24<=bar<40 or peak
        c=(bright if wide else chords)[bar%8]
        # A low pedal with faster chord-tone figures above it gives weight and motion.
        density=16 if (peak or slug=='charge') and not quiet else 8
        if quiet:density=4
        pattern=[1,2,3,2,1,3,2,4,1,2,3,4,2,3,4,3]
        for j in range(density):
            pitch=c[pattern[j]]+(12 if j%4 in (1,3) else 0)
            n(0,beat+j*4/density,pitch,.17 if density==16 else .32,51 if quiet else (86 if j%4==0 else 67))
        for off in ([0,2] if quiet else [0,1,2,3]):
            n(4,beat+off,c[0]+12,1.72 if quiet else .78,55 if quiet else 79)
        if not quiet:
            # Open spacing: bass is separate from mid/high chord voices.
            for p in [c[2],c[3]+12,c[4]+12]:
                n(1,beat+.02,p,3.82,75 if peak else 61 if not build else 49+(bar-44)*7)
            if peak or wide:
                for p in [c[2]+12,c[4]+12]:n(7,beat+.06,p,3.76,57 if peak else 45)
        else:
            for p in c[2:]:n(1,beat+.04,p,3.78,43)
        melody=(answer if wide else theme)[bar%8]
        if quiet:melody=melody[:1]
        if build:melody=melody[:2]
        for off,p,d in melody:
            duration=min(d*.98,3.93-off)
            n(3,beat+off,p,duration,57 if quiet else 95 if peak else 83)
            if not quiet and not build:
                n(2,beat+off,p-12 if p>=65 else p,duration*.87,81 if peak else 65)
                # High strings double the theme in the climax, reinforcing its shape.
                if peak or opening:n(8 if slug=='embers' and opening else 7,beat+off,min(p+12,88),duration*.91,66)
        if slug=='embers':
            for j in range(8):n(8,beat+j*.5,c[1+j%4]+12,.39,47 if quiet else 64)
        elif bar%4==3 and not quiet:
            for j,p in enumerate(c[2:]):n(8,beat+2.5+j*.45,p+12,.32,56)
        if quiet:
            if bar%2==0:n(5,beat,c[0],1.4,58)
            continue
        # Layer a resonant orchestral pulse with short low drums and contrasting fills.
        for off in [0,2]:n(5,beat+off,c[0],.82,91 if peak else 77)
        kicks=[0,1.5,2,3.5] if slug!='embers' else [0,.75,2,2.75]
        for off in kicks:n(6,beat+off,36,.17,101 if off in (0,2) else 75)
        for off in [0,2]:n(6,beat+off,41,.22,85 if peak else 72)
        for off in [1,3]:n(6,beat+off,38,.15,88 if peak else 77)
        for off in [.5,1.5,2.5,3.5]:n(6,beat+off,42,.1,41 if peak else 32)
        if bar%4==3:
            for j,p in enumerate([45,43,41]):n(6,beat+3.25+j*.25,p,.16,65+j*8)
        if bar in (0,8,24,48,56,64):n(6,beat,49,1.3,83 if bar==48 else 69)
        if bar%8==0:n(6,beat,57,.9,54)
        if build:
            for j in range(8):n(6,beat+j*.5,40,.12,38+(bar-44)*9+j*2)
            for j in range(4):n(5,beat+2+j*.5,c[0]+7,.25,50+j*7+(bar-44)*3)
    # Same-pitch overlapping note-offs can cancel the following note in MIDI samplers.
    s['notes'].sort(key=lambda x:(x['instrument'],x['pitch'],x['beat']))
    clean=[]
    for event in s['notes']:
        if clean and (clean[-1]['instrument'],clean[-1]['pitch'])==(event['instrument'],event['pitch']):
            prev=clean[-1]
            if event['beat']-prev['beat']<.035:
                prev['velocity']=max(prev['velocity'],event['velocity']);prev['duration']=max(prev['duration'],event['duration']);continue
            prev['duration']=round(min(prev['duration'],event['beat']-prev['beat']-.012),5)
        clean.append(event)
    s['notes']=sorted(clean,key=lambda x:(x['beat'],x['instrument'],x['pitch']))
    return slug,s


def main():
    manifest=[];preserved={}
    for config in CONFIGS:
        folder=OUT/config[1]
        for p in folder.rglob('v001*'):
            if p.is_file():preserved[str(p.relative_to(OUT.parent))]=hashlib.sha256(p.read_bytes()).hexdigest()
        assert not (folder/'v002-乐谱.json').exists(),'已有 v002，请先另设新版本，不能覆盖。'
    for config in CONFIGS:
        slug,score=create(config);folder=OUT/score['title']
        (folder/'v002-乐谱.json').write_text(json.dumps(score,ensure_ascii=False,indent=2)+'\n')
        (folder/'v002-创作简报.txt').write_text(score['brief']+'\n')
        write_midi(score,folder/'v002-编曲.mid')
        manifest.append([slug,score['title'],-17.5 if slug!='embers' else -18])
        print(score['title'],len(score['notes']),round(score['lengthBeats']*60/score['bpm'],3),'seconds')
    (OUT.parent/'决战v002-渲染清单.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    (OUT.parent/'决战v002-旧版校验.json').write_text(json.dumps(preserved,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
