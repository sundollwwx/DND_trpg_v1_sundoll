#!/usr/bin/env python3
"""Shared menu and command routing for the macOS and Windows launchers."""
from pathlib import Path
import subprocess
import sys


MAINTENANCE_MODES = {
    '--backup': 'backup',
    '--restore': 'restore',
    '--verify-backup': 'verify',
    '--recover-backup': 'recover',
}


def choose_mode():
    print('桑哆尔之歌')
    print('  1. 本机使用')
    print('  2. 公网联机')
    print('启动后不自动打开网页，请使用窗口显示的地址。')
    while True:
        try:
            answer = input('选择 1 或 2；直接回车取消：').strip()
        except (EOFError, KeyboardInterrupt):
            print('\n已取消。')
            return None
        if not answer:
            print('已取消。')
            return None
        if answer in ('1', '2'):
            return 'local' if answer == '1' else 'auto'
        print('请输入 1 或 2。')


def main(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    app = Path(__file__).resolve().parent
    if arguments == ['--help'] or arguments == ['-h']:
        print('桑哆尔之歌统一启动器')
        print('不带参数：选择本机使用或公网联机。')
        print('local / auto：直接启动本机服务 / 本机服务与公网联机。')
        print('启动参数原样传递；统一启动器始终禁止自动打开网页。')
        print('首次空安装：先到主程序目录运行 python3 manage_accounts.py init --help。')
        print('--backup：完整私人备份（账号、角色、全部房间与历史归档）。')
        print('--restore：选择、校验并明确确认恢复完整私人备份。')
        print('--verify-backup：只校验所选完整私人备份。')
        print('--recover-backup：明确确认回滚中断的安装级恢复。')
        print('完整私人备份前须让所有 DM 保存并完整停服，默认位于“私人备份/”。')
        print('完整账号房间恢复仅使用停服维护工具；旧工作区网页备份不能代替它。')
        print('\n服务参数：')
        return subprocess.call([sys.executable, '-u', str(app / 'launch_sundoll.py'), '--help'])
    if not arguments:
        mode = choose_mode()
        if mode is None:
            return 0
        arguments = [mode]
    maintenance = MAINTENANCE_MODES.get(arguments[0])
    if maintenance:
        command = [sys.executable, '-u', str(app / 'manage_installation_ui.py'),
                   maintenance, *arguments[1:]]
    else:
        command = [sys.executable, '-u', str(app / 'launch_sundoll.py'),
                   *arguments, '--no-open']
    return subprocess.call(command)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except OSError as error:
        print('[启动失败] ' + str(error))
        raise SystemExit(1)
