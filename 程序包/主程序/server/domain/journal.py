"""Journal normalization and authorized mutations; no server state."""
import copy, re, secrets, time
from .values import finite_number
MAX_JOURNAL_ENTRIES = 100
MAX_JOURNAL_TITLE = 80
MAX_JOURNAL_TOTAL_TEXT = 20000
JOURNAL_ENTRY_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,96}$')
class JournalMutationError(ValueError):
    """A client-safe validation error while changing one campaign-log entry."""


class JournalPermissionError(JournalMutationError):
    """The current player tried to change a log entry they do not own."""


def journal_clean_title(value, fallback=''):
    """Keep a title compact and safe for the directory list."""
    text = '' if value is None else str(value)
    text = re.sub(r'[\r\n\t]+', ' ', text)
    text = re.sub(r'\s{2,}', ' ', text).strip()[:MAX_JOURNAL_TITLE]
    return text or fallback


def journal_actor_name(value, fallback=''):
    return journal_clean_title(value, fallback)[:24]


def journal_nonnegative_int(value, default=0):
    number = finite_number(value)
    if number is None:
        return default
    return max(0, int(number))


def journal_world_value(value):
    number = finite_number(value)
    return max(0, int(number)) if number is not None else None


def journal_entry_id(raw, index, seen):
    candidate = str((raw or {}).get('id') or '') if isinstance(raw, dict) else ''
    if not JOURNAL_ENTRY_ID_RE.fullmatch(candidate) or candidate in seen:
        candidate = 'legacy-%d' % (index + 1)
    base = candidate
    suffix = 2
    while candidate in seen:
        candidate = '%s-%d' % (base, suffix)
        suffix += 1
    seen.add(candidate)
    return candidate


def normalize_journal_entry(raw, index, seen):
    source = raw if isinstance(raw, dict) else {'text': raw}
    author = journal_actor_name(source.get('author') or source.get('createdBy'), '未知作者')
    updated_by = journal_actor_name(source.get('updatedBy') or source.get('editor'), author)
    body = source.get('text')
    if not isinstance(body, str):
        body = '' if body is None else str(body)
    return {
        'id': journal_entry_id(source, index, seen),
        'title': journal_clean_title(source.get('title'), '未命名日志 %d' % (index + 1)),
        'text': body[:MAX_JOURNAL_TOTAL_TEXT],
        'author': author,
        'createdAt': journal_nonnegative_int(source.get('createdAt', source.get('at'))),
        'createdWorldSeconds': journal_world_value(source.get('createdWorldSeconds', source.get('worldSeconds'))),
        'updatedBy': updated_by,
        'updatedAt': journal_nonnegative_int(source.get('updatedAt', source.get('at'))),
        'updatedWorldSeconds': journal_world_value(source.get('updatedWorldSeconds', source.get('worldSeconds'))),
    }


def normalize_journal(value, expected_campaign_id=''):
    """Migrate the old single-text book into durable, independently editable entries."""
    incoming = value if isinstance(value, dict) else {}
    requested_campaign_id = str(expected_campaign_id or '').strip()
    stored_campaign_id = str(incoming.get('campaignId') or '').strip()
    # 不允许一份旧快照里的日志跟着另一个 campaignId 流转。
    source = {} if requested_campaign_id and stored_campaign_id and requested_campaign_id != stored_campaign_id else incoming
    seen = set()
    if isinstance(source.get('entries'), list):
        raw_entries = source['entries'][:MAX_JOURNAL_ENTRIES]
    else:
        legacy_text = source.get('text')
        if not isinstance(legacy_text, str):
            legacy_text = '' if legacy_text is None else str(legacy_text)
        legacy_history = source.get('history')
        legacy_last = legacy_history[-1] if isinstance(legacy_history, list) and legacy_history else {}
        legacy_author = journal_actor_name(
            source.get('author') or (legacy_last or {}).get('author'), 'DM'
        )
        raw_entries = [] if not legacy_text else [
            {
                'id': 'legacy-%d' % (index + 1),
                'title': '未命名日志 %d' % (index + 1),
                'text': page,
                'author': legacy_author,
                'createdAt': source.get('at'),
                'createdWorldSeconds': source.get('worldSeconds'),
                'updatedBy': legacy_author,
                'updatedAt': source.get('at'),
                'updatedWorldSeconds': source.get('worldSeconds'),
            }
            for index, page in enumerate(legacy_text[:MAX_JOURNAL_TOTAL_TEXT].split('\f')[:MAX_JOURNAL_ENTRIES])
        ]
    entries = [normalize_journal_entry(item, index, seen) for index, item in enumerate(raw_entries)]
    remaining = MAX_JOURNAL_TOTAL_TEXT
    for entry in entries:
        entry['text'] = entry['text'][:remaining]
        remaining -= len(entry['text'])
    revision = journal_nonnegative_int(source.get('revision'))
    history = [copy.deepcopy(item) for item in (source.get('history') or []) if isinstance(item, dict)][-50:]
    return {
        'schemaVersion': 2,
        'campaignId': requested_campaign_id or stored_campaign_id or None,
        'revision': revision,
        'entries': entries,
        # 旧版页面、旧存档恢复工具仍会读取 text，因此保留只读镜像。
        'text': '\f'.join(entry['text'] for entry in entries),
        'author': journal_actor_name(source.get('author'), ''),
        'worldSeconds': journal_world_value(source.get('worldSeconds')),
        'history': history,
    }


def journal_new_id(entries):
    existing = {entry.get('id') for entry in entries if isinstance(entry, dict)}
    while True:
        candidate = 'journal-' + secrets.token_hex(12)
        if candidate not in existing:
            return candidate


def journal_incoming_entry(value):
    if not isinstance(value, dict):
        raise JournalMutationError('日志标题和正文格式无效')
    raw_title, raw_text = value.get('title'), value.get('text')
    if not isinstance(raw_title, str) or not isinstance(raw_text, str):
        raise JournalMutationError('日志标题和正文必须是文字')
    if len(raw_title) > MAX_JOURNAL_TITLE:
        raise JournalMutationError('日志标题最多 %d 字' % MAX_JOURNAL_TITLE)
    if len(raw_text) > MAX_JOURNAL_TOTAL_TEXT:
        raise JournalMutationError('日志正文最多 %d 字' % MAX_JOURNAL_TOTAL_TEXT)
    title = journal_clean_title(raw_title)
    if not title:
        raise JournalMutationError('请给日志填写标题')
    return {'title': title, 'text': raw_text}


def current_campaign_world_seconds(state, now_ms=None):
    world = (state.get('encounter') or {}).get('worldTime') or {}
    total_seconds = max(0, int(finite_number(world.get('totalSeconds')) or 0))
    running_since = finite_number(world.get('runningSince'))
    if running_since:
        rate = finite_number(world.get('rate'))
        rate = max(.01, min(60, rate if rate is not None and rate > 0 else 1))
        if now_ms is None:
            now_ms = int(time.time() * 1000)
        total_seconds += max(0, int((now_ms - running_since) * rate / 1000))
    return total_seconds


def mutate_journal(current, mutation, actor, is_dm, at, world_seconds, campaign_id=''):
    """Apply one server-authorized create/update/delete operation to a normalized journal."""
    if not isinstance(mutation, dict):
        raise JournalMutationError('日志操作无效')
    operation = str(mutation.get('operation') or '')
    if operation not in ('create', 'update', 'delete'):
        raise JournalMutationError('日志操作无效')
    journal = normalize_journal(current, campaign_id)
    entries = journal['entries']
    entry_id = str(mutation.get('entryId') or '')

    if operation == 'create':
        if len(entries) >= MAX_JOURNAL_ENTRIES:
            raise JournalMutationError('最多可建立 %d 篇日志' % MAX_JOURNAL_ENTRIES)
        incoming = journal_incoming_entry(mutation.get('entry'))
        if sum(len(item['text']) for item in entries) + len(incoming['text']) > MAX_JOURNAL_TOTAL_TEXT:
            raise JournalMutationError('所有日志正文合计最多 %d 字' % MAX_JOURNAL_TOTAL_TEXT)
        entry_id = journal_new_id(entries)
        target = {
            'id': entry_id,
            'title': incoming['title'],
            'text': incoming['text'],
            'author': actor,
            'createdAt': at,
            'createdWorldSeconds': world_seconds,
            'updatedBy': actor,
            'updatedAt': at,
            'updatedWorldSeconds': world_seconds,
        }
        entries.append(target)
    else:
        if not JOURNAL_ENTRY_ID_RE.fullmatch(entry_id):
            raise JournalMutationError('日志条目不存在')
        target = next((item for item in entries if item['id'] == entry_id), None)
        if not target:
            raise JournalMutationError('这篇日志已不存在，请重新打开日志')
        if operation == 'delete':
            if not is_dm and target['author'] != actor:
                raise JournalPermissionError('只能删除自己创建的日志')
            entries[:] = [item for item in entries if item['id'] != entry_id]
        else:
            if not is_dm and target['author'] != actor:
                raise JournalPermissionError('只能修改自己创建的日志')
            incoming = journal_incoming_entry(mutation.get('entry'))
            total = sum(len(incoming['text']) if item['id'] == entry_id else len(item['text']) for item in entries)
            if total > MAX_JOURNAL_TOTAL_TEXT:
                raise JournalMutationError('所有日志正文合计最多 %d 字' % MAX_JOURNAL_TOTAL_TEXT)
            target.update({
                'title': incoming['title'],
                'text': incoming['text'],
                'updatedBy': actor,
                'updatedAt': at,
                'updatedWorldSeconds': world_seconds,
            })

    journal['campaignId'] = str(campaign_id or journal.get('campaignId') or '').strip() or None
    journal['revision'] += 1
    journal['author'] = actor
    journal['worldSeconds'] = world_seconds
    journal['text'] = '\f'.join(item['text'] for item in entries)
    journal['history'] = (journal['history'] + [{
        'author': actor,
        'at': at,
        'worldSeconds': world_seconds,
        'revision': journal['revision'],
        'action': operation,
        'entryId': entry_id,
        'title': target.get('title') if target else '',
    }])[-50:]
    return journal, entry_id


