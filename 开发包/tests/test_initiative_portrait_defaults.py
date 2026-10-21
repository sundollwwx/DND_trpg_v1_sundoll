from project_test_paths import APP_ROOT
import json
from pathlib import Path
import tempfile
import unittest
from server.initiative_portrait_defaults import CONFIG_NAME, MAX_BYTES, read_defaults, bootstrap_markup


class InitiativePortraitDefaultsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.save = self.root/'运行数据/存档'
        self.save.mkdir(parents=True)
        self.config = self.save.parent/CONFIG_NAME

    def test_missing_or_invalid_configuration_stays_empty(self):
        empty = {'owned':{}, 'presets':{}}
        self.assertEqual(read_defaults(self.save), empty)
        self.assertFalse(self.config.exists())
        for raw in ('bad json', 'null', '[]', '{"version":2}', 'x'*(MAX_BYTES+1)):
            self.config.write_text(raw)
            self.assertEqual(read_defaults(self.save), empty)

    def test_only_module_asset_urls_are_active_and_markup_is_inert(self):
        valid = '/api/module-assets/'+'1'*64
        self.config.write_text(json.dumps(dict(version=1, owned={
            'synthetic-role':valid, 'broken':'立绘/missing.png',
            'outside':'https://example.test/image.png', 'escape':'</script>'}, presets={})))
        self.assertEqual(read_defaults(self.save), {'owned':{'synthetic-role':valid},'presets':{}})
        markup = bootstrap_markup(self.save)
        self.assertEqual(markup.count('</script>'), 1)
        self.assertIn('type="application/json"', markup)

    def test_configuration_does_not_follow_symlinks(self):
        other = self.root/'other.json'
        other.write_text(json.dumps(dict(version=1,owned={'synthetic':'/api/module-assets/'+'2'*64})))
        self.config.symlink_to(other)
        self.assertEqual(read_defaults(self.save), {'owned':{},'presets':{}})


if __name__=='__main__': unittest.main()
