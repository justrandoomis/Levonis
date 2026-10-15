"""P0 page parser: one crawled store page -> a closed, price-free extraction (stdlib only).

Builds on scratchpad/bambu_tools/rsc.py + resolve.py. Reads ONLY the closed list below from the
product object P (spec §C.10 layer 1), the description element (4 formats, §C.5), the JSON-LD
identity fields, and - through crossSell() only - productSku.{id, productId, seoCode, skuCode}.
Every string kept is passed through scrub_money(); no price/stock/promotion key is ever read.

Usage (driver): python3 -I parse_all.py
"""
import gzip, json, os, re, sys, unicodedata, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', '..', 'bambu_tools'))
from rsc import extract_flight, split_rows, jsonld  # noqa: E402
from resolve import resolve  # noqa: E402
import dom  # noqa: E402

MONEY = re.compile(r'(?:US)?\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|dollars)\b', re.I)


def scrub_money(s):
    if isinstance(s, str) and MONEY.search(s):
        return MONEY.sub('[amount removed]', s)
    return s


def S(v):
    return scrub_money(v) if isinstance(v, str) else v


def nfc(s):
    return unicodedata.normalize('NFC', s) if isinstance(s, str) else s


# ---------------------------------------------------------------- product object (closed read list)

def find_P(rows):
    best = None
    need = ('id', 'seoCode', 'productSkuList', 'productPropertyList', 'mediaFiles')
    for k, v in rows.items():
        if isinstance(v, dict) and all(x in v for x in need):
            n = len(json.dumps(v))
            if best is None or n > best[0]:
                best = (n, k)
    return best[1] if best else None


def read_P(rows, rid):
    raw = rows[rid]

    def g(key):
        return resolve(rows, raw.get(key))

    feats = g('productFeaturesModuleList') or []
    feat_html = []
    for f in feats if isinstance(feats, list) else []:
        if isinstance(f, dict) and isinstance(f.get('content'), str):
            feat_html.append(S(f['content']))
    media = []
    for m in g('mediaFiles') or []:
        if isinstance(m, dict):
            media.append({'resourceFileId': str(m.get('resourceFileId') or ''), 'url': m.get('url') or ''})
    props = []
    for p in g('productPropertyList') or []:
        if not isinstance(p, dict):
            continue
        vals = []
        for v in p.get('productPropertyValueList') or []:
            if not isinstance(v, dict):
                continue
            pvm = v.get('propertyValueMediaFile')
            vals.append({'id': str(v.get('id') or ''), 'value': S(v.get('value') or ''),
                         'selectedDefault': v.get('selectedDefault'), 'colorUrl': v.get('colorUrl') or '',
                         'has_value_media': bool(pvm)})
        props.append({'propertyKey': S(p.get('propertyKey') or ''), 'propertyKeyId': str(p.get('propertyKeyId') or ''),
                      'type': p.get('type'), 'title': S(p.get('title') or ''), 'position': p.get('position'),
                      'introduction': S(p.get('introduction')) if isinstance(p.get('introduction'), str) else None,
                      'explanation': S(p.get('explanation')) if isinstance(p.get('explanation'), str) else None,
                      'values': vals})
    skus = []
    for s in g('productSkuList') or []:
        if not isinstance(s, dict):
            continue
        mf = s.get('mediaFile') if isinstance(s.get('mediaFile'), dict) else None
        skus.append({'id': str(s.get('id') or ''), 'skuCode': s.get('skuCode'),
                     'props': [{'propertyKey': S(x.get('propertyKey') or ''), 'propertyKeyId': str(x.get('propertyKeyId') or ''),
                                'propertyValue': S(x.get('propertyValue') or ''), 'position': x.get('position')}
                               for x in (s.get('productSkuPropertyList') or []) if isinstance(x, dict)],
                     'mediaFile': {'resourceFileId': str(mf.get('resourceFileId') or ''), 'url': mf.get('url') or ''} if mf else None,
                     'description': S(s.get('description') or ''),
                     'has_sub_products': bool(s.get('subProductSkuSimpleList'))})
    extra = g('productExtraInfoVO') or {}
    return {
        'id': str(g('id')), 'seoCode': g('seoCode'), 'seoUrlHandle': g('seoUrlHandle'), 'name': S(g('name')),
        'subTitle': S(g('subTitle')), 'seoTitle': S(g('seoTitle')), 'seoMetaDescription': S(g('seoMetaDescription')),
        'type': g('type'), 'isFilament': g('isFilament'), 'newFlag': g('newFlag'),
        'currentAllIdRoute': g('currentAllIdRoute') or '',
        'productFeaturesTitle': S(g('productFeaturesTitle')), 'features_html': feat_html,
        'externalVideoLinkList': [x for x in (g('externalVideoLinkList') or []) if isinstance(x, str) and x],
        'showMwModelIds': [str(x) for x in (g('showMwModelIds') or []) if x],
        'mediaFiles': media, 'options': props, 'skus': skus,
        'productFileList_present': bool(extra.get('productFileList')) if isinstance(extra, dict) else False,
        'subProductList_present': bool(g('subProductList')),
    }


# ---------------------------------------------------------------- cross-sell (narrow reader, §C.1)

def cross_sell(rows):
    """relationProducts.randomBuyRangeGroupList[].{skuList,spuList[].skuList}[].productSku.{id,productId,seoCode,skuCode}"""
    out = []
    for k, v in rows.items():
        if not (isinstance(v, dict) and 'randomBuyRangeGroupList' in v and len(v) <= 3):
            continue
        groups = resolve(rows, v.get('randomBuyRangeGroupList'))
        if not isinstance(groups, list):
            continue
        for gi in groups:
            if not isinstance(gi, dict):
                continue
            entries = list(gi.get('skuList') or [])
            for spu in gi.get('spuList') or []:
                if isinstance(spu, dict):
                    entries.extend(spu.get('skuList') or [])
            for e in entries:
                ps = e.get('productSku') if isinstance(e, dict) else None
                if isinstance(ps, dict):
                    out.append({'id': str(ps.get('id') or ''), 'productId': str(ps.get('productId') or ''),
                                'seoCode': ps.get('seoCode') or '', 'skuCode': ps.get('skuCode') or ''})
    return out


# ---------------------------------------------------------------- description (A -> B -> C -> D1 -> D2)

def iter_elements(v, path=()):
    if isinstance(v, list):
        if len(v) == 4 and v[0] == '$' and isinstance(v[1], str) and isinstance(v[3], dict):
            yield path, v[1], v[3]
        for i, x in enumerate(v):
            yield from iter_elements(x, path + (i,))
    elif isinstance(v, dict):
        for k, x in v.items():
            yield from iter_elements(x, path + (k,))


def detect_description(rows):
    els = []
    for k, v in rows.items():
        if isinstance(v, (list, dict)):
            for path, comp, props in iter_elements(v, (k,)):
                els.append((k, comp, props))
    found = {}
    for k, comp, props in els:
        if 'isOldVersion' in props and 'description' in props and 'A' not in found:
            found['A'] = {'row': k, 'html': resolve(rows, props['description'])}
        secs = props.get('sections')
        if isinstance(secs, list) and secs and isinstance(secs[0], dict):
            if 'name' in secs[0] and 'B' not in found:
                bodies = [resolve(rows, p2['description']) for k2, c2, p2 in els
                          if k2 == k and 'description' in p2 and set(p2.keys()) == {'description'}]
                found['B'] = {'row': k, 'sections': [{'id': s.get('id'), 'name': s.get('name'),
                                                      'html': bodies[i] if i < len(bodies) else None}
                                                     for i, s in enumerate(secs)]}
            if 'label' in secs[0] and 'D2' not in found:
                found['D2'] = {'row': k, 'nav': [{'id': s.get('id'), 'label': s.get('label')} for s in secs]}
        d = props.get('data')
        if isinstance(d, list) and d and isinstance(d[0], dict) and 'componentType' in d[0] and 'E' not in found:
            found['E'] = {'row': k, 'components': resolve(rows, d)}
        if 'config' in props and 'C' not in found:
            cfg = resolve(rows, props['config'])
            if isinstance(cfg, dict) and 'schemaVersion' in cfg:
                found['C'] = {'row': k, 'config': cfg}
    if not found.get('A') and not found.get('B'):
        for k, v in rows.items():
            if isinstance(v, (list, dict)):
                s = json.dumps(v, ensure_ascii=False)
                if 'product_description_' in s and 'shopify-section-template' in s and len(s) > 1500:
                    found['D1'] = {'row': k}
                    break
    for kind in ('A', 'B', 'C', 'D1', 'D2', 'E'):
        if kind in found:
            return kind, found
    return None, found


SEC_KIND = [
    (r'specification|specs|basic information|parameter|technical', 'specs'),
    (r'in the box|what.?s in|package (list|content)|packing list|box contents|included', 'in_the_box'),
    (r'compatib|works with|fits', 'compat'),
    (r'instruction|install|how to|usage|user guide|tutorial|setup', 'instructions'),
    (r'faq|question', 'faq'),
    (r'warning|caution|attention|safety|notice', 'warning'),
    (r'comparison|compare|vs\b', 'comparison'),
    (r'overview|feature|introduc|description|highlight', 'overview'),
]


def sec_kind(title):
    t = (title or '').lower()
    for rx, k in SEC_KIND:
        if re.search(rx, t):
            return k
    return 'other'


class Collector:
    """Walks DOM nodes in order, attributing tables/text/links/images to the current section."""

    def __init__(self):
        self.sections = []
        self.cur = None

    def open(self, title, kind=None, path=''):
        title = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', title or '')).strip()
        self.cur = {'title': S(title), 'kind': kind or sec_kind(title), 'path': path,
                    'text': [], 'tables': [], 'links': [], 'images': [], 'box_items': []}
        self.sections.append(self.cur)

    def ensure(self):
        if self.cur is None:
            self.open('', 'overview', 'root')

    def add_nodes(self, nodes, split_h3=False, d1=False):
        self.ensure()
        buf = []

        def flush():
            if buf:
                t = dom.text_of(buf)
                if t:
                    self.cur['text'].append(S(t))
                buf.clear()

        def rec(ns):
            for n in ns:
                if isinstance(n, str):
                    buf.append(n)
                    continue
                tag = n['tag']
                a = n['attrs']
                if d1 and tag == 'div' and isinstance(a.get('id'), str):
                    m = re.search(r'__product_description_([a-z_]+?)_[A-Za-z0-9]{6}$', a['id'])
                    if m:
                        flush()
                        k = m.group(1)
                        kind = {'special': 'specs', 'what_is_in_the_box': 'in_the_box', 'faq': 'faq',
                                'unboxing': 'in_the_box', 'nav_anchor': 'other'}.get(k, 'overview')
                        self.open(k, kind, 'D1:' + k)
                if split_h3 and tag in ('h2', 'h3', 'h4'):
                    flush()
                    title = dom.text_of(n.get('children') or [])
                    if tag != 'h4' or re.search(r'specification|in the box|compatib|package|instruction|warning', title, re.I):
                        self.open(title, None, tag + ':' + title[:60])
                        continue
                if tag == 'table':
                    flush()
                    self.cur['tables'].append(dom.table_grid(n))
                    continue
                if tag == 'a' and a.get('href'):
                    self.cur['links'].append({'url': a.get('href'), 'text': S(dom.text_of(n.get('children') or []))[:200]})
                if tag in ('img', 'source', 'video') or (tag == '#comp' and (a.get('src') or a.get('data-src'))):
                    src = a.get('data-src') or a.get('src') or a.get('srcset') or ''
                    if isinstance(src, str) and src and not src.startswith('data:'):
                        alt = a.get('alt') if isinstance(a.get('alt'), str) else ''
                        if alt == '图片加载失败文案':
                            alt = ''
                        self.cur['images'].append({'url': src, 'alt': S(alt)})
                if tag == '#comp':
                    for key in ('link', 'dtsLink', 'href', 'url', 'downloadLink'):
                        x = a.get(key)
                        if isinstance(x, str) and x.startswith(('http', '//', '/')):
                            self.cur['links'].append({'url': x, 'text': key})
                    for key in ('label', 'title', 'alt', 'name', 'text', 'description'):
                        x = a.get(key)
                        if isinstance(x, str) and x.strip() and not x.startswith('$') and len(x) < 400:
                            buf.append('\n' + x + '\n')
                if tag in dom.BLOCK:
                    buf.append('\n')
                if tag == 'br':
                    buf.append('\n')
                rec(n.get('children') or [])
                if tag in dom.BLOCK:
                    buf.append('\n')
        rec(nodes)
        flush()


def witb_items(nodes):
    """D1 'what_is_in_the_box' items: an element with class witb-item-name, image from the nearest data-src."""
    items = []

    def rec(ns, last_img):
        for n in ns:
            if isinstance(n, str):
                continue
            a = n['attrs']
            cls = a.get('className') or a.get('class') or ''
            if n['tag'] == 'img':
                last_img[0] = a.get('data-src') or a.get('src') or ''
            if isinstance(cls, str) and 'witb-item-name' in cls:
                items.append({'text': S(dom.text_of(n.get('children') or [])), 'image': last_img[0]})
                last_img[0] = ''
                continue
            rec(n.get('children') or [], last_img)
    rec(nodes, [''])
    return items


def page_builder_sections(cfg, col):
    def comp_text(c):
        out = []
        mods = c.get('modules') or {}
        ts = (mods.get('typeStyles') or {}).get('content') or {}
        for key in ('title', 'subTitle', 'description'):
            x = ts.get(key)
            if isinstance(x, str) and x.strip():
                out.append(x)
        return out

    def rec(cs, depth):
        for c in cs or []:
            if not isinstance(c, dict):
                continue
            name = c.get('name') or ''
            anchor = (c.get('anchor') or {}).get('name') if isinstance(c.get('anchor'), dict) else ''
            if depth == 0:
                title = anchor or name or c.get('type') or ''
                kind = 'faq' if c.get('type') == 'content-block-21-pro' or 'faq' in title.lower() else sec_kind(title)
                if name == 'Download':
                    kind = 'documents'
                col.open(title, kind, 'C:' + str(c.get('id')))
            texts = comp_text(c)
            for t in texts:
                col.add_nodes(dom.from_html(t))
            ts = ((c.get('modules') or {}).get('typeStyles') or {}).get('content') or {}
            for key, x in ts.items() if isinstance(ts, dict) else []:
                if key not in ('title', 'subTitle', 'description') and isinstance(x, str) and '<table' in x:
                    col.add_nodes(dom.from_html(x))
            mods = c.get('modules') or {}
            media = mods.get('media') or {}
            for side in ('pc', 'mo'):
                m = media.get(side) if isinstance(media, dict) else None
                if isinstance(m, dict) and isinstance(m.get('src'), str) and m['src']:
                    col.cur['images'].append({'url': m['src'], 'alt': ''})
            fc = mods.get('featureConfig') or {}
            if isinstance(fc, dict):
                for key, x in fc.items():
                    if isinstance(x, str) and x.strip() and ('<table' in x or key in ('richText', 'content', 'text', 'description', 'title')):
                        col.add_nodes(dom.from_html(x))
            for it in fc.get('items') or [] if isinstance(fc, dict) else []:
                if not isinstance(it, dict):
                    continue
                if isinstance(it.get('link'), str) and it['link']:
                    col.cur['links'].append({'url': it['link'], 'text': S(it.get('description') or it.get('title') or '')})
                for key, x in it.items():
                    if not isinstance(x, str) or not x.strip() or key in ('link', 'id', 'url', 'src'):
                        continue
                    if '<table' in x or key in ('title', 'description', 'question', 'answer', 'content', 'text', 'richText', 'subTitle'):
                        col.add_nodes(dom.from_html(x))
            rec(c.get('children'), depth + 1)
    rec(cfg.get('components'), 0)


E_KIND = {'SpecTable': 'specs', 'Inbox': 'in_the_box', 'FAQ': 'faq', 'Unbox': 'in_the_box', 'Anchor': None}
E_TEXT_KEYS = {'title', 'subtitle', 'h2Text', 'featureTitle', 'featureSubtitle', 'question', 'answer', 'originalText',
               'note', 'tableNote', 'collapseText', 'notCollapseText', 'footNote', 'text', 'description', 'content'}


def component_sections(comps, col):
    anchors = {}
    for c in comps or []:
        if isinstance(c, dict) and c.get('componentType') == 'Anchor':
            for a in (c.get('data') or {}).get('list') or []:
                anchors[str(a.get('id'))] = a.get('name') or ''
    box = []

    def media(v):
        return isinstance(v, dict) and isinstance(v.get('url'), str) and ('fileOriginalName' in v or 'dataType' in v or 'resourceFileId' in v)

    def rec(v, key=''):
        if isinstance(v, str):
            if '<table' in v:
                col.add_nodes(dom.from_html(v))
            elif key in E_TEXT_KEYS and v.strip():
                col.add_nodes(dom.from_html(v) if dom.HTMLISH.search(v) else [v + '\n'])
            elif key in ('link', 'href', 'url', 'downloadLink') and v.startswith('http'):
                col.cur['links'].append({'url': v, 'text': key})
            return
        if isinstance(v, list):
            for x in v:
                rec(x, key)
            return
        if isinstance(v, dict):
            if media(v):
                col.cur['images'].append({'url': v['url'], 'alt': S(v.get('alt') or ''), 'name': v.get('fileOriginalName') or ''})
                return
            for k2, x in v.items():
                rec(x, k2)
    for c in comps or []:
        if not isinstance(c, dict):
            continue
        ct = c.get('componentType')
        data = c.get('data') or {}
        if ct == 'Anchor':
            continue
        title = anchors.get(str(data.get('anchorId')), '') if isinstance(data, dict) else ''
        kind = E_KIND.get(ct) or sec_kind(title) or 'overview'
        col.open((data.get('title') if isinstance(data, dict) and isinstance(data.get('title'), str) else '') or title or ct,
                 kind, 'E:' + str(c.get('componentName')))
        if ct == 'Inbox' and isinstance(data, dict):
            hdr = data.get('headers') or {}
            for it in data.get('items') or []:
                if not isinstance(it, dict):
                    continue
                c1 = it.get('column1') or {}
                imgs = [x.get('url') for x in (c1.get('image') or []) if isinstance(x, dict) and x.get('url')]
                qty = {hdr.get(k) or k: (it.get(k) or {}).get('text') for k in ('column2', 'column3', 'column4', 'column5')
                       if isinstance(it.get(k), dict) and ((it.get(k) or {}).get('text') or (it.get(k) or {}).get('showCheckIcon'))}
                col.cur['box_items'].append({'text': S(c1.get('text') or ''), 'image': imgs[0] if imgs else '', 'qty_by_scope': qty})
            continue
        rec(data)


MESSAGE_NS = {'ams-2-pro': 'AMSPro', 'ams-ht': 'AMSHT'}


def messages_spec_table(m, ns):
    st = (m.get(ns) or {}).get('SpecificationTable') if isinstance(m, dict) else None
    if not isinstance(st, dict):
        return None
    rows = []
    for k, v in st.items():
        if isinstance(v, str) and k + 'Value' in st and isinstance(st[k + 'Value'], str):
            rows.append({'cells': [{'t': S(v)}, {'t': S(dom.text_of(dom.from_html(st[k + 'Value'])))}], 'raw_n': 2,
                         'rowspan_any': False, 'locator': 'messages.%s.SpecificationTable.%sValue' % (ns, k)})
    return rows


def messages_bundle(rows):
    for k, v in rows.items():
        if isinstance(v, list) and len(v) == 4 and v[0] == '$' and isinstance(v[3], dict) and 'messages' in v[3]:
            m = resolve(rows, v[3]['messages'])
            if isinstance(m, dict):
                return m
    return None


def parse_description(rows, kind, found):
    col = Collector()
    extra = {}
    if kind == 'A':
        col.add_nodes(dom.from_html(found['A']['html'] or ''), split_h3=True)
    elif kind == 'B':
        for s in found['B']['sections']:
            col.open(s.get('name') or '', None, 'B:' + str(s.get('id')))
            col.add_nodes(dom.from_html(s.get('html') or ''), split_h3=False)
    elif kind == 'C':
        page_builder_sections(found['C']['config'], col)
    elif kind == 'D1':
        tree = dom.from_react(resolve(rows, rows[found['D1']['row']]))
        col.add_nodes(tree, d1=True)
        for s in col.sections:
            if s['path'] == 'D1:what_is_in_the_box':
                pass
        extra['witb'] = witb_items(tree)
    elif kind == 'D2':
        tree = dom.from_react(resolve(rows, rows[found['D2']['row']]))
        # sections by <section id> or element id matching the nav ids
        nav_ids = {s['id']: s['label'] for s in found['D2']['nav']}
        col.open('overview', 'overview', 'D2:overview')

        def rec(ns):
            for n in ns:
                if isinstance(n, str):
                    col.add_nodes([n])
                    continue
                sid = n['attrs'].get('id') if isinstance(n['attrs'].get('id'), str) else None
                if sid in nav_ids:
                    col.open(nav_ids[sid], sec_kind(nav_ids[sid]) if sid != 'specs' else 'specs', 'D2:' + sid)
                    col.add_nodes(n.get('children') or [])
                    continue
                if n['tag'] in ('section', 'div', '#comp', 'main', '#prop') and n.get('children'):
                    shallow = {k: v for k, v in n.items() if k != 'children'}
                    shallow['children'] = []
                    col.add_nodes([shallow])
                    rec(n['children'])
                else:
                    col.add_nodes([n])
        rec(tree)
        extra['nav'] = found['D2']['nav']
    elif kind == 'E':
        component_sections(found['E']['components'], col)
    secs = [s for s in col.sections if s['text'] or s['tables'] or s['links'] or s['images'] or s['box_items']]
    return secs, extra


def parse(html_text):
    fl = extract_flight(html_text)
    rows = split_rows(fl)
    rid = find_P(rows)
    if not rid:
        return {'error': 'NO_PRODUCT_OBJECT'}
    P = read_P(rows, rid)
    kind, found = detect_description(rows)
    secs, extra = parse_description(rows, kind, found) if kind else ([], {})
    jl = jsonld(html_text)
    jl0 = next((j for j in jl if isinstance(j, dict) and j.get('@type') == 'ProductGroup'), None)
    ident = None
    if jl0:
        ident = {'productGroupID': str(jl0.get('productGroupID')), 'name': S(jl0.get('name')),
                 'url': jl0.get('url'), 'brand': (jl0.get('brand') or {}).get('name') if isinstance(jl0.get('brand'), dict) else None,
                 'variant_skus': [str(v.get('sku')) for v in jl0.get('hasVariant') or [] if isinstance(v, dict)]}
    canon = re.search(r'<link rel="canonical" href="([^"]*)"', html_text)
    msgs = None
    if kind == 'D2':
        mb = messages_bundle(rows)
        ns = MESSAGE_NS.get(handle_of(P.get('seoCode')))
        if ns and isinstance(mb, dict):
            t = messages_spec_table(mb, ns)
            if t:
                secs.append({'title': 'Specs (messages.%s.SpecificationTable)' % ns, 'kind': 'specs', 'path': 'messages.' + ns,
                             'text': [], 'tables': [t], 'links': [], 'images': [], 'box_items': []})
                msgs = ns
    return {
        'P': P, 'desc_kind': kind, 'desc_formats_present': sorted(found.keys()),
        'sections': secs, 'desc_extra': extra, 'jsonld': ident, 'link_canonical': canon.group(1) if canon else None,
        'cross_sell': cross_sell(rows), 'messages_namespaces': msgs,
    }


def handle_of(seo):
    return nfc(urllib.parse.unquote(seo or ''))
