import unittest
from html.parser import HTMLParser
from pathlib import Path

class Panels(HTMLParser):
    def __init__(self):
        super().__init__();self.stack=[];self.locations={}
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if 'id' in attrs:self.locations[attrs['id']]=list(self.stack)
        if tag not in ('input','img','meta','link','br','hr','source'):self.stack.append((tag,attrs))
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:self.stack=self.stack[:i];break

class AppearancePanelTests(unittest.TestCase):
    def test_controls_are_inside_management_panels(self):
        for file,control,attribute in [('主控台.html','detail-portrait','data-detail-panel'),('玩家.html','player-portrait','data-player-detail-panel')]:
            p=Panels();p.feed(Path('主控台',file).read_text())
            self.assertTrue(any(a.get(attribute)=='manage' for _,a in p.locations[control]))
    def test_player_management_tab_enabled(self):
        s=Path('主控台/玩家.html').read_text()
        self.assertIn("['status','tactics','manage','notes'].includes(tab)",s)
        self.assertIn('data-player-detail-tab="manage"',s)

    def test_player_portrait_manager_matches_host_thumbnail_workflow(self):
        source=Path('主控台/玩家.html').read_text()
        for element_id in (
            'player-portrait-manager-open', 'player-portrait-manager-modal',
            'player-portrait-strip', 'player-portrait-scroll-left',
            'player-portrait-scroll-right', 'player-portrait-save-current',
        ):
            self.assertIn('id="%s"' % element_id, source)
        self.assertIn('function renderPlayerPortraitManager(', source)
        self.assertIn("sendPatch(t.id,{portraitVariants:t.portraitVariants}", source)

    def test_right_click_investigation_does_not_replace_left_click_behavior(self):
        source=Path('主控台/玩家.html').read_text()
        self.assertIn('id="token-context-menu"', source)
        self.assertIn('id="token-investigate"', source)
        self.assertIn("board.addEventListener('contextmenu'", source)
        self.assertIn("else if(friendly(selected)&&Number.isFinite(Number(selected.hp)))showTokenPeek", source)
        self.assertIn('function showTokenInvestigation(', source)
        self.assertIn("detailed=friendly(t)&&Number.isFinite(Number(t.hp))", source)
        self.assertIn("(t.conditions||[]).filter(condition=>condition.visibility!=='gm')", source)

    def test_investigation_uses_centered_modal_and_circular_portrait(self):
        source=Path('主控台/玩家.html').read_text()
        self.assertIn('id="token-investigation" class="investigation-mask"', source)
        self.assertIn('id="token-investigation-window" class="investigation-window"', source)
        self.assertIn('.investigation-mask { position:fixed; inset:0;', source)
        self.assertIn('.investigation-window { width:min(680px,94vw);', source)
        self.assertIn('border-radius:50%', source)
        self.assertIn('object-fit:cover', source)
        self.assertIn("stage.classList.toggle('portrait-path',!!t.iconImgPath)", source)
        show_source=source.split('function showTokenInvestigation(t)',1)[1].split('function refreshTokenInvestigation',1)[0]
        self.assertNotIn('placeFloatingElement(', show_source)
