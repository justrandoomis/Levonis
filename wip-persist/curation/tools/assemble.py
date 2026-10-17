#!/usr/bin/env python3
"""Offline: join plan.json with docs/index.json into curation/docs-by-product.json (the hand-off for the curators)."""
import json, os

C = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad/curation'
plan = json.load(open(f'{C}/plan.json'))
index = json.load(open(f'{C}/docs/index.json'))
out = []
COMPONENT_OF = {
    'hwb-pumpkinfamily': ('pla-basic-filament', 'page text: "PLA Basic - Pumpkin Orange (10301)", "PLA Basic - Bambu Green (10501)"'),
    'hwb-hauntedhouse': ('pla-basic-filament', 'page text: Black PLA Basic and "PLA Basic - Jade White (10100)"'),
    'pla-cmyk-lithophane': ('pla-basic-filament', 'page text: "PLA Basic Cyan #0086D6", "PLA Basic Magenta #EC008C", "PLA Basic Yellow #F4EE2A", "PLA Basic White #FFFFFF" (hex inline on the store page)'),
}
for h, e in plan.items():
    docs, missing = [], list(e['missing'])
    kinds = set()
    for d in e['docs']:
        rec = index.get(d['url'])
        if d['kind'] == 'tracker':
            if rec and rec.get('redirects'):
                loc, hops = rec['redirects'][0]['location'], 0
                while hops < 3:  # chain the no-follow HEAD records (a canonicalisation hop, then the target)
                    nxt = index.get(loc.replace('http://', 'https://', 1))
                    if not nxt or not nxt.get('redirects'):
                        break
                    loc, hops = nxt['redirects'][0]['location'], hops + 1
                cached = index.get(loc, {}).get('status') == 200
                missing.append(f'tracker_resolved: {d["url"]} -> {loc}' + ('' if cached else ' (maintenance page, not a spec source: not cached)'))
            else:
                missing.append(f'tracker_unresolved: {d["url"]} (status {rec.get("status") if rec else "not fetched"})')
            continue
        if not rec or rec.get('status') != 200 or not rec.get('file') or not os.path.exists(rec['file']):
            st = rec.get('status') if rec else 'not_fetched'
            why = ('host answered 403 to robots.txt (not an S3 missing-object body); host not contacted again, never bypassed' if rec and rec.get('host_blocked_403')
                   else 'robots_disallowed' if rec and rec.get('robots_disallowed') else f'status {st}')
            missing.append(f'fetch_failed:{d["kind"]}:{d["url"]} ({why})')
            continue
        text = rec.get('text') or rec['file']
        png = rec['file'][:-4] + '.page-1.png'
        if rec['file'].endswith('.pdf') and os.path.exists(png) and (not rec.get('text') or os.path.getsize(rec['text']) < 50):
            text = png
            missing.append(f'pdf_image_only_text_empty: {d["url"]} (no text layer; read the rendered page {png})')
        item = {'kind': d['kind'], 'url': d['url'], 'file': rec['file'], 'text': text}
        if text == rec.get('text') and d['kind'] in ('tds', 'sds', 'hex', 'spec_pdf') and (not rec.get('text') or os.path.getsize(rec['text']) < 50):
            missing.append(f'pdf_text_empty_or_image_only:{d["url"]} (needs OCR / visual read of {rec["file"]})')
        docs.append(item)
        kinds.add(d['kind'])
    t = e['type']
    if h in COMPONENT_OF:
        src = plan[COMPONENT_OF[h][0]]
        for d in src['docs']:
            rec = index.get(d['url'])
            if d['kind'] in ('tds', 'sds', 'hex') and rec and rec.get('status') == 200:
                docs.append({'kind': d['kind'], 'url': d['url'], 'file': rec['file'], 'text': rec.get('text') or rec['file']})
                kinds.add(d['kind'])
        missing.append(f'own_tds_sds_hex_not_linked_by_store_page: the {t} page links no TDS/SDS/hex; the PLA Basic component documents are listed instead ({COMPONENT_OF[h][1]})')
    if h == 'a1':
        missing.append('spec_pdf_not_linked_by_own_page: the a1 page\'s "Download TDS" has no URL (§C.6); A1_Spec_EN_1214.pdf listed here is the one refurbished-a1 and bambu-lab-a1-combo-starter-kit link')
    if 'page_withdrawn' not in missing:
        if t == 'filament':
            for k in ('tds', 'sds', 'hex'):
                if k not in kinds and not any(m.startswith(f'fetch_failed:{k}:') for m in missing):
                    missing.append(f'{k}_not_linked_by_store_page')
        if t in ('printer', 'ams', 'laser_machine') and 'spec_pdf' not in kinds and not any(m.startswith('fetch_failed:spec_pdf:') for m in missing):
            missing.append('spec_pdf_not_linked_by_store_page')
        if t in ('hotend', 'build_plate') and not kinds - {'wiki'}:
            missing.append('no_official_pdf_linked_by_store_page (wiki pages only)')
    for s in e['skipped']:
        pass
    out.append({'handle': h, 'type': t, 'docs': docs, 'missing': missing,
                'skipped_certificates': [s['url'] for s in e['skipped']]})
json.dump(out, open(f'{C}/docs-by-product.json', 'w'), indent=1)
ok = sum(1 for r in index.values() if r.get('status') == 200)
print('products', len(out), 'index entries', len(index), 'ok', ok)
for r in out:
    print(r['handle'], len(r['docs']), r['missing'])
