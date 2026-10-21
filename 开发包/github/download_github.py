#!/usr/bin/env python3
"""Update public source only; local private data is never an overwrite target."""

import argparse
import datetime
import os
from pathlib import Path
import shutil
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_paths import checkout_root
from public_source import public_path, candidate_files, validate_tree, validate_worktree_paths, stage_public
import tempfile


REPOSITORY = 'https://github.com/sundollwwx/DND_trpg_v1_sundoll.git'
BACKUP_PREFIX = 'backup/before-github-overwrite-'


class DownloadError(Exception):
    pass


def download(root, repository=REPOSITORY, assume_yes=False, now=None):
    """Fetch source ``main``, back up source changes, and preserve all private files."""
    root = Path(root).resolve()

    def git(*args, capture=True, check=True, extra_env=None):
        env = None
        if extra_env:
            env = os.environ.copy()
            env.update(extra_env)
        result = subprocess.run(
            ['git', *args], cwd=root, text=True, encoding='utf-8',
            errors='replace', stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None, env=env,
        )
        if check and result.returncode:
            detail = result.stderr or result.stdout or 'Git 命令失败，请查看上方信息。'
            raise DownloadError(detail.strip())
        return result

    if not shutil.which('git'):
        raise DownloadError('未找到 Git，请安装 Git 后重新双击。Windows 可安装 Git for Windows。')

    top_level = git('rev-parse', '--show-toplevel', check=False)
    if top_level.returncode or Path(top_level.stdout.strip()).resolve() != root:
        raise DownloadError('请将覆盖程序放在项目 Git 仓库根目录。')
    if git('symbolic-ref', '--quiet', '--short', 'HEAD').stdout.strip() != 'main':
        raise DownloadError('当前不是 main 分支。为避免覆盖其他工作分支，程序已停止。')

    origins = git('remote', 'get-url', '--all', 'origin').stdout.splitlines()
    allowed = {repository}
    if repository == REPOSITORY:
        allowed.add('git@github.com:sundollwwx/DND_trpg_v1_sundoll.git')
    if len(origins) != 1 or origins[0] not in allowed:
        raise DownloadError('origin 与指定仓库不一致，已停止；程序没有修改仓库地址。')
    target = origins[0]

    for state in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'):
        path = Path(git('rev-parse', '--git-path', state).stdout.strip())
        if (path if path.is_absolute() else root / path).exists():
            raise DownloadError('存在未完成的合并或变基，请先处理，当前文件尚未覆盖。')
    if git('ls-files', '--unmerged').stdout.strip():
        raise DownloadError('存在未解决的冲突，请先处理，当前文件尚未覆盖。')

    local_head = git('rev-parse', 'HEAD').stdout.strip()
    original_index_tree = git('write-tree').stdout.strip()
    try:
        local_paths = validate_tree(git, local_head)
        validate_tree(git, original_index_tree)
        source_files = candidate_files(root)
    except ValueError as error:
        raise DownloadError(str(error) + '\n旧 HEAD 或索引仍含私人数据时，必须先完成源码分离；本次没有覆盖或删除本机文件。')
    status_before = git('status', '--porcelain=v1', '-z', '--untracked-files=all').stdout
    source_dirty = (git('diff', '--quiet', check=False).returncode != 0
                    or git('diff', '--cached', '--quiet', check=False).returncode != 0
                    or bool(set(source_files) - set(local_paths)))
    ignored_before = {
        entry for entry in git(
            'ls-files', '--others', '--ignored', '--exclude-standard', '-z'
        ).stdout.split('\0') if entry
    }

    print('[1/4] 连接 GitHub 并读取 main 最新版本……', flush=True)
    git('fetch', '--no-tags', target, 'refs/heads/main', capture=False)
    remote_head = git('rev-parse', 'FETCH_HEAD^{commit}').stdout.strip()
    try:
        remote_paths = set(validate_tree(git, remote_head))
        validate_worktree_paths(root, remote_paths | set(local_paths))
    except ValueError as error:
        raise DownloadError(str(error))
    remote_directories = set()
    for remote_path in remote_paths:
        parts = remote_path.split('/')
        remote_directories.update('/'.join(parts[:index]) for index in range(1, len(parts)))

    def ignored_path_will_be_overwritten(path):
        if path in remote_paths or path in remote_directories:
            return True
        parts = path.split('/')
        return any('/'.join(parts[:index]) in remote_paths for index in range(1, len(parts)))

    colliding_ignored = sorted(
        path for path in ignored_before if ignored_path_will_be_overwritten(path)
    )

    if local_head == remote_head and not source_dirty:
        print('\n本地项目已经与 GitHub main 完全一致，无需覆盖。', flush=True)
        return {
            'changed': False,
            'cancelled': False,
            'commit': remote_head,
            'backupBranch': None,
        }

    changed_count = len([entry for entry in status_before.split('\0') if entry])
    print('\n即将从 GitHub 更新公开源码：')
    print('  当前本地版本：' + local_head[:12])
    print('  GitHub main： ' + remote_head[:12])
    print('  本地未提交变更：%d 项' % changed_count)
    if colliding_ignored:
        print('  与远端路径冲突的本地缓存：%d 项（会一并收入备份）' % len(colliding_ignored))
    print('  仅覆盖公开源码；账号、角色、房间存档、私人文件和未知目录均保留。')
    print('  源码修改会先保存到本地备份分支，请暂停编辑程序文件。')
    if not assume_yes:
        try:
            answer = input('\n确认继续请输入 YES：').strip().upper()
        except EOFError:
            answer = ''
        if answer != 'YES':
            print('已取消，本地文件未被覆盖。')
            return {
                'changed': False,
                'cancelled': True,
                'commit': local_head,
                'backupBranch': None,
            }

    timestamp = (now or datetime.datetime.now()).strftime('%Y%m%d-%H%M%S')
    branch_base = BACKUP_PREFIX + timestamp
    backup_branch = branch_base
    suffix = 2
    while git('show-ref', '--verify', '--quiet', 'refs/heads/' + backup_branch, check=False).returncode == 0:
        backup_branch = '%s-%d' % (branch_base, suffix)
        suffix += 1

    print('[2/4] 保存覆盖前的本地备份（素材较多时请等待）：%s' % backup_branch, flush=True)
    if source_dirty:
        git_dir_result = git('rev-parse', '--absolute-git-dir', check=False)
        git_dir_text = (
            git('rev-parse', '--git-dir').stdout
            if git_dir_result.returncode else git_dir_result.stdout
        )
        git_dir = Path(git_dir_text.strip())
        if not git_dir.is_absolute():
            git_dir = root / git_dir
        descriptor, temp_index = tempfile.mkstemp(prefix='sundoll-overwrite-', dir=str(git_dir))
        os.close(descriptor)
        os.unlink(temp_index)
        index_env = {'GIT_INDEX_FILE': temp_index}
        try:
            try:
                backup_tree = stage_public(git, root, index_env)
            except ValueError as error:
                raise DownloadError(str(error))
        finally:
            try:
                os.unlink(temp_index)
            except FileNotFoundError:
                pass
        identity_env = {
            'GIT_AUTHOR_NAME': '桑哆尔本地备份',
            'GIT_AUTHOR_EMAIL': 'local-backup@sundoll.invalid',
            'GIT_COMMITTER_NAME': '桑哆尔本地备份',
            'GIT_COMMITTER_EMAIL': 'local-backup@sundoll.invalid',
        }
        backup_commit = git(
            'commit-tree', backup_tree, '-p', local_head,
            '-m', 'GitHub 覆盖前的本地文件备份 ' + timestamp,
            extra_env=identity_env,
        ).stdout.strip()
    else:
        backup_commit = local_head
    git(
        'update-ref', '-m', '一键从 GitHub 覆盖前备份',
        'refs/heads/' + backup_branch, backup_commit,
    )

    print('[3/4] 用 GitHub main 更新公开源码……', flush=True)
    destructive_started = False
    try:
        destructive_started = True
        # Only exact, regular source filenames can be cleaned. Never recurse over
        # a directory: unknown/unignored save files must remain on this computer.
        for index in range(0, len(source_files), 80):
            git('--literal-pathspecs', 'clean', '-fx', '--',
                *source_files[index:index + 80], capture=False)
        git('reset', '--hard', remote_head, capture=False)

        if git('rev-parse', 'HEAD').stdout.strip() != remote_head:
            raise DownloadError('本地 HEAD 未切换到目标版本。')
        worktree_diff = git('diff', '--quiet', check=False).returncode
        index_diff = git('diff', '--cached', '--quiet', check=False).returncode
        if worktree_diff not in (0, 1) or index_diff not in (0, 1):
            raise DownloadError('无法核对覆盖后的 Git 状态。')
        if worktree_diff or index_diff:
            raise DownloadError('覆盖后仍有已跟踪文件不同，可能有文件被其他程序占用。')
        status_after = [
            entry for entry in git(
                'status', '--porcelain=v1', '-z', '--untracked-files=all'
            ).stdout.split('\0') if entry
        ]

        def was_ignored_before(path):
            clean_path = path.rstrip('/')
            return clean_path in ignored_before or any(
                ignored.startswith(clean_path + '/') for ignored in ignored_before
            )

        unexpected = []
        for entry in status_after:
            if not entry.startswith('?? '):
                unexpected.append(entry)
                continue
            if public_path(entry[3:]) and not was_ignored_before(entry[3:]):
                unexpected.append(entry)
        if unexpected:
            raise DownloadError('更新后仍存在未同步源码，可能有程序文件被占用。')
    except (Exception, KeyboardInterrupt) as error:
        if destructive_started:
            try:
                git('reset', '--hard', backup_commit, capture=False)
                git('reset', '--mixed', local_head, capture=False)
                git('read-tree', original_index_tree)
            except Exception as restore_error:
                raise DownloadError(
                    '覆盖中断，自动恢复也未完成。备份分支仍在：%s\n原错误：%s\n恢复错误：%s'
                    % (backup_branch, error, restore_error)
                )
        if isinstance(error, DownloadError):
            raise DownloadError('%s\n已自动恢复覆盖前文件；备份分支：%s' % (error, backup_branch))
        raise DownloadError(
            '覆盖中断：%s\n已自动恢复覆盖前文件；备份分支：%s'
            % (error, backup_branch)
        )

    print('[4/4] 核对 GitHub 当前版本……', flush=True)
    remote_check = git('ls-remote', target, 'refs/heads/main', check=False)
    actual = remote_check.stdout.split() if remote_check.returncode == 0 else []
    remote_check_unavailable = remote_check.returncode != 0
    changed_during_sync = bool(actual) and actual[0] != remote_head

    print('\n覆盖成功！本地 main 已更新：' + remote_head[:12], flush=True)
    print('更新前源码保存在本地分支：' + backup_branch)
    print('如需找回旧内容，请先不要运行“一键上传”，并保留上面的备份分支名。')
    if remote_check_unavailable:
        print('注意：本地覆盖已完成，但网络中断，未能再次核对 GitHub；稍后可重新运行。')
    elif changed_during_sync:
        print('注意：GitHub 在覆盖期间又出现了新版本，请再运行一次本工具。')
    return {
        'changed': True,
        'cancelled': False,
        'commit': remote_head,
        'backupBranch': backup_branch,
        'remoteChangedDuringSync': changed_during_sync,
        'remoteCheckUnavailable': remote_check_unavailable,
    }


def parse_args():
    parser = argparse.ArgumentParser(description='从 GitHub main 更新桑哆尔之歌公开源码，保留本机存档')
    parser.add_argument('--yes', action='store_true', help='跳过 YES 确认，仅供明确需要的自动化使用')
    return parser.parse_args()


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    args = parse_args()
    print('桑哆尔之歌 · 一键从 GitHub 覆盖本地\n' + REPOSITORY)
    print('本工具只下载 GitHub main，不会向 GitHub 上传任何内容。', flush=True)
    try:
        result = download(checkout_root(), assume_yes=args.yes)
        return 0 if result else 1
    except (DownloadError, OSError) as error:
        print('\n覆盖未完成：' + str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('\n已中断。若覆盖已经开始，请查看窗口中的备份分支名。', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
