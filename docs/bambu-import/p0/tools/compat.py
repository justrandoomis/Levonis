"""P0 compatibility labels: extraction (§B.6 evidence kinds), atomisation and the reviewed target table."""
import re
import dom

COMPAT_GROUP_RX = re.compile(r'^(compatibility|compatible|printer model|select the type of printer|select your printer series)', re.I)
COMPAT_SECTION_TITLES = {'compatibility', 'compatible', 'compatibility:'}
BULLET_RX = re.compile(r'^(?P<body>.+?)\s+(?P<neg>not\s+)?compatible(?P<tail>,.*)?\.?$', re.I)
MODEL_HINT = re.compile(r'\b(A1|A2L?|P1[PS]?|P2S?|X1[CE]?|X2D?|H2[DSC]?|H Series|R1|AMS|All Series|Rotary Attachment|Smoke Purifier)\b', re.I)
SKIP_LINES = re.compile(r'^(in the box|product specifications?|compatibility|-\s|\*|\d+\.|\[)', re.I)


def raw_labels(rec, group_kind):
    """[(raw label, relation, evidence_kind, scope, quote)]"""
    P, r = rec['P'], rec['r']
    out = []
    for g in P['options']:
        key = re.sub(r'\s+', ' ', g['propertyKey']).strip()
        if COMPAT_GROUP_RX.match(key):
            for v in g['values']:
                val = v['value'].strip()
                out.append((val, 'compatible_with', 'option_value', 'option_value:' + v['id'], '%s: %s' % (key[:60], val)))
    for s in r['sections']:
        if s['kind'] == 'compat' and s['title'].strip().lower() in COMPAT_SECTION_TITLES:
            for t in s['text']:
                for line in t.split('\n'):
                    line = line.strip()
                    if not line or len(line) > 100 or SKIP_LINES.match(line) or not MODEL_HINT.search(line):
                        continue
                    out.append((line, 'compatible_with', 'compat_section', 'product', line))
    for h in P['features_html']:
        for line in dom.text_of(dom.from_html(h)).split('\n'):
            line = line.strip()
            if len(line) > 80:
                continue
            m = BULLET_RX.match(line)
            if m and len(m.group('body')) <= 60 and not re.search(r'\b(with|is|are|and is|but)\b.*\b(with|is|are)\b', m.group('body'), re.I):
                rel = 'not_compatible_with' if m.group('neg') else 'compatible_with'
                out.append((m.group('body').strip(), rel, 'feature_bullet', 'product', line))
    return out


BARE = re.compile(r'^(X1|P1|A1|H2|X2|P2|A2)$', re.I)


def atomize(raw):
    s = raw.strip()
    neg = []
    m = re.search(r'\(not for ([^)]+)\)', s, re.I)
    if m:
        neg = [x.strip() for x in re.split(r'/|,| and ', m.group(1)) if x.strip()]
        s = (s[:m.start()] + s[m.end():]).strip()
    s = re.sub(r'^(for|works with)\s+(bambu\s+(lab\s+)?)?', '', s, flags=re.I)
    s = re.sub(r'\s+(exclusive|only)$', '', s, flags=re.I)
    s = re.sub(r'(\S)\(', r'\1 (', s)             # 'H2 Series(Laser)' -> 'H2 Series (Laser)'
    prot = {}

    def keep(mm):
        k = '\x00%d\x00' % len(prot)
        prot[k] = mm.group(0)
        return k
    s2 = re.sub(r'\([^)]*\)', keep, s)
    if re.match(r'^X1/P1 Non-Combo Printers$', s, re.I):
        parts = [s]
    else:
        parts = [p for p in re.split(r'\s*(?:/|,|&|\band\b)\s*', s2) if p.strip()]
    parts = [re.sub(r'\x00\d+\x00', lambda mm: prot[mm.group(0)], p).strip() for p in parts]
    if len(parts) >= 2 and ('/' in raw or '&' in raw):
        parts = [p + ' Series' if BARE.match(p) else p for p in parts]
    parts = [re.sub(r'\s+', ' ', p) for p in parts]
    return parts, neg


# ---- the reviewed target table (atom -> target). Members named by manifest handle, or an existing Levonis printer that
#      the step-2 sealed snapshot must resolve (X1C/X1E/P1P/P1S/X1 are discontinued and absent from the sitemap).
LEV = lambda model: {'levonis_model': model, 'levonis_product_id': None, 'resolve_from': 'step2_snapshot'}  # noqa: E731
SRC = lambda h: {'source_handle': h}  # noqa: E731

NEW_PRINTERS = ['a1', 'a1-mini', 'a2l', 'p1s', 'p2s', 'x2d', 'h2d', 'h2d-pro', 'h2s', 'h2c']
REFURB = {'a1': 'refurbished-a1', 'p1s': 'refurbished-p1s', 'p2s': 'refurbished-bambu-lab-p2s-3d-printer',
          'h2d': 'refurbished-bambu-lab-h2d-3d-printer', 'x1c': 'refurbished-x1c'}


def model_family(h):
    m = [SRC(h)]
    if h in REFURB:
        m.append(SRC(REFURB[h]))
    return m


TARGETS = {
    # printers (a model and its factory-refurbished twin, which is the same model)
    'A1': ('family', 'model_a1', model_family('a1'), 'same_model_incl_refurbished'),
    'A1 mini': ('printer', None, [SRC('a1-mini')], 'same_model'),
    'A2L': ('printer', None, [SRC('a2l')], 'same_model'),
    'P1S': ('family', 'model_p1s', model_family('p1s') + [LEV('P1S')], 'same_model_incl_refurbished'),
    'P1P': ('printer', None, [LEV('P1P')], 'levonis_existing_model'),
    'P2S': ('family', 'model_p2s', model_family('p2s'), 'same_model_incl_refurbished'),
    'X2D': ('printer', None, [SRC('x2d')], 'same_model'),
    'H2D': ('family', 'model_h2d', model_family('h2d'), 'same_model_incl_refurbished'),
    'H2D Pro': ('printer', None, [SRC('h2d-pro')], 'same_model'),
    'H2S': ('printer', None, [SRC('h2s')], 'same_model'),
    'H2C': ('printer', None, [SRC('h2c')], 'same_model'),
    'R1': ('printer', None, [SRC('r1')], 'same_model'),
    'X1C': ('family', 'model_x1c', [SRC('refurbished-x1c'), LEV('X1C')], 'same_model_incl_refurbished'),
    'X1E': ('printer', None, [LEV('X1E')], 'levonis_existing_model'),
    'X1': ('printer', None, [LEV('X1')], 'levonis_existing_model'),
    # qualified printers: the qualifier stays in target_label; the target is the model
    'H2D Laser': ('printer', None, [SRC('h2d')], 'same_model_qualified'),
    'H2S Laser': ('printer', None, [SRC('h2s')], 'same_model_qualified'),
    'H2C Laser': ('printer', None, [SRC('h2c')], 'same_model_qualified'),
    'H2C (Right Hotend)': ('printer', None, [SRC('h2c')], 'same_model_qualified'),
    'H2C (Left Hotend)': ('printer', None, [SRC('h2c')], 'same_model_qualified'),
    'H2C (Left)': ('printer', None, [SRC('h2c')], 'same_model_qualified'),
    'X2D (Left)': ('printer', None, [SRC('x2d')], 'same_model_qualified'),
    'X2D (Right)': ('printer', None, [SRC('x2d')], 'same_model_qualified'),
    'H2D/H2S/H2C (Left Hotend)': ('family', 'h2_series_left', [SRC('h2d'), SRC('h2s'), SRC('h2c')], 'family_members_qualified'),
    # families
    'X1 Series': ('family', 'x1_series', [SRC('refurbished-x1c'), LEV('X1C'), LEV('X1E')], 'family_members_in_levonis'),
    'P1 Series': ('family', 'p1_series', model_family('p1s') + [LEV('P1S'), LEV('P1P')], 'family_members_in_levonis'),
    'A1 Series': ('family', 'a1_series', model_family('a1'), 'family_members_narrow_default'),
    'A2 Series': ('family', 'a2_series', [SRC('a2l')], 'family_members_by_source'),
    'H2 Series': ('family', 'h2_series', [SRC('h2d'), SRC('h2d-pro'), SRC('h2s'), SRC('h2c'), SRC(REFURB['h2d'])], 'family_members_by_source'),
    'H Series': ('family', 'h2_series', [SRC('h2d'), SRC('h2d-pro'), SRC('h2s'), SRC('h2c'), SRC(REFURB['h2d'])], 'family_alias'),
    'P2 Series': ('family', 'p2_series', model_family('p2s'), 'family_members_by_source'),
    'X2 Series': ('family', 'x2_series', [SRC('x2d')], 'family_members_by_source'),
    'H2 Series (Laser)': ('family', 'h2_series_laser', [SRC('h2d'), SRC('h2s'), SRC('h2c')], 'family_members_qualified'),
    'H2 Laser': ('family', 'h2_series_laser', [SRC('h2d'), SRC('h2s'), SRC('h2c')], 'family_alias'),
    'H2 Series (Cutting)': ('family', 'h2_series_cutting', [SRC('h2d'), SRC('h2s'), SRC('h2c')], 'family_members_qualified'),
    'H2 Series (Laser & Cutting)': ('family', 'h2_series_laser_cutting', [SRC('h2d'), SRC('h2s'), SRC('h2c')], 'family_members_qualified'),
    'X1/P1 Non-Combo Printers': ('family', 'x1_p1_non_combo', [SRC('refurbished-x1c'), LEV('X1C'), LEV('X1E')] + model_family('p1s') + [LEV('P1P')],
                                 'family_members_qualified'),
    'All Series': ('family', 'all_bambu_printers', [SRC(h) for h in NEW_PRINTERS] + [SRC(v) for v in REFURB.values()] +
                   [LEV('X1C'), LEV('X1E'), LEV('P1P')], 'family_all_by_source'),
    # AMS family, hub, buffer
    'AMS': ('ams', None, [SRC('ams-multicolor-printing')], 'same_model'),
    'AMS lite': ('ams', None, [SRC('ams-lite')], 'same_model'),
    'AMS 2 Pro': ('ams', None, [SRC('ams-2-pro')], 'same_model'),
    'AMS HT': ('ams', None, [SRC('ams-ht')], 'same_model'),
    'All AMS Series': ('family', 'ams_series', [SRC('ams-multicolor-printing'), SRC('ams-lite'), SRC('ams-2-pro'), SRC('ams-ht')], 'family_members_by_source'),
    # other targets
    'Rotary Attachment': ('part', None, [SRC('rotary-attachment')], 'same_model'),
    'Smoke Purifier': ('other', None, [SRC('smoke-purifier')], 'same_model'),
}
ALIASES = {'Bambu Lab Rotary Attachment': 'Rotary Attachment', 'Bambu Lab AMS': 'AMS', 'Bambu AMS': 'AMS', 'A1 mini Exclusive': 'A1 mini'}
UNRESOLVABLE = {
    'CyberBrick Time-lapse Kit - ZK005': 'variant_choice_not_a_target',
    'Expansion Board Only - XA015': 'variant_choice_not_a_target',
    'Ventilation': 'generic_term_not_a_product',
    '0.2 mm Nozzle': 'component_concept_not_a_product',
    '110~240V': 'electrical_rating_not_a_target',
    'Stainless Steel Nozzles': 'component_concept_not_a_product',
    '0.2 mm nozzles': 'component_concept_not_a_product',
}


def resolve_atom(a):
    a2 = ALIASES.get(a, a)
    for k in TARGETS:
        if k.lower() == a2.lower():
            return k
    for k in UNRESOLVABLE:
        if k.lower() == a2.lower():
            return None
    return None


# ---- reviewed compound atoms: where the generic "bare token -> '<token> Series'" rule (X1/P1 -> X1 Series, P1 Series) is wrong.
#      'A1/A2L' names the A1 model, not the A1 Series: the same pages' Compatibility section reads "A1, A2L" (atoms A1, A2L), and the
#      A1 mini has its own versions of these parts (touch-screen-a1-mini, heatbed-nozzle-wiper-a1-mini).
COMPOUND_ATOMS = {
    'A1/A2L': (['A1', 'A2L'], [{'handle': 'touch-screen-a1-a2l', 'evidence_kind': 'compat_section', 'quote': 'A1, A2L'},
                               {'handle': 'touch-screen-a1-mini', 'evidence_kind': 'title', 'quote': 'Touch Screen - A1 mini'},
                               {'handle': 'heatbed-nozzle-wiper-a1-mini', 'evidence_kind': 'title', 'quote': 'Heatbed Nozzle Wiper - A1 mini'}]),
}

# ---- "A1 Series" is resolved PER SUBJECT (the product whose page names it). Bambu uses the label two ways:
#      * the printer family incl. the A1 mini on shared toolhead parts: toolhead-board-a1-mini's Compatibility values are "A1" and
#        "A1 mini" under a section reading "A1 Series"; printer-maintenance-kit's section "For A1 Series" lists "For A1" and
#        "For A1 mini"; the "… - A1 Series" toolhead parts link their install guide under wiki.bambulab.com/en/a1-mini/;
#        the step-4 registry (registry/models.ts) puts the A1 mini in series 'A1 Series';
#      * the A1 alone where the A1 mini cannot be meant: the a1-mini page says "AMS is incompatible with the A1 mini. If you want
#        a multi-color print using A1 mini, you must use the AMS lite.", yet AMS, AMS 2 Pro and AMS HT offer "A1 Series" as a
#        printer choice; and where the same page or a sibling product names the A1 mini separately.
#      A subject with no evidence either way keeps the narrow default (A1 + refurbished A1) and is listed for the owner (P0-1).
A1_MINI_ON_A1_MINI_PAGE = {'handle': 'a1-mini', 'evidence_kind': 'description_text',
                           'quote': 'AMS is incompatible with the A1 mini. If you want a multi-color print using A1 mini, you must use the AMS lite.'}
# Bambu's own usage, recorded on the label (not a subject of the label: its options name A1 and A1 mini separately)
A1_SERIES_USAGE = [{'handle': 'printer-maintenance-kit', 'evidence_kind': 'section_title', 'quote': 'For A1 Series', 'section_lines': ['For A1', 'For A1 mini']},
                   {'handle': 'toolhead-board-a1-mini', 'evidence_kind': 'compat_section', 'quote': 'A1 Series'},
                   {'handle': 'a1-mini', 'evidence_kind': 'description_text',
                    'quote': 'AMS is incompatible with the A1 mini. If you want a multi-color print using A1 mini, you must use the AMS lite.'},
                   {'handle': 'a1', 'evidence_kind': 'variant_note',
                    'quote': 'To connect AMS 2 Pro unit(s) to A1 series printer, an A1 series AMS Hub (SA013) is required.'}]


def _wiki(h, path):
    return {'handle': h, 'evidence_kind': 'wiki_link', 'quote': 'https://wiki.bambulab.com' + path}


A1_SERIES_BY_SUBJECT = {
    # --- includes the A1 mini
    'toolhead-board-a1-mini': ('includes_a1_mini', [{'handle': 'toolhead-board-a1-mini', 'evidence_kind': 'option_value', 'quote': 'Compatibility: A1 mini'},
                                                   {'handle': 'toolhead-board-a1-mini', 'evidence_kind': 'compat_section', 'quote': 'A1 Series'}]),
    'bambu-hotend-a1-a2': ('includes_a1_mini', [{'handle': 'bambu-hotend-a1-a2', 'evidence_kind': 'option_value', 'quote': 'Printer Model: A1 mini'},
                                               _wiki('bambu-hotend-a1-a2', '/en/a1-mini/maintenance/toolhead')]),
    'ams-lite': ('includes_a1_mini', [A1_MINI_ON_A1_MINI_PAGE, {'handle': 'ams-lite', 'evidence_kind': 'option_value', 'quote': 'Compatibility: A1&A2 Series'}]),
    'replacement-filament-cutter': ('includes_a1_mini', [_wiki('replacement-filament-cutter', '/en/a1-mini/maintenance/filament-cutter-replacement')]),
    'extruder-unit-a1-series': ('includes_a1_mini', [_wiki('extruder-unit-a1-series', '/en/a1-mini/maintenance/extruder-replacement-guide')]),
    'filament-cutter-lever-a1-series': ('includes_a1_mini', [_wiki('filament-cutter-lever-a1-series', '/en/a1-mini/maintenance/a1-extruder')]),
    'filament-sensor-base-a1-series': ('includes_a1_mini', [_wiki('filament-sensor-base-a1-series', '/en/a1-mini/maintenance/filament-sensor-base-replacement')]),
    'hardened-steel-extruder-gear-assembly-a1-series': ('includes_a1_mini', [_wiki('hardened-steel-extruder-gear-assembly-a1-series', '/en/a1-mini/maintenance/a1-extruder')]),
    'hotend-cooling-fan-a1-series': ('includes_a1_mini', [_wiki('hotend-cooling-fan-a1-series', '/en/a1-mini/maintenance/hotend-cooling-fan')]),
    'hotend-heating-assembly-a1-series': ('includes_a1_mini', [_wiki('hotend-heating-assembly-a1-series', '/en/a1-mini/maintenance/hotend-heating-assembly-replacement')]),
    'part-cooling-fan-a1-series': ('includes_a1_mini', [_wiki('part-cooling-fan-a1-series', '/en/a1-mini/maintenance/part-cooling-fan')]),
    'print-head-front-cover-a1-series': ('includes_a1_mini', [_wiki('print-head-front-cover-a1-series', '/en/a1-mini/maintenance/toolhead')]),
    'purge-wiper-a1-series': ('includes_a1_mini', [_wiki('purge-wiper-a1-series', '/en/a1-mini/purge-wiper-replacement')]),
    'toolhead-block-a1-series': ('includes_a1_mini', [_wiki('toolhead-block-a1-series', '/en/a1-mini/maintenance/a1-mini-com')]),
    'toolhead-rear-housing-a1-series': ('includes_a1_mini', [_wiki('toolhead-rear-housing-a1-series', '/en/a1-mini/maintenance/toolhead')]),
    # The kit's own "Screws Information" table names A1 mini locations (final pass: it was on the narrow default).
    'screws-kit-a1-series-and-ams-lite': ('includes_a1_mini', [
        {'handle': 'screws-kit-a1-series-and-ams-lite', 'evidence_kind': 'table_text', 'quote': 'A1 mini Heatbed'},
        {'handle': 'screws-kit-a1-series-and-ams-lite', 'evidence_kind': 'table_text', 'quote': 'Bottom Plate of A1& A1 mini'},
        {'handle': 'screws-kit-a1-series-and-ams-lite', 'evidence_kind': 'table_text', 'quote': 'Purge Unit and the A1 mini Z Cover'}]),
    # --- excludes the A1 mini
    'ams-multicolor-printing': ('excludes_a1_mini', [A1_MINI_ON_A1_MINI_PAGE, {'handle': 'ams-multicolor-printing', 'evidence_kind': 'option_value',
                                                                              'quote': 'Select the type of printer you plan to use the AMS: A1 Series'}]),
    'ams-2-pro': ('excludes_a1_mini', [A1_MINI_ON_A1_MINI_PAGE, {'handle': 'ams-2-pro', 'evidence_kind': 'option_value',
                                                                'quote': 'Select the type of printer you plan to use the AMS 2 Pro: A1 Series'}]),
    'ams-ht': ('excludes_a1_mini', [A1_MINI_ON_A1_MINI_PAGE, {'handle': 'ams-ht', 'evidence_kind': 'option_value',
                                                             'quote': 'Select the type of printer you plan to use the AMS HT: A1 Series'}]),
    'ams-hub-a1-series': ('excludes_a1_mini', [A1_MINI_ON_A1_MINI_PAGE, {'handle': 'ams-hub-a1-series', 'evidence_kind': 'description_text',
                                                                        'quote': 'This HUB accessory is specifically designed for A1-series 3D printers, serving as a standardized hub for seamless connectivity and integrated functionality between the AMS, AMS 2 Pro, and AMS HT.'}]),
    # The box sold with the A1 (its own title) holds A1-only items (Supportive Footpad, Stiffener screws); the A1 mini has its own box.
    'accessory-box-for-a1': ('excludes_a1_mini', [{'handle': 'accessory-box-for-a1', 'evidence_kind': 'title', 'quote': 'Accessory Box for A1'},
                                                  {'handle': 'accessory-box-for-a1-mini', 'evidence_kind': 'title', 'quote': 'Accessory Box for A1 mini'}]),
    # "X1/P1/A1 Series": the page's own plate rows size the plate for the A1 (256 mm) and name no A1 mini (final pass: it was
    # on the narrow default; the members do not change, the basis is now page evidence).
    'build-plate-combo': ('excludes_a1_mini', [{'handle': 'build-plate-combo', 'evidence_kind': 'table_text', 'quote': 'X1C/P1P/P1S/A1/P2S/X2D - 256*256mm'},
                                               {'handle': 'build-plate-combo', 'evidence_kind': 'table_text', 'quote': 'X1C/P1P/P1S/A1/P2S/X2D - 315*295*15mm'}]),
    'bambu-3d-effect-plate': ('excludes_a1_mini', [{'handle': 'bambu-3d-effect-plate', 'evidence_kind': 'option_value', 'quote': 'Compatibility: A1 mini'}]),
    '3d-effect-plate-full-combo': ('excludes_a1_mini', [{'handle': '3d-effect-plate-full-combo', 'evidence_kind': 'option_value', 'quote': 'Compatibility: A1 mini'}]),
}
A1_SERIES_MEMBERS = {'includes_a1_mini': model_family('a1') + [SRC('a1-mini')], 'excludes_a1_mini': model_family('a1')}
A1_SERIES_REASON = {'includes_a1_mini': 'family_members_by_subject_evidence_incl_a1_mini', 'excludes_a1_mini': 'family_members_by_subject_evidence_excl_a1_mini'}
