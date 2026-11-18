/**
 * SEARCH BY PHOTO (owner, 2026-11-18: «add search about images and scan … match
 * the image with available options and color, smart and extra and no mistake»).
 *
 * A customer takes or picks a photo; the shop answers with ITS OWN products,
 * opened on the colour or option the photo shows. Two model calls, and the
 * model never names a product on its own:
 *
 *   1. READ — the photo alone → what is in it, as data: is it a thing a shop
 *      like this sells, its kind, brand, model, base colour, the codes printed
 *      on it, and up to three English search phrases (`READ_SCHEMA`).
 *   2. CANDIDATES — the shop's own search, not the model: the identifier lane
 *      for the printed codes (an EAN or a model code is answered exactly), the
 *      token index for the phrases. At most `MAX_CANDIDATES` VISIBLE products,
 *      each with its colours and options and, where the stored small copy
 *      exists, its picture.
 *   3. PICK — the photo again, beside that closed list → which candidates are
 *      the same product, which are only similar, and which colour/option of it
 *      the photo shows (`PICK_SCHEMA`). A key that is not on the list is
 *      dropped by `validatePick`, so a product the shop does not list can
 *      never be answered, and an option key the product does not own is
 *      replaced by the deterministic colour match (`colourSelection`) or by
 *      nothing.
 *
 * NO MISTAKE MEANS SAYING WHEN IT IS NOT SURE. The answer's `verdict` is the
 * model's word checked against the list: `same` only with at least one pick at
 * high confidence; `similar` when the shop has things like it but not it;
 * `none` when nothing on the list is close or the photo is not a product. The
 * page labels each row from that, never «تطابق» for a near one.
 *
 * Pure (no D1, no fetch): the route (worker/routes/searchImage.ts) does the
 * reads and the calls. Exported for tests/searchImage.test.ts.
 */
import { BASE_COLOURS, baseColourOf, type BaseColour } from '../../../packages/catalog/src/bambuImport/registry/colours';
import { selectionNamesFrom } from './document';

// ------------------------------------------------------------- the switch

/** One `admin_settings` row, written by the owner (Creative Studio settings). No migration. */
export const IMAGE_SEARCH_SETTING_KEY = 'searchImageAi';

export interface ImageSearchSettings {
  /** On unless the owner turned it off: the owner asked for it (2026-11-18). */
  enabled: boolean;
  /** Photos per UTC day, the whole shop together (each photo is at most two model calls). */
  daily: number;
}

export const IMAGE_DAILY_DEFAULT = 300;
export const IMAGE_DAILY_MAX = 5000;
export const IMAGE_SEARCH_DEFAULT: ImageSearchSettings = Object.freeze({ enabled: true, daily: IMAGE_DAILY_DEFAULT }) as ImageSearchSettings;

/** A stored value → settings. Unreadable JSON keeps the default; only a literal `false` turns it off. */
export function imageSearchFromSetting(value: string | null | undefined): ImageSearchSettings {
  if (typeof value !== 'string' || !value.trim()) return IMAGE_SEARCH_DEFAULT;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return IMAGE_SEARCH_DEFAULT;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return IMAGE_SEARCH_DEFAULT;
  const o = raw as Record<string, unknown>;
  const daily = typeof o.daily === 'number' && Number.isInteger(o.daily) && o.daily >= 0 && o.daily <= IMAGE_DAILY_MAX ? o.daily : IMAGE_DAILY_DEFAULT;
  return { enabled: o.enabled !== false, daily };
}

// ------------------------------------------------------------- the photo

/** What the page sends: a JPEG or WebP it already scaled to 1024 px on its long edge. */
export const IMAGE_MAX_BYTES = 1_500_000;
export type PhotoMime = 'image/jpeg' | 'image/webp' | 'image/png';

/** `data:image/jpeg;base64,…` → the base64 body and its type, or null. The bytes are sniffed, not trusted. */
export function photoOf(raw: unknown): { mime: PhotoMime; data: string } | null {
  if (typeof raw !== 'string' || raw.length > Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 64) return null;
  const m = /^data:(image\/(?:jpeg|webp|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!m) return null;
  const data = m[2];
  let head: string;
  try {
    head = atob(data.slice(0, 24));
  } catch {
    return null;
  }
  const b = (i: number) => head.charCodeAt(i);
  const sniffed: PhotoMime | null =
    b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff
      ? 'image/jpeg'
      : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP'
        ? 'image/webp'
        : b(0) === 0x89 && head.slice(1, 4) === 'PNG'
          ? 'image/png'
          : null;
  if (!sniffed || sniffed !== m[1]) return null;
  return { mime: sniffed, data };
}

// ------------------------------------------------------------- step 1: read

export const COLOUR_ENUM = [...(Object.keys(BASE_COLOURS) as BaseColour[]), 'none'] as const;

export const READ_SYSTEM = [
  'You look at ONE photo a customer of a 3D-printing and maker shop in Iraq took or uploaded, to find the product in the shop.',
  'The shop sells 3D printers (Bambu Lab, Creality, Elegoo, Anycubic, Prusa…), filament spools and refills, resin, nozzles, hotends, build plates, AMS units, spare parts, tools, adhesives, electronics and maker supplies.',
  'Describe only what you can SEE. Never guess a brand or model you cannot read or clearly recognise: leave it empty.',
  'codes: every printed code that could identify the product — model numbers, part numbers, SKUs, colour codes, the digits under a barcode. Copy them exactly. Empty when none is legible.',
  'colour: the main colour of the product itself (not the background, not the packaging unless the product is the packaging). "none" when it has no clear colour.',
  'queries: 1 to 3 short English search phrases a shop search would match, most specific first (e.g. "Bambu Lab A1 mini", "PLA Matte filament black", "hardened steel nozzle 0.4").',
  'is_product is false for a photo of a person, a place, a screenshot of text, or anything that is not a physical item.',
].join('\n');

export const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_product', 'kind', 'brand', 'model', 'colour', 'codes', 'queries'],
  properties: {
    is_product: { type: 'boolean' },
    kind: { type: 'string' },
    brand: { type: 'string' },
    model: { type: 'string' },
    colour: { type: 'string', enum: COLOUR_ENUM },
    codes: { type: 'array', items: { type: 'string' } },
    queries: { type: 'array', items: { type: 'string' } },
  },
} as const;

export interface PhotoRead {
  is_product: boolean;
  kind: string;
  brand: string;
  model: string;
  colour: BaseColour | null;
  codes: string[];
  queries: string[];
}

const clean = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? [...v]
        .map((ch) => (ch.charCodeAt(0) < 32 || ch === '<' || ch === '>' ? ' ' : ch))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

/** The model's read → a bounded one, or null when it is not the shape asked for. */
export function validateRead(raw: unknown): PhotoRead | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.is_product !== 'boolean') return null;
  const list = (v: unknown, n: number, max: number) =>
    Array.isArray(v) ? [...new Set(v.map((x) => clean(x, max)).filter(Boolean))].slice(0, n) : [];
  const colour = typeof o.colour === 'string' && o.colour in BASE_COLOURS ? (o.colour as BaseColour) : null;
  return {
    is_product: o.is_product,
    kind: clean(o.kind, 60),
    brand: clean(o.brand, 40),
    model: clean(o.model, 60),
    colour,
    codes: list(o.codes, 6, 40).filter((c) => /[0-9A-Za-z]{3,}/.test(c)),
    queries: list(o.queries, 3, 80),
  };
}

/** The texts the shop's own search is asked, most specific first, without repeats. */
export function searchTexts(read: PhotoRead): string[] {
  const named = [read.brand, read.model].filter(Boolean).join(' ');
  const out = [...read.queries];
  if (named && !out.some((q) => q.toLowerCase().includes(named.toLowerCase()))) out.unshift(named);
  if (!out.length && read.kind) out.push(read.kind);
  return [...new Set(out.map((q) => q.trim()).filter(Boolean))].slice(0, 4);
}

// ------------------------------------------------------------- step 2: candidates

/** Products put before the model in step 3. Enough for «A1» vs «A1 mini» vs «A1 Combo», few enough to stay cheap. */
export const MAX_CANDIDATES = 12;
/** Of those, how many carry their picture (a 320 px copy is ~90 image tokens). */
export const MAX_CANDIDATE_PICTURES = 8;
/** Colours and options listed per candidate. */
const MAX_CHOICES = 24;

export interface Candidate {
  key: string;
  product_id: string;
  name: string;
  brand: string;
  /** `o<n>`/`c<n>` keys → what the step-3 model may answer, and the selection each one is. */
  choices: Array<{ key: string; name: string; selection: { option_value_ids: string[]; color_id: string | null } }>;
}

/** A visible product row → its candidate entry, with every colour and option it owns, keyed small. */
export function candidateOf(index: number, row: Record<string, unknown>): Candidate {
  const choices: Candidate['choices'] = [];
  for (const o of selectionNamesFrom(row.options)) {
    if (choices.length >= MAX_CHOICES) break;
    const name = o.names[0];
    if (name) choices.push({ key: `o${choices.length + 1}`, name, selection: { option_value_ids: [o.id], color_id: null } });
  }
  for (const c of selectionNamesFrom(row.colors)) {
    if (choices.length >= MAX_CHOICES) break;
    const name = c.names[0];
    if (name) choices.push({ key: `c${choices.length + 1}`, name, selection: { option_value_ids: [], color_id: c.id } });
  }
  return {
    key: `p${index + 1}`,
    product_id: String(row.id),
    name: clean(row.name, 160),
    brand: clean(row.brand, 40),
    choices,
  };
}

/** The list as the step-3 model reads it: one line per product, then its choices. */
export function candidateText(list: readonly Candidate[], pictured: ReadonlySet<string>): string {
  return list
    .map((c) => {
      const head = `${c.key}: ${c.name}${c.brand ? ` (brand: ${c.brand})` : ''}${pictured.has(c.key) ? ' [picture attached]' : ''}`;
      const choices = c.choices.length ? `\n   options: ${c.choices.map((x) => `${x.key}=${x.name}`).join('; ')}` : '';
      return head + choices;
    })
    .join('\n');
}

// ------------------------------------------------------------- step 3: pick

export const PICK_SYSTEM = [
  'You match a customer photo to products a shop actually sells. You get the photo, then a numbered list of the shop products closest to it (some with their own picture, in the same order, labelled with their key).',
  'Answer ONLY with keys from that list. Never invent a product.',
  'verdict "same": at least one listed product is exactly the product in the photo (same model and variant family). "similar": the shop sells things like it but not this exact product. "none": nothing listed is close, or the photo shows no product.',
  'picks: up to 3 keys, best first. confidence "high" only when model AND appearance clearly agree (for example A1 vs A1 mini, Combo vs not, 0.4 vs 0.6 mm must match); "medium" when likely; "low" when only similar.',
  'option: the key of the colour or option of that product the photo shows (for example the filament colour), or "" when none of its options is visible or none fits.',
  'Be strict. A wrong "high" is worse than an honest "medium".',
].join('\n');

export const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'picks'],
  properties: {
    verdict: { type: 'string', enum: ['same', 'similar', 'none'] },
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'confidence', 'option'],
        properties: {
          key: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          option: { type: 'string' },
        },
      },
    },
  },
} as const;

export type Confidence = 'high' | 'medium' | 'low';
export type Verdict = 'same' | 'similar' | 'none';

export interface Pick {
  product_id: string;
  confidence: Confidence;
  selection: { option_value_ids: string[]; color_id: string | null; variant_id: string | null } | null;
  /** How the selection was chosen: by the model from the product's own list, or by the colour words. */
  via: 'model' | 'colour' | null;
}

/**
 * THE DETERMINISTIC COLOUR MATCH: the one choice of this product whose name's
 * base colour is the photo's base colour. Two choices of that colour (Matte
 * Black and Basic Black) is no answer: the page then opens on no colour rather
 * than on one of two.
 */
export function colourSelection(c: Candidate, colour: BaseColour | null): Candidate['choices'][number] | null {
  if (!colour) return null;
  const hits = c.choices.filter((x) => baseColourOf(x.name) === colour);
  return hits.length === 1 ? hits[0] : null;
}

/** The model's pick → only keys on the list, only options the product owns; the verdict checked against them. */
export function validatePick(
  raw: unknown,
  list: readonly Candidate[],
  colour: BaseColour | null
): { verdict: Verdict; picks: Pick[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const verdict = o.verdict === 'same' || o.verdict === 'similar' || o.verdict === 'none' ? o.verdict : null;
  if (!verdict || !Array.isArray(o.picks)) return null;
  const byKey = new Map(list.map((c) => [c.key, c]));
  const seen = new Set<string>();
  const picks: Pick[] = [];
  for (const p of o.picks.slice(0, 3)) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    const c = typeof r.key === 'string' ? byKey.get(r.key) : undefined;
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    const conf: Confidence = r.confidence === 'high' || r.confidence === 'medium' ? r.confidence : 'low';
    const own = typeof r.option === 'string' && r.option ? c.choices.find((x) => x.key === r.option) : undefined;
    const choice = own ?? colourSelection(c, colour);
    picks.push({
      product_id: c.product_id,
      // «similar» is never a high pick, whatever the row says.
      confidence: verdict === 'same' ? conf : conf === 'high' ? 'medium' : conf,
      selection: choice ? { ...choice.selection, variant_id: null } : null,
      via: own ? 'model' : choice ? 'colour' : null,
    });
  }
  if (verdict === 'none') return { verdict, picks: [] };
  if (!picks.length) return { verdict: 'none', picks: [] };
  return { verdict: verdict === 'same' && !picks.some((p) => p.confidence === 'high') ? 'similar' : verdict, picks };
}

/** The card media URL → its R2 key, only for the catalogue's own public pictures. */
export function pictureKeyOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('/files/')) return null;
  const key = url.slice('/files/'.length).split('?')[0];
  return /^products\/[A-Za-z0-9/_.-]+\.(webp|jpe?g|png)$/.test(key) && !key.includes('..') ? key : null;
}
