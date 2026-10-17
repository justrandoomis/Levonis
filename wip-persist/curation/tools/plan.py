#!/usr/bin/env python3
"""Offline: per curated product, the documents to cache (store-linked official PDFs + the wiki pages §F names).
Writes curation/plan.json ({handle: {type, docs:[{kind,url,why}], skipped:[...], missing:[...]}}) and curation/queue.json."""
import json, re

C = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad/curation'
W = 'https://wiki.bambulab.com'
links = json.load(open(f'{C}/links.json'))
wiki_en = set(open(f'{C}/wiki-en.txt').read().split())

MAT = f'{W}/en/general/filament-guide-material-table'
NOZ = f'{W}/en/filament-acc/acc/nozzles'
DRY = f'{W}/en/filament-acc/filament/dry-filament'

# /en/filament/<family> (slugs from the wiki's own sitemap)
FAMILY = {
    'pla': ['pla-basic-filament', 'pla-matte', 'pla-sparkle', 'pla-metal', 'pla-marble', 'pla-cf', 'pla-cmyk-lithophane', 'pla-basic-gradient',
            'pla-aero', 'pla-glow', 'pla-silk-multi-color', 'pla-galaxy', 'pla-wood', 'pla-silk-upgrade', 'pla-translucent', 'pla-tough-upgrade',
            'pla-basic-beginner-s-filament-pack', 'pla-basic-color-trial-set', 'hwb-pumpkinfamily', 'hwb-hauntedhouse', 'pla-pure'],
    'pla-pure': ['pla-pure'],
    'petg': ['petg-basic', 'petg-hf', 'petg-translucent', 'petg-matte', 'petg-cf'],
    'abs_asa_pc': ['abs-filament', 'asa-filament', 'pc-filament', 'pc-fr', 'asa-aero'],
    'absgf_pa6gf': ['abs-gf', 'pa6-gf'],
    'asacf_pahtcf': ['asa-cf', 'paht-cf'],
    'petcf_ppacf': ['pet-cf', 'ppa-cf', 'pps-cf', 'pa6-cf'],
    'support': ['support-for-pa-pet', 'support-for-pla-petg', 'support-for-abs', 'support-for-pla-new', 'pva'],
}
TPU = {'tpu-95a-hf': [], 'tpu-for-ams': [], 'tpu-85a-tpu-90a': [f'{W}/en/filament-acc/filament/tpu-85a-90a']}

# printers: /en/<printer>/manual/acc-in-the-box (slugs from the sitemap)
BOX = {
    'h2d': ['/en/h2/manual/acc-in-the-box'],
    'refurbished-bambu-lab-h2d-3d-printer': ['/en/h2/manual/acc-in-the-box'],
    'h2d-pro': ['/en/h2d-pro/manual/acc-in-the-box'],
    'h2s': ['/en/h2s/manual/acc-in-the-box'],
    'h2c': ['/en/h2c/acc-in-the-box'],
    'p2s': ['/en/p2s/manual/acc-in-the-box'],
    'refurbished-bambu-lab-p2s-3d-printer': ['/en/p2s/manual/acc-in-the-box'],
    'bambu-lab-p2s-combo-starter-kit': ['/en/p2s/manual/acc-in-the-box'],
    'x2d': ['/en/x2d/manual/acc-in-the-box'],
    'bambu-lab-x2d-combo-starter-kit': ['/en/x2d/manual/acc-in-the-box'],
    'a2l': ['/en/a2l/manual/acc-in-the-box'],
    'p1s': ['/en/p1/manual/p1s-acc-in-the-box', '/en/p1/manual/p1s-combo-acc-in-the-box'],
    'refurbished-p1s': ['/en/p1/manual/p1s-acc-in-the-box', '/en/p1/manual/p1s-combo-acc-in-the-box'],
    'a1-mini': ['/en/a1-mini/manual/acc-in-the-box'],
    'a1': ['/en/a1/manual/acc-in-the-box'],
    'refurbished-a1': ['/en/a1/manual/acc-in-the-box'],
    'bambu-lab-a1-combo-starter-kit': ['/en/a1/manual/acc-in-the-box'],
    'refurbished-x1c': ['/en/x1/manual/acc-in-the-box'],
    'r1': ['/en/r1/manual/acc-in-the-box'],
}

# store-linked or product-named wiki pages that carry spec / compatibility / box facts (maintenance and generic how-to pages are skipped)
EXTRA_WIKI = {
    'ams-2-pro': ['/en/ams/manual/multi-model-AMS-compatibility-guide', '/en/ams-2-pro/manual/intro-and-connection-guide', '/en/ams-2-pro/manual/drying-function', MAT],
    'ams-ht': ['/en/ams/manual/multi-model-AMS-compatibility-guide', '/en/ams-ht/manual/intro-and-connection-guide', '/en/ams-2-pro/manual/drying-function', MAT],
    'ams-multicolor-printing': ['/en/ams/manual/ams-function-introduction', '/en/x1/manual/intro-ams', '/en/ams/manual/multi-model-AMS-compatibility-guide', MAT],
    'ams-lite': ['/en/ams-lite/manual/intro-ams-lite', '/en/ams-lite', MAT],
    'a2l': ['/en/a2l/manual/a2l-ams-connection-guide'],
    'obxidian-high-flow-hotend': ['/en/accessories/e3d-hotend'],
    'h2d-tpu-high-flow-kit': ['/en/h2d/manual/tpu-high-flow-hotend'],
    'h2c-induction-hotend-right': ['/en/h2c/manual/induction-hotend-system-workflow'],
    'vortek-utility-hotends-bundle': ['/en/h2c/manual/induction-hotend-system-workflow'],
    'build-plate-combo': ['/en/filament-acc/acc/plates'],
    'bambu-cool-plate-supertack': ['/en/filament-acc/acc/bambu-cool-plate-supertack'],
    'bambu-3d-effect-plate': ['/en/filament-acc/acc/3d-effect-sheets'],
    '3d-effect-plate-full-combo': ['/en/filament-acc/acc/3d-effect-sheets'],
    'pva': ['/en/filament-acc/filament/pva-printing-guide'],
    'asa-aero': ['/en/filament-acc/filament/asa-aero-printing-guide'],
    'support-for-abs': ['/en/filament-acc/filament/support-for-abs'],
}
PLATES = ['bambu-textured-pei-plate', 'bambu-smooth-pei-plate', 'bambu-dual-texture-pei-plate', 'bambu-3d-effect-plate', 'bambu-cool-plate-supertack',
          'bambu-engineering-plate', '3d-effect-plate-full-combo', 'build-plate-combo']

CERT = re.compile(r'rohs|pops?\b|cp ?65|tsca|svhc|pahs?\b|en ?71|ul ?94|food contact|toy safety|reach', re.I)


def kind_of(ptype, text, url):
    t = f'{text} {url.rsplit("/", 1)[-1]}'.lower()
    if CERT.search(text) or (CERT.search(url.rsplit('/', 1)[-1]) and not re.search(r'tds|technical|sds|hex', t)):
        return 'certificate'
    if re.search(r'(?:^|[^a-z])m?sds(?:[^a-z]|$)|safety data', t):
        return 'sds'
    if re.search(r'hex[\s_-]?code', t):
        return 'hex'
    if ptype in ('printer', 'ams', 'laser_machine'):
        return 'spec_pdf'
    if re.search(r'(?:^|[^a-z])tds(?:[^a-z]|$)|technical[\s_-]data', t):
        return 'tds'
    if re.search(r'manual|quick[\s_-]?start|install', t):
        return 'manual'
    return 'other_pdf'


plan, queue_cdn, queue_wiki = {}, [], []
for p in links['products']:
    h = p['handle']
    ent = {'type': p['type'], 'docs': [], 'skipped': [], 'missing': []}
    plan[h] = ent
    if p.get('withdrawn'):
        ent['missing'].append('page_withdrawn')
        continue
    seen = set()

    def add(kind, url, why):
        if url in seen:
            return
        seen.add(url)
        ent['docs'].append({'kind': kind, 'url': url, 'why': why})
        (queue_wiki if 'wiki.bambulab.com' in url else queue_cdn).append(url)

    pdfs = []
    for l in p['links']:
        u = l['url']
        if re.search(r'\.pdf(\?|$)', u, re.I):
            pdfs.append((l['text'], u.split('?')[0] if 'cdn.shopify.com' in u or u.endswith('.pdf') else u))
    # page_builder configs carry the spec PDF only in the raw page (x2d, a2l, r1 and the X2D starter kit)
    for u in p.get('raw', []):
        if re.search(r'\.pdf$', u, re.I) and '&quot;' not in u and not any(u == x[1] or u.split('?')[0] == x[1] for x in pdfs):
            if re.search(r'store\.bblcdn\.(com|eu)|public-cdn\.bambulab\.com', u) and p['type'] in ('printer', 'laser_machine', 'ams'):
                pdfs.append(('Spec (page_builder config)', u))
    for text, u in pdfs:
        k = kind_of(p['type'], text, u)
        if k == 'certificate':
            ent['skipped'].append({'kind': 'certificate', 'url': u, 'text': text, 'reason': 'compliance certificate / third-party test report: not a spec source for §F (link only)'})
            continue
        add(k, u, f'store page link: {text}')
    # wiki pages §F names
    t = p['type']
    if t == 'filament':
        add('wiki', MAT, '§F material table')
        fams = [f for f, hs in FAMILY.items() if h in hs]
        for f in fams:
            add('wiki', f'{W}/en/filament/{f}', f'§F /en/filament/{f}')
        if h in TPU:
            for u in TPU[h]:
                add('wiki', u, 'TPU family page (store-linked)')
            if not TPU[h]:
                ent['missing'].append('wiki_family_page_none_published (no /en/filament/<family> page for TPU in the wiki sitemap)')
        if any(l['url'] == DRY for l in p['links']) or True:
            add('wiki', DRY, 'drying settings (store-linked on most filament pages)')
        if any('/en/filament/petg' == l['url'].replace(W, '') for l in p['links']):
            add('wiki', f'{W}/en/filament/petg', 'store-linked PETG usage guide')
    if t == 'hotend':
        add('wiki', NOZ, '§F nozzles page')
        add('wiki', MAT, '§F material table (store-linked)')
    if t == 'build_plate':
        add('wiki', MAT, '§F material table (build plate settings section)')
        add('wiki', f'{W}/en/filament-acc/acc/plates', 'build plates page')
    if h == 'a1':  # the a1 page's "Download TDS" has no URL (§C.6); the same official A1 spec PDF is linked by its sibling pages
        add('spec_pdf', 'https://store.bblcdn.com/s7/default/be1cfa84d0bd42dfb72d44cd16c1c907/A1_Spec_EN_1214.pdf', 'not linked by this page; linked by refurbished-a1 and bambu-lab-a1-combo-starter-kit')
    for path in BOX.get(h, []):
        add('wiki', W + path, '§F acc-in-the-box')
    for path in EXTRA_WIKI.get(h, []):
        add('wiki', path if path.startswith('http') else W + path, 'store-linked / product wiki page')
    for l in p['links']:
        if l['src'] == 'tracker' or 'e.bambulab.com/t' in l['url']:
            ent['docs'].append({'kind': 'tracker', 'url': l['url'], 'why': f'tracker link: {l["text"]}'})
            queue_cdn.append({'url': l['url'], 'method': 'HEAD'})
    # sanity: every wiki URL is in the sitemap
    for d in ent['docs']:
        if 'wiki.bambulab.com' in d['url'] and d['url'] not in wiki_en:
            d['not_in_sitemap'] = True

# interleave wiki and CDN so the per-host spacing overlaps; de-duplicate
def key(x):
    return x if isinstance(x, str) else x['url']
seen, q = set(), []
wi, ci = iter(queue_wiki), iter(queue_cdn)
done_w = done_c = False
while not (done_w and done_c):
    for it, flag in ((wi, 'w'), (ci, 'c'), (ci, 'c'), (ci, 'c')):
        try:
            x = next(it)
        except StopIteration:
            if flag == 'w':
                done_w = True
            else:
                done_c = True
            continue
        if key(x) not in seen:
            seen.add(key(x))
            q.append(x)
json.dump(plan, open(f'{C}/plan.json', 'w'), indent=1)
json.dump(q, open(f'{C}/queue.json', 'w'), indent=1)
print('products', len(plan), 'queue', len(q), 'wiki', sum('wiki.bambulab.com' in key(x) for x in q), 'other', sum('wiki.bambulab.com' not in key(x) for x in q))
print('not in sitemap:', sorted({d['url'] for e in plan.values() for d in e['docs'] if d.get('not_in_sitemap')}))
