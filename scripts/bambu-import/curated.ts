/**
 * THE REVIEWED CURATED FILES (Bambu import spec §F): what a committed
 * `data/bambu-import/curated/<handle>.json` may hold, read by the curated merge
 * (enrich.ts `mergeCurated`) and checked by tests/bambuImportCurated.test.ts.
 *
 * The values `mergeCurated` accepts (statuses, confidences, source kinds,
 * regions) live here, so the merge and the schema check can never drift apart.
 * The checks are the §F "Quality validation per class" gates (1) and (4):
 *
 *   - schema: registry keys only, the registry's unit (a weight in g or kg),
 *     a value of the key's type, Bambu-owned source hosts per source kind,
 *     `locator` and a `quote` of at most 200 characters on every verified
 *     numeric value, every `not_published` key covered by a `searched` entry;
 *   - privacy: no money, stock or shipping-fee key or value, no secret name,
 *     no model name, no link off a Bambu-owned host;
 *   - range sanity per key, in the registry unit (weights in grams).
 *
 * Every function answers a list of problems (empty when the file passes); none
 * throws, so a test names every problem at once.
 */
import { FORBIDDEN_KEY } from '@levonis/catalog/bambuImport/payload';
import { plausibleEdge, plausibleWeight, weightToG } from '@levonis/catalog/bambuImport/logistics';
import { DOCUMENT_HOSTS } from '@levonis/catalog/bambuImport/registry/documents';
import { SPEC_KEYS, specKey } from '@levonis/catalog/bambuImport/registry/specKeys';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ what the merge accepts

/** Source rank: curated beats a store-page value of the same key, scope and region only by this (§F "Merge at run time"). */
export const CONFIDENCE_RANK: Readonly<Record<string, number>> = { official_variant: 5, official_doc: 4, official_page: 3, component_maker: 2, independent: 1, derived: 0 };
export const SPEC_STATUSES: ReadonlySet<string> = new Set(['verified', 'unverified', 'not_found', 'not_published', 'not_applicable', 'unknown']);
export const SOURCE_KINDS: ReadonlySet<string> = new Set(['store_page', 'store_messages', 'store_doc', 'tds', 'sds', 'manual', 'wiki', 'curated', 'derived']);
export const REGIONS: ReadonlySet<string> = new Set(['', 'us_110v', 'intl_220v']);

/** Covered by a `searched` entry's key: the key itself, or `group.*`. */
export const keyCovered = (pattern: string, key: string) => (pattern.endsWith('.*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key);

// ------------------------------------------------------------------ hosts

/** Bambu's own store-file shops on cdn.shopify.com, as the store pages link them. */
const BAMBU_SHOPIFY_SHOPS = ['/s/files/1/0584/7236/6216/', '/s/files/1/0645/5876/0155/', '/s/files/1/0573/5320/7868/'];
/** The document CDNs: TDS, SDS, spec sheets, hex-code sheets and manuals. */
const CDN_HOSTS = new Set(['store.bblcdn.com', 'store.bblcdn.eu', 'cdn.shopify.com']);
/** Where each source kind may come from. A `store_page` ref stays owner-only in the database (§G.1). */
const HOSTS_BY_KIND: Readonly<Record<string, ReadonlySet<string>>> = {
  wiki: new Set(['wiki.bambulab.com']),
  store_page: new Set(['us.store.bambulab.com']),
  store_messages: new Set(['us.store.bambulab.com']),
  store_doc: CDN_HOSTS,
  tds: CDN_HOSTS,
  sds: CDN_HOSTS,
  manual: new Set([...CDN_HOSTS, 'wiki.bambulab.com']),
};
/** Every source host (any kind). */
export const CURATED_SOURCE_HOSTS: ReadonlySet<string> = new Set(Object.values(HOSTS_BY_KIND).flatMap((s) => [...s]));
/** Any link anywhere in a file (notes included): Bambu-owned hosts, and the store's own video links. */
const ANY_LINK_HOSTS = new Set([...CURATED_SOURCE_HOSTS, ...DOCUMENT_HOSTS, 'public-cdn.bambulab.com', 'public-cdn.bblmw.com', 'youtu.be']);

function urlProblem(raw: unknown, allowed: ReadonlySet<string>): string | null {
  if (typeof raw !== 'string') return 'is not a string';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'https:') return 'is not https';
  if (!allowed.has(u.host)) return `host ${u.host} is not allowed here`;
  if (u.host === 'cdn.shopify.com' && !BAMBU_SHOPIFY_SHOPS.some((p) => u.pathname.startsWith(p))) return 'is not a Bambu store file';
  return null;
}

// ------------------------------------------------------------------ schema (§F gate 1)

const TOP_KEYS = new Set(['handle', 'schema', 'curated_by', 'reviewed_by', 'curated_at', 'searched', 'specs', 'hex', 'relations', 'in_the_box', 'documents', 'not_published', 'notes']);
const SPEC_ENTRY_KEYS = new Set([
  'key', 'scope', 'value', 'unit', 'status', 'confidence', 'source_kind', 'source_url', 'source_title', 'locator', 'quote',
  'test_method', 'test_condition', 'region', 'retrieved_at', 'note', 'conflict', 'conflict_note',
]);
const SEARCHED_KEYS = new Set(['kind', 'url', 'title', 'retrieved_at', 'keys', 'note', 'locator']);
const SCOPE_KEYS = new Set(['kind', 'source_value_id', 'source_variant_id', 'value_text', 'label']);
const RELATIONS = new Set(['compatible_with', 'not_compatible_with', 'requires', 'recommended_with', 'includes', 'related']);
const HANDLE = /^[\p{Ll}\p{Nd}][\p{Ll}\p{Nd}\p{M}._-]*$/u;
const HEX = /^#[0-9A-Fa-f]{6}$/;
/** A published bound kept as written («< 300 mm/s», «> 650%»): the number and what follows it. */
const BOUND = /^[<>≤≥]\s*(\d+(?:\.\d+)?)\s*(.*)$/;
/** A published W × D × H (the package's `object` text). */
const DIMS = /^(\d+(?:\.\d+)?) × (\d+(?:\.\d+)?) × (\d+(?:\.\d+)?) mm$/;
const PLAIN_YES_NO = /^(?:yes|no|true|false|supported|not supported)$/i;
const MAX_QUOTE = 200;

const isMinMax = (v: unknown): v is { min: number; max: number } =>
  isRec(v) && Object.keys(v).every((k) => k === 'min' || k === 'max') && Number.isFinite(v.min) && Number.isFinite(v.max) && (v.min as number) <= (v.max as number);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Whether the value has the shape the key's registry type takes (as `mergeCurated` turns it into a row). */
function valueShapeProblem(type: string, value: unknown, unit: string): string | null {
  switch (type) {
    case 'number':
    case 'range': {
      if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return null;
      if (isMinMax(value)) return null;
      if (typeof value === 'string') {
        const m = BOUND.exec(value);
        return m && m[2].trim() === unit ? null : `a ${type} text must be a published bound in ${unit || 'no unit'} («< 300 mm/s»)`;
      }
      return `is not a ${type}`;
    }
    case 'object':
      return typeof value === 'string' && DIMS.test(value) ? null : 'is not «W × D × H mm»';
    case 'boolean':
      if (typeof value === 'boolean') return null;
      return nonEmpty(value) && !PLAIN_YES_NO.test(value.trim()) ? null : 'is not a boolean (a plain yes/no is written as one)';
    case 'list':
      return Array.isArray(value) && value.length > 0 && value.every((x) => (typeof x === 'string' && x.trim() !== '') || (typeof x === 'number' && Number.isFinite(x))) ? null : 'is not a non-empty list';
    default:
      return nonEmpty(value) ? null : 'is not a non-empty string';
  }
}

/** Whether a value is numeric (a number, `{min, max}`, or a published bound): the values §F gate 1 wants a locator and quote on. */
const isNumericValue = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || isMinMax(v) || (typeof v === 'string' && BOUND.test(v));

const REGISTRY_GROUPS = new Set(SPEC_KEYS.map((k) => k.key.split('.')[0]));
const searchedKeyOk = (k: unknown) => typeof k === 'string' && (k.endsWith('.*') ? REGISTRY_GROUPS.has(k.slice(0, -2)) : !!specKey(k));

/** §F gate (1): the schema test. `handle` is the file name's handle, when known. */
export function curatedSchemaProblems(file: unknown, handle?: string): string[] {
  const out: string[] = [];
  const bad = (path: string, what: string) => out.push(`${path} ${what}`);
  if (!isRec(file)) return ['$ is not an object'];
  for (const k of Object.keys(file)) if (!TOP_KEYS.has(k)) bad(`$.${k}`, 'is not a curated-file key');
  if (typeof file.handle !== 'string' || !HANDLE.test(file.handle)) bad('$.handle', 'is not a handle');
  else if (handle !== undefined && file.handle !== handle) bad('$.handle', `names ${file.handle}, not its file ${handle}`);
  if (file.schema !== 2) bad('$.schema', 'is not 2');
  if (!nonEmpty(file.curated_by)) bad('$.curated_by', 'is empty');
  if (file.reviewed_by !== undefined && typeof file.reviewed_by !== 'string') bad('$.reviewed_by', 'is not a string');
  if (typeof file.curated_at !== 'string' || Number.isNaN(Date.parse(file.curated_at))) bad('$.curated_at', 'is not a date');
  for (const k of ['searched', 'specs', 'hex', 'relations', 'in_the_box', 'documents', 'not_published'] as const) if (!Array.isArray(file[k])) bad(`$.${k}`, 'is not a list');
  if (file.notes !== undefined && !(Array.isArray(file.notes) && file.notes.every((n) => typeof n === 'string'))) bad('$.notes', 'is not a list of strings');
  const list = (k: string): unknown[] => (Array.isArray(file[k]) ? (file[k] as unknown[]) : []);

  const searched = list('searched');
  searched.forEach((s, i) => {
    const p = `$.searched[${i}]`;
    if (!isRec(s)) return bad(p, 'is not an object');
    for (const k of Object.keys(s)) if (!SEARCHED_KEYS.has(k)) bad(`${p}.${k}`, 'is not a searched-entry key');
    if (typeof s.kind !== 'string' || !HOSTS_BY_KIND[s.kind]) bad(`${p}.kind`, `is not a document kind`);
    else {
      const u = urlProblem(s.url, HOSTS_BY_KIND[s.kind]);
      if (u) bad(`${p}.url`, u);
    }
    // Empty when the document was read for something else (a hex-code table, an index page).
    if (!Array.isArray(s.keys)) bad(`${p}.keys`, 'is not a list');
    else s.keys.forEach((k, j) => searchedKeyOk(k) || bad(`${p}.keys[${j}]`, `${String(k)} is not a registry key or group`));
  });

  list('specs').forEach((s, i) => {
    const p = `$.specs[${i}]`;
    if (!isRec(s)) return bad(p, 'is not an object');
    for (const k of Object.keys(s)) if (!SPEC_ENTRY_KEYS.has(k)) bad(`${p}.${k}`, 'is not a spec-entry key');
    const reg = typeof s.key === 'string' ? specKey(s.key) : undefined;
    if (!reg) return bad(`${p}.key`, `${String(s.key)} is not a registry key`);
    const at = `${p} (${reg.key})`;
    // Scope: the product, or one of its own option values or variants by source id.
    const sc = s.scope;
    if (!isRec(sc)) bad(`${at}.scope`, 'is not an object');
    else {
      for (const k of Object.keys(sc)) if (!SCOPE_KEYS.has(k)) bad(`${at}.scope.${k}`, 'is not a scope key');
      if (sc.kind === 'option_value' ? !/^\d+$/.test(String(sc.source_value_id ?? '')) : sc.kind === 'variant' ? !/^\d+$/.test(String(sc.source_variant_id ?? '')) : sc.kind !== 'product') {
        bad(`${at}.scope`, 'is not the product, an option value or a variant by source id');
      }
    }
    if (typeof s.status !== 'string' || !['verified', 'unverified'].includes(s.status)) bad(`${at}.status`, 'is not verified or unverified (a key with no value goes in not_published)');
    if (typeof s.confidence !== 'string' || !(s.confidence in CONFIDENCE_RANK)) bad(`${at}.confidence`, 'is not a confidence the merge ranks');
    if (typeof s.region !== 'string' || !REGIONS.has(s.region)) bad(`${at}.region`, 'is not a region');
    if (typeof s.source_kind !== 'string' || !HOSTS_BY_KIND[s.source_kind]) bad(`${at}.source_kind`, 'is not a document source kind');
    else {
      const u = urlProblem(s.source_url, HOSTS_BY_KIND[s.source_kind]);
      if (u) bad(`${at}.source_url`, u);
    }
    for (const k of ['source_title', 'locator', 'quote', 'test_method', 'test_condition'] as const) if (typeof s[k] !== 'string') bad(`${at}.${k}`, 'is not a string');
    if (typeof s.quote === 'string' && s.quote.length > MAX_QUOTE) bad(`${at}.quote`, `is ${s.quote.length} characters (at most ${MAX_QUOTE})`);
    // Unit: the registry's; a weight (stored in grams) may be written in g or kg, and must convert.
    if (reg.unit === 'g') {
      if (typeof s.value !== 'number' || typeof s.unit !== 'string' || !['g', 'kg'].includes(s.unit) || !weightToG(s.value, s.unit)) bad(`${at}.unit`, 'is not a plausible weight in g or kg');
    } else if (s.unit !== reg.unit) bad(`${at}.unit`, `is «${String(s.unit)}», the registry stores «${reg.unit}»`);
    const shape = valueShapeProblem(reg.type, s.value, reg.unit);
    if (shape) bad(`${at}.value`, shape);
    // §F gate 1, §B.2: every verified numeric value carries where it was read and the words read.
    if (s.status === 'verified' && isNumericValue(s.value) && (!nonEmpty(s.locator) || !nonEmpty(s.quote))) bad(at, 'is a verified numeric value without a locator and a quote');
  });

  const np = list('not_published');
  np.forEach((k, i) => {
    const p = `$.not_published[${i}]`;
    if (typeof k !== 'string' || !specKey(k)) return bad(p, `${String(k)} is not a registry key`);
    if (np.indexOf(k) !== i) bad(p, `${k} is listed twice`);
    const covered = searched.some((s) => isRec(s) && Array.isArray(s.keys) && s.keys.some((x) => typeof x === 'string' && keyCovered(x, k)));
    if (!covered) bad(p, `${k} is not covered by a searched entry`);
  });

  list('hex').forEach((h, i) => {
    const p = `$.hex[${i}]`;
    if (!isRec(h)) return bad(p, 'is not an object');
    if (!nonEmpty(h.value_text)) bad(`${p}.value_text`, 'is empty');
    const hexes = h.hex !== undefined ? [h.hex] : Array.isArray(h.hexes) ? h.hexes : [];
    if (!hexes.length || !hexes.every((x) => typeof x === 'string' && HEX.test(x))) bad(p, 'has no published #RRGGBB');
    const u = urlProblem(h.source_url, CDN_HOSTS);
    if (u) bad(`${p}.source_url`, u);
    if (!nonEmpty(h.locator)) bad(`${p}.locator`, 'is empty');
  });
  list('relations').forEach((r, i) => {
    const p = `$.relations[${i}]`;
    if (!isRec(r)) return bad(p, 'is not an object');
    if (typeof r.relation !== 'string' || !RELATIONS.has(r.relation)) bad(`${p}.relation`, 'is not a relation');
    if (!nonEmpty(r.target_label)) bad(`${p}.target_label`, 'is empty');
    const u = urlProblem(r.source_url, CURATED_SOURCE_HOSTS);
    if (u) bad(`${p}.source_url`, u);
  });
  list('in_the_box').forEach((b, i) => {
    const p = `$.in_the_box[${i}]`;
    if (!isRec(b)) return bad(p, 'is not an object');
    const u = urlProblem(b.source_url, CURATED_SOURCE_HOSTS);
    if (u) bad(`${p}.source_url`, u);
  });
  list('documents').forEach((d, i) => {
    const p = `$.documents[${i}]`;
    if (!isRec(d)) return bad(p, 'is not an object');
    if (!nonEmpty(d.kind)) bad(`${p}.kind`, 'is empty');
    const u = urlProblem(d.url, new Set([...CURATED_SOURCE_HOSTS, ...DOCUMENT_HOSTS]));
    if (u) bad(`${p}.url`, u);
  });
  return out;
}

// ------------------------------------------------------------------ privacy

/** A money amount, a stock state or a shipping fee, in any string. «Ships in the box» and a note that a policy bullet is NOT carried pass. */
const MONEY_STOCK_SHIPPING = [
  /[$€£¥]\s?\d|\b(?:USD|EUR|GBP|IQD)\s?\d|\d\s?(?:USD|EUR|GBP|IQD)\b/,
  /\b(?:in stock|out of stock|sold out|back in stock|restock(?:ed|ing)?|pre-?order)\b/i,
  /\bfree shipping\b|\bshipping (?:fees?|costs?|charges?|rates?)\b|\bdelivery (?:fees?|charges?)\b/i,
  /\b(?:price|msrp|discount|coupon|promo code)\b/i,
];
const SECRET_OR_MODEL = /IRAQ_PARALLEL_FX_API_KEY|\b(?:claude|opus|sonnet|haiku|chatgpt|gpt-?\d|gemini|anthropic|openai)\b/i;
const LINK = /https?:\/\/[^\s"'<>)\]]+/g;

/** No price, cost, stock or shipping key or value; no secret or model name; no link off a Bambu-owned host. */
export function curatedPrivacyProblems(file: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      for (const re of MONEY_STOCK_SHIPPING) if (re.test(v)) out.push(`${path} reads like money, stock or a shipping fee: ${v.slice(0, 80)}`);
      if (SECRET_OR_MODEL.test(v)) out.push(`${path} names a secret or a model`);
      for (const m of v.match(LINK) ?? []) {
        const u = urlProblem(m.replace(/[.,;:]+$/, ''), ANY_LINK_HOSTS);
        if (u) out.push(`${path} links ${m.slice(0, 80)}: ${u}`);
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (isRec(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEY.test(k) || /shipping/i.test(k)) out.push(`${path}.${k} is a forbidden key`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(file, '$');
  return out;
}

// ------------------------------------------------------------------ range sanity (§F gate 4)

const EDGE = [1, 3000] as const; // §B.7: an edge of 1–3,000 mm
const WEIGHT = [1, 200_000] as const; // §B.7: a weight of 1 g–200 kg

/**
 * The plausible range of every numeric key a curated file may carry, in the registry unit (weights in grams).
 * §F names nozzle 150–350 °C and density 0.9–2.5 g/cm³; the logistics bounds are §B.7's; the rest are the
 * physical bounds of a desktop FDM printer, its parts and its filament. A numeric key not listed here fails
 * the range test, so a new key is given its range before its first value lands.
 */
export const CURATED_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  'print_settings.nozzle_temp': [150, 350],
  'thermal.max_nozzle_temp': [150, 350],
  'material.density': [0.9, 2.5],
  'print_settings.bed_temp': [20, 130],
  'thermal.max_bed_temp': [50, 130],
  'thermal.chamber_temp': [20, 100],
  'thermal.glass_transition': [-100, 350],
  'thermal.heat_deflection_temp': [20, 350],
  'thermal.vicat_softening': [20, 350],
  'thermal.melting_temp': [100, 400],
  'part.max_temperature': [20, 400],
  'drying.temperature': [40, 150],
  'drying.time': [0.5, 48],
  'print_settings.print_speed': [10, 2000],
  'material.diameter': [1.5, 3],
  'extrusion.filament_diameter': [1.5, 3],
  'material.diameter_tolerance': [0.005, 0.1],
  'nozzle.diameter': [0.1, 1.2],
  'extrusion.nozzle_diameter': [0.1, 1.2],
  'printing.layer_height': [0.01, 1],
  'mechanical.tensile_strength': [1, 300],
  'mechanical.flexural_strength': [1, 400],
  'mechanical.flexural_modulus': [5, 25_000],
  'mechanical.impact_strength': [0.5, 200],
  'mechanical.elongation_at_break': [0.1, 1500],
  'motion.max_speed': [50, 2000],
  'motion.max_acceleration': [500, 100_000],
  'motion.max_flow': [1, 100],
  'motion.max_flow_high_flow': [1, 100],
  'electrical.max_power': [1, 3500],
  'electrical.rated_power': [1, 3500],
  'ams.slots': [1, 16],
  'contents.pieces': [1, 1000],
  'physical.thickness': [0.05, 100],
  'product.length': EDGE,
  'product.width': EDGE,
  'product.height': EDGE,
  'package.length': EDGE,
  'package.width': EDGE,
  'package.height': EDGE,
  'product.net_weight': WEIGHT,
  'package.weight': WEIGHT,
  'shipment.gross_weight': WEIGHT,
  'material.net_weight': WEIGHT,
};

/** §F gate (4): unit and range sanity per key. Only entries the schema accepts are read. */
export function curatedRangeProblems(file: unknown): string[] {
  const out: string[] = [];
  if (!isRec(file) || !Array.isArray(file.specs)) return out;
  file.specs.forEach((s, i) => {
    if (!isRec(s) || typeof s.key !== 'string') return;
    const reg = specKey(s.key);
    if (!reg) return;
    const at = `$.specs[${i}] (${reg.key})`;
    if (reg.type === 'object') {
      const m = typeof s.value === 'string' ? DIMS.exec(s.value) : null;
      if (m && ![m[1], m[2], m[3]].every((x) => plausibleEdge(Number(x)))) out.push(`${at} has an edge outside 1–3000 mm`);
      return;
    }
    const nums: number[] = [];
    if (typeof s.value === 'number' && Number.isFinite(s.value)) {
      const g = reg.unit === 'g' && typeof s.unit === 'string' ? weightToG(s.value, s.unit) : null;
      nums.push(g ? g.value : s.value);
    } else if (isMinMax(s.value)) nums.push(s.value.min, s.value.max);
    else if (typeof s.value === 'string' && BOUND.test(s.value)) nums.push(Number(BOUND.exec(s.value)![1]));
    else return;
    const range = CURATED_RANGES[reg.key];
    if (!range) return void out.push(`${at} has no declared range`);
    for (const n of nums) if (n < range[0] || n > range[1]) out.push(`${at} ${n} ${reg.unit} is outside ${range[0]}–${range[1]} ${reg.unit}`);
    if (reg.unit === 'g' && nums.some((n) => !plausibleWeight(n))) out.push(`${at} is not a plausible weight`);
  });
  return out;
}
