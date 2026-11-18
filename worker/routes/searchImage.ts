/**
 * POST /api/search/image — SEARCH BY PHOTO (owner, 2026-11-18).
 *
 *   { image: "data:image/jpeg;base64,…" }   (the page scales it to 1024 px first)
 *
 * The steps and why the model can never answer a product the shop does not
 * list are in worker/lib/search/imageSearch.ts. This file is the reads, the
 * two calls and the caps:
 *
 *   - THE KEY AND THE MODEL are the Creative Studio's (the owner's sealed key
 *     or the Worker secret; the model the owner picked there). A model the
 *     studio knows cannot read pictures is refused before any call.
 *   - THE SWITCH is `admin_settings.searchImageAi` (on unless the owner turns
 *     it off), with the shop's photos per day.
 *   - THE CAPS: 6 photos a minute and 40 a day per account or IP (`rateLimit`,
 *     a 429), and the shop's daily total (one conditional statement in
 *     `rate_limits`, so two parallel photos cannot both take the last slot).
 *   - NOTHING IS KEPT. The photo is not stored, logged or put in the trends
 *     table; only the shop's own counters move.
 *
 * The answer is the storefront's own cards for this viewer (`resolveListingCards`,
 * the grid's price and availability), with `matched` — the colour or option
 * the photo shows — in the listing's shape, so the page links `?v=` exactly as
 * a typed search does.
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { createMessage, keyState, type ContentBlock } from '../lib/creative/anthropic';
import { readProviderSettings } from '../lib/creative/settings';
import { resolveListingCards } from '../lib/catalog/cardsRead';
import { optimisticSellable, optimisticSellableFlag, optimisticVisible, runListed } from '../lib/listing';
import { pricingCtx } from './products';
import { searchProducts } from '../lib/search/store';
import { resolveIdentifier } from '../lib/search/identifiers';
import { readStoredVariant } from '../lib/imageVariants';
import {
  IMAGE_MAX_BYTES,
  IMAGE_SEARCH_SETTING_KEY,
  MAX_CANDIDATES,
  MAX_CANDIDATE_PICTURES,
  PICK_SCHEMA,
  PICK_SYSTEM,
  READ_SCHEMA,
  READ_SYSTEM,
  candidateOf,
  candidateText,
  imageSearchFromSetting,
  photoOf,
  pictureKeyOf,
  searchTexts,
  validatePick,
  validateRead,
  type Candidate,
  type Confidence,
  type Pick,
  type PhotoRead,
  type Verdict,
} from '../lib/search/imageSearch';

export const searchImageRoutes = new Hono<AppContext>();

export const IMAGE_DAY_KEY = 'search-image-day:all';

/** Take one slot of the shop's daily total if it stays at or under `cap`. Never throws: a failed write refuses. */
export async function takeDaySlot(db: D1Database, cap: number, nowMs = Date.now()): Promise<boolean> {
  if (cap <= 0) return false;
  const now = Math.floor(nowMs / 1000);
  const windowStart = now - (now % 86_400);
  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
           window_start = ?2
         WHERE rate_limits.window_start <> ?2 OR rate_limits.count < ?3
         RETURNING count`
      )
      .bind(IMAGE_DAY_KEY, windowStart, cap)
      .first<{ count: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/** Photos taken from the shop's daily total today (0 once the day has turned), for the owner's card. */
export async function imageDayUsed(db: D1Database, nowMs = Date.now()): Promise<number> {
  const now = Math.floor(nowMs / 1000);
  try {
    const row = await db.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').bind(IMAGE_DAY_KEY).first<{ window_start: number; count: number }>();
    return row && row.window_start === now - (now % 86_400) ? row.count : 0;
  } catch {
    return 0;
  }
}

const unavailable = () => new HttpError(409, 'Search by photo is not available right now.', 'IMAGE_SEARCH_UNAVAILABLE');

async function readSetting(db: D1Database) {
  try {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(IMAGE_SEARCH_SETTING_KEY).first<{ value: string }>();
    return imageSearchFromSetting(row?.value);
  } catch {
    return imageSearchFromSetting(null);
  }
}

/** The rows the storefront may list, in `ids` order (the listing's own scope). */
async function listedRows(db: D1Database, ids: string[]): Promise<Record<string, unknown>[]> {
  if (!ids.length) return [];
  const scope = `${optimisticVisible(db)} AND (products.composition = '' OR ${optimisticSellable(db)})`;
  const { results } = await runListed(
    db,
    `SELECT *, ${optimisticSellableFlag(db)} AS sellable_now FROM products WHERE ${scope} AND products.id IN (SELECT value FROM json_each(?))`,
    (q) => db.prepare(q).bind(JSON.stringify(ids)).all<Record<string, unknown>>()
  );
  const byId = new Map((results ?? []).map((r) => [String(r.id), r]));
  return ids.map((id) => byId.get(id)).filter((r): r is Record<string, unknown> => !!r);
}

function listedIdsOf(db: D1Database) {
  return async (ids: string[]): Promise<ReadonlySet<string>> => new Set((await listedRows(db, ids)).map((r) => String(r.id)));
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The stored 320 px WebP copy of a card's main picture, or null (never cut here: no copy, no picture). */
async function candidatePicture(env: AppContext['Bindings'], card: Record<string, unknown>): Promise<ContentBlock | null> {
  const images = Array.isArray(card.images) ? card.images : [];
  const key = pictureKeyOf(images[0]);
  if (!key) return null;
  const obj = await readStoredVariant(env, key, 320, 'image/webp').catch(() => null);
  if (!obj || obj.size > 200_000) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: toBase64(bytes) } };
}

type Ask = (system: string, content: ContentBlock[], schema: Record<string, unknown>) => Promise<unknown>;

async function asker(c: Context<AppContext>): Promise<Ask> {
  const settings = await readProviderSettings(c.env.DB);
  if (!settings.migrated || !settings.model) throw unavailable();
  if ((await keyState(c.env)).source === 'none') throw unavailable();
  if (settings.capabilities.vision === false) throw unavailable();
  const model = settings.model;
  return async (system, content, schema) => {
    const out = await createMessage(c.env, {
      task: 'search_image',
      model,
      system,
      content,
      schema,
      effort: 'low',
      capabilities: settings.capabilities,
    });
    if (!out.ok) {
      if (out.code === 'PROVIDER_RATE_LIMITED' || out.code === 'PROVIDER_OVERLOADED') throw new HttpError(503, 'Busy, try again.', 'IMAGE_SEARCH_BUSY');
      throw new HttpError(502, 'The photo could not be read.', 'IMAGE_SEARCH_FAILED');
    }
    return out.json;
  };
}

export interface ImageAnswer {
  verdict: Verdict;
  /** How the answer was reached: a printed code the shop carries, or the photo compared with the candidates. */
  via: 'code' | 'photo';
  colour: PhotoRead['colour'];
  /** The best text to search for «more like this»: what the page puts in the field. */
  query: string;
  products: Record<string, unknown>[];
  confidence: Record<string, Confidence>;
  matched: Record<string, { option_value_ids: string[]; color_id: string | null; variant_id: string | null }>;
}

searchImageRoutes.post('/image', async (c) => {
  await rateLimit(c, 'search-image', 6, 60);
  await rateLimit(c, 'search-image-day', 40, 86_400);
  // The size is checked on the BYTES, not on a header a client may omit or understate:
  // a body without Content-Length is refused, and one longer than declared or than the cap is never parsed.
  const cap = Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 4096;
  const declaredRaw = c.req.header('content-length');
  const declared = declaredRaw === undefined ? NaN : Number(declaredRaw);
  if (!Number.isInteger(declared) || declared < 0) throw new HttpError(411, 'Content-Length is required.', 'LENGTH_REQUIRED');
  if (declared > cap) throw new HttpError(413, 'The photo is too large.', 'IMAGE_TOO_LARGE');
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > cap) throw new HttpError(413, 'The photo is too large.', 'IMAGE_TOO_LARGE');
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const photo = photoOf(body && typeof body === 'object' ? body.image : null);
  if (!photo) throw badRequest('image: a JPEG, WebP or PNG data URL is required', 'INVALID_INPUT');

  const setting = await readSetting(c.env.DB);
  if (!setting.enabled) throw unavailable();
  const ask = await asker(c);
  if (!(await takeDaySlot(c.env.DB, setting.daily))) throw new HttpError(429, 'Search by photo is resting for today.', 'IMAGE_SEARCH_DAILY_LIMIT');

  const db = c.env.DB;
  const photoBlock: ContentBlock = { type: 'image', source: { type: 'base64', media_type: photo.mime, data: photo.data } };
  const ctxPromise = pricingCtx(c);

  // 1. READ.
  const read = validateRead(await ask(READ_SYSTEM, [photoBlock, { type: 'text', text: 'Describe the product in this photo.' }], READ_SCHEMA as unknown as Record<string, unknown>));
  if (!read) throw new HttpError(502, 'The photo could not be read.', 'IMAGE_SEARCH_FAILED');
  const texts = searchTexts(read);
  const empty: ImageAnswer = { verdict: 'none', via: 'photo', colour: read.colour, query: texts[0] ?? '', products: [], confidence: {}, matched: {} };
  if (!read.is_product && !read.codes.length) return c.json({ success: true, ...empty });

  // 2. CANDIDATES — a printed code first, then the phrases.
  const visible = listedIdsOf(db);
  const ident = read.codes.length ? await resolveIdentifier(db, `${read.codes.join(' ')} `, { visible }).catch(() => null) : null;
  const exactIds = [...new Set((ident?.exact ?? []).map((h) => h.product_id))];
  const ranked: string[] = [...exactIds];
  for (const text of texts) {
    if (ranked.length >= MAX_CANDIDATES * 2) break;
    const res = await searchProducts(db, `${text} `, { limit: 8, completeLast: false, visible }).catch(() => null);
    for (const id of res?.ids ?? []) if (!ranked.includes(id)) ranked.push(id);
  }
  const rows = await listedRows(db, ranked.slice(0, MAX_CANDIDATES));
  if (!rows.length) return c.json({ success: true, ...empty });
  const cards = await resolveListingCards(db, rows, await ctxPromise, null, 'flag');
  const listed = rows.filter((r) => cards.has(String(r.id)));
  const candidates: Candidate[] = listed.map((r, i) => candidateOf(i, r));

  // A code printed on the item that exactly one listed product carries is the answer: no second call.
  let verdict: Verdict;
  let picks: Pick[];
  let via: ImageAnswer['via'] = 'photo';
  const exactListed = exactIds.filter((id) => cards.has(id));
  if (exactListed.length === 1) {
    via = 'code';
    verdict = 'same';
    const sel = ident?.matched.get(exactListed[0]) ?? null;
    picks = [{ product_id: exactListed[0], confidence: 'high', selection: sel, via: sel ? 'model' : null }];
    for (const cand of candidates) if (cand.product_id !== exactListed[0] && picks.length < 3) picks.push({ product_id: cand.product_id, confidence: 'low', selection: null, via: null });
  } else {
    // 3. PICK — the photo beside the closed list, with the candidates' own pictures.
    const pictured = new Set<string>();
    const pictureBlocks: ContentBlock[] = [];
    const pics = await Promise.all(
      candidates.slice(0, MAX_CANDIDATE_PICTURES).map((cand) => candidatePicture(c.env, cards.get(cand.product_id)!).catch(() => null))
    );
    pics.forEach((block, i) => {
      if (!block) return;
      pictured.add(candidates[i].key);
      pictureBlocks.push({ type: 'text', text: `Picture of ${candidates[i].key}:` }, block);
    });
    const seen = [read.kind, read.brand, read.model, read.colour ? `colour ${read.colour}` : '', read.codes.length ? `codes ${read.codes.join(', ')}` : '']
      .filter(Boolean)
      .join('; ');
    const content: ContentBlock[] = [
      { type: 'text', text: 'The customer photo:' },
      photoBlock,
      { type: 'text', text: `First read of the photo: ${seen || 'nothing certain'}.\n\nShop products closest to it:\n${candidateText(candidates, pictured)}` },
      ...pictureBlocks,
      { type: 'text', text: 'Which listed products are the product in the customer photo, and which option of it does the photo show?' },
    ];
    const pick = validatePick(await ask(PICK_SYSTEM, content, PICK_SCHEMA as unknown as Record<string, unknown>), candidates, read.colour);
    if (!pick) throw new HttpError(502, 'The photo could not be read.', 'IMAGE_SEARCH_FAILED');
    verdict = pick.verdict;
    picks = pick.picks;
  }

  const answer: ImageAnswer = { ...empty, verdict, via };
  for (const p of picks) {
    const card = cards.get(p.product_id);
    if (!card) continue;
    answer.products.push(card);
    answer.confidence[p.product_id] = p.confidence;
    if (p.selection) answer.matched[p.product_id] = p.selection;
  }
  if (!answer.products.length) answer.verdict = 'none';
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, ...answer });
});
