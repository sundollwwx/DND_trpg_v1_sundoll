"""Locate the checkout containing the application package and launchers."""
from pathlib import Path


def checkout_root(start=None):
    origin = Path(start or __file__).resolve()
    directory = origin if origin.is_dir() else origin.parent
    for candidate in (directory, *directory.parents):
        if (candidate / '.git').exists():
            return candidate
    raise RuntimeError('找不到 Git 仓库，请保留外层项目文件夹及其隐藏的 .git 目录。')
