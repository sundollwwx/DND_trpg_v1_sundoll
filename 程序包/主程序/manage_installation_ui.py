#!/usr/bin/env python3
"""Small local-operator interface for private installation maintenance."""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3

from server.installation_backup import InstallationBackups


def select_backup(directory):
    if not directory.is_dir():
        raise ValueError('还没有完整私人备份；请先通过统一启动器运行 --backup。')
    backups = sorted((p for p in directory.iterdir()
        if p.is_dir() and not p.is_symlink() and (p / '备份清单.json').is_file()),
        key=lambda p: p.name, reverse=True)
    if not backups:
        raise ValueError('私人备份目录里没有安装级备份。旧格式需在隔离副本中恢复，不能直接拼入当前安装。')
    print('可用的完整私人备份：')
    for index, backup in enumerate(backups, 1):
        print(f'  {index}. {backup.name}')
    answer = input('选择编号；直接回车取消：').strip()
    if not answer:
        return None
    if not answer.isdecimal() or not 1 <= int(answer) <= len(backups):
        raise ValueError('编号无效，未恢复任何数据。')
    return backups[int(answer) - 1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('backup', 'restore', 'verify', 'recover'))
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    root = args.root.absolute()
    private = root.parent / '私人备份'
    try:
        if private.is_symlink():
            raise ValueError('私人备份目录不允许符号链接。')
        tool = InstallationBackups(root)
        if args.mode == 'backup':
            print('请先让所有 DM 保存进度，并关闭本机服务和所有战役进程。')
            print('若服务仍在运行，本工具会拒绝备份；不会替你关闭正在使用的战役。')
            private.mkdir(mode=0o700, parents=True, exist_ok=True)
            private.chmod(0o700)
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            result = tool.create(private / f'全部战役-{stamp}-{os.getpid()}')
            print('全部战役备份完成，文件、数据库和空间关系校验已通过。')
            print('备份位置：' + result['path'])
            print('它包含账号与私人存档，请保管好整个备份文件夹。')
        elif args.mode == 'recover':
            print('此操作将回滚中断的整套恢复，保留恢复前的数据。')
            if input('输入“回滚恢复”继续；直接回车取消：').strip() != '回滚恢复':
                print('已取消。'); return 0
            result = tool.recover()
            print('回滚完成，可以重新启动服务。' if result['recovered'] else '没有待回滚的恢复任务。')
        else:
            backup = select_backup(private)
            if backup is None:
                print('已取消。'); return 0
            verified = tool.verify(backup)
            print('备份校验通过：' + backup.name)
            if args.mode == 'verify':
                return 0
            print('将恢复这份备份中的账号、角色、背包、全部房间及历史归档。')
            print('请先保存并完整停服。恢复前会自动保留当前数据的完整备份。')
            if input('输入“恢复全部战役”继续；直接回车取消：').strip() != '恢复全部战役':
                print('已取消。'); return 0
            result = tool.restore(backup, verified['manifestHash'])
            print('恢复完成。请重新启动服务，并重新登录邮箱账号。')
            print('恢复前备份：' + result['rollbackPath'])
    except (ValueError, RuntimeError, OSError, sqlite3.Error, EOFError, KeyboardInterrupt) as error:
        print('未完成操作：' + str(error))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
