"""Compatibility adapter: per-character durable bags, room-scoped resource views."""
import copy
import json
from .module_store import ModuleStore, RevisionConflict, encode
from .account_characters import Characters, context


class GlobalResources:
    def __init__(self, save_root):
        root,self.room=context(save_root)
        self.characters=Characters(root)
        self.store=ModuleStore(save_root)

    def active(self): return True

    def read(self):
        db=self.store.connect()
        try:
            db.execute('BEGIN')
            data=dict(version=1,revision=db.execute('SELECT revision FROM people.meta WHERE id=1').fetchone()[0],globalCharacters=True,backpacks={},characters={'@global':{}},mapItems={})
            rows=db.execute('SELECT c.* FROM people.characters c JOIN people.room_characters r ON r.character_id=c.id WHERE r.room=?',(self.room,)).fetchall()
            for row in rows:
                data['characters']['@global'][row['id']]=json.loads(row['runtime'])
                pid=row['carrier']
                if pid not in data['backpacks']:
                    meta=json.loads(db.execute('SELECT metadata FROM people.carriers WHERE id=?',(pid,)).fetchone()[0])
                    data['backpacks'][pid]=dict(meta,playerId=pid,items=[],removedItems=[],wallets={})
                bag=data['backpacks'][pid]
                value=json.loads(db.execute('SELECT payload FROM people.bags WHERE character_id=?',(row['id'],)).fetchone()[0])
                bag['items'].extend(value['items']);bag['removedItems'].extend(value.get('removedItems',[]))
                if value.get('wallet') is not None:bag['wallets'][row['id']]=value['wallet']
            for bag in data['backpacks'].values():
                ids={i['id'] for i in bag['items']+[r['item'] for r in bag['removedItems']]}
                owned={cid for cid,c in data['characters']['@global'].items() if c['ownerPlayerId']==bag['playerId']}
                bag['history']=[e for e in bag.get('history',[]) if e.get('itemId') in ids or e.get('characterId') in owned or e.get('sourceCharacterId') in owned]
            for row in db.execute("SELECT id,payload FROM documents WHERE kind='runtime-map'"):
                data['mapItems'][row['id']]=json.loads(row['payload'])
        finally:db.close()
        self.characters.supply_assets(data,self.store)
        return data

    def read_for_backpack(self, player_id, character_ids=(), all_characters=False):
        return self.read()

    def save(self,data):
        self.characters.adopt_assets(data,self.store)
        with self.store.transaction() as db:self.save_into(db,data)

    def save_into(self,db,data):
        revision=db.execute('SELECT revision FROM people.meta WHERE id=1').fetchone()[0]
        if revision!=data['revision']:raise RevisionConflict('角色或背包已更新，请刷新后重试')
        rows={r['id']:r for r in db.execute('SELECT c.* FROM people.characters c JOIN people.room_characters r ON r.character_id=c.id WHERE r.room=?',(self.room,))}
        changed=False
        for cid,value in data['characters']['@global'].items():
            row=rows.get(cid)
            if not row:raise RevisionConflict('角色未参加当前房间')
            old=json.loads(row['runtime'])
            if value==old:continue
            self.require_active(row)
            if value['ownerPlayerId']!=row['carrier']:raise RevisionConflict('角色归属不能由房间修改')
            db.execute('UPDATE people.characters SET runtime=? WHERE id=?',(encode(value),cid));changed=True
        for pid,bag in data['backpacks'].items():
            selected=[r for r in rows.values() if r['carrier']==pid]
            ids={r['id'] for r in selected}
            items=bag.get('items',[])+[r['item'] for r in bag.get('removedItems',[])]
            if any(i.get('ownerCharacterId') not in ids for i in items):raise RevisionConflict('每件物品必须属于当前房间中的一个角色')
            if any(cid not in ids for cid in bag.get('wallets',{})):raise RevisionConflict('钱包所属角色未参加当前房间')
            bag_changed=False
            for row in selected:
                cid=row['id']
                value=dict(items=[i for i in bag.get('items',[]) if i['ownerCharacterId']==cid],removedItems=[r for r in bag.get('removedItems',[]) if r['item']['ownerCharacterId']==cid],wallet=bag.get('wallets',{}).get(cid))
                old=json.loads(db.execute('SELECT payload FROM people.bags WHERE character_id=?',(cid,)).fetchone()[0])
                if value==old:continue
                self.require_active(row)
                db.execute('UPDATE people.bags SET payload=? WHERE character_id=?',(encode(value),cid));bag_changed=True
            row=db.execute('SELECT metadata FROM people.carriers WHERE id=?',(pid,)).fetchone()
            if not row:raise RevisionConflict('账号角色关联不存在')
            old=json.loads(row[0]);metadata={k:v for k,v in bag.items() if k not in ('items','removedItems','wallets')}
            # Keep out-of-room history private on read and intact on write.
            # One transfer has both send/receive records with the same request ID.
            def event_key(e):return tuple(e.get(k) for k in ('id','op','itemId','characterId','sourceCharacterId'))
            updates={event_key(e):e for e in metadata.get('history',[])}
            known={event_key(e) for e in old.get('history',[])}
            metadata['history']=[updates.get(event_key(e),e) for e in old.get('history',[])]+[e for e in metadata.get('history',[]) if event_key(e) not in known]
            if metadata!=old:
                db.execute('UPDATE people.carriers SET metadata=? WHERE id=?',(encode(metadata),pid));bag_changed=True
            changed=changed or bag_changed
        for cid,value in data.get('mapItems',{}).items():
            old=self.store.document(db,'runtime-map',cid)
            if old and old['data']==value:continue
            self.store.write_document(db,'runtime-map',cid,cid,value,old['revision'] if old else 0);changed=True
        if changed:
            db.execute('UPDATE people.meta SET revision=revision+1')
            data['revision']=revision+1

    def require_active(self,row):
        if row['active_room']!=self.room:
            raise RevisionConflict('此角色正在其他房间冒险，请由角色本人从个人主页切换回来后再修改')
