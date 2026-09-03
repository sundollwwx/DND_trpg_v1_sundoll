import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
HOST_HTML = PROJECT_ROOT / '主控台' / '主控台.html'
HOST_JS = PROJECT_ROOT / '主控台' / 'app.js'


class IdCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.elements = {}
        self.duplicate_ids = set()

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        element_id = values.get('id')
        if not element_id:
            return
        if element_id in self.elements:
            self.duplicate_ids.add(element_id)
        self.elements[element_id] = {'tag': tag, 'attrs': values}


class DetailPanelMarkupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = HOST_HTML.read_text(encoding='utf-8')
        cls.javascript = HOST_JS.read_text(encoding='utf-8')
        cls.parser = IdCollector()
        cls.parser.feed(cls.html)

    def test_page_ids_remain_unique(self):
        self.assertEqual(self.parser.duplicate_ids, set())

    def test_detail_panel_has_three_accessible_tabs(self):
        expected = {
            'detail-tab-status': 'detail-panel-status',
            'detail-tab-tactics': 'detail-panel-tactics',
            'detail-tab-manage': 'detail-panel-manage',
        }
        for tab_id, panel_id in expected.items():
            tab = self.parser.elements[tab_id]
            panel = self.parser.elements[panel_id]
            self.assertEqual(tab['attrs'].get('role'), 'tab')
            self.assertEqual(tab['attrs'].get('aria-controls'), panel_id)
            self.assertEqual(panel['attrs'].get('role'), 'tabpanel')
            self.assertEqual(panel['attrs'].get('aria-labelledby'), tab_id)

    def test_owner_is_a_bounded_player_selector(self):
        owner = self.parser.elements['detail-owner']
        self.assertEqual(owner['tag'], 'select')
        self.assertIn('GM 控制', self.html)
        self.assertNotIn('owner-list', self.html)

    def test_high_frequency_controls_stay_in_status_panel(self):
        status = re.search(
            r'id="detail-panel-status"[\s\S]*?id="detail-panel-tactics"',
            self.html,
        )
        self.assertIsNotNone(status)
        markup = status.group(0)
        for element_id in (
            'detail-hp-current',
            'detail-hp-max',
            'detail-ac-input',
            'detail-conditions',
            'btn-detail-hp-undo',
        ):
            self.assertIn(f'id="{element_id}"', markup)

    def test_numeric_inputs_use_draft_commit_helpers(self):
        self.assertIn('function commitDetailNumberInput(', self.javascript)
        self.assertIn("input.dataset.dirty = 'true'", self.javascript)
        self.assertNotIn("$('#detail-hp-current').addEventListener('input', (e) => {", self.javascript)

    def test_unit_card_uses_its_dedicated_close_control(self):
        card = self.parser.elements['unit-card']
        self.assertIn('data-no-collapse', card['attrs'])
        self.assertIn('btn-detail-close', self.parser.elements)
        self.assertIn(".card:not([data-no-collapse])", self.javascript)


if __name__ == '__main__':
    unittest.main()
