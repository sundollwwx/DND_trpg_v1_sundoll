"""SQLite adapter for the existing atomic resource commands.

Activated only by the reviewed migration. Legacy JSON is then import-only;
there is no dual write. Character, backpack, map loot and receipts commit in
one transaction. Documents are stored individually, not as one giant JSON.
"""
import copy
import json
import os
from .module_store import ModuleStore, RevisionConflict


class ResourceDatabase:
    def __new__(cls, save_root):
        from .account_characters import context
        if context(save_root):
            from .global_resources import GlobalResources
            return GlobalResources(save_root)
        return super().__new__(cls)

    def __init__(self, save_root):
        self.store = ModuleStore(save_root)

    def active(self):
        marker = self.store.root / 'runtime-v3.json'
        if not self.store.database.exists():
            if marker.exists(): raise OSError('模块数据库缺失，已停止读取旧档以防角色回退')
            return False
        db = self.store.connect()
        try:
            active = self.store.document(db, 'runtime-meta', 'resources') is not None
            if marker.exists() and not active: raise OSError('模块数据库迁移标记缺失，请恢复一致备份')
            return active
        finally:
            db.close()

    def read(self):
        db = self.store.connect()
        try:
            db.execute('BEGIN')
            meta = self.store.document(db, 'runtime-meta', 'resources')
            if not meta: raise ValueError('模块化资源尚未迁移')
            data = dict(version=1, revision=meta['revision'], globalCharacters=True,
                        backpacks={}, characters={'@global': {}}, mapItems={})
            for row in db.execute("SELECT kind,id,payload FROM documents WHERE kind IN ('runtime-character','runtime-backpack','runtime-map')"):
                value = json.loads(row['payload'])
                if row['kind'] == 'runtime-character': data['characters']['@global'][row['id']] = value
                elif row['kind'] == 'runtime-backpack': data['backpacks'][row['id']] = value
                else: data['mapItems'][row['id']] = value
            return data
        finally:
            db.close()

    def read_for_backpack(self, player_id, character_ids=(), all_characters=False):
        """One request snapshot: the recipient's bag and relevant characters.

        Map loot and other players' inventories are not needed to display a bag.
        Keep the global resource revision so any lazy character reconciliation
        still uses the same compare-and-swap protection as a full resource read.
        """
        db = self.store.connect()
        try:
            db.execute('BEGIN')
            meta = self.store.document(db, 'runtime-meta', 'resources')
            if not meta: raise ValueError('模块化资源尚未迁移')
            data = dict(version=1, revision=meta['revision'], globalCharacters=True,
                        backpacks={}, characters={'@global': {}}, mapItems={})
            bag = self.store.document(db, 'runtime-backpack', player_id)
            if bag: data['backpacks'][player_id] = bag['data']
            def collect(rows):
                for row in rows:
                    data['characters']['@global'][row['id']] = json.loads(row['payload'])
            if all_characters:
                collect(db.execute("SELECT id,payload FROM documents WHERE kind='runtime-character'"))
            else:
                collect(db.execute("SELECT id,payload FROM documents WHERE kind='runtime-character' AND owner=?", (player_id,)))
                identities = list(set(character_ids))
                for offset in range(0, len(identities), 400):
                    group = identities[offset:offset + 400]
                    collect(db.execute("SELECT id,payload FROM documents WHERE kind='runtime-character' AND id IN (" +
                                       ','.join('?' for _ in group) + ')', group))
            return data
        finally:
            db.close()

    def save(self, data):
        with self.store.transaction() as db:
            self.save_into(db, data)

    def save_into(self, db, data):
        meta = self.store.document(db, 'runtime-meta', 'resources')
        if not meta or meta['revision'] != data['revision']:
            raise RevisionConflict('角色或物品已被另一操作更新，请刷新后重试')
        changed = False
        for kind, group in (('runtime-character', data['characters']['@global']),
                            ('runtime-backpack', data['backpacks']), ('runtime-map', data.get('mapItems', {}))):
            for key, value in group.items():
                old = self.store.document(db, kind, key)
                if old and old['data'] == value: continue
                owner = value.get('ownerPlayerId', '') if kind == 'runtime-character' else key
                self.store.write_document(db, kind, key, owner, value, old['revision'] if old else 0)
                changed = True
        if changed:
            data['revision'] = self.store.write_document(db, 'runtime-meta', 'resources', '', meta['data'], meta['revision'])

    def activate(self, data, libraries, migration):
        """One transaction establishes the sole authority and migration receipt."""
        with self.store.transaction() as db:
            if self.store.document(db, 'runtime-meta', 'resources'):
                previous = db.execute('SELECT payload FROM migrations WHERE id=?', ('runtime-v3',)).fetchone()
                if previous and json.loads(previous[0]) == migration: return False
                raise RevisionConflict('此目录已经迁移，不能覆盖现有角色和物品')
            for kind, group in (('runtime-character', data['characters']['@global']),
                                ('runtime-backpack', data['backpacks']), ('runtime-map', data.get('mapItems', {})),
                                ('player-library', libraries)):
                for identity, value in group.items():
                    owner = value.get('ownerPlayerId', '') if kind == 'runtime-character' else identity
                    self.store.write_document(db, kind, identity, owner, value, 0)
            self.store.write_document(db, 'runtime-meta', 'resources', '', {'format': 3}, 0)
            db.execute('INSERT INTO migrations VALUES (?,?)', ('runtime-v3', json.dumps(migration, ensure_ascii=False)))
        marker = self.store.root / 'runtime-v3.json'
        temporary = marker.with_suffix('.tmp')
        with temporary.open('w', encoding='utf-8') as handle:
            handle.write('{"format":3,"authority":"sqlite"}')
            handle.flush(); os.fsync(handle.fileno())
        temporary.replace(marker)
        return True
