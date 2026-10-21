from project_test_paths import DAILY_LIFE_FIXTURE
import importlib.util
import itertools
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
APP = ROOT/'程序包/主程序'
sys.path.insert(0, str(APP))
from server.static_policy import static_file_allowed

class FishingTablesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = DAILY_LIFE_FIXTURE/'资料/fishing-tables.json'
        cls.data = json.loads(cls.path.read_text())

    def test_all_24_combinations_have_twenty_unique_results(self):
        d=self.data
        expected=set(itertools.product([p['id'] for p in d['locations']],d['times'],d['weathers']))
        actual=[(t['location'],t['time'],t['weather']) for t in d['tables']]
        self.assertEqual(len(actual),24)
        self.assertEqual(set(actual),expected)
        for t in d['tables']:
            self.assertEqual([r['roll'] for r in t['rows']],list(range(1,21)))
            self.assertEqual(len({r['name'] for r in t['rows']}),20)
            self.assertIn('没有任何收获',t['rows'][7]['effect'])
            self.assertIn('艰难战斗',t['rows'][0]['effect'])
            for r in t['rows'][1:3]: self.assertIn('脱战',r['effect'])
            self.assertIn('鱼饵完整收回',t['rows'][19]['effect'])

    def test_majority_stable_and_extremes_unique(self):
        for p in self.data['locations']:
            tables=[t for t in self.data['tables'] if t['location']==p['id']]
            for i in [0,19]:self.assertEqual(len({t['rows'][i]['name'] for t in tables}),6)
            for a,b in itertools.combinations(tables,2):
                self.assertGreaterEqual(sum(x==y for x,y in zip(a['rows'],b['rows'])),15)

    def test_no_d2_and_risk_damage_progression(self):
        self.assertIsNone(re.search(r'(?i)\bd2\b',self.path.read_text()))
        def bounds(effect):
            expr=re.search(r'受到 ([\dd＋]+) 点',effect).group(1)
            low=high=0
            for part in expr.split('＋'):
                if 'd' in part:
                    count,sides=map(int,part.split('d'));low+=count;high+=count*sides
                else: low+=int(part);high+=int(part)
            return low,high
        for time in self.data['times']:
            for weather in self.data['weathers']:
                prev=(0,0)
                for place in self.data['locations']:
                    t=next(t for t in self.data['tables'] if (t['location'],t['time'],t['weather'])==(place['id'],time,weather))
                    heavy=bounds(t['rows'][3]['effect']);light=bounds(t['rows'][4]['effect'])
                    self.assertGreater(heavy[0],light[1])
                    self.assertGreater(heavy[0],prev[0]);self.assertGreater(heavy[1],prev[1]);prev=heavy

    def test_rewards_increase_and_lava_requirements_present(self):
        def price(text):
            m=re.search(r'(?:整份收购价 |价值 |获得 .*?，)(\d+ (?:金币|银币|铜币)(?: \d+ (?:银币|铜币))*)',text)
            self.assertIsNotNone(m,text)
            return sum(int(n)*{'金币':100,'银币':10,'铜币':1}[u] for n,u in re.findall(r'(\d+) (金币|银币|铜币)',m.group(1)))
        # 奖池按地区递增；同一地区晚雨的顶奖高于早晴。
        for time in self.data['times']:
            for weather in self.data['weathers']:
                prizes=[price(next(t for t in self.data['tables'] if (t['location'],t['time'],t['weather'])==(p['id'],time,weather))['rows'][19]['effect']) for p in self.data['locations']]
                self.assertEqual(prizes,sorted(set(prizes)))
        lava=next(p for p in self.data['locations'] if p['id']=='lava')
        self.assertIn('黑曜石',lava['gear']);self.assertIn('魔法鱼饵',lava['gear']);self.assertIn('缺少任一项不能掷表',lava['gear'])

    def test_host_only_assets(self):
        for name in ['daily-life.js','daily-life.css','lifestyle-ui.js','world-ui.js']:
            target=APP/'主控台/host'/name
            self.assertTrue(static_file_allowed(APP,target,True))
            self.assertFalse(static_file_allowed(APP,target,False))

    def test_single_general_source_is_not_statically_served(self):
        self.assertFalse((APP/'主控台/host/fishing-tables.json').exists())
        self.assertFalse(static_file_allowed(APP,self.path,True))
        self.assertEqual(self.data['provenance']['kind'],'legacy-house-rule')

    def test_exports_match_runtime_data(self):
        spec = importlib.util.spec_from_file_location('fishing_export',
            ROOT/'开发包/生活玩法/export_fishing.py')
        exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(exporter)
        with tempfile.TemporaryDirectory(prefix='sundoll-fishing-export-') as directory:
            output = Path(directory)
            exporter.export(output=output)
            self.assertEqual({p.name for p in output.iterdir()},
                             {p['file'] for p in self.data['locations']})
            for p in self.data['locations']:
                text=(output/p['file']).read_text(encoding='utf-8')
                self.assertIsNone(re.search(r'(?i)\bd2\b',text))
                for t in self.data['tables']:
                    if t['location']==p['id']:
                        self.assertIn(f"## {t['time']} · {t['weather']}",text)
                        for r in t['rows']:self.assertIn(f"| {r['roll']} | {r['name']} | {r['effect']} |",text)

if __name__=='__main__':unittest.main()
