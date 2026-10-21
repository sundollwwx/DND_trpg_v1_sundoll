import json,os,shutil,socket,subprocess,sys,tempfile,time,urllib.request,urllib.error
from pathlib import Path
from urllib.parse import quote,urljoin
from html.parser import HTMLParser
SOURCE=Path(__file__).resolve().parent.parent/'程序包/主程序'
sys.path.insert(0,str(SOURCE))
from server.module_packages import ModulePackages
class Dependencies(HTMLParser):
 def __init__(self):super().__init__();self.urls=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag=='script' and a.get('src'):self.urls.append(a['src'])
  if tag=='link' and a.get('rel')=='stylesheet':self.urls.append(a['href'])
with tempfile.TemporaryDirectory(prefix='sundoll-unified-http-') as tmp:
 root=Path(tmp);engine=root/'游戏程序';shutil.copytree(SOURCE,engine,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 env={k:v for k,v in os.environ.items() if k!='SUNDOLL_TEST_SAVE_ROOT'};env['PYTHONDONTWRITEBYTECODE']='1'
 log=(root/'server.log').open('wb');p=subprocess.Popen([sys.executable,str(engine/'start_server.py'),'--port',str(port),'--bind','127.0.0.1'],cwd=root,env=env,stdout=log,stderr=log)
 base=f'http://127.0.0.1:{port}';generation=''
 def request(path,body=None,expected=200,raw=None):
  data=raw if raw is not None else json.dumps(body).encode() if body is not None else None
  headers={'Content-Type':'application/json','X-Sundoll-Local-Save':'1','X-Sundoll-Workspace':generation}
  req=urllib.request.Request(base+path,data,headers)
  try:
   with urllib.request.urlopen(req,timeout=30) as r:status=r.status;blob=r.read()
  except urllib.error.HTTPError as e:status=e.code;blob=e.read()
  assert status==expected,(path,status,blob[:800])
  return json.loads(blob)
 try:
  for _ in range(100):
   try:request('/api/workspace-epoch');break
   except OSError:
    if p.poll() is not None:raise RuntimeError((root/'server.log').read_text())
    time.sleep(.1)
  else:raise RuntimeError('startup timeout')
  result={'renamedEngineStarts':True,'doubleClickLauncher':(engine/'启动桑哆尔之歌.command').exists(),'noGhostMainDirectory':not (root/'主程序').exists()}
  initial=request('/api/modules',{'op':'overview'});assert not initial['campaigns'] and not initial['players'] and not initial['general']
  urls=set()
  for page in ('主控台/主控台.html','主控台/玩家.html','asset/棋子库/棋子库.html'):
   url=base+'/'+quote(page)
   with urllib.request.urlopen(url) as r:html=r.read().decode()
   parser=Dependencies();parser.feed(html)
   for link in parser.urls:
    u=urljoin(url,quote(link,safe='/?=&%'))
    with urllib.request.urlopen(u) as r:assert r.status==200
    urls.add(u)
  result['pageDependencies']=len(urls)
  player=request('/api/player-profiles',{'op':'create','name':'第一玩家'})
  state={'campaignId':'c-http','campaignName':'验证冒险','maps':[{'id':'m','name':'入口','tokens':[]}]}
  request('/api/local-save',{'op':'write-campaign','path':'战役/c-http/当前存档.json','text':json.dumps({'campaignId':'c-http','campaignName':'验证冒险','state':state}),'expectedHash':None,'protocolVersion':34})
  source=ModulePackages(root/'source',engine);pkg=root/'general.sundoll';source.export(pkg,'general','测试来源',{'templates':[{'id':'test','name':'测试棋子','hpMax':10,'category':'通用生物/野兽'}],'items':[]},'http-general')
  preview=request('/api/modules/preview',raw=pkg.read_bytes());request('/api/modules',{'op':'confirm-import','ticket':preview['ticket']});request('/api/modules',{'op':'activate-general','moduleId':'http-general'})
  backup=request('/api/modules',{'op':'backup-create'})['backup'];oldStorage=request('/api/local-save',{'op':'status'})['storageId']
  request('/api/player-profiles',{'op':'create','name':'备份后玩家'})
  request('/api/modules',{'op':'uninstall','moduleId':'http-general'});assert not request('/api/modules',{'op':'overview'})['general']
  # Actual subprocess restart and restoration, not mocked handler execution.
  request('/api/modules',{'op':'backup-restore','backupId':backup['id']})
  request('/api/modules',{'op':'overview'},expected=409)
  for _ in range(200):
   try:
    v=request('/api/workspace-epoch')
    if v.get('epoch'):break
   except OSError:pass
   if p.poll() is not None:raise RuntimeError((root/'server.log').read_text())
   time.sleep(.1)
  else:raise RuntimeError('restore restart timeout')
  request('/api/player-profiles',{'op':'create','name':'旧页拒绝'},expected=409)
  generation=v['epoch'];after=request('/api/modules',{'op':'overview'})
  assert len(after['players'])==1 and len(after['campaigns'])==1 and len(after['general'])==1
  assert request('/api/local-save',{'op':'status'})['storageId']!=oldStorage
  assert (root/'运行数据/存档/.server.lock').exists()
  result.update(restoreRestartsService=True,stalePageRejected=True,cacheNamespaceRotated=True,playersRestored=1,campaignsRestored=1,generalRestored=1)
  exported=request('/api/modules',{'op':'backup-export','backupId':backup['id']})
  with urllib.request.urlopen(base+exported['downloadUrl']) as r:archive=r.read()
  request('/api/workspace-backups/import',raw=archive)
  request('/api/modules',{'op':'restore-campaign','campaignId':'c-http','path':'战役/c-http/当前存档.json'})
  result['privateBackupRoundTrip']=True
  print(json.dumps(result,ensure_ascii=False));Path('/tmp/sundoll-unified-http-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 except Exception:
  log.flush();print((root/'server.log').read_text()[-4000:]);raise
 finally:
  p.terminate()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  log.close()
