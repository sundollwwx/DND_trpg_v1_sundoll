from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import tempfile
import unittest
from pathlib import Path
from server.static_policy import static_file_allowed


class StaticPolicyTests(unittest.TestCase):
    def test_private_data_and_directory_listings_are_never_public(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name in ['存档/战役/c1/当前存档.json','备团/剧情.md','output/候选.png','docs/a.md',
                         '.git/config','server/static_policy.py','asset/音乐制作/demo.mp3']:
                p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('private')
                for host in [True,False]:self.assertFalse(static_file_allowed(root,p,host),name)
            self.assertFalse(static_file_allowed(root,root,True))
    def test_runtime_allowlist_and_host_pages(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name in ['主控台/玩家.html','shared/rules.js','shared/design-system.css','主控台/shared/downed-portrait.js','asset/界面/logo.png','主控台/主控台.html','主控台/host/prep-handbook.js','主控台/host/prep-handbook.css']:
                p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('test')
                self.assertTrue(static_file_allowed(root,p,True),name)
                self.assertEqual(static_file_allowed(root,p,False),name not in ['主控台/主控台.html','主控台/host/prep-handbook.js','主控台/host/prep-handbook.css'])
    def test_map_form_editor_files_are_host_only(self):
        for name in ['shared/map-forms.js','主控台/host/map-forms.js','主控台/host/map-forms.css']:
            self.assertTrue(static_file_allowed(APP_ROOT, APP_ROOT/name, True))
            self.assertFalse(static_file_allowed(APP_ROOT, APP_ROOT/name, False))

    def test_initiative_ribbon_is_available_to_host_and_players(self):
        for name in ['主控台/shared/initiative-ribbon.js', '主控台/shared/initiative-ribbon.css']:
            for host in [True, False]:
                self.assertTrue(static_file_allowed(APP_ROOT, APP_ROOT/name, host))

    def test_allowed_filename_cannot_link_to_private_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);secret=root/'secret';secret.write_text('private')
            (root/'asset/界面').mkdir(parents=True);link=root/'asset/界面/leak.png';link.symlink_to(secret)
            self.assertFalse(static_file_allowed(root,link,True))
