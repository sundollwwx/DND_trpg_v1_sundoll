#!/usr/bin/env python3
"""Offline full-installation backup, verification, restoration and rollback."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from server.installation_backup import InstallationBackups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('create', help='完整停服后创建私有安装级备份目录')
    create.add_argument('--root', required=True, type=Path, help='含运行数据的程序包根目录；兼容旧同级模块工作区')
    create.add_argument('--output', required=True, type=Path, help='程序包以外的新备份目录')
    verify = commands.add_parser('verify', help='只读验证备份，不要求停服')
    verify.add_argument('--backup', required=True, type=Path)
    restore = commands.add_parser('restore', help='完整停服后验证并恢复；保留恢复前副本')
    restore.add_argument('--root', required=True, type=Path)
    restore.add_argument('--backup', required=True, type=Path)
    restore.add_argument('--expected-manifest-hash', required=True, help='verify 返回的 manifestHash')
    recover = commands.add_parser('recover', help='中断恢复后回滚到恢复前状态')
    recover.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'verify': result = InstallationBackups.verify(args.backup)
        else:
            tool = InstallationBackups(args.root)
            if args.command == 'create': result = tool.create(args.output)
            elif args.command == 'restore': result = tool.restore(args.backup, args.expected_manifest_hash)
            else: result = tool.recover()
    except (ValueError, RuntimeError, OSError, sqlite3.Error, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
