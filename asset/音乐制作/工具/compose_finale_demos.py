"""Second original batch: three contrasting final-battle compositions, v001.
Uses the first batch's score/MIDI format; never changes the first batch.
"""
import json
from compose_scene_demos import OUT, instrument, make_score, write_midi


def charge():
    s, n = make_score('决战·赤旗破阵', '首领', 144, 4, 72, [
        instrument('拨弦弦乐', 45, -12, -28), instrument('弦乐群', 48, -14, 23),
        instrument('圆号主题', 60, -8, -8), instrument('大提琴', 42, -12, -12),
        instrument('定音鼓', 47, -13), instrument('军鼓与大鼓', 0, -15, 8, True),
        instrument('小号应答', 56, -16, 18), instrument('长笛对位', 73, -20, 30)],
        '原创奇幻决战纯器乐，D 小调，144 BPM，4/4，约两分钟。表现城门前迎敌与破阵冲锋，以短促拨弦、前倾的切分低音和军鼓推动，圆号奏可辨识的上行主题，小号隔句应答。主题之后打开一个较宽的降 B 大调色彩段，中部抽去铜管与大部分鼓点，再逐层恢复，以属和弦接回开头。热烈、坚定，依靠节奏和配器提升力度，保持对白空间。无歌词、无合唱、无警报，不引用现成旋律。',
        'A: Dm–Dm/C–Bb–F/A–Gm–Dm/F–Eø–A；B: Bb–F–C–Dm–Gm–Bb–Eø–A',
        '引入8 / A主题16 / B展开16 / 低潮8 / 蓄势8 / A再现16', 18, 90511)
    a = [[38,50,57,62,65],[36,50,57,62,65],[34,46,53,58,62],[33,48,53,57,60],
         [31,43,50,55,58],[41,50,57,62,65],[40,52,55,58,62],[33,45,52,57,61]]
    b = [a[2],[41,53,57,60,65],[36,48,55,60,64],a[0],a[4],a[2],a[6],a[7]]
    theme = [
        [(0,62,.65),(.75,62,.2),(1,65,.7),(2,69,1.3),(3.5,67,.35)],
        [(0,65,1.2),(1.5,62,.7),(2.5,69,.6),(3.25,65,.55)],
        [(0,70,.7),(1,69,.4),(1.5,65,.8),(2.5,62,1.15)],
        [(0,60,.65),(.75,65,.65),(1.5,69,1.0),(3,72,.7)],
        [(0,67,1.15),(1.5,65,.4),(2,62,.7),(3,58,.7)],
        [(0,62,.65),(1,65,.7),(2,69,1.7)],
        [(0,70,.7),(1,67,.7),(2,64,.7),(3,62,.65)],
        [(0,61,1.2),(1.5,64,.7),(2.5,69,1.1)]]
    wide = [
        [(0,74,1.7),(2,70,.7),(3,65,.7)],[(0,72,2.6),(3,69,.7)],
        [(0,67,1.3),(1.5,64,.8),(2.5,72,1.1)],[(0,69,2.5),(3,65,.7)],
        [(0,70,1.2),(1.5,69,.7),(2.5,67,1.1)],[(0,65,1.4),(2,62,1.6)],
        [(0,64,1.3),(1.5,67,.7),(2.5,70,1.1)],[(0,73,1.7),(2,69,1.6)]]
    for bar in range(72):
        base = bar * 4; section = 'intro' if bar < 8 else 'a' if bar < 24 else 'b' if bar < 40 else 'quiet' if bar < 48 else 'rise' if bar < 56 else 'return'
        c = (b if section == 'b' else a)[bar % 8]
        soft = section == 'quiet'; full = section in ('a','b','return')
        for j, ix in enumerate([1,2,3,2,1,3,2,4]):
            if soft and j % 2: continue
            n(0, base+j*.5, c[ix]+12, .29, (40 if soft else 59)+(5 if j in (0,3,6) else -5))
        for off in ([0,2] if soft else [0,1.5,2.5]): n(3,base+off,c[0]+12,1.35 if soft else .72,41 if soft else 54)
        if full:
            for p in c[2:]: n(1,base+.04,p+12,3.75,41 if section=='b' else 36)
            for off,p,d in (wide if section=='b' else theme)[bar%8]: n(2,base+off,p,d,64 if section=='return' else 60)
            if bar%4==3:
                for off,p,d in theme[bar%8][-2:]: n(6,base+off,p+12,d*.7,40)
            if section=='b' and bar%2==1:
                for j,p in enumerate(reversed(c[2:])): n(7,base+1+j*.75,p+24,.58,36)
        elif section=='rise':
            for p in c[2:]:n(1,base+.05,p+12,3.7,30+(bar-48)*2)
            if bar>=52:
                for off,p,d in theme[bar%8][:2]:n(2,base+off,p,d,47)
        elif soft and bar%2==0: n(2,base+.5,c[3],2.4,39)
        if not soft:
            n(4,base,c[0],.8,51 if bar%4==0 else 38)
            for off in [0,1.5,2,3.5]:n(5,base+off,36,.15,61 if off in (0,2) else 43)
            for off in [1,3]:n(5,base+off,38,.13,49)
            if full:
                for off in [.5,1.5,2.5,3.5]:n(5,base+off,42,.08,25)
            if bar%8==7:
                for j,p in enumerate([45,43,41]):n(5,base+3.25+j*.25,p,.14,41+j*4)
            if bar in (8,24,56):n(5,base,49,1.4,42)
        else:n(4,base,c[0],1.1,31)
    return s


def embers():
    s,n = make_score('决战·余烬不灭','首领',112,4,64,[
        instrument('钢琴',0,-13,-20),instrument('弦乐群',48,-11,22),
        instrument('圆号',60,-11,-5),instrument('大提琴独奏',42,-8,-12),
        instrument('定音鼓',47,-17),instrument('低鼓与军鼓',0,-16,8,True),
        instrument('竖琴',46,-20,30),instrument('小号',56,-20,14)],
        '原创奇幻决战纯器乐，B 小调，112 BPM，4/4，约两分十七秒。表现濒临败局时仍决定守住同伴，以低声钢琴和大提琴提出一个带停顿的下行主题。中段让弦乐接过旋律，和声短暂转向 D 大调的明亮色彩，再加入半拍推进的圆号、军鼓与竖琴。先压抑，再坚韧反击，避免从头到尾全力轰鸣。以 F# 属和弦回到 B 小调，适合循环。无歌词、无合唱，不使用参考曲或现成旋律。',
        'A: Bm–Gmaj7–D/F#–Asus–Em–Bm/D–C#ø–F#；B: D–A/C#–Bm–G–Em–D/F#–G–F#',
        '钢琴引入8 / 大提琴主题16 / 孤立低潮8 / 弦乐蓄势8 / 反击主题16 / 收束回环8',24,90512)
    a=[[35,47,54,59,62],[31,43,50,54,59],[30,42,50,57,62],[33,45,52,57,62],
       [28,40,47,55,59],[38,50,54,59,62],[37,49,52,55,59],[30,42,49,54,58]]
    b=[[38,50,57,62,66],[37,49,52,57,61],a[0],a[1],a[4],a[2],a[1],a[7]]
    theme=[[(0,66,1.4),(2,62,.7),(3,59,.7)],[(.5,62,1.4),(2.5,59,1.1)],
           [(0,62,1.7),(2,66,1.4)],[(.5,64,1.1),(2,62,.7),(3,57,.7)],
           [(0,59,1.5),(2,55,1.5)],[(0,54,.7),(1,59,1.2),(2.5,62,1.1)],
           [(0,64,1.2),(1.5,67,.7),(2.5,64,1.1)],[(0,61,1.6),(2,58,1.5)]]
    hope=[[(0,66,1.4),(1.5,69,.7),(2.5,74,1.1)],[(0,73,1.7),(2,69,1.6)],
          [(0,71,1.2),(1.5,69,.7),(2.5,66,1.1)],[(0,67,1.6),(2,66,.7),(3,62,.7)],
          [(0,64,1.2),(1.5,67,.7),(2.5,71,1.1)],[(0,69,1.7),(2,66,1.6)],
          [(0,67,1.2),(1.5,66,.7),(2.5,62,1.1)],[(0,61,1.6),(2,66,1.5)]]
    for bar in range(64):
        base=bar*4; intro=bar<8; quiet=24<=bar<32; rise=32<=bar<40; peak=40<=bar<56
        c=(b if peak else a)[bar%8]
        offsets=[0,1.5,2.5] if intro or quiet else [0,.75,1.5,2,2.75,3.5]
        for j,off in enumerate(offsets):n(0,base+off,c[1+j%4]+12,.65,43 if peak else 35)
        if intro:
            if bar%2==0:
                for off,p,d in theme[bar%8][:2]:n(3,base+off,p-12,d,42)
        elif not peak:
            for off,p,d in theme[bar%8]:
                if quiet and off>=2:continue
                n(3,base+off,p-12,d,53 if not quiet else 40)
        else:
            n(3,base,c[0]+12,3.65,44)
            for off,p,d in hope[bar%8]:n(2,base+off,p,d,60)
        if not intro and not quiet:
            for p in c[2:]:n(1,base+.05,p+12,3.78,32 if not peak else 43)
        if rise or peak or bar>=56:
            for off in [0,2]:n(5,base+off,36,.17,48 if peak else 38)
            n(4,base,c[0],1.15,42 if peak else 32)
            if peak:
                for off in [1,3]:n(5,base+off,38,.17,39)
                for off in [.5,1.5,2.5,3.5]:n(6,base+off,c[2+int(off)%3]+24,.6,35)
                if bar%4==3:
                    for off,p,d in hope[bar%8][-2:]:n(7,base+off,p,d*.7,36)
            elif rise:
                for j in range(1+(bar-32)//2):n(5,base+3+j*.25,38,.1,23+j*3)
        elif bar%4==0:n(4,base,c[0],1.5,29)
        if bar in (40,48):n(5,base,49,1.6,35)
    return s


def throne():
    s,n=make_score('决战·星陨王座','首领',126,3,72,[
        instrument('低弦拨奏',45,-10,-25),instrument('弦乐群',48,-12,20),
        instrument('长号',57,-13,-8),instrument('圆号',60,-10,8),
        instrument('定音鼓',47,-12),instrument('重鼓与镲',0,-17,0,True),
        instrument('管钟',14,-22,28),instrument('钢片琴',8,-24,32)],
        '原创奇幻终局首领战纯器乐，C 小调，126 BPM，3/4，约一分四十三秒。用三拍重心和低弦重复动机表现宏大、危险的王座大厅，长号给出下降宣告，圆号以攀升主题回应；稀疏管钟和钢片琴带来星空般的冷光。和声包含降二级 D♭ 大三和弦的短暂威胁，随后回到 G 属和弦。中部只留低弦和冷光，后半叠加铜管与定音鼓，结尾回到循环入口。阴沉、庄严、紧迫，仍留出战术对话空间。无歌词、无合唱、无惊吓音效，不引用现有音乐。',
        'A: Cm–Ab–Fm–G–Cm/Eb–Db–Fm–G；B: Eb–Bb–Ab–G–Fm–Db–Gsus–G',
        '暗场引入8 / 宣告主题16 / 交锋展开16 / 冷光间奏8 / 倒计时8 / 终局再现16',25,90513)
    a=[[36,48,55,60,63],[32,44,51,56,60],[29,41,48,56,60],[31,43,50,55,59],
       [39,48,55,60,63],[37,49,56,61,65],[29,41,48,53,56],[31,43,50,55,59]]
    b=[[39,51,58,63,67],[34,46,53,58,62],a[1],a[3],a[2],a[5],
       [31,43,50,55,60],a[7]]
    dark=[[(0,60,1.2),(1.5,55,.5),(2.25,51,.5)],[(0,56,1.7),(2,51,.7)],
          [(0,53,1.2),(1.5,56,.5),(2.25,60,.5)],[(0,59,1.7),(2,55,.7)],
          [(0,63,1.1),(1.5,60,.5),(2.25,55,.5)],[(0,61,1.7),(2,56,.7)],
          [(0,56,.65),(.75,53,.65),(1.5,48,1.1)],[(0,50,1.1),(1.5,55,1.1)]]
    climb=[[(0,67,.6),(.75,70,.6),(1.5,75,1.1)],[(0,74,1.3),(1.5,70,1.1)],
           [(0,72,.6),(.75,68,.6),(1.5,63,1.1)],[(0,71,1.3),(1.5,67,1.1)],
           [(0,68,.6),(.75,65,.6),(1.5,60,1.1)],[(0,65,1.3),(1.5,61,1.1)],
           [(0,67,.6),(.75,69,.6),(1.5,72,1.1)],[(0,71,1.3),(1.5,67,1.1)]]
    for bar in range(72):
        base=bar*3; quiet=40<=bar<48; full=8<=bar<40 or bar>=56; second=24<=bar<40
        c=(b if second else a)[bar%8]
        for j,ix in enumerate([1,2,1,3,2,4]):
            if quiet and j%2:continue
            n(0,base+j*.5,c[ix],.34,46 if quiet else 61 if j in (0,3) else 47)
        if full:
            for p in c[2:]:n(1,base+.06,p+12,2.76,37 if not second else 42)
            if second:
                for off,p,d in climb[bar%8]:n(3,base+off,p,d,60)
                if bar%2==0:n(2,base,c[1],2.4,43)
            else:
                for off,p,d in dark[bar%8]:n(2,base+off,p,d,57)
                if bar>=56:
                    for off,p,d in dark[bar%8][-2:]:n(3,base+off,p+12,d*.85,50)
        elif 48<=bar<56:
            for p in c[2:]:n(1,base+.03,p+12,2.7,27+(bar-48)*2)
        if not quiet:
            n(4,base,c[0],.95,53 if bar%4==0 else 42)
            n(5,base,36,.2,60)
            if full or bar>=48:
                for off in [1.5,2.5]:n(5,base+off,41,.18,37)
                n(5,base+2,38,.13,33)
            if bar%8==7:
                for j in range(3):n(4,base+2+j*.25,c[0]+(7 if j==1 else 0),.18,36+j*5)
        if bar%8==0:n(6,base+.1,c[3]+12,2.3,40 if not quiet else 30)
        if quiet or (bar%4==2):
            for j,p in enumerate([c[4],c[3],c[2]]):n(7,base+.35+j*.8,p+24,.65,33)
        if bar in (8,24,56):n(5,base,49,1.4,39)
    return s


def main():
    manifest=[]
    for slug,score in [('charge',charge()),('embers',embers()),('throne',throne())]:
        folder=OUT/score['title']
        if (folder/'v001-乐谱.json').exists():
            raise FileExistsError(f'已有 v001，不覆盖制作历史：{folder}')
        folder.mkdir(parents=True,exist_ok=True)
        (folder/'候选').mkdir(exist_ok=True);(folder/'母带').mkdir(exist_ok=True)
        score['notes'].sort(key=lambda x:(x['beat'],x['instrument'],x['pitch']))
        (folder/'v001-乐谱.json').write_text(json.dumps(score,ensure_ascii=False,indent=2)+'\n')
        (folder/'v001-创作简报.txt').write_text(score['brief']+'\n')
        write_midi(score,folder/'v001-编曲.mid')
        manifest.append([slug,score['title'],-20 if slug!='embers' else -22])
        print(score['title'],round(score['lengthBeats']*60/score['bpm'],3),'seconds',len(score['notes']),'notes')
    (OUT.parent/'第二批-渲染清单.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
