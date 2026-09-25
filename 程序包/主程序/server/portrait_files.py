"""Human-readable portrait copies owned by their module; originals stay immutable."""
import hashlib
import html
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
from urllib.parse import quote

EXTENSIONS = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif'}
URL = re.compile(r'^/api/module-assets/([a-f0-9]{64})$')


def label(value):
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(value or '未命名')).strip(' .')[:60]
    if text.upper() in {'CON','PRN','AUX','NUL',*[f'COM{i}' for i in range(10)],*[f'LPT{i}' for i in range(10)]}: text = '_' + text
    return text or '未命名'


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def publish_text(path, text):
    if path.exists() and path.read_text('utf-8') == text: return
    temp = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        temp.write_text(text, encoding='utf-8'); os.replace(temp, path)
    finally: temp.unlink(missing_ok=True)


def sync_directory(store, directory):
    from .workspace import atomic_json
    ws = store.workspace
    directory = ws.checked(Path(directory))
    root = ws.checked(directory / '棋子立绘')
    manifest = ws.checked(root / '立绘索引.json')
    previous = json.loads(manifest.read_text('utf-8')).get('files', []) if manifest.exists() else []
    old = {item['path']: item for item in previous}
    entries = []
    for record in sorted((directory / '记录').glob('*.json')):
        ws.checked(record)
        data = json.loads(record.read_text('utf-8'))
        if data['kind'] not in ('player-library', 'template'): continue
        pieces = data['data'].get('pieces', []) if data['kind'] == 'player-library' else [data['data']]
        for piece in pieces:
            identity = piece.get('ownedPieceId') or piece.get('id') or data['id']
            name = piece.get('name') or '未命名'
            # Stable short identity distinguishes same-named independent characters.
            folder = label(name) + '--' + hashlib.sha256(str(identity).encode()).hexdigest()[:10]
            forms = list(piece.get('portraitVariants') or [])
            source = piece.get('iconImgPath') or piece.get('iconImgHd') or piece.get('iconImg')
            if source and not any(source == f.get('iconImgPath') for f in forms):
                forms.insert(0, dict(name='默认形态', iconImgPath=source))
            for index, form in enumerate(forms, 1):
                match = URL.fullmatch(str(form.get('iconImgPath') or ''))
                if not match: continue
                hash_id = match[1]
                info = next((a for a in data.get('assets', []) if a['id'] == hash_id), None)
                if not info or info['mime'] not in EXTENSIONS: continue
                variant = form.get('name') or '默认形态'
                relative = folder + '/%02d-%s%s' % (index, label(variant), EXTENSIONS[info['mime']])
                entries.append(dict(path=relative, characterId=identity, name=name, variant=variant,
                                    sha256=hash_id, source='/api/module-assets/'+hash_id))
    if not entries and not manifest.exists(): return []
    root.mkdir(parents=True, exist_ok=True)
    for item in entries:
        target = ws.checked(root / item['path'])
        if target.exists():
            actual = digest(target)
            if actual == item['sha256']: continue
            if item['path'] not in old or actual != old[item['path']]['sha256']:
                raise ValueError('立绘浏览副本被手动修改，请先另存：'+str(target))
        source = ws.checked(directory/'资源'/item['sha256'][:2]/item['sha256'])
        if not source.is_file() or digest(source) != item['sha256']:
            raise ValueError('模块正式立绘缺失或损坏：'+str(source))
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name+'.'+secrets.token_hex(8)+'.tmp')
        try:
            shutil.copyfile(source, temp); os.replace(temp, target)
        finally: temp.unlink(missing_ok=True)
    current = {item['path'] for item in entries}
    for relative, item in old.items():
        rel = PurePosixPath(relative)
        if rel.is_absolute() or '..' in rel.parts or '\\' in relative: raise ValueError('立绘索引路径无效')
        target = ws.checked(root / relative)
        if relative not in current and target.is_file() and digest(target) == item['sha256']:
            target.unlink()
            try: target.parent.rmdir()
            except OSError: pass
    cards = []
    for item in entries:
        href = quote(item['path'], safe='/')
        title = html.escape(item['name']+' · '+item['variant'])
        cards.append(f'<article><a href="{href}" target="_blank"><img loading="lazy" src="{href}" alt="{title}"></a><h2>{title}</h2><a class="download" href="{href}" download>下载原尺寸图片</a></article>')
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>棋子立绘</title><style>
body{margin:0;background:#181d27;color:#e8dcc3;font:16px system-ui}header{padding:32px 5%;border-bottom:1px solid #65583e}h1{margin:0 0 12px}p{line-height:1.7;color:#c3bdaF}main{padding:24px 5%;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:22px}article{background:#252b37;border:1px solid #4c4850;border-radius:12px;overflow:hidden;padding:12px}img{width:100%;aspect-ratio:1;object-fit:contain;background:#d9c6a1;border-radius:6px}h2{font-size:16px}a{color:#e1bc77}.download{display:inline-block;padding:8px 0}</style><header><h1>棋子立绘</h1><p>''' + html.escape(directory.name) + ''' · 点击图片查看原尺寸，也可直接复制角色文件夹导出全部形态。<br>这些图片随本模块保存。更新立绘请在程序中操作，此目录会自动同步。</p></header><main>''' + ''.join(cards) + '</main></html>'
    publish_text(ws.checked(root/'浏览立绘.html'), page)
    publish_text(ws.checked(root/'使用说明.txt'), '本目录是当前模块立绘的可读副本，可双击浏览立绘.html，或复制角色文件夹导出。\n资源/中的编号原图仍为程序引用依据。修改形态请通过程序操作，不要直接覆盖本目录文件。\n角色删除、改名或更换图片后，本目录自动同步；手动新增文件不会被自动删除。\n')
    atomic_json(manifest, dict(format='sundoll-readable-portraits-v1', files=entries))
    return entries


def rebuild_all(store):
    results = {}
    for family in (store.workspace.players, store.workspace.campaigns, store.workspace.general):
        for directory in sorted(family.iterdir() if family.exists() else []):
            if directory.is_dir() and (directory/'模块.json').is_file():
                results[str(directory)] = len(sync_directory(store, directory))
    return results
