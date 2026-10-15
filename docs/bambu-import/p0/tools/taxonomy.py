"""P0 taxonomy rules: route -> leaf, per-product evidence-backed overrides, families (spec §D.2)."""
import re

L1 = {
    'printers': '552709755391528960', 'filament': '552709755819347968', 'accessories': '552709757765505024',
    'spare_parts': '552709758222684160', 'makers': '552709760852512768', 'laser_materials': '578424673239986176',
    'laser_machines': '777329586458394624',
}

# New nodes (insert-only, created by /run/prepare-taxonomy). Names reviewed against the app's vocabulary (row 183).
CREATE = [
    # key, parent, slug, en, ar, ckb, template_family, is_printer_catalog, sort
    # Parent is cat_printers_fdm, not cat_printers: a branch [@printers-refurb, cat_printers] names neither leaf of the
    # 'printer-technology' axis, so worker/lib/templateFamilies.ts excludedGroups() answers with the FDM + Resin union (all
    # five refurbished printers are FDM). Under cat_printers_fdm the branch names the FDM leaf and keeps only the FDM groups.
    ('printers-refurb', 'cat_printers_fdm', 'factory-refurbished-printers', 'Factory-refurbished printers', 'طابعات مجدَّدة من المصنع',
     'چاپکەرە نوێکراوەکانی کارگە', 'devices', 1, 13),
    ('ams', 'cat_pacc_fdm', 'ams-filament-feeding', 'AMS & filament feeding', 'أنظمة تغذية المواد (AMS)',
     'سیستەمەکانی پێدانی کەرەستە (AMS)', 'devices', 0, 5),
    ('printer-acc', 'cat_pacc_fdm', 'printer-accessories-add-ons', 'Printer accessories & add-ons', 'ملحقات وإضافات الطابعات',
     'پێداویستی و زیادکراوەکانی چاپکەر', 'devices', 0, 6),
    ('pla', 'cat_materials_fdm', 'pla', 'PLA', 'PLA', 'PLA', 'materials', 0, 1),
    ('petg', 'cat_materials_fdm', 'petg', 'PETG', 'PETG', 'PETG', 'materials', 0, 2),
    ('abs-asa', 'cat_materials_fdm', 'abs-asa', 'ABS & ASA', 'ABS وASA', 'ABS و ASA', 'materials', 0, 3),
    ('tpu', 'cat_materials_fdm', 'tpu', 'TPU', 'TPU', 'TPU', 'materials', 0, 4),
    ('pc', 'cat_materials_fdm', 'pc', 'PC', 'PC', 'PC', 'materials', 0, 5),
    ('engineering', 'cat_materials_fdm', 'engineering-materials', 'Engineering materials', 'مواد هندسية', 'کەرەستەی ئەندازیاری', 'materials', 0, 6),
    ('support', 'cat_materials_fdm', 'support-materials', 'Support materials', 'مواد الدعم', 'کەرەستەی پاڵپشت', 'materials', 0, 7),
    ('fiber', 'cat_materials_fdm', 'fibre-reinforced', 'Fibre-reinforced', 'مواد مقوّاة بالألياف', 'کەرەستەی بەهێزکراو بە ڕیشاڵ', 'materials', 0, 8),
    ('filament-packs', 'cat_materials_fdm', 'filament-packs-bundles', 'Filament packs & bundles', 'باقات ومجموعات الفلامنت',
     'پاکێج و کۆمەڵەکانی فیلامێنت', 'materials', 0, 9),
    ('filament-acc', 'cat_materials_fdm', 'filament-accessories', 'Filament accessories', 'ملحقات الفلامنت', 'پێداویستی فیلامێنت', 'materials', 0, 10),
    ('parts-x1p1', 'cat_maint_spare', 'x1-p1-series-parts', 'X1 & P1 series parts', 'قطع غيار سلسلة X1 وP1',
     'پارچە یەدەگەکانی زنجیرەی X1 و P1', 'devices', 0, 1),
    ('parts-a1', 'cat_maint_spare', 'a1-a2l-series-parts', 'A1 & A2L series parts', 'قطع غيار سلسلة A1 وA2L',
     'پارچە یەدەگەکانی زنجیرەی A1 و A2L', 'devices', 0, 2),
    ('parts-h2', 'cat_maint_spare', 'h2-series-parts', 'H2 series parts', 'قطع غيار سلسلة H2', 'پارچە یەدەگەکانی زنجیرەی H2', 'devices', 0, 3),
    ('parts-p2x2', 'cat_maint_spare', 'p2s-x2d-parts', 'P2S & X2D parts', 'قطع غيار P2S وX2D', 'پارچە یەدەگەکانی P2S و X2D', 'devices', 0, 4),
    ('parts-ams', 'cat_maint_spare', 'ams-parts', 'AMS parts', 'قطع غيار AMS', 'پارچە یەدەگەکانی AMS', 'devices', 0, 5),
    ('parts-laser', 'cat_maint_spare', 'r1-laser-parts', 'R1 laser parts', 'قطع غيار ليزر R1', 'پارچە یەدەگەکانی لەیزەری R1', 'devices', 0, 6),
    ('parts-common', 'cat_maint_spare', 'parts-for-all-series', 'Parts for all series', 'قطع صيانة لكل السلاسل',
     'پارچەی چاککردنەوە بۆ هەموو زنجیرەکان', 'devices', 0, 7),
    ('bundles', 'cat_accessories', 'bundles-kits', 'Bundles & kits', 'الحزم والمجموعات', 'کۆمەڵە و پاکێجەکان', 'materials', 0, 90),
]

# Existing seeded leaves this map uses (repo seeds 0018 / 0102 / 0148; names as seeded — never renamed by the import)
EXISTING = {
    'cat_printers_fdm': ('FDM Printers', 'طابعات FDM', 'چاپکەری FDM'),
    'cat_laser_machines': ('Laser Machines', 'ماكينات الليزر', 'ئامێری لەیزەر'),
    'cat_laser_acc': ('Laser Accessories', 'ملحقات الليزر وقطع الصيانة', 'پێداویستی لەیزەر'),
    'cat_maint_hotend': ('Hotends & Nozzles', 'رؤوس الطباعة والفوهات', ''),
    'cat_maint_plate': ('Build Plates', 'ألواح الطباعة', ''),
    'cat_materials_laser': ('Laser Materials', 'مواد الليزر', 'کەرەستەی لەیزەر'),
    'cat_materials_blade': ('Blade Cutting Materials', 'مواد القص بالشفرة', 'کەرەستەی بڕین بە تیغ'),
    'cat_makers_kits': ('Model Kits', 'أطقم المجسمات', 'کیتی مۆدێل'),
    'cat_makers_cyber': ('CyberBrick RC', 'CyberBrick RC', 'CyberBrick RC'),
    'cat_makers_tools': ('Maker Tools', 'أدوات Maker', 'ئامرازی Maker'),
    'cat_makers_hw': ('Hardware Parts', 'قطع هاردوير', 'پارچەی هاردوێر'),
    'cat_makers_elec': ('Electronics', 'إلكترونيات', 'ئەلیکترۆنیات'),
    'cat_makers_other': ('Others', 'أخرى', 'ئەوانی تر'),
    'cat_makers_combo': ('Maker Combo Kits', 'باقات Maker', 'کۆمبۆی Maker'),
    'cat_laser': ('Laser Crafting', 'أجهزة الليزر', 'دروستکردن بە لەیزەر'),
}
EXISTING_PARENT = {'cat_printers_fdm': 'cat_printers', 'cat_laser_machines': 'cat_laser', 'cat_laser_acc': 'cat_laser',
                   'cat_maint_hotend': 'cat_maint', 'cat_maint_plate': 'cat_maint', 'cat_materials_laser': 'cat_materials',
                   'cat_materials_blade': 'cat_materials', 'cat_makers_kits': 'cat_makers', 'cat_makers_cyber': 'cat_makers',
                   'cat_makers_tools': 'cat_makers', 'cat_makers_hw': 'cat_makers', 'cat_makers_elec': 'cat_makers',
                   'cat_makers_other': 'cat_makers', 'cat_makers_combo': 'cat_makers', 'cat_laser': None}

LEAF_TYPE = {
    'cat_printers_fdm': 'printer', '@printers-refurb': 'printer', '@ams': 'ams', 'cat_laser_machines': 'laser_machine',
    '@pla': 'filament', '@petg': 'filament', '@abs-asa': 'filament', '@tpu': 'filament', '@pc': 'filament',
    '@engineering': 'filament', '@support': 'filament', '@filament-packs': 'filament', '@filament-acc': 'accessory',
    'cat_maint_hotend': 'hotend', 'cat_maint_plate': 'build_plate', '@printer-acc': 'accessory', 'cat_laser_acc': 'accessory',
    'cat_makers_tools': 'accessory',
    '@parts-x1p1': 'spare_part', '@parts-a1': 'spare_part', '@parts-h2': 'spare_part', '@parts-p2x2': 'spare_part',
    '@parts-ams': 'spare_part', '@parts-laser': 'spare_part', '@parts-common': 'spare_part',
    'cat_materials_laser': 'laser_material', 'cat_materials_blade': 'laser_material',
    'cat_makers_kits': 'makers_supply', 'cat_makers_cyber': 'makers_supply', 'cat_makers_hw': 'makers_supply',
    'cat_makers_elec': 'makers_supply', 'cat_makers_other': 'makers_supply', 'cat_makers_combo': 'makers_supply',
}

# Route prefixes -> leaf (deepest prefix wins). Filled for every L2 the crawl shows; L3 entries where L3 differs.
FILAMENT_L2 = {
    '552709755857096704': '@pla', '552709756440104960': '@petg', '552709756595294208': '@abs-asa', '552709756700151808': '@abs-asa',
    '552709756834369536': '@pc', '552709756939227136': '@tpu', '552709757065056256': '@engineering', '552709757257994240': '@engineering',
    '552709757316714496': '@engineering', '552709757392211968': '@support', '552709757576761344': '@filament-packs',
    '552709757610315776': '@filament-acc',
}
MAKERS_L2 = {
    '552709760911233024': 'cat_makers_kits', '552709760948981760': 'cat_makers_kits', '552709760978341888': 'cat_makers_combo',
    '552709761007702016': 'cat_makers_hw', '552709761460686848': 'cat_makers_elec', '552709761666207744': 'cat_makers_other',
    '591521224512909312': 'cat_makers_cyber',
}
LASERMAT_L2_BLADE = {'578428646415355904', '578429003299885056'}   # vinyl & decal sheets; transfer/masking tape + heat press
ACC_L2 = {
    '552709757794865152': 'cat_maint_plate', '552709757979414528': 'cat_maint_hotend', '750510267545833472': 'cat_makers_tools',
}
ACC_L3 = {'552709758193324032': '@ams'}

# Reviewed per-handle leaves where the route default contradicts the product's own page (§D.2 rule 7: each cites the page).
# handle -> (leaf, quote_kind, quote). The quote must be found on that page (tools/verify.py checks it).
REVIEWED_LEAF = {
    # Printer vibration-isolation feet filed by route beside pliers and screwdrivers (cat_makers_tools); the page sells them
    # per printer model, and the similar anti-vibration-feet are already in @printer-acc.
    'floating-damper-feet': ('@printer-acc', 'option_value', 'Printer Model: X1 Series / P1 Series'),
    # A heat-press appliance filed by route under blade-cutting MATERIALS beside transfer and masking tape; it is a tool for
    # heat-transfer (cut vinyl) projects, so it goes to the cutting/laser accessories leaf with type accessory.
    'mini-heat-press': ('cat_laser_acc', 'description_text',
                        'Unlock endless DIY possibilities with three precision heat levels, tailored for unusually small or unique projects.'),
}

# The four FDM printer families a "parts for all series" item must cover (laser parts are their own leaf).
FDM_FAMILIES = {'x1p1', 'a', 'h2', 'p2x2'}

FAMILY_LEAF = {'x1p1': '@parts-x1p1', 'a': '@parts-a1', 'h2': '@parts-h2', 'p2x2': '@parts-p2x2', 'ams': '@parts-ams',
               'laser': '@parts-laser', 'common': '@parts-common'}

FAM_RX = [
    ('laser', re.compile(r'\bR1\b')),
    ('p2x2', re.compile(r'\bP2S?\b|\bX2D?\b|\bP2 Series|\bX2 Series|\bX2/P2|\bX2 / A2', re.I)),
    ('h2', re.compile(r'\bH2[DSC]?\b|\bH2 Series|\bH2 /|\bH2D Pro', re.I)),
    ('a', re.compile(r'\bA1\b|\bA1 mini\b|\bA2L?\b|\bA1 Series|\bA2 Series|\bA1&A2', re.I)),
    ('x1p1', re.compile(r'\bX1[CE]?\b|\bP1[PS]?\b|\bX1 Series|\bP1 Series|X1/P1', re.I)),
    ('ams', re.compile(r'\bAMS\b', re.I)),
    ('common', re.compile(r'\bAll Series\b', re.I)),
]


def families(labels):
    fams = set()
    for l in labels:
        for f, rx in FAM_RX:
            if rx.search(l):
                fams.add(f)
    return fams


def families_in_order(labels):
    """Families in the order the evidence names them (first label first, left to right inside a label)."""
    out = []
    for l in labels:
        found = []
        for f, rx in FAM_RX:
            m = rx.search(l)
            if m:
                found.append((m.start(), f))
        for _, f in sorted(found):
            if f not in out:
                out.append(f)
    return out


PART_WORDS = re.compile(r'board|cable|fan|motor|belt|housing|cover|panel|sensor|screen|camera|assembly|heater|thermistor|wiper|unit\b|'
                        r'connector|antenna|led|lidar|frame|carriage|pulley|bearing|rail|screw|spring|lever|stopper|buffer|power supply|'
                        r'heatbed|tube|footpad|glass|door|cutter|seal|hub\b|shaft|pad\b|lining|organizer|brush|extruder|toolhead|holder|'
                        r'coupler|tensioner|chain|chute|switch|cap\b|base housing|end cap|block|frame|inner|gear|nozzle wiper|'
                        r'spool holder|plug|clamp|mirror|lens|pump|shell|slat|curtain|hose|feet|tray|strut|lid|harness|key\b|'
                        r'encoder|flow blocker|latch|actuator|dock\b|rack\b', re.I)
BUNDLE_RX = re.compile(r'\b(bundle|combo|starter kit|starter pack|trial set|trial kit|mystery box)\b', re.I)
