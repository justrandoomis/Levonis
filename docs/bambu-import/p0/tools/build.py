"""P0 step 3 (b)(c)(d)(f): build the reviewed-data DRAFTS from the 1,115 crawled pages. Sandbox only; no network.

Usage: python3 -I tools/build.py      (writes into p0/)
"""
import collections, datetime, hashlib, json, math, os, re, sys, unicodedata
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze as A  # noqa: E402
import compat as C  # noqa: E402
import registry  # noqa: E402
import taxonomy as T  # noqa: E402
import reviewed_values as RV  # noqa: E402
from p0lib import P0, H, index_tokens, normalize_text, fname, nfc  # noqa: E402

NOW = '2026-10-15'
OUT = P0


def jdump(obj, name):
    p = os.path.join(OUT, name)
    with open(p, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    return p


def sha256_file(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


recs = A.analyze_all()
by_handle = {r['f']['handle']: r for r in recs}
by_id = {r['f']['id']: r for r in recs}
leaf_name = {('@' + c[0]): c for c in T.CREATE}

# =====================================================================================  SKU codes (cross-sell harvest)
xs_all = []
for r in recs:
    for x in r['r']['cross_sell']:
        xs_all.append((r['f']['handle'], x))
codes = collections.defaultdict(lambda: collections.defaultdict(set))   # handle -> variant id -> {code}
xs_stats = collections.Counter()
xs_unmatched = collections.Counter()
seen_xs = set()
for page, x in xs_all:
    key = (x['id'], x['seoCode'], x['skuCode'])
    if key in seen_xs:
        xs_stats['duplicate_sightings'] += 1
        continue
    seen_xs.add(key)
    xs_stats['distinct_entries'] += 1
    if not x['skuCode']:
        xs_stats['entries_without_code'] += 1
        continue
    h = nfc(__import__('urllib.parse').parse.unquote(x['seoCode'] or ''))
    tgt = by_handle.get(h)
    if not tgt:
        xs_unmatched['seoCode_not_in_sitemap'] += 1
        continue
    vids = {s['id'] for s in tgt['P']['skus']}
    if x['id'] not in vids:
        xs_unmatched['sku_id_not_a_variant_of_that_handle'] += 1
        continue
    if x['productId'] and x['productId'] != tgt['f']['id']:
        xs_unmatched['productId_mismatch'] += 1
        continue
    codes[h][x['id']].add(x['skuCode'])
sku_conflicts = [{'handle': h, 'variant_id': v, 'codes': sorted(cs)} for h, m in codes.items() for v, cs in m.items() if len(cs) > 1]
sku_codes = {h: {v: sorted(cs)[0] for v, cs in m.items() if len(cs) == 1} for h, m in codes.items()}

# =====================================================================================  compatibility labels
label_seen = collections.defaultdict(lambda: {'count': 0, 'products': set(), 'evidence': []})
compound_seen = collections.defaultdict(lambda: {'count': 0, 'atoms': None, 'neg': None, 'relation': None, 'products': set(), 'evidence': []})
for r in recs:
    f = r['f']
    rel_atoms = set()
    for raw, rel, kind, scope, quote in f['compat_raw']:
        cs = compound_seen[raw]
        atoms, neg = C.atomize(raw)
        if raw in C.TARGETS:
            atoms = [raw]
        if raw in C.COMPOUND_ATOMS:
            atoms = list(C.COMPOUND_ATOMS[raw][0])
        cs['count'] += 1
        cs['atoms'], cs['neg'], cs['relation'] = atoms, neg, rel
        cs['products'].add(f['handle'])
        if len(cs['evidence']) < 3:
            cs['evidence'].append({'handle': f['handle'], 'evidence_kind': kind, 'quote': quote[:200]})
        for a in atoms:
            ls = label_seen[a]
            ls['count'] += 1
            ls['products'].add(f['handle'])
            if len(ls['evidence']) < 3:
                ls['evidence'].append({'handle': f['handle'], 'evidence_kind': kind, 'quote': quote[:200]})
            rel_atoms.add((scope, rel, a))
        for a in neg:
            ls = label_seen[a]
            ls['count'] += 1
            ls['products'].add(f['handle'])
            if len(ls['evidence']) < 3:
                ls['evidence'].append({'handle': f['handle'], 'evidence_kind': kind, 'quote': quote[:200]})
            rel_atoms.add((scope, 'not_compatible_with', a))
    f['relations'] = sorted(rel_atoms)

manifest_handles = set(by_handle)
compat_labels, compat_unres, missing_targets = {}, {}, []
for a, ls in sorted(label_seen.items(), key=lambda x: -x[1]['count']):
    k = C.resolve_atom(a)
    if k:
        kind, fam, members, reason = C.TARGETS[k]
        for m in members:
            if 'source_handle' in m and m['source_handle'] not in manifest_handles:
                missing_targets.append((a, m['source_handle']))
        entry = {'kind': kind, 'reason': reason, 'seen': ls['count'], 'products': len(ls['products']), 'evidence': ls['evidence']}
        if k != a:
            entry['alias_of'] = k
        if kind == 'family':
            entry['family'] = fam
            entry['members'] = members
        else:
            entry['to'] = members[0]
        if any('levonis_model' in m for m in members):
            entry['pending'] = 'levonis_product_id from the step-2 sealed snapshot'
        q = re.search(r'\(([^)]+)\)$', a)
        if q or re.search(r'\bLaser\b$', a):
            entry['qualifier'] = q.group(1) if q else 'Laser'
        compat_labels[a] = entry
    else:
        compat_unres[a] = {'reason': C.UNRESOLVABLE.get(a, 'not_a_bambu_target_in_scope'), 'seen': ls['count'], 'products': len(ls['products']),
                           'evidence': ls['evidence'], 'reviewed': True}

# "A1 Series" is resolved per subject (compat.py A1_SERIES_BY_SUBJECT); subjects without evidence keep the narrow default.
if 'A1 Series' in compat_labels:
    a1s = compat_labels['A1 Series']
    a1s['reason'] = 'family_members_by_subject'
    a1s['default'] = {'members': a1s.pop('members'), 'reason': 'family_members_narrow_default',
                      'applies_to': 'a subject page with no evidence either way (listed in subjects_on_default; owner question P0-1)'}
    a1s['by_subject'] = {h: {'basis': b, 'reason': C.A1_SERIES_REASON[b], 'members': C.A1_SERIES_MEMBERS[b], 'evidence': ev}
                         for h, (b, ev) in sorted(C.A1_SERIES_BY_SUBJECT.items())}
    a1s['subjects_on_default'] = sorted(h for h in label_seen['A1 Series']['products'] if h not in C.A1_SERIES_BY_SUBJECT)
    a1s['usage_evidence'] = C.A1_SERIES_USAGE
    a1s['resolution'] = 'members = by_subject[subject handle].members if present, else default.members'

# =====================================================================================  spec label coverage
lab_occ = collections.Counter()
lab_prod = collections.defaultdict(set)
lab_example = {}
mapped_occ = 0
for r in recs:
    for p in r['f']['spec_rows']:
        l = p['label']
        if not l or len(l) > 80:
            continue
        hit = registry.lookup(l)
        if hit:
            mapped_occ += 1
            p['key'] = hit[0]
        else:
            n = registry.norm(l)
            lab_occ[n] += 1
            lab_prod[n].add(r['f']['handle'])
            lab_example.setdefault(n, (r['f']['handle'], l, p['value'][:80]))
            p['key'] = registry.slug(l)
total_occ = mapped_occ + sum(lab_occ.values())
distinct_labels = set()
for r in recs:
    for p in r['f']['spec_rows']:
        if p['label'] and len(p['label']) <= 80:
            distinct_labels.add(registry.norm(p['label']))
distinct_mapped = sum(1 for l in distinct_labels if registry.lookup(l))
top_unknown = [{'label': l, 'occurrences': n, 'products': len(lab_prod[l]), 'example': {'handle': lab_example[l][0], 'label': lab_example[l][1],
                'value': lab_example[l][2]}, 'proposed_key': registry.slug(l)} for l, n in lab_occ.most_common(50)]
long_labels = [{'handle': r['f']['handle'], 'label_excerpt': p['label'][:120]} for r in recs for p in r['f']['spec_rows'] if p['label'] and len(p['label']) > 80]


# =====================================================================================  plan size estimate (§A.5 budget)
def search_tokens(f, rec):
    P = rec['P']
    vals = [f['title'], 'Bambu Lab', P.get('seoMetaDescription') or '']
    vals += [v['value'] for g in P['options'] for v in g['values']]
    vals += list(sku_codes.get(f['handle'], {}).values())
    vals += [p['value'] for p in f['spec_rows'] if p.get('key') == 'identity.part_code']
    leaf = f['leaf']
    if leaf.startswith('@'):
        vals.append(leaf_name[leaf][3])
    else:
        vals.append(T.EXISTING.get(leaf, (leaf,))[0])
    return index_tokens(vals)


def plan(f, rec):
    P = rec['P']
    G, V, N, I = f['G'], f['V'], f['N'], f['image_rows']
    SW = f['swatches']
    colour_codes = sum(1 for g, k in zip(P['options'], f['group_kinds']) if k == 'color' for v in g['values'] if re.search(r'\(\d{5}\)', v['value']))
    part_codes = len({p['value'] for p in f['spec_rows'] if p.get('key') == 'identity.part_code'})
    sk = len(sku_codes.get(f['handle'], {}))
    E = 1 + N + colour_codes + sk + part_codes
    keys = {(p.get('key'), p.get('scope_hint', '')) for p in f['spec_rows']}
    S_found = len(keys)
    found_keys = {k for k, _ in keys}
    S_nf = max(0, registry.EXPECTED_COUNT.get(f['type'], 4) - len(found_keys & {x[0] for x in registry.R}))
    S_val = sum(len(g['values']) for g, k in zip(P['options'], f['group_kinds']) if k in ('pack', 'nozzle'))
    S = S_found + S_nf + S_val
    docs = set()
    for cls in ('pdf', 'model_file', 'wiki', 'video', 'video_file', 'makerworld', 'tracker'):
        for _, u, _ in f['link_classes'].get(cls, []):
            docs.add(u.split('?')[0])
    D = len(docs)
    R = len(f['relations'])
    fits = 0
    for scope, rel, a in f['relations']:
        k = C.resolve_atom(a)
        if k and rel == 'compatible_with':
            kind, fam, members, reason = C.TARGETS[k]
            if kind in ('printer', 'family'):
                if k == 'A1 Series' and f['handle'] in C.A1_SERIES_BY_SUBJECT:
                    members = C.A1_SERIES_MEMBERS[C.A1_SERIES_BY_SUBJECT[f['handle']][0]]
                fits = max(fits, len(members))
    T_ = len(search_tokens(f, rec))
    img_blocks = min(40, f['desc_images'])
    C_ = f['text_blocks'] + img_blocks
    U = f['usage_steps']
    mirror_rows = S_found + S_val
    TR = 2 + f['text_blocks'] + img_blocks + V + (min(mirror_rows, 1) * 3 + 2 * mirror_rows) + 2 * U
    memberships = 2 + len(f['also'])
    reads = 45 + math.ceil(max(I, 1) / 90) + math.ceil(max(SW, 1) / 90)
    fixed = 22 + memberships
    batch = fixed + 3 * G + 3 * V + 3 * N + 2 * I + SW + (T_ + 2) + S + D + E + R + fits + TR
    total = reads + batch + 3
    # the same plan if the writer inserts the side tables as multi-row INSERTs chunked under D1's 100 bound parameters
    side_rows = {'option_source_refs': (G + V + N + I, 8), 'external_ids': (E, 8), 'swatches': (SW, 9), 'spec_values': (S, 30), 'relations': (R, 16)}
    side_now = sum(n for n, _ in side_rows.values())
    side_multi = sum(math.ceil(n / max(1, 100 // w)) for n, w in side_rows.values() if n)
    total_multi = total - side_now + side_multi
    return {'statements_estimate': total, 'statements_estimate_multirow_side_inserts': total_multi, 'batch_estimate': batch, 'reads_estimate': reads,
            'breakdown': {'groups': G, 'values': V, 'variants': N, 'image_rows': I, 'swatches': SW, 'search_tokens': T_,
                          'spec_rows': S, 'documents': D, 'external_ids': E, 'relations': R, 'printer_fits_max': fits,
                          'content_blocks': C_, 'translation_slots': TR, 'memberships': memberships},
            'rows_per_collection': {'option_groups': G, 'option_values': V, 'variants': N, 'images': I}}


for r in recs:
    r['f']['plan'] = plan(r['f'], r)

# =====================================================================================  holds, curated, queue
for r in recs:
    f = r['f']
    f['hold_code'] = 'ORDER_TYPE_WORD' if f['order_type_hits'] else ''
    f['curated'] = f['type'] in ('printer', 'filament', 'hotend', 'build_plate', 'laser_machine') or (f['type'] == 'ams' and f['subtype'] == 'ams_unit')
audit_of = collections.defaultdict(list)
for cls, hs in A.AUDIT:
    for h in hs:
        audit_of[h].append(cls)
first = [by_handle[A.CANARY]]
audit_handles = []
for cls, hs in A.AUDIT:
    for h in hs:
        if h not in audit_handles and h != A.CANARY:
            audit_handles.append(h)
audit_recs = sorted([by_handle[h] for h in audit_handles], key=lambda r: (A.TYPE_ORDER.index(r['f']['type']), r['sitemap_index']))
fixed_set = {A.CANARY} | set(audit_handles)
rest = [r for r in recs if r['f']['handle'] not in fixed_set and not r['f']['hold_code']]
rest.sort(key=lambda r: (A.TYPE_ORDER.index(r['f']['type']), r['sitemap_index']))
held = [r for r in recs if r['f']['hold_code'] and r['f']['handle'] not in fixed_set]
held.sort(key=lambda r: (A.TYPE_ORDER.index(r['f']['type']), r['sitemap_index']))
for r in audit_recs + first:
    if r['f']['hold_code']:
        r['f']['note'] = 'audit/canary product carries a hold'
queue = first + audit_recs + rest + held
for i, r in enumerate(queue, 1):
    r['f']['queue_position'] = i

# =====================================================================================  taxonomy map
route_members = collections.defaultdict(list)
for r in recs:
    route_members[r['f']['route']].append(r)
routes_map = {}
overrides = {}
for rt, members in sorted(route_members.items()):
    voters = [m for m in members if m['f']['handle'] not in T.REVIEWED_LEAF] or members   # a reviewed handle leaf never moves its route
    cnt = collections.Counter(m['f']['leaf'] for m in voters)
    best = max(cnt.items(), key=lambda kv: (kv[1], -min(m['sitemap_index'] for m in voters if m['f']['leaf'] == kv[0])))[0]
    if rt == T.L1['accessories']:
        best = '@printer-acc'      # the bare accessories route keeps an accessory default; its spare parts carry overrides
    entry = {'primary': best if not best.startswith('@') else best, 'products': len(members)}
    fib = [m for m in members if any(a[0] == '@fiber' for a in m['f']['also'])]
    if fib and len(fib) == len(members):
        entry['also'] = ['@fiber']
    routes_map[rt] = entry
    for m in members:
        if m['f']['leaf'] != best:
            ev = m['f']['leaf_evidence'] or ('title', m['f']['title'])
            overrides[m['f']['handle']] = {'primary': m['f']['leaf'], 'route': rt, 'quote': ev[1][:200], 'quote_kind': ev[0]}
also_by_handle = {}
for r in recs:
    f = r['f']
    extra = [a for a in f['also'] if not (a[0] == '@fiber' and 'also' in routes_map[f['route']])]
    if extra:
        also_by_handle[f['handle']] = [{'also': a[0], 'route': f['route'], 'quote': a[2][:200], 'quote_kind': a[1]} for a in extra]


def resolve_leaf(handle, route):
    if handle in overrides:
        return overrides[handle]['primary']
    parts = route.split('>')
    for i in range(len(parts), 0, -1):
        k = '>'.join(parts[:i])
        if k in routes_map:
            return routes_map[k]['primary']
    return None


leaf_counts = collections.Counter()
secondary_counts = collections.Counter()
unmapped = []
for r in recs:
    lf = resolve_leaf(r['f']['handle'], r['f']['route'])
    if lf is None:
        unmapped.append(r['f']['handle'])
    elif lf != r['f']['leaf']:
        unmapped.append(r['f']['handle'] + ' (map disagrees)')
    leaf_counts[lf] += 1
    for a in r['f']['also']:
        secondary_counts[a[0]] += 1

marketing = []
coll = json.load(open(os.path.join(os.path.dirname(P0), 'collections.json')))
coll_rules = {'_policy': 'The run fetches no collection page (§J.1) and P0 crawled none, so no collection adds a membership; secondaries come only from '
                         'page evidence (also_by_handle, route also). Non-type collections (marketing, SEO landings, legacy one-product, system) are '
                         'ignored and their handles are omitted on purpose (they name promotions).',
              '_ignored_non_type_counts': {}}
for c in coll['collections']:
    g = c['group']
    if g in ('marketing', 'seo_landing', 'legacy_single_product', 'system'):
        coll_rules['_ignored_non_type_counts'][g] = coll_rules['_ignored_non_type_counts'].get(g, 0) + 1
    elif not re.search(r'sale|deal|discount|promo|coupon|price|offer', c['handle'], re.I):
        coll_rules[c['handle']] = {'ignore': 'type_collection_membership_not_crawled'}
    else:
        coll_rules['_ignored_non_type_counts']['type_but_commerce_named'] = coll_rules['_ignored_non_type_counts'].get('type_but_commerce_named', 0) + 1


def node(key):
    if key.startswith('@'):
        c = leaf_name[key]
        return {'id': key, 'name_en': c[3], 'name_ar': c[4], 'name_ckb': c[5], 'parent': c[1], 'new': True}
    e = T.EXISTING[key]
    return {'id': key, 'name_en': e[0], 'name_ar': e[1], 'name_ckb': e[2], 'parent': T.EXISTING_PARENT.get(key), 'new': False}


tax = {
    'version': 1,
    'status': 'DRAFT (P0 step 3). Not reviewed by the integrator; snapshot_sha256 stays null until the step-2 sealed snapshot confirms the live tree.',
    'reviewed_by': 'p0-agent (draft)', 'reviewed_at': NOW, 'snapshot_sha256': None,
    'tree_source': {
        'used': 'repository seeds at /home/user/Levonis (migrations 0018, 0102, 0147, 0148; worker/lib/templateFamilies.ts:1858-1930)',
        'live_tree_read': False,
        'why': 'P0 instruction: never contact levonis-iq.com. /api/catalog/tree exists (worker/routes/catalog.ts) but was not read; '
               'owner-made nodes and live slugs are unknown until the step-2 sealed snapshot.',
    },
    'create': [{'key': c[0], 'parent': c[1], 'slug': c[2], 'name_en': c[3], 'name_ar': c[4], 'name_ckb': c[5], 'template_family': c[6],
                'is_printer_catalog': c[7], 'sort': c[8]} for c in T.CREATE],
    'routes': routes_map,
    'handles': overrides,
    'also_by_handle': also_by_handle,
    'collections': coll_rules,
    'leaf_limit': 250,
    'leaf_counts': {k: v for k, v in sorted(leaf_counts.items(), key=lambda kv: -kv[1])},
    'secondary_counts': dict(secondary_counts),
    'nodes': {k: node(k) for k in sorted(set(leaf_counts) | set(secondary_counts) | {'@' + c[0] for c in T.CREATE})},
}

# =====================================================================================  identity map
# identity.series = the step-4 registry's Bambu family for the model (packages/catalog/src/bambuImport/registry/models.ts:29-41,
# mirrored here and cross-checked by tools/verify.py), each a label the store's own pages use (count recorded as evidence).
# No invented values: R1 has no series on any page, so it gets none. AMS units: the registry family 'AMS Series' (pages:
# "All AMS Series"), whose reviewed members in compat-targets.json are exactly the four AMS units.
MODEL_SERIES = {'A1 mini': 'A1 Series', 'A1': 'A1 Series', 'A2L': 'A2 Series', 'P1P': 'P1 Series', 'P1S': 'P1 Series', 'P2S': 'P2 Series',
                'X1C': 'X1 Series', 'X1E': 'X1 Series', 'X2D': 'X2 Series', 'H2D Pro': 'H2 Series', 'H2D': 'H2 Series', 'H2S': 'H2 Series',
                'H2C': 'H2 Series', 'AMS': 'AMS Series', 'AMS lite': 'AMS Series', 'AMS 2 Pro': 'AMS Series', 'AMS HT': 'AMS Series'}
SERIES_PAGE_LABEL = {'AMS Series': 'All AMS Series'}
MAT_L2 = {'552709755857096704': 'PLA', '552709756440104960': 'PETG', '552709756595294208': 'ABS', '552709756700151808': 'ASA',
          '552709756834369536': 'PC', '552709756939227136': 'TPU', '552709757065056256': 'PA', '552709757257994240': 'PET',
          '552709757316714496': 'PPS', '552709757392211968': 'Support'}
identity = {}
for r in recs:
    f = r['f']
    rt = f['route'].split('>')
    l2 = rt[1] if len(rt) > 1 else ''
    t = f['title']
    if f['type'] in ('printer', 'ams', 'laser_machine'):
        model = re.sub(r'^\[Refurbished\]\s*', '', t)
        model = re.sub(r'^Bambu Lab\s+', '', model)
        model = re.sub(r'\s*(3D Printer|Combo Starter Kit|- Automatic Material System)\s*$', '', model).strip()
        series = MODEL_SERIES.get(model, '')
        fam = {'printer': 'bambu_lab_3d_printers', 'ams': 'bambu_lab_ams', 'laser_machine': 'bambu_lab_laser_cutters'}[f['type']]
        ev = {'route': f['route'], 'title': t, 'model_from': 'title',
              'series_from': ('registry/models.ts series of the model' if series and series != 'AMS Series' else
                              'registry/models.ts ams_family "AMS Series" (form "All AMS Series"); its reviewed members in compat-targets.json '
                              'are the four AMS units' if series else 'none: no page names a series for this model')}
        if series:
            pl = SERIES_PAGE_LABEL.get(series, series)
            ev['series_label_on_store_pages'] = {'label': pl, 'sightings': label_seen[pl]['count'] if pl in label_seen else 0,
                                                 'products': len(label_seen[pl]['products']) if pl in label_seen else 0}
        identity[f['handle']] = {'model': model, 'series': series, 'family': fam, 'evidence': ev}
    elif f['type'] == 'filament' and f['subtype'] != 'pack':
        # the material family of the route's L2 node, kept only when the title states it as a word (PAHT-CF / PPA-CF / PVA: none)
        mat = MAT_L2.get(l2, '')
        proven = bool(mat) and re.search(r'(?<![A-Za-z])' + re.escape(mat) + r'(?![A-Za-z])', t, re.I)
        identity[f['handle']] = {'model': t, 'series': mat if proven else '', 'family': 'bambu_filament',
                                 'evidence': {'route': f['route'], 'title': t, 'model_from': 'title',
                                              'series_from': 'route L2 material node, stated in the title' if proven else
                                              ('none: the route L2 material (%s) is not stated in the title' % mat if mat else 'none')}}
handle_title_mismatch = []
for r in recs:
    f = r['f']
    tokens_h = set(re.split(r'[-_]+', f['handle'].lower()))
    tokens_t = set(re.findall(r'[a-z0-9]+', f['title'].lower()))
    if tokens_h and len(tokens_h & tokens_t) / max(1, len(tokens_h)) < 0.5:
        handle_title_mismatch.append({'handle': f['handle'], 'title': f['title']})
id_map = {'version': 1, 'status': 'DRAFT (P0). Machines and filaments only; parts carry none. model = the title\'s model token; series = the '
                                   'step-4 registry family of that model (a label the store pages use, sightings recorded) or, for a filament, '
                                   'the route\'s material node only when the title states it; empty when no page names one (R1, PAHT-CF, PPA-CF, '
                                   'PVA); family = the Levonis product_family code (internal, from the type).',
          'reviewed_by': 'p0-agent (draft)', 'reviewed_at': NOW, 'entries': identity}

# =====================================================================================  scans
scans = {}
# (1) variant_key / value identity
case_dupes, exact_dupes, valid_dupes, sku_unmatched, combo_dupes, jsonld_bad, seo_mismatch, empty_value_ids = [], [], [], [], [], [], [], []
for r in recs:
    P, f = r['P'], r['f']
    allv = []
    for g in P['options']:
        texts = [nfc(v['value'].strip()) for v in g['values']]
        cnt = collections.Counter(texts)
        for t_, n in cnt.items():
            if n > 1:
                exact_dupes.append({'handle': f['handle'], 'group': g['propertyKey'].strip(), 'value': t_, 'times': n})
        low = collections.defaultdict(list)
        for t_ in set(texts):
            low[t_.lower()].append(t_)
        for k, vs in low.items():
            if len(vs) > 1:
                ids = [v['id'] for v in g['values'] if nfc(v['value'].strip()) in vs]
                case_dupes.append({'handle': f['handle'], 'group': g['propertyKey'].strip(), 'values': sorted(vs), 'value_ids': ids,
                                   'variant_keys': ['bv-' + H('bambu_us:value:' + i) for i in ids]})
        for v in g['values']:
            allv.append(v['id'])
            if not v['id']:
                empty_value_ids.append({'handle': f['handle'], 'group': g['propertyKey'].strip(), 'value': v['value']})
    c2 = collections.Counter(allv)
    for vid, n in c2.items():
        if n > 1 and vid:
            valid_dupes.append({'handle': f['handle'], 'value_id': vid, 'times': n})
    gmap = {g['propertyKeyId']: {nfc(v['value'].strip()) for v in g['values']} for g in P['options']}
    combos = collections.Counter()
    for s in P['skus']:
        combo = []
        for p in s['props']:
            vals = gmap.get(p['propertyKeyId'])
            if vals is None or nfc(p['propertyValue'].strip()) not in vals:
                sku_unmatched.append({'handle': f['handle'], 'variant_id': s['id'], 'group_key_id': p['propertyKeyId'], 'value': p['propertyValue']})
            combo.append((p['propertyKeyId'], nfc(p['propertyValue'].strip())))
        combos[tuple(sorted(combo))] += 1
    for k, n in combos.items():
        if n > 1:
            combo_dupes.append({'handle': f['handle'], 'combo': [v for _, v in k], 'times': n})
    jl = r['r']['jsonld']
    if not jl:
        jsonld_bad.append({'handle': f['handle'], 'problem': 'no ProductGroup JSON-LD'})
    else:
        if jl['productGroupID'] != f['id']:
            jsonld_bad.append({'handle': f['handle'], 'problem': 'productGroupID != P.id'})
        vids = {s['id'] for s in P['skus']}
        if set(jl['variant_skus']) - vids:
            jsonld_bad.append({'handle': f['handle'], 'problem': 'hasVariant sku not a variant id', 'extra': sorted(set(jl['variant_skus']) - vids)[:5]})
        if vids - set(jl['variant_skus']):
            jsonld_bad.append({'handle': f['handle'], 'problem': 'variant missing from JSON-LD', 'missing': sorted(vids - set(jl['variant_skus']))[:5]})
    if f['handle'] != r['sitemap_handle']:
        seo_mismatch.append({'sitemap_handle': r['sitemap_handle'], 'seoCode_decoded': f['handle']})
    if (P['seoUrlHandle'] or '').rsplit('/', 1)[-1] != P['seoCode']:
        seo_mismatch.append({'handle': f['handle'], 'problem': 'seoUrlHandle tail != seoCode', 'seoUrlHandle': P['seoUrlHandle']})
scans['variant_keys'] = {
    'rule': "variant_key = 'bv-' + H('bambu_us:value:' + source value id); value id ov_ = H(product_id + ':' + propertyKeyId + ':' + NFC(text))",
    'case_only_duplicates': case_dupes, 'exact_duplicate_value_text_in_group': exact_dupes, 'duplicate_value_ids_in_product': valid_dupes,
    'empty_value_ids': empty_value_ids, 'sku_value_not_in_group': sku_unmatched, 'duplicate_variant_combos': combo_dupes,
    'jsonld_identity_problems': jsonld_bad, 'handle_problems': seo_mismatch}
# (2) order-type words
scans['order_type_words'] = {'rule': 'packages/pricing/src/availability.ts availabilityFromName: /pre[\\s-]?order|طلب\\s*مسبق/i, /direct(\\s*sale)?|بيع\\s*مباشر/i',
                             'hits': [{'handle': r['f']['handle'], **h} for r in recs for h in r['f']['order_type_hits']],
                             'products': sorted({r['f']['handle'] for r in recs if r['f']['order_type_hits']})}
# group-name check (not refused by legacyShapeErrors, informational)
scans['order_type_words']['group_name_hits'] = [{'handle': r['f']['handle'], 'group': g['propertyKey']} for r in recs for g in r['P']['options']
                                                if A.availability_from_name(g['propertyKey'])]
# (2b) customer-text refusals (§C.10 layer 2): source strings copied verbatim into customer-text payload fields that payload.ts
#      refuses (IMPORT_PAYLOAD_KEY_REFUSED, refused_text). hold_code cannot park them (0195), so each needs a reviewed value label.
_rt = []
for r in recs:
    for x in r['f']['refused_text_hits']:
        vl = RV.VALUE_LABELS.get(r['f']['handle'], {})
        covered = 'value_labels' if x.get('value_source_id') in vl else 'NONE'
        _rt.append({'handle': r['f']['handle'], 'queue_position': r['f']['queue_position'], **x, 'covered_by': covered})
scans['refused_customer_text'] = {
    'rule': 'tools/sentences.py (port of sentences.ts + payload.ts REFUSED_FOR.customer): money, promotion, shipping_policy, warranty',
    'scanned': {'titles': len(recs), 'option_groups': sum(len(r['P']['options']) for r in recs),
                'option_values': sum(len(g['values']) for r in recs for g in r['P']['options'])},
    'hits': _rt, 'uncovered': [x for x in _rt if x['covered_by'] == 'NONE'],
    'note': 'ids and class only; the refused text is never written to any P0 output'}
# (3) composite cells
_seen_c = set()
scans['composite_cells'] = []
for r in recs:
    for c in r['f']['composites']:
        k = (r['f']['handle'], c['label'], c['excerpt'])
        if k not in _seen_c:
            _seen_c.add(k)
            scans['composite_cells'].append({'handle': r['f']['handle'], **c})
# (4) region
scans['region_tables'] = [{'handle': r['f']['handle'], 'type': r['f']['type'], 'hits': r['f']['region_hits'][:6], 'hit_count': len(r['f']['region_hits'])}
                          for r in recs if r['f']['region_hits']]
# (5) spec labels
scans['spec_labels'] = {'label_occurrences': total_occ, 'mapped_occurrences': mapped_occ,
                        'coverage_occurrences': round(mapped_occ / total_occ, 4) if total_occ else None,
                        'distinct_labels': len(distinct_labels), 'distinct_mapped': distinct_mapped,
                        'unknown_distinct': len(lab_occ), 'top_50_unknown': top_unknown,
                        'labels_over_80_chars': long_labels,
                        'matrix_tables': [{'handle': r['f']['handle'], **m} for r in recs for m in r['f']['spec_matrices']],
                        'products_without_spec_rows': sorted(r['f']['handle'] for r in recs if not r['f']['spec_rows'])}
# (6) media review list
media_review, url_dupes, value_name_candidates = [], [], []
for r in recs:
    P, f = r['P'], r['f']
    b = f['binding']
    gal = P['mediaFiles']
    byname = collections.defaultdict(list)
    for i, m in enumerate(gal):
        byname[fname(m['url'])].append((i, m))
    bound_idx = set(b['hero'].values())
    for nm, lst in byname.items():
        urls = {m['url'] for _, m in lst}
        if len(lst) > 1 and len(urls) > 1:
            media_review.append({'handle': f['handle'], 'file_name': nm, 'gallery_indexes': [i for i, _ in lst],
                                 'distinct_urls': len(urls), 'any_variant_bound': any(i in bound_idx for i, _ in lst),
                                 'action': 'hash at /media; same hash -> content_duplicate (inherits binding); different hash -> image_review, stays unbound'})
    for i, j in b['dup_url']:
        url_dupes.append({'handle': f['handle'], 'gallery_index': i, 'same_url_as_index': j})
    # unbound gallery images whose file name names exactly one option value (override candidates, §C.4 step 2)
    title_toks = set(re.findall(r'[a-z0-9]+', f['title'].lower())) | {'bambu', 'lab'}
    STOP = {'bundle', 'combo', 'with', 'and', 'the', 'for', 'of', 'a', 'pcs', 'pc', 'set', 'kit'}
    for u in b['unbound_general']:
        stem = re.sub(r'\.[a-z0-9]+$', '', fname(u).lower())
        ftoks = set(re.findall(r'[a-z0-9]+', stem))
        best = []
        for g in P['options']:
            if len(g['values']) < 2:
                continue
            for v in g['values']:
                vt = set(re.findall(r'[a-z0-9]+', v['value'].lower())) - STOP - title_toks
                if not vt:
                    continue
                inter = vt & ftoks
                score = len(inter) / len(vt)
                if score >= 0.6 and (len(inter) >= 2 or any(len(x) >= 4 and not x.isdigit() for x in inter)):
                    best.append((score, g['propertyKey'].strip(), v['value']))
        if best:
            best.sort(reverse=True)
            if len(best) == 1 or best[0][0] > best[1][0]:
                value_name_candidates.append({'handle': f['handle'], 'image_file': fname(u), 'candidate_value': best[0][2], 'group': best[0][1],
                                              'score': round(best[0][0], 2)})
scans['media'] = {
    'note': 'P0 fetched no image bytes (no network); content hashes are computed at /media. File-name evidence only.',
    'same_name_different_url': media_review, 'same_url_twice_in_gallery': url_dupes,
    'override_candidates_by_file_name': value_name_candidates,
    'variants_without_hero': [{'handle': r['f']['handle'], 'variant_ids': r['f']['binding']['no_hero']} for r in recs if r['f']['binding']['no_hero']],
    'variant_hero_not_in_gallery': [{'handle': r['f']['handle'], 'variant_ids': r['f']['binding']['hero_not_in_gallery']} for r in recs
                                    if r['f']['binding']['hero_not_in_gallery']],
    'binding_rule_totals': dict(sum((collections.Counter(r['f']['binding']['rules']) for r in recs), collections.Counter())),
    'description_images_over_40': [{'handle': r['f']['handle'], 'description_images': r['f']['desc_images']} for r in recs if r['f']['desc_images'] > 40],
    'store_test_host_links': [{'handle': r['f']['handle'], 'count': len(r['f']['link_classes'].get('store_test_host', []))} for r in recs
                              if r['f']['link_classes'].get('store_test_host')],
}
# (7) in-the-box
scans['in_the_box'] = {'products_with_items_or_images': sum(1 for r in recs if r['f']['box_images'] or r['f']['box_items']),
                       'products_with_box_images': sum(1 for r in recs if r['f']['box_images']),
                       'total_box_images': sum(len(r['f']['box_images']) for r in recs),
                       'over_30_cap': [{'handle': r['f']['handle'], 'images': len(r['f']['box_images'])} for r in recs if len(r['f']['box_images']) > 30],
                       'top': sorted([{'handle': r['f']['handle'], 'images': len(r['f']['box_images']), 'items': r['f']['box_items']}
                                      for r in recs if r['f']['box_images']], key=lambda x: -x['images'])[:15]}
# (8)(9) tracker + wiki links
scans['tracker_links'] = [{'handle': r['f']['handle'], 'url': u, 'text': t[:80], 'where': w[:50]} for r in recs
                          for (w, u, t) in r['f']['link_classes'].get('tracker', [])]
wiki = []
for r in recs:
    us = sorted({u.split('#')[0] for _, u, _ in r['f']['link_classes'].get('wiki', [])})
    if us:
        wiki.append({'handle': r['f']['handle'], 'count': len(us), 'urls': us, 'over_3_followed_limit': len(us) > 3})
scans['wiki_links'] = wiki
scans['documents'] = {'pdf_links': sum(len({u for _, u, _ in r['f']['link_classes'].get('pdf', [])}) for r in recs),
                      'model_files': sum(len({u for _, u, _ in r['f']['link_classes'].get('model_file', [])}) for r in recs),
                      'videos': sum(len({u for _, u, _ in r['f']['link_classes'].get('video', [])}) for r in recs),
                      'makerworld_links': sum(len({u for _, u, _ in r['f']['link_classes'].get('makerworld', [])}) for r in recs),
                      'store_links_to_rewrite': sum(len(r['f']['link_classes'].get('store_link', [])) for r in recs)}
# (10)(11) plan sizes and row caps
plans = sorted(({'handle': r['f']['handle'], 'type': r['f']['type'], **r['f']['plan']} for r in recs), key=lambda x: -x['statements_estimate'])
scans['plan_size'] = {'limit_invocation': 900, 'review_threshold': 600, 'method': 'tools/build.py plan(): reads 45 + media-verify chunks; batch = fixed 22 + memberships + 3G + 3V + 3N + 2I + swatches + search tokens(+2) + spec rows (incl. expected not_found) + documents + external ids + relations + fits + translation slots; post-commit 3',
                      'over_600': [p for p in plans if p['statements_estimate'] > 600], 'over_900': [p for p in plans if p['statements_estimate'] > 900],
                      'over_600_with_multirow_side_inserts': [{'handle': p['handle'], 'estimate': p['statements_estimate_multirow_side_inserts']} for p in plans
                                                              if p['statements_estimate_multirow_side_inserts'] > 600],
                      'top_10': plans[:10], 'median': plans[len(plans) // 2]['statements_estimate'], 'max': plans[0]['statements_estimate']}
scans['collections_over_400_rows'] = [{'handle': r['f']['handle'], **r['f']['plan']['rows_per_collection']} for r in recs
                                      if max(r['f']['plan']['rows_per_collection'].values()) > 400]
# sentence classes (§C.10) — counts only, no text. One classifier for every P0 number: tools/sentences.py, the port of
# sentences.ts (classifySentence over splitSentences), checked against the TypeScript original by tools/verify.py.
import sentences as SC  # noqa: E402
sent_counts = collections.Counter()
sent_products = collections.defaultdict(set)
for r in recs:
    for where, t in __import__('p0lib').all_text_blobs(r):
        for sent in SC.split_sentences(t):
            cls = SC.classify_sentence(sent)
            if cls != 'keep':
                sent_counts[cls] += 1
                sent_products[cls].add(r['f']['handle'])
scans['sentence_classes'] = {cls: {'sentences': sent_counts[cls], 'products': len(sent_products[cls])} for cls in SC.CLASSES}
# extra: description formats, thin pages, sku codes, handle/title mismatch
scans['description_formats'] = dict(collections.Counter(r['f']['desc_kind'] for r in recs))
scans['description_format_E_component_list'] = sorted(r['f']['handle'] for r in recs if r['f']['desc_kind'] == 'E')
scans['machines_without_spec_table'] = sorted(r['f']['handle'] for r in recs if r['f']['type'] in ('printer', 'ams', 'laser_machine') and not r['f']['spec_rows'])
scans['thin_pages'] = sorted(r['f']['handle'] for r in recs if not r['r']['sections'] and not r['P']['features_html'])
scans['sku_codes'] = {'stats': dict(xs_stats), 'unmatched': dict(xs_unmatched), 'products_with_codes': len(sku_codes),
                      'variants_with_codes': sum(len(v) for v in sku_codes.values()), 'conflicts': sku_conflicts}
scans['handle_title_mismatch'] = handle_title_mismatch
scans['group_kinds'] = dict(collections.Counter(k for r in recs for k in r['f']['group_kinds']))
scans['option_group_names_needing_translation_review'] = sorted({g['propertyKey'].strip() for r in recs for g, k in zip(r['P']['options'], r['f']['group_kinds']) if k == 'other'})
scans['compat'] = {'labels_mapped': len(compat_labels), 'labels_unresolvable': len(compat_unres), 'compounds': len(compound_seen),
                   'targets_missing_from_manifest': missing_targets}

# =====================================================================================  manifest
rows = []
for r in queue:
    f = r['f']
    rows.append({
        'queue_position': f['queue_position'], 'source': 'bambu_us', 'source_product_id': f['id'], 'handle': f['handle'],
        'seo_code_raw': f['seoCode'], 'canonical_url': f['canonical_url'], 'title': f['title'],
        'type': f['type'], 'subtype': f['subtype'], 'currentAllIdRoute': f['route'], 'leaf': resolve_leaf(f['handle'], f['route']),
        'also': [a[0] for a in f['also']], 'curated': f['curated'], 'hold_code': f['hold_code'],
        'sku_codes': sku_codes.get(f['handle'], {}), 'value_labels': RV.VALUE_LABELS.get(f['handle'], {}), 'audit_classes': audit_of.get(f['handle'], []) + (['canary'] if f['handle'] == A.CANARY else []),
        'description_format': f['desc_kind'], 'sitemap_index': r['sitemap_index'],
        'plan': {'statements_estimate': f['plan']['statements_estimate'],
                 'statements_estimate_multirow_side_inserts': f['plan']['statements_estimate_multirow_side_inserts'], **f['plan']['rows_per_collection']},
    })
type_counts = collections.Counter(x['type'] for x in rows)
manifest = {
    'version': 1, 'source': 'bambu_us',
    'status': 'DRAFT (P0 step 3 b). existing-matches (step 3 e) is PENDING the step-2 sealed snapshot, so OWNER_HIDDEN holds cannot be known yet.',
    'generated_at': NOW, 'generated_by': 'scratchpad/bambu/p0/tools/build.py',
    'inputs': {'sitemap': 'scratchpad/bambu/products_sitemap.xml', 'sitemap_urls': len(recs), 'crawl_log': 'p0/crawl.log.jsonl',
               'crawl_log_sha256': sha256_file(os.path.join(P0, 'crawl.log.jsonl')), 'pages_http_200': len(recs)},
    'counts': {'rows': len(rows), 'unique_source_ids': len({x['source_product_id'] for x in rows}), 'unique_handles': len({x['handle'] for x in rows}),
               'by_type': dict(type_counts), 'curated': sum(1 for x in rows if x['curated']), 'holds': dict(collections.Counter(x['hold_code'] for x in rows if x['hold_code'])),
               'with_sku_codes': sum(1 for x in rows if x['sku_codes']), 'with_value_labels': sum(1 for x in rows if x['value_labels'])},
    'queue_rule': 'J.4: canary filament-buffer; then the I.4 audit classes ordered printers -> AMS -> ... (type order); then the rest by type order '
                  '(printer, ams, laser_machine, filament, hotend, build_plate, accessory, spare_part, laser_material, makers_supply) and sitemap order; holds last.',
    'rows': rows,
}

# =====================================================================================  compat targets file
compat_file = {
    'version': 1, 'status': 'DRAFT (P0). Members marked levonis_model resolve to existing Levonis printer ids from the step-2 sealed snapshot.',
    'reviewed_by': 'p0-agent (draft)', 'reviewed_at': NOW,
    'reason_codes': sorted({v['reason'] for v in compat_labels.values()} | {v['reason'] for v in compat_unres.values()}
                           | {x['reason'] for v in compat_labels.values() for x in v.get('by_subject', {}).values()}
                           | {v['default']['reason'] for v in compat_labels.values() if 'default' in v}),
    'labels': compat_labels,
    'compounds': {raw: {'atoms': cs['atoms'], 'not_atoms': cs['neg'], 'relation': cs['relation'], 'seen': cs['count'], 'products': len(cs['products']),
                        'evidence': cs['evidence'][:2],
                        **({'atoms_reviewed': {'why': 'names the A1 model, not the A1 Series', 'evidence': C.COMPOUND_ATOMS[raw][1]}}
                           if raw in C.COMPOUND_ATOMS else {})}
                  for raw, cs in sorted(compound_seen.items(), key=lambda kv: -kv[1]['count'])},
    'reviewed_unresolvable': compat_unres,
    'requirement_targets': {
        # labels that requirement sentences name (the classifier's `requires` relations, §B.6 / §C.5); each with its quote
        'AMS Hub': {'kind': 'hub', 'to': {'source_handle': 'ams-hub'}, 'reason': 'same_model', 'code_evidence': 'SA002-N harvested for ams-hub',
                    'evidence': [{'handle': 'ams-multicolor-printing', 'evidence_kind': 'description_text',
                                  'quote': 'To connect multiple AMS units, an AMS Hub(SA002-N), a PTFE Tube Coupler(FAZ006), and a 4-pin Cable(CAB002-N) are required'}]},
        'A1 series AMS Hub': {'kind': 'hub', 'to': {'source_handle': 'ams-hub-a1-series'}, 'reason': 'same_model',
                              'evidence': [{'handle': 'a1', 'evidence_kind': 'description_text',
                                            'quote': 'To connect AMS 2 Pro unit(s) to A1 series printer, an A1 series AMS Hub (SA013) is required'}]},
        'Filament Buffer': {'kind': 'buffer', 'to': {'source_handle': 'filament-buffer'}, 'reason': 'same_model',
                            'evidence': [{'handle': 'ams-multicolor-printing', 'evidence_kind': 'description_text',
                                          'quote': 'To connect a single AMS unit to X1/P1 series printer, a Filament Buffer(SA003), a PTFE Tube Coupler(FAZ006), and a 4-pin Cable(CAB002-N) are required'}]},
        'P2S Filament Buffer': {'kind': 'buffer', 'to': {'source_handle': 'filament-buffer-p2s'}, 'reason': 'same_model', 'code_evidence': 'SA011 harvested for filament-buffer-p2s',
                                'evidence': [{'handle': 'ams-ht', 'evidence_kind': 'description_text',
                                              'quote': 'To connect one or two AMS HT unit(s) to P2S, a P2S Filament Buffer (SA011) is required'}]},
        'PTFE Tube Coupler': {'kind': 'part', 'to': {'source_handle': 'ptfe-tube-coupler'}, 'reason': 'same_model',
                              'evidence': [{'handle': 'ams-multicolor-printing', 'evidence_kind': 'description_text',
                                            'quote': 'an AMS Hub(SA002-N), a PTFE Tube Coupler(FAZ006), and a 4-pin Cable(CAB002-N) are required'}]},
        '4-in-1 PTFE Adapter': {'kind': 'part', 'to': {'source_handle': 'bambu-4-in-1-ptfe-adapter'}, 'reason': 'same_model', 'code_evidence': 'FAZ013 on the adapter page',
                                'evidence': [{'handle': 'ams-multicolor-printing', 'evidence_kind': 'description_text',
                                              'quote': 'To connect more than two AMS units, a P2S Filament Buffer (SA011) and 4-in-1 PTFE Adapter(s) (FAZ013-N) are required'}]},
        'Bambu Reusable Spool': {'kind': 'spool', 'to': {'source_handle': 'bambu-reusable-spool'}, 'reason': 'same_model', 'code_evidence': 'RSP001/RSP002 harvested',
                                 'evidence': [{'handle': 'pla-basic-color-trial-set', 'evidence_kind': 'description_text', 'quote': 'For AMS: Use with Bambu Reusable Spool'}]},
        'spool': {'kind': 'spool', 'to': {'source_handle': 'bambu-reusable-spool'}, 'reason': 'requirement_generic_to_official_part',
                  'evidence': [{'handle': 'abs-filament', 'evidence_kind': 'description_text', 'quote': 'Note: The refill needs to be used with a spool'}]},
        'Laser Module': {'kind': 'laser_module', 'to': {'source_handle': 'laser-module'}, 'reason': 'same_model',
                         'evidence': [{'handle': 'birds-eye-camera', 'evidence_kind': 'description_text',
                                       'quote': 'When paired with the H2C, the Birds Eye Camera requires the Laser Module for calibration'}]},
        '10W laser modules': {'kind': 'laser_module', 'to': {'source_handle': 'laser-module'}, 'qualifier': '10 W', 'reason': 'same_model_qualified',
                              'evidence': [{'handle': '10-w-laser-air-assist-nozzle-and-laser-lens', 'evidence_kind': 'description_text',
                                            'quote': 'This laser lens is compatible with 10W laser modules'}]},
    },
    'requirement_unresolvable': {
        '4-pin Cable(CAB002-N)': {'reason': 'ambiguous_target_needs_review', 'note_code': 'CAB002-N appears on no crawled product page',
                                  'evidence': [{'handle': 'ams-multicolor-printing', 'evidence_kind': 'description_text',
                                                'quote': 'an AMS Hub(SA002-N), a PTFE Tube Coupler(FAZ006), and a 4-pin Cable(CAB002-N) are required'}]},
    },
    'levonis_existing_printers': {m: {'levonis_product_id': None, 'resolve_from': 'step2_snapshot', 'why': 'discontinued or not in the sitemap; Levonis sells/sold it'}
                                  for m in ['X1C', 'X1E', 'P1P', 'P1S', 'X1']},
}

# =====================================================================================  synonyms
SYN = [
    # (term, canonical, lang, kind) — model words (names stay English; these route Arabic/Kurdish typing to the model token)
    ('ايه2ال', 'a2l', 'ar', 'model'), ('اي2ال', 'a2l', 'ar', 'model'), ('بي1اس', 'p1s', 'ar', 'model'), ('بي2اس', 'p2s', 'ar', 'model'),
    ('اكس1سي', 'x1c', 'ar', 'model'), ('اكس1', 'x1', 'ar', 'model'), ('اتش2اس', 'h2s', 'ar', 'model'), ('اتش2سي', 'h2c', 'ar', 'model'),
    ('ار1', 'r1', 'ar', 'model'), ('لايت', 'lite', 'ar', 'model'), ('برو', 'pro', 'ar', 'model'), ('اتش تي', 'ht', 'ar', 'model'),
    ('سايبر بريك', 'cyberbrick', 'ar', 'model'), ('سايبربريك', 'cyberbrick', 'ar', 'model'), ('سلسلة', 'series', 'ar', 'model'),
    # material and format terms
    ('عبوة بدون بكرة', 'refill', 'ar', 'material'), ('ريفل', 'refill', 'ar', 'material'), ('مع بكرة', 'spool', 'ar', 'material'),
    ('بكرة قابلة لاعادة الاستخدام', 'reusable', 'ar', 'material'), ('بي اي اي', 'pei', 'ar', 'material'), ('مطفي', 'matte', 'ar', 'material'),
    ('مات', 'matte', 'ar', 'material'), ('متوهج', 'glow', 'ar', 'material'), ('مضيء', 'glow', 'ar', 'material'), ('رخامي', 'marble', 'ar', 'material'),
    ('معدني', 'metal', 'ar', 'material'), ('خشبي', 'wood', 'ar', 'material'), ('شفاف نصفي', 'translucent', 'ar', 'material'),
    ('متدرج', 'gradient', 'ar', 'material'), ('الياف كربون', 'cf', 'ar', 'material'), ('الياف زجاج', 'gf', 'ar', 'material'),
    ('اي اس اي', 'asa', 'ar', 'material'), ('بولي كربونات', 'pc', 'ar', 'material'), ('بي في اي', 'pva', 'ar', 'material'),
    ('دعامات', 'support', 'ar', 'material'), ('مادة الدعم', 'support', 'ar', 'material'), ('لوح خشب', 'plywood', 'ar', 'material'),
    ('اكريليك', 'acrylic', 'ar', 'material'), ('فينيل', 'vinyl', 'ar', 'material'), ('جلد صناعي', 'leatherette', 'ar', 'material'),
    # product types
    ('هوت اند', 'hotend', 'ar', 'product_type'), ('هوتند', 'hotend', 'ar', 'product_type'), ('راس الطباعة', 'hotend', 'ar', 'product_type'),
    ('صفيحة طباعة', 'plate', 'ar', 'product_type'), ('لوح طباعة', 'plate', 'ar', 'product_type'), ('سطح الطباعة', 'plate', 'ar', 'product_type'),
    ('ليزر', 'laser', 'ar', 'product_type'), ('حفر بالليزر', 'laser', 'ar', 'product_type'), ('قص بالشفرة', 'cutting', 'ar', 'product_type'),
    ('براغي', 'screw', 'ar', 'product_type'), ('مغناطيس', 'magnet', 'ar', 'product_type'), ('محمل', 'bearings', 'ar', 'product_type'),
    ('محرك', 'motor', 'ar', 'product_type'), ('مروحة', 'fan', 'ar', 'product_type'), ('حزام', 'belt', 'ar', 'product_type'),
    ('انبوب تفلون', 'ptfe', 'ar', 'product_type'), ('كاشطة', 'scraper', 'ar', 'product_type'), ('غراء', 'glue', 'ar', 'product_type'),
    # Sorani (real ckb, never the Arabic)
    ('ماسوورە', 'spool', 'ckb', 'material'), ('پڕکردنەوە', 'refill', 'ckb', 'material'), ('ڕیشاڵی کاربۆن', 'cf', 'ckb', 'material'),
    ('ڕیشاڵی شووشە', 'gf', 'ckb', 'material'), ('پاڵپشت', 'support', 'ckb', 'material'), ('ئاکریلیک', 'acrylic', 'ckb', 'material'),
    ('ڤاینل', 'vinyl', 'ckb', 'material'), ('نۆزڵ', 'nozzle', 'ckb', 'product_type'), ('هۆتئێند', 'hotend', 'ckb', 'product_type'),
    ('پلێتی چاپ', 'plate', 'ckb', 'product_type'), ('لەیزەر', 'laser', 'ckb', 'product_type'), ('پارچەی یەدەگ', 'parts', 'ckb', 'product_type'),
    ('پارچە یەدەگ', 'parts', 'ckb', 'product_type'), ('پرینتەر', 'printer', 'ckb', 'product_type'), ('بزوێنەر', 'motor', 'ckb', 'product_type'),
    ('پانکە', 'fan', 'ckb', 'product_type'), ('موگناتیس', 'magnet', 'ckb', 'product_type'), ('بڕغی', 'screw', 'ckb', 'product_type'),
    ('سایبەربریک', 'cyberbrick', 'ckb', 'model'), ('ئەی ئێم ئێس', 'ams', 'ckb', 'model'), ('زنجیرە', 'series', 'ckb', 'model'),
]
existing_seed = {}
for line in open('/home/user/Levonis/worker/lib/search/vocabulary.ts', encoding='utf-8'):
    m = re.search(r"\{ term: '([^']*)', canonical: '([^']*)' \}", line)
    if m:
        existing_seed[normalize_text(m.group(1))] = m.group(2)
all_tokens = set()
for r in recs:
    all_tokens |= {t for t in index_tokens([r['f']['title']] + [v['value'] for g in r['P']['options'] for v in g['values']]) if not t.startswith('~')}
for c in T.CREATE:
    all_tokens |= {t for t in index_tokens([c[3]]) if not t.startswith('~')}
for k, v in T.EXISTING.items():
    all_tokens |= {t for t in index_tokens([v[0]]) if not t.startswith('~')}
all_tokens |= {t for t in index_tokens(['Maintenance Parts', 'Spare Parts', 'Printer Accessories', 'Printing Materials', 'Printers']) if not t.startswith('~')}
syn_rows, syn_skipped, syn_dead = [], [], []
seen_terms = set()
for term, canon, lang, kind in SYN:
    tn = normalize_text(term)
    if tn in seen_terms:
        continue
    seen_terms.add(tn)
    if tn in existing_seed:
        syn_skipped.append({'term': term, 'existing_canonical': existing_seed[tn], 'proposed_canonical': canon, 'why': 'already seeded (INSERT OR IGNORE keeps the seed)'})
        continue
    def _n(c):
        return sum(1 for r in recs if c in index_tokens([r['f']['title'], (leaf_name[r['f']['leaf']][3] if r['f']['leaf'].startswith('@') else T.EXISTING.get(r['f']['leaf'], ('',))[0])]
                                                         + [v['value'] for g in r['P']['options'] for v in g['values']]))
    products = _n(canon)
    if kind == 'product_type' and canon.isalpha() and len(canon) >= 4 and canon not in all_tokens:
        alt = canon[:-1] if canon.endswith('s') else canon + 's'
        if _n(alt) > products:
            canon, products = alt, _n(alt)
    if canon not in all_tokens:
        syn_dead.append({'term': term, 'canonical': canon, 'why': 'canonical token not in any manifest title or option value'})
        continue
    syn_rows.append({'term': term, 'term_normalized': tn, 'canonical': canon, 'lang': lang, 'kind': kind, 'products_with_canonical': products})
syn_file = {'version': 1, 'status': 'DRAFT (P0). Inserted by /run/prepare-taxonomy with INSERT OR IGNORE; names stay English, these only route ar/ckb searches.',
            'reviewed_by': 'p0-agent (draft)', 'reviewed_at': NOW, 'direction': 'term -> canonical (search_synonyms(term, canonical))',
            'rows': syn_rows, 'skipped_already_seeded': syn_skipped, 'dropped_canonical_not_in_catalogue': syn_dead}

# =====================================================================================  write
jdump(manifest, 'manifest.json')
jdump(scans, 'scans.json')
jdump(tax, 'taxonomy-map.json')
jdump(compat_file, 'compat-targets.json')
jdump(id_map, 'identity-map.json')
jdump({'version': 1, 'status': 'DRAFT (P0). Empty: no case is PROVEN by the crawl (no image bytes were fetched in P0). Candidates are in scans.json media.override_candidates_by_file_name for visual review.',
       'reviewed_by': 'p0-agent (draft)', 'reviewed_at': NOW, 'overrides': []}, 'media-overrides.json')
jdump(syn_file, 'search-synonyms.json')
json.dump({'recs': [{k: v for k, v in r['f'].items() if k not in ('binding', 'links', 'link_classes', 'spec_rows')} for r in recs]},
          open(os.path.join(P0, 'work', 'facts.json'), 'w'), ensure_ascii=False, default=list)
print('rows', len(rows), 'types', dict(type_counts))
print('leaves', len(leaf_counts), 'max leaf', max(leaf_counts.values()), 'unmapped', unmapped[:5])
print('overrides', len(overrides), 'also_by_handle', len(also_by_handle))
print('compat labels', len(compat_labels), 'unresolvable', len(compat_unres), 'missing targets', missing_targets)
print('spec coverage', scans['spec_labels']['coverage_occurrences'], 'distinct', len(distinct_labels), 'unknown', len(lab_occ))
print('plans >600', len(scans['plan_size']['over_600']), '>900', len(scans['plan_size']['over_900']), 'max', scans['plan_size']['max'], 'median', scans['plan_size']['median'])
print('holds', manifest['counts']['holds'], 'curated', manifest['counts']['curated'], 'sku', scans['sku_codes'])
print('synonyms', len(syn_rows), 'skipped', len(syn_skipped), 'dead', len(syn_dead))
