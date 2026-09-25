"""Document catalog and bounded DOCX preview parsing, independent of HTTP."""
import os, re, hashlib, zipfile
from .catalog_paths import safe_campaign_name as _safe_music_campaign_name
import xml.etree.ElementTree as ET
from pathlib import Path
DEFAULT_DOCUMENT_ROOT = str(Path(__file__).resolve().parents[1] / "asset" / "文档")
DOCUMENT_EXTS = ('.pdf', '.docx')
MAX_DOCUMENT_LIBRARY_FILES = 500
MAX_DOCUMENT_SOURCE_BYTES = 64 * 1024 * 1024
MAX_DOCX_ZIP_ENTRIES = 2048
MAX_DOCX_UNCOMPRESSED_BYTES = 160 * 1024 * 1024
MAX_DOCX_XML_BYTES = 32 * 1024 * 1024
MAX_DOCX_COMPRESSION_RATIO = 200
MAX_DOCX_PREVIEW_BLOCKS = 5000
MAX_DOCX_PREVIEW_CHARS = 2 * 1024 * 1024
DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
WORDPROCESSING_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
class DocumentPreviewError(ValueError):
    pass


class DocumentTooLargeError(DocumentPreviewError):
    pass


def _path_within(root, path):
    """同时按书写路径和真实路径校验，避免 ``..`` 与软链接逃逸。"""
    root = os.path.abspath(root)
    path = os.path.abspath(path)
    try:
        if os.path.commonpath([root, path]) != root:
            return False
        real_root = os.path.realpath(root)
        real_path = os.path.realpath(path)
        return os.path.commonpath([real_root, real_path]) == real_root
    except (OSError, ValueError):
        return False


def _path_written_or_resolved_within(root, path):
    """静态封锁同时识别目录原路径和从别处指向目录的软链接别名。"""
    root = os.path.abspath(root)
    path = os.path.abspath(path)
    try:
        written_inside = os.path.commonpath([root, path]) == root
        real_root = os.path.realpath(root)
        real_path = os.path.realpath(path)
        resolved_inside = os.path.commonpath([real_root, real_path]) == real_root
        return written_inside or resolved_inside
    except (OSError, ValueError):
        return False


def _document_path_is_safe(root, path):
    if not _path_within(root, path):
        return False
    root = os.path.abspath(root)
    path = os.path.abspath(path)
    if os.path.lexists(root) and os.path.islink(root):
        return False
    relative = os.path.relpath(path, root)
    if relative == os.pardir or relative.startswith(os.pardir + os.sep):
        return False
    cursor = root
    for part in (() if relative == '.' else relative.split(os.sep)):
        cursor = os.path.join(cursor, part)
        if os.path.lexists(cursor) and os.path.islink(cursor):
            return False
    return True


def _walk_document_files(root, start):
    if not os.path.isdir(start) or not _document_path_is_safe(root, start):
        return
    for directory, subdirs, files in os.walk(start):
        subdirs[:] = [name for name in subdirs
                      if not name.startswith('.')
                      and _document_path_is_safe(root, os.path.join(directory, name))]
        for name in files:
            path = os.path.join(directory, name)
            extension = os.path.splitext(name)[1].lower()
            if (name.startswith('.') or name.startswith('~$') or extension not in DOCUMENT_EXTS
                    or not _document_path_is_safe(root, path)
                    or not os.path.isfile(path)):
                continue
            yield path


def document_library_catalog(root=None, campaign_id='', campaign_name=''):
    """只索引当前战役的 PDF/DOCX，并用不含物理路径的内容 ID 对外引用。"""
    root = os.path.abspath(root or DEFAULT_DOCUMENT_ROOT)
    campaign_id = re.sub(r'[^\w\-]', '', str(campaign_id or ''))[:80]
    campaign_name = _safe_music_campaign_name(campaign_name)[:120]
    documents = []
    index = {}
    campaigns_root = os.path.join(root, '战役')
    folder_names = []
    if os.path.isdir(campaigns_root) and _document_path_is_safe(root, campaigns_root):
        try:
            folder_names = [name for name in os.listdir(campaigns_root)
                            if os.path.isdir(os.path.join(campaigns_root, name))
                            and _document_path_is_safe(root, os.path.join(campaigns_root, name))]
        except OSError:
            folder_names = []
    expected = ((campaign_id + '-' + campaign_name) if campaign_id and campaign_name else '')
    candidates = sorted(folder_names, key=lambda name: (
        0 if expected and name == expected else
        1 if campaign_id and name == campaign_id else
        2 if campaign_id and name.startswith(campaign_id + '-') else
        3 if campaign_name and name == campaign_name else 4,
        name,
    ))
    selected = next((name for name in candidates if (
        (expected and name == expected)
        or (campaign_id and (name == campaign_id or name.startswith(campaign_id + '-')))
        or (campaign_name and name == campaign_name)
    )), '')
    if selected:
        campaign_root = os.path.join(campaigns_root, selected)
        for path in _walk_document_files(root, campaign_root):
            if len(documents) >= MAX_DOCUMENT_LIBRARY_FILES:
                break
            try:
                stat = os.stat(path)
                size = stat.st_size
                if size <= 0 or size > MAX_DOCUMENT_SOURCE_BYTES:
                    continue
                relative = os.path.relpath(path, root).replace(os.sep, '/')
            except OSError:
                continue
            document_id = hashlib.sha256(relative.encode('utf-8')).hexdigest()[:32]
            extension = os.path.splitext(path)[1].lower()
            version = '?v=%x-%x' % (stat.st_mtime_ns, size)
            preview_endpoint = ('/api/document-stream/' if extension == '.pdf'
                                else '/api/document-preview/')
            documents.append({
                'id': document_id,
                'title': os.path.splitext(os.path.basename(path))[0],
                'fileName': os.path.basename(path),
                'type': extension[1:],
                'size': size,
                'mtime': int(stat.st_mtime * 1000),
                'previewUrl': preview_endpoint + document_id + version,
                'downloadUrl': '/api/document-download/' + document_id + version,
            })
            index[document_id] = path
    documents.sort(key=lambda item: (item['title'].lower(), item['type']))
    return {
        'ok': True,
        'campaignId': campaign_id,
        'campaignName': campaign_name,
        'documents': documents,
        '_index': index,
    }


def _validate_docx_member_name(name):
    raw = str(name or '')
    if not raw or '\x00' in raw or raw.startswith(('/', '\\')) or '\\' in raw:
        raise DocumentPreviewError('DOCX 包含非法路径')
    parts = [part for part in raw.split('/') if part]
    if any(part in ('.', '..') for part in parts) or (parts and re.match(r'^[A-Za-z]:', parts[0])):
        raise DocumentPreviewError('DOCX 包含非法路径')


def _validate_docx_archive(archive):
    infos = archive.infolist()
    if len(infos) > MAX_DOCX_ZIP_ENTRIES:
        raise DocumentTooLargeError('DOCX 内部文件过多')
    total_size = 0
    total_compressed = 0
    seen_names = set()
    for info in infos:
        _validate_docx_member_name(info.filename)
        if info.filename in seen_names:
            raise DocumentPreviewError('DOCX 包含重复内部文件')
        seen_names.add(info.filename)
        if info.flag_bits & 1:
            raise DocumentPreviewError('不支持加密 DOCX')
        total_size += max(0, int(info.file_size))
        total_compressed += max(0, int(info.compress_size))
        ratio = info.file_size / max(1, info.compress_size)
        if info.file_size > 1024 and ratio > MAX_DOCX_COMPRESSION_RATIO:
            raise DocumentTooLargeError('DOCX 压缩率异常')
    if total_size > MAX_DOCX_UNCOMPRESSED_BYTES:
        raise DocumentTooLargeError('DOCX 解压后过大')
    if total_size > 1024 and total_size / max(1, total_compressed) > MAX_DOCX_COMPRESSION_RATIO:
        raise DocumentTooLargeError('DOCX 压缩率异常')
    names = {info.filename for info in infos}
    if 'word/document.xml' not in names:
        raise DocumentPreviewError('DOCX 缺少正文')
    document_info = archive.getinfo('word/document.xml')
    if document_info.file_size > MAX_DOCX_XML_BYTES:
        raise DocumentTooLargeError('DOCX 正文过大')


def _read_zip_member_limited(archive, name, limit):
    try:
        with archive.open(name) as handle:
            raw = handle.read(limit + 1)
    except KeyError:
        return None
    if len(raw) > limit:
        raise DocumentTooLargeError('DOCX XML 过大')
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise DocumentPreviewError('DOCX XML 声明不安全')
    return raw


def _docx_text_pieces(element):
    namespace = '{' + WORDPROCESSING_NS + '}'
    pieces = []
    current = []
    for node in element.iter():
        if node.tag == namespace + 't':
            current.append(node.text or '')
        elif node.tag == namespace + 'tab':
            current.append('\t')
        elif node.tag in (namespace + 'lastRenderedPageBreak', namespace + 'br'):
            is_page = (node.tag == namespace + 'lastRenderedPageBreak'
                       or node.get(namespace + 'type') == 'page')
            if is_page:
                pieces.append(''.join(current).strip())
                pieces.append(None)
                current = []
            else:
                current.append('\n')
    pieces.append(''.join(current).strip())
    return pieces


def _docx_style_map(archive):
    raw = _read_zip_member_limited(archive, 'word/styles.xml', 4 * 1024 * 1024)
    if not raw:
        return {}
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return {}
    namespace = '{' + WORDPROCESSING_NS + '}'
    styles = {}
    for style in root.findall('.//' + namespace + 'style'):
        style_id = style.get(namespace + 'styleId') or ''
        name_element = style.find('./' + namespace + 'name')
        outline_element = style.find('.//' + namespace + 'outlineLvl')
        styles[style_id] = {
            'name': (name_element.get(namespace + 'val') if name_element is not None else '') or '',
            'outline': (outline_element.get(namespace + 'val') if outline_element is not None else None),
        }
    return styles


def _docx_paragraph_kind(paragraph, styles):
    namespace = '{' + WORDPROCESSING_NS + '}'
    style_element = paragraph.find('./' + namespace + 'pPr/' + namespace + 'pStyle')
    style_id = style_element.get(namespace + 'val') if style_element is not None else ''
    style = styles.get(style_id, {})
    label = (style_id + ' ' + str(style.get('name') or '')).lower()
    match = re.search(r'(?:heading|标题)\s*([1-6])', label)
    if match:
        return 'heading', int(match.group(1))
    try:
        outline = int(style.get('outline'))
        if 0 <= outline <= 5:
            return 'heading', outline + 1
    except (TypeError, ValueError):
        pass
    if paragraph.find('./' + namespace + 'pPr/' + namespace + 'numPr') is not None:
        return 'list', None
    return 'paragraph', None


def parse_docx_preview(path):
    try:
        size = os.path.getsize(path)
    except OSError:
        raise DocumentPreviewError('文档不存在')
    if size <= 0 or size > MAX_DOCUMENT_SOURCE_BYTES:
        raise DocumentTooLargeError('DOCX 文件大小超出限制')
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile):
        raise DocumentPreviewError('DOCX 文件已损坏')
    with archive:
        _validate_docx_archive(archive)
        raw = _read_zip_member_limited(archive, 'word/document.xml', MAX_DOCX_XML_BYTES)
        try:
            root = ET.fromstring(raw)
        except (TypeError, ET.ParseError):
            raise DocumentPreviewError('DOCX 正文无法解析')
        styles = _docx_style_map(archive)

    namespace = '{' + WORDPROCESSING_NS + '}'
    body = root.find('.//' + namespace + 'body')
    if body is None:
        raise DocumentPreviewError('DOCX 缺少正文')
    blocks = []
    character_count = 0

    def append_block(block):
        nonlocal character_count
        if len(blocks) >= MAX_DOCX_PREVIEW_BLOCKS:
            raise DocumentTooLargeError('DOCX 预览内容过多')
        if block.get('type') == 'table':
            added = sum(len(cell) for row in block.get('rows', []) for cell in row)
        else:
            added = len(block.get('text') or '')
        character_count += added
        if character_count > MAX_DOCX_PREVIEW_CHARS:
            raise DocumentTooLargeError('DOCX 预览文字过多')
        blocks.append(block)

    for child in body:
        if child.tag == namespace + 'p':
            block_type, level = _docx_paragraph_kind(child, styles)
            pieces = _docx_text_pieces(child)
            for index, text_value in enumerate(pieces):
                if text_value:
                    block = {'type': block_type, 'text': text_value}
                    if block_type == 'heading':
                        block['level'] = level
                    append_block(block)
                if index < len(pieces) - 1 and pieces[index + 1] is None:
                    append_block({'type': 'pageBreak'})
        elif child.tag == namespace + 'tbl':
            rows = []
            for row in child.findall('./' + namespace + 'tr'):
                cells = []
                for cell in row.findall('./' + namespace + 'tc'):
                    paragraphs = []
                    for paragraph in cell.findall('./' + namespace + 'p'):
                        text_value = ''.join(piece or '' for piece in _docx_text_pieces(paragraph)).strip()
                        if text_value:
                            paragraphs.append(text_value)
                    cells.append('\n'.join(paragraphs))
                if cells:
                    rows.append(cells)
            if rows:
                append_block({'type': 'table', 'rows': rows})
    return blocks


