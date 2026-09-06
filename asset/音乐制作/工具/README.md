# 原创场景音乐 v001 制作工具

这批音乐采用音符编排和 macOS 乐器音源离线渲染。创作简报是实际编曲依据，没有提交给外部文生音乐模型。现有三个作品目录已包含可直接编辑的 MIDI 和权威 JSON 乐谱。

## 工具职责

- `compose_scene_demos.py`：Python 3 标准库，按固定种子写入三首 v001 乐谱、MIDI 和创作简报。
- `render_score.swift`：读取一份 JSON，使用 AVAudioUnitSampler 和系统音源离线渲染两轮，保留第二轮作为 44.1 kHz 双声道浮点 WAV。需要 macOS、Swift 与系统音频组件访问权限，不录音、不上传。
- `master_scene_demos.py`：需要 Python 3、NumPy、macOS afconvert；读取原始渲染，移除直流偏移、首尾各 12 毫秒渐变、固定增益归一化和 16-bit 抖动，保存 WAV 母带并编码 M4A，重新解码检查、保存候选与正式文件。

本机音色库引用 `/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls`，不随项目分发。Windows 可以播放成品、在音乐软件编辑 MIDI；该 Swift 渲染器仅面向 macOS。

## 在独立副本中复现

以下命令在项目副本根目录的终端输入。生成器和母带脚本会写入固定的 v001 文件；要继续创作请先复制作品及脚本、改成 v002，再运行，避免覆盖制作历史。`python3` 需要能导入 NumPy。

```sh
python3 asset/音乐制作/工具/compose_scene_demos.py
mkdir -p /private/tmp/sundoll-music-renders
swiftc -module-cache-path /private/tmp/sundoll-swift-modules asset/音乐制作/工具/render_score.swift -o /private/tmp/sundoll-render-score
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/城镇·灯下旅人/v001-乐谱.json' /private/tmp/sundoll-music-renders/town.wav
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/探索·雾径微光/v001-乐谱.json' /private/tmp/sundoll-music-renders/explore.wav
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/战斗·铁火前行/v001-乐谱.json' /private/tmp/sundoll-music-renders/battle.wav
python3 asset/音乐制作/工具/master_scene_demos.py /private/tmp/sundoll-music-renders
```

系统音源或编码器版本变化可能改变渲染结果。乐谱中的随机变化有固定种子；不保证跨系统音频逐字节相同。检查报告记录 RMS 和样本峰值，不代表 LUFS、true peak 或主观试听通过。AAC/浏览器播放也不保证无缝循环。

## 第二批决战音乐

`compose_finale_demos.py` 引用第一批的 JSON/MIDI 写出格式，创建三首独立作品。检测到已有 v001 乐谱时会停止，避免覆盖；要重新生成可使用独立项目副本。母带脚本新增可选清单参数，未传清单时仍处理第一批。

```sh
python3 asset/音乐制作/工具/compose_finale_demos.py
mkdir -p /private/tmp/sundoll-finale-renders
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/决战·赤旗破阵/v001-乐谱.json' /private/tmp/sundoll-finale-renders/charge.wav
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/决战·余烬不灭/v001-乐谱.json' /private/tmp/sundoll-finale-renders/embers.wav
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/决战·星陨王座/v001-乐谱.json' /private/tmp/sundoll-finale-renders/throne.wav
python3 asset/音乐制作/工具/master_scene_demos.py /private/tmp/sundoll-finale-renders asset/音乐制作/第二批-渲染清单.json
```

母带脚本会写入清单对应的候选、母带、播放副本与检查报告；集中小样归档需在验收后另复制到 `asset/音乐制作/小样/第二批·决战/<曲名>-v001.m4a`，确认与候选字节一致。每首制作记录保留实际简报与验证结果。

## 决战 v002 重编

`compose_finale_v002.py` 读取 v001 乐谱中的旋律动机，重建节奏、配器与段落；不修改 v001。发现已有 v002 乐谱时会停止。新增 `决战v002-旧版校验.json` 保存旧版文件的 SHA-256，便于核对历史保留完整性。

在含有 v001 素材的独立副本中执行：

```sh
python3 asset/音乐制作/工具/compose_finale_v002.py
mkdir -p /private/tmp/sundoll-finale-v002
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/决战·赤旗破阵/v002-乐谱.json' /private/tmp/sundoll-finale-v002/charge.wav
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/决战·余烬不灭/v002-乐谱.json' /private/tmp/sundoll-finale-v002/embers.wav
/private/tmp/sundoll-render-score 'asset/音乐制作/通用/决战·星陨王座/v002-乐谱.json' /private/tmp/sundoll-finale-v002/throne.wav
python3 asset/音乐制作/工具/master_scene_demos.py /private/tmp/sundoll-finale-v002 asset/音乐制作/决战v002-渲染清单.json v002
```

母带脚本最后一个可选参数为版本号，默认仍是 v001。它先编码候选并验证解码时长、非静音与峰值，再更新播放副本；候选、母带及报告写入对应版本名。重跑会写入所选版本，因此精修应先改成下一个版本号。v002 不采用动态压缩，气势的变化主要来自实际编曲、音符力度和配器调整；音量仍保留峰值余量。

## 第三批：六段休息转场

`compose_rest_cues.py` 生成六个场景的 v001 乐谱、MIDI、完整简报和 `休息音频-渲染清单.json`，已有同版乐谱时拒绝覆盖。使用 60 BPM 使乐谱一拍等于一秒，长度为 2.2 或 4.4 拍，对齐现有短休/长休动画。清单第四列指定项目内安装路径，因此这六段会写入 `asset/界面/休息动画/音频/`，不会进入背景音乐曲库。

渲染器新增可选 `loop: false`：这类片段只渲染一轮，从安静起音；旧作品没有此字段时继续两轮预热、保留第二轮。母带脚本支持乐谱里的 `fadeInSeconds` 与 `fadeOutSeconds`，未指定时仍用原来的 12 ms。

在独立副本生成乐谱后，重新编译 `render_score.swift`，按清单逐个渲染到临时目录 `<slug>.wav`，最后运行：

```sh
python3 asset/音乐制作/工具/master_scene_demos.py /private/tmp/sundoll-rest-renders asset/音乐制作/休息音频-渲染清单.json
```

这一批固定增益目标为短休 −23 dBFS RMS、长休 −24 dBFS RMS，35 ms 起音淡入、400 / 650 ms 尾音衰减。曲库成品与集中小样均已存放，前端通过场景配置播放一次，不循环。
