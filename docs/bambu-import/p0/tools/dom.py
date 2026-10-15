"""Tiny DOM for the four Bambu description formats (P0 tooling, stdlib only).

A node is {'tag': str, 'attrs': dict, 'children': [node|str]}; text is a plain str.
- from_html(s): HTML string -> list of nodes
- from_react(v): a resolved React flight element tree -> list of nodes; client components become
  {'tag': '#comp', 'attrs': {props without children}, ...}; string props that hold HTML tables or
  dangerouslySetInnerHTML are parsed into children.
"""
import html as H
import re
from html.parser import HTMLParser

VOID = {'br', 'img', 'hr', 'meta', 'link', 'input', 'source', 'col', 'wbr', 'area', 'base', 'embed', 'param', 'track'}
BLOCK = {'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'ul', 'ol', 'table', 'tbody', 'thead',
         'figure', 'figcaption', 'blockquote', 'dt', 'dd', 'article', 'header', 'footer'}


class _B(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {'tag': '#root', 'attrs': {}, 'children': []}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        n = {'tag': tag.lower(), 'attrs': {k: (v if v is not None else '') for k, v in attrs}, 'children': []}
        self.stack[-1]['children'].append(n)
        if n['tag'] not in VOID:
            self.stack.append(n)

    def handle_startendtag(self, tag, attrs):
        n = {'tag': tag.lower(), 'attrs': {k: (v if v is not None else '') for k, v in attrs}, 'children': []}
        self.stack[-1]['children'].append(n)

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]['tag'] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if data:
            self.stack[-1]['children'].append(data)

    def handle_comment(self, data):
        pass


def from_html(s):
    if not s or not isinstance(s, str):
        return []
    s = re.sub(r'<style\b.*?</style>', '', s, flags=re.S | re.I)
    s = re.sub(r'<script\b.*?</script>', '', s, flags=re.S | re.I)
    b = _B()
    try:
        b.feed(s)
        b.close()
    except Exception:
        return [H.unescape(re.sub(r'<[^>]+>', ' ', s))]
    return b.root['children']


HTMLISH = re.compile(r'<(table|p|div|ul|ol|br|h\d|span|img|a|strong|b|li|tr|td)\b', re.I)


def from_react(v):
    out = []
    _react(v, out)
    return out


def _react(v, out):
    if v is None or v is True or v is False:
        return
    if isinstance(v, (int, float)):
        out.append(str(v))
        return
    if isinstance(v, str):
        if v.startswith('$'):
            return
        if HTMLISH.search(v):
            out.extend(from_html(v))
        else:
            out.append(v)
        return
    if isinstance(v, list):
        if len(v) == 4 and v[0] == '$' and isinstance(v[1], str):
            props = v[3] if isinstance(v[3], dict) else {}
            typ = v[1]
            attrs = {k: x for k, x in props.items() if k not in ('children', 'dangerouslySetInnerHTML')}
            node = {'tag': typ.lower() if not typ.startswith('$') else '#comp', 'attrs': attrs, 'children': []}
            if typ.startswith('$'):
                node['attrs']['__type'] = typ
            dsi = props.get('dangerouslySetInnerHTML')
            if isinstance(dsi, dict) and isinstance(dsi.get('__html'), str):
                node['children'].extend(from_html(dsi['__html']))
            _react(props.get('children'), node['children'])
            # client component props carrying HTML (spec tables) or nested elements
            if node['tag'] == '#comp':
                for k, x in props.items():
                    if k in ('children', 'dangerouslySetInnerHTML'):
                        continue
                    if isinstance(x, str) and '<table' in x:
                        node['children'].append({'tag': '#prop', 'attrs': {'name': k}, 'children': from_html(x)})
                    elif isinstance(x, (list, dict)):
                        sub = []
                        _react(x, sub)
                        if sub:
                            node['children'].append({'tag': '#prop', 'attrs': {'name': k}, 'children': sub})
            out.append(node)
            return
        for x in v:
            _react(x, out)
        return
    if isinstance(v, dict):
        # plain data object inside a tree: keep only element-ish values
        for k, x in v.items():
            if isinstance(x, (list, dict)):
                _react(x, out)


def walk(nodes, fn, ctx=None):
    """Depth-first, document order. fn(node, ctx) may return a new ctx for its children."""
    for n in nodes:
        if isinstance(n, str):
            fn(n, ctx)
            continue
        c2 = fn(n, ctx)
        walk(n.get('children') or [], fn, c2 if c2 is not None else ctx)


def text_of(nodes, sep_br='\n'):
    parts = []

    def rec(ns):
        for n in ns:
            if isinstance(n, str):
                parts.append(n)
                continue
            t = n['tag']
            if t == 'br':
                parts.append(sep_br)
                continue
            if t in ('#prop',) and n['attrs'].get('name') not in ('children',):
                # props of client components are content too (tables/labels)
                pass
            if t in BLOCK:
                parts.append('\n')
            rec(n.get('children') or [])
            if t in BLOCK:
                parts.append('\n')
            if t in ('td', 'th'):
                parts.append(' ')
    rec(nodes)
    s = ''.join(parts)
    s = re.sub(r'[ \t ]+', ' ', s)
    s = re.sub(r' *\n *', '\n', s)
    s = re.sub(r'\n{2,}', '\n', s)
    return s.strip()


def cell_text(n):
    """Cell text with <br> kept as ' ⏎ ' segment separators (composite cells)."""
    t = text_of(n.get('children') or [], sep_br='\n')
    return t


def table_grid(tbl):
    """Expand a <table> node into a grid of cell texts (rowspan/colspan expanded, origin flags kept)."""
    rows = []

    def collect_tr(ns):
        for n in ns:
            if isinstance(n, str):
                continue
            if n['tag'] == 'tr':
                rows.append(n)
            elif n['tag'] in ('thead', 'tbody', 'tfoot', '#prop', '#comp', 'div', 'span'):
                collect_tr(n.get('children') or [])
    collect_tr(tbl.get('children') or [])
    grid = []
    pending = {}  # col -> (text, remaining, origin)
    for tr in rows:
        cells = [c for c in (tr.get('children') or []) if not isinstance(c, str) and c['tag'] in ('td', 'th')]
        out = []
        col = 0
        ci = 0
        while ci < len(cells) or col in pending:
            if col in pending:
                txt, rem, hdr = pending[col]
                out.append({'t': txt, 'span': True, 'th': hdr, 'carry': True})
                if rem <= 1:
                    del pending[col]
                else:
                    pending[col] = (txt, rem - 1, hdr)
                col += 1
                continue
            c = cells[ci]
            ci += 1
            txt = cell_text(c)
            try:
                cs = max(1, int(str(c['attrs'].get('colspan') or c['attrs'].get('colSpan') or 1)))
            except ValueError:
                cs = 1
            try:
                rs = max(1, int(str(c['attrs'].get('rowspan') or c['attrs'].get('rowSpan') or 1)))
            except ValueError:
                rs = 1
            for j in range(cs):
                cell = {'t': txt, 'span': j > 0, 'th': c['tag'] == 'th', 'rs': rs if j == 0 else 1}
                if j > 0:
                    cell['copy'] = True
                out.append(cell)
                if rs > 1:
                    pending[col] = (txt, rs - 1, c['tag'] == 'th')
                col += 1
        grid.append({'cells': out, 'raw_n': len(cells), 'rowspan_any': any(
            str(c['attrs'].get('rowspan') or c['attrs'].get('rowSpan') or '1') not in ('1', '') for c in cells)})
    return grid


def find_all(nodes, pred):
    res = []

    def rec(ns):
        for n in ns:
            if isinstance(n, str):
                continue
            if pred(n):
                res.append(n)
            rec(n.get('children') or [])
    rec(nodes)
    return res
