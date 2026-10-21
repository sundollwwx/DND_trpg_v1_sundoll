"""Historical v3 builder for the archived 程序包/应用 layout.

Current sibling workspaces use build_distribution_v4.py --source SAVE_ROOT
--destination NEW_DIRECTORY. Never archive the working directory or user data.
"""
import argparse
import json
from pathlib import Path
import shutil
import sys
import zipfile
PACKAGE=Path(__file__).resolve().parent.parent/'程序包'
sys.path.insert(0,str(PACKAGE/'应用'))

def build(app, source_save, destination, standard=False):
    from server.static_policy import PUBLIC_FILES, HOST_FILES
    from server.module_packages import ModulePackages
    from server.module_store import ModuleStore
    app, source_save, destination = Path(app), Path(source_save), Path(destination)
    if destination.exists(): raise ValueError('发行目标必须为新目录')
    output=destination/'程序包/应用';output.mkdir(parents=True)
    allowed=set(PUBLIC_FILES)|set(HOST_FILES)|{'start_server.py','launch_sundoll.py','shared/protocol.js'}
    allowed.update(p.relative_to(app).as_posix() for p in (app/'server').rglob('*.py'))
    allowed.update(p.relative_to(app).as_posix() for p in (app/'asset/界面').rglob('*') if p.is_file() and p.suffix.lower() in {'.js','.css','.png','.jpg','.jpeg','.webp','.svg','.mp3','.wav','.ogg','.m4a'})
    for relative in sorted(allowed):
        if relative=='asset/棋子库/默认预设.js': continue
        source=app/relative
        if not source.is_file() or source.is_symlink(): raise ValueError('缺少发行文件：'+relative)
        target=output/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
    (output/'asset/棋子库/默认预设.js').write_text('window.__LIBRARY_SEED__ = [];\n',encoding='utf-8')
    (output/'distribution.json').write_text(json.dumps({'format':3,'edition':'standard' if standard else 'empty'},ensure_ascii=False),encoding='utf-8')
    project=app.parent.parent
    for name in ('启动桑哆尔之歌.command','启动桑哆尔之歌.bat'):
        shutil.copy2(project/name,destination/name)
    general_count=item_count=0
    if standard:
        library=json.loads((source_save/'棋子库/棋子库.json').read_text('utf-8'))
        templates=[p for p in library['presets'] if str(p.get('category','')).startswith('通用生物/') and not p.get('ownedPieceId') and not p.get('characterId')]
        items=json.loads((source_save/'玩家档案/物品库.json').read_text('utf-8'))['templates']
        items=[i for i in items if i.get('scope')=='general' and not i.get('archived')]
        ModulePackages(source_save,app).export(destination/'程序包/内容包/通用内容.sundoll','general','通用棋子与物品',{'templates':templates,'items':items},'sundoll-general-v3')
        general_count,item_count=len(templates),len(items)
    readme='''# 桑哆尔之歌 · 模块版\n\n解压后双击对应系统的启动器，需要 Python 3.9 或更高版本。\n\n本发行包不带作者的战役、玩家、登录码或个人资源。首次启动会在本机生成自己的用户数据。\n\n主控台右上角“冒险模块”可以导入 .sundoll 文件。战役内容包可多次新建独立冒险；玩家包加入角色名册，不会进入大棋子库。\n\n备份自己的所有内容时，保留“程序包/用户数据”；只分享内容时，请使用模块导出，不要压缩用户数据目录。\n'''
    (destination/'使用说明.md').write_text(readme,encoding='utf-8')
    manifest={'edition':'standard' if standard else 'empty','generalTemplates':general_count,'generalItems':item_count,'files':[]}
    for path in sorted(destination.rglob('*')):
        if not path.is_file(): continue
        rel=path.relative_to(destination).as_posix()
        if any(word in rel for word in ('用户数据','当前存档','认证','恢复备份','__pycache__','.sqlite')): raise ValueError('发行包混入用户数据')
        manifest['files'].append({'path':rel,'bytes':path.stat().st_size,'sha256':ModuleStore.hash_file(path)})
    (destination/'发行清单.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    archive=destination.with_suffix('.zip')
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for path in sorted(destination.rglob('*')):
            if path.is_file(): z.write(path,str(Path(destination.name)/path.relative_to(destination)))
    return {'path':str(archive),'bytes':archive.stat().st_size,'generalTemplates':general_count,'generalItems':item_count,'files':len(manifest['files'])}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-save',required=True);parser.add_argument('--destination',required=True)
    parser.add_argument('--standard',action='store_true')
    args=parser.parse_args()
    if not (PACKAGE/'应用/start_server.py').is_file():
        parser.error('v3 仅用于历史“程序包/应用”工作区；当前项目请使用 build_distribution_v4.py --source 存档目录 --destination 新发行目录')
    print(json.dumps(build(PACKAGE/'应用',args.source_save,args.destination,args.standard),ensure_ascii=False))
