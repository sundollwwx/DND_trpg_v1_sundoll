#!/usr/bin/env python3
"""Publish reviewed public source without touching local saves or private files."""
import datetime
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_paths import checkout_root
from public_source import validate_tree, stage_public

REPOSITORY = 'https://github.com/sundollwwx/DND_trpg_v1_sundoll.git'


class UploadError(Exception):
    pass


def upload(root, repository=REPOSITORY):
    root = Path(root).resolve()

    def git(*args, capture=True, check=True, extra_env=None):
        result = subprocess.run(
            ['git', *args], cwd=root, text=True, encoding='utf-8',
            errors='replace', stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            env={**os.environ, **(extra_env or {})},
        )
        if check and result.returncode:
            raise UploadError((result.stderr or result.stdout or 'Git 命令失败。').strip())
        return result

    if not shutil.which('git'):
        raise UploadError('未找到 Git，请安装 Git 后重新双击。Windows 可安装 Git for Windows。')
    if Path(git('rev-parse', '--show-toplevel').stdout.strip()).resolve() != root:
        raise UploadError('上传目标必须是包含启动器与程序包的 Git 仓库根目录。')
    if git('symbolic-ref', '--quiet', '--short', 'HEAD').stdout.strip() != 'main':
        raise UploadError('当前不是 main 分支，请先处理当前分支，再切回 main 上传。')
    origins = git('remote', 'get-url', '--all', 'origin').stdout.splitlines()
    allowed = {repository}
    if repository == REPOSITORY:
        allowed.add('git@github.com:sundollwwx/DND_trpg_v1_sundoll.git')
    if len(origins) != 1 or origins[0] not in allowed:
        raise UploadError('origin 与指定仓库不一致，已停止，未修改仓库地址。')
    target = origins[0]
    for state in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'):
        path = Path(git('rev-parse', '--git-path', state).stdout.strip())
        if (path if path.is_absolute() else root / path).exists():
            raise UploadError('存在未完成的合并或变基，请先处理后再上传。')
    if git('ls-files', '--unmerged').stdout.strip():
        raise UploadError('存在未解决的冲突，请先处理后再上传。')
    # Check identity before staging or creating any commits.
    git('var', 'GIT_AUTHOR_IDENT')
    git('var', 'GIT_COMMITTER_IDENT')
    try:
        validate_tree(git, 'HEAD')
        validate_tree(git, git('write-tree').stdout.strip())
    except ValueError as error:
        raise UploadError(str(error) + '\n请先完成旧仓库的源码/私人数据分离；本工具不会自动上传或删除这些文件。')

    print('[1/4] 连接仓库并读取 main 最新版本……', flush=True)
    git('fetch', '--no-tags', target, 'refs/heads/main', capture=False)
    remote_head = git('rev-parse', 'FETCH_HEAD').stdout.strip()
    local_head = git('rev-parse', 'HEAD').stdout.strip()

    remote_is_ancestor = git('merge-base', '--is-ancestor', remote_head, local_head, check=False)
    if remote_is_ancestor.returncode == 1:
        raise UploadError('GitHub main 已领先或发生分叉，请先正常合并并解决冲突；没有暂存、提交或覆盖远端内容。')
    if remote_is_ancestor.returncode != 0:
        raise UploadError(remote_is_ancestor.stderr.strip())
    try:
        validate_tree(git, remote_head)
        for pending_commit in git('rev-list', remote_head + '..' + local_head).stdout.splitlines():
            validate_tree(git, pending_commit)
    except ValueError as error:
        raise UploadError(str(error))

    print('[2/4] 收集公开程序源码与界面素材，排除账号和存档……', flush=True)
    with tempfile.TemporaryDirectory(prefix='sundoll-source-index-') as temporary:
        index_env = {'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
        try:
            tree = stage_public(git, root, index_env)
        except ValueError as error:
            raise UploadError(str(error))
    # GitHub rejects ordinary files exceeding 100 MiB; check staged blobs,
    # rather than disk sizes, so Git LFS pointer files remain supported.
    entries = git('ls-tree', '-r', '-l', '-z', tree).stdout.split('\0')
    oversized = []
    for entry in entries:
        if not entry:
            continue
        metadata, name = entry.split('\t', 1)
        mode, kind, oid, size = metadata.split()
        if kind == 'blob' and int(size) > 100 * 1024 * 1024:
            oversized.append(name)
    if oversized:
        raise UploadError('以下文件超过 GitHub 单文件 100 MiB 限制，请缩小或使用 Git LFS：\n' + '\n'.join(oversized))

    print('[3/4] 保存本地版本……', flush=True)
    local_tree = git('rev-parse', 'HEAD^{tree}').stdout.strip()
    if tree != local_tree:
        stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        parents = ['-p', local_head]
        # Only single-parent commits are allowed; divergence is rejected above.
        commit = git('commit-tree', tree, *parents, '-m', '一键上传：公开源码 ' + stamp).stdout.strip()
        git('update-ref', '-m', '一键上传 GitHub', 'refs/heads/main', commit, local_head)
        git('read-tree', tree)
    else:
        commit = local_head

    print('[4/4] 上传源码到 GitHub……', flush=True)
    # Push a fixed snapshot to an explicit URL. No force push; concurrent remote
    # changes are rejected and a subsequent run can include their history.
    git('push', target, commit + ':refs/heads/main', capture=False)
    actual = git('ls-remote', target, 'refs/heads/main').stdout.split()
    if not actual or actual[0] != commit:
        raise UploadError('远端版本验证未通过，请重新运行上传程序。')
    print('\n上传成功！GitHub main 已更新：' + commit[:12], flush=True)
    if git('diff', '--quiet', check=False).returncode:
        print('上传期间源码又产生了改动，请检查后再次上传。')
    return commit


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    print('桑哆尔之歌 · 一键上传 GitHub\n' + REPOSITORY)
    print('仅同步公开源码与界面素材；账号、角色、房间存档、备份和密钥留在本机。')
    print('远端领先或分叉时会停止，请正常合并后重试。\n', flush=True)
    try:
        upload(checkout_root())
        return 0
    except (UploadError, OSError) as error:
        print('\n上传未完成：' + str(error), file=sys.stderr)
        print('本地文件仍保留。网络或登录失败时，处理后重新双击即可。', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('\n已中断，请重新运行以确认远端状态。', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
