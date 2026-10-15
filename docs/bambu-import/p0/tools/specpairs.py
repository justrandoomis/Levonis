"""Spec table -> labelled pairs (P0). Shapes: 2-cell KV, 4-cell double KV, 'Item|Item|Specification' grouped KV,
header/column tables ('Product ID | ... ' one row per item), messages key/value tables."""
import re

HDR_WORDS = re.compile(r'^(product id|sku|name|item|model|type|specification|specifications|parameter|parameters|value)$', re.I)


def norm_label(s):
    s = (s or '').replace('\n', ' ')
    s = re.sub(r'\s+', ' ', s).strip().strip(':：').strip()
    return s


def row_texts(row):
    return [c['t'] for c in row['cells']]


def logical(row):
    return [c['t'] for c in row['cells'] if not c.get('copy')]


def pairs(table):
    """Yield dicts {label, value, group, scope_hint, locator, shape}."""
    rows = [r for r in table if r['cells']]
    if not rows:
        return []
    out = []
    first = row_texts(rows[0])
    width = max(len(r['cells']) for r in rows)
    is_item_spec = len(first) >= 2 and first[0].strip().lower() == 'item' and re.search(r'specification', first[-1], re.I)
    if is_item_spec:
        for i, r in enumerate(rows[1:], 1):
            t = logical(r)
            if len(t) >= 3:
                group, label, value = t[0], t[-2], t[-1]
                if group == label:
                    group = ''
            elif len(t) == 2:
                group, label, value = '', t[0], t[1]
            else:
                continue
            out.append({'label': norm_label(label), 'value': value.strip(), 'group': norm_label(group),
                        'locator': 'row %d' % i, 'shape': 'item_spec'})
        return out
    carry_rows = sum(1 for r in rows if r['cells'] and r['cells'][0].get('carry'))
    if width == 3 and carry_rows >= 1 and not HDR_WORDS.match(norm_label(first[0])):
        for i, r in enumerate(rows):
            t = logical(r)
            if len(t) >= 3:
                group, label, value = t[0], t[-2], t[-1]
            elif len(t) == 2:
                group, label, value = '', t[0], t[1]
            else:
                continue
            out.append({'label': norm_label(label), 'value': value.strip(), 'group': norm_label(group), 'locator': 'row %d' % (i + 1), 'shape': 'grouped_kv'})
        return out
    header_like = width >= 3 and width != 4 and (any(HDR_WORDS.match(norm_label(x)) for x in first) or all(c.get('th') for c in rows[0]['cells']))
    if width >= 5 or header_like or (width == 3 and len(first) == 3):
        hdr = [norm_label(x) for x in first]
        scope_col = 0 if hdr and re.match(r'^(product id|sku|model|name|item)$', hdr[0], re.I) else None
        for i, r in enumerate(rows[1:], 1):
            t = row_texts(r)
            scope = t[0] if scope_col == 0 and t else ''
            for j, v in enumerate(t):
                if j == scope_col or j >= len(hdr) or not hdr[j]:
                    continue
                out.append({'label': hdr[j], 'value': v.strip(), 'group': '', 'scope_hint': scope,
                            'locator': 'row %d col %d' % (i, j), 'shape': 'column_table'})
        return out
    for i, r in enumerate(rows):
        t = row_texts(r) if len(row_texts(r)) in (2, 4) else logical(r)
        if len(t) == 2 or len(t) == 4:
            for k in range(0, len(t) - 1, 2):
                if norm_label(t[k]):
                    out.append({'label': norm_label(t[k]), 'value': t[k + 1].strip(), 'group': '',
                                'locator': r.get('locator') or 'row %d' % (i + 1), 'shape': 'kv%d' % len(t)})
        elif len(t) == 3:
            out.append({'label': norm_label(t[1]), 'value': t[2].strip(), 'group': norm_label(t[0]),
                        'locator': 'row %d' % (i + 1), 'shape': 'kv3'})
    return out
