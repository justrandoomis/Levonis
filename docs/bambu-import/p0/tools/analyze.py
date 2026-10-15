"""Per-product facts for P0 (stdlib only). analyze_all() -> list of recs with rec['f'] filled."""
import collections, re, urllib.parse
import dom
import registry
import taxonomy as T
import compat as C
import sentences as SC
from p0lib import (H, nfc, load_all, binding, group_kind, all_links, all_text_blobs, classify_link, availability_from_name,
                   spec_tables, REGION_RX, composite, index_tokens, fname)

AUDIT = [  # §I.4 class -> handles (from the fixtures)
    ('printer_standard_combo', ['h2d']),
    ('multi_colour_filament_refill_spool', ['pla-basic-filament']),
    ('hotend_multiple_nozzle_sizes', ['bambu-hotend-a1-a2']),
    ('ams_units_and_spare_parts', ['ams-2-pro', 'ams-2-pro-feeder-unit']),
    ('build_plate_multiple_compat', ['bambu-textured-pei-plate']),
    ('makers_supply_kit_or_electronic', ['wireless-charger-kit-k012']),
    ('product_in_more_than_one_category', ['h2d']),
    ('sold_out_at_supplier', ['refurbished-bambu-lab-h2d-3d-printer']),
]
CANARY = 'filament-buffer'
TYPE_ORDER = ['printer', 'ams', 'laser_machine', 'filament', 'hotend', 'build_plate', 'accessory', 'spare_part', 'laser_material', 'makers_supply']


def title_suffix(t):
    m = re.search(r'\s-\s*([^-]+)$', t)
    return m.group(1).strip() if m else ''


def leaf_for(f):
    """-> (leaf, reason/evidence quote, evidence kind)"""
    if f['handle'] in T.REVIEWED_LEAF:
        leaf, kind, quote = T.REVIEWED_LEAF[f['handle']]
        return leaf, (kind, quote)
    rt = f['route'].split('>')
    l1, l2, l3 = rt[0], (rt[1] if len(rt) > 1 else ''), (rt[2] if len(rt) > 2 else '')
    title = f['title']
    if l1 == T.L1['printers']:
        if l2 == '552709755685130240':
            return '@ams', None
        if title.lower().startswith('[refurbished]'):
            return '@printers-refurb', ('title', title)
        return 'cat_printers_fdm', None
    if l1 == T.L1['laser_machines']:
        return 'cat_laser_machines', None
    if l1 == T.L1['filament']:
        return T.FILAMENT_L2[l2], None
    if l1 == T.L1['makers']:
        return T.MAKERS_L2[l2], None
    if l1 == T.L1['laser_materials']:
        if l2 in T.LASERMAT_L2_BLADE:
            return 'cat_materials_blade', None
        if re.search(r'cutting material kit', title, re.I):
            return 'cat_materials_blade', ('title', title)
        return 'cat_materials_laser', None
    fam_labels = [x[0] for x in f['compat_raw']]
    suffix = title_suffix(title)
    if suffix:
        fam_labels = fam_labels + [suffix]
    fams = T.families(fam_labels)
    ev = None
    for raw, rel, kind, scope, quote in f['compat_raw']:
        if kind == 'option_value' or kind == 'compat_section':
            ev = (kind, quote)
            break
    if not ev and suffix:
        ev = ('title', title)
    if l1 == T.L1['accessories']:
        if l3 in T.ACC_L3:
            return T.ACC_L3[l3], None
        if l2 in T.ACC_L2:
            return T.ACC_L2[l2], None
        # accessories outside the plate/hotend/tools/AMS-hub routes: evidence per product
        t = title.lower()
        if 'plate' in t and 'combo' in t:
            return 'cat_maint_plate', ('title', title)
        if re.search(r'hotends? (combo|kit|expansion)|multi-size hotends|high-flow kit|hotend expansion', t):
            return 'cat_maint_hotend', ('title', title)
        if fams == {'laser'}:
            return 'cat_laser_acc', ev or ('title', title)
        if fams == {'ams'} or t.startswith('ams ') or t.startswith('ams/'):
            return '@ams', ev or ('title', title)
        if re.search(r'accessory box|glue|lubricant|desiccant|maintenance kit|exhaust|track switch|feed assist|upgrade kit|'
                     r'cleaning pad', t) and not re.search(r'laser|cutting', t):
            return '@printer-acc', ev or ('title', title)
        pf = fams - {'ams', 'common'}
        if not l2 and len(pf) == 1 and T.PART_WORDS.search(title):
            return T.FAMILY_LEAF[next(iter(pf))], ev
        if (re.search(r'\((laser|cutting)|\bH2 Laser\b', ' '.join(fam_labels), re.I)
                or re.search(r'\blaser\b|\bcutting\b|blade|material pins?|purifier', t)):
            return 'cat_laser_acc', ev or ('title', title)
        return '@printer-acc', ev or ('title', title)
    if l1 == T.L1['spare_parts']:
        if l2 == '581730574607491072':
            return '@parts-ams', None
        if l2 == '581727459719290880':
            return '@parts-h2', None
        t = title.lower()
        if t.startswith('ams') or (fams == {'ams'}):
            return '@parts-ams', ev or ('title', title)
        if 'common' in fams:
            return '@parts-common', ev
        pf = fams - {'ams', 'common'}
        if len(pf) == 1:
            return T.FAMILY_LEAF[next(iter(pf))], ev
        if len(pf) >= 2:
            # «قطع صيانة لكل السلاسل» only for a part that fits every FDM family. A part that names some families goes to the
            # first family it names; the others become secondary memberships with the same quote (analyze_all).
            if pf >= T.FDM_FAMILIES:
                return '@parts-common', ev
            first = next(x for x in T.families_in_order(fam_labels) if x in pf)
            return T.FAMILY_LEAF[first], ev
        if 'ams' in fams:
            return '@parts-ams', ev
        return '@parts-common', ev or ('title', title)
    raise ValueError('unmapped L1 %s' % l1)


def analyze_all():
    recs = load_all()
    for rec in recs:
        P, r = rec['P'], rec['r']
        f = {}
        rec['f'] = f
        f['id'] = P['id']
        f['seoCode'] = P['seoCode']
        f['handle'] = nfc(urllib.parse.unquote(P['seoCode'] or ''))
        f['title'] = re.sub(r'\s+', ' ', P['name'] or '').strip()
        f['canonical_url'] = P['seoUrlHandle']
        f['route'] = P['currentAllIdRoute']
        f['desc_kind'] = r['desc_kind']
        kinds = [group_kind(g) for g in P['options']]
        f['group_kinds'] = kinds
        f['G'] = len(P['options'])
        f['V'] = sum(len(g['values']) for g in P['options'])
        f['N'] = len(P['skus'])
        f['gallery'] = len(P['mediaFiles'])
        f['compat_raw'] = C.raw_labels(rec, kinds)
        leaf, ev = leaf_for(f)
        f['leaf'] = leaf
        f['leaf_evidence'] = ev
        # type / subtype
        typ = T.LEAF_TYPE[leaf]
        sub = ''
        if leaf == '@ams':
            if f['route'].startswith('552709755391528960>552709755685130240'):
                typ, sub = 'ams', 'ams_unit'
            else:
                typ, sub = 'accessory', 'ams_accessory'
        if typ == 'printer':
            sub = 'refurbished' if leaf == '@printers-refurb' else ('starter_kit' if 'starter kit' in f['title'].lower() else 'printer')
        if leaf == '@filament-packs':
            sub = 'pack'
        f['type'] = typ
        f['subtype'] = sub
        # secondary memberships with evidence
        also = []
        if leaf in ('@pla', '@petg', '@abs-asa', '@pc', '@tpu', '@engineering') and re.search(r'-(CF|GF)\b|\b(CF|GF)\b', f['title']):
            also.append(('@fiber', 'route', f['route']))
        if T.BUNDLE_RX.search(f['title']) and typ not in ('spare_part',):
            also.append(('@bundles', 'title', f['title']))
        if typ == 'printer' and sub != 'refurbished':
            for g in P['options']:
                for v in g['values']:
                    if re.search(r'\blaser\b.*\bcombo\b', v['value'], re.I):
                        also.append(('cat_laser_machines', 'option_value', '%s: %s' % (g['propertyKey'].strip(), v['value'].strip())))
                        break
                else:
                    continue
                break
        # a spare part filed under one printer family's leaf that names other (not all) FDM families: secondary memberships
        fam_of_leaf = {v: k for k, v in T.FAMILY_LEAF.items()}
        if typ == 'spare_part' and leaf in fam_of_leaf and fam_of_leaf[leaf] not in ('ams', 'common'):
            labels = [x[0] for x in f['compat_raw']] + ([title_suffix(f['title'])] if title_suffix(f['title']) else [])
            pf = T.families(labels) - {'ams', 'common'}
            if len(pf) >= 2 and not pf >= T.FDM_FAMILIES:
                for other in T.families_in_order(labels):
                    if other not in pf or other == fam_of_leaf[leaf]:
                        continue
                    q = next(((k, qt) for raw, rel, k, sc, qt in f['compat_raw'] if T.families([raw]) & {other} and k in ('option_value', 'compat_section')),
                             ('title', f['title']))
                    also.append((T.FAMILY_LEAF[other], q[0], q[1]))
        f['also'] = also
        # binding & media
        b = binding(P, kinds)
        f['binding'] = b
        f['image_rows'] = b['rows']
        f['swatches'] = sum(1 for g, k in zip(P['options'], kinds) if k == 'color' for v in g['values'] if v['colorUrl'])
        # links
        links = all_links(rec)
        f['links'] = links
        cls = collections.defaultdict(list)
        for where, u, txt in links:
            cls[classify_link(u)].append((where, u, txt))
        f['link_classes'] = cls
        # in the box images
        box_imgs = set()
        box_items = 0
        for s in r['sections']:
            if s['kind'] == 'in_the_box':
                for im in s['images']:
                    box_imgs.add(im['url'])
                for bi in s['box_items']:
                    box_items += 1
                    if bi.get('image'):
                        box_imgs.add(bi['image'])
        for w in (r.get('desc_extra') or {}).get('witb') or []:
            box_items += 1
            if w.get('image'):
                box_imgs.add(w['image'])
        f['box_images'] = sorted(box_imgs)
        f['box_items'] = box_items
        # description images (content blocks, capped 40)
        desc_imgs = set()
        text_blocks = 0
        for s in r['sections']:
            if s['kind'] in ('in_the_box', 'specs'):
                continue
            for im in s['images']:
                desc_imgs.add(im['url'])
            if s['text']:
                text_blocks += 1
        f['desc_images'] = len(desc_imgs)
        f['text_blocks'] = text_blocks + (1 if P['features_html'] else 0)
        f['usage_steps'] = sum(1 for s in r['sections'] if s['kind'] == 'instructions')
        # specs
        spec_rows = []
        matrices = []
        for title, t, ps, matrix in spec_tables(rec):
            if matrix:
                matrices.append({'section': title, 'rows': len(t)})
                continue
            for p in ps:
                spec_rows.append(p)
        f['spec_rows'] = spec_rows
        f['spec_matrices'] = matrices
        # region / composite
        version_values = [v['value'] for g, k in zip(P['options'], kinds) if k == 'version' for v in g['values']]
        model_tok = re.sub(r'^Bambu Lab\s+|\s+3D Printer$', '', f['title']).strip()
        version_values += [re.sub(re.escape(model_tok) + r'\s*', '', v).strip() for v in version_values if model_tok]
        comps = []
        for p in spec_rows:
            segs = composite(p['value'], version_values)
            if segs:
                comps.append({'label': p['label'], 'segments': len(segs), 'locator': p['locator'], 'excerpt': p['value'][:200]})
        f['composites'] = comps
        reg = []
        for where, t in all_text_blobs(rec):
            for m in REGION_RX.finditer(t):
                reg.append({'where': where[:60], 'match': m.group(0)[:60]})
        f['region_hits'] = reg
        # order-type words
        f['order_type_hits'] = [{'group': g['propertyKey'].strip(), 'value': v['value'].strip(), 'reads_as': availability_from_name(v['value'])}
                                for g in P['options'] for v in g['values'] if availability_from_name(v['value'])]
        # source strings copied verbatim into customer-text payload fields that payload.ts would refuse (refused_text):
        # title_en, groups[].name_en/source_label, values[].name_en/variant_label/source_label. Ids and class only, no text.
        rt_hits = []
        c = SC.text_refusal(f['title'])
        if c:
            rt_hits.append({'field': '$.product.title_en', 'class': c})
        for gi, g in enumerate(sorted(P['options'], key=lambda g: g.get('position') or 0)):
            c = SC.text_refusal(re.sub(r'\s+', ' ', g['propertyKey']).strip())
            if c:
                rt_hits.append({'field': '$.groups[%d].source_label' % gi, 'group_source_id': g['propertyKeyId'], 'class': c})
            for vi, v in enumerate(g['values']):
                c = SC.text_refusal(v['value'].strip())
                if c:
                    rt_hits.append({'field': '$.groups[%d].values[%d].name_en' % (gi, vi), 'group_source_id': g['propertyKeyId'],
                                    'value_source_id': v['id'], 'class': c})
        f['refused_text_hits'] = rt_hits
        rec['f'] = f
    return recs
