"""P0 analyses over the parsed pages (stdlib only). Imported by build.py."""
import collections, hashlib, json, os, re, sys, unicodedata, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dom  # noqa: E402
import registry  # noqa: E402
from specpairs import pairs as spec_pairs  # noqa: E402

P0 = os.path.dirname(HERE)
PARSED = os.path.join(P0, 'work', 'parsed')
BAMBU = os.path.dirname(P0)
SITEMAP = os.path.join(BAMBU, 'products_sitemap.xml')


def H(x):
    return hashlib.sha256(x.encode('utf-8')).hexdigest()[:24]


def nfc(s):
    return unicodedata.normalize('NFC', s) if isinstance(s, str) else s


def safe_name(handle):
    return re.sub(r'[^A-Za-z0-9._-]', '_', handle)


def sitemap_order():
    urls = re.findall(r'<loc>(https://us\.store\.bambulab\.com/products/[^<]+)</loc>', open(SITEMAP, encoding='utf-8').read())
    seen, out = set(), []
    for u in urls:
        if u in seen:
            continue
        seen.add(u)
        h = urllib.parse.unquote(u.rsplit('/products/', 1)[1]).strip('/')
        out.append((u, h))
    return out


def load_all():
    order = sitemap_order()
    recs = []
    for i, (url, h) in enumerate(order):
        fn = os.path.join(PARSED, safe_name(h) + '.json')
        r = json.load(open(fn))
        recs.append({'sitemap_index': i, 'sitemap_url': url, 'sitemap_handle': h, 'file': safe_name(h), 'r': r, 'P': r['P']})
    return recs


_ALL = None


def load_all_cached():
    global _ALL
    if _ALL is None:
        _ALL = load_all()
    return _ALL


# ------------------------------------------------------------------ text helpers

def all_text_blobs(rec):
    """(where, text) for every prose source on the page (description sections, features, variant notes, option notes)."""
    r, P = rec['r'], rec['P']
    out = []
    for s in r['sections']:
        for t in s['text']:
            out.append(('section:' + (s['title'] or s['kind']), t))
        for tb in s['tables']:
            for row in tb:
                for c in row['cells']:
                    out.append(('table:' + (s['title'] or s['kind']), c['t']))
    for h in P['features_html']:
        out.append(('features', dom.text_of(dom.from_html(h))))
    for sku in P['skus']:
        if sku['description']:
            out.append(('variant_note:' + sku['id'], dom.text_of(dom.from_html(sku['description']))))
    for o in P['options']:
        for k in ('introduction', 'explanation'):
            if o.get(k):
                out.append(('option_' + k, dom.text_of(dom.from_html(o[k]))))
    if P.get('seoMetaDescription'):
        out.append(('seoMetaDescription', P['seoMetaDescription']))
    return out


URL_RX = re.compile(r'https?://[^\s"\'<>)\]]+|//(?:store|wiki|e)\.bambulab\.com[^\s"\'<>)\]]*|//store\.bblcdn\.com[^\s"\'<>)\]]*')


def all_links(rec):
    """Every URL the page's content carries: (where, url, text)."""
    r, P = rec['r'], rec['P']
    out = []
    for s in r['sections']:
        for l in s['links']:
            out.append(('section:' + (s['title'] or s['kind']), l['url'], l.get('text') or ''))
        for t in s['text']:
            for m in URL_RX.findall(t):
                out.append(('section-text:' + (s['title'] or s['kind']), m, ''))
    for h in P['features_html']:
        for n in dom.find_all(dom.from_html(h), lambda n: n['tag'] == 'a' and n['attrs'].get('href')):
            out.append(('features', n['attrs']['href'], dom.text_of(n['children'])))
    for sku in P['skus']:
        if sku['description']:
            for n in dom.find_all(dom.from_html(sku['description']), lambda n: n['tag'] == 'a' and n['attrs'].get('href')):
                out.append(('variant_note', n['attrs']['href'], dom.text_of(n['children'])))
    for o in P['options']:
        for k in ('introduction', 'explanation'):
            if o.get(k):
                for n in dom.find_all(dom.from_html(o[k]), lambda n: n['tag'] == 'a' and n['attrs'].get('href')):
                    out.append(('option_' + k, n['attrs']['href'], dom.text_of(n['children'])))
    for v in P['externalVideoLinkList']:
        out.append(('externalVideoLinkList', v, 'video'))
    return out


def classify_link(u):
    ul = u.lower()
    if re.search(r'(^|//|\.)e\.bambulab\.com(/|$)', ul) and not re.search(r'store\.bambulab\.com', ul):
        return 'tracker'
    if 'wiki.bambulab.com' in ul:
        return 'wiki'
    if 'store-test.bblcdn.com' in ul:
        return 'store_test_host'
    if re.search(r'\.(pdf)(\?|$)', ul):
        return 'pdf'
    if re.search(r'\.(zip|3mf|stl|step|stp|rar)(\?|$)', ul):
        return 'model_file'
    if 'youtube.com' in ul or 'youtu.be' in ul:
        return 'video'
    if re.search(r'\.(mp4|mov|webm)(\?|$)', ul):
        return 'video_file'
    if 'makerworld.com' in ul:
        return 'makerworld'
    if re.search(r'(us\.)?store\.bambulab\.com/|^\.\./|^/products/|^/collections/', ul) or ul.startswith('../'):
        return 'store_link'
    if 'bambulab.com' in ul:
        return 'bambulab_other'
    return 'other'


# ------------------------------------------------------------------ option groups (§C.2)

WEIGHT_RX = re.compile(r'^\s*\d+(\.\d+)?\s*(kg|g)\s*(\*\s*\d+)?\s*$', re.I)
NOZZLE_RX = re.compile(r'\d\.\d\s*mm.*(steel|nozzle|hotend|carbide|flow)|(steel|nozzle|hotend|carbide).*\d\.\d\s*mm', re.I)
PRINTER_TOK = re.compile(r'\b(A1|A1 mini|A2L?|P1[PS]?|P2S?|X1[CE]?|X2D?|H2[DSC]?|H2D Pro|R1)\b|series|printers?', re.I)
SPOOL_WORDS = {'refill', 'spool', 'with spool', 'filament with spool', 'filament refill', 'refill only', 'spool only'}


def group_kind(g):
    key = re.sub(r'\s+', ' ', g['propertyKey']).strip()
    k = key.lower()
    vals = [v['value'].strip() for v in g['values']]
    lv = [v.lower() for v in vals]
    if k in ('color', 'colour', 'colors') or any(v['colorUrl'] for v in g['values']):
        return 'color'
    if k == 'type' and lv and all(v in SPOOL_WORDS for v in lv):
        return 'spool'
    if re.match(r'^how many .* unit', k):
        return 'units'
    if re.match(r'^(printer model|select the type of printer|select your printer series|compatible|compatibility|device)', k):
        if vals and all(PRINTER_TOK.search(v) for v in vals):
            return 'printer'
        return 'other'
    if g.get('type') == 4 or k in ('variant', 'version'):
        return 'version'
    if k in ('size', 'nozzle diameter') and vals and all(NOZZLE_RX.search(v) or re.match(r'^\d\.\d\s*mm', v) for v in vals) and any(NOZZLE_RX.search(v) for v in vals):
        return 'nozzle'
    if k == 'size' and vals and all(WEIGHT_RX.match(v) for v in vals):
        return 'pack'
    if k in ('size', 'thickness', 'length'):
        return 'size'
    if k in ('item', 'ltem', 'items'):
        return 'item'
    if k in ('texture',) or any(re.search(r'\bplate\b|\bpei\b', v, re.I) for v in vals):
        return 'plate'
    return 'other'


# ------------------------------------------------------------------ media binding (§C.4), file-name level (P0 has no hashes)

def fname(url):
    return urllib.parse.unquote((url or '').rsplit('/', 1)[-1]).split('?')[0]


def binding(P, groups_kind):
    gallery = P['mediaFiles']
    skus = P['skus']
    groups = P['options']
    gid = {}
    url_first = {}
    dup_url = []
    for i, m in enumerate(gallery):
        if m['url'] in url_first:
            dup_url.append((i, url_first[m['url']]))
        else:
            url_first[m['url']] = i
        gid.setdefault(m['resourceFileId'], i)
    # variant hero -> gallery index (by id, then url)
    hero = {}
    no_hero, hero_missing = [], []
    for s in skus:
        mf = s['mediaFile']
        if not mf or not (mf.get('resourceFileId') or mf.get('url')):
            no_hero.append(s['id'])
            continue
        gi = gid.get(mf['resourceFileId'])
        if gi is None:
            gi = url_first.get(mf['url'])
        if gi is None:
            hero_missing.append(s['id'])
            continue
        hero[s['id']] = url_first.get(gallery[gi]['url'], gi)   # collapse URL-identical duplicates to earliest
    # value sets per group: value text -> set(variant ids)
    vsets = []
    for gi_, g in enumerate(groups):
        m = collections.defaultdict(set)
        for s in skus:
            for p in s['props']:
                if p['propertyKeyId'] == g['propertyKeyId']:
                    m[nfc(p['propertyValue'].strip())].add(s['id'])
        vsets.append(m)
    rows = []
    rule_count = collections.Counter()
    own_value_rows = set()   # (group index, value)
    collapsed = sorted(set(url_first.values()))
    for g_index in collapsed:
        V = {sid for sid, h in hero.items() if h == g_index}
        if not V:
            rows.append(('general', g_index, None)); rule_count['general'] += 1
            continue
        if len(V) == 1:
            rows.append(('variant', g_index, next(iter(V)))); rule_count['variant'] += 1
            continue
        single = None
        order = sorted(range(len(groups)), key=lambda i: (0 if groups_kind[i] == 'color' else 1, i))
        for i in order:
            for val, vs in vsets[i].items():
                if vs == V and len(vsets[i]) >= 1:
                    single = (i, val)
                    break
            if single:
                break
        if single and len(vsets[single[0]]) >= 2:
            rows.append(('value', g_index, single)); rule_count['value'] += 1
            own_value_rows.add(single)
            continue
        union = None
        for i in order:
            if len(vsets[i]) < 2:
                continue
            S = [val for val, vs in vsets[i].items() if vs and vs <= V]
            if S and set().union(*[vsets[i][x] for x in S]) == V and len(S) >= 2:
                union = (i, S)
                break
        if union:
            for val in union[1]:
                rows.append(('value_set', g_index, (union[0], val)))
                own_value_rows.add((union[0], val))
            rule_count['value_set'] += len(union[1])
            continue
        if single:   # single-value group: equivalent to all variants -> bind at value level once
            rows.append(('value', g_index, single)); rule_count['value'] += 1
            own_value_rows.add(single)
            continue
        for sid in sorted(V):
            rows.append(('variant', g_index, sid))
        rule_count['variant'] += len(V)
    # representative rows (step 3)
    rep = 0
    for i, g in enumerate(groups):
        if len(vsets[i]) < 2:
            continue
        for val, vs in vsets[i].items():
            if (i, val) in own_value_rows:
                continue
            # the representative variant: default of other groups else first in SKU order
            cand = [s for s in skus if s['id'] in vs]
            if any(s['id'] in hero for s in cand[:1]):
                rep += 1
    rule_count['representative'] = rep
    return {'rows': len(rows) + rep, 'rules': dict(rule_count), 'dup_url': dup_url, 'no_hero': no_hero,
            'hero_not_in_gallery': hero_missing, 'unbound_general': [gallery[i]['url'] for k, i, _ in rows if k == 'general'],
            'hero': hero, 'vsets': vsets}


# ------------------------------------------------------------------ search tokens (port of worker/lib/search/normalize.ts + translit.ts)

AR_DIAC = re.compile('[ً-ٰٟۖ-ۭ]')
FOLD = {'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي', 'ؤ': 'و', 'ئ': 'ي', 'ک': 'ك', 'ی': 'ي', 'ە': 'ه'}
AR2LAT = {'ا': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'س': 's',
          'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm',
          'ن': 'n', 'ه': 'h', 'و': 'w', 'ي': 'y', 'ء': '', 'پ': 'p', 'چ': 'ch', 'ڤ': 'v', 'گ': 'g', 'ژ': 'zh', 'ڕ': 'r', 'ڵ': 'l', 'ۆ': 'o', 'ھ': 'h'}


def normalize_text(s):
    if not isinstance(s, str) or not s:
        return ''
    s = unicodedata.normalize('NFD', s.lower())
    s = re.sub('[̀-ͯ]', '', s)
    s = AR_DIAC.sub('', s).replace('ـ', '')
    s = ''.join(FOLD.get(ch, ch) for ch in s)
    s = re.sub(r'[^\w]+|_', ' ', s, flags=re.U)
    return s.strip()


def tokenize(s):
    out = set()
    for w in normalize_text(s).split(' '):
        if 2 <= len(w) <= 32:
            out.add(w)
        parts = re.split(r'(?<=[^\W\d_])(?=\d)|(?<=\d)(?=[^\W\d_])', w)
        if len(parts) > 1:
            for p in parts:
                if 2 <= len(p) <= 32:
                    out.add(p)
    return out


def has_ar(s):
    return re.search('[؀-ۿݐ-ݿ]', s) is not None


def romanize(t):
    out = ''.join(AR2LAT.get(ch, ch) for ch in t)
    out = re.sub(r'[aeiouwy]+', 'a', out)
    out = re.sub(r'(.)\1+', r'\1', out)
    return re.sub(r'[^a-z0-9]', '', out)


def index_tokens(values):
    best = set()
    for v in values:
        for t in tokenize(v):
            best.add(t)
            sk = romanize(t)
            if has_ar(t):
                if sk and sk != t:
                    best.add(sk)
            elif re.search(r'[a-z]', sk) and 2 <= len('~' + sk) <= 32 and 2 <= len(sk):
                best.add('~' + sk)
    return best


# ------------------------------------------------------------------ order-type words (packages/pricing/src/availability.ts)

def availability_from_name(name):
    if re.search(r'pre[\s-]?order|طلب\s*مسبق', name, re.I):
        return 'pre_order'
    if re.search(r'direct(\s*sale)?|بيع\s*مباشر', name, re.I):
        return 'direct_sale'
    return ''


# ------------------------------------------------------------------ spec tables

MATRIX_HINT = re.compile(r'^(p1p|p1s|x1c|x1e|x1|a1|a1 mini|h2d|h2s|h2c|p2s|x2d|a2l|support for .*|pva|pla|petg|abs|asa|tpu|pc|pa|pet)$', re.I)


def spec_tables(rec):
    """Yield (section title, table, is_matrix) for tables in spec sections (and the messages table)."""
    for s in rec['r']['sections']:
        if s['kind'] != 'specs':
            continue
        for t in s['tables']:
            ps = spec_pairs(t)
            labels = [p['label'] for p in ps]
            matrix = bool(labels) and sum(1 for l in labels if MATRIX_HINT.match(l.strip())) >= max(3, len(labels) // 3)
            yield s['title'], t, ps, matrix


REGION_RX = re.compile(r'100\s*[-–~]\s*120\s*V|\b1[12]0\s*V\b|@\s*1[12]0\s*V|\bUS version\b|purchase the version corresponding to your region|\b110\s*~\s*240\s*V', re.I)
SUBLABEL_RX = re.compile(r'(package size|packaging size|net weight|gross weight|recommended space|product size|dimensions?)\s*[:：]?', re.I)
NUMDIM_RX = re.compile(r'\d+(\.\d+)?\s*[*x×X]\s*\d+(\.\d+)?(\s*[*x×X]\s*\d+(\.\d+)?)?\s*(mm|cm)?|\d+(\.\d+)?\s*(kg|g)\b', re.I)


def composite(value, version_values):
    """A labelled multi-value cell: >=2 segments carrying sub-labels or version prefixes."""
    segs = [x.strip() for x in re.split(r'\n|;|,(?=\s*[A-Za-z][A-Za-z ()]*\s*[:：])', value) if x.strip()]
    labelled = [x for x in segs if SUBLABEL_RX.search(x) or any(x.lower().startswith(v.lower()) for v in version_values if v)]
    nums = NUMDIM_RX.findall(value)
    if (len(labelled) >= 2 and len(nums) >= 2) or (len(segs) >= 2 and len(nums) >= 2 and re.search(r'[A-Za-z][A-Za-z ]+\s*[:：]', value) and len(re.findall(r'[:：]', value)) >= 2):
        return segs
    return None
