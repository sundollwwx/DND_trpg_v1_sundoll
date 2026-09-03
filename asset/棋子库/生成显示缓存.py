#!/usr/bin/env python3
"""从正式立绘生成浏览器使用的 192/512px WebP 显示缓存。"""

from __future__ import annotations

import argparse
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError as exc:  # pragma: no cover - 只在本机缺少依赖时触发
    raise SystemExit("缺少 Pillow，请先运行：python3 -m pip install Pillow") from exc


ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = ROOT / "立绘"
CACHE_ROOT = ROOT / "显示缓存"
DEFAULT_SIZES = (192, 512)
SUPPORTED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def cache_path(source: Path, size: int) -> Path:
    relative = source.relative_to(SOURCE_ROOT).with_suffix(".webp")
    return CACHE_ROOT / str(size) / relative


def generate_one(source: Path, target: Path, size: int, force: bool) -> bool:
    if not force and target.exists() and target.stat().st_mtime_ns >= source.stat().st_mtime_ns:
        return False

    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened)
        image.thumbnail((size, size), Image.Resampling.LANCZOS, reducing_gap=3.0)
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA" if "transparency" in image.info else "RGB")
        image.save(
            target,
            "WEBP",
            quality=90,
            method=6,
            optimize=True,
            exact=image.mode == "RGBA",
        )
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="忽略修改时间，强制重建全部缓存")
    parser.add_argument(
        "--sizes",
        type=int,
        nargs="+",
        default=DEFAULT_SIZES,
        help="要生成的边长，默认 192 512",
    )
    args = parser.parse_args()

    sizes = tuple(sorted({size for size in args.sizes if size > 0}))
    if not sizes:
        parser.error("至少需要一个大于 0 的尺寸")
    if not SOURCE_ROOT.is_dir():
        raise SystemExit(f"找不到正式立绘目录：{SOURCE_ROOT}")

    sources = sorted(
        path for path in SOURCE_ROOT.rglob("*")
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES
    )
    generated = 0
    skipped = 0
    for source in sources:
        for size in sizes:
            if generate_one(source, cache_path(source, size), size, args.force):
                generated += 1
            else:
                skipped += 1

    print(f"显示缓存完成：{len(sources)} 张原图，新增/更新 {generated} 个，跳过 {skipped} 个。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
