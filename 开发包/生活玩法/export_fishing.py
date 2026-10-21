"""从公开默认数据源导出四份可读文档。"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / '程序包/主程序/defaults/日常小事/资料/fishing-tables.json'
OUT = ROOT / '创作包/生活玩法/钓鱼'

def export(output=None):
    output = Path(output) if output is not None else OUT
    data = json.loads(DATA.read_text(encoding='utf-8'))
    output.mkdir(parents=True, exist_ok=True)
    for place in data['locations']:
        text = [f"# {place['name']}垂钓表" if not place['name'].endswith('垂钓') else f"# {place['name']}表",
                '', '状态：主控台「世界 → 钓鱼」使用的当前设计。自定义规则，物价尚未与完整经济体系校准。',
                '', f"环境风险：{place['risk']}。{place['scene']}", '', place['gear'], '', '## 通用规则', '']
        text.extend('- ' + rule for rule in data['rules'])
        for table in data['tables']:
            if table['location'] != place['id']: continue
            text += ['', f"## {table['time']} · {table['weather']}", '', '| d20 | 结果 | 事件与奖惩 |', '| ---: | --- | --- |']
            text.extend(f"| {r['roll']} | {r['name']} | {r['effect']} |" for r in table['rows'])
        (output/place['file']).write_text('\n'.join(text)+'\n', encoding='utf-8')
if __name__ == '__main__': export()
