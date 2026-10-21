"""从公开默认菜单数据导出两份已有餐食文档。"""
import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / '程序包/主程序/defaults/日常小事/资料/menus.json'
OUT = ROOT / '创作包/生活玩法/餐食'
DOCUMENTS = {
    'dragon-monastery': '巨龙修道院菜单.md',
    'sundoll-tavern': '桑哆尔之歌酒馆菜单.md',
}


def cell(value):
    return str(value).replace('|', r'\|').replace('\r\n', '<br>').replace('\n', '<br>')


def render(menu):
    setting_note = (
        '本食单的免费用餐与自愿捐赠属于当地款待约定，不能据此推定其他寺院的供应或收费。'
        if menu['id'] == 'dragon-monastery' else
        '标准一人餐参考 2024 食宿档位；热饼、自定酒款及细分份量属于店家设定。'
    )
    text = [
        f"# {menu['title']}菜单", '',
        f"{menu['subtitle']}", '',
        '状态：玩家可见菜单；此文档由公开默认数据生成，不在此处另改价格。', '',
        f"> {menu['motto']}", '', menu['intro'], '', menu['note'], '',
    ]
    for section in menu['sections']:
        text.extend([
            f"## {section['title']}", '',
            '| 餐食／饮品 | 价格与份量 | 风味 |',
            '| --- | --- | --- |',
        ])
        for item in section['items']:
            name = item['name'] + (f"（{item['tag']}）" if item.get('tag') else '')
            text.append(f"| {cell(name)} | {cell(item['price'])} | {cell(item['detail'])} |")
        text.append('')
    text.extend([
        '## 资料来源与使用说明', '',
        '菜单唯一来源：[公开默认菜单数据](../../../程序包/主程序/defaults/日常小事/资料/menus.json)。', '',
        '菜名、口味、店规、具体供应与款待安排为原创地方设定；菜单价格与份量以数据源为准。'
        + setting_note, '',
        '官方食宿档位与计价方式使用 D&D 2024 / SRD 5.2.1；'
        '采用已包含基础食宿的生活费时，不重复收取所含餐费与房费。'
        '菜单不自动扣款、产生增益或满足休息条件。', '',
        '规则来源与完整署名见[日常小事通用包说明](../../../程序包/主程序/defaults/日常小事/README.md)，'
        '官方价格原文见 [SRD 5.2.1 第 101–102 页](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf)。',
    ])
    return '\n'.join(text) + '\n'


def export(check=False):
    data = json.loads(DATA.read_text(encoding='utf-8'))
    menus = {menu['id']: menu for menu in data['menus']}
    mismatches = []
    for identity, filename in DOCUMENTS.items():
        expected = render(menus[identity])
        path = OUT / filename
        if check:
            if not path.is_file() or path.read_text(encoding='utf-8') != expected:
                mismatches.append(str(path.relative_to(ROOT)))
        else:
            OUT.mkdir(parents=True, exist_ok=True)
            path.write_text(expected, encoding='utf-8')
    return mismatches


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='只检查文档是否与数据一致')
    arguments = parser.parse_args()
    differences = export(check=arguments.check)
    if differences:
        parser.exit(1, '菜单文档需同步：\n' + '\n'.join(differences) + '\n')
    print('两份菜单文档与公开默认资料一致。' if arguments.check else '已从公开默认资料同步两份菜单文档。')
