"""Switch an explicitly closed v3 session to the reviewed sibling workspace."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from build_distribution_v4 import copy_engine,copy_launchers,write_workspace_guide
from migrate_workspace_v4 import migrate

DEVELOPMENT=Path(__file__).resolve().parent
PROJECT=DEVELOPMENT.parent
PACKAGE=PROJECT/'程序包'
LAUNCHERS=('启动桑哆尔之歌.command','启动桑哆尔之歌.bat')


def activate(pid,python):
    app=PACKAGE/'应用';source=PACKAGE/'用户数据/存档'
    roots=('主程序','通用包','战役包','玩家包','运行数据')
    if any((PACKAGE/r).exists() for r in roots):raise ValueError('目标模块目录已存在，不能覆盖')
    command=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True).strip()
    if str(app/'start_server.py') not in command or '--port 8090' not in command:raise ValueError('进程与旧服务不匹配')
    stamp=time.strftime('%Y%m%d-%H%M%S')
    staging=DEVELOPMENT/'同级模块待切换'/stamp
    staging.mkdir(parents=True)
    for name in LAUNCHERS:shutil.copy2(PROJECT/name,staging/(name+'.旧版'))
    shutil.copy2(PACKAGE/'使用说明.md',staging/'使用说明.旧版.md')
    old_log=PACKAGE/'用户数据/运行日志'/('同级切换回退-'+stamp+'.log')
    moved=[];old_app=None;old_data=None;process=None
    def start(engine,log):
        log.parent.mkdir(parents=True,exist_ok=True)
        with log.open('ab') as output:
            return subprocess.Popen([python,'-u',str(engine/'start_server.py'),'--port','8090','--bind','0.0.0.0'],
                cwd=engine,stdin=subprocess.DEVNULL,stdout=output,stderr=output,start_new_session=True,
                env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'))
    os.kill(pid,signal.SIGTERM)
    for _ in range(50):
        result=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
        if result.returncode or result.stdout.strip().startswith('Z'):break
        time.sleep(.1)
    else:raise RuntimeError('旧服务尚未退出，未开始移动数据')
    try:
        report=migrate(source,app,staging/'程序包')
        copy_engine(app,staging/'程序包/主程序')
        copy_launchers(app,staging)
        backup=staging/'程序包/运行数据/恢复备份'/('同级切换前-'+stamp)
        backup.mkdir(parents=True)
        for name in LAUNCHERS:shutil.copy2(staging/(name+'.旧版'),backup/name)
        old_app=backup/'应用';app.rename(old_app)
        old_data=backup/'用户数据';(PACKAGE/'用户数据').rename(old_data)
        for name in roots:
            (staging/'程序包'/name).rename(PACKAGE/name);moved.append(name)
        backup=PACKAGE/'运行数据/恢复备份'/('同级切换前-'+stamp)
        old_app=backup/'应用';old_data=backup/'用户数据'
        for name in LAUNCHERS:shutil.copy2(staging/name,PROJECT/name)
        write_workspace_guide(PACKAGE)
        process=start(PACKAGE/'主程序',PACKAGE/'运行数据/运行日志'/('同级模块服务-'+stamp+'.log'))
        def request(path,body):
            req=urllib.request.Request('http://127.0.0.1:8090'+path,json.dumps(body).encode(),{'Content-Type':'application/json','X-Sundoll-Local-Save':'1'})
            with urllib.request.urlopen(req,timeout=10) as response:return json.load(response)
        for _ in range(60):
            try:
                result=request('/api/local-save',{'op':'status'})
                if result.get('workspace',{}).get('format')==4:break
            except OSError:pass
            if process.poll() is not None:raise RuntimeError('新版服务未能启动')
            time.sleep(.2)
        else:raise RuntimeError('新版服务健康检查失败')
        assert len(request('/api/player-profiles',{'op':'list'})['players'])==report['players']
        campaigns=request('/api/local-save',{'op':'campaign-catalog'})['records']
        assert {r['id']:len(r['state']['maps']) for r in campaigns}=={r['id']:r['maps'] for r in report['campaigns']}
        result=dict(report,pid=process.pid,backup=str(backup),active=True)
        (PACKAGE/'运行数据/正式切换记录-v4.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        return result
    except BaseException:
        if process and process.poll() is None:
            process.terminate();process.wait(timeout=10)
        for name in reversed(moved):(PACKAGE/name).rename(staging/'程序包'/name)
        backup=next((staging/'程序包/运行数据/恢复备份').glob('同级切换前-*'),None)
        if backup:
            if (backup/'应用').exists():(backup/'应用').rename(app)
            if (backup/'用户数据').exists():(backup/'用户数据').rename(PACKAGE/'用户数据')
        for name in LAUNCHERS:shutil.copy2(staging/(name+'.旧版'),PROJECT/name)
        shutil.copy2(staging/'使用说明.旧版.md',PACKAGE/'使用说明.md')
        if app.exists() and source.exists():start(app,old_log)
        raise


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--saved-and-closed',action='store_true',required=True)
    parser.add_argument('--pid',type=int,required=True);parser.add_argument('--python',default=sys.executable)
    args=parser.parse_args();print(json.dumps(activate(args.pid,args.python),ensure_ascii=False))
