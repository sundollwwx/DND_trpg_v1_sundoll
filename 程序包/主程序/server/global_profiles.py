"""Legacy game transports backed by account-owned, room-selected characters.

No user creates a player profile here. A carrier is a private compatibility key
for existing map/session messages; character ownership is stored directly.
"""
import copy
import json
import secrets
from .player_profiles import Store, ProfileError
from .account_characters import Characters, context
from .module_store import ModuleStore, RevisionConflict, encode


class GlobalProfiles(Store):
    def __init__(self,save_root,project_root,cache_root):
        super().__init__(save_root,project_root,cache_root)
        root,self.room=context(save_root)
        self.characters=Characters(root)

    def players(self):
        with self.characters.connect() as db:
            rows=db.execute('SELECT DISTINCT p.* FROM carriers p JOIN characters c ON c.carrier=p.id JOIN room_characters r ON r.character_id=c.id WHERE r.room=?',(self.room,)).fetchall()
            result=[]
            for r in rows:
                characters=[dict(characterId=c['id'],name=json.loads(c['runtime'])['name']) for c in db.execute('SELECT c.id,c.runtime FROM characters c JOIN room_characters rc ON rc.character_id=c.id WHERE rc.room=? AND c.carrier=? ORDER BY c.id',(self.room,r['id']))]
                result.append(dict(playerId=r['id'],name=r['name'],enabled=bool(r['enabled']),revision=1,accountId=r['account_id'],characterMode=True,characters=characters))
            return result

    def read(self,pid):
        found=next((p for p in self.players() if p['playerId']==pid),None)
        if found is None:raise ProfileError('角色未参加当前房间',404)
        return found

    def preferred_character(self,pid):
        person=self.read(pid)
        with self.characters.connect() as db:
            row=db.execute('SELECT c.id FROM room_focus f JOIN characters c ON c.id=f.character_id JOIN room_characters r ON r.character_id=c.id AND r.room=f.room WHERE f.room=? AND f.account_id=? AND c.carrier=?',(self.room,person.get('accountId'),pid)).fetchone()
            if row:return row['id']
            row=db.execute('SELECT c.id FROM characters c JOIN room_characters r ON r.character_id=c.id WHERE r.room=? AND c.carrier=? ORDER BY c.id LIMIT 1',(self.room,pid)).fetchone()
            return row['id'] if row else ''

    def session_valid(self,pid,version):
        try:return bool(self.read(pid)['enabled'] and version=='account-characters-v1')
        except ProfileError:return False

    def library(self,pid):
        self.read(pid)
        with self.characters.connect() as db:
            db.execute('BEGIN')
            meta=json.loads(db.execute('SELECT metadata FROM carriers WHERE id=?',(pid,)).fetchone()[0])
            rows=db.execute('SELECT c.* FROM characters c JOIN room_characters r ON r.character_id=c.id WHERE r.room=? AND c.carrier=?',(self.room,pid)).fetchall()
            pieces=[]
            for row in rows:
                piece=json.loads(row['sheet']);c=json.loads(row['runtime'])
                piece.update(c['base'],**c['runtime'],name=c['name'],characterRevision=c['revision'],characterId=c['id'],ownerAccountId=row['account_id'],activeRoomId=row['active_room'])
                piece.pop('campaignStates',None);piece.pop('mapSyncStates',None)
                pieces.append(piece)
        self.characters.supply_assets(pieces,ModuleStore(self.save_root))
        return dict(revision=meta.get('libraryRevision',1),pieces=pieces,grants=meta.get('grants',{}))

    def commit_library(self,pid,lib):
        self.read(pid)
        self.characters.adopt_assets(lib,ModuleStore(self.save_root))
        from .resources import ResourceStore
        with self.characters.transaction() as db:
            carrier=db.execute('SELECT * FROM carriers WHERE id=?',(pid,)).fetchone()
            meta=json.loads(carrier['metadata'])
            if meta.get('libraryRevision',1)!=lib['revision']:raise ProfileError('角色列表已更新，请刷新后重试',409)
            old={r['id']:r for r in db.execute('SELECT c.* FROM characters c JOIN room_characters r ON r.character_id=c.id WHERE r.room=? AND c.carrier=?',(self.room,pid))}
            if not set(old).issubset({p['ownedPieceId'] for p in lib['pieces']}):raise ProfileError('移出房间不能删除账号角色',409)
            for piece in lib['pieces']:
                cid=piece['ownedPieceId'];row=old.get(cid)
                if row:
                    c=json.loads(row['runtime']);former=json.loads(row['sheet'])
                    if piece.get('characterRevision')!=c['revision']:
                        raise ProfileError('角色数值已更新，请刷新资料后重试',409)
                    original=dict(former,**c['base'],**c['runtime'],name=c['name'],characterRevision=c['revision'],characterId=c['id'],ownerAccountId=row['account_id'],activeRoomId=row['active_room'])
                    if piece==original:continue
                    if row['active_room']!=self.room:raise ProfileError('角色正在其他房间冒险，当前房间只能查看',409)
                    changes={k:piece[k] for k in ('hpMax','ac','level') if piece.get(k)!=c['base'].get(k) and k in piece}
                    if changes or c['name']!=piece['name']:
                        c['base']=ResourceStore.base(dict(c['base'],**changes));c['runtime']=ResourceStore.runtime(c['runtime'],c['base'])
                        c.update(name=piece['name'],revision=c['revision']+1)
                    db.execute('UPDATE characters SET sheet=?,runtime=? WHERE id=?',(encode(piece),encode(c),cid))
                else:
                    if db.execute('SELECT 1 FROM characters WHERE id=?',(cid,)).fetchone():raise ProfileError('角色身份重复',409)
                    base=ResourceStore.base(piece);c=dict(id=cid,ownerPlayerId=pid,name=piece['name'],revision=1,base=base,runtime=ResourceStore.runtime(piece,base))
                    db.execute('INSERT INTO characters VALUES (?,?,?,?,?,?,?)',(cid,pid,carrier['account_id'],self.room,self.room,encode(piece),encode(c)))
                    db.execute('INSERT INTO bags VALUES (?,?)',(cid,encode(dict(items=[],removedItems=[],wallet=None))))
                    db.execute('INSERT INTO room_characters VALUES (?,?)',(self.room,cid))
            meta.update(libraryRevision=lib['revision']+1,grants=lib.get('grants',{}))
            db.execute('UPDATE carriers SET metadata=? WHERE id=?',(encode(meta),pid))
            db.execute('UPDATE meta SET revision=revision+1')
        return self.library(pid)

    def create(self,*args,**kwargs):
        raise ProfileError('请在个人主页创建角色，再选择角色加入房间',409)

    def rename(self,*args,**kwargs):
        raise ProfileError('请编辑角色名称，无需另设玩家档案名称',409)

    def delete(self,*args,**kwargs):
        raise ProfileError('房间不能删除账号角色；移除成员只撤销房间访问',409)

    def rotate(self,*args,**kwargs):
        raise ProfileError('角色使用邮箱账号登录，无需单独凭证',409)
