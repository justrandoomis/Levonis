/**
 * THE OWNER'S SNAPSHOT UPLOAD (docs/SMART_PRICING.md §3.2, §3.4; migration 0218).
 *
 * A capture reaches the Worker only through the owner's browser: it reads a
 * `levonis.supplier-prices.v1` file, hashes it with crypto.subtle and posts it
 * in chunks. The Worker never fetches a snapshot file.
 *
 *   create    a snapshot in state `loading` (source, currency, basis, capture,
 *             date, who, the file's SHA-256 and its item count);
 *   items     one chunk of at most 50 items and 256 KB, read by the strict
 *             parser (packages/catalog/src/supplierPrices/format.ts), written
 *             as items, SKUs (with `pack_units` and `net_weight_g` read by
 *             keys.ts `packOf`) and the matcher's index keys (`catalogueKeysOf`)
 *             through INSERT … SELECT … FROM json_each(?): one list per
 *             statement, no SQL function call with more than two arguments.
 *             Idempotent on the primary keys: a chunk posted twice writes once;
 *   complete  the counts and the hash checked, then in ONE batch the source's
 *             previous complete snapshot becomes `superseded` and this one
 *             `complete` (ux_sps_current allows one per source);
 *   discard   a snapshot's rows are deleted and it is marked `discarded`.
 *
 * After a completion or a discard, superseded snapshots beyond the newest
 * three per source are deleted with their rows.
 *
 * Owner-only (invariant I6), and the import's guard triggers refuse every
 * write to these tables inside an import batch (T12).
 */
import { auditStatements } from '../audit';
import { HttpError, notFound } from '../http';
import { fence, isFenceMiss } from '../operations';
import { inputInvalid } from '../pricingEngine/whatIf';
import {
  SNAPSHOT_HEADER_KEYS,
  SUPPLIER_PRICE_FORMAT_MESSAGE,
  SUPPLIER_PRICE_LIMITS,
  SupplierPriceFormatError,
  parseSnapshotHeader,
  parseSupplierPriceItems,
  type SupplierPriceItem,
  type SupplierSource,
} from '@levonis/catalog/supplierPrices/format';
import { catalogueKeysOf, packOf } from '@levonis/catalog/supplierPrices/keys';
import { daysBetween, isSupplierSource, pricingChanged, strictBody } from './store';

/** The most items one upload chunk carries (§3.4). */
export const UPLOAD_CHUNK_ITEMS = 50;
/** The most bytes of JSON one upload chunk carries (§3.4). */
export const UPLOAD_CHUNK_BYTES = 256 * 1024;
/** Superseded snapshots kept per source (§3.4 discard). */
export const SUPERSEDED_KEPT = 3;

const SNAPSHOT_ID = /^sps_[A-Za-z0-9_-]{1,36}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const isSnapshotId = (v: unknown): v is string => typeof v === 'string' && SNAPSHOT_ID.test(v);

/** 400 SUPPLIER_PRICE_FORMAT_INVALID {path, reason}: the strict parser refused the file; nothing was stored. */
export function formatRefusal(e: SupplierPriceFormatError): HttpError {
  return new HttpError(400, `${SUPPLIER_PRICE_FORMAT_MESSAGE.ar} / ${SUPPLIER_PRICE_FORMAT_MESSAGE.en}`, e.code, { path: e.path, reason: e.reason });
}

const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

// ---------------------------------------------------------------- reads

export interface SnapshotDto {
  id: string;
  source: SupplierSource;
  currency: string;
  /** How the store listed the price ('list' or 'net_of_vat'): recorded, never converted (282(a)). */
  snapshot_price_basis: string;
  capture: string;
  captured_on: string;
  captured_by: string;
  file_sha256: string;
  item_count: number;
  sku_count: number;
  state: string;
  created_at: string;
  completed_at: string | null;
  /** Days since the capture (UTC). */
  age_days: number | null;
  /** Rows stored so far (a loading snapshot's progress). */
  stored_items: number;
  stored_skus: number;
  /** Items of this snapshot with a confirmed or suggested match of its source, and the rest. */
  matched_items: number;
  unmatched_items: number;
}

const SNAPSHOT_COLUMNS =
  's.id, s.source, s.currency, s.price_basis, s.capture, s.captured_on, s.captured_by, s.file_sha256, s.item_count, s.sku_count, s.state, s.created_at, s.completed_at';

function snapshotDto(r: Record<string, unknown>, today: string): SnapshotDto {
  const stored = Number(r.stored_items ?? 0);
  const matched = Number(r.matched_items ?? 0);
  const age = daysBetween(String(r.captured_on ?? ''), today);
  return {
    id: String(r.id),
    source: String(r.source) as SupplierSource,
    currency: String(r.currency),
    snapshot_price_basis: String(r.price_basis ?? 'list'),
    capture: String(r.capture),
    captured_on: String(r.captured_on),
    captured_by: String(r.captured_by ?? ''),
    file_sha256: String(r.file_sha256),
    item_count: Number(r.item_count ?? 0),
    sku_count: Number(r.sku_count ?? 0),
    state: String(r.state),
    created_at: String(r.created_at),
    completed_at: r.completed_at === null || r.completed_at === undefined ? null : String(r.completed_at),
    age_days: Number.isFinite(age) ? age : null,
    stored_items: stored,
    stored_skus: Number(r.stored_skus ?? 0),
    matched_items: matched,
    unmatched_items: Math.max(0, stored - matched),
  };
}

const SNAPSHOT_STATS = `
  (SELECT COUNT(*) FROM supplier_price_items i WHERE i.snapshot_id = s.id) AS stored_items,
  (SELECT COUNT(*) FROM supplier_price_skus k WHERE k.snapshot_id = s.id) AS stored_skus,
  (SELECT COUNT(*) FROM supplier_price_items i WHERE i.snapshot_id = s.id
      AND EXISTS (SELECT 1 FROM supplier_price_matches m
                   WHERE m.source = s.source AND m.item_key = i.item_key AND m.state IN ('confirmed', 'suggested'))) AS matched_items`;

/** Every snapshot (newest first per source), with its counts and age. */
export async function listSnapshots(db: D1Database, today: string): Promise<SnapshotDto[]> {
  const { results } = await db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS}, ${SNAPSHOT_STATS} FROM supplier_price_snapshots s ORDER BY s.source, s.created_at DESC, s.id DESC LIMIT 200`)
    .all<Record<string, unknown>>();
  return (results ?? []).map((r) => snapshotDto(r, today));
}

export async function snapshotById(db: D1Database, id: string, today: string): Promise<SnapshotDto | null> {
  if (!isSnapshotId(id)) return null;
  const r = await db.prepare(`SELECT ${SNAPSHOT_COLUMNS}, ${SNAPSHOT_STATS} FROM supplier_price_snapshots s WHERE s.id = ?`).bind(id).first<Record<string, unknown>>();
  return r ? snapshotDto(r, today) : null;
}

// ---------------------------------------------------------------- create

const CREATE_KEYS = [...SNAPSHOT_HEADER_KEYS, 'file_sha256', 'item_count'];

/** POST /snapshots: a new snapshot in state `loading`. */
export async function createSnapshot(db: D1Database, body: Record<string, unknown>, actor: string, now: Date): Promise<SnapshotDto> {
  strictBody(body, CREATE_KEYS);
  let header;
  try {
    header = parseSnapshotHeader(body, '$');
  } catch (e) {
    if (e instanceof SupplierPriceFormatError) throw formatRefusal(e);
    throw e;
  }
  if (typeof body.file_sha256 !== 'string' || !SHA256.test(body.file_sha256)) throw inputInvalid('file_sha256');
  if (!wholeIn(body.item_count, 1, SUPPLIER_PRICE_LIMITS.items)) throw inputInvalid('item_count');
  const id = `sps_${crypto.randomUUID().replace(/-/g, '')}`;
  const at = now.toISOString();
  const audit = await auditStatements(db, actor, 'supplier_prices.snapshot_create', id, { source: header.source, capture: header.capture, item_count: body.item_count });
  await db.batch([
    db
      .prepare(
        `INSERT INTO supplier_price_snapshots
           (id, source, currency, price_basis, capture, captured_on, captured_by, file_sha256, item_count, sku_count, state, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'loading', ?, ?)`
      )
      .bind(id, header.source, header.currency, header.price_basis, header.capture, header.captured_on, header.captured_by, body.file_sha256, body.item_count, actor, at),
    ...audit.statements,
  ]);
  return (await snapshotById(db, id, at.slice(0, 10)))!;
}

// ---------------------------------------------------------------- items

interface SnapshotHead {
  id: string;
  source: SupplierSource;
  state: string;
  item_count: number;
  file_sha256: string;
}

async function snapshotHead(db: D1Database, id: string): Promise<SnapshotHead> {
  if (!isSnapshotId(id)) throw notFound();
  const r = await db.prepare('SELECT id, source, state, item_count, file_sha256 FROM supplier_price_snapshots WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!r || !isSupplierSource(r.source)) throw notFound();
  return { id: String(r.id), source: r.source, state: String(r.state), item_count: Number(r.item_count), file_sha256: String(r.file_sha256) };
}

/** The rows one parsed chunk writes, as the three json_each lists. */
export function chunkRows(source: SupplierSource, items: readonly SupplierPriceItem[]) {
  const itemRows = items.map((i) => ({
    k: i.item_key,
    u: i.url,
    h: i.page_host,
    t: i.title,
    n: i.name_en,
    c: i.category,
    s: i.sourcing,
    r: i.freight_route,
    cj: JSON.stringify(i.codes),
    pj: JSON.stringify(i.props),
  }));
  const skuRows = items.flatMap((i) =>
    i.skus.map((s) => {
      const pack = packOf([...Object.values(s.options), i.title]);
      return {
        k: i.item_key,
        s: s.sku_key,
        o: JSON.stringify(s.options),
        oe: JSON.stringify(s.options_en),
        cj: JSON.stringify(s.codes),
        sc: s.sku_code,
        p: s.price,
        l: s.price_label,
        q: s.quantity,
        pu: pack.pack_units,
        w: pack.net_weight_g,
      };
    })
  );
  const keyRows: Array<[string, string, string, string]> = [];
  const seen = new Set<string>();
  for (const i of items) {
    for (const k of catalogueKeysOf(source, i)) {
      const id = `${k.key_type}\u0000${k.key_value}\u0000${i.item_key}\u0000${k.sku_key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      keyRows.push([k.key_type, k.key_value, i.item_key, k.sku_key]);
    }
  }
  return { itemRows, skuRows, keyRows };
}

export interface UploadAnswer {
  /** Items and SKUs in this chunk. */
  chunk: { items: number; skus: number };
  /** What the snapshot holds now. */
  totals: { items: number; skus: number };
}

async function storedCounts(db: D1Database, id: string): Promise<{ items: number; skus: number }> {
  const r = await db
    .prepare('SELECT (SELECT COUNT(*) FROM supplier_price_items WHERE snapshot_id = ?1) AS items, (SELECT COUNT(*) FROM supplier_price_skus WHERE snapshot_id = ?1) AS skus')
    .bind(id)
    .first<{ items: number; skus: number }>();
  return { items: Number(r?.items ?? 0), skus: Number(r?.skus ?? 0) };
}

/** POST /snapshots/:id/items: one chunk, from the request's raw JSON text (its size is checked before it is parsed). */
export async function uploadItems(db: D1Database, id: string, raw: string): Promise<UploadAnswer> {
  if (new TextEncoder().encode(raw).byteLength > UPLOAD_CHUNK_BYTES) throw inputInvalid('items');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw inputInvalid('items');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw inputInvalid('items');
  const b = body as Record<string, unknown>;
  strictBody(b, ['items', 'offset']);
  const offset = b.offset === undefined ? 0 : b.offset;
  if (!wholeIn(offset, 0, SUPPLIER_PRICE_LIMITS.items)) throw inputInvalid('offset');
  const head = await snapshotHead(db, id);
  if (head.state !== 'loading') throw pricingChanged();
  let items: SupplierPriceItem[];
  try {
    items = parseSupplierPriceItems(b.items, head.source, { max: UPLOAD_CHUNK_ITEMS, offset });
  } catch (e) {
    if (e instanceof SupplierPriceFormatError) throw formatRefusal(e);
    throw e;
  }
  const { itemRows, skuRows, keyRows } = chunkRows(head.source, items);
  const after = fence(
    db,
    '(SELECT COUNT(*) FROM supplier_price_items WHERE snapshot_id = ?) <= (SELECT item_count FROM supplier_price_snapshots WHERE id = ?) AND (SELECT COUNT(*) FROM supplier_price_skus WHERE snapshot_id = ?) <= ?',
    [id, id, id, SUPPLIER_PRICE_LIMITS.skus]
  );
  try {
    await db.batch([
      ...fence(db, "EXISTS (SELECT 1 FROM supplier_price_snapshots WHERE id = ? AND state = 'loading')", [id]),
      db
        .prepare(
          `INSERT INTO supplier_price_items
             (snapshot_id, item_key, url, page_host, title, name_en, category, sourcing_hint, route_hint, codes_json, props_json)
           SELECT ?1, json_extract(j.value, '$.k'), json_extract(j.value, '$.u'), json_extract(j.value, '$.h'),
                  json_extract(j.value, '$.t'), json_extract(j.value, '$.n'), json_extract(j.value, '$.c'),
                  json_extract(j.value, '$.s'), json_extract(j.value, '$.r'), json_extract(j.value, '$.cj'), json_extract(j.value, '$.pj')
             FROM json_each(?2) j WHERE 1
           ON CONFLICT DO NOTHING`
        )
        .bind(id, JSON.stringify(itemRows)),
      db
        .prepare(
          `INSERT INTO supplier_price_skus
             (snapshot_id, item_key, sku_key, options_json, options_en_json, codes_json, sku_code, price, price_label, quantity, pack_units, net_weight_g)
           SELECT ?1, json_extract(j.value, '$.k'), json_extract(j.value, '$.s'), json_extract(j.value, '$.o'),
                  json_extract(j.value, '$.oe'), json_extract(j.value, '$.cj'), json_extract(j.value, '$.sc'),
                  json_extract(j.value, '$.p'), json_extract(j.value, '$.l'), json_extract(j.value, '$.q'),
                  json_extract(j.value, '$.pu'), json_extract(j.value, '$.w')
             FROM json_each(?2) j WHERE 1
           ON CONFLICT DO NOTHING`
        )
        .bind(id, JSON.stringify(skuRows)),
      db
        .prepare(
          `INSERT INTO supplier_price_keys (snapshot_id, key_type, key_value, item_key, sku_key)
           SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]')
             FROM json_each(?2) j WHERE 1
           ON CONFLICT DO NOTHING`
        )
        .bind(id, JSON.stringify(keyRows)),
      ...after,
    ]);
  } catch (e) {
    if (!isFenceMiss(e)) throw e;
    // Which fence: the snapshot left `loading` (another tab), or this chunk carried more than the file declared.
    const now = await snapshotHead(db, id);
    throw now.state !== 'loading' ? pricingChanged() : inputInvalid('items');
  }
  return { chunk: { items: itemRows.length, skus: skuRows.length }, totals: await storedCounts(db, id) };
}

// ---------------------------------------------------------------- complete, discard, prune

/**
 * The superseded snapshots of source ?1 beyond its newest ?2: newest by completion, then by
 * creation order (the rowid) — two completions inside one clock step never decide by a random id.
 */
const PRUNABLE = `SELECT s.id FROM supplier_price_snapshots s
  WHERE s.source = ?1 AND s.state = 'superseded'
    AND (SELECT COUNT(*) FROM supplier_price_snapshots n
          WHERE n.source = s.source AND n.state = 'superseded'
            AND (COALESCE(n.completed_at, '') > COALESCE(s.completed_at, '')
                 OR (COALESCE(n.completed_at, '') = COALESCE(s.completed_at, '') AND n.rowid > s.rowid))) >= ?2`;

/** Deletes the superseded snapshots of a source beyond the newest three, children first (not only by cascade). */
export function pruneStatements(db: D1Database, source: SupplierSource): D1PreparedStatement[] {
  return ['supplier_price_keys', 'supplier_price_skus', 'supplier_price_items'].map((t) =>
    db.prepare(`DELETE FROM ${t} WHERE snapshot_id IN (${PRUNABLE})`).bind(source, SUPERSEDED_KEPT)
  ).concat(db.prepare(`DELETE FROM supplier_price_snapshots WHERE id IN (${PRUNABLE})`).bind(source, SUPERSEDED_KEPT));
}

/** Deletes one snapshot's rows (its items, SKUs and index keys). */
function childDeletes(db: D1Database, id: string): D1PreparedStatement[] {
  return ['supplier_price_keys', 'supplier_price_skus', 'supplier_price_items'].map((t) => db.prepare(`DELETE FROM ${t} WHERE snapshot_id = ?`).bind(id));
}

/** POST /snapshots/:id/complete {item_count, sku_count, file_sha256}. */
export async function completeSnapshot(db: D1Database, id: string, body: Record<string, unknown>, actor: string, now: Date): Promise<SnapshotDto> {
  strictBody(body, ['item_count', 'sku_count', 'file_sha256']);
  const head = await snapshotHead(db, id);
  if (head.state !== 'loading') throw pricingChanged();
  if (!wholeIn(body.item_count, 1, SUPPLIER_PRICE_LIMITS.items) || body.item_count !== head.item_count) throw inputInvalid('item_count');
  if (!wholeIn(body.sku_count, 1, SUPPLIER_PRICE_LIMITS.skus)) throw inputInvalid('sku_count');
  if (typeof body.file_sha256 !== 'string' || body.file_sha256 !== head.file_sha256) throw inputInvalid('file_sha256');
  const stored = await storedCounts(db, id);
  if (stored.items !== head.item_count) throw inputInvalid('item_count');
  if (stored.skus !== body.sku_count) throw inputInvalid('sku_count');
  const at = now.toISOString();
  const audit = await auditStatements(db, actor, 'supplier_prices.snapshot_complete', id, { source: head.source, item_count: stored.items, sku_count: stored.skus });
  try {
    await db.batch([
      ...fence(
        db,
        "EXISTS (SELECT 1 FROM supplier_price_snapshots WHERE id = ? AND state = 'loading') AND (SELECT COUNT(*) FROM supplier_price_items WHERE snapshot_id = ?) = ? AND (SELECT COUNT(*) FROM supplier_price_skus WHERE snapshot_id = ?) = ?",
        [id, id, stored.items, id, stored.skus]
      ),
      // The previous current snapshot first: ux_sps_current holds one complete snapshot per source.
      db.prepare("UPDATE supplier_price_snapshots SET state = 'superseded' WHERE source = ? AND state = 'complete' AND id <> ?").bind(head.source, id),
      db.prepare("UPDATE supplier_price_snapshots SET state = 'complete', sku_count = ?, completed_at = ? WHERE id = ? AND state = 'loading'").bind(stored.skus, at, id),
      ...pruneStatements(db, head.source),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isFenceMiss(e)) throw pricingChanged();
    throw e;
  }
  return (await snapshotById(db, id, at.slice(0, 10)))!;
}

/** POST /snapshots/:id/discard: its rows deleted, the snapshot kept as `discarded` (a second discard answers it as it is). */
export async function discardSnapshot(db: D1Database, id: string, actor: string, now: Date): Promise<SnapshotDto> {
  const head = await snapshotHead(db, id);
  const at = now.toISOString();
  if (head.state === 'discarded') return (await snapshotById(db, id, at.slice(0, 10)))!;
  const audit = await auditStatements(db, actor, 'supplier_prices.snapshot_discard', id, { source: head.source, from: head.state });
  try {
    await db.batch([
      ...fence(db, 'EXISTS (SELECT 1 FROM supplier_price_snapshots WHERE id = ? AND state = ?)', [id, head.state]),
      db.prepare("UPDATE supplier_price_snapshots SET state = 'discarded' WHERE id = ?").bind(id),
      ...childDeletes(db, id),
      ...pruneStatements(db, head.source),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isFenceMiss(e)) throw pricingChanged();
    throw e;
  }
  return (await snapshotById(db, id, at.slice(0, 10)))!;
}
