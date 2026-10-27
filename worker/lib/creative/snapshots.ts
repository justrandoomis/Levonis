/**
 * MARKETING SNAPSHOTS — stored, hashed, re-verified (spec §9, §25).
 *
 * A design binds to a snapshot id, never to live numbers. A `live` snapshot is
 * built by the store connector (worker/lib/creative/store.ts) from the public
 * card path; a `manual` or `test` snapshot is the brief's JSON import fallback
 * («عند تعذر الاتصال … مع تمييز البيانات اليدوية أو التجريبية عن الاتصال
 * الحي»): it passes the same allow-list below, is labelled by its source for
 * ever, and is never treated as live — its offer is no evidence for a model,
 * a test price renders «تجريبي», and a test snapshot is a blocker at approval
 * (quality.ts `test_data`).
 */
import type { ProductSnapshot, ProductSnapshotData, SnapshotAvailability, SnapshotImage, SnapshotPrice, Localized } from '../../../packages/creativeDoc/src/snapshot';
import { cleanText } from '../../../packages/creativeDoc/src/text';
import { SAFE_FILES_PATH } from '../../../packages/creativeDoc/src/normalize';
import { newId } from '../crypto';
import { badRequest } from '../http';
import { jsonObject, nowIso } from './db';
import { snapshotHash } from './store';

interface SnapshotRow {
  id: string;
  product_id: string | null;
  variant_key: string | null;
  data_json: string;
  hash: string;
  source: 'live' | 'manual' | 'test';
  fetched_at: string;
}

export function snapshotOf(r: SnapshotRow): ProductSnapshot {
  return { id: r.id, data: jsonObject(r.data_json) as unknown as ProductSnapshotData, hash: r.hash, source: r.source, fetched_at: r.fetched_at };
}

export async function getSnapshot(db: D1Database, id: string): Promise<ProductSnapshot | null> {
  const row = await db.prepare('SELECT id, product_id, variant_key, data_json, hash, source, fetched_at FROM creative_product_snapshots WHERE id = ?').bind(id).first<SnapshotRow>();
  return row ? snapshotOf(row) : null;
}

export async function getSnapshots(db: D1Database, ids: readonly string[]): Promise<Map<string, ProductSnapshot>> {
  const out = new Map<string, ProductSnapshot>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare('SELECT id, product_id, variant_key, data_json, hash, source, fetched_at FROM creative_product_snapshots WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(ids)]))
    .all<SnapshotRow>();
  for (const r of results ?? []) out.set(r.id, snapshotOf(r));
  return out;
}

export async function storeSnapshot(db: D1Database, data: ProductSnapshotData, source: ProductSnapshot['source'], actorId: string): Promise<ProductSnapshot> {
  const id = newId('csnap');
  const hash = await snapshotHash(data);
  const fetched = nowIso();
  await db
    .prepare('INSERT INTO creative_product_snapshots (id, product_id, variant_key, data_json, hash, source, fetched_at, fetched_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, data.product_id, data.variant_key, JSON.stringify(data), hash, source, fetched, actorId)
    .run();
  return { id, data, hash, source, fetched_at: fetched };
}

// ---------------------------------------------------------------------------
// The import allow-list
// ---------------------------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const loc = (v: unknown, max: number): Localized => {
  const o = obj(v);
  return { ar: cleanText(o.ar, max).value, en: cleanText(o.en, max).value, ckb: cleanText(o.ckb, max).value };
};
const locOrNull = (v: unknown, max: number): Localized | null => {
  if (v === null || v === undefined) return null;
  const l = loc(v, max);
  return l.ar || l.en || l.ckb ? l : null;
};
const iqd = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000_000 ? v : null);
const AVAILABILITY: readonly SnapshotAvailability[] = ['available', 'preorder', 'unavailable', 'unknown'];

function importPrice(v: unknown): SnapshotPrice {
  const p = obj(v);
  const status = p.status === 'priced' || p.status === 'members_only' ? p.status : 'unpriced';
  const amount = iqd(p.amount_iqd);
  // Unpriced and members-only carry no number — never a zero (spec §9).
  if (status !== 'priced' || amount === null) {
    return { status: status === 'members_only' ? 'members_only' : 'unpriced', amount_iqd: null, regular_iqd: null, from: false, offer: null, member_price_iqd: null };
  }
  const offerRaw = p.offer && typeof p.offer === 'object' ? obj(p.offer) : null;
  const regular = iqd(p.regular_iqd);
  const when = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 30) : null);
  const member = iqd(p.member_price_iqd);
  return {
    status: 'priced',
    amount_iqd: amount,
    regular_iqd: offerRaw && regular !== null && regular > amount ? regular : null,
    from: p.from === true,
    offer: offerRaw && regular !== null && regular > amount ? { starts_at: when(offerRaw.starts_at), ends_at: when(offerRaw.ends_at) } : null,
    member_price_iqd: member !== null && member < amount ? member : null,
  };
}

function importImage(v: unknown): SnapshotImage | null {
  const o = obj(v);
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const sameOrigin = SAFE_FILES_PATH.test(url) && !url.includes('..');
  if (!sameOrigin && !/^https:\/\/[^\s/]{1,200}\/[^\s]{0,400}$/.test(url)) return null;
  const dim = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 20000 ? x : null);
  const vk = typeof o.variant_key === 'string' && /^[A-Za-z0-9_:.,|-]{1,120}$/.test(o.variant_key) ? o.variant_key : null;
  return { url, width: dim(o.width), height: dim(o.height), alt: cleanText(o.alt, 300).value, primary: o.primary === true, variant_key: vk, same_origin: sameOrigin };
}

/**
 * An owner's imported JSON → a marketing snapshot, field by field. Anything
 * not in the type is dropped (a `cost_iqd`, a `stock` or a `supplier` in the
 * file never reaches the row). A 400 when the product id or name is missing.
 */
export function normalizeSnapshotImport(raw: unknown): ProductSnapshotData {
  const d = obj(raw);
  const productId = typeof d.product_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.product_id) ? d.product_id : null;
  if (!productId) throw badRequest('data.product_id is required (letters, digits, _ and -)', 'INVALID_INPUT');
  const name = loc(d.name, 200);
  if (!name.ar && !name.en) throw badRequest('data.name needs Arabic or English', 'INVALID_INPUT');
  const slug = typeof d.slug === 'string' && /^[A-Za-z0-9-]{1,120}$/.test(d.slug) ? d.slug : productId;
  const variantKey = typeof d.variant_key === 'string' && /^[A-Za-z0-9_:.,|-]{1,120}$/.test(d.variant_key) ? d.variant_key : null;
  const specs = (Array.isArray(d.specs) ? d.specs : []).slice(0, 24).flatMap((s) => {
    const o = obj(s);
    const value = cleanText(o.value, 160).value;
    const label = loc(o.label, 120);
    return value && (label.ar || label.en) ? [{ label, value }] : [];
  });
  const contents = (Array.isArray(d.contents) ? d.contents : []).slice(0, 20).flatMap((c) => {
    const o = obj(c);
    const t = cleanText(o.text, 160).value;
    return t ? [{ text: t, qty: typeof o.qty === 'number' && Number.isInteger(o.qty) && o.qty > 0 && o.qty < 1000 ? o.qty : null }] : [];
  });
  const price = importPrice(d.price);
  const availability = AVAILABILITY.includes(d.availability as SnapshotAvailability) ? (d.availability as SnapshotAvailability) : 'unknown';
  return {
    product_id: productId,
    slug,
    path: `/product/${encodeURIComponent(slug)}`,
    variant_key: variantKey,
    variant_label: variantKey ? locOrNull(d.variant_label, 120) : null,
    name,
    brand: locOrNull(d.brand, 120),
    category: locOrNull(d.category, 120),
    sku: typeof d.sku === 'string' && d.sku.trim() ? cleanText(d.sku, 80).value : null,
    short_description: loc(d.short_description, 300),
    specs,
    contents,
    price,
    // An unpriced product's availability is unknown by the card rule; a members-only one too.
    availability: price.status === 'priced' ? availability : 'unknown',
    sale_types: Array.isArray(d.sale_types) ? d.sale_types.filter((t): t is string => t === 'direct_sale' || t === 'pre_order' || t === 'bundle') : [],
    images: (Array.isArray(d.images) ? d.images : []).slice(0, 40).map(importImage).filter((x): x is SnapshotImage => x !== null),
    source_updated_at: typeof d.source_updated_at === 'string' ? d.source_updated_at.slice(0, 30) : null,
  };
}
