#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""地图生成脚本模板 —— 新建团时复制本文件，改写地图数据后运行。

用法：python3 gen_maps.py
生成：同目录 maps/ 下的 .地图.json（与主控台格式一致）
"""

import json
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "maps")
os.makedirs(OUT, exist_ok=True)

# 地图工坊支持的图块 id（供校验）
KNOWN_TILES = {
    "void", "floor", "wood", "grass", "road", "sand", "ice", "water",
    "wall", "woodwall", "rock", "rubble", "bars", "fence", "pillar", "hedge",
    "door", "gate", "stairs", "bridge", "portal",
    "table", "chest", "bed", "bookshelf", "altar", "throne", "barrel",
    "crate", "fountain", "statue",
    "trap", "lava", "spikes", "pit", "torch",
    "tree", "bush", "mushroom",
}


def make_map(name, grid, cell_states=None):
    nrows = len(grid)
    ncols = len(grid[0])
    for row in grid:
        assert len(row) == ncols, (name, len(row), ncols)
        for c in row:
            assert c in KNOWN_TILES, (name, c)
    return {
        "app": "dnd-board",
        "kind": "map",
        "mapName": name,
        "mapW": ncols * 50,
        "mapH": nrows * 50,
        "gridSize": 50,
        "grid": grid,
        "cellStates": cell_states or {},
        "tokens": [],
        "init": [],
    }


def save(data, fname):
    with open(os.path.join(OUT, fname), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ============================================================
# 地图 1：<场景名>（<列数>×<行数>）
# 写法：先铺基底，再用坐标覆盖图块（参考下方示例）
# ============================================================
W, H = 20, 14
grid = [["floor"] * W for _ in range(H)]

# 示例：外墙 + 门 + 一张桌子
for x in range(W):
    grid[0][x] = "wall"
    grid[H - 1][x] = "wall"
for y in range(H):
    grid[y][0] = "wall"
    grid[y][W - 1] = "wall"
grid[H - 1][W // 2] = "door"
grid[5][5] = "table"

save(make_map("示例·地图", grid), "示例·地图.地图.json")

# ============================================================
# 地图 2 / 3 / ...：按需添加
# ============================================================

print("生成完成：")
for fname in sorted(os.listdir(OUT)):
    print(" -", fname)
