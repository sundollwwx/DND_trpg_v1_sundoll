# 风骸岛之龙 · 地图资源

本目录保存「风骸岛之龙」战役中的海岸酒馆「桑哆尔之歌」、舰艇「风暴浪涌号」，以及北方避风港和白色修道院「巨龙之憩」。战术地图与叙事外观使用独立资源，同时保持同一地点或舰艇的结构与视觉连续性。

## 资源

| 文件 | 用途 |
| --- | --- |
| `酒馆·桑哆尔之歌·室内.地图.json` | 地图工坊地图；28×20 格，每格 50px／5 尺，可继续编辑并放置棋子 |
| `酒馆·桑哆尔之歌·外观·到达.png` | 1536×1024 无内置网格的叙事场景；玩家从海岸道路第一次抵达酒馆时展示 |
| `地点·巨龙之憩·登陆沙滩·战术俯视.png` | 1536×1024 严格俯视战术图；24×16 格、64px／5 尺，默认显示网格 |
| `地点·巨龙之憩·白色修道院·外观.png` | 1536×1024 明亮晴天叙事外观；默认隐藏网格 |
| `地点·巨龙之憩·白色修道院·内部·战术俯视.png` | 1536×1152 严格俯视战术图；24×18 格、64px／5 尺，默认显示网格 |
| `地点·巨龙之憩·制作说明.md` | 巨龙之憩正式设定、空间对应、主控台设置与三张图的最终提示词 |
| `舰艇·风暴浪涌号·外观·晴朗.png` | 1536×1024 晴天叙事外观；默认隐藏网格 |
| `舰艇·风暴浪涌号·外观·暴雨.png` | 1536×1024 同船同镜头暴雨外观；默认隐藏网格 |
| `舰艇·风暴浪涌号·甲板·战术俯视.png` | 1536×2304 海上严格俯视战术图；24×36 格、64px／5 尺，图内无网格 |
| `舰艇·风暴浪涌号·制作说明.md` | 舰艇统一设计、主控台设置与三张图的最终提示词 |

PNG 战术俯视图本身不包含烘焙网格。主控台按各地图记录的格距动态叠加网格，因此主持人可以在不改变原图、吸附或测距比例的情况下随时开关网格。

## 巨龙之憩

- 海滩位于北方避风港内，包含登陆码头、系泊划艇、五彩水草、黑色玄武岩和通往崖顶的盘旋石阶。
- 修道院以象牙白石灰岩和白色粉刷墙面建在黑色海崖上，中层广场设青铜龙雕像，崖壁中凿有六间修士房，另有独立打水房、餐厅、厨房和图书馆。
- 最高处的巴哈姆特露天神殿以石柱支撑木屋顶，并使用铂金龙浮雕、龙纹马赛克与七只金丝雀等宗教意象。

## 空间连续性

- 酒馆主体为盐蚀深色木构与粗石基座，两层坡顶建筑。
- 南侧双开正门面向海岸道路；东侧侧门通往码头与装卸区。
- 室内主厅包含北侧吧台、五组长桌、六张散桌、小演奏区和壁炉；北侧后场依次为厨房、储藏区和店主房，并有楼梯通往楼上。
- 外观图中的码头、帆船、木桶、绳索与暖色灯光延续室内的港口酒馆气质。

## 外观图最终生成提示词

```text
Use case: illustration-story
Asset type: TRPG campaign narrative location image for the campaign 风骸岛之龙
Primary request: Create the exterior entrance of a coastal fantasy tavern named “桑哆尔之歌”.
Scene/backdrop: A weathered but welcoming two-story timber-and-stone tavern stands directly beside a rocky seacoast and harbor lane. A wooden pier and several moored sailing ships with tall masts are visible beside it, with rolling sea, salt spray, ropes, barrels, lantern posts, and wind-bent coastal grass. The building’s south-facing double front door opens toward the shore road; a smaller service side leads toward the docks.
Subject: The tavern façade and its entrance are the single main focus. A carved hanging wooden sign above the entrance must clearly read the exact Chinese text “桑哆尔之歌”.
Style/medium: High-quality Western fantasy narrative illustration, painterly cinematic environment concept art, grounded architecture, suitable for a D&D location reveal.
Composition/framing: Wide arrival shot from human eye level on the shore road, looking toward the entrance. Foreground cobbles and damp timber lead the eye to the doorway; tavern in the middle ground; ships, pier, and sea establish the coastal background without overwhelming the entrance.
Lighting/mood: Late-afternoon overcast coastal light with warm amber window and doorway glow, windswept, adventurous, hospitable, slightly weathered by ocean storms.
Color palette: Sea blue-gray, wet stone, dark weathered oak, muted sailcloth, warm amber lamps.
Materials/textures: Salt-stained timber, rough stone foundation, heavy wooden double doors, iron fittings, damp cobbles, canvas sails and rigging.
Text (verbatim): “桑哆尔之歌”
Constraints: No people or creatures. One coherent scene, readable entrance, plausible ship scale, exact Chinese sign text, no gameplay spoilers.
Avoid: grid, map view, top-down view, floor plan, UI, labels other than the tavern sign, subtitles, border, signature, watermark, modern objects, photorealism, isometric view, collage.
```

外观图使用内置 imagegen 生成；室内地图已在项目地图工坊中载入并检查尺寸、格距和可编辑结构。

外观图随后使用同一张图进行定向亮度修订：只提高天空、海面、建筑立面和前景的曝光与日光感，保持构图、建筑、船只、入口和“桑哆尔之歌”招牌不变。战役存档中该叙事图默认隐藏网格，室内战术图默认显示网格；隐藏网格不会改变格距、吸附或测距。

亮度修订的最终提示词：

```text
Make this exact coastal tavern exterior moderately brighter and more welcoming. Change only lighting, sky, exposure, and color balance: lift the overall exposure, open the heavy shadows on the façade and foreground, let soft late-morning sunlight break through thinner coastal clouds, brighten the blue-gray sea and sails, and add clearer warm daylight to the wood and stone. Keep the camera, architecture, double entrance, dock, sailing ships, shoreline, barrels, ropes and lanterns unchanged. The carved sign must remain clearly legible and read exactly “桑哆尔之歌”. No people, creatures, new signs, grid, UI, border or watermark.
```
