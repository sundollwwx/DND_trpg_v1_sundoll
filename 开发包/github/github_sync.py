#!/usr/bin/env python3
"""Shared, interactive entrypoint for the two desktop GitHub shortcuts."""
import argparse
from contextlib import contextmanager
from pathlib import Path
import os
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_paths import checkout_root

from upload_github import upload, UploadError, REPOSITORY
from download_github import download, DownloadError


def git(root, *args):
    result = subprocess.run(['git', *args], cwd=root, text=True, encoding='utf-8',
                            errors='replace', stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Git 检查失败')
    return result.stdout.strip()


@contextmanager
def sync_lock(root):
    # OS locks are released even when the terminal is closed; no stale lock cleanup.
    lock_path = Path(git(root, 'rev-parse', '--git-path', 'sundoll-sync.lock'))
    if not lock_path.is_absolute():
        lock_path = root / lock_path
    with open(lock_path, 'a+b') as handle:
        handle.seek(0, os.SEEK_END)
        if not handle.tell():
            handle.write(b'0'); handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError('另一个上传或下载工具正在运行，请等待它结束。')
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def main(argv=None):
    parser = argparse.ArgumentParser(description='桑哆尔之歌 GitHub 同步工具')
    parser.add_argument('action', choices=('upload', 'download', 'check'))
    parser.add_argument('--yes', action='store_true', help='跳过确认，仅供明确授权的自动化调用')
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    root = checkout_root()
    try:
        top = Path(git(root, 'rev-parse', '--show-toplevel')).resolve()
        if top != root:
            raise RuntimeError('同步工具定位到的目录与 Git 仓库根目录不一致。')
        branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD')
        origin = git(root, 'remote', 'get-url', 'origin')
        changes = git(root, '-c', 'core.quotepath=false', 'status', '--short')
        print('\n桑哆尔之歌 · GitHub 同步')
        print('当前电脑目录：' + str(root))
        print('仓库：' + origin + '\n分支：' + branch)
        print('本地改动预览（最多 15 行）：\n' + ('\n'.join(changes.splitlines()[:15]) or '无未提交改动'))
        if args.action == 'check':
            print('只检查了本地状态，未连接或修改 GitHub。')
            return 0
        if origin not in (REPOSITORY, 'git@github.com:sundollwwx/DND_trpg_v1_sundoll.git') or branch != 'main':
            raise RuntimeError('仓库地址或分支不符合预期，已停止。请使用指定仓库的 main 分支。')
        with sync_lock(root):
            if args.action == 'upload':
                print('\n方向：当前电脑 → GitHub main')
                print('只上传公开源码与界面素材；账号、角色、房间存档、备份和密钥不上传。')
                print('请暂停编辑源码。远端领先或分叉时会停止，需先正常合并。')
                if not args.yes and input('确认上传请输入 YES，直接回车取消：').strip().upper() != 'YES':
                    print('已取消，没有提交或上传。'); return 0
                upload(root)
            else:
                print('\n方向：GitHub main → 当前电脑')
                print('只覆盖公开源码，先备份源码修改；本机账号、角色、房间存档与未知文件均保留。')
                print('若旧仓库仍跟踪私人数据，工具会停止，请先完成源码分离。')
                download(root, assume_yes=args.yes)
        return 0
    except (UploadError, DownloadError, RuntimeError, OSError) as error:
        print('\n操作未完成：' + str(error), file=sys.stderr)
        print('请保留窗口中的错误和备份分支名称。网络/登录问题修复后可重新运行。', file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print('\n已取消或中断；如已开始传输，请再次检查同步状态。')
        return 130


if __name__ == '__main__':
    sys.exit(main())
