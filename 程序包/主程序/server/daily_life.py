"""Read non-executable everyday content from its sole general-module source."""
import json
import math
import copy
from urllib.parse import urlparse

from .workspace import Workspace, LOCK


MODULE_ID = '日常小事'
DATA_FILES = {
    'lifestyle': 'lifestyle.json',
    'flavor': 'flavor.json',
    'menus': 'menus.json',
    'fishing-tables': 'fishing-tables.json',
    'climate': 'climate.json',
}
MAX_DATA_BYTES = 4 * 1024 * 1024
LEGACY_CONDITION_KEYS = ('clear', 'cloudy', 'rain', 'storm', 'fog', 'snow', 'wind', 'heat')
CONDITION_KEYS = LEGACY_CONDITION_KEYS + ('lightFog', 'heavyRain', 'heavySnow')
ACTIVE_CONDITION_KEYS = tuple(key for key in CONDITION_KEYS if key not in ('wind', 'heat'))
WIND_KEYS = ('calm', 'breeze', 'strong', 'gale')
SEASON_KEYS = ('spring', 'summer', 'autumn', 'winter')
CLIMATE_KEYS = ('temperate', 'cold', 'tropical', 'arid', 'coastal', 'highland')


def _read_json(workspace, path):
    target = workspace.checked(path)
    if not target.is_file():
        raise FileNotFoundError('日常小事通用模块资料缺失')
    if target.stat().st_size > MAX_DATA_BYTES:
        raise ValueError('日常小事资料超过容量限制')
    # Also limit the bytes actually read if a local editor changes the file.
    with target.open('rb') as handle:
        raw = handle.read(MAX_DATA_BYTES + 1)
    if len(raw) > MAX_DATA_BYTES:
        raise ValueError('日常小事资料超过容量限制')
    try:
        return json.loads(raw.decode('utf-8'))
    except (UnicodeError, ValueError) as error:
        raise ValueError('日常小事资料不是有效的 UTF-8 JSON') from error


def validate_manifest(manifest):
    if (not isinstance(manifest, dict)
            or manifest.get('format') != 'sundoll-workspace-module'
            or manifest.get('version') != 4
            or manifest.get('family') != '通用包'
            or manifest.get('id') != MODULE_ID):
        raise ValueError('日常小事通用模块清单无效')
    if type(manifest.get('enabled', True)) is not bool:
        raise ValueError('日常小事模块启用状态无效')
    return manifest


def module_root(save_root, allow_disabled=False):
    """Never fall back to engine-owned content or another campaign's module."""
    workspace = Workspace(save_root)
    if workspace.active and (workspace.root/'运行数据/模块发布中.json').exists():
        raise ValueError('模块正在恢复发布，请稍后重试')
    directory = workspace.checked(workspace.general / MODULE_ID)
    manifest = validate_manifest(_read_json(workspace, directory / '模块.json'))
    if not allow_disabled and not manifest.get('enabled', True):
        raise ValueError('日常小事通用模块已停用')
    return workspace, directory


def _menu_values(value):
    menus = value.get('menus') if isinstance(value, dict) else value
    if not isinstance(menus, list) or not menus or len(menus) > 200:
        raise ValueError('日常小事菜单列表无效')
    identities = set()
    for menu in menus:
        if (not isinstance(menu, dict)
                or not isinstance(menu.get('id'), str) or not menu['id']
                or len(menu['id']) > 120 or menu['id'] in identities
                or not isinstance(menu.get('title'), str) or not menu['title']
                or not isinstance(menu.get('sections'), list)):
            raise ValueError('日常小事菜单格式无效')
        identities.add(menu['id'])
        for section in menu['sections']:
            if (not isinstance(section, dict)
                    or not isinstance(section.get('title'), str)
                    or not isinstance(section.get('items'), list)):
                raise ValueError('日常小事菜单分组无效')
            for item in section['items']:
                if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not item['name']:
                    raise ValueError('日常小事餐食格式无效')
    return menus


def _public_menus(value):
    """Explicit display-field projection; unknown fields never reach players."""
    menus = _menu_values(value)
    visible = []
    for menu in menus:
        projected = {key: menu[key] for key in ('id', 'title', 'subtitle', 'motto', 'intro', 'note')
                     if isinstance(menu.get(key), str)}
        projected['sections'] = []
        for section in menu['sections']:
            group = {'title': section['title'], 'items': []}
            for item in section['items']:
                dish = {key: item[key] for key in ('name', 'price', 'detail', 'tag', 'portion')
                        if isinstance(item.get(key), str)}
                if type(item.get('priceCp')) is int and item['priceCp'] >= 0:
                    dish['priceCp'] = item['priceCp']
                group['items'].append(dish)
            projected['sections'].append(group)
        visible.append(projected)
    if isinstance(value, list):
        return visible
    result = {'menus': visible}
    if isinstance(value.get('version'), (str, int)) and not isinstance(value.get('version'), bool):
        result['version'] = value['version']
    return result


def _climate_error():
    raise ValueError('通用气候资料不符合版本 1/2 的格式或数值范围')


def _object(value):
    if not isinstance(value, dict): _climate_error()
    return value


def _text(value, maximum=4000):
    if not isinstance(value, str) or len(value) > maximum: _climate_error()
    return value


def _number(value, minimum, maximum, integer=False):
    if type(value) not in (int, float) or (integer and type(value) is not int): _climate_error()
    if not minimum <= value <= maximum or not math.isfinite(value): _climate_error()
    return value


def _enum(value, choices):
    if not isinstance(value, str) or value not in choices: _climate_error()
    return value


def _matrix(value, rows, columns):
    source = _object(value)
    projected = {}
    for key in rows:
        row = _object(source.get(key))
        projected[key] = {column: _number(row.get(column), 0, 1000000) for column in columns}
        if not any(projected[key].values()): _climate_error()
    return projected


def _upgrade_climate_v1(source):
    """Explicit schema migration, never a substitute for a missing module.

    Existing v1 seasonal biases and global weights remain the migration input.
    They become local profile matrices; authored v2 modules can vary every row.
    This changes config shape only and does not rewrite saved weather state.
    """
    source = copy.deepcopy(source)
    legacy = _object(source.get('transitions'))
    old_weather = _matrix(legacy.get('weather'), LEGACY_CONDITION_KEYS, LEGACY_CONDITION_KEYS)
    old_wind = _matrix(legacy.get('wind'), WIND_KEYS, WIND_KEYS)
    old_weather_wind = _matrix(legacy.get('weatherWind'), LEGACY_CONDITION_KEYS, WIND_KEYS)
    conditions = _object(source.get('conditions'))
    ancestors = {'lightFog': 'fog', 'heavyRain': 'rain', 'heavySnow': 'snow'}
    for key, ancestor in ancestors.items():
        conditions[key] = copy.deepcopy(_object(conditions.get(ancestor)))
    labels = {'lightFog': ('薄雾', '🌫️'), 'heavyRain': ('暴雨', '🌧️'),
              'heavySnow': ('大雪', '🌨️'), 'storm': ('雷暴（伴暴雨）', '⛈️'),
              'wind': ('强风（旧存档）', '💨'), 'heat': ('酷热（旧存档）', '🏜️')}
    for key in CONDITION_KEYS:
        entry = _object(conditions.get(key))
        if key in labels: entry['label'], entry['icon'] = labels[key]
        entry.update(legacyOnly=key in ('wind', 'heat'),
                     obscurement='heavy' if key == 'fog' else 'light' if key in ('lightFog', 'heavyRain', 'heavySnow', 'storm') else 'none',
                     heavyPrecipitation=key in ('heavyRain', 'heavySnow', 'storm'),
                     precipitation='rain' if key in ('rain', 'heavyRain', 'storm') else 'snow' if key in ('snow', 'heavySnow') else 'none',
                     effects=[])
        if key in ('fog', 'lightFog'):
            entry['description'] = '浓雾形成重度遮蔽。' if key == 'fog' else '薄雾形成轻度遮蔽。'
            entry['effects'] = [dict(title='重度遮蔽' if key == 'fog' else '轻度遮蔽',
                detail='区域阻挡视觉；尝试看见其中目标时，视为目盲。' if key == 'fog' else '仅依赖视觉的感知（察觉）检定有劣势。',
                sourceId='vision', when='透过雾观察目标时')]
        if key in ('heavyRain', 'heavySnow', 'storm'):
            entry['description'] = '强降雪，使用大雪环境规则。' if key == 'heavySnow' else '强降雨，使用暴雨环境规则；不自动产生雷击伤害。'
            entry['effects'] = [dict(title='大雪' if key == 'heavySnow' else '暴雨',
                detail='区域轻度遮蔽；区域中所有感知（察觉）检定有劣势。' + ('' if key == 'heavySnow' else '熄灭明火。'),
                sourceId='environment', when='实际处在强降水区域中')]
        entry.setdefault('description', '仅兼容旧存档；实际效果按独立风力和温度处理。' if key in ('wind', 'heat') else '按实际光照与环境描述。')
    weather = {}
    weather_wind = {}
    for key in CONDITION_KEYS:
        ancestor = ancestors.get(key, key)
        row = old_weather[ancestor]
        weather[key] = {column: (0 if column in ('wind', 'heat') else
            row[ancestors.get(column, column)] * (.35 if column in ancestors else 1)) for column in CONDITION_KEYS}
        weather_wind[key] = dict(old_weather_wind[ancestor])
        if key in ('fog', 'lightFog'):
            weather_wind[key].update(strong=0, gale=0)
    climates = _object(source.get('climates'))
    for key in CLIMATE_KEYS:
        profile = _object(climates.get(key))
        seasonal = _object(profile.get('weather'))
        for season in SEASON_KEYS:
            pool = seasonal.get(season)
            if not isinstance(pool, list) or not 1 <= len(pool) <= 200: _climate_error()
            seasonal[season] = [{'heat': 'clear', 'wind': 'cloudy'}.get(_enum(candidate, LEGACY_CONDITION_KEYS), candidate)
                                for candidate in pool]
        profile['transitions'] = dict(weather=copy.deepcopy(weather), wind=copy.deepcopy(old_wind),
                                      weatherWind=copy.deepcopy(weather_wind))
        profile.setdefault('description', '由旧版气候资料迁移；可独立调整本地区的天气与风力矩阵。')
    references = source.get('sources')
    if not isinstance(references, list): _climate_error()
    for index, raw in enumerate(references):
        entry = _object(raw)
        entry['id'] = ('srd', 'environment')[index] if index < 2 else f'source-{index + 1}'
    if len(references) < 2: _climate_error()
    references.append(dict(id='vision', title='2024 Basic Rules — Playing the Game: Vision and Light',
        url='https://www.dndbeyond.com/sources/dnd/br-2024/playing-the-game#VisionandLight', license='官方在线规则参考'))
    source.pop('transitions', None)
    source['version'] = 2
    return source


def _public_climate(value):
    """Validate v2 region matrices and reconstruct every public field.

    Matrix entries are relative weights, not probabilities. Extra authored
    fields can exist in the private source but are never emitted to browsers.
    Version 1 migrates explicitly to the same public v2 shape. The calendar
    remains the existing 24-hour, 7-day, 52-week application clock.
    """
    source = _object(value)
    if type(source.get('version')) is not int or source['version'] not in (1, 2): _climate_error()
    if source['version'] == 1: source = _upgrade_climate_v1(source)
    calendar = _object(source.get('calendar'))
    projected = {'version': 2, 'name': _text(source.get('name'))}
    projected['calendar'] = {}
    for key, fixed in (('minutesPerDay', 1440), ('daysPerWeek', 7), ('weeksPerYear', 52)):
        projected['calendar'][key] = _number(calendar.get(key), fixed, fixed, integer=True)
    projected['calendar']['label'] = _text(calendar.get('label'))

    seasons = source.get('seasons')
    if not isinstance(seasons, list) or len(seasons) != len(SEASON_KEYS): _climate_error()
    projected['seasons'] = []
    occupied = set()
    for key, raw in zip(SEASON_KEYS, seasons):
        entry = _object(raw)
        if entry.get('key') != key: _climate_error()
        first = _number(entry.get('firstWeek'), 1, 52, integer=True)
        last = _number(entry.get('lastWeek'), first, 52, integer=True)
        weeks = set(range(first, last+1))
        if occupied.intersection(weeks): _climate_error()
        occupied.update(weeks)
        projected['seasons'].append(dict(key=key, label=_text(entry.get('label')),
            icon=_text(entry.get('icon'), 32), firstWeek=first, lastWeek=last))
    if occupied != set(range(1, 53)): _climate_error()

    conditions = _object(source.get('conditions'))
    projected['conditions'] = {}
    for key in CONDITION_KEYS:
        entry = _object(conditions.get(key))
        out = dict(label=_text(entry.get('label')), icon=_text(entry.get('icon'), 32),
                   temperatureDelta=_number(entry.get('temperatureDelta'), -100, 100))
        out['description'] = _text(entry.get('description'))
        for flag in ('legacyOnly', 'heavyPrecipitation'):
            if type(entry.get(flag)) is not bool: _climate_error()
            out[flag] = entry[flag]
        if out['legacyOnly'] != (key in ('wind', 'heat')): _climate_error()
        out['obscurement'] = _enum(entry.get('obscurement'), ('none', 'light', 'heavy'))
        out['precipitation'] = _enum(entry.get('precipitation'), ('none', 'rain', 'snow'))
        if out['heavyPrecipitation'] != (key in ('storm', 'heavyRain', 'heavySnow')): _climate_error()
        expected_obscurement = 'heavy' if key == 'fog' else 'light' if key in ('lightFog', 'storm', 'heavyRain', 'heavySnow') else 'none'
        expected_precipitation = 'rain' if key in ('rain', 'storm', 'heavyRain') else 'snow' if key in ('snow', 'heavySnow') else 'none'
        if out['obscurement'] != expected_obscurement or out['precipitation'] != expected_precipitation: _climate_error()
        effects = entry.get('effects')
        if not isinstance(effects, list) or len(effects) > 20: _climate_error()
        out['effects'] = []
        for effect in effects:
            effect = _object(effect)
            out['effects'].append(dict(title=_text(effect.get('title')), detail=_text(effect.get('detail')),
                                       sourceId=_text(effect.get('sourceId'), 120), when=_text(effect.get('when'))))
        projected['conditions'][key] = out
    winds = _object(source.get('winds'))
    projected['winds'] = {}
    for key in WIND_KEYS:
        entry = _object(winds.get(key))
        projected['winds'][key] = dict(label=_text(entry.get('label')), icon=_text(entry.get('icon'), 32))

    climates = _object(source.get('climates'))
    projected['climates'] = {}
    for key in CLIMATE_KEYS:
        entry = _object(climates.get(key))
        temperatures = _object(entry.get('temperatures'))
        weather = _object(entry.get('weather'))
        out = dict(label=_text(entry.get('label')), icon=_text(entry.get('icon'), 32),
                   diurnalRange=_number(entry.get('diurnalRange'), 0, 100),
                   temperatures={}, weather={})
        if 'description' in entry: out['description'] = _text(entry['description'])
        for season in SEASON_KEYS:
            out['temperatures'][season] = _number(temperatures.get(season), -100, 100)
            candidates = weather.get(season)
            if not isinstance(candidates, list) or not 1 <= len(candidates) <= 200: _climate_error()
            out['weather'][season] = [_enum(candidate, ACTIVE_CONDITION_KEYS) for candidate in candidates]
        transitions = _object(entry.get('transitions'))
        out['transitions'] = {
            'weather': _matrix(transitions.get('weather'), CONDITION_KEYS, CONDITION_KEYS),
            'wind': _matrix(transitions.get('wind'), WIND_KEYS, WIND_KEYS),
            'weatherWind': _matrix(transitions.get('weatherWind'), CONDITION_KEYS, WIND_KEYS),
        }
        for previous in CONDITION_KEYS:
            row = out['transitions']['weather'][previous]
            if row['wind'] or row['heat']: _climate_error()
            for pool in out['weather'].values():
                # A valid row must be usable in every season, even when a
                # saved condition came from another region or an older build.
                if not any(row[condition] > 0 for condition in pool): _climate_error()
            weather_wind = out['transitions']['weatherWind'][previous]
            if previous in ('fog', 'lightFog') and (weather_wind['strong'] or weather_wind['gale']): _climate_error()
            for wind_row in out['transitions']['wind'].values():
                if not any(weather_wind[wind] * wind_row[wind] > 0 for wind in WIND_KEYS): _climate_error()
        projected['climates'][key] = out
    temperature = _object(source.get('temperature'))
    curve = temperature.get('hourlyCurve')
    if not isinstance(curve, list) or len(curve) != 24: _climate_error()
    minimum = _number(temperature.get('min'), -100, 100)
    maximum = _number(temperature.get('max'), -100, 100)
    if minimum >= maximum: _climate_error()
    projected['temperature'] = dict(
        hourlyCurve=[_number(point, -100, 100) for point in curve],
        inertia=_number(temperature.get('inertia'), 0, 1),
        maxHourlyStep=_number(temperature.get('maxHourlyStep'), 0.000001, 100),
        maxSnowTemperature=_number(temperature.get('maxSnowTemperature'), minimum, maximum),
        noise=_number(temperature.get('noise'), 0, 100), min=minimum, max=maximum)
    schedule = _object(source.get('schedule'))
    projected['schedule'] = dict(
        secondsPerStep=_number(schedule.get('secondsPerStep'), 3600, 3600, integer=True),
        maxCatchupHours=_number(schedule.get('maxCatchupHours'), 1, 1000000, integer=True))
    default = _object(source.get('defaultWeather'))
    if type(default.get('auto')) is not bool: _climate_error()
    projected['defaultWeather'] = dict(climate=_enum(default.get('climate'), CLIMATE_KEYS),
        condition=_enum(default.get('condition'), CONDITION_KEYS),
        temperature=_number(default.get('temperature'), minimum, maximum),
        wind=_enum(default.get('wind'), WIND_KEYS), auto=default['auto'])

    notes = source.get('rulesNotes')
    references = source.get('sources')
    if not isinstance(notes, list) or len(notes) > 100: _climate_error()
    if not isinstance(references, list) or len(references) > 100: _climate_error()
    projected['rulesNotes'] = []
    for raw in notes:
        entry = _object(raw)
        page = entry.get('sourcePage')
        if page is not None: page = _number(page, 1, 10000, integer=True)
        projected['rulesNotes'].append(dict(id=_text(entry.get('id'), 120),
            title=_text(entry.get('title')), detail=_text(entry.get('detail')), sourcePage=page))
    projected['sources'] = []
    source_ids = set()
    for raw in references:
        entry = _object(raw)
        source_id = _text(entry.get('id'), 120)
        if not source_id or source_id in source_ids: _climate_error()
        source_ids.add(source_id)
        url = _text(entry.get('url'))
        parsed = urlparse(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password: _climate_error()
        projected['sources'].append(dict(id=source_id, title=_text(entry.get('title')), url=url,
                                         license=_text(entry.get('license'))))
    for condition in projected['conditions'].values():
        if any(effect['sourceId'] not in source_ids for effect in condition['effects']): _climate_error()
    return projected


def _validate(kind, value):
    if kind == 'menus':
        _menu_values(value)
        return
    if kind == 'climate':
        _public_climate(value)
        return
    if not isinstance(value, dict) or not value:
        raise ValueError('日常小事资料格式无效')
    if kind == 'fishing-tables':
        for field in ('locations', 'times', 'weathers', 'tables'):
            if not isinstance(value.get(field), list) or not value[field]:
                raise ValueError('钓鱼资料缺少分类或表格')
        for table in value['tables']:
            if not isinstance(table, dict) or not isinstance(table.get('rows'), list):
                raise ValueError('钓鱼表格格式无效')


def validate_bundle(value):
    """The portable general module accepts only five fixed JSON datasets."""
    if not isinstance(value, dict) or set(value)-{'data','readme','dataReadme'}:
        raise ValueError('日常小事模块资料清单无效')
    data = value.get('data')
    if not isinstance(data, dict) or set(data) != set(DATA_FILES):
        raise ValueError('日常小事模块必须包含完整的五类资料')
    for kind, entry in data.items():
        try: size = len(json.dumps(entry, ensure_ascii=False, allow_nan=False).encode('utf-8'))
        except (TypeError, ValueError, UnicodeError) as error:
            raise ValueError('日常小事资料不是有效 JSON') from error
        if size > MAX_DATA_BYTES: raise ValueError('日常小事资料超过容量限制')
        _validate(kind, entry)
    for field in ('readme', 'dataReadme'):
        if field in value and (not isinstance(value[field], str) or len(value[field].encode('utf-8')) > MAX_DATA_BYTES):
            raise ValueError('日常小事说明文件无效或过大')
    return value


def read_bundle(save_root):
    """Read authored files even when disabled, for export/update/restore only."""
    with LOCK:
        workspace, directory = module_root(save_root, allow_disabled=True)
        value = {'data':{kind:_read_json(workspace, directory/'资料'/name) for kind,name in DATA_FILES.items()}}
        for field, relative in (('readme','README.md'), ('dataReadme','资料/README.md')):
            path = workspace.checked(directory/relative)
            if path.is_file():
                if path.stat().st_size > MAX_DATA_BYTES: raise ValueError('日常小事说明文件过大')
                value[field] = path.read_text('utf-8')
        return validate_bundle(value)


def publish_bundle(workspace, directory, value, atomic):
    """Publish under the workspace outbox lock/marker; failures are replayable."""
    bundle = validate_bundle(value['bundle'])
    for kind, name in DATA_FILES.items(): atomic(workspace.checked(directory/'资料'/name), bundle['data'][kind])
    for field, relative in (('readme','README.md'), ('dataReadme','资料/README.md')):
        path = workspace.checked(directory/relative)
        if field not in bundle:
            path.unlink(missing_ok=True)
            continue
        import os
        import secrets
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name+'.'+secrets.token_hex(8)+'.tmp')
        try:
            with temporary.open('x', encoding='utf-8') as handle:
                handle.write(bundle[field]); handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if temporary.exists(): temporary.unlink()
    manifest = dict(format='sundoll-workspace-module', version=4, family='通用包', id=MODULE_ID,
                    portable=True, enabled=value['enabled'], sourceModuleId=value['sourceModuleId'])
    atomic(workspace.checked(directory/'模块.json'), manifest)


def load_data(save_root, kind, public=False):
    """Read fresh data; public access exposes only menu or climate projections.

    ``kind`` is one of DATA_FILES' fixed keys, not a filename or relative path.
    Authorization for private values belongs to the HTTP handler calling this.
    Missing or malformed modules raise an error; no implicit replacement exists.
    """
    if kind not in DATA_FILES:
        raise ValueError('未知的日常小事资料类别')
    if public and kind not in ('menus', 'climate'):
        raise PermissionError('此日常小事资料只供主持人读取')
    with LOCK:
        workspace, directory = module_root(save_root)
        value = _read_json(workspace, directory / '资料' / DATA_FILES[kind])
        _validate(kind, value)
    if public:
        return _public_menus(value) if kind == 'menus' else _public_climate(value)
    return value
