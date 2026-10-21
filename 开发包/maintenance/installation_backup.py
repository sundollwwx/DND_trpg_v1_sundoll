#!/usr/bin/env python3
"""Compatibility entry point for the portable installation maintenance tool."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '程序包/主程序'))
from manage_installation import main

if __name__ == '__main__':
    sys.exit(main())
