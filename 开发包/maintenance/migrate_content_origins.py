#!/usr/bin/env python3
"""Preview content-origin migration; apply only with a reviewed hash and lock."""
import argparse
import json
from pathlib import Path
import re
import shutil
import sqlite3
import sys


APP_ROOT = Path(__file__).resolve().parents[2] / '程序包/主程序'
sys.path.insert(0, str(APP_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from server.content_packages import ContentPackages
from server.paths import local_save_root
from server.save_storage import ProjectServerLock
from server.sqlite_read import open_readonly_database
from server.storage_mode import account_rooms_only, ARCHIVE_FILE
from server.workspace import atomic_json
from server.workspace_backup import Backups
from verify_content_migration import verify


def migration_receipt(database):
    connection = open_readonly_database(database)
    try:
        row = connection.execute(
            "SELECT payload FROM migrations WHERE id='content-origins-v1'").fetchone()
        return json.loads(row[0]) if row else None
    finally:
        connection.close()


def run(save_root, overrides=None, apply=False, expected_plan_hash=None, output=None):
    root = Path(save_root).resolve()
    service = ContentPackages(root)
    if account_rooms_only(root):
        raise ValueError('中央目录只保存账号关联，请用 --save-root 明确选择具体房间')
    if apply and any((parent/ARCHIVE_FILE).exists() for parent in (service.workspace.root, *service.workspace.root.parents)):
        raise ValueError('历史归档只允许预览；请在独立恢复副本中修改')
    report_path = Path(output).resolve() if output else None
    if report_path and report_path.is_relative_to(service.workspace.root):
        raise ValueError('维护输出请放在程序包以外，避免覆盖活动模块或运行数据')
    if not apply:
        plan = service.migration_plan(overrides)
        if report_path:
            atomic_json(report_path, plan)
        return plan
    if not re.fullmatch(r'[0-9a-f]{64}', str(expected_plan_hash)):
        raise ValueError('执行迁移必须提供已审查的 --expected-plan-hash')
    if not report_path:
        raise ValueError('执行迁移必须用 --output 指定维护报告文件')

    # Acquire the same OS lock as the server before any backup or migration.
    lock = ProjectServerLock(root)
    try:
        receipt = migration_receipt(service.database)
        if receipt:
            if receipt.get('planHash') != expected_plan_hash:
                raise ValueError('这个工作区已执行另一份来源迁移，未进行任何新迁移')
            if report_path.is_file():
                previous = json.loads(report_path.read_text('utf-8'))
                if previous.get('planHash') == expected_plan_hash and previous.get('migrationResult') == receipt:
                    return dict(previous, alreadyApplied=True)
            return dict(phase='already-applied', alreadyApplied=True, planHash=expected_plan_hash,
                        migrationResult=receipt, backupId=None,
                        note='已存在同一迁移回执；未重复备份或执行。原维护报告未在此输出路径找到。')

        plan = service.migration_plan(overrides)
        if plan['planHash'] != expected_plan_hash:
            raise ValueError('存档或归属方案已变化，迁移哈希不一致；请重新生成并审查预览')
        if plan['unresolved']:
            raise ValueError('仍有旧物品来源待确认，未执行备份或迁移')
        backups = Backups(root)
        if backups.journal.exists():
            raise ValueError('工作区有待完成的整套恢复；请先完成恢复再重新预览')
        backup = backups.create('内容来源迁移前自动备份')

        # Backup creation finishes committed projections. Recheck after that
        # recovery, rather than migrating from an earlier potentially stale view.
        plan = ContentPackages(root).migration_plan(overrides)
        if plan['planHash'] != expected_plan_hash:
            raise ValueError('备份完成后存档指纹变化，已停止迁移；备份编号：' + backup['id'])

        artifacts = report_path.with_name(report_path.stem + '-资料')
        artifacts.mkdir(parents=True, exist_ok=True)
        before = artifacts / 'before.sqlite3'
        if before.exists():
            raise ValueError('维护资料目录已有 before.sqlite3，请换用新的输出文件名')
        backed_up_database = backups.path(backup['id']) / '数据' / service.database.relative_to(backups.root)
        shutil.copy2(backed_up_database, before)
        # Only the independent snapshot changes journal mode. The formal DB and
        # the checksum-protected full backup remain untouched by this step.
        snapshot = sqlite3.connect(str(before))
        try:
            if snapshot.execute('PRAGMA journal_mode=DELETE').fetchone()[0] != 'delete':
                raise RuntimeError('独立迁移前快照无法准备为只读核查格式')
        finally:
            snapshot.close()
        atomic_json(artifacts / 'plan.json', plan)
        report = dict(phase='backed-up', planHash=plan['planHash'], backupId=backup['id'],
                      backup=backup, beforeDatabase=str(before), afterDatabase=str(service.database))
        atomic_json(report_path, report)
        try:
            result = ContentPackages(root).apply_migration(plan)
            report.update(phase='applied', migrationResult=result)
            atomic_json(report_path, report)
            verification = verify(before, service.database, plan)
            report.update(phase='verified' if verification['passed'] else 'verification-failed',
                          verification=verification)
            atomic_json(report_path, report)
            return report
        except Exception as exc:
            report.update(phase='stopped', error=str(exc))
            atomic_json(report_path, report)
            raise
    finally:
        lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--save-root', type=Path, default=local_save_root())
    parser.add_argument('--overrides', type=Path, help='按实例 ID 提供已确认来源的 JSON')
    parser.add_argument('--output', type=Path, help='预览文件；执行模式下为必填的维护报告文件')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-plan-hash', '--expectedPlanHash', dest='expected_plan_hash')
    args = parser.parse_args()
    try:
        overrides = json.loads(args.overrides.read_text('utf-8')) if args.overrides else {}
        result = run(args.save_root, overrides, args.apply, args.expected_plan_hash, args.output)
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if not args.apply and args.output:
        result = dict(readOnly=True, output=str(args.output.resolve()), planHash=result['planHash'],
                      summary=result['summary'])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result.get('phase') == 'verification-failed' else 0


if __name__ == '__main__':
    sys.exit(main())
