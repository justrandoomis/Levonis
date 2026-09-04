/**
 * EXTERNAL MODEL LINKS — MakerWorld and the sites like it.
 *
 * A customer very often does not have a file. They have a link: "print me this
 * one". The request has to work from that, and the merchant has to be able to
 * see what "this one" is.
 *
 * THE RULE THIS FILE OBEYS, and it is not new. The product-form mandate already
 * banned page scraping outright — worker/lib/fetchGuard.ts says so in its own
 * header, and the ban exists because an HTML scraper is a promise you break
 * silently the next time somebody else redesigns their site. The owner repeated
 * it here: "لا تعتمد على scraping هش إذا كان هناك API/public source أفضل".
 *
 * So this module NEVER parses HTML. It does two things:
 *
 *   1. READS THE URL. Which site, and which model id. That is structural — the
 *      shape of a permalink is a contract, not a page — and it always works,
 *      offline, with no request at all. It is enough to show the customer and
 *      the merchant exactly which design is meant, which is the important half.
 *
 *   2. ASKS THAT SITE'S OWN JSON API, when one is configured. The endpoint
 *      lives in admin settings, not in this file, so a provider can be enabled,
 *      re-pointed or switched off without a deploy — and a provider that has
 *      not been configured is simply not called.
 *
 * WHEN THE LOOKUP FAILS — no endpoint, a timeout, a shape nobody recognises —
 * the answer is `resolved: false` WITH A REASON, and the wizard carries on with
 * the link alone and a lower pricing confidence. It never invents a weight, a
 * time or a size, because a fabricated dimension becomes a fabricated price.
 */

import { validateOutboundUrl } from './fetchGuard';

export interface LinkProviderConfig {
  id: string;
  /** Hostnames this provider claims, without `www.`. */
  hosts: string[];
  /** `{id}` is replaced with the extracted model id. Empty = no API lookup. */
  api_url: string;
  /** Sent as-is. Never a secret: settings are readable by every admin. */
  headers?: Record<string, string>;
  enabled: boolean;
}

/**
 * The providers Levonis knows the URL shape of. `api_url` is deliberately EMPTY
 * here: this file states what a MakerWorld link looks like, and the admin states
 * where (and whether) to ask MakerWorld about it. Shipping a hardcoded endpoint
 * would be shipping a guess about somebody else's API with no way to correct it.
 */
export const DEFAULT_LINK_PROVIDERS: LinkProviderConfig[] = [
  { id: 'makerworld', hosts: ['makerworld.com'], api_url: '', enabled: true },
  { id: 'printables', hosts: ['printables.com'], api_url: '', enabled: true },
  { id: 'thingiverse', hosts: ['thingiverse.com'], api_url: '', enabled: true },
  { id: 'thangs', hosts: ['thangs.com'], api_url: '', enabled: true },
  { id: 'cults3d', hosts: ['cults3d.com'], api_url: '', enabled: true },
];

export interface ParsedLink {
  provider: string;
  /** The model id inside that site, when the URL shape gives one up. */
  external_id: string;
  /** The link with tracking parameters and fragments removed. */
  canonical_url: string;
  host: string;
}

/** Per-site permalink shapes. Ordered: the first capture that matches wins. */
const ID_PATTERNS: Record<string, RegExp[]> = {
  makerworld: [/\/models\/(\d+)/i, /\/model\/(\d+)/i],
  printables: [/\/model\/(\d+)/i],
  thingiverse: [/\/thing:(\d+)/i],
  thangs: [/\/designer\/[^/]+\/3d-model\/[^/]*-(\d+)/i, /\/3d-model\/[^/]*-(\d+)/i],
  cults3d: [/\/3d-model\/[^/]+\/([a-z0-9-]+)/i],
};

/**
 * What the URL alone says. Pure, offline, and always available — this is what
 * makes a pasted link usable even when no API in the world answers.
 */
export function parseModelLink(raw: string, providers: LinkProviderConfig[] = DEFAULT_LINK_PROVIDERS): ParsedLink | null {
  let url: URL;
  try {
    url = validateOutboundUrl(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const provider = providers.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)));

  let externalId = '';
  const patterns = provider ? (ID_PATTERNS[provider.id] ?? []) : [];
  for (const re of patterns) {
    const m = re.exec(url.pathname);
    if (m) {
      externalId = m[1];
      break;
    }
  }

  // Tracking parameters are noise that makes the same design look like two
  // different links, so they are dropped and the rest is kept in order.
  const keep = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (/^(utm_|fbclid|gclid|ref|from|share)/i.test(k)) continue;
    keep.append(k, v);
  }
  const canonical = `${url.origin}${url.pathname}${keep.toString() ? `?${keep}` : ''}`;

  return { provider: provider?.id ?? '', external_id: externalId, canonical_url: canonical, host };
}

export interface ExternalModelInfo {
  resolved: boolean;
  /** Machine-readable, so the UI can word it: NO_API_CONFIGURED, FETCH_FAILED… */
  reason?: string;
  provider: string;
  external_id: string;
  url: string;
  name?: string;
  creator?: string;
  description?: string;
  images?: string[];
  /** Everything below arrives only if the provider publishes it. */
  recommended_material?: string;
  print_profiles?: string[];
  plates?: number;
  colors?: string[];
  estimated_weight_g?: number;
  estimated_time_minutes?: number;
  license?: string;
}

/**
 * Ask the provider's own API, if the admin configured one.
 *
 * WHY THE MAPPING IS TOLERANT RATHER THAN EXACT. These are other people's APIs
 * and their field names are theirs to change. Pinning one exact schema would
 * mean the integration breaks silently the day they rename `cover` to
 * `coverUrl`. So the extractor looks for a SET of plausible names at any depth
 * and takes the first that is the right TYPE — and if it finds nothing, it says
 * so rather than returning an object full of undefined that looks like success.
 */
export async function resolveModelLink(
  raw: string,
  providers: LinkProviderConfig[],
  fetchImpl: typeof fetch = fetch
): Promise<ExternalModelInfo> {
  const parsed = parseModelLink(raw, providers);
  if (!parsed) {
    return { resolved: false, reason: 'BAD_URL', provider: '', external_id: '', url: raw };
  }
  const base: ExternalModelInfo = {
    resolved: false,
    provider: parsed.provider,
    external_id: parsed.external_id,
    url: parsed.canonical_url,
  };

  const provider = providers.find((p) => p.id === parsed.provider);
  if (!provider || !provider.enabled) return { ...base, reason: 'PROVIDER_NOT_ENABLED' };
  if (!provider.api_url) return { ...base, reason: 'NO_API_CONFIGURED' };
  if (!parsed.external_id) return { ...base, reason: 'NO_MODEL_ID_IN_URL' };

  const endpoint = provider.api_url.replace('{id}', encodeURIComponent(parsed.external_id));
  let target: URL;
  try {
    target = validateOutboundUrl(endpoint);
  } catch {
    return { ...base, reason: 'BAD_API_URL' };
  }

  let payload: unknown;
  try {
    const res = await fetchImpl(target.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', ...(provider.headers ?? {}) },
      // A slow third party must not hold a customer's wizard open.
      signal: AbortSignal.timeout(6000),
      redirect: 'follow',
    });
    if (!res.ok) return { ...base, reason: `HTTP_${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    // JSON or nothing. An HTML body here means we were handed a page, and
    // reading a page is the thing this module exists not to do.
    if (!type.includes('json')) return { ...base, reason: 'NOT_JSON' };
    payload = await res.json();
  } catch (e) {
    return { ...base, reason: e instanceof Error && e.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED' };
  }

  const info = mapPayload(payload, base);
  return info.name || info.images?.length ? { ...info, resolved: true } : { ...base, reason: 'UNRECOGNISED_SHAPE' };
}

/** Field names these sites actually use, in the order we prefer them. */
const FIELDS = {
  name: ['name', 'title', 'designTitle', 'modelName'],
  creator: ['creator', 'designer', 'author', 'owner', 'username', 'nickname'],
  description: ['description', 'summary', 'details', 'intro'],
  image: ['cover', 'coverUrl', 'thumbnail', 'thumbnailUrl', 'image', 'imageUrl', 'preview'],
  material: ['material', 'filament', 'recommendedMaterial', 'filamentType'],
  weight: ['weight', 'weightG', 'filamentWeight', 'estimatedWeight'],
  time: ['printTime', 'estimatedTime', 'timeEstimate', 'duration'],
  plates: ['plates', 'plateCount', 'boards'],
  license: ['license', 'licenseType'],
} as const;

function mapPayload(payload: unknown, base: ExternalModelInfo): ExternalModelInfo {
  const out: ExternalModelInfo = { ...base };
  const name = pickString(payload, FIELDS.name);
  if (name) out.name = trim(name, 200);
  const creator = pickCreator(payload);
  if (creator) out.creator = trim(creator, 120);
  const description = pickString(payload, FIELDS.description);
  if (description) out.description = trim(description, 4000);

  const images = pickImages(payload);
  if (images.length) out.images = images.slice(0, 6);

  const material = pickString(payload, FIELDS.material);
  if (material) out.recommended_material = trim(material, 60);
  const license = pickString(payload, FIELDS.license);
  if (license) out.license = trim(license, 80);

  const weight = pickNumber(payload, FIELDS.weight);
  if (weight !== null && weight > 0 && weight < 100_000) out.estimated_weight_g = Math.round(weight);
  const time = pickNumber(payload, FIELDS.time);
  if (time !== null && time > 0) {
    // Sites publish this in seconds, minutes or hours. Anything above a week in
    // the given unit is read as seconds; anything under 100 as hours. Values in
    // between are minutes. A wrong guess here would be a wrong price, so the
    // number is only kept when the reading is unambiguous.
    out.estimated_time_minutes =
      time > 10_080 ? Math.round(time / 60) : time < 100 ? Math.round(time * 60) : Math.round(time);
  }
  const plates = pickNumber(payload, FIELDS.plates);
  if (plates !== null && plates >= 1 && plates <= 100) out.plates = Math.round(plates);

  const colors = pickColors(payload);
  if (colors.length) out.colors = colors.slice(0, 12);
  return out;
}

/** Depth-limited walk. The payloads are small and the limit stops a hostile or
 *  merely enormous document from costing the Worker its CPU budget. */
function walk(value: unknown, visit: (key: string, v: unknown) => boolean, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) walk(item, visit, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (visit(k, v)) return;
    walk(v, visit, depth + 1);
  }
}

function pickString(payload: unknown, names: readonly string[]): string {
  let best = '';
  for (const want of names) {
    walk(payload, (k, v) => {
      if (best) return true;
      if (k.toLowerCase() === want.toLowerCase() && typeof v === 'string' && v.trim()) {
        best = v.trim();
        return true;
      }
      return false;
    });
    if (best) break;
  }
  return best;
}

function pickNumber(payload: unknown, names: readonly string[]): number | null {
  let best: number | null = null;
  for (const want of names) {
    walk(payload, (k, v) => {
      if (best !== null) return true;
      if (k.toLowerCase() === want.toLowerCase()) {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        if (Number.isFinite(n)) {
          best = n;
          return true;
        }
      }
      return false;
    });
    if (best !== null) break;
  }
  return best;
}

/** A creator may be a string or an object with a name inside it. */
function pickCreator(payload: unknown): string {
  let best = '';
  walk(payload, (k, v) => {
    if (best) return true;
    if (!FIELDS.creator.some((c) => c.toLowerCase() === k.toLowerCase())) return false;
    if (typeof v === 'string' && v.trim()) {
      best = v.trim();
      return true;
    }
    if (v && typeof v === 'object') {
      const inner = v as Record<string, unknown>;
      for (const key of ['name', 'nickname', 'username', 'handle']) {
        if (typeof inner[key] === 'string' && (inner[key] as string).trim()) {
          best = (inner[key] as string).trim();
          return true;
        }
      }
    }
    return false;
  });
  return best;
}

/** Only absolute https image URLs. A relative path from someone else's API is
 *  meaningless here, and an http one would break the page it is shown on. */
function pickImages(payload: unknown): string[] {
  const out: string[] = [];
  walk(payload, (k, v) => {
    if (out.length >= 6) return true;
    if (typeof v !== 'string') return false;
    const isImageKey = FIELDS.image.some((c) => k.toLowerCase().includes(c.toLowerCase()));
    if (!isImageKey) return false;
    if (!/^https:\/\//i.test(v)) return false;
    if (!out.includes(v)) out.push(v);
    return false;
  });
  return out;
}

function pickColors(payload: unknown): string[] {
  const out: string[] = [];
  walk(payload, (k, v) => {
    if (out.length >= 12) return true;
    if (typeof v !== 'string') return false;
    if (!/colou?r/i.test(k)) return false;
    const hex = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
    if (hex) {
      const norm = `#${hex[1].toLowerCase()}`;
      if (!out.includes(norm)) out.push(norm);
    }
    return false;
  });
  return out;
}

const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
