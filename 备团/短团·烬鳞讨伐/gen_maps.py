#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「短团·烬鳞讨伐」的四张跑团台地图（.地图.json）。"""

import json
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "maps")
os.makedirs(OUT, exist_ok=True)


def make_map(name, grid, cell_states=None, objects=None):
    nrows = len(grid)
    ncols = len(grid[0])
    for row in grid:
        assert len(row) == ncols, (name, len(row), ncols)
        for c in row:
            assert isinstance(c, str) and c, (name, c)
    return {
        "app": "dnd-board",
        "kind": "map",
        "mapName": name,
        "mapW": ncols * 50,
        "mapH": nrows * 50,
        "gridSize": 50,
        "grid": grid,
        "cellStates": cell_states or {},
        "objects": objects or {},
        "tokens": [],
        "init": [],
    }


def save(data, fname):
    with open(os.path.join(OUT, fname), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ============================================================
# 地图 1：酒馆·桑哆尔之歌（20×14）
# 图例：#=木墙  .=木地板  D=木门  T=桌子  C=宝箱  B=木桶  K=板条箱  t=火把  S=楼梯
# ============================================================
TAVERN_ROWS = [
    "####################",
    "#..t...........t...#",
    "#BBT............KK.#",
    "#B.T............KK.#",
    "#..T...............#",
    "#C.T..TT...TT......#",
    "#..T..TT...TT......#",
    "#C.T...............D",
    "#.....TT...TT......#",
    "#.....TT...TT......#",
    "#.B................#",
    "#.B................#",
    "#..t.............S.#",
    "#########D##########",
]

TAVERN_TILE = {
    "#": "woodwall",
    ".": "wood",
    "D": "door",
    "T": "table",
    "C": "chest",
    "B": "barrel",
    "K": "crate",
    "t": "torch",
    "S": "stairs",
}

tavern_grid = [[TAVERN_TILE[c] for c in row] for row in TAVERN_ROWS]
tavern_states = {"3,1": "on", "15,1": "on", "3,12": "on"}
save(make_map("酒馆·桑哆尔之歌", tavern_grid, tavern_states), "酒馆·桑哆尔之歌.地图.json")


# ============================================================
# 地图 2：林地·鸦羽谷道（30×20）
# ============================================================
W, H = 30, 20
woodland = [["grass"] * W for _ in range(H)]

# 土路：南北向三条
for y in range(H):
    for x in (14, 15, 16):
        woodland[y][x] = "road"

WOODLAND_ITEMS = {
    "tree": [
        (2, 2), (3, 2), (4, 2), (2, 3), (5, 3), (2, 4), (3, 4), (6, 4),
        (3, 5), (4, 5), (2, 6), (5, 6), (3, 7), (6, 7), (2, 8), (4, 8),
        (7, 8), (3, 9), (5, 9), (2, 10), (4, 10), (2, 13), (3, 13), (4, 13),
        (2, 14), (5, 14), (3, 15), (2, 16), (4, 16), (6, 16), (3, 17),
        (5, 17), (2, 18),
        (24, 3), (25, 3), (26, 3), (24, 4), (27, 4), (25, 5), (24, 6),
        (26, 6), (27, 7), (24, 8), (28, 8), (25, 9), (27, 9), (24, 10),
        (26, 10), (25, 13), (26, 13), (24, 14), (27, 14), (25, 15),
        (26, 16), (24, 17), (27, 17), (25, 18), (28, 18),
        (26, 19), (28, 19),
    ],
    "bush": [
        (12, 6), (13, 7), (11, 9), (10, 11), (12, 12), (17, 11), (18, 12),
        (19, 13), (11, 16), (19, 16), (12, 18), (18, 18), (21, 6), (22, 7),
        (8, 10), (20, 14), (9, 14), (22, 16),
    ],
    "rock": [
        (9, 5), (10, 5), (9, 6), (10, 7), (20, 5), (21, 5), (9, 15),
        (10, 15), (21, 12), (21, 13), (22, 12), (8, 16), (19, 17),
    ],
    "rubble": [
        (8, 9), (20, 8), (11, 13), (18, 14), (10, 17), (19, 18),
    ],
    "water": [
        (27, 15), (28, 15), (27, 16), (28, 16), (29, 16),
    ],
}

for tile, coords in WOODLAND_ITEMS.items():
    for (x, y) in coords:
        assert woodland[y][x] == "grass", ("woodland overlap", x, y)
        woodland[y][x] = tile

save(make_map("林地·鸦羽谷道", woodland), "林地·鸦羽谷道.地图.json")


# ============================================================
# 地图 3：营地·碎颅丘（36×24）
# ============================================================
W3, H3 = 36, 24
camp = [["grass"] * W3 for _ in range(H3)]

# 木栅栏外圈
for x in range(W3):
    camp[0][x] = "fence"
    camp[H3 - 1][x] = "fence"
for y in range(1, H3 - 1):
    camp[y][0] = "fence"
    camp[y][W3 - 1] = "fence"

# 三个出入口
for xy in [(17, 23), (18, 23), (0, 11), (0, 12), (35, 11), (35, 12)]:
    x, y = xy
    camp[y][x] = "gate"

# 主路
for y in range(1, H3 - 1):
    for x in (16, 17, 18):
        camp[y][x] = "road"


def hut(x0, y0, x1, y1, door_x, door_y, inside):
    """用木墙围出小屋，门开在 door 处，内部放置 inside 物品。"""
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            if x in (x0, x1) or y in (y0, y1):
                camp[y][x] = "woodwall"
    camp[door_y][door_x] = "door"
    for (ix, iy) in inside:
        camp[iy][ix] = "wood"


# 四座地精棚屋（墙内留空格，内部摆放家具）
hut(10, 4, 13, 6, 13, 5, [(11, 5), (12, 5)])
camp[5][11] = "bed"
camp[5][12] = "barrel"

hut(22, 4, 25, 6, 22, 5, [(23, 5), (24, 5)])
camp[5][23] = "crate"
camp[5][24] = "bed"

hut(10, 17, 13, 19, 13, 18, [(11, 18), (12, 18)])
camp[18][11] = "barrel"
camp[18][12] = "bed"

hut(22, 17, 25, 19, 22, 18, [(23, 18), (24, 18)])
camp[18][23] = "crate"
camp[18][24] = "chest"

# 中央篝火（碎石火坑 + 火把）
for xy in [
    (16, 10), (17, 10), (18, 10),
    (16, 11), (18, 11),
    (16, 12), (17, 12), (18, 12),
]:
    x, y = xy
    camp[y][x] = "rubble"
camp[11][17] = "torch"

# 物资堆
for xy in [(19, 11), (21, 11), (20, 12), (21, 12)]:
    x, y = xy
    camp[y][x] = "barrel"
for xy in [(20, 11), (19, 12)]:
    x, y = xy
    camp[y][x] = "crate"

# 图腾柱、岗哨柱、陷阱、碎石点缀
camp[7][17] = "statue"
for xy in [(4, 3), (4, 4), (4, 5), (30, 3), (30, 4), (30, 5)]:
    x, y = xy
    camp[y][x] = "pillar"
for xy in [(20, 8), (12, 16), (21, 15), (11, 9)]:
    x, y = xy
    camp[y][x] = "trap"
for xy in [(5, 10), (29, 10), (7, 14), (28, 14)]:
    x, y = xy
    camp[y][x] = "rubble"

camp_states = {
    "17,23": "open", "18,23": "open",
    "0,11": "open", "0,12": "open",
    "35,11": "open", "35,12": "open",
    "17,11": "on",
}
save(make_map("营地·碎颅丘", camp, camp_states), "营地·碎颅丘.地图.json")


# ============================================================
# 地图 4：龙巢·烬鳞矿窟（40×28）
# ============================================================
W4, H4 = 40, 28
lair = [["wall"] * W4 for _ in range(H4)]

# 内部石地板 + 南侧入口
for y in range(1, H4 - 1):
    for x in range(1, W4 - 1):
        lair[y][x] = "floor"
for x in (19, 20):
    lair[H4 - 1][x] = "floor"

# 中央高台（红龙卧处）
for x in range(16, 24):
    for y in range(5, 10):
        if x in (16, 23) or y in (5, 9):
            lair[y][x] = "rock"
        else:
            lair[y][x] = "floor"
lair[7][19] = "floor"
lair[7][21] = "altar"
lair[7][22] = "statue"
lair[6][18] = "chest"

# 岩浆池与岩浆溪（溪上两格石板桥）
for x in range(4, 8):
    for y in range(13, 18):
        lair[y][x] = "lava"
for x in range(31, 35):
    for y in range(13, 18):
        lair[y][x] = "lava"
for x in range(16, 24):
    lair[23][x] = "lava"
lair[23][19] = "bridge"
lair[23][20] = "bridge"

# 石柱
for xy in [
    (8, 8), (30, 8), (8, 19), (30, 19),
    (13, 11), (25, 11), (13, 16), (25, 16),
]:
    x, y = xy
    lair[y][x] = "pillar"

# 深坑与尖刺
for xy in [(12, 20), (26, 20)]:
    x, y = xy
    lair[y][x] = "pit"
for xy in [(10, 24), (28, 24)]:
    x, y = xy
    lair[y][x] = "spikes"

# 财宝堆
for xy in [
    (12, 14), (14, 15), (16, 16), (20, 15), (23, 16),
    (25, 14), (27, 15), (18, 18), (21, 19), (19, 17), (14, 19),
]:
    x, y = xy
    lair[y][x] = "chest"
for xy in [(13, 17), (24, 17), (18, 21)]:
    x, y = xy
    lair[y][x] = "barrel"
for xy in [(15, 18), (22, 18), (16, 20)]:
    x, y = xy
    lair[y][x] = "crate"
for xy in [(26, 19), (12, 19), (21, 13)]:
    x, y = xy
    lair[y][x] = "statue"

# 火把、碎石、龙蛋巢（碎石堆）
for xy in [(4, 9), (34, 9), (19, 3), (12, 22), (26, 22)]:
    x, y = xy
    lair[y][x] = "torch"
for xy in [
    (7, 20), (31, 20), (11, 23), (27, 23), (15, 10), (24, 10),
    (18, 10), (21, 10), (19, 11), (20, 11), (19, 12), (20, 12),
]:
    x, y = xy
    lair[y][x] = "rubble"

lair_states = {"4,9": "on", "34,9": "on", "19,3": "on"}
lair_objects = {
    "19,7": {"id": "thronedais", "w": 2, "h": 2},
}
save(make_map("龙巢·烬鳞矿窟", lair, lair_states, lair_objects), "龙巢·烬鳞矿窟.地图.json")

print("生成完成：")
for fname in sorted(os.listdir(OUT)):
    print(" -", fname)
