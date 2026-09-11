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
