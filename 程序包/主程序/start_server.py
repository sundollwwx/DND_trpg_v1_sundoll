#!/usr/bin/env python3
"""ASCII-named Windows entry point for the Sangduoer local server."""
from pathlib import Path
import runpy

SERVER = Path(__file__).resolve().parent / "server" / "http_app.py"
runpy.run_path(str(SERVER), run_name="__main__")
