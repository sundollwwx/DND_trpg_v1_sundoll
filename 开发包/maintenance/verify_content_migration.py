#!/usr/bin/env python3
"""Read-only, field-by-field acceptance of the content-origin migration.

Use an untouched SQLite backup as --before-db. This tool never initializes the
application, repairs outboxes, migrates saves, or updates authoritative data.
SQLite may initialize its empty WAL coordination sidecars while reading.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '程序包/主程序'))
from server.sqlite_read import open_readonly_database


ORIGIN_FIELDS = {
    'sourcePackageId', 'sourceScope', 'sourceCampaignId',
    'sourceTemplateId', 'sourceTemplateVersion',
    'sourcePlayerId', 'sourceCharacterId', 'boundCharacterId',
}


def read_database(path):
    connection = open_readonly_database(path)
    connection.execute('BEGIN')
    try:
        integrity = [row[0] for row in connection.execute('PRAGMA integrity_check')]
        foreign_keys = [tuple(row) for row in connection.execute('PRAGMA foreign_key_check')]
        documents = {}
        for row in connection.execute('SELECT kind,id,owner,revision,payload FROM documents'):
            value = dict(row)
            value['data'] = json.loads(value['payload'])
            documents[(row['kind'], row['id'])] = value
        receipt = connection.execute(
            "SELECT payload FROM migrations WHERE id='content-origins-v1'").fetchone()
        return documents, json.loads(receipt[0]) if receipt else None, integrity, foreign_keys
    finally:
        connection.close()


def item_paths(kind, value):
    if kind == 'runtime-backpack':
        for index, item in enumerate(value.get('items', [])):
            yield ('items', index), item
        for index, entry in enumerate(value.get('removedItems', [])):
            yield ('removedItems', index, 'item'), entry['item']
    elif kind == 'runtime-map':
        for map_id, group in value.items():
            for marker_index, marker in enumerate(group.get('markers', [])):
                for index, item in enumerate(marker.get('items', [])):
                    yield (map_id, 'markers', marker_index, 'items', index), item
                if marker.get('containerItem'):
                    yield (map_id, 'markers', marker_index, 'containerItem'), marker['containerItem']


def at_path(value, path):
    for key in path:
        value = value[key]
    return value


def only_origin_additions(kind, before, after):
    """Discard only allowed new fields; existing values must remain identical."""
    restored = copy.deepcopy(after)
    if kind == 'item-template':
        if 'contentPackageId' not in before:
            restored.pop('contentPackageId', None)
    else:
        for path, original in item_paths(kind, before):
            try:
                updated = at_path(restored, path)
            except (KeyError, IndexError, TypeError):
                return False
            if not isinstance(updated, dict):
                return False
            for field in ORIGIN_FIELDS - original.keys():
                updated.pop(field, None)
    return restored == before


def verify(before_path, after_path, plan, audit=None):
    before, _, before_integrity, before_fk = read_database(before_path)
    after, receipt, after_integrity, after_fk = read_database(after_path)
    errors = []

    def check(condition, message):
        if not condition:
            errors.append(message)

    check(before_integrity == ['ok'] and not before_fk, '迁移前数据库完整性检查失败')
    check(after_integrity == ['ok'] and not after_fk, '迁移后数据库完整性检查失败')
    check(not plan.get('unresolved'), '迁移预览仍有未确认物品')
    changes = {(entry['kind'], entry['id']): entry for entry in plan['changes']}
    check(len(changes) == len(plan['changes']), '迁移预览包含重复文档')
    check(bool(receipt) and receipt.get('planHash') == plan['planHash'], '迁移回执与指定方案不一致')
    if receipt:
        for field, expected in plan['summary'].items():
            check(receipt.get(field) == expected, '迁移回执汇总不一致：' + field)

    if audit:
        fingerprints = {(entry['kind'], entry['id']): entry for entry in audit['documentFingerprints']}
        check(set(fingerprints) == set(before), '迁移前文档集合与只读审计不同')
        for key, expected in fingerprints.items():
            actual = before.get(key)
            check(actual is not None and actual['owner'] == expected['owner']
                  and actual['revision'] == expected['revision']
                  and hashlib.sha256(actual['payload'].encode()).hexdigest() == expected['sha256'],
                  '迁移前审计指纹不一致：' + '/'.join(key))

    has_runtime = any(kind.startswith('runtime-') for kind, _ in changes)
    has_templates = any(kind == 'item-template' for kind, _ in changes)
    for key, original in before.items():
        label = '/'.join(key)
        current = after.get(key)
        if current is None:
            errors.append('原文档丢失：' + label)
            continue
        expected_data = original['data']
        expected_revision = original['revision']
        if key in changes:
            entry = changes[key]
            check(entry['owner'] == original['owner'] and entry['revision'] == original['revision'],
                  '方案起始版本或归属不一致：' + label)
            expected_data = entry['data']
            expected_revision += 1
            check(only_origin_additions(key[0], original['data'], expected_data),
                  '方案改写原字段或删改原物品：' + label)
            check(only_origin_additions(key[0], original['data'], current['data']),
                  '实际迁移改写原字段或删改原物品：' + label)
        elif has_runtime and key == ('runtime-meta', 'resources'):
            expected_revision += 1
        elif has_templates and key == ('catalog-meta', 'item-template'):
            expected_data = dict(expected_data, revision=expected_data.get('revision', 0) + 1)
            expected_revision += 1
        check(current['owner'] == original['owner'], '原文档归属改变：' + label)
        check(current['revision'] == expected_revision, '文档版本变化超出迁移范围：' + label)
        check(current['data'] == expected_data, '文档内容与迁移方案不一致：' + label)

    allowed_new = {('content-package', p['id']) for p in plan['packages']}
    allowed_new.update(('content-selection', p['campaignId']) for p in plan['campaigns'])
    check(set(after) - set(before) == allowed_new - set(before), '新增文档集合与预览不一致')
    for package in plan['packages']:
        current = after.get(('content-package', package['id']), {}).get('data', {})
        check(all(current.get(field) == package.get(field) for field in
                  ('id', 'name', 'scope', 'sourceCampaignId', 'localOwner')),
              '内容包身份或归属不一致：' + package['id'])
    for campaign in plan['campaigns']:
        current = after.get(('content-selection', campaign['campaignId']), {}).get('data', {})
        check(current.get('sourcePackageId') == campaign['sourcePackageId'] and
              current.get('enabledPackageIds') == campaign['enabledPackageIds'],
              '战役启用内容不一致：' + campaign['campaignId'])

    item_count = 0
    for (kind, identity), document in after.items():
        for path, item in item_paths(kind, document['data']):
            item_count += 1
            check(bool(item.get('sourcePackageId')) and item.get('sourceScope') in
                  ('general', 'campaign', 'personal'), '物品来源缺失：' + identity + '/' + str(path))
            if item.get('sourceScope') == 'personal':
                check(bool(item.get('sourcePlayerId')) and bool(item.get('sourceCharacterId')),
                      '角色专属物品来源身份缺失：' + str(item.get('id')))
    return {
        'passed': not errors, 'readOnly': True,
        'beforeDatabase': str(Path(before_path).resolve()),
        'afterDatabase': str(Path(after_path).resolve()),
        'planHash': plan['planHash'], 'baselineDocuments': len(before),
        'resultDocuments': len(after), 'changedDocuments': len(changes),
        'checkedItemSnapshots': item_count,
        'integrityBefore': before_integrity, 'integrityAfter': after_integrity,
        'errors': errors,
        'scope': '核查 SQLite 文档、全部物品快照及迁移回执；不验证浏览器交互或素材文件内容。',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before-db', required=True, type=Path)
    parser.add_argument('--after-db', required=True, type=Path)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--audit', type=Path)
    parser.add_argument('--output', type=Path, help='可选：将报告写到指定维护目录；数据库始终只读')
    args = parser.parse_args()
    report = verify(args.before_db, args.after_db, json.loads(args.plan.read_text('utf-8')),
                    json.loads(args.audit.read_text('utf-8')) if args.audit else None)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf-8')
    print(rendered, end='')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
