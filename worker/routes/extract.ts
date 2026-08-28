import { Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { requireAdmin, badRequest, str, HttpError } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { validateExtractUrl } from './misc';
import { sniff } from './uploads';

/**
 * Extraction v2 + media ingestion (mandate §7) — /api/admin/extract-v2.
 *
 * Reads a remote product page with the SAME SSRF discipline as the legacy
 * /api/extract (shared validateExtractUrl, manual redirects re-validated per
 * hop, 10s timeout, 1MB HTML cap, text/html only), parses JSON-LD AND
 * og:/meta tags AND <title>, and returns PER-FIELD results with source and
 * conflict tracking. Nothing is fabricated: a field the page does not state
 * comes back status 'missing'.
 *
 * STRICT MONETARY EXCLUSION: the JSON-LD walk never descends into offers/
 * price/priceSpecification (or any price-like key), so no price from a
 * foreign site can reach any output. Currency-looking text inside extracted
 * name/description is NOT auto-stripped — it is flagged as a
 * 'possible_price_text' warning for admin review.
 *
 * Media ingestion is synchronous and bounded: up to 6 images, each SSRF-
 * checked, ≤ 4MB, magic-byte sniffed (images only, via the shared sniff()),
 * content-addressed at products/import/<sha256>.<ext> (HEAD-first dedup).
 * Per-image failures become warnings and never abort the extraction.
 * Ingestion writes ONLY under products/import/ — never a private prefix.
 */

export const extractRoutes = new Hono<AppContext>();

type Source = 'json-ld' | 'og' | 'meta' | 'title';

interface Candidate {
  value: string | string[];
  source: Source;
}

interface FieldResult {
  field: string;
  value: string | string[] | SpecEntry[] | null;
  source: Source | null;
  status: 'extracted' | 'missing' | 'conflicting';
  candidates?: Candidate[];
}

interface SpecEntry {
  name: string;
  value: string;
  unit: string;
}

interface ExtractWarning {
  kind: 'possible_price_text' | 'media_fetch_failed';
  field?: string;
  snippet?: string;
  source_url?: string;
  reason?: string;
}

interface MediaResult {
  source_url: string;
  key?: string;
  url?: string;
  status: 'stored' | 'failed';
  reason?: string;
}

const FIELD_NAMES = [
  'name', 'description', 'brand', 'sku', 'gtin', 'model', 'material', 'colors', 'images', 'specs',
] as const;

const USER_AGENT = 'Mozilla/5.0 (compatible; LevonisBot/1.0)';
const HTML_CAP = 1_000_000; // 1MB, same as legacy /api/extract
const IMAGE_CAP = 4 * 1024 * 1024; // 4MB per ingested image
const MAX_IMAGES = 6;

/** Keys whose subtree must never be read: offers, price, priceCurrency,
 *  priceSpecification, lowPrice/highPrice, cost… — any price-like key. */
const PRICE_KEY_RE = /price|offer|cost|currency/i;

/** Currency patterns flagged (not stripped) in extracted name/description:
 *  dollar/euro/pound signs, IQD/USD codes, د.ع / دينار / دولار, and digits
 *  followed by currency words. Plain numeric specs do not match. */
const CURRENCY_RE =
  /[$€£]|\b(?:IQD|USD|EUR|GBP)\b|د\.?\s?ع|دينار|دولار|يورو|\d[\d,.]*\s*(?:dollars?|euros?|pounds?|dinars?)\b/i;

extractRoutes.post('/', requireAdmin, async (c) => {
  await rateLimit(c, 'extract_v2', 30, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  let url = validateExtractUrl(str(body.url, 'url', { min: 8, max: 2000 }));
  const requestedUrl = url.toString();

  // --- Fetch the page (same discipline as legacy: manual redirects, max 3
  // hops each re-validated, 10s timeout).
  let res: Response | null = null;
  try {
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('Location');
        if (!loc) break;
        url = validateExtractUrl(new URL(loc, url).toString());
        continue;
      }
      break;
    }
  } catch (e) {
    // Re-throw SSRF/validation errors; network/timeout becomes a plain 400.
    if (e instanceof HttpError) throw e;
    throw badRequest('Failed to fetch the URL');
  }
  if (!res) throw badRequest('Failed to fetch the URL');

  if (!res.ok) {
    // The site refused us (bot protection, auth wall, error page). Honest
    // unsupported result — never fabricated values.
    await audit(c.env.DB, user.id, 'product.extract_v2', requestedUrl, { unsupported: true, http_status: res.status });
    return c.json(unsupportedResponse(requestedUrl, `The site responded with HTTP ${res.status}.`));
  }
  const ctype = res.headers.get('Content-Type') || '';
  if (!ctype.includes('text/html')) throw badRequest('The URL did not return an HTML page');

  const html = new TextDecoder('utf-8').decode(await readCapped(res, HTML_CAP));

  // --- Parse both structured sources.
  const ld = parseJsonLd(html, url);
  const og = parseOgMeta(html, url);

  // --- Per-field results with source + conflict tracking.
  const fields: FieldResult[] = [];
  const warnings: ExtractWarning[] = [];

  // name: JSON-LD vs og:title compete; <title> is a fallback only (it usually
  // carries a " | site name" suffix — treating it as a competing claim would
  // flag a false conflict on nearly every page).
  const nameCandidates: Candidate[] = [];
  if (ld.name) nameCandidates.push({ value: ld.name, source: 'json-ld' });
  if (og.title) nameCandidates.push({ value: og.title, source: 'og' });
  if (nameCandidates.length === 0 && og.titleTag) nameCandidates.push({ value: og.titleTag, source: 'title' });
  fields.push(scalarField('name', nameCandidates));

  const descCandidates: Candidate[] = [];
  if (ld.description) descCandidates.push({ value: ld.description, source: 'json-ld' });
  if (og.description) descCandidates.push({ value: og.description, source: 'og' });
  if (og.metaDescription) descCandidates.push({ value: og.metaDescription, source: 'meta' });
  fields.push(scalarField('description', descCandidates));

  const brandCandidates: Candidate[] = [];
  if (ld.brand) brandCandidates.push({ value: ld.brand, source: 'json-ld' });
  if (og.brand) brandCandidates.push({ value: og.brand, source: 'og' });
  fields.push(scalarField('brand', brandCandidates));

  fields.push(scalarField('sku', ld.sku ? [{ value: ld.sku, source: 'json-ld' }] : []));
  fields.push(scalarField('gtin', ld.gtin ? [{ value: ld.gtin, source: 'json-ld' }] : []));
  fields.push(scalarField('model', ld.model ? [{ value: ld.model, source: 'json-ld' }] : []));
  fields.push(scalarField('material', ld.material ? [{ value: ld.material, source: 'json-ld' }] : []));

  // colors: JSON-LD union vs og product:color. Overlapping/subset sets merge;
  // genuinely different sets are a conflict.
  fields.push(listField('colors', ld.colors, og.colors));

  // images: og:image + JSON-LD image are complementary claims about the same
  // gallery (media ingestion below unions them by mandate), so the field is a
  // union, never a conflict.
  const imageUrls = dedupeStrings([...og.images, ...ld.images]).slice(0, 12);
  fields.push(
    imageUrls.length === 0
      ? { field: 'images', value: null, source: null, status: 'missing' }
      : {
          field: 'images',
          value: imageUrls,
          source: ld.images.length > 0 ? 'json-ld' : 'og',
          status: 'extracted',
        }
  );

  fields.push(
    ld.specs.length === 0
      ? { field: 'specs', value: null, source: null, status: 'missing' }
      : { field: 'specs', value: ld.specs, source: 'json-ld', status: 'extracted' }
  );

  // --- Monetary text scan (flag, never auto-strip).
  for (const f of fields) {
    if (f.field !== 'name' && f.field !== 'description') continue;
    const texts = new Set<string>();
    if (typeof f.value === 'string') texts.add(f.value);
    for (const cand of f.candidates ?? []) if (typeof cand.value === 'string') texts.add(cand.value);
    const seen = new Set<string>();
    for (const t of texts) {
      const m = CURRENCY_RE.exec(t);
      if (!m) continue;
      const at = m.index;
      const snippet = t.slice(Math.max(0, at - 40), Math.min(t.length, at + m[0].length + 40)).trim();
      if (seen.has(snippet)) continue;
      seen.add(snippet);
      warnings.push({ kind: 'possible_price_text', field: f.field, snippet });
      if (seen.size >= 2) break;
    }
  }

  // --- Proposals: factual names only, hex never guessed, never prices.
  const proposed_colors = ld.colorProposals.map((name) => ({ name, hex: '' }));
  const proposed_options = ld.optionProposals.map((name) => ({ name }));

  const unsupported = fields.every((f) => f.status === 'missing');
  if (unsupported) {
    // JS-rendered or intentionally opaque page: honest empty result.
    await audit(c.env.DB, user.id, 'product.extract_v2', requestedUrl, { unsupported: true });
    return c.json(
      unsupportedResponse(
        requestedUrl,
        'The page exposes no readable product data in its HTML (it is likely rendered by JavaScript or blocks bots).'
      )
    );
  }

  // --- Media ingestion (synchronous, bounded, never aborts the extraction).
  const media: MediaResult[] = [];
  for (const raw of dedupeStrings([...og.images, ...ld.images]).slice(0, MAX_IMAGES)) {
    const result = await ingestImage(c.env, url, raw);
    media.push(result);
    if (result.status === 'failed') {
      warnings.push({ kind: 'media_fetch_failed', source_url: result.source_url, reason: result.reason });
    }
  }

  await audit(c.env.DB, user.id, 'product.extract_v2', requestedUrl, {
    unsupported: false,
    fields_extracted: fields.filter((f) => f.status !== 'missing').map((f) => f.field),
    media_stored: media.filter((m) => m.status === 'stored').length,
    media_failed: media.filter((m) => m.status === 'failed').length,
  });

  return c.json({
    success: true,
    source_url: requestedUrl,
    fields,
    proposed_options,
    proposed_colors,
    media,
    warnings,
    unsupported: false,
  });
});

// --------------------------------------------------------------- response helpers

function unsupportedResponse(sourceUrl: string, why: string) {
  return {
    success: true,
    source_url: sourceUrl,
    fields: FIELD_NAMES.map(
      (field): FieldResult => ({ field, value: null, source: null, status: 'missing' })
    ),
    proposed_options: [] as Array<{ name: string }>,
    proposed_colors: [] as Array<{ name: string; hex: string }>,
    media: [] as MediaResult[],
    warnings: [] as ExtractWarning[],
    unsupported: true,
    message:
      `Automatic extraction could not read this page: ${why} ` +
      'Nothing was invented. Please use the TXT template workflow (Admin → Products → Template): ' +
      'download the template, fill it in, and upload it to create the product.',
  };
}

/** Scalar field: candidates ranked json-ld > og > meta > title; agreeing
 *  sources collapse to 'extracted', disagreeing ones become 'conflicting'
 *  with every candidate preserved for admin review. */
function scalarField(field: string, candidates: Candidate[]): FieldResult {
  const rank: Record<Source, number> = { 'json-ld': 0, og: 1, meta: 2, title: 3 };
  const present = candidates
    .filter((c) => typeof c.value === 'string' && c.value.trim() !== '')
    .sort((a, b) => rank[a.source] - rank[b.source]);
  if (present.length === 0) return { field, value: null, source: null, status: 'missing' };
  const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();
  const distinct = new Set(present.map((c) => norm(c.value as string)));
  const top = present[0];
  if (distinct.size === 1) {
    return { field, value: (top.value as string).trim(), source: top.source, status: 'extracted' };
  }
  return {
    field,
    value: (top.value as string).trim(),
    source: top.source,
    status: 'conflicting',
    candidates: present.map((c) => ({ value: (c.value as string).trim(), source: c.source })),
  };
}

/** List field (colors): subset/overlap merges to a union; genuinely different
 *  sets from two sources are a conflict with both candidate lists kept. */
function listField(field: string, ldValues: string[], ogValues: string[]): FieldResult {
  const a = dedupeStrings(ldValues);
  const b = dedupeStrings(ogValues);
  if (a.length === 0 && b.length === 0) return { field, value: null, source: null, status: 'missing' };
  if (a.length === 0) return { field, value: b, source: 'og', status: 'extracted' };
  if (b.length === 0) return { field, value: a, source: 'json-ld', status: 'extracted' };
  const setA = new Set(a.map((v) => v.toLowerCase()));
  const setB = new Set(b.map((v) => v.toLowerCase()));
  const subset = (x: Set<string>, y: Set<string>) => [...x].every((v) => y.has(v));
  if (subset(setA, setB) || subset(setB, setA)) {
    return { field, value: dedupeStrings([...a, ...b]), source: 'json-ld', status: 'extracted' };
  }
  return {
    field,
    value: a,
    source: 'json-ld',
    status: 'conflicting',
    candidates: [
      { value: a, source: 'json-ld' },
      { value: b, source: 'og' },
    ],
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// --------------------------------------------------------------- og:/meta/title parsing

interface OgResult {
  title: string;
  titleTag: string;
  description: string;
  metaDescription: string;
  brand: string;
  colors: string[];
  images: string[];
}

function parseOgMeta(html: string, pageUrl: URL): OgResult {
  const one = (prop: string) => metaContents(html, prop)[0] ?? '';
  const images: string[] = [];
  for (const raw of metaContents(html, 'og:image')) {
    const abs = absolutize(raw, pageUrl);
    if (abs) images.push(abs);
  }
  return {
    title: decodeEntities(one('og:title')).trim().slice(0, 300),
    titleTag: decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim().slice(0, 300),
    description: decodeEntities(one('og:description')).trim().slice(0, 5000),
    metaDescription: decodeEntities(one('description')).trim().slice(0, 5000),
    brand: decodeEntities(one('product:brand')).trim().slice(0, 200),
    colors: splitColorList(decodeEntities(one('product:color'))),
    images,
  };
}

/** All content="…" values for meta tags whose property/name matches. The
 *  monetary exclusion holds structurally: only the specific non-price
 *  properties above are ever queried. */
function metaContents(html: string, prop: string): string[] {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*>`, 'gi');
  const out: string[] = [];
  for (const tag of html.match(re) ?? []) {
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) out.push(content);
  }
  return out;
}

function absolutize(raw: string, base: URL): string {
  const v = decodeEntities(raw).trim();
  if (!v) return '';
  try {
    const u = new URL(v, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// --------------------------------------------------------------- JSON-LD parsing

interface LdResult {
  name: string;
  description: string;
  brand: string;
  sku: string;
  gtin: string;
  model: string;
  material: string;
  colors: string[];
  images: string[];
  specs: SpecEntry[];
  colorProposals: string[];
  optionProposals: string[];
}

function parseJsonLd(html: string, pageUrl: URL): LdResult {
  const nodes: Array<Record<string, unknown>> = [];
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let blocks = 0;
  while ((m = scriptRe.exec(html)) !== null && blocks < 20) {
    blocks++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue; // malformed JSON-LD: skip the block, never guess
    }
    collectProductNodes(parsed, nodes, 0, { budget: 500 });
  }

  const productNodes = nodes.filter((n) => hasType(n, 'product') || hasType(n, 'productgroup'));
  const modelNodes = nodes.filter((n) => hasType(n, 'productmodel'));
  const primary = productNodes[0] ?? modelNodes[0];
  // Some pages mark up only ProductModel nodes — fall back to them for facts.
  const searchNodes = productNodes.length > 0 ? productNodes : modelNodes;

  const firstStr = (key: string, extraKeys: string[] = []): string => {
    for (const node of searchNodes) {
      for (const k of [key, ...extraKeys]) {
        const v = asText(node[k]);
        if (v) return v;
      }
    }
    return '';
  };

  const colors: string[] = [];
  const images: string[] = [];
  for (const node of nodes) {
    colors.push(...colorsOf(node.color));
    for (const raw of imageUrlsOf(node.image)) {
      const abs = absolutize(raw, pageUrl);
      if (abs) images.push(abs);
    }
  }

  // specs: additionalProperty of the first node that states any.
  let specs: SpecEntry[] = [];
  for (const node of [primary, ...productNodes, ...modelNodes]) {
    if (!node) continue;
    const parsedSpecs = parseAdditionalProperty(node.additionalProperty);
    if (parsedSpecs.length > 0) {
      specs = parsedSpecs;
      break;
    }
  }

  // Option proposals: names of ProductModel/variant nodes that differ from the
  // primary name, plus variesBy axis names. Factual names only, never prices.
  const primaryName = primary ? asText(primary.name) : '';
  const optionProposals: string[] = [];
  for (const node of nodes) {
    if (node === primary) continue;
    if (hasType(node, 'productmodel') || hasType(node, 'product')) {
      const n = asText(node.name);
      if (n && n.toLowerCase() !== primaryName.toLowerCase()) optionProposals.push(n);
    }
  }
  for (const node of nodes) {
    const vb = node.variesBy;
    const list = Array.isArray(vb) ? vb : vb !== undefined && vb !== null ? [vb] : [];
    for (const v of list) {
      const t = asText(v);
      if (!t) continue;
      const axis = t.replace(/^https?:\/\/schema\.org\//i, '').trim();
      if (axis) optionProposals.push(axis);
    }
  }

  return {
    name: primary ? asText(primary.name).slice(0, 300) : '',
    description: firstStr('description').slice(0, 5000),
    brand: brandName(searchNodes).slice(0, 200),
    sku: firstStr('sku').slice(0, 120),
    gtin: firstStr('gtin', ['gtin13', 'gtin12', 'gtin14', 'gtin8']).slice(0, 60),
    model: modelText(searchNodes).slice(0, 200),
    material: firstStr('material').slice(0, 300),
    colors: dedupeStrings(colors).slice(0, 30),
    images: dedupeStrings(images).slice(0, 12),
    specs,
    colorProposals: dedupeStrings(colors).slice(0, 30),
    optionProposals: dedupeStrings(optionProposals).slice(0, 30),
  };
}

/** Bounded walk over parsed JSON-LD. Arrays, @graph and nested nodes are all
 *  reached because every non-price key is descended into; keys matching
 *  PRICE_KEY_RE (offers, price, priceSpecification, …) are NEVER entered, so
 *  monetary data cannot reach any output. */
function collectProductNodes(
  value: unknown,
  out: Array<Record<string, unknown>>,
  depth: number,
  state: { budget: number }
): void {
  if (depth > 8 || state.budget <= 0) return;
  if (Array.isArray(value)) {
    for (const v of value) collectProductNodes(v, out, depth + 1, state);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  state.budget--;
  const o = value as Record<string, unknown>;
  if (hasType(o, 'product') || hasType(o, 'productmodel') || hasType(o, 'productgroup')) {
    if (!out.includes(o)) out.push(o);
  }
  for (const [k, v] of Object.entries(o)) {
    if (PRICE_KEY_RE.test(k)) continue; // strict monetary exclusion
    collectProductNodes(v, out, depth + 1, state);
  }
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : [t];
  return list.some(
    (x) => typeof x === 'string' && x.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase() === type
  );
}

/** Text of a JSON-LD value: string or number verbatim; {name} objects yield
 *  the name. Anything else is not text — never invented. */
function asText(v: unknown): string {
  if (typeof v === 'string') return decodeEntities(v).trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = asText(item);
      if (t) return t;
    }
    return '';
  }
  if (v && typeof v === 'object') {
    const name = (v as Record<string, unknown>).name;
    if (typeof name === 'string') return decodeEntities(name).trim();
  }
  return '';
}

function brandName(nodes: Array<Record<string, unknown>>): string {
  for (const node of nodes) {
    const b = node.brand;
    const t = asText(b);
    if (t) return t;
  }
  return '';
}

/** The model FIELD takes only literal string values; ProductModel objects are
 *  variant descriptions and feed the option proposals instead (never guessed
 *  into the model field). */
function modelText(nodes: Array<Record<string, unknown>>): string {
  for (const node of nodes) {
    if (typeof node.model === 'string' && node.model.trim()) return decodeEntities(node.model).trim();
  }
  return '';
}

/** Raw image URL strings from a JSON-LD image value (string, array, or
 *  ImageObject). Relative URLs are resolved by the caller; data:/javascript:
 *  and other non-http schemes are rejected there too. */
function imageUrlsOf(v: unknown): string[] {
  if (typeof v === 'string') {
    const t = v.trim();
    return t && !/^(data|blob|javascript):/i.test(t) ? [t] : [];
  }
  if (Array.isArray(v)) return v.flatMap(imageUrlsOf);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const u = o.url ?? o.contentUrl;
    if (typeof u === 'string') return imageUrlsOf(u);
  }
  return [];
}

function splitColorList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,/|]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= 60);
}

/** JSON-LD `color` may be a string ("Black, Gold") or an array of strings. */
function colorsOf(v: unknown): string[] {
  if (typeof v === 'string') return splitColorList(decodeEntities(v));
  if (Array.isArray(v)) return v.flatMap(colorsOf);
  return [];
}

/** additionalProperty → factual spec rows. Price-like names are excluded by
 *  the monetary rule; legitimate numeric specs (voltage, mm, kg, model
 *  numbers) pass through untouched. */
function parseAdditionalProperty(v: unknown): SpecEntry[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const out: SpecEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = asText(o.name ?? o.propertyID).slice(0, 200);
    if (!name || PRICE_KEY_RE.test(name)) continue;
    const value =
      typeof o.value === 'boolean' ? String(o.value) : asText(o.value ?? o.description).slice(0, 500);
    if (!value) continue;
    const unit = asText(o.unitText ?? o.unitCode).slice(0, 40);
    out.push({ name, value, unit });
    if (out.length >= 60) break;
  }
  return out;
}

// --------------------------------------------------------------- media ingestion

/** Fetch one remote image with the same SSRF discipline as the page fetch,
 *  sniff it (images only), and store it content-addressed under
 *  products/import/ (public product-media prefix; never private). A HEAD
 *  probe first makes re-imports of the same bytes a natural no-op. */
async function ingestImage(env: Env, pageUrl: URL, rawUrl: string): Promise<MediaResult> {
  let sourceUrl = rawUrl;
  try {
    let target = validateExtractUrl(new URL(rawUrl, pageUrl).toString());
    sourceUrl = target.toString();

    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(target.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('Location');
        if (!loc) break;
        target = validateExtractUrl(new URL(loc, target).toString());
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      return { source_url: sourceUrl, status: 'failed', reason: `HTTP ${res ? res.status : 'error'}` };
    }

    const buf = await readCapped(res, IMAGE_CAP + 1);
    if (buf.length > IMAGE_CAP) {
      return { source_url: sourceUrl, status: 'failed', reason: 'Image exceeds the 4 MB limit' };
    }
    const kind = sniff(buf);
    if (!kind || !kind.mime.startsWith('image/')) {
      return { source_url: sourceUrl, status: 'failed', reason: 'Not a supported image (JPEG/PNG/WebP/GIF)' };
    }

    const digest = await crypto.subtle.digest('SHA-256', buf as unknown as BufferSource);
    const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const key = `products/import/${sha}.${kind.ext}`;

    const existing = await env.BUCKET.head(key);
    if (!existing) {
      await env.BUCKET.put(key, buf, {
        httpMetadata: { contentType: kind.mime, cacheControl: 'public, max-age=31536000, immutable' },
      });
    }
    return { source_url: sourceUrl, key, url: `/files/${key}`, status: 'stored' };
  } catch (e) {
    const reason =
      e instanceof DOMException && e.name === 'TimeoutError'
        ? 'Timed out'
        : e && typeof e === 'object' && 'message' in e && typeof (e as Error).message === 'string'
          ? (e as Error).message.slice(0, 200)
          : 'Fetch failed';
    return { source_url: sourceUrl, status: 'failed', reason };
  }
}

/** Read a response body up to `cap` bytes, then stop (the page fetch parses a
 *  truncated 1MB head; image reads treat exceeding the cap as failure). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.length;
  }
  return out;
}
