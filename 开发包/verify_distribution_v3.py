"""Exercise a built distribution against disposable data, never the author's live server."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urljoin
from html.parser import HTMLParser
PACKAGE = Path(__file__).resolve().parent.parent/'程序包'
APP = next(p for p in (PACKAGE/'主程序',PACKAGE/'应用') if (p/'start_server.py').exists())
sys.path.insert(0,str(APP))
from server.module_runtime import ModuleRuntime
from server.module_store import ModuleStore


def verify(app, source, standard=False):
    app,source=Path(app).resolve(),Path(source).resolve()
    edition=json.loads((app/'distribution.json').read_text())
    protocol=json.loads((app/'shared/protocol.js').read_text().split(' = ',1)[1].rstrip().rstrip(';'))['version']
    manifest=app.parent.parent/'发行清单.json'
    expected_templates=json.loads(manifest.read_text())['generalTemplates'] if manifest.exists() else (37 if standard else 0)
    author=ModuleRuntime(source,APP)
    with tempfile.TemporaryDirectory(prefix='sundoll-package-check-') as temp:
        temp=Path(temp);save=temp/'工作区/运行数据/存档' if edition['format']==4 else temp/'saves'
        campaign=temp/'campaign.sundoll';player=temp/'player.sundoll'
        cm=author.export_campaign('c286','campaign-content',campaign)
        report=json.loads((source/'迁移报告.json').read_text('utf-8'))
        walnut=[c for c in report['characters'] if c['name']=='黑胡桃']
        assert len(walnut)==2 and len({c['playerId'] for c in walnut})==1
        pm=author.export_player(walnut[0]['playerId'],player)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
        env=dict(os.environ,SUNDOLL_TEST_SAVE_ROOT=str(save),PYTHONDONTWRITEBYTECODE='1')
        with (temp/'server.log').open('w') as log:
            process=subprocess.Popen([sys.executable,str(app/'start_server.py'),'--port',str(port),'--bind','127.0.0.1'],cwd=app,env=env,stdout=log,stderr=log)
            try:
                def request(path,body):
                    raw=body if isinstance(body,bytes) else json.dumps(body).encode()
                    req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,raw,{'Content-Type':'application/json','X-Sundoll-Local-Save':'1'})
                    with urllib.request.urlopen(req,timeout=45) as res:return json.load(res)
                deadline=time.monotonic()+30
                while True:
                    try:
                        status=request('/api/local-save',{'op':'status'});break
                    except OSError:
                        if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('Clean server failed to start')
                        time.sleep(.1)
                class Dependencies(HTMLParser):
                    def __init__(self): super().__init__(); self.urls=[]
                    def handle_starttag(self,tag,attributes):
                        attributes=dict(attributes)
                        if tag=='script' and attributes.get('src'): self.urls.append(attributes['src'])
                        if tag=='link' and attributes.get('rel')=='stylesheet': self.urls.append(attributes['href'])
                checked=set()
                for page in ('主控台/主控台.html','主控台/玩家.html','asset/棋子库/棋子库.html'):
                    from urllib.parse import quote
                    page_url=f'http://127.0.0.1:{port}/'+quote(page)
                    with urllib.request.urlopen(page_url) as response: markup=response.read().decode('utf-8')
                    dependencies=Dependencies();dependencies.feed(markup)
                    for dependency in dependencies.urls:
                        url=urljoin(page_url,quote(dependency,safe='/?=&%'))
                        with urllib.request.urlopen(url) as response: assert response.status==200
                        checked.add(url)
                assert status['modular'] is True
                assert request('/api/local-save',{'op':'campaign-catalog'})['records']==[]
                assert request('/api/player-profiles',{'op':'list'})['players']==[]
                library=json.loads(request('/api/local-save',dict(op='read',path='棋子库/棋子库.json'))['text'])['presets']
                assert len(library)==expected_templates,len(library)
                request('/api/modules/import',campaign.read_bytes())
                first=request('/api/modules',dict(op='create-run',moduleId=cm['moduleId'],requestId='clean-install-first-run'))
                replay=request('/api/modules',dict(op='create-run',moduleId=cm['moduleId'],requestId='clean-install-first-run'))
                assert first['campaignId']==replay['campaignId']
                second=request('/api/modules',dict(op='create-run',moduleId=cm['moduleId'],requestId='clean-install-second-run'))
                assert first['campaignId']!=second['campaignId']
                request('/api/modules/import',player.read_bytes())
                request('/api/modules',dict(op='activate-player',moduleId=pm['moduleId']))
                records=request('/api/local-save',dict(op='campaign-catalog'))['records']
                assert len(records)==2
                role=request('/api/player-profiles',dict(op='get',playerId=walnut[0]['playerId']))['library']['pieces']
                assert sorted((r['hpMax'],r['ac']) for r in role)==[(24,16),(43,17)]
                templates=json.loads(request('/api/local-save',dict(op='read',path='棋子库/棋子库.json'))['text'])['presets']
                assert not any(p.get('ownedPieceId') or p.get('characterId') for p in templates)
                # Exercise repeated lightweight switching and disk persistence.
                for cycle in range(10):
                    for rec in records:
                        load=request('/api/local-save',dict(op='read-campaign',path=rec['_path']))
                        state=json.loads(load['text'])['state']
                        assert len(state['maps'])==29
                        result=request('/api/local-save',dict(op='write-campaign',path=rec['_path'],text=load['text'],expectedHash=load['sourceHash'],protocolVersion=protocol))
                        assert result['ok']
                if edition['format']==4:
                    workspace=save.parent.parent
                    assert not (save/'战役').exists()
                    assert len(list((workspace/'战役包').glob('*/当前存档.json')))==2
                    assert (workspace/'玩家包'/walnut[0]['playerId']/'当前档案.json').is_file()
                    assert not (app/'asset/棋子库/立绘').exists()
                store=ModuleStore(save);db=store.connect()
                try: assets=db.execute('SELECT id,size FROM assets').fetchall()
                finally:db.close()
                assert all(store.hash_file(store.asset_path(a['id']))==a['id'] for a in assets)
                return dict(edition='standard' if standard else 'empty',initialTemplates=len(library),campaignRuns=2,mapsPerRun=29,
                    playerAccounts=1,independentCharacters=2,clientDependencies=len(checked),switchAndSaveCycles=10,verifiedAssets=len(assets),result='passed')
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--app',required=True);parser.add_argument('--source',required=True);parser.add_argument('--standard',action='store_true')
    args=parser.parse_args();print(json.dumps(verify(args.app,args.source,args.standard),ensure_ascii=False))
