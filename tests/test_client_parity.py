import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
HOST_HTML = (PROJECT_ROOT / '主控台' / '主控台.html').read_text(encoding='utf-8')
HOST_JS = (PROJECT_ROOT / '主控台' / 'app.js').read_text(encoding='utf-8')
HOST_CSS = (PROJECT_ROOT / '主控台' / 'style.css').read_text(encoding='utf-8')
PLAYER_HTML = (PROJECT_ROOT / '主控台' / '玩家.html').read_text(encoding='utf-8')
DICE_JS = (PROJECT_ROOT / '骰子动画.js').read_text(encoding='utf-8')


def attribute_values(markup, attribute):
    return set(re.findall(rf'{re.escape(attribute)}="([^"]+)"', markup))


def function_body(source, name, next_name):
    match = re.search(
        rf'function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{([\s\S]*?)\n\s*function\s+{re.escape(next_name)}\s*\(',
        source,
    )
    if not match:
        raise AssertionError(f'Function {name} was not found')
    return match.group(1)


class ClientParityTests(unittest.TestCase):
    def test_shared_dice_reactions_and_spell_presets_match(self):
        self.assertEqual(attribute_values(HOST_HTML, 'data-die'), attribute_values(PLAYER_HTML, 'data-die'))
        self.assertEqual(attribute_values(HOST_HTML, 'data-map-reaction'), attribute_values(PLAYER_HTML, 'data-map-reaction'))
        self.assertEqual(attribute_values(HOST_HTML, 'data-spell-shape'), attribute_values(PLAYER_HTML, 'data-spell-shape'))
        self.assertEqual(attribute_values(HOST_HTML, 'data-spell-feet'), attribute_values(PLAYER_HTML, 'data-spell-feet'))
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-spell-feet'), {'15', '30', '60', '90', '120', '180'})

    def test_both_clients_load_the_same_dice_animation_version(self):
        host_version = re.search(r'骰子动画\.js\?v=([^"<]+)', HOST_HTML)
        player_version = re.search(r'骰子动画\.js\?v=([^"<]+)', PLAYER_HTML)
        self.assertIsNotNone(host_version)
        self.assertIsNotNone(player_version)
        self.assertEqual(host_version.group(1), player_version.group(1))
        self.assertIn('face-lock', host_version.group(1))

    def test_condition_badges_start_at_top_right_above_tokens(self):
        for source in (HOST_CSS, PLAYER_HTML):
            block = re.search(r'\.token-condition-badges\s*\{([^}]+)\}', source)
            self.assertIsNotNone(block)
            css = re.sub(r'\s+', '', block.group(1))
            self.assertIn('right:-2px', css)
            self.assertIn('top:-2px', css)
            self.assertIn('bottom:auto', css)
            self.assertIn('flex-direction:row-reverse', css)
            self.assertIn('z-index:6', css)
        self.assertIn('appendConditionBadges(el, t.conditions, true)', HOST_JS)
        self.assertIn('appendConditionBadges(rd, r.conditions, true)', HOST_JS)
        self.assertIn('appendConditionBadges(el,t.conditions)', PLAYER_HTML)
        self.assertIn('appendConditionBadges(rd,r.conditions)', PLAYER_HTML)
        self.assertIn("condition.visibility === 'gm' ? ' · 仅 GM' : ''", HOST_JS)
        self.assertIn("filter(condition=>condition.visibility!=='gm')", PLAYER_HTML)

    def test_cone_aim_is_a_pointer_drag_and_player_sends_once_on_release(self):
        for hook in ('beginSelectedSpellAim', 'previewSelectedSpellAimAt', 'finishSelectedSpellAim'):
            self.assertIn(f'function {hook}(', HOST_JS)
        for hook in ('beginPlayerSpellAim', 'previewPlayerSpellAimAt', 'finishPlayerSpellAim'):
            self.assertIn(f'function {hook}(', PLAYER_HTML)
        self.assertIn("drag.mode === 'spell-aim'", HOST_JS)
        self.assertIn("drag.kind==='spell-aim'", PLAYER_HTML)
        self.assertIn('setPointerCapture(e.pointerId)', HOST_JS)
        self.assertIn('setPointerCapture(e.pointerId)', PLAYER_HTML)
        preview = function_body(PLAYER_HTML, 'previewPlayerSpellAimAt', 'beginPlayerSpellAim')
        finish = function_body(PLAYER_HTML, 'finishPlayerSpellAim', 'encounter')
        self.assertNotIn('sendPatch(', preview)
        self.assertEqual(finish.count('sendPatch('), 1)
        self.assertIn('按住左键旋转', HOST_JS)
        self.assertIn('按住左键旋转', PLAYER_HTML)

    def test_dice_lock_result_to_world_up_and_report_diagnostics(self):
        self.assertIn('targetVec = worldUp', DICE_JS)
        self.assertNotIn('targetVec = viewDir', DICE_JS)
        self.assertIn('topLabels:', DICE_JS)
        self.assertIn('topScores:', DICE_JS)
        self.assertIn('faceLockPassed:', DICE_JS)
        self.assertIn('root.dataset.faceLockPassed', DICE_JS)
        self.assertIn('qYaw.multiply(qAlign).normalize()', DICE_JS)

    def test_map_grid_and_visual_layer_order_match(self):
        for source in (HOST_JS, PLAYER_HTML):
            self.assertIn('rgba(255,255,255,.78)', source.replace(' ', ''))
            self.assertIn('rgba(0,0,0,.16)', source.replace(' ', ''))
        for source in (HOST_CSS, PLAYER_HTML):
            compact = re.sub(r'\s+', '', source)
            self.assertIn('#spell-range-canvas{z-index:1;', compact)
            self.assertIn('#turn-path-canvas{z-index:2;', compact)
            self.assertIn('#doodle-canvas{', compact)
            self.assertIn('z-index:3;', compact)
        self.assertIn("${streamInfo.readyCount || 0} 人已准备", HOST_JS)


if __name__ == '__main__':
    unittest.main()
