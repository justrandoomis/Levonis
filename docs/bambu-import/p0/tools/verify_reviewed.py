"""P0 step 3 e: the three reviewed files against the sealed live snapshot and the manifest (HANDOFF-PLAN §3.5 step 7).

Run through verify.py (the P0 exit checks), in the agent's sandbox only:

    python3 -I docs/bambu-import/p0/tools/verify.py --snapshot <snapshot.json> --sealed <snapshot.sealed> \
        [--data data/bambu-import] [--manifest docs/bambu-import/p0/manifest.json] \
        [--pages <dir of parsed option structures>] [--candidates <match-candidates output>] [--review <private review>]

The snapshot (workflow 60 mode=snapshot, opened with unseal.mjs) holds hidden and draft products, so this prints
check names, counts, public source handles and Levonis ids only: never a name, a slug of a non-active product, an
option or colour name, or anything else from the snapshot. It writes nothing.

Files checked (spec §A.3, §A.8, §B.6, §D.2, §E.1; worker/lib/catalogImport/reviewed.ts):
  data/bambu-import/existing-matches.json   one entry per source: ids, a public slug (active targets only), a
                                            decision, a reason code, and for a merge the value map
  data/bambu-import/compat-targets.json     every snapshot member resolved
  data/bambu-import/taxonomy-map.json       snapshot_sha256, existing catalog ids, free slugs and cat_bi_<key> ids

The value map rule (also used to build the file): a source variant maps when every value of a source group that
has a counterpart on the target maps to exactly one ACTIVE option value or ACTIVE colour of that target:
  - an option value by its exact name, else by the one widening the integrator approved (2026-10-16): the names
    are equal after case-folding and removing whitespace and the separators - – — · , / ( )  ("0.2mm Stainless
    Steel" = "0.2 mm — Stainless Steel"; nothing semantic: "P1S AMS 2 Pro Combo" is not "P1S AMS 2 Combo", and a
    part code is not a name);
  - a colour by its exact name, or the same Bambu colour code "(NNNNN)", or the colour name without its code when
    the Levonis colour carries none; then, by the integrator's second approval, the same names case-insensitively
    ("Lilac purple (11700)" = "Lilac Purple");
  - a source "Printer Model" group with no counterpart on the target is compatibility, not a dimension (third
    approval): variants that differ only in it are one choice. Flow Type and every other group stay dimensions.
A source group none of whose values has a counterpart is not a dimension of the target and is not read. A variant
that maps to nothing, or whose option values another source choice also maps to (two source choices on one existing
value: Flow Type's Standard and High Flow on one size), is unmapped. Colour-only targets may repeat (a colour is
shared by its refill and spool variants).
"""
import hashlib, json, os, re, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
MATCH_ROOT_KEYS = {'version', 'status', 'reviewed_by', 'reviewed_at', 'snapshot_sha256', 'entries'}
MATCH_KEYS = ['source_product_id', 'source_handle', 'levonis_product_id', 'levonis_slug', 'decision', 'value_map',
              'unmapped_variants', 'reason', 'reviewed_by', 'reviewed_at', 'approval_ref']
DECISIONS = ['merge', 'merge_publish', 'distinct', 'not_bambu', 'hold_owner_hidden']
REASONS = ['same_model', 'different_generation', 'different_bundle', 'not_bambu_product', 'owner_decision']
NODE_REF = re.compile(r'^(?:@[a-z0-9][a-z0-9-]*|cat_[a-z0-9_]+)$')
ARABIC = re.compile('[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]')
BAMBU_CDN = re.compile(r'^https://(store\.bblcdn\.com|cdn\.shopify\.com)/')
# Model tokens of the Levonis models compat-targets.json once expected (registry spelling, case-insensitive).
MODEL_TOKENS = {
    'X1C': re.compile(r'\bx1[ -]?c(?:arbon)?\b', re.I),
    'X1E': re.compile(r'\bx1[ -]?e\b', re.I),
    'P1P': re.compile(r'\bp1[ -]?p\b', re.I),
    'P1S': re.compile(r'\bp1[ -]?s\b', re.I),
    'X1': re.compile(r'\bx1\b(?![ -]?(?:c|e|carbon)\b)', re.I),
}


def clean(s):
    return unicodedata.normalize('NFC', re.sub(r'\s+', ' ', s or '').strip())


_CODE = re.compile(r'\s*\((\d{5})\)\s*$')


def code_of(s):
    m = _CODE.search(clean(s))
    return m.group(1) if m else None


def strip_code(s):
    return _CODE.sub('', clean(s)).strip()


_SEPARATORS = re.compile(r'[\s\-\u2013\u2014\u00b7,/()]+')


def loose_name(s):
    """The approved widening for option values: case-folded, without whitespace and the separators - – — · , / ( )."""
    return _SEPARATORS.sub('', clean(s)).casefold()


def taxonomy_node_id(key):
    """worker/lib/catalogImport/reviewed.ts taxonomyNodeId."""
    return 'cat_bi_' + re.sub(r'[^a-z0-9]+', '_', re.sub(r'^@', '', key))


def catalog_id_of(ref):
    return taxonomy_node_id(ref) if ref.startswith('@') else ref


def value_map_for(page, option_values, colours):
    """The value map of one merge: (value_map, unmapped, info). `page` is the parsed option structure
    ({groups: [{label, kind, values: [{text}]}], skus: [{id, props: [{key, value}]}]}); `option_values` and
    `colours` are the target's snapshot rows (all statuses: only active ones are matched)."""
    act_ovs = [v for v in option_values if v['active'] == 1]
    act_cols = [c for c in colours if c['active'] == 1]
    gmatch, counterpart, tiers = {}, {}, {}
    for g in page['groups']:
        label = clean(g['label'])
        hits = {}
        for v in g['values']:
            t = clean(v['text'])
            found = []
            if g['kind'] == 'color':
                for c in act_cols:
                    n = clean(c['name_en'])
                    if n == t:
                        found.append(('c', c['id'], 'exact'))
                    elif code_of(t) and code_of(n) == code_of(t):
                        found.append(('c', c['id'], 'colour_code'))
                    elif code_of(t) and not code_of(n) and n == strip_code(t):
                        found.append(('c', c['id'], 'name_without_code'))
                if not found:
                    # The integrator's second approval (2026-10-16): colour names compare case-insensitively (case only).
                    for c in act_cols:
                        n = clean(c['name_en'])
                        if n.casefold() == t.casefold():
                            found.append(('c', c['id'], 'case'))
                        elif code_of(t) and not code_of(n) and n.casefold() == strip_code(t).casefold():
                            found.append(('c', c['id'], 'name_without_code_case'))
            else:
                found = [('o', o['value_id'], 'exact') for o in act_ovs if clean(o['name_en']) == t]
                if not found:
                    found = [('o', o['value_id'], 'separators_case') for o in act_ovs if loose_name(o['name_en']) == loose_name(t)]
            if len(found) == 1:
                hits[t] = found[0]
        claimed = {}
        for t, h in hits.items():
            claimed.setdefault(h[1], []).append(t)
        for ts in claimed.values():
            if len(ts) > 1:
                for t in ts:
                    hits.pop(t, None)
        counterpart[label] = bool(hits)
        for t, h in hits.items():
            gmatch[(label, t)] = h
    # The integrator's third approval (2026-10-16): a source "Printer Model" group with no counterpart on the target is
    # compatibility, not a dimension — variants that differ only in it are one choice of the target (a hotend sold per
    # printer). Every other group without a counterpart (Flow Type) still counts in the conflation rule below.
    compat_only = {clean(g['label']) for g in page['groups'] if clean(g['label']).casefold() == 'printer model' and not counterpart[clean(g['label'])]}
    vm, unmapped, keys = {}, [], {}
    for sku in page['skus']:
        ids, colour, ok = [], None, True
        for p in sku['props']:
            lab, t = clean(p['key']), clean(p['value'])
            if lab not in counterpart:
                ok = False
                break
            if not counterpart[lab]:
                continue
            h = gmatch.get((lab, t))
            if not h:
                ok = False
                break
            tiers[h[2]] = tiers.get(h[2], 0) + 1
            if h[0] == 'c':
                colour = h[1]
            else:
                ids.append(h[1])
        if not ok or (not ids and not colour):
            unmapped.append(sku['id'])
            continue
        e = {}
        if ids:
            e['option_value_ids'] = sorted(ids)
        if colour:
            e['color_id'] = colour
        vm[sku['id']] = e
        choice = tuple((clean(p['key']), clean(p['value'])) for p in sku['props'] if clean(p['key']) not in compat_only)
        keys.setdefault((tuple(sorted(ids)), colour), {}).setdefault(choice, []).append(sku['id'])
    for (ids, _colour), choices in keys.items():
        if ids and len(choices) > 1:
            for sids in choices.values():
                for sid in sids:
                    vm.pop(sid, None)
                    unmapped.append(sid)
    order = {s['id']: i for i, s in enumerate(page['skus'])}
    vm = {k: vm[k] for k in sorted(vm, key=lambda k: order[k])}
    unmapped = sorted(set(unmapped), key=lambda k: order[k])
    return vm, unmapped, {'tiers': tiers, 'colour_only': sum(1 for e in vm.values() if 'option_value_ids' not in e)}


def _arg(argv, name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


def main(argv):
    res = []

    def check(name, ok, detail=''):
        res.append((name, bool(ok), detail))
        print(('PASS ' if ok else 'FAIL ') + name + (' — ' + detail if detail else ''))

    pending = []

    def pend(name, detail):
        pending.append(name)
        print('PENDING ' + name + ' — ' + detail)

    snap_path = _arg(argv, '--snapshot')
    sealed = _arg(argv, '--sealed')
    data = _arg(argv, '--data', os.path.join(ROOT, 'data', 'bambu-import'))
    manifest_path = _arg(argv, '--manifest')
    if not manifest_path:
        dm = os.path.join(data, 'manifest.json')
        manifest_path = dm if json.load(open(dm, encoding='utf-8')).get('rows') else os.path.join(ROOT, 'docs', 'bambu-import', 'p0', 'manifest.json')
    pages = _arg(argv, '--pages')
    cand_path = _arg(argv, '--candidates')
    review_path = _arg(argv, '--review')
    if not snap_path or not sealed:
        print('usage: verify.py --snapshot <snapshot.json> --sealed <snapshot.sealed> [--data DIR] [--manifest FILE] [--pages DIR] [--candidates FILE] [--review FILE]')
        return 2

    snap = json.load(open(snap_path, encoding='utf-8'))
    S = snap['tables']
    sealed_sha = hashlib.sha256(open(sealed, 'rb').read()).hexdigest()
    texts = {f: open(os.path.join(data, f), encoding='utf-8').read() for f in ('existing-matches.json', 'compat-targets.json', 'taxonomy-map.json')}
    EM, CT, T = (json.loads(texts[f]) for f in ('existing-matches.json', 'compat-targets.json', 'taxonomy-map.json'))
    rows = json.load(open(manifest_path, encoding='utf-8'))['rows']
    by_sid = {r['source_product_id']: r for r in rows}
    by_handle = {r['handle']: r for r in rows}
    P = {p['id']: p for p in S['products']}
    ovs_of, cols_of = {}, {}
    for v in S['option_values']:
        ovs_of.setdefault(v['product_id'], []).append(v)
    for c in S['colors']:
        cols_of.setdefault(c['product_id'], []).append(c)
    cats = {c['id']: c for c in S['catalogs']}
    active = lambda pid: P.get(pid, {}).get('status') == 'active'
    print('inputs: snapshot %s (%d products, %d catalogs), sealed sha256 %s…, manifest %d rows' % (
        snap.get('taken_at', '?'), len(S['products']), len(S['catalogs']), sealed_sha[:12], len(rows)))

    # ------------------------------------------------------------------ existing-matches.json
    entries = EM.get('entries', [])
    shape_bad = [k for k in EM if k not in MATCH_ROOT_KEYS]
    seen = set()
    for i, e in enumerate(entries):
        shape_bad += ['%d.%s' % (i, k) for k in e if k not in MATCH_KEYS]
        if not (isinstance(e.get('source_product_id'), str) and re.fullmatch(r'\d{1,24}', e['source_product_id'])):
            shape_bad.append('%d.source_product_id' % i)
        if e.get('source_product_id') in seen:
            shape_bad.append('%d duplicate source' % i)
        seen.add(e.get('source_product_id'))
        if e.get('decision') not in DECISIONS or e.get('reason') not in REASONS:
            shape_bad.append('%d decision/reason' % i)
    check('matches: version 1, only the allowed keys, decision and reason codes from the fixed lists, one entry per source',
          EM.get('version') == 1 and not shape_bad, '%d entries; %s' % (len(entries), shape_bad[:5]))
    check('matches: snapshot_sha256 is the sealed file\'s SHA-256', EM.get('snapshot_sha256') == sealed_sha)
    bad = [e['source_handle'] for e in entries if by_sid.get(e['source_product_id'], {}).get('handle') != e['source_handle']]
    check('matches: every source is a manifest row under the same handle', not bad, str(bad[:5]))
    bad = [e['levonis_product_id'] for e in entries if e['levonis_product_id'] not in P]
    check('matches: every Levonis id exists in the snapshot', not bad, str(bad[:5]))
    bad = []
    for e in entries:
        a = active(e['levonis_product_id'])
        d = e['decision']
        if (d == 'merge' and not a) or (d in ('hold_owner_hidden', 'merge_publish') and a) or (d == 'merge_publish' and not e.get('approval_ref')):
            bad.append(e['source_handle'])
    check('matches: merge only into an active product; hold_owner_hidden / merge_publish only for a non-active one (L-7)', not bad, str(bad))
    bad = []
    for e in entries:
        a = active(e['levonis_product_id'])
        if 'levonis_slug' in e and (not a or e['levonis_slug'] != P[e['levonis_product_id']]['slug']):
            bad.append(e['source_handle'] + ' (slug)')
        if e['decision'] == 'merge' and 'levonis_slug' not in e:
            bad.append(e['source_handle'] + ' (merge without its public slug)')
        if e['decision'] == 'hold_owner_hidden' and any(k in e for k in ('levonis_slug', 'value_map', 'unmapped_variants', 'approval_ref')):
            bad.append(e['source_handle'] + ' (a held non-active target carries more than its id)')
        if e['decision'] == 'merge_publish' and not ('value_map' in e and 'unmapped_variants' in e):
            bad.append(e['source_handle'] + ' (merge_publish without its value map)')
    check('matches: a slug only for an active target and equal to it (never for merge_publish, §A.8 line 317); a held target carries its id only',
          not bad, str(bad[:5]))
    decisions_md = os.path.join(ROOT, 'docs', 'DECISIONS.md')
    rows_md = set(re.findall(r'^\| (\d+) \|', open(decisions_md, encoding='utf-8').read(), re.M)) if os.path.exists(decisions_md) else set()
    bad = [e['source_handle'] for e in entries if e['decision'] == 'merge_publish'
           and not (re.fullmatch(r'DECISIONS row (\d+)', e.get('approval_ref', '')) and re.fullmatch(r'DECISIONS row (\d+)', e['approval_ref']).group(1) in rows_md)]
    check('matches: every merge_publish names the owner\'s approval as an existing docs/DECISIONS.md row', not bad,
          '%d merge_publish; refs %s; bad %s' % (sum(1 for e in entries if e['decision'] == 'merge_publish'),
                                                 sorted({e['approval_ref'] for e in entries if e.get('approval_ref')}), bad[:5]))
    bad = []
    for e in entries:
        pid = e['levonis_product_id']
        okv = {v['value_id'] for v in ovs_of.get(pid, []) if v['active'] == 1}
        okc = {c['id'] for c in cols_of.get(pid, []) if c['active'] == 1}
        vm = e.get('value_map', {})
        for sid, m in vm.items():
            if not m or any(x not in okv for x in m.get('option_value_ids', [])) or (m.get('color_id') and m['color_id'] not in okc):
                bad.append('%s:%s' % (e['source_handle'], sid))
        if set(vm) & set(e.get('unmapped_variants', [])):
            bad.append(e['source_handle'] + ' (mapped and unmapped)')
    check('matches: every value_map target is an ACTIVE option value or colour of that very product; mapped and unmapped disjoint', not bad, str(bad[:5]))
    if pages:
        bad, cov = [], {'variants': 0, 'mapped': 0, 'unmapped': 0, 'colour_only': 0}
        tiers = {}
        for e in entries:
            if e['decision'] not in ('merge', 'merge_publish'):
                continue
            pf = os.path.join(pages, e['source_handle'] + '.json')
            if not os.path.exists(pf):
                bad.append(e['source_handle'] + ' (page not parsed)')
                continue
            page = json.load(open(pf, encoding='utf-8'))
            sids = [s['id'] for s in page['skus']]
            if page.get('source_product_id') != e['source_product_id']:
                bad.append(e['source_handle'] + ' (page names another product)')
            vm, un, info = value_map_for(page, ovs_of.get(e['levonis_product_id'], []), cols_of.get(e['levonis_product_id'], []))
            if sorted(list(e.get('value_map', {})) + e.get('unmapped_variants', [])) != sorted(sids):
                bad.append(e['source_handle'] + ' (not every source variant accounted for)')
            if vm != e.get('value_map', {}) or un != e.get('unmapped_variants', []):
                bad.append(e['source_handle'] + ' (differs from the exact-name rule)')
            cov['variants'] += len(sids)
            cov['mapped'] += len(vm)
            cov['unmapped'] += len(un)
            cov['colour_only'] += info['colour_only']
            for k, n in info['tiers'].items():
                tiers[k] = tiers.get(k, 0) + n
        check('matches: every merge / merge_publish accounts for each source variant of its parsed page, and its value map is the reviewed rule\'s',
              not bad, '%s; source values matched (before the conflation rule) by %s; %s' % (cov, tiers, bad[:5]))
    else:
        pend('matches: value maps recomputed from the parsed pages', 'pass --pages to recompute them')
    # every Bambu-signal product of the snapshot is either a target or a reviewed non-target
    bambu = {b['id'] for b in S['brands'] if b['slug'] == 'bambu-lab'}
    cdn = {s['product_id'] for s in S['image_sources'] if BAMBU_CDN.match(s['source_url'])}
    signal = {p['id'] for p in S['products'] if p['brand_id'] in bambu or p['id'] in cdn or re.search('bambu', p['name'] or '', re.I)}
    targets = [e['levonis_product_id'] for e in entries]
    review = json.load(open(review_path, encoding='utf-8')) if review_path else {}
    not_targets = review.get('not_targets', {})
    uncovered = sorted(signal - set(targets) - set(not_targets))
    check('matches: every snapshot product with a Bambu signal (brand, Bambu CDN image, name) is the target of one entry or a reviewed non-target',
          not uncovered and len(targets) == len(set(targets)) and not (set(targets) & set(not_targets)),
          '%d with a signal: %d targets, %d reviewed non-targets (%s), %d uncovered' % (
              len(signal), len(set(targets) & signal), len(set(not_targets) & signal),
              ', '.join(sorted({v['decision'] for v in not_targets.values()})) or '-', len(uncovered)))
    bad = [e['source_handle'] for e in entries if P[e['levonis_product_id']]['brand_id'] not in bambu]
    check('matches: every target is a Bambu Lab product', not bad, str(bad))
    if cand_path:
        cands = {c['levonis_product_id']: {x['handle'] for x in c['candidates']} for c in json.load(open(cand_path, encoding='utf-8'))['products']}
        bad = [e['source_handle'] for e in entries if e['source_handle'] not in cands.get(e['levonis_product_id'], set())]
        bad += ['%s (non-target)' % v['source_handle'] for k, v in not_targets.items() if v['source_handle'] not in cands.get(k, set())]
        check('matches: every pairing is a candidate of scripts/bambu-import/match-candidates.ts (§E.1 signals)', not bad, str(bad))
    else:
        pend('matches: pairings against match-candidates.ts', 'pass --candidates')
    held = [e for e in entries if e['decision'] == 'hold_owner_hidden']
    not_free = max((r['queue_position'] for r in rows if not r.get('hold_code')), default=0)
    mis = [e['source_handle'] for e in held if by_sid[e['source_product_id']].get('hold_code') != 'OWNER_HIDDEN' or by_sid[e['source_product_id']]['queue_position'] < not_free]
    audit = [e['source_handle'] for e in held if by_sid[e['source_product_id']].get('audit_classes')]
    merged_audit = [e['source_handle'] for e in entries if e['decision'] == 'merge' and by_sid[e['source_product_id']].get('audit_classes')]
    if mis:
        pend('manifest: every hold_owner_hidden source carries hold_code OWNER_HIDDEN and is queued last (§J.4, owner-questions H-2)',
             '%d of %d held sources not yet held in the manifest (%d of them audit-class rows; %d audit-class rows are merges) — '
             'integrator, before step 9: the Worker refuses their create (OWNER_HIDDEN) already, but a BLOCKED item stops the queue at its position' % (
                 len(mis), len(held), len(audit), len(merged_audit)))
    else:
        check('manifest: every hold_owner_hidden source is held and queued last', True)

    # ------------------------------------------------------------------ compat-targets.json
    check('compat: snapshot_sha256 is the sealed file\'s SHA-256', CT.get('snapshot_sha256') == sealed_sha)
    left = [m for m in ('resolve_from', 'step2_snapshot', '"pending"') if m in texts['compat-targets.json']]
    ids, handles, nulls = set(), set(), []

    def visit(v, path):
        if isinstance(v, list):
            for i, x in enumerate(v):
                visit(x, path + '[%d]' % i)
        elif isinstance(v, dict):
            for k, x in v.items():
                if k in ('evidence', 'usage_evidence'):
                    continue
                if k == 'levonis_product_id':
                    if x:
                        ids.add(x)
                    else:
                        nulls.append(path)
                elif k == 'source_handle' and isinstance(x, str):
                    handles.add(x)
                else:
                    visit(x, path + '.' + k)
    for table in ('labels', 'requirement_targets'):
        visit(CT.get(table, {}), table)
    check('compat: no member left waiting for the snapshot (no resolve_from, no pending, no null Levonis id)', not left and not nulls, str(left + nulls[:3]))
    check('compat: every Levonis target id exists in the snapshot and is active', all(active(i) for i in ids), '%d ids' % len(ids))
    check('compat: every source target is a manifest handle', handles <= set(by_handle), '%d handles; unknown %s' % (len(handles), sorted(handles - set(by_handle))[:5]))
    merges = {e['source_handle']: e['levonis_product_id'] for e in entries if e['decision'] in ('merge', 'merge_publish')}
    bad = []
    for model, v in CT.get('levonis_existing_printers', {}).items():
        tok = MODEL_TOKENS.get(model)
        carriers = [p['id'] for p in S['products'] if tok and (tok.search(p['name'] or '') or tok.search((p['slug'] or '').replace('-', ' ')))]
        if v.get('resolution') == 'not_in_levonis':
            if v.get('levonis_product_id') is not None or carriers:
                bad.append(model)
        elif v.get('resolution') == 'merged_source':
            if merges.get(v.get('source_handle')) != v.get('levonis_product_id') or not active(v.get('levonis_product_id')):
                bad.append(model)
        else:
            bad.append(model + ' (unresolved)')
    check('compat: each formerly expected Levonis model is either absent from the whole snapshot or the merge target of its source',
          not bad, '%s' % ({m: v.get('resolution') for m, v in CT.get('levonis_existing_printers', {}).items()}))
    held_handles = {e['source_handle'] for e in held}
    waits = sorted(handles & held_handles)
    print('NOTE compat: %d source targets are owner-hidden holds; relations naming them stay pending until the owner decides' % len(waits))

    # ------------------------------------------------------------------ taxonomy-map.json
    check('taxonomy: snapshot_sha256 is the sealed file\'s SHA-256', T.get('snapshot_sha256') == sealed_sha)
    keys = [n['key'] for n in T['create']]
    bad = []
    for n in T['create']:
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', n['key']) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', n['slug']):
            bad.append(n['key'] + ' (key/slug shape)')
        if n.get('template_family') not in ('devices', 'materials') or n.get('is_printer_catalog') not in (0, 1):
            bad.append(n['key'] + ' (family/printer flag)')
        if not (n['name_ar'] and n['name_en'] and n['name_ckb']) or (n['name_ar'] == n['name_ckb'] and ARABIC.search(n['name_ar'])):
            bad.append(n['key'] + ' (ar/en/ckb, row 183)')
    refs = [n['parent'] for n in T['create']]
    for r in T['routes'].values():
        refs += [r['primary']] + r.get('also', [])
    refs += [h['primary'] for h in T['handles'].values()]
    refs += [a['also'] for lst in T['also_by_handle'].values() for a in lst]
    refs += [r['leaf'] for r in rows if r.get('leaf')] + [a for r in rows for a in r.get('also', [])]
    bad += [x + ' (not a node reference)' for x in set(refs) if not NODE_REF.match(x)]
    check('taxonomy: the shape reviewed.ts reads (keys, slugs, template family, printer flag, ar/en/ckb with ckb never the Arabic)', not bad and len(set(keys)) == len(keys), str(bad[:5]))
    seeded = sorted({x for x in refs if x.startswith('cat_')})
    missing = [x for x in seeded if x not in cats or cats[x]['active'] != 1]
    check('taxonomy: every seeded catalog the map or the manifest names exists in the snapshot and is active', not missing, '%d ids; missing/inactive %s' % (len(seeded), missing))
    unknown = sorted({x for x in refs if x.startswith('@') and x[1:] not in keys})
    check('taxonomy: every @key reference names a node the map creates', not unknown, str(unknown))
    slugs = [n['slug'] for n in T['create']]
    taken = sorted(set(slugs) & {c['slug'] for c in S['catalogs']})
    check('taxonomy: every new slug is free in the snapshot and unique in the map', not taken and len(set(slugs)) == len(slugs), '%d slugs; taken %s' % (len(slugs), taken))
    new_ids = [taxonomy_node_id(k) for k in keys]
    check('taxonomy: every new id cat_bi_<key> is free in the snapshot and unique', not (set(new_ids) & set(cats)) and len(set(new_ids)) == len(new_ids), '%d ids' % len(new_ids))
    bad = []
    for n in T['create']:
        par = n['parent']
        fam, pic = (cats[par]['template_family'], cats[par]['is_printer_catalog']) if par in cats else next(((m['template_family'], m['is_printer_catalog']) for m in T['create'] if m['key'] == par[1:]), (None, None))
        if fam != n['template_family'] or (n['is_printer_catalog'] == 1 and pic != 1):
            bad.append(n['key'])
    check('taxonomy: a new node takes its parent\'s template family, and is a printer node only under a printer node', not bad, str(bad))

    def resolve(h, rt):
        prim, also = None, []
        parts = rt.split('>') if rt else []
        for i in range(len(parts), 0, -1):
            hit = T['routes'].get('>'.join(parts[:i]))
            if hit:
                prim, also = hit['primary'], hit.get('also', [])
                break
        if h in T['handles']:
            prim = T['handles'][h]['primary']
        if not prim:
            return None, []
        sec = []
        for a in also + [x['also'] for x in T['also_by_handle'].get(h, [])]:
            if catalog_id_of(a) != catalog_id_of(prim) and catalog_id_of(a) not in sec:
                sec.append(catalog_id_of(a))
        return catalog_id_of(prim), sec
    bad, count = [], {}
    for r in rows:
        prim, sec = resolve(r['handle'], r['currentAllIdRoute'])
        if prim is None or (r.get('leaf') and prim != catalog_id_of(r['leaf'])):
            bad.append(r['handle'])
        for c in [prim] + sec:
            count[c] = count.get(c, 0) + 1
    worst = max(count.items(), key=lambda kv: kv[1]) if count else ('-', 0)
    check('taxonomy: every manifest row resolves (handle override, then the deepest route) to its reviewed leaf; no leaf over leaf_limit',
          not bad and worst[1] <= T.get('leaf_limit', 250), '%d rows; largest leaf %s with %d; bad %s' % (len(rows), worst[0], worst[1], bad[:5]))

    # ------------------------------------------------------------------ privacy (§A.8)
    public = set(by_handle) | set(T.get('collections', {}))
    leaks = 0
    na = [p for p in S['products'] if p['status'] != 'active']
    checked = 0
    for p in na:
        for f, v in (('name', p['name']), ('name_ar', p['name_ar']), ('name_ku', p['name_ku']), ('sku', p['sku'])):
            if v and len(v) >= 3:
                checked += 1
                leaks += sum(t.count(v) for t in texts.values())
        if p['slug']:
            checked += 1
            for t in texts.values():
                for m in re.finditer(re.escape(p['slug']), t):
                    a, b = t.rfind('"', 0, m.start()), t.find('"', m.end())
                    if t[a + 1:b] not in public:
                        leaks += 1
    for c in S['catalogs']:
        if c['active'] != 1:
            for v in (c['name_en'], c['name_ar'], c['name_ckb'], c['slug']):
                if v:
                    checked += 1
                    leaks += sum(t.count(v) for t in texts.values())
    # Option and colour ids of a non-active product appear only in the value map of the merge_publish entry that
    # publishes that very product (the owner's decision); never anywhere else.
    publishing = {e['levonis_product_id'] for e in entries if e['decision'] == 'merge_publish'}
    hidden_ids = {v['value_id'] for p in na if p['id'] not in publishing for v in ovs_of.get(p['id'], [])} | {
        c['id'] for p in na if p['id'] not in publishing for c in cols_of.get(p['id'], [])}
    in_map = {x for e in entries for m in e.get('value_map', {}).values() for x in m.get('option_value_ids', []) + ([m['color_id']] if m.get('color_id') else [])}
    check('privacy: no name, SKU or slug of a non-active product (outside the public Bambu handles), no inactive catalog, no option or colour id of a non-active product outside its own merge_publish entry',
          leaks == 0 and not (hidden_ids & in_map), '%d non-active products (%d being published), %d strings checked, %d hits' % (len(na), len(publishing), checked, leaks))
    forbid = re.compile(r'price|cost|stock|inventor|discount|msrp|currency|coupon|margin|profit|wallet|order', re.I)
    keys_hit = []

    def walk(v, path):
        if isinstance(v, dict):
            for k, x in v.items():
                if forbid.search(k):
                    keys_hit.append(path + '.' + k)
                walk(x, path + '.' + k)
        elif isinstance(v, list):
            for x in v:
                walk(x, path)
    for n, j in (('existing-matches', EM), ('compat-targets', CT), ('taxonomy-map', T)):
        walk(j, n)
    money = [n for n, t in texts.items() if re.search(r'(?:US)?\$\s?\d|\d\s?(USD|IQD|dollars)\b', t)]
    check('privacy: no price, cost, stock, order or money key or amount in the three files', not keys_hit and not money, str(keys_hit[:5] + money))

    fails = [r for r in res if not r[1]]
    print('\n%d checks, %d failed, %d pending' % (len(res), len(fails), len(pending)))
    return 1 if fails else 0
