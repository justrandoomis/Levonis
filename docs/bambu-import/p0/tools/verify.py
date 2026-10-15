"""P0 exit checks (step 3 exit row, the parts P0 can prove). Usage: python3 -I tools/verify.py"""
import collections, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); P0 = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import compat as C
import p0lib
import sentences as SC
import taxonomy as TX
J = lambda n: json.load(open(os.path.join(P0, n), encoding='utf-8'))
M, T, CT, S, I, SY = J('manifest.json'), J('taxonomy-map.json'), J('compat-targets.json'), J('scans.json'), J('identity-map.json'), J('search-synonyms.json')
facts = {r['handle']: r for r in json.load(open(os.path.join(P0, 'work', 'facts.json')))['recs']}
res = []
def check(name, ok, detail=''):
    res.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (' — ' + detail if detail else ''))

rows = M['rows']
_pages = {}


def page(h):
    """The parsed page (text blobs, links, sections, title, compat quotes) of a handle, for quote checks."""
    if h not in _pages:
        rec = next(r for r in p0lib.load_all_cached() if r['sitemap_handle'] == h)
        _pages[h] = {'title': re.sub(r'\s+', ' ', rec['P']['name'] or '').strip(),
                     'text': '\n'.join(t for _, t in p0lib.all_text_blobs(rec)),
                     'links': {u.split('#')[0] for _, u, _ in p0lib.all_links(rec)},
                     'sections': [(sct['title'] or '', '\n'.join(sct['text'])) for sct in rec['r']['sections']],
                     'compat': [q for _, _, _, _, q in facts[h]['compat_raw']] if h in facts else []}
    return _pages[h]


def quote_on_page(ev):
    pg = page(ev['handle'])
    k, q = ev['evidence_kind'], ev['quote']
    if k in ('option_value', 'compat_section'):
        return q in pg['compat']
    if k == 'wiki_link':
        return q in pg['links']
    if k == 'title':
        return q == pg['title']
    if k == 'section_title':
        return any(t.strip() == q and all(l in body for l in ev.get('section_lines', [])) for t, body in pg['sections'])
    return re.sub(r'\s+', ' ', q) in re.sub(r'\s+', ' ', pg['text'])
crawl = [json.loads(l) for l in open(os.path.join(P0, 'crawl.log.jsonl'))]
check('crawl: 1,115 pages, all HTTP 200', len(crawl) == 1115 and all(c.get('status') == 200 for c in crawl), f'{len(crawl)} pages')
check('manifest: 1,115 rows = sitemap count', len(rows) == 1115)
check('unique source ids', len({r['source_product_id'] for r in rows}) == 1115)
check('unique handles', len({r['handle'] for r in rows}) == 1115)
check('ids are strings of digits', all(isinstance(r['source_product_id'], str) and r['source_product_id'].isdigit() for r in rows))
check('queue positions 1..N unique', sorted(r['queue_position'] for r in rows) == list(range(1, 1116)))
check('canary first', rows[0]['handle'] == 'filament-buffer')
held = [r['queue_position'] for r in rows if r['hold_code']]
check('holds last', not held or min(held) > max(r['queue_position'] for r in rows if not r['hold_code']), str(held))
# taxonomy
all_routes = {r['currentAllIdRoute'] for r in rows}
check('every distinct route has a map entry', all_routes <= set(T['routes']), f'{len(all_routes)} routes')
known = {'@' + c['key'] for c in T['create']} | {k for k in T['nodes'] if not k.startswith('@')}
def resolve(h, rt):
    if h in T['handles']:
        return T['handles'][h]['primary']
    p = rt.split('>')
    for i in range(len(p), 0, -1):
        if '>'.join(p[:i]) in T['routes']:
            return T['routes']['>'.join(p[:i])]['primary']
bad = [r['handle'] for r in rows if resolve(r['handle'], r['currentAllIdRoute']) not in known]
check('every product resolves to a known leaf', not bad, str(bad[:5]))
mism = [r['handle'] for r in rows if resolve(r['handle'], r['currentAllIdRoute']) != r['leaf']]
check('manifest leaf == map resolution', not mism, str(mism[:5]))
cnt = collections.Counter(resolve(r['handle'], r['currentAllIdRoute']) for r in rows)
for h, lst in T['also_by_handle'].items():
    for a in lst:
        cnt[a['also']] += 1
for rt, e in T['routes'].items():
    for a in e.get('also', []):
        cnt[a] += e['products']
check('every leaf <= 250 (primary + secondary)', max(cnt.values()) <= 250, f'max {max(cnt.values())} ({cnt.most_common(1)[0][0]})')
bad_o = []
for h, o in T['handles'].items():
    r = next(x for x in rows if x['handle'] == h)
    if o['route'] != r['currentAllIdRoute'] or not o['quote'].strip():
        bad_o.append(h)
    p = o['route'].split('>'); base = None
    for i in range(len(p), 0, -1):
        if '>'.join(p[:i]) in T['routes']:
            base = T['routes']['>'.join(p[:i])]['primary']; break
    if base == o['primary']:
        bad_o.append(h + ' (same as route)')
    f = facts[h]
    hay = ' '.join([f['title']] + [q for _, _, _, _, q in f['compat_raw']])
    if o['quote'][:60] not in hay and o['quote'] not in hay and not (o.get('quote_kind') == 'description_text' and quote_on_page({**o, 'handle': h, 'evidence_kind': 'description_text'})):
        bad_o.append(h + ' (quote not on page)')
check('overrides cite their route + a quote found on the page, and differ from the route', not bad_o, str(bad_o[:5]))
bad_a = [h for h, lst in T['also_by_handle'].items() for a in lst if not a['quote'] or a['route'] != next(x for x in rows if x['handle'] == h)['currentAllIdRoute']]
check('secondary memberships cite route + quote', not bad_a)
ar = re.compile('[؀-ۿ]')
bad_n = [c['key'] for c in T['create'] if not (c['name_ar'] and c['name_en'] and c['name_ckb']) or (ar.search(c['name_ar'] + c['name_ckb']) and c['name_ar'] == c['name_ckb'])]
check('new nodes: ar/en/ckb present, ckb never equals ar', not bad_n, str(bad_n))
slugs = [c['slug'] for c in T['create']]
seed_slugs = {'printers', 'fdm-printers', 'resin-printers', 'printer-accessories', 'fdm-printer-accessories', 'resin-printer-accessories', 'printing-materials',
              'fdm-materials', 'resin-materials', 'accessories', 'makers-supply', 'new-products', 'model-kits', 'cyberbrick-rc', 'maker-tools', 'parts-components',
              'makerlab-accessories', 'premium-model-kits', 'hardware-parts', 'electronics', 'others', 'maker-combo-kits', 'laser-crafting', 'laser-machines',
              'laser-accessories', 'laser-material', 'blade-cutting-material', 'used', 'used-printers', 'used-printer-accessories', 'maintenance-parts',
              'hotends-nozzles', 'build-plates', 'spare-parts'}
check('new slugs unique and not a seeded slug', len(set(slugs)) == len(slugs) and not (set(slugs) & seed_slugs))
# compat
labels = set(CT['labels']) | set(CT['reviewed_unresolvable'])
missing = [a for raw, c in CT['compounds'].items() for a in c['atoms'] + c['not_atoms'] if a not in labels]
check('every compatibility label mapped or reviewed-unresolvable', not missing, f"{len(CT['labels'])} mapped, {len(CT['reviewed_unresolvable'])} unresolvable, {len(CT['compounds'])} raw")
handles = {r['handle'] for r in rows}
tgt_bad = []
for sect in ('labels', 'requirement_targets'):
    for k, v in CT[sect].items():
        mem = list(v.get('members') or [v.get('to')]) + list((v.get('default') or {}).get('members', [])) + [m for b in v.get('by_subject', {}).values() for m in b['members']]
        for m in mem:
            if m and 'source_handle' in m and m['source_handle'] not in handles:
                tgt_bad.append(k)
        if not v.get('evidence'):
            tgt_bad.append(k + ' (no evidence)')
check('compat targets name manifest handles and carry evidence quotes', not tgt_bad, str(tgt_bad[:5]))
check('kinds cover printers, AMS family, hubs, buffers, laser modules, spools, Levonis X1/P1',
      {'printer', 'family', 'ams'} <= {v['kind'] for v in CT['labels'].values()} and {'hub', 'buffer', 'laser_module', 'spool'} <= {v['kind'] for v in CT['requirement_targets'].values()}
      and set(CT['levonis_existing_printers']) >= {'X1C', 'X1E', 'P1P'})
# "A1 Series" per subject: every subject is either evidence-resolved or on the narrow default; every evidence quote is on its page
a1s = CT['labels']['A1 Series']
subj = set()
for h, f in facts.items():
    for raw, *_ in f['compat_raw']:
        atoms, neg = C.atomize(raw)
        if raw in C.TARGETS:
            atoms = [raw]
        if raw in C.COMPOUND_ATOMS:
            atoms = C.COMPOUND_ATOMS[raw][0]
        if 'A1 Series' in atoms + neg:
            subj.add(h)
bs, dflt = set(a1s.get('by_subject', {})), set(a1s.get('subjects_on_default', []))
ev_bad = [(h, e['handle'], e['quote'][:40]) for h, b in a1s.get('by_subject', {}).items() for e in b['evidence'] if not quote_on_page(e)]
ev_bad += [('usage', e['handle'], e['quote'][:40]) for e in a1s.get('usage_evidence', []) if not quote_on_page(e)]
check('"A1 Series" resolved per subject: by_subject + default = every subject, no stray subject, every quote found on its page',
      bs | dflt == subj and not (bs & dflt) and not ev_bad and all(any(m.get('source_handle') == 'a1-mini' for m in b['members']) == (b['basis'] == 'includes_a1_mini')
                                                            for b in a1s.get('by_subject', {}).values()),
      f"{len(bs)} by evidence ({sum(1 for b in a1s.get('by_subject', {}).values() if b['basis'] == 'includes_a1_mini')} incl. A1 mini), {len(dflt)} on the narrow default; bad {ev_bad[:3]}")
cev_bad = [(raw, e['handle']) for raw, (atoms, evs) in C.COMPOUND_ATOMS.items() for e in evs if not quote_on_page(e)]
check('reviewed compound atoms ("A1/A2L" -> A1, A2L) applied and their evidence found', all(CT['compounds'][raw]['atoms'] == atoms for raw, (atoms, _) in C.COMPOUND_ATOMS.items()) and not cev_bad, str(cev_bad))
# customer-text refusals (§C.10 layer 2) and reviewed value labels
rt = S.get('refused_customer_text', {'hits': [], 'uncovered': ['scan missing'], 'scanned': None})
rows_by_h = {r['handle']: r for r in rows}
uncov = [x for x in rt['hits'] if x.get('value_source_id') not in rows_by_h[x['handle']].get('value_labels', {})]
check('every customer-text refusal (titles, group and value names) is covered by a reviewed value label', not uncov and not rt['uncovered'],
      f"{len(rt['hits'])} hit(s) over {rt['scanned']}; uncovered {uncov}")
vl_bad = []
for r in rows:
    if not r.get('value_labels'):
        continue
    P = next(x for x in p0lib.load_all_cached() if x['sitemap_handle'] == r['handle'])['P']
    vids = {v['id']: g['propertyKeyId'] for g in P['options'] for v in g['values']}
    for vid, e in r['value_labels'].items():
        if vids.get(vid) != e['group_source_id']:
            vl_bad.append((r['handle'], vid, 'not a value of that group'))
        if not (e['name_en'] and e['name_ar'] and e['name_ckb']) or e['name_ckb'] == e['name_ar']:
            vl_bad.append((r['handle'], vid, 'ar/en/ckb'))
        for lang in ('name_en', 'name_ar', 'name_ckb'):
            if SC.text_refusal(e[lang]) or p0lib.availability_from_name(e[lang]):
                vl_bad.append((r['handle'], vid, lang + ' refused or reads as an order type'))
        if not quote_on_page({'handle': r['handle'], 'evidence_kind': 'description_text', 'quote': e['evidence']['quote']}):
            vl_bad.append((r['handle'], vid, 'evidence quote not on page'))
check('value labels: a value of the named group, ar/en/ckb with ckb != ar, pass the classifier and availabilityFromName, evidence on page', not vl_bad, str(vl_bad))
try:
    PR = J('parse-report.json')
    pr_bad = [i['handle'] for i in PR['items'] if any(hh.startswith('IMPORT_PAYLOAD_KEY_REFUSED') for hh in i.get('holds', []))
              and not rows_by_h[i['handle']].get('value_labels')]
    pr_hold = sorted({i['handle'] for i in PR['items'] if i.get('holds')})
    check('step-4 parse report: every allow-list refusal is a product with reviewed value labels (ORDER_TYPE_WORD stays a hold)',
          not pr_bad and all(rows_by_h[h].get('value_labels') or rows_by_h[h]['hold_code'] for h in pr_hold), f'report holds {pr_hold}; uncovered {pr_bad}')
except FileNotFoundError:
    check('step-4 parse report present', False)
# the real TypeScript classifier and validator (work/step4/check.ts, run before this script): same hits as the Python port, and the
# reviewed labels, applied in the option model (names, variant label, source label AND the image alt selection), clear the whole payload
try:
    TS = J(os.path.join('work', 'step4', 'check.json'))
    py_hits = sorted((x['handle'], x.get('value_source_id', ''), x['class']) for x in rt['hits'])
    ts_hits = sorted((x['handle'], x.get('value_source_id', ''), x['class']) for x in TS['hits'])
    check('classifier port == sentences.ts over every title, group and value (TypeScript run)', py_hits == ts_hits and TS['scanned'] == rt['scanned'],
          f'python {py_hits} / typescript {ts_hits}')
    a = TS['ams_2_pro']
    alts_listed = all({'images[].alt_en', 'images[].alt_ar', 'images[].alt_ckb'} <= set(e.get('applies_to', [])) for r in rows for e in (r.get('value_labels') or {}).values())
    check('ams-2-pro: with its value label applied in the option model the whole step-4 payload passes assertImportPayload; the label lists the alt texts',
          a['after_names_and_alts'] == 'ok' and not a['promotion_word_left_at'] and a['variants'] == 15 and alts_listed,
          f"names only: {a['after_names_only']}; with alts: {a['after_names_and_alts']} ({a['alt_fixed']} alt strings)")
    # both TypeScript runs (check.ts and the refreshed parse-report) used the same step-4 code; say whether it has moved since
    import hashlib

    def _step4_sha():
        root = '/home/user/levonis-import/packages/catalog/src/bambuImport'
        files = sorted(os.path.relpath(os.path.join(dp, n), root).replace(os.sep, '/') for dp, _, fn in os.walk(root) for n in fn)
        h = hashlib.sha256()
        for f in files:
            h.update(f.encode()); h.update(b'\0'); h.update(open(os.path.join(root, f), 'rb').read()); h.update(b'\0')
        return h.hexdigest()
    cs, ps = TS.get('step4_code', {}), PR.get('step4_code', {})
    check('the TypeScript check and the step-4 parse report ran against the same step-4 code', cs.get('sha256') and cs.get('sha256') == ps.get('sha256'),
          f"HEAD {cs.get('head')} + {cs.get('dirty_files_in_bambuImport')} uncommitted file(s), sha256 {str(cs.get('sha256'))[:12]}")
    try:
        _now = _step4_sha()
        print('NOTE step-4 code ' + ('unchanged since the TypeScript runs' if _now == cs.get('sha256') else
                                     'MOVED since the TypeScript runs (another session edits it): re-run work/step4/check.ts and corpus.ts before relying on them'))
    except OSError:
        pass
except FileNotFoundError:
    check('step-4 TypeScript check present (work/step4/check.json)', False)
# identity series: registry families (cross-checked against the step-4 registry when present) or a title-stated material
REG = '/home/user/levonis-import/packages/catalog/src/bambuImport/registry/models.ts'
reg_series = {}
if os.path.exists(REG):
    for mm in re.finditer(r"m\('([^']+)', 'printer', \[[^\]]*\], '([^']+)'\)", open(REG, encoding='utf-8').read()):
        reg_series[mm.group(1)] = mm.group(2)
reg_fams = set(reg_series.values()) | {'AMS Series'}
id_bad = []
for h, e in I['entries'].items():
    if e['family'] == 'bambu_filament':
        if e['series'] and not re.search(r'(?<![A-Za-z])' + re.escape(e['series']) + r'(?![A-Za-z])', e['evidence']['title'], re.I):
            id_bad.append(h)
    elif e['series'] and (e['series'] not in reg_fams or (e['model'] in reg_series and reg_series[e['model']] != e['series'])):
        id_bad.append(h)
    elif not e['series'] and e['model'] in reg_series:
        id_bad.append(h + ' (registry has a series)')
check('identity.series: registry family of the model (models.ts read: %s) or a title-stated material; never invented' % bool(reg_series), not id_bad, str(id_bad))
# taxonomy: printer nodes sit under a printer-technology leaf; «لكل السلاسل» holds only parts that fit every FDM family
pr_nodes = [c['key'] for c in T['create'] if c['is_printer_catalog'] and c['parent'] not in ('cat_printers_fdm', 'cat_printers_resin')]
check('new printer nodes are children of cat_printers_fdm / cat_printers_resin (template narrows to one technology)', not pr_nodes, str(pr_nodes))
common_bad = []
for r in rows:
    if r['leaf'] != '@parts-common':
        continue
    labels = [x[0] for x in facts[r['handle']]['compat_raw']]
    fams = TX.families(labels)
    if labels and 'common' not in fams and not (fams - {'ams'}) >= TX.FDM_FAMILIES:
        common_bad.append(r['handle'])
check('@parts-common holds only all-series parts', not common_bad, f"{sum(1 for r in rows if r['leaf'] == '@parts-common')} members; bad {common_bad}")
# sku codes
bad_s = []
for r in rows:
    vids = set(facts[r['handle']].get('variant_ids', [])) if 'variant_ids' in facts[r['handle']] else None
check('sku codes frozen only for own variant ids (checked at harvest)', S['sku_codes']['unmatched'] == {} and not S['sku_codes']['conflicts'])
# no commerce data in outputs
FORBID_KEY = re.compile(r'price|cost|stock|inventor|discount|msrp|currency|coupon|margin|profit|wallet|availableStock|trackingQuantity', re.I)
MONEY = re.compile(r'(?:US)?\$\s?\d|\d\s?(USD|dollars)\b')
def walk(v, path, hits):
    if isinstance(v, dict):
        for k, x in v.items():
            if FORBID_KEY.search(k):
                hits.append(path + '.' + k)
            walk(x, path + '.' + k, hits)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            walk(x, path, hits)
    elif isinstance(v, str) and MONEY.search(v):
        hits.append(path + ': ' + v[:60])
hits = []
for n in ('manifest.json', 'taxonomy-map.json', 'compat-targets.json', 'identity-map.json', 'media-overrides.json', 'search-synonyms.json', 'scans.json'):
    walk(J(n), n, hits)
for n in ('scans.md', 'owner-questions.md'):
    t = open(os.path.join(P0, n), encoding='utf-8').read()
    hits += [n + ': ' + m.group(0) for m in MONEY.finditer(t)]
check('no price/cost/stock/discount key and no money amount in any output', not hits, str(hits[:5]))
cls_hits = []


def walk_cls(v, path):
    if isinstance(v, dict):
        for k, x in v.items():
            walk_cls(x, path + '.' + k)
    elif isinstance(v, list):
        for x in v:
            walk_cls(x, path + '[]')
    elif isinstance(v, str) and SC.text_refusal(v, 'owner'):
        cls_hits.append(path + ' (' + SC.text_refusal(v, 'owner') + ')')


for n in ('manifest.json', 'taxonomy-map.json', 'compat-targets.json', 'identity-map.json', 'media-overrides.json', 'search-synonyms.json', 'scans.json'):
    walk_cls(J(n), n)
check('no money / promotion / shipping-policy sentence (§C.10 classifier) in any JSON draft', not cls_hits, str(cls_hits[:5]))
# synonyms
bad_y = [y['term'] for y in SY['rows'] if not y['canonical'] or y['lang'] not in ('ar', 'ckb')]
check('synonyms: ar/ckb only, canonical present in the catalogue', not bad_y and not SY['dropped_canonical_not_in_catalogue'], f"{len(SY['rows'])} rows")
fails = [r for r in res if not r[1]]
print('\n%d checks, %d failed' % (len(res), len(fails)))
json.dump([{'check': a, 'pass': b, 'detail': c} for a, b, c in res], open(os.path.join(P0, 'work', 'verify.json'), 'w'), indent=1)
