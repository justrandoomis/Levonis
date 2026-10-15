/**
 * A small, tolerant HTML reader for the store's description markup (spec §C.5).
 *
 * The store's HTML is hand-written and loose: stray `</div>` closers inside a
 * table cell (the H2D "Physical Dimensions" cell), unclosed `<p>`, `<br>`
 * inside cells, Chinese comments, `<style>` blocks and paste-helper buttons.
 * A Worker has no DOM, and this package may not depend on one, so this is a
 * forgiving tokenizer plus a tree builder with the handful of implied-close
 * rules descriptions need. React element trees from the RSC payload are turned
 * into the same node shape, so every format is read by one set of helpers.
 */
import { decodeEntities } from './normalize';

export interface ElementNode {
  type: 'el';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}
export interface TextNode {
  type: 'text';
  text: string;
}
/** A client component of the RSC tree (`$L…` type): its props are kept as plain data. */
export interface ComponentNode {
  type: 'component';
  props: Record<string, unknown>;
  children: HtmlNode[];
}
export type HtmlNode = ElementNode | TextNode | ComponentNode;

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'param', 'track']);
const SKIP_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'svg']);
const BLOCK = new Set([
  'p', 'div', 'table', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'blockquote',
  'pre', 'figure', 'dl', 'nav', 'aside', 'main', 'form', 'hr',
]);
/** Tags whose opening closes an open element of the listed kinds (the implied-end rules the store needs). */
const CLOSES: Readonly<Record<string, readonly string[]>> = {
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  thead: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tfoot: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
};
/** An implied close never crosses one of these. */
const SCOPE = new Set(['table', 'ul', 'ol', 'dl', 'select']);

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Parses an HTML fragment into nodes. Never throws: malformed markup degrades to text. */
export function parseHtml(html: string): HtmlNode[] {
  const root: ElementNode = { type: 'el', tag: '#root', attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (raw: string) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    const kids = top().children;
    const last = kids[kids.length - 1];
    if (last && last.type === 'text') last.text += text;
    else kids.push({ type: 'text', text });
  };
  const closeTo = (tag: string): boolean => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) {
        stack.length = i;
        return true;
      }
    }
    return false;
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const close = /^<\/\s*([A-Za-z][A-Za-z0-9:-]*)\s*>/.exec(html.slice(lt, lt + 200));
    if (close) {
      const tag = close[1].toLowerCase();
      if (tag === 'p' && !stack.some((e) => e.tag === 'p')) {
        // A stray </p> is an empty paragraph in every browser; it adds nothing here.
      } else {
        closeTo(tag); // a stray closer with nothing open to close is ignored
      }
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([A-Za-z][A-Za-z0-9:-]*)((?:\s+[^>]*?)?)\s*(\/?)>/s.exec(html.slice(lt, lt + 4000));
    if (!open) {
      pushText('<');
      i = lt + 1;
      continue;
    }
    const tag = open[1].toLowerCase();
    i = lt + open[0].length;
    if (SKIP_CONTENT.has(tag)) {
      const endRe = new RegExp(`</\\s*${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = endRe.exec(rest);
      i = m ? i + m.index + m[0].length : n;
      continue;
    }
    // Implied ends.
    const closes = CLOSES[tag];
    if (closes) {
      for (let s = stack.length - 1; s > 0; s--) {
        if (SCOPE.has(stack[s].tag)) break;
        if (closes.includes(stack[s].tag)) {
          stack.length = s;
          break;
        }
      }
    }
    if (BLOCK.has(tag)) {
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === 'p') {
          stack.length = s;
          break;
        }
        if (SCOPE.has(stack[s].tag) || stack[s].tag === 'td' || stack[s].tag === 'th' || stack[s].tag === 'li') break;
      }
    }
    const el: ElementNode = { type: 'el', tag, attrs: parseAttrs(open[2] ?? ''), children: [] };
    top().children.push(el);
    if (!VOID.has(tag) && open[3] !== '/') stack.push(el);
  }
  return root.children;
}

/**
 * Turns a React element tree (`["$", type, key, props]`) into nodes. Host
 * elements become elements (their string props become attributes;
 * `dangerouslySetInnerHTML.__html` is parsed); client components (`$L…`)
 * become component nodes carrying their props. `props` here are already the
 * extractor's closed-list copy.
 */
export function reactToNodes(v: unknown): HtmlNode[] {
  const out: HtmlNode[] = [];
  const walk = (x: unknown) => {
    if (x === null || x === undefined || typeof x === 'boolean') return;
    if (typeof x === 'string') {
      if (x.startsWith('$') && !x.startsWith('$$')) return; // an unresolved reference: nothing to show
      out.push({ type: 'text', text: x.startsWith('$$') ? x.slice(1) : x });
      return;
    }
    if (typeof x === 'number') {
      out.push({ type: 'text', text: String(x) });
      return;
    }
    if (Array.isArray(x)) {
      if (x.length === 4 && x[0] === '$' && typeof x[1] === 'string' && x[3] && typeof x[3] === 'object' && !Array.isArray(x[3])) {
        out.push(elementOf(x[1], x[3] as Record<string, unknown>));
        return;
      }
      for (const y of x) walk(y);
      return;
    }
    if (typeof x === 'object') {
      // A plain object in children position (rare): read its children only.
      const o = x as Record<string, unknown>;
      if ('children' in o) walk(o.children);
    }
  };
  walk(v);
  return out;
}

function elementOf(type: string, props: Record<string, unknown>): HtmlNode {
  const children: HtmlNode[] = [];
  const inner = props.dangerouslySetInnerHTML;
  if (inner && typeof inner === 'object' && typeof (inner as { __html?: unknown }).__html === 'string') {
    children.push(...parseHtml((inner as { __html: string }).__html));
  }
  if ('children' in props) children.push(...reactToNodes(props.children));
  if (type.startsWith('$')) return { type: 'component', props, children };
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'children' || k === 'dangerouslySetInnerHTML') continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const name = k === 'className' ? 'class' : k === 'colSpan' ? 'colspan' : k === 'rowSpan' ? 'rowspan' : k.toLowerCase();
      attrs[name] = String(v);
    }
  }
  return { type: 'el', tag: type.toLowerCase(), attrs, children };
}

const BREAKS = new Set(['br']);
const LINE = new Set([...BLOCK, 'li', 'tr', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'caption']);

/**
 * The visible text of nodes. Block elements and `<br>` become line breaks
 * (collapsed); table cells are separated by a tab when `cells` is set.
 */
export function textOf(nodes: HtmlNode | readonly HtmlNode[], opts: { lines?: boolean } = {}): string {
  const parts: string[] = [];
  const walk = (node: HtmlNode) => {
    if (node.type === 'text') {
      parts.push(node.text);
      return;
    }
    if (node.type === 'component') {
      for (const c of node.children) walk(c);
      return;
    }
    if (BREAKS.has(node.tag)) {
      parts.push('\n');
      return;
    }
    if (node.tag === 'img' || node.tag === 'button' && node.attrs.id === 'paste-helper-id') return;
    const line = LINE.has(node.tag);
    if (line) parts.push('\n');
    for (const c of node.children) walk(c);
    if (line) parts.push('\n');
    if (node.tag === 'td' || node.tag === 'th') parts.push(' ');
  };
  for (const n of Array.isArray(nodes) ? nodes : [nodes as HtmlNode]) walk(n);
  const raw = parts.join('');
  if (opts.lines) {
    return raw
      .split('\n')
      .map((l) => l.replace(/[\s\u00a0]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }
  return raw.replace(/[\s\u00a0]+/g, ' ').trim();
}

/** Every node (pre-order) for which `pred` holds; the search does not descend into a match when `stopAtMatch`. */
export function findAll(nodes: readonly HtmlNode[], pred: (n: HtmlNode) => boolean, stopAtMatch = false): HtmlNode[] {
  const out: HtmlNode[] = [];
  const walk = (n: HtmlNode) => {
    const hit = pred(n);
    if (hit) out.push(n);
    if (hit && stopAtMatch) return;
    if (n.type !== 'text') for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

export const isEl = (tag: string) => (n: HtmlNode): n is ElementNode => n.type === 'el' && n.tag === tag;

/**
 * A table as a grid of cell texts with rowspan and colspan expanded, the
 * header row(s) first. `cellNodes` keeps each cell's nodes for composite
 * parsing (the `<br>` boundaries matter there).
 */
export interface TableGrid {
  rows: string[][];
  cellNodes: HtmlNode[][][];
  /** Cells that were really in the markup (not copies from a span), per row. */
  original: boolean[][];
  headerRows: number;
}

export function tableGrid(table: ElementNode): TableGrid {
  const trs = findAll(table.children, (n) => n.type === 'el' && n.tag === 'tr').filter((n): n is ElementNode => n.type === 'el');
  // Only rows of THIS table, not of a nested one.
  const own = trs.filter((tr) => {
    const nested = findAll(table.children, (n) => n.type === 'el' && n.tag === 'table');
    return !nested.some((t) => t !== table && findAll((t as ElementNode).children, (x) => x === tr).length > 0);
  });
  const rows: string[][] = [];
  const cellNodes: HtmlNode[][][] = [];
  const original: boolean[][] = [];
  const carry: Array<{ left: number; text: string; nodes: HtmlNode[] } | undefined> = [];
  let headerRows = 0;
  own.forEach((tr, r) => {
    const cells = tr.children.filter((c): c is ElementNode => c.type === 'el' && (c.tag === 'td' || c.tag === 'th'));
    const row: string[] = [];
    const nodesRow: HtmlNode[][] = [];
    const origRow: boolean[] = [];
    let col = 0;
    const fillCarry = () => {
      while (carry[col] && carry[col]!.left > 0) {
        row[col] = carry[col]!.text;
        nodesRow[col] = carry[col]!.nodes;
        origRow[col] = false;
        carry[col]!.left--;
        col++;
      }
    };
    for (const cell of cells) {
      fillCarry();
      const span = Math.max(1, Math.min(20, parseInt(cell.attrs.colspan ?? '1', 10) || 1));
      const rspan = Math.max(1, Math.min(50, parseInt(cell.attrs.rowspan ?? '1', 10) || 1));
      const text = textOf(cell.children, { lines: true });
      for (let s = 0; s < span; s++) {
        row[col] = text;
        nodesRow[col] = cell.children;
        origRow[col] = s === 0;
        if (rspan > 1) carry[col] = { left: rspan - 1, text, nodes: cell.children };
        col++;
      }
    }
    fillCarry();
    rows.push(row.map((x) => x ?? ''));
    cellNodes.push(nodesRow.map((x) => x ?? []));
    original.push(origRow.map((x) => x ?? false));
    const inHead = findAll(table.children, (n) => n.type === 'el' && n.tag === 'thead').some((th) => findAll((th as ElementNode).children, (x) => x === tr).length > 0);
    if (inHead && r === headerRows) headerRows++;
  });
  return { rows, cellNodes, original, headerRows };
}

/** Every link (`<a href>`) in the nodes, with its text. */
export function linksOf(nodes: readonly HtmlNode[]): Array<{ href: string; text: string }> {
  return findAll(nodes, (n) => n.type === 'el' && n.tag === 'a' && !!n.attrs.href).map((n) => ({
    href: (n as ElementNode).attrs.href,
    text: textOf((n as ElementNode).children),
  }));
}

/** Every image source (`src`, `data-src`) in the nodes, with its alt text. */
export function imagesOf(nodes: readonly HtmlNode[]): Array<{ src: string; alt: string }> {
  return findAll(nodes, (n) => n.type === 'el' && n.tag === 'img').map((n) => {
    const a = (n as ElementNode).attrs;
    return { src: a['data-src'] || a.src || '', alt: a.alt ?? '' };
  }).filter((x) => x.src);
}
