/**
 * DESCRIPTIONS: FOUR SOURCE FORMATS INTO ONE NEUTRAL TREE (spec §C.5).
 *
 *   A legacy_html          the `pct_*` template, split at headings
 *   B sections_html        named sections, one HTML string each
 *   C page_builder         the component tree (banner / chapter / content blocks;
 *                          `Download` → documents; `content-block-21-pro` → FAQ)
 *   D1 bespoke_shopify_port `…__product_description_<kind>_<id>` sections
 *   D2 bespoke_new         nav-anchored client components and their props,
 *                          plus the messages spec table where the page renders one
 *
 * Cleaning on every format: no <style>, comments, paste-helper buttons or the
 * placeholder alt `图片加载失败文案`; store-test images ignored; queries stripped
 * from kept links; tracker links collected for ENRICH (never followed here);
 * relative store links turned into handles. Every sentence is classified
 * later (sentences.ts) — nothing here decides what a customer may read.
 */
import type { DescriptionSource } from './extract';
import {
  findAll,
  imagesOf,
  parseHtml,
  reactToNodes,
  tableGrid,
  textOf,
  type ElementNode,
  type HtmlNode,
  type TableGrid,
} from './html';
import { absolutize, collapseWs, decodeEntities, decodeHandle, hostOf, stripQuery } from './normalize';
import { sectionKindOf, type SectionKind } from './registry/sections';

export type Block =
  | { t: 'text'; text: string }
  | { t: 'image'; url: string; alt: string }
  | { t: 'table'; grid: TableGrid; note?: string }
  | { t: 'list'; items: string[] }
  | { t: 'link'; url: string; text: string }
  | { t: 'video'; url: string }
  | { t: 'box_item'; text: string; qty: number | null; image: string | null; scopes?: string[] }
  | { t: 'faq'; question: string; answer: string };

export interface Section {
  kind: SectionKind;
  title: string;
  /** Where the section came from (format-specific path), for provenance. */
  path: string;
  blocks: Block[];
}

export interface DescribedLink {
  url: string;
  text: string;
  section: SectionKind;
  /** The prop or element the link came from ('a', 'link', 'dtsLink', 'download', 'iframe' …). */
  via: string;
}

export interface Described {
  format: DescriptionSource['kind'];
  sections: Section[];
  /** Links to downloadable documents (PDF, ZIP, 3MF …) and documented props (link / dtsLink / Download items). */
  documents: DescribedLink[];
  /** wiki.bambulab.com links. */
  wikiLinks: DescribedLink[];
  /** e.bambulab.com/t?c=… tracker links: resolved in ENRICH, never here. */
  trackerLinks: DescribedLink[];
  /** YouTube embeds and links, and CDN .mp4 files. */
  videos: DescribedLink[];
  /** makerworld.com and other off-store links (kept as text, listed for review). */
  otherLinks: DescribedLink[];
  /** Links to other store products, by decoded handle. */
  storeLinks: Array<{ handle: string; text: string }>;
  /** A D2 page's messages spec table as label/value pairs. */
  specPairs: Array<{ label: string; value: string; locator: string; group: string }>;
}

const PLACEHOLDER_ALT = '图片加载失败文案';
const STORE_HOST = /(^|\.)store\.bambulab\.com$/i;

type Ev =
  | { e: 'heading'; text: string }
  | { e: 'text'; text: string }
  | { e: 'list'; items: string[] }
  | { e: 'table'; node: ElementNode; note?: string }
  | { e: 'image'; url: string; alt: string }
  | { e: 'link'; url: string; text: string; via: string }
  | { e: 'video'; url: string }
  | { e: 'faq'; question: string; answer: string }
  | { e: 'box'; text: string; image: string | null };

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'li', 'ul', 'ol', 'table', 'blockquote', 'pre', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'main', 'aside', 'nav', 'button', 'tr', 'td', 'th', 'details', 'summary',
]);

function cleanAlt(alt: string): string {
  const a = collapseWs(alt);
  return a === PLACEHOLDER_ALT ? '' : a;
}

function imageUrl(raw: string): string {
  const u = absolutize(raw.trim());
  return /^https:\/\//i.test(u) ? u : '';
}

/** Flattens nodes into events in document order. */
function flatten(nodes: readonly HtmlNode[], out: Ev[]): void {
  let buf = '';
  const flush = () => {
    const t = buf
      .split('\n')
      .map((l) => collapseWs(l))
      .filter(Boolean)
      .join('\n');
    if (t) out.push({ e: 'text', text: t });
    buf = '';
  };
  const walk = (n: HtmlNode) => {
    if (n.type === 'text') {
      buf += n.text;
      return;
    }
    if (n.type === 'component') {
      flush();
      componentEvents(n.props, out);
      for (const c of n.children) walk(c);
      flush();
      return;
    }
    const tag = n.tag;
    if (tag === 'br') {
      buf += '\n';
      return;
    }
    if (tag === 'button' && n.attrs.id === 'paste-helper-id') return;
    if (/^h[1-6]$/.test(tag)) {
      flush();
      const text = textOf(n.children);
      if (text) out.push({ e: 'heading', text });
      return;
    }
    if (tag === 'table') {
      flush();
      out.push({ e: 'table', node: n });
      return;
    }
    if (tag === 'img') {
      const url = imageUrl(n.attrs['data-src'] || n.attrs.src || '');
      if (url && !/store-test\.bblcdn\.com/i.test(url)) {
        flush();
        out.push({ e: 'image', url, alt: cleanAlt(n.attrs.alt ?? '') });
      }
      return;
    }
    if (tag === 'iframe' || tag === 'video' || tag === 'source') {
      const url = imageUrl(n.attrs['data-src'] || n.attrs.src || '');
      if (url) {
        flush();
        out.push({ e: 'video', url });
      }
      if (tag === 'video') for (const c of n.children) walk(c);
      return;
    }
    if (tag === 'a') {
      const href = (n.attrs.href ?? '').trim();
      const text = textOf(n.children);
      if (href) out.push({ e: 'link', url: href, text, via: 'a' });
      for (const c of n.children) walk(c);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      const items = n.children
        .filter((c): c is ElementNode => c.type === 'el' && c.tag === 'li')
        .map((li) => textOf(li.children, { lines: true }))
        .filter(Boolean);
      if (items.length) out.push({ e: 'list', items });
      // Images and links inside list items are events too.
      for (const li of n.children) {
        if (li.type !== 'el') continue;
        for (const img of imagesOf(li.children)) {
          const url = imageUrl(img.src);
          if (url) out.push({ e: 'image', url, alt: cleanAlt(img.alt) });
        }
        for (const a of findAll(li.children, (x) => x.type === 'el' && x.tag === 'a' && !!x.attrs.href)) {
          const el = a as ElementNode;
          out.push({ e: 'link', url: el.attrs.href.trim(), text: textOf(el.children), via: 'a' });
        }
      }
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    for (const c of n.children) walk(c);
    if (block) flush();
  };
  for (const n of nodes) walk(n);
  flush();
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Text that may itself be HTML (D2 props, page-builder descriptions). */
function richText(s: string): string {
  if (!s) return '';
  if (/<[a-z!/]/i.test(s)) return textOf(parseHtml(s), { lines: true });
  return decodeEntities(s).split('\n').map(collapseWs).filter(Boolean).join('\n');
}

/** Events from a D2 client component's (closed-list) props. */
function componentEvents(p: Record<string, unknown>, out: Ev[]): void {
  const title = str(p.title) || str(p.label);
  if (title && !p.sections) out.push({ e: 'heading', text: collapseWs(title) });
  if (str(p.subtitle)) out.push({ e: 'text', text: richText(str(p.subtitle)) });
  if (str(p.description)) out.push({ e: 'text', text: richText(str(p.description)) });
  if (str(p.text) && typeof p.text === 'string') out.push({ e: 'text', text: richText(str(p.text)) });
  if (str(p.note)) out.push({ e: 'text', text: richText(str(p.note)) });
  const img = obj(p.image);
  if (str(img.src)) out.push({ e: 'image', url: imageUrl(str(img.src)), alt: cleanAlt(str(img.alt)) });
  if (str(p.src) && !p.children) {
    const url = imageUrl(str(p.src));
    if (url) out.push({ e: 'image', url, alt: cleanAlt(str(p.alt)) });
  }
  for (const it of arr(p.items)) {
    const o = obj(it);
    if (str(o.title)) out.push({ e: 'text', text: richText(str(o.title)) });
    if (str(o.description)) out.push({ e: 'text', text: richText(str(o.description)) });
    const im = obj(o.image);
    if (str(im.src)) out.push({ e: 'image', url: imageUrl(str(im.src)), alt: cleanAlt(str(im.alt)) });
  }
  for (const it of arr(p.images)) {
    const o = obj(it);
    const src = str(o.src) || str(o.hoverSrc);
    if (src) out.push({ e: 'image', url: imageUrl(src), alt: cleanAlt(str(o.alt) || str(o.title) || str(o.label)) });
  }
  for (const it of arr(p.textSource)) {
    const o = obj(it);
    if (str(o.title)) out.push({ e: 'heading', text: collapseWs(str(o.title)) });
    if (str(o.description)) out.push({ e: 'text', text: richText(str(o.description)) });
  }
  if (str(p.mediaUrl) && /\.mp4(\?|$)/i.test(str(p.mediaUrl))) out.push({ e: 'video', url: str(p.mediaUrl) });
  const button = obj(p.button);
  if (str(button.mediaUrl) && /\.mp4(\?|$)/i.test(str(button.mediaUrl))) out.push({ e: 'video', url: str(button.mediaUrl) });
  for (const key of ['link', 'dtsLink'] as const) {
    const url = str(p[key]);
    if (url) out.push({ e: 'link', url, text: key === 'dtsLink' || p.collapseTable ? 'TDS' : '', via: key });
  }
  for (const key of ['notCollapseTable', 'collapseTable'] as const) {
    const html = str(p[key]);
    if (!html) continue;
    for (const t of findAll(parseHtml(html), (n) => n.type === 'el' && n.tag === 'table', true)) {
      out.push({ e: 'table', node: t as ElementNode, note: str(p.tableNote) || undefined });
    }
  }
  if (str(p.tableNote)) out.push({ e: 'text', text: richText(str(p.tableNote)) });
  // In the box (H2D): images and item names that do not pair one to one.
  const imgs = arr(p.imageSource).map((x) => imageUrl(str(x))).filter(Boolean);
  const texts = arr(p.textList).map((x) => collapseWs(str(x))).filter(Boolean);
  if (imgs.length || texts.length) {
    out.push({ e: 'heading', text: "What's in the box" });
    for (const t of texts) out.push({ e: 'box', text: t, image: null });
    for (const u of imgs) out.push({ e: 'image', url: u, alt: '' });
  }
  for (const it of arr(p.faqItems)) {
    const o = obj(it);
    const q = collapseWs(str(o.question));
    const a = richText(str(o.answer));
    if (q || a) out.push({ e: 'faq', question: q, answer: a });
  }
}

/** Sections from events: a heading starts a section; its kind from its title, else the enclosing kind. */
function sectionize(events: Ev[], base: { kind: SectionKind; title: string; path: string }, out: Section[]): void {
  let cur: Section = { kind: base.kind, title: base.title, path: base.path, blocks: [] };
  let n = 0;
  const close = () => {
    if (cur.blocks.length || cur.title) out.push(cur);
  };
  for (const ev of events) {
    if (ev.e === 'heading') {
      close();
      const k = sectionKindOf(ev.text);
      n++;
      cur = { kind: k === 'other' ? base.kind : k, title: ev.text, path: `${base.path} › ${n}`, blocks: [] };
      continue;
    }
    cur.blocks.push(blockOf(ev));
  }
  close();
}

/** A section's repeated text (carousels render the same caption twice) is kept once. */
function dedupeTexts(sections: Section[]): void {
  for (const s of sections) {
    const seen = new Set<string>();
    s.blocks = s.blocks.filter((b) => {
      if (b.t !== 'text') return true;
      if (seen.has(b.text)) return false;
      seen.add(b.text);
      return true;
    });
  }
}

function blockOf(ev: Exclude<Ev, { e: 'heading' }>): Block {
  switch (ev.e) {
    case 'text':
      return { t: 'text', text: ev.text };
    case 'list':
      return { t: 'list', items: ev.items };
    case 'table':
      return { t: 'table', grid: tableGrid(ev.node), note: ev.note };
    case 'image':
      return { t: 'image', url: ev.url, alt: ev.alt };
    case 'link':
      return { t: 'link', url: ev.url, text: ev.text };
    case 'video':
      return { t: 'video', url: ev.url };
    case 'faq':
      return { t: 'faq', question: ev.question, answer: ev.answer };
    case 'box':
      return { t: 'box_item', ...parseBoxItem(ev.text), image: ev.image };
  }
}

/** "- BT2-8 Screw *2" → {BT2-8 Screw, 2}; "2x M3*21.5 screws" → {M3*21.5 screws, 2}; "Spool Holder (x4)" → 4. */
export function parseBoxItem(raw: string): { text: string; qty: number | null } {
  let t = collapseWs(raw.replace(/^[-–•·*]\s*/, ''));
  let qty: number | null = null;
  // A trailing "*N" after a word is a count; after a digit (M3*21) it is part of a dimension.
  let m = /(?<![\d.])\s*[*×]\s*(\d{1,3})\s*$/.exec(t) ?? /\s+x\s*(\d{1,3})\s*$/i.exec(t);
  if (m) {
    qty = Number(m[1]);
    t = t.slice(0, m.index).trim();
  } else if ((m = /\(\s*[x×]\s*(\d{1,3})\s*\)\s*$/i.exec(t))) {
    qty = Number(m[1]);
    t = t.slice(0, m.index).trim();
  } else if ((m = /^(\d{1,3})\s*[x×]\s+/i.exec(t))) {
    qty = Number(m[1]);
    t = t.slice(m[0].length).trim();
  }
  return { text: t, qty };
}

function emptyDescribed(format: DescriptionSource['kind']): Described {
  return { format, sections: [], documents: [], wikiLinks: [], trackerLinks: [], videos: [], otherLinks: [], storeLinks: [], specPairs: [] };
}

const DOC_FILE = /\.(pdf|zip|3mf|stl|step|stp|f3d)(\?|#|$)/i;

/** Sorts every link of every section into its kind. */
function collectLinks(d: Described): void {
  const seen = new Set<string>();
  for (const s of d.sections) {
    for (const b of s.blocks) {
      if (b.t === 'link') classify(b.url, b.text, s.kind, 'a');
      if (b.t === 'video') classify(b.url, '', s.kind, 'video');
    }
  }
  function classify(raw: string, text: string, section: SectionKind, via: string) {
    const url0 = absolutize(raw.trim());
    if (!url0 || /^(mailto|tel|javascript):/i.test(url0)) return;
    if (!/^https?:\/\//i.test(url0)) {
      // Relative store link (../../../products/<handle>).
      const m = /\/products\/([^/?#]+)/.exec(url0);
      if (m) d.storeLinks.push({ handle: decodeHandle(m[1]), text });
      return;
    }
    const host = hostOf(url0);
    if (host === 'e.bambulab.com' && /\/t\b/.test(url0)) {
      // A tracker link keeps its query: it IS the identifier ENRICH resolves.
      if (!seen.has(url0)) d.trackerLinks.push({ url: url0, text, section, via });
      seen.add(url0);
      return;
    }
    const url = stripQuery(url0);
    if (seen.has(url)) return;
    seen.add(url);
    if (STORE_HOST.test(host)) {
      const m = /\/products\/([^/?#]+)/.exec(url);
      if (m) d.storeLinks.push({ handle: decodeHandle(m[1]), text });
      return;
    }
    const link = { url: url.replace(/^http:/i, 'https:'), text, section, via };
    if (host === 'wiki.bambulab.com') d.wikiLinks.push(link);
    else if (host.endsWith('youtube.com') || host === 'youtu.be' || /\.mp4$/i.test(url)) d.videos.push(link);
    else if (DOC_FILE.test(url)) d.documents.push(link);
    else d.otherLinks.push(link);
  }
}

/** Builds the neutral tree of a description source. */
export function describe(src: DescriptionSource): Described {
  const d = emptyDescribed(src.kind);
  switch (src.kind) {
    case 'legacy_html': {
      const ev: Ev[] = [];
      flatten(parseHtml(src.html), ev);
      sectionize(ev, { kind: 'overview', title: '', path: 'html' }, d.sections);
      break;
    }
    case 'sections_html': {
      src.sections.forEach((s, i) => {
        const ev: Ev[] = [];
        flatten(parseHtml(s.html), ev);
        const k = sectionKindOf(s.name);
        sectionize(ev, { kind: k === 'other' ? 'features' : k, title: s.name, path: `sections[${i}] ${s.name}` }, d.sections);
      });
      break;
    }
    case 'page_builder':
      pageBuilder(src.config, d);
      break;
    case 'bespoke_shopify_port':
      shopifyPort(src.tree, d);
      break;
    case 'bespoke_new':
      bespokeNew(src, d);
      break;
    case 'component_list':
      componentList(src.components, d);
      break;
    case 'none':
      break;
  }
  dedupeTexts(d.sections);
  collectLinks(d);
  return d;
}

// ---------------------------------------------------------------- C: page builder

function pageBuilder(config: unknown, d: Described): void {
  const comps = arr(obj(config).components);
  const visit = (c: unknown, path: string) => {
    const o = obj(c);
    const name = str(o.name);
    const variant = str(o.variant);
    const modules = obj(o.modules);
    const content = obj(obj(modules.typeStyles).content);
    const title = collapseWs(str(content.title));
    const anchor = str(obj(o.anchor).name);
    const isFaq = variant === 'content-block-21-pro' || /faq|printing tips/i.test(name);
    const isDownload = /download/i.test(name) || /download/i.test(title);
    let kind: SectionKind = str(o.type) === 'banner' ? 'overview' : 'features';
    if (isFaq) kind = 'faq';
    else if (isDownload) kind = 'other';
    else {
      const k = sectionKindOf(title || anchor);
      if (k !== 'other') kind = k;
    }
    const s: Section = { kind, title: title || anchor || name, path, blocks: [] };
    const desc = str(content.description);
    if (desc) s.blocks.push({ t: 'text', text: richText(desc) });
    for (const key of ['subtitle', 'subtitle2', 'text'] as const) if (str(content[key])) s.blocks.push({ t: 'text', text: richText(str(content[key])) });
    const media = obj(modules.media);
    const pc = obj(media.pc);
    if (str(pc.src) && str(pc.type) !== 'video') s.blocks.push({ t: 'image', url: imageUrl(str(pc.src)), alt: '' });
    if (str(pc.src) && str(pc.type) === 'video') s.blocks.push({ t: 'video', url: str(pc.src) });
    const fc = obj(modules.featureConfig);
    for (const it of arr(fc.items)) {
      const io = obj(it);
      const link = str(io.link);
      const text = collapseWs(str(io.description) || str(io.title));
      if (link) s.blocks.push({ t: 'link', url: link, text });
      else if (text) s.blocks.push({ t: 'text', text: richText(str(io.description) || str(io.title)) });
      const im = obj(obj(io.media).pc);
      if (!link && str(im.src)) s.blocks.push({ t: 'image', url: imageUrl(str(im.src)), alt: '' });
    }
    for (const card of [...arr(fc.cards), ...arr(fc.tabs)]) {
      const co = obj(card);
      const ct = collapseWs(str(co.title));
      if (ct) s.blocks.push({ t: 'text', text: ct });
      if (str(co.description)) s.blocks.push({ t: 'text', text: richText(str(co.description)) });
      const im = obj(obj(co.media).pc);
      if (str(im.src)) s.blocks.push({ t: 'image', url: imageUrl(str(im.src)), alt: '' });
    }
    for (const f of arr(fc.faqs)) {
      const fo = obj(f);
      const answer = arr(fo.answerBlocks).map((b) => richText(str(obj(b).content))).filter(Boolean).join('\n');
      s.blocks.push({ t: 'faq', question: collapseWs(str(fo.question)), answer });
      // Links inside answers (wiki guides) are links of the section.
      for (const b of arr(fo.answerBlocks)) {
        for (const a of findAll(parseHtml(str(obj(b).content)), (n) => n.type === 'el' && n.tag === 'a' && !!n.attrs.href)) {
          const el = a as ElementNode;
          s.blocks.push({ t: 'link', url: el.attrs.href, text: textOf(el.children) });
        }
      }
    }
    if (desc && /<a\s/i.test(desc)) {
      for (const a of findAll(parseHtml(desc), (n) => n.type === 'el' && n.tag === 'a' && !!n.attrs.href)) {
        const el = a as ElementNode;
        s.blocks.push({ t: 'link', url: el.attrs.href, text: textOf(el.children) });
      }
    }
    if (s.blocks.length) d.sections.push(s);
    arr(o.children).forEach((ch, i) => visit(ch, `${path} › ${i}`));
  };
  comps.forEach((c, i) => visit(c, `components[${i}]`));
}

// ---------------------------------------------------------------- D1: the Shopify-theme port

const D1_SECTION = /__product_description_([a-z_]+?)_[A-Za-z0-9]{6}$/;
const D1_KINDS: Readonly<Record<string, SectionKind>> = {
  special: 'specs',
  what_is_in_the_box: 'in_the_box',
  faq: 'faq',
  grip: 'features',
  pic_and_text: 'features',
  unboxing: 'instructions',
  youtubers: 'other',
};

function shopifyPort(tree: unknown, d: Described): void {
  const nodes = reactToNodes(tree);
  const sections = findAll(nodes, (n) => n.type === 'el' && D1_SECTION.test(n.attrs.id ?? ''), true).map((n) => ({
    kind: D1_SECTION.exec((n as ElementNode).attrs.id)![1],
    node: n as ElementNode,
  }));
  const inSection = new Set<HtmlNode>();
  for (const s of sections) for (const x of findAll([s.node], () => true)) inSection.add(x);
  // Images outside every section (the hero banners above them) are the overview.
  const preImages = findAll(nodes, (n) => n.type === 'component' && typeof n.props.src === 'string', true).filter((n) => !inSection.has(n));
  if (preImages.length) {
    d.sections.push({
      kind: 'overview',
      title: '',
      path: 'banner',
      blocks: preImages
        .map((n) => ({ t: 'image' as const, url: imageUrl(String((n as { props: Record<string, unknown> }).props.src)), alt: '' }))
        .filter((b) => b.url),
    });
  }
  sections.forEach((s, i) => {
    if (s.kind === 'nav' || s.kind === 'nav_anchor') return;
    const kind = D1_KINDS[s.kind] ?? 'features';
    const ev: Ev[] = [];
    flatten([s.node], ev);
    if (kind === 'in_the_box') {
      // image + item-name pairs; the first text is the block title ("What's in the box", "A1 Combo Add-ons").
      const title = ev.find((e) => e.e === 'text') as { e: 'text'; text: string } | undefined;
      const blocks: Block[] = [];
      let pendingImage: string | null = null;
      let first = true;
      for (const e of ev) {
        if (e.e === 'text' && first) {
          first = false;
          continue;
        }
        if (e.e === 'image') pendingImage = e.url;
        else if (e.e === 'text') {
          for (const line of e.text.split('\n')) {
            blocks.push({ t: 'box_item', ...parseBoxItem(line), image: pendingImage });
            pendingImage = null;
          }
        }
      }
      d.sections.push({ kind, title: title?.text ?? '', path: `d1:${s.kind}[${i}]`, blocks });
      return;
    }
    if (kind === 'faq') {
      // Each item is a container whose first element is the question <button> and the next one the answer.
      const title = (ev.find((e) => e.e === 'text') as { text: string } | undefined)?.text ?? '';
      const blocks: Block[] = [];
      const buttons = findAll([s.node], (n) => n.type === 'el' && n.tag === 'button');
      const parents = findAll([s.node], (n) => n.type === 'el' && n.children.some((c) => buttons.includes(c)));
      for (const par of parents) {
        if (par.type !== 'el') continue;
        const kids = par.children.filter((c): c is ElementNode => c.type === 'el');
        const qi = kids.findIndex((c) => buttons.includes(c));
        const question = textOf(kids[qi].children);
        const answer = kids.slice(qi + 1).map((c) => textOf(c.children, { lines: true })).filter(Boolean).join('\n');
        if (question) blocks.push({ t: 'faq', question, answer });
      }
      for (const e of ev) if (e.e === 'link') blocks.push({ t: 'link', url: e.url, text: e.text });
      d.sections.push({ kind, title, path: `d1:${s.kind}[${i}]`, blocks });
      return;
    }
    const title = (ev.find((e) => e.e === 'text') as { text: string } | undefined)?.text ?? '';
    const sec: Section[] = [];
    sectionize(ev, { kind, title, path: `d1:${s.kind}[${i}]` }, sec);
    // A D1 section's own title is its first text; keep the declared kind for the whole section.
    for (const x of sec) d.sections.push({ ...x, kind: x.kind === 'other' ? kind : x.kind });
  });
}

// ---------------------------------------------------------------- D2: the bespoke pages

function bespokeNew(src: Extract<DescriptionSource, { kind: 'bespoke_new' }>, d: Described): void {
  const nodes = reactToNodes(src.tree);
  const navIds = new Map(src.navSections.map((s) => [s.id, s.label]));
  // Split the top-level content at the nav anchors (an element or component whose id is a nav id).
  let cur = { id: '', label: '', nodes: [] as HtmlNode[] };
  const parts: Array<typeof cur> = [];
  const anchorOf = (n: HtmlNode): string => {
    if (n.type === 'el') return navIds.has(n.attrs.id ?? '') ? n.attrs.id : '';
    if (n.type === 'component') return typeof n.props.id === 'string' && navIds.has(n.props.id) ? (n.props.id as string) : '';
    return '';
  };
  const visit = (n: HtmlNode) => {
    const a = anchorOf(n);
    if (a) {
      if (cur.nodes.length) parts.push(cur);
      cur = { id: a, label: navIds.get(a) ?? a, nodes: [n] };
      return;
    }
    // Descend into wrappers that contain anchors; otherwise the node belongs to the current part.
    const hasAnchor = n.type !== 'text' && findAll(n.children, (x) => !!anchorOf(x)).length > 0;
    if (hasAnchor) {
      if (n.type === 'component') {
        const ev: Ev[] = [];
        componentEvents(n.props, ev);
        if (ev.length) cur.nodes.push({ type: 'component', props: n.props, children: [] });
      }
      for (const c of n.children) visit(c);
      return;
    }
    cur.nodes.push(n);
  };
  for (const n of nodes) visit(n);
  if (cur.nodes.length) parts.push(cur);
  parts.forEach((p, i) => {
    const ev: Ev[] = [];
    flatten(p.nodes, ev);
    const k = sectionKindOf(p.label);
    const base = { kind: (k === 'other' ? 'features' : k) as SectionKind, title: p.label, path: `d2:${p.id || 'top'}[${i}]` };
    const secs: Section[] = [];
    sectionize(ev, base, secs);
    for (const s of secs) {
      // In a box section, an image with an item name as its alt is an item (AMS 2 Pro).
      if (s.kind === 'in_the_box') {
        s.blocks = s.blocks.map((b) => (b.t === 'image' && b.alt ? { t: 'box_item', ...parseBoxItem(b.alt), image: b.url } : b));
      }
      d.sections.push(s);
    }
  });
  if (src.specTable) {
    let group = '';
    for (const [k, v] of Object.entries(src.specTable)) {
      if (k.endsWith('Value')) continue;
      const value = src.specTable[`${k}Value`];
      if (value === undefined) {
        if (k !== 'item' && k !== 'specification') group = v;
        continue;
      }
      d.specPairs.push({ label: v, value, locator: `messages.SpecificationTable.${k}`, group });
    }
  }
}

// ---------------------------------------------------------------- E: the component list (H2S, P2S, H2C …)

const E_KIND: Readonly<Record<string, SectionKind>> = { SpecTable: 'specs', Inbox: 'in_the_box', FAQ: 'faq', FootNote: 'other' };
/** Components that are no product description: the anchor bar and the MakerWorld model showcase. */
const E_SKIP: ReadonlySet<string> = new Set(['Anchor', 'EndlessModels']);
const E_TEXT_KEYS: ReadonlySet<string> = new Set([
  'title', 'subtitle', 'subTitle', 'mainTitleText', 'subtitleText', 'description', 'text', 'originalText', 'h2Text', 'caption', 'note',
  'footNote', 'featureTitle', 'featureSubtitle', 'descriptionInfoTitle', 'descriptionInfoDescription', 'label', 'leftLabel',
  'rightLabel', 'collapseText', 'notCollapseText', 'question', 'answer',
]);
const E_LINK_KEYS: ReadonlySet<string> = new Set(['link', 'downloadLink', 'buttonUrl']);
const E_VIDEO_KEYS: ReadonlySet<string> = new Set(['videoUrl', 'mediaUrl', 'pcVideo']);
const VIDEO_FILE = /\.(mp4|mov|webm|m3u8)(\?|#|$)/i;

function componentList(components: unknown, d: Described): void {
  const comps = arr(components).map(obj);
  const anchors = new Map<string, string>();
  for (const c of comps) {
    if (str(c.componentType) !== 'Anchor') continue;
    for (const a of arr(obj(c.data).list)) anchors.set(String(obj(a).id ?? ''), collapseWs(str(obj(a).name)));
  }
  comps.forEach((c, i) => {
    const ct = str(c.componentType);
    if (!ct || E_SKIP.has(ct)) return;
    const data = obj(c.data);
    const anchorName = anchors.get(String(data.anchorId ?? '')) ?? '';
    // E titles mark line breaks with '#' ("Multi-Color#3D Printing").
    const eText = (raw: string) => richText(raw).replace(/\s*#\s*/g, ' ').trim();
    const title = collapseWs(eText(str(data.title) || str(data.mainTitleText) || str(obj(data.pc).title)));
    const byTitle = sectionKindOf(title);
    const byAnchor = sectionKindOf(anchorName);
    const kind: SectionKind = E_KIND[ct] ?? (byTitle !== 'other' ? byTitle : byAnchor !== 'other' ? byAnchor : 'features');
    const s: Section = { kind, title: title || anchorName, path: `e:${str(c.componentName) || ct}[${i}]`, blocks: [] };
    if (ct === 'SpecTable') {
      const note = richText(str(data.tableNote)) || undefined;
      for (const key of ['notCollapseTable', 'collapseTable'] as const) {
        const html = str(data[key]);
        if (!html) continue;
        for (const t of findAll(parseHtml(html), (n) => n.type === 'el' && n.tag === 'table', true)) {
          s.blocks.push({ t: 'table', grid: tableGrid(t as ElementNode), note });
        }
      }
      if (note) s.blocks.push({ t: 'text', text: note });
      if (str(data.link)) s.blocks.push({ t: 'link', url: str(data.link), text: 'TDS' });
    } else if (ct === 'Inbox') {
      // Columns 2… are the versions an item ships with ("H2S AMS Combo", "H2S Laser Full Combo", "H2S").
      const headers = obj(data.headers);
      const cols = ['column2', 'column3', 'column4', 'column5'].filter((k) => collapseWs(str(headers[k])));
      for (const it of arr(data.items)) {
        const o = obj(it);
        const c1 = obj(o.column1);
        const parsed = parseBoxItem(richText(str(c1.text)));
        if (!parsed.text) continue;
        const image = arr(c1.image).map((x) => imageUrl(str(obj(x).url))).find(Boolean) ?? null;
        let qty = parsed.qty;
        const scopes: string[] = [];
        for (const k of cols) {
          const cell = obj(o[k]);
          const t = collapseWs(str(cell.text));
          if (cell.showCheckIcon === true || t) scopes.push(collapseWs(str(headers[k])));
          const n = /^[x×]?\s*(\d{1,3})$/i.exec(t);
          if (qty === null && n) qty = Number(n[1]);
        }
        s.blocks.push({ t: 'box_item', text: parsed.text, qty, image, ...(cols.length && scopes.length < cols.length ? { scopes } : {}) });
      }
    } else if (ct === 'FAQ') {
      for (const it of arr(data.faqItems)) {
        const o = obj(it);
        const q = collapseWs(richText(str(o.question)));
        const a = richText(str(o.answer));
        if (q || a) s.blocks.push({ t: 'faq', question: q, answer: a });
      }
    } else {
      const seenText = new Set<string>([title]);
      const walk = (v: unknown, key: string) => {
        if (typeof v === 'string') {
          const raw = v.trim();
          if (!raw) return;
          if (/<table/i.test(raw)) {
            for (const t of findAll(parseHtml(raw), (n) => n.type === 'el' && n.tag === 'table', true)) s.blocks.push({ t: 'table', grid: tableGrid(t as ElementNode) });
            return;
          }
          if (E_LINK_KEYS.has(key)) {
            if (/^https?:\/\//i.test(raw)) s.blocks.push({ t: 'link', url: raw, text: '' });
            return;
          }
          if (E_VIDEO_KEYS.has(key)) {
            if (/^https?:\/\//i.test(raw)) s.blocks.push({ t: 'video', url: raw });
            return;
          }
          if (E_TEXT_KEYS.has(key) || /^image\d{1,2}(?:Title|Subtitle)$/.test(key)) {
            const t = eText(raw);
            if (t && !seenText.has(t)) {
              seenText.add(t);
              s.blocks.push({ t: 'text', text: t });
            }
          }
          return;
        }
        if (Array.isArray(v)) {
          for (const x of v) walk(x, key);
          return;
        }
        const o = obj(v);
        const url = str(o.url);
        if (url) {
          const u = imageUrl(url);
          if (!u) return;
          if (VIDEO_FILE.test(u) || E_VIDEO_KEYS.has(key)) s.blocks.push({ t: 'video', url: u });
          else s.blocks.push({ t: 'image', url: u, alt: cleanAlt(str(o.alt)) });
          return;
        }
        for (const [k, x] of Object.entries(o)) walk(x, k);
      };
      for (const [k, x] of Object.entries(data)) if (k !== 'title' && k !== 'anchorId') walk(x, k);
    }
    if (s.blocks.length) d.sections.push(s);
  });
}
