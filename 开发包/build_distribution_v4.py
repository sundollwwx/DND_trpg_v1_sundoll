"""Build engine plus optional public content in the sibling workspace layout."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile
import zipfile
PROJECT=Path(__file__).resolve().parent.parent
PACKAGE=PROJECT/'程序包'
APP=next(p for p in (PACKAGE/'主程序',PACKAGE/'应用') if (p/'start_server.py').exists())
sys.path.insert(0,str(APP))
from server.static_policy import PUBLIC_FILES, HOST_FILES
from server.module_packages import ModulePackages
from server.module_store import ModuleStore
from server.workspace import read_catalog, Workspace
from server.daily_life import DATA_FILES, MAX_DATA_BYTES, MODULE_ID, validate_bundle, validate_manifest

LAUNCHER_FILES = (
    '启动桑哆尔之歌.command', '启动桑哆尔之歌.bat',
)
# Dynamic entrance pages and offline tools are not public static HTTP files.
ENGINE_FILES = {
    'start_server.py', 'launch_sundoll.py', 'launch_entry.py', 'shared/protocol.js',
    'web/account.html', 'web/dm-login.html', 'web/home.html',
    'manage_accounts.py', 'manage_installation.py', 'manage_installation_ui.py',
    '邮箱账号设置.example.json',
    'shared/ui-assets-sw.js',
}
DAILY_FILES = ('模块.json', 'README.md', '资料/README.md',
               *('资料/'+name for name in DATA_FILES.values()))


def copy_engine(app, output):
    app,output=Path(app),Path(output)
    output.mkdir(parents=True,exist_ok=True)
    allowed=set(PUBLIC_FILES)|set(HOST_FILES)|ENGINE_FILES|set(LAUNCHER_FILES)
    allowed.update('defaults/'+MODULE_ID+'/'+relative for relative in DAILY_FILES
                   if (app/'defaults'/MODULE_ID/relative).is_file())
    allowed.update(p.relative_to(app).as_posix() for p in (app/'server').rglob('*.py'))
    if (app/'bin').is_dir():
        allowed.update(p.relative_to(app).as_posix() for p in (app/'bin').iterdir() if p.is_file())
    excluded_asset_folders={'待审核','设计原图','草稿','候选'}
    allowed.update(p.relative_to(app).as_posix() for p in (app/'asset/界面').rglob('*')
                   if p.is_file()
                   and not excluded_asset_folders.intersection(p.relative_to(app/'asset/界面').parts)
                   and p.suffix.lower() in {'.js','.css','.png','.jpg','.jpeg','.webp','.svg','.mp3','.wav','.ogg','.m4a'})
    for relative in sorted(allowed):
        if relative=='asset/棋子库/默认预设.js':continue
        source=app/relative
        if not source.is_file() or source.is_symlink():raise ValueError('发行文件缺失：'+relative)
        target=output/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
    # Default rules are runtime inputs, not HTTP assets. Validate before shipping.
    daily_life_snapshot(app/'defaults'/MODULE_ID)
    (output/'asset/棋子库/默认预设.js').write_text('window.__LIBRARY_SEED__ = [];\n',encoding='utf-8')
    (output/'distribution.json').write_text('{"format":4}',encoding='utf-8')
    (output/'模块.json').write_text(json.dumps(dict(format='sundoll-engine',version=4,name='桑哆尔之歌',dependencies=[]),ensure_ascii=False),encoding='utf-8')


def copy_launchers(app, destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for name in LAUNCHER_FILES:
        # Packaged templates also locate the engine from the outer root.
        source = Path(app) / name
        if not source.is_file() or source.is_symlink():
            raise ValueError('发行启动器缺失：' + name)
        shutil.copy2(source, destination / name)


def write_workspace_guide(package):
    shutil.copy2(PACKAGE/'使用说明.md',Path(package)/'使用说明.md')


def daily_life_snapshot(source):
    """Read only declared, validated public rule files."""
    source = Path(source).absolute()
    origin = source.parent

    def checked_file(relative, optional=False):
        path = source/relative
        cursor = origin
        if cursor.is_symlink(): raise ValueError('日常小事发行源不允许符号链接')
        for part in path.relative_to(origin).parts:
            cursor /= part
            if cursor.is_symlink(): raise ValueError('日常小事发行源不允许符号链接')
        if optional and not path.exists(): return None
        if not path.is_file(): raise ValueError('日常小事发行资料缺失：'+relative)
        if path.stat().st_size > MAX_DATA_BYTES: raise ValueError('日常小事发行资料过大')
        return path

    manifest_file = checked_file('模块.json')
    entries = [('模块.json', manifest_file)]
    entries.extend(('资料/'+name, checked_file('资料/'+name)) for name in DATA_FILES.values())
    for relative in ('README.md', '资料/README.md'):
        path = checked_file(relative, optional=True)
        if path: entries.append((relative, path))
    snapshots = {}
    for relative, path in entries:
        with path.open('rb') as handle: snapshots[relative] = handle.read(MAX_DATA_BYTES+1)
        if len(snapshots[relative]) > MAX_DATA_BYTES: raise ValueError('日常小事发行资料过大')
    validate_manifest(json.loads(snapshots['模块.json'].decode('utf-8')))
    bundle = {'data':{kind:json.loads(snapshots['资料/'+name].decode('utf-8')) for kind,name in DATA_FILES.items()}}
    for field, relative in (('readme', 'README.md'), ('dataReadme', '资料/README.md')):
        if relative in snapshots: bundle[field] = snapshots[relative].decode('utf-8')
    validate_bundle(bundle)
    return snapshots


def copy_daily_life(app, package, source=None):
    """Use bundled defaults unless a workspace was explicitly selected."""
    if source:
        workspace = Workspace(source)
        if not workspace.active:
            raise ValueError('发行内容来源必须是明确的 v4 工作区存档目录')
        origin = workspace.root/'通用包'/MODULE_ID
    else:
        origin = Path(app)/'defaults'/MODULE_ID
    snapshots = daily_life_snapshot(origin)
    target = Path(package)/'主程序/defaults'/MODULE_ID
    for relative, contents in snapshots.items():
        output = target/relative
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(contents)
    return list(snapshots)


def build(app,source,destination,standard=False):
    destination=Path(destination)
    if destination.exists():raise ValueError('发行目标必须不存在')
    archive=destination.with_suffix('.zip')
    if archive.exists():raise ValueError('发行压缩包已存在，不会覆盖')
    if standard and not source:raise ValueError('标准版必须用 --source 明确选择要分享的通用内容')
    if source and not Workspace(source).active:raise ValueError('发行内容来源必须是明确的 v4 工作区存档目录')
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.sundoll-build-',dir=destination.parent) as temporary:
        staged=Path(temporary)/destination.name
        result=_build(app,source,staged,standard)
        # Nothing becomes a release until all sources, JSON and the ZIP validate.
        with zipfile.ZipFile(result['path']) as built:
            if built.testzip() is not None:raise ValueError('发行压缩包校验失败')
        if destination.exists() or archive.exists():raise ValueError('发行目标已被其他操作创建')
        staged.rename(destination)
        try:
            Path(result['path']).rename(archive)
        except BaseException:
            destination.rename(staged)
            raise
        return dict(result,path=str(archive))


def _build(app,source,destination,standard=False):
    package=destination/'程序包'
    copy_engine(app,package/'主程序')
    (package/'运行数据').mkdir()
    daily_life_files = copy_daily_life(app, package, source)
    copy_launchers(app,destination)
    write_workspace_guide(package)
    templates=[];items=[]
    if standard:
        public_prefixes=('通用生物/','魔宠/','坐骑/','物件/','法术造物/')
        templates=[p for p in read_catalog(source,'template')['presets'] if str(p.get('category','')).startswith(public_prefixes) and not p.get('campaignId') and not p.get('ownedPieceId') and not p.get('characterId')]
        items=[i for i in read_catalog(source,'item-template')['templates'] if i.get('scope')=='general' and not i.get('archived')]
        target=package/'主程序/defaults/通用内容/基础通用内容.sundoll'
        target.parent.mkdir(parents=True,exist_ok=True)
        ModulePackages(source,app).export(target,'general','基础通用棋子与物品',dict(templates=templates,items=items),'sundoll-general-v4')
    (destination/'使用说明.md').write_text('''# 桑哆尔之歌 · 网页服务

需要 Python 3.9 或更高版本。首次部署先在“程序包/主程序”执行 `python3 manage_accounts.py init --help`，按提示设置自己的域名和 SMTP；密钥用 `set-smtp-secret` 的隐藏输入或 SUNDOLL_SMTP_PASSWORD 环境变量。初始化只适用于空安装，不能覆盖已有账号或房间。

完成配置后，macOS 双击“启动桑哆尔之歌.command”，Windows 双击“启动桑哆尔之歌.bat”，选择“本机使用”或“公网联机”。启动器只运行服务，请自行打开窗口显示的个人主页地址。公网域名和隧道需由部署者另行配置。

账号注册后创建角色，从个人主页创建房间或接受邀请。账号与角色、背包、钱包保存在中央运行数据；战役与场景保存在各房间内。切换房间沿用角色，不复制角色背包。

本发行包不带作者的战役、账号、登录码或私人收藏。公开默认资料在“主程序/defaults”，创建房间时初始化到该房间；修改已有房间不会反写程序默认值。标准版另含构建者明确选定的通用内容，请构建者在分享前审阅。

更新程序时只替换主程序，保留“运行数据”。分享内容使用房间内的导出入口；旧玩家包用于兼容迁移，不是中央账号角色库。完整私人备份使用统一启动器的 --backup / --restore 模式，须先保存并完整停服；不要把运行数据或整个工作目录发给别人。详见程序包/使用说明.md。

已有旧工作区需先备份并明确迁移，不能使用初始化命令绕过。缺失配置、资料或数据库时应停止并检查，不要删除模式标记试图重新生成存档。
''',encoding='utf-8')
    manifest={'format':4,'edition':'standard' if standard else 'empty','generalTemplates':len(templates),'generalItems':len(items),'dailyLifeFiles':len(daily_life_files),'files':[]}
    for path in sorted(destination.rglob('*')):
        if not path.is_file():continue
        rel=path.relative_to(destination).as_posix()
        if any(word in rel for word in ('认证','当前存档','恢复备份','.sqlite','__pycache__')):raise ValueError('发行包混入私人数据')
        manifest['files'].append(dict(path=rel,bytes=path.stat().st_size,sha256=ModuleStore.hash_file(path)))
    (destination/'发行清单.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    archive=destination.with_suffix('.zip')
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as out:
        for path in sorted(destination.rglob('*')):
            out.write(path,str(Path(destination.name)/path.relative_to(destination)))
    return dict(path=str(archive),bytes=archive.stat().st_size,generalTemplates=len(templates),generalItems=len(items),dailyLifeFiles=len(daily_life_files))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',help='可选：明确选择 v4 工作区存档中的通用内容；未指定时只用随源码公开默认资料');parser.add_argument('--destination',required=True);parser.add_argument('--standard',action='store_true')
    args=parser.parse_args()
    try:
        print(json.dumps(build(APP,args.source,args.destination,args.standard),ensure_ascii=False))
    except (OSError, ValueError) as error:
        parser.exit(1, '发行未完成：'+str(error)+'\n')
