#!/usr/bin/env python3
"""Run dependency-free regression checks with isolated save/cache directories."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

PACKAGE=Path(__file__).resolve().parents[2]/'程序包'
ROOT=next(p for p in (PACKAGE/'主程序',PACKAGE/'应用') if (p/'start_server.py').exists())
TEST_ROOT=Path(__file__).resolve().parents[1] / 'tests'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node',default=shutil.which('node'),help='Node.js executable')
    args=parser.parse_args()
    if not args.node:
        parser.error('Node.js is required for frontend tests; install it or pass --node PATH')
    with tempfile.TemporaryDirectory(prefix='sundoll-check-') as directory:
        env=dict(os.environ,SUNDOLL_PYTHON=sys.executable,SUNDOLL_TEST_SAVE_ROOT=str(Path(directory)/'saves'),PYTHONPYCACHEPREFIX=str(Path(directory)/'pycache'),PYTHONPATH=os.pathsep.join([str(ROOT),str(TEST_ROOT)]))
        # Production workspace selection outranks TEST_SAVE_ROOT in paths.py.
        # Never let an inherited terminal setting defeat test isolation.
        env.pop('SUNDOLL_WORKSPACE_ROOT', None)
        env.pop('SUNDOLL_SMTP_PASSWORD', None)
        commands=[
            [sys.executable,'-m','unittest','discover','-s',str(TEST_ROOT),'-p','test_*.py'],
            [args.node,'--test',*[str(p) for p in sorted(TEST_ROOT.glob('test_*.cjs'))]],
        ]
        for command in commands:
            if subprocess.run(command,cwd=ROOT,env=env).returncode:
                return 1
    return 0

if __name__=='__main__':
    raise SystemExit(main())
