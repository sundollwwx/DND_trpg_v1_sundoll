"""Explicit, previewed backup retention; never delete on startup or save."""
import hashlib
import json
import re
import shutil
import time

from . import player_profiles as profiles
from .save_storage import SAVE_WRITE_LOCK
from .workspace import atomic_json
from .workspace_backup import Backups


class BackupPlanConflict(ValueError):
    pass


class BackupRetention:
    def __init__(self, save_root):
        self.backups = Backups(save_root)
        self.workspace = self.backups.workspace
        self.settings = self.workspace.checked(self.workspace.root / '运行数据/备份保留设置.json')

    def _read(self):
        if not self.settings.exists():
            return {'version': 1, 'keepCount': 10, 'keepDays': 30, 'pinnedIds': [], 'receipts': {}}
        data = json.loads(self.settings.read_text('utf-8'))
        if data.get('version') != 1:
            raise ValueError('备份保留设置版本无效，现有备份未改变')
        self._policy(data.get('keepCount'), data.get('keepDays'))
        if not isinstance(data.get('pinnedIds'), list) or not isinstance(data.get('receipts', {}), dict):
            raise ValueError('备份保留设置无效，现有备份未改变')
        return data

    @staticmethod
    def _policy(count, days):
        if type(count) is not int or not 1 <= count <= 1000:
            raise ValueError('最近保留份数应为 1–1000')
        if type(days) is not int or not 0 <= days <= 3650:
            raise ValueError('最近保留天数应为 0–3650')

    def _protected(self, backups, settings):
        protected = {identity: ['手动保留'] for identity in settings['pinnedIds']}
        if backups:
            protected.setdefault(backups[0]['id'], []).append('最新备份')
        for backup in backups:
            if any(text in backup['name'] for text in ('迁移', '恢复前', '切换前')):
                protected.setdefault(backup['id'], []).append('重要恢复点')
        if self.backups.journal.exists():
            journal = json.loads(self.backups.journal.read_text('utf-8'))
            protected.setdefault(journal.get('rollbackId'), []).append('待恢复回退点')
            job = str(journal.get('job', ''))
            if not re.fullmatch(r'运行数据/恢复任务/r[0-9a-f]{32}', job):
                raise ValueError('待恢复任务无效，备份清理已停止')
            manifest = self.workspace.checked(self.workspace.root / job / '备份清单.json')
            if manifest.exists():
                source = json.loads(manifest.read_text('utf-8'))['id']
                protected.setdefault(source, []).append('待恢复来源')
        return protected

    def _overview(self):
        settings = self._read()
        backups = self.backups.list()
        protected = self._protected(backups, settings)
        now_ms = int(time.time() * 1000)
        threshold = now_ms - settings['keepDays'] * 86400000
        candidates = []
        for index, backup in enumerate(backups):
            backup['pinned'] = backup['id'] in settings['pinnedIds']
            backup['protectionReasons'] = protected.get(backup['id'], [])
            backup['protected'] = bool(backup['protectionReasons'])
            backup['canTogglePin'] = not any(reason != '手动保留' for reason in backup['protectionReasons'])
            if not backup['protected'] and index >= settings['keepCount'] and backup['createdAt'] <= threshold:
                candidates.append(backup)
        policy = {key: settings[key] for key in ('keepCount', 'keepDays')}
        # Include all rows so new backups or a changed recovery intent invalidate
        # an old preview, even when its proposed deletion list happens to match.
        basis = {'policy': policy, 'backups': backups, 'candidateIds': [b['id'] for b in candidates]}
        token = hashlib.sha256(json.dumps(basis, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        return {
            'backups': backups,
            'policy': dict(policy, automaticDeletion=False),
            'storage': {'count': len(backups), 'totalBytes': sum(b['bytes'] for b in backups),
                        'protectedCount': sum(b['protected'] for b in backups)},
            'plan': {'previewToken': token, 'candidates': candidates,
                     'reclaimableBytes': sum(b['bytes'] for b in candidates)},
        }

    def overview(self):
        with SAVE_WRITE_LOCK, profiles.LOCK:
            return self._overview()

    def set_policy(self, keep_count, keep_days):
        self._policy(keep_count, keep_days)
        with SAVE_WRITE_LOCK, profiles.LOCK:
            settings = self._read()
            settings.update(keepCount=keep_count, keepDays=keep_days)
            atomic_json(self.settings, settings)
            return self._overview()

    def set_pinned(self, identity, pinned):
        if type(pinned) is not bool:
            raise ValueError('保留标记无效')
        with SAVE_WRITE_LOCK, profiles.LOCK:
            current = self._overview()
            backup = next((b for b in current['backups'] if b['id'] == identity), None)
            if not backup:
                raise ValueError('备份不存在')
            if not backup['canTogglePin']:
                raise ValueError('最新备份、重要恢复点和待恢复备份始终保留')
            settings = self._read()
            ids = set(settings['pinnedIds'])
            ids.add(identity) if pinned else ids.discard(identity)
            settings['pinnedIds'] = sorted(ids)
            atomic_json(self.settings, settings)
            return self._overview()

    def apply(self, preview_token, identities, request_id):
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{12,96}', request_id):
            raise ValueError('备份清理操作编号无效')
        if not isinstance(identities, list) or not identities or not all(isinstance(x, str) for x in identities):
            raise ValueError('请先选择要清理的备份')
        if len(set(identities)) != len(identities):
            raise ValueError('备份清理选择重复')
        with SAVE_WRITE_LOCK, profiles.LOCK:
            settings = self._read()
            fingerprint = hashlib.sha256(json.dumps({'token': preview_token, 'ids': sorted(identities)}, sort_keys=True).encode()).hexdigest()
            old = settings.get('receipts', {}).get(request_id)
            if old:
                if old['fingerprint'] != fingerprint:
                    raise BackupPlanConflict('同一清理操作不能改变选择，请重新预览')
                return self._complete(request_id, settings) if old.get('pending') else old['result']
            overview = self._overview()
            if preview_token != overview['plan']['previewToken']:
                raise BackupPlanConflict('备份或保留策略已变化，请重新预览清理')
            eligible = {b['id']: b for b in overview['plan']['candidates']}
            if not set(identities) <= set(eligible):
                raise BackupPlanConflict('选择包含受保护或不符合策略的备份，请重新预览')
            # Persist intent first. A retry can finish a partial deletion after
            # an I/O error without deleting any newly created backup.
            receipt = {'fingerprint': fingerprint, 'pending': True,
                       'result': {'deletedIds': identities, 'reclaimedBytes': sum(eligible[x]['bytes'] for x in identities)}}
            settings.setdefault('receipts', {})[request_id] = receipt
            atomic_json(self.settings, settings)
            return self._complete(request_id, settings)

    def _complete(self, request_id, settings):
        receipt = settings['receipts'][request_id]
        protected = self._protected(self.backups.list(), settings)
        if any(identity in protected and self.backups.path(identity).exists()
               for identity in receipt['result']['deletedIds']):
            raise BackupPlanConflict('尚未完成的清理涉及新保留的恢复点，清理已停止')
        for identity in receipt['result']['deletedIds']:
            folder = self.backups.path(identity)
            if folder.exists():
                shutil.rmtree(folder)
        receipt['pending'] = False
        # Keep a bounded retry ledger, never evict an incomplete operation.
        complete = [key for key, value in settings['receipts'].items() if not value.get('pending')]
        for key in complete[:-20]:
            del settings['receipts'][key]
        atomic_json(self.settings, settings)
        return receipt['result']
