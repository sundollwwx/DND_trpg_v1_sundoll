"""General-module reads, public projection and distribution ownership."""
from project_test_paths import DAILY_LIFE_FIXTURE, APP_ROOT, TOOLS_ROOT
import importlib.util
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server.daily_life import DATA_FILES, MAX_DATA_BYTES, load_data
from server.workspace import enable


SPEC = importlib.util.spec_from_file_location('daily_life_distribution', TOOLS_ROOT/'build_distribution_v4.py')
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


def create_module(root):
    module = root/'通用包/日常小事'
    folder = module/'资料'
    folder.mkdir(parents=True)
    (module/'模块.json').write_text(json.dumps({
        'format': 'sundoll-workspace-module', 'version': 4,
        'family': '通用包', 'id': '日常小事', 'portable': False,
    }, ensure_ascii=False), encoding='utf-8')
    values = {
        'lifestyle': {'version': 1, 'edition': 'SRD 5.2.1', 'rules': []},
        'flavor': {'version': 1, 'locations': []},
        'climate': json.loads((DAILY_LIFE_FIXTURE / '资料/climate.json').read_text('utf-8')),
        'fishing-tables': {
            'locations': [{'id': 'river'}], 'times': ['早'],
            'weathers': ['晴天'], 'tables': [{'location': 'river', 'rows': []}],
        },
        'menus': {'version': 1, 'gmSecret': '绝不可公开', 'menus': [{
            'id': 'inn', 'title': '旅店', 'subtitle': '当日菜单',
            'motto': '汤还热着', 'intro': '一份一人', 'note': '银币十铜币',
            'gmSecret': '老板藏着密信', 'sections': [{
                'title': '饭食', 'gmSecret': '暗号在汤里', 'items': [{
                    'name': '热汤', 'price': '3 银币', 'priceCp': 30,
                    'portion': '一人份', 'detail': '一碗浓汤', 'tag': '热食',
                    'gmSecret': '不要泄露', 'nestedSecret': {'password': 'secret'},
                }],
            }],
        }]},
    }
    for kind, value in values.items():
        (folder/DATA_FILES[kind]).write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    (module/'README.md').write_text('规则与创作内容的说明。', encoding='utf-8')
    return module, values


class DailyLifeModuleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sundoll-daily-read-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.save = enable(self.root)
        self.module, self.values = create_module(self.root)

    def test_reads_only_general_module_and_reloads_authored_changes(self):
        for kind in DATA_FILES:
            self.assertEqual(load_data(self.save, kind), self.values[kind])
        changed = {'version': 2, 'rules': ['修改后内容']}
        (self.module/'资料/lifestyle.json').write_text(json.dumps(changed), encoding='utf-8')
        self.assertEqual(load_data(self.save, 'lifestyle'), changed)

    def test_rejects_arbitrary_paths_and_public_private_content(self):
        for kind in ('../lifestyle', '资料/lifestyle.json', '/etc/passwd', 'menus.json'):
            with self.assertRaises(ValueError): load_data(self.save, kind)
        for kind in set(DATA_FILES)-{'menus', 'climate'}:
            with self.assertRaises(PermissionError): load_data(self.save, kind, public=True)

    def test_public_projection_excludes_secrets_at_all_levels(self):
        projected = load_data(self.save, 'menus', public=True)
        text = json.dumps(projected, ensure_ascii=False)
        self.assertNotIn('Secret', text)
        self.assertNotIn('password', text)
        self.assertNotIn('密信', text)
        self.assertEqual(set(projected), {'version', 'menus'})
        self.assertEqual(projected['menus'][0]['sections'][0]['items'][0]['priceCp'], 30)
        self.assertEqual(load_data(self.save, 'menus')['gmSecret'], '绝不可公开')

    def test_rejects_file_and_directory_symlinks(self):
        source = self.module/'资料/lifestyle.json'
        elsewhere = self.root/'outside.json'
        source.rename(elsewhere)
        source.symlink_to(elsewhere)
        with self.assertRaises(ValueError): load_data(self.save, 'lifestyle')
        source.unlink()
        elsewhere.rename(source)
        folder = self.module/'资料'
        target = self.root/'outside-data'
        folder.rename(target)
        folder.symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError): load_data(self.save, 'menus', public=True)

    def test_rejects_invalid_manifest_json_schema_and_oversize(self):
        source = self.module/'资料/lifestyle.json'
        for raw in (b'broken', b'[]', b'{}', b'x'*(MAX_DATA_BYTES+1)):
            source.write_bytes(raw)
            with self.assertRaises(ValueError): load_data(self.save, 'lifestyle')
        manifest = self.module/'模块.json'
        manifest.write_text('{"format":"other"}', encoding='utf-8')
        with self.assertRaises(ValueError): load_data(self.save, 'menus')

    def test_legacy_isolated_save_does_not_fall_back_to_real_module(self):
        with self.assertRaises(FileNotFoundError):
            load_data(self.root/'legacy-isolated-save', 'menus')

    def test_player_projection_preserves_array_menu_format(self):
        path = self.module/'资料/menus.json'
        path.write_text(json.dumps(self.values['menus']['menus'], ensure_ascii=False), encoding='utf-8')
        projected = load_data(self.save, 'menus', public=True)
        self.assertIsInstance(projected, list)
        self.assertEqual(projected[0]['id'], 'inn')
        self.assertNotIn('gmSecret', projected[0])

    def test_public_climate_strips_secrets_recursively_without_losing_configuration(self):
        value = copy.deepcopy(self.values['climate'])

        def add_secrets(node):
            if isinstance(node, dict):
                for child in list(node.values()): add_secrets(child)
                node['gmSecret'] = '私有场景与身份'
            elif isinstance(node, list):
                for child in node: add_secrets(child)

        add_secrets(value)
        (self.module/'资料/climate.json').write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        projected = load_data(self.save, 'climate', public=True)
        self.assertEqual(projected, self.values['climate'])
        self.assertNotIn('gmSecret', json.dumps(projected))
        self.assertEqual(load_data(self.save, 'climate')['gmSecret'], '私有场景与身份')
        json.dumps(projected, ensure_ascii=True, allow_nan=False)

    def test_climate_rejects_invalid_weights_clock_numeric_bounds_and_enums(self):
        original = self.values['climate']
        path = self.module/'资料/climate.json'
        edits = [
            lambda c: c['calendar'].update(daysPerWeek=8),
            lambda c: c['seasons'][0].update(lastWeek=14),
            lambda c: c['temperature'].update(inertia=float('nan')),
            lambda c: c['temperature'].update(maxHourlyStep=float('inf')),
            lambda c: c['temperature'].update(noise=True),
            lambda c: c['temperature'].update(maxSnowTemperature=True),
            lambda c: c['temperature'].update(maxSnowTemperature=float('nan')),
            lambda c: c['temperature'].update(maxSnowTemperature=c['temperature']['max'] + 1),
            lambda c: c['temperature'].pop('maxSnowTemperature'),
            lambda c: c['temperature'].update(hourlyCurve=[0]*23),
            lambda c: c['temperature'].update(min=100, max=-100),
            lambda c: c['schedule'].update(secondsPerStep=1800),
            lambda c: c['defaultWeather'].update(climate='secret-biome'),
            lambda c: c['climates']['temperate']['weather'].update(spring=['unsupported']),
            lambda c: c['climates']['temperate']['transitions']['weather']['clear'].update(clear=-1),
            lambda c: c['climates']['temperate']['transitions']['weather']['clear'].update(clear=10**400),
            lambda c: c['climates']['temperate']['transitions']['wind'].update(calm={key: 0 for key in c['winds']}),
            lambda c: c['climates']['temperate']['transitions']['weather']['clear'].pop('heavyRain'),
            lambda c: c['climates']['temperate']['transitions']['weather']['clear'].update(heat=1),
            lambda c: c['climates']['temperate']['transitions']['weatherWind']['fog'].update(strong=1),
            lambda c: c['climates']['coastal']['transitions']['weatherWind']['lightFog'].update(gale=1),
            lambda c: c['climates']['arid']['weather'].update(summer=['heat']),
            lambda c: c['conditions']['fog'].update(obscurement='full'),
            lambda c: c['conditions']['fog'].update(obscurement='none'),
            lambda c: c['conditions']['rain'].update(heavyPrecipitation=1),
            lambda c: c['conditions']['rain'].update(heavyPrecipitation=True),
            lambda c: c['conditions']['heavySnow'].update(precipitation='rain'),
            lambda c: c['conditions']['wind'].update(legacyOnly=False),
            lambda c: c['conditions']['heavyRain']['effects'][0].update(sourceId='private-reference'),
            lambda c: c['rulesNotes'][0].update(sourcePage=True),
            lambda c: c['sources'][0].update(url='https://user:password@example.org/secret'),
            lambda c: c['sources'][1].update(id=c['sources'][0]['id']),
        ]
        for edit in edits:
            value = copy.deepcopy(original)
            edit(value)
            path.write_text(json.dumps(value), encoding='utf-8')
            with self.subTest(value=value), self.assertRaises(ValueError):
                load_data(self.save, 'climate', public=True)

    def test_region_matrix_rejects_zero_season_and_wind_intersections(self):
        path = self.module/'资料/climate.json'
        for broken in ('season', 'wind'):
            value = copy.deepcopy(self.values['climate'])
            local = value['climates']['temperate']['transitions']
            if broken == 'season':
                # Globally nonzero is insufficient: spring does not contain snow.
                local['weather']['clear'] = {key: int(key == 'snow') for key in value['conditions']}
            else:
                # Each row is nonzero but the weather and wind products are zero.
                local['wind']['calm'] = {key: int(key == 'gale') for key in value['winds']}
                local['weatherWind']['clear'] = {key: int(key == 'calm') for key in value['winds']}
            path.write_text(json.dumps(value), encoding='utf-8')
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                load_data(self.save, 'climate', public=True)

    def test_v1_climate_migrates_to_public_v2_without_rewriting_source(self):
        value = copy.deepcopy(self.values['climate'])
        old_keys = ('clear', 'cloudy', 'rain', 'storm', 'fog', 'snow', 'wind', 'heat')
        local = value['climates']['temperate']['transitions']
        # A v1 fixture has only its original eight conditions and global matrix.
        value['version'] = 1
        value['conditions'] = {key: {field: value['conditions'][key][field] for field in
            ('label', 'icon', 'temperatureDelta', 'description')} for key in old_keys}
        value['transitions'] = {
            'weather': {key: {column: (1 if column in ('wind', 'heat') else local['weather'][key][column])
                             for column in old_keys} for key in old_keys},
            'wind': copy.deepcopy(local['wind']),
            'weatherWind': {key: copy.deepcopy(local['weatherWind'][key]) for key in old_keys},
        }
        for profile in value['climates'].values():
            profile.pop('transitions')
            profile.pop('description')
            profile['weather'] = {season: ['heat', 'wind', 'clear', 'rain'] for season in profile['weather']}
        value['sources'] = [{key: source[key] for key in ('title', 'url', 'license')}
                            for source in value['sources'][:2]]
        value['gmSecret'] = 'must stay private'
        path = self.module/'资料/climate.json'
        path.write_text(json.dumps(value), encoding='utf-8')
        before = path.read_bytes()
        projected = load_data(self.save, 'climate', public=True)
        self.assertEqual(projected['version'], 2)
        self.assertNotIn('transitions', projected)
        self.assertNotIn('gmSecret', json.dumps(projected))
        self.assertEqual(set(projected['conditions']), set(self.values['climate']['conditions']))
        for profile in projected['climates'].values():
            self.assertEqual(profile['weather']['spring'], ['clear', 'cloudy', 'clear', 'rain'])
            self.assertEqual(set(profile['transitions']['weather']), set(projected['conditions']))
            self.assertEqual(profile['transitions']['weatherWind']['lightFog']['strong'], 0)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(load_data(self.save, 'climate')['version'], 1)


class DailyLifeDistributionTests(unittest.TestCase):
    def test_both_editions_copy_only_declared_module_files(self):
        with tempfile.TemporaryDirectory(prefix='sundoll-daily-build-') as temporary:
            root = Path(temporary).resolve()
            source = root/'source'
            module, _ = create_module(source)
            save = enable(source)
            (module/'private.txt').write_text('任意未声明资料不能进入发行', encoding='utf-8')
            app = source/'主程序'
            app.mkdir()

            def copy_engine(_, target): target.mkdir(parents=True)

            with patch.object(BUILDER, 'copy_engine', copy_engine), \
                    patch.object(BUILDER, 'copy_launchers'), \
                    patch.object(BUILDER, 'write_workspace_guide'), \
                    patch.object(BUILDER, 'read_catalog', return_value={'presets': [], 'templates': []}), \
                    patch.object(BUILDER, 'ModulePackages'):
                for standard in (False, True):
                    destination = root/('standard' if standard else 'empty')
                    result = BUILDER.build(app, save, destination, standard=standard)
                    shipped = destination/'程序包/主程序/defaults/日常小事'
                    self.assertEqual(result['dailyLifeFiles'], len(DATA_FILES)+2)
                    for filename in DATA_FILES.values():
                        self.assertEqual((shipped/'资料'/filename).read_bytes(), (module/'资料'/filename).read_bytes())
                    self.assertFalse((shipped/'private.txt').exists())
                    self.assertFalse((destination/'程序包/主程序/资料').exists())
                    manifest = json.loads((destination/'发行清单.json').read_text('utf-8'))
                    self.assertEqual(manifest['dailyLifeFiles'], len(DATA_FILES)+2)
                    self.assertEqual(manifest['edition'], 'standard' if standard else 'empty')

    def test_distribution_reads_the_selected_room_without_original_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);room=root/'room';save=enable(room)
            module,_=create_module(room)
            files=BUILDER.copy_daily_life(root/'central/主程序',root/'output',save)
            self.assertEqual(len(files),len(DATA_FILES)+2)
            self.assertEqual((root/'output/主程序/defaults/日常小事/资料/climate.json').read_bytes(),
                             (module/'资料/climate.json').read_bytes())

    def test_distribution_rejects_symlink_source(self):
        with tempfile.TemporaryDirectory(prefix='sundoll-daily-symlink-build-') as temporary:
            root = Path(temporary).resolve()
            module, _ = create_module(root)
            save = enable(root)
            path = module/'资料/menus.json'
            hidden = root/'hidden.json'
            path.rename(hidden)
            path.symlink_to(hidden)
            with self.assertRaises(ValueError): BUILDER.copy_daily_life(root/'主程序', root/'output', save)


if __name__ == '__main__':
    unittest.main()
