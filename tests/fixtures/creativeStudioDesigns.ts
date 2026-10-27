/**
 * DESIGNS THE STUDIO'S SERVER CHECKS ACCEPT, AND A D1 THAT OPENS A WINDOW —
 * shared by the version, review and archive tests (tests/creativeStudioVersions,
 * tests/creativeStudioReleased, tests/creativeStudioArchive).
 *
 * `goodDesign` passes every check the Worker runs at approval and a final
 * export (a bound picture, a bound price, a headline, inside the safe area).
 * `hookedD1` runs `fire` once, right after the first statement whose SQL
 * matches — a competing request landing between a write's reads and its batch
 * (tests/fixtures/d1.ts: races are simulated by interleaving in one process).
 */
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { json as body, post } from './app';
import { SqliteD1, type SqliteStatement } from './d1';
import { BASE, design, textLayer, type studioApp } from './creativeStudio';

type App = ReturnType<typeof studioApp>;

export const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);

export async function create(app: App, content: Record<string, unknown> = design(), extra: Record<string, unknown> = {}) {
  const res = await post(app, `${BASE}/documents`, { title: 'Design', content, kind: 'post', ...extra });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await body(res)).document as { id: string; version: number; status: string; content: Record<string, unknown> };
}

export function multipart(app: App, path: string, file: Buffer, fields: Record<string, string>, type = 'image/png') {
  const form = new FormData();
  form.set('file', new Blob([file], { type }), 'upload.bin');
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return app.request(path, { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
}

/** POST a 1×1 PNG as an export of `version` (final unless told otherwise). */
export const exportPng = (app: App, id: string, version: number, final = true) =>
  multipart(app, `${BASE}/documents/${id}/exports`, PNG_1x1, { meta: JSON.stringify({ version, kind: 'png', final, width: 1080, height: 1080 }) });

export const approve = (app: App, id: string, version: number) => post(app, `${BASE}/documents/${id}/approve`, { version, qa: {}, export_ids: [] });

/** A design that passes every server check; `price: false` leaves the bound price out (an awareness post). */
export function goodDesign(snapshotId: string, extra: Record<string, unknown> = {}, opts: { price?: boolean; headline?: string } = {}) {
  const layers: unknown[] = [
    { id: 'background', type: 'shape', name: 'bg', role: 'background', x: 0, y: 0, width: 1080, height: 1080, shape: 'rect', fill: '#111214', locked: true },
    textLayer('headline', 'headline', opts.headline ?? 'طابعة دقيقة لكل مشروع', { x: 120, y: 110, width: 840, height: 110 }),
    { id: 'product', type: 'image', name: 'product', role: 'product', x: 240, y: 260, asset: { kind: 'product', ref: '/files/products/p_print/main.webp', slot: 'main' }, natural: { width: 1200, height: 1000 }, scale: 0.5 },
  ];
  if (opts.price !== false) {
    layers.push(textLayer('price', 'price', '900,000 د.ع', { x: 120, y: 800, width: 840, height: 90, source: { kind: 'product', slot: 'main', field: 'price' } }));
  }
  return design({
    objective: 'sell',
    products: [{ slot: 'main', product_id: 'p_print', variant_key: null, snapshot_id: snapshotId }],
    layers,
    alt_text: 'طابعة',
    caption: 'طابعة Bambu Lab A1',
    ...extra,
  });
}

/** A fresh live snapshot of the seeded printer. */
export async function snapshotOf(app: App, productId = 'p_print'): Promise<{ id: string; data: { price: { offer: unknown } } }> {
  const snap = await body(await post(app, `${BASE}/snapshots`, { product_id: productId, variant_key: null }));
  assert.ok(snap.id, JSON.stringify(snap));
  return snap as { id: string; data: { price: { offer: unknown } } };
}

/** A live public offer on a product (100,000 IQD off), the way the storefront's offers are stored. */
export function startOffer(raw: DatabaseSync, productId = 'p_print') {
  raw
    .prepare(
      `INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,offer_price_iqd,discount_percent,discount_iqd,plus_price_iqd,locked_preview,active)
       VALUES ('product', ?, ?, NULL, NULL, '[]', 'discount_iqd', NULL, NULL, 100000, NULL, 1, 1)`
    )
    .run(productId, `ofw_${productId}`);
}

export const endOffer = (raw: DatabaseSync, productId = 'p_print') => raw.prepare('DELETE FROM offer_windows WHERE subject_id = ?').run(productId);

/** A finished AI job row, as the AI routes leave one (task, status and owner as the test needs). */
export function seedJob(raw: DatabaseSync, id: string, extra: { task?: string; status?: string; actor?: string; document_id?: string | null; base_version?: number | null } = {}) {
  raw
    .prepare(
      `INSERT INTO creative_jobs (id, task, status, actor_id, idempotency_key, request_hash, document_id, base_version, result_json, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'h', ?, ?, '{}', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:01.000Z')`
    )
    .run(id, extra.task ?? 'compose', extra.status ?? 'succeeded', extra.actor ?? 'usr_owner', `key-${id}`, extra.document_id ?? null, extra.base_version ?? null);
}

interface Hook {
  match: RegExp;
  fire: () => Promise<void> | void;
  done?: boolean;
}

/** A D1 over `raw` whose statements run `fire` once, right after the first one matching `match` (tests/authRaces.test.ts). */
export function hookedD1(raw: DatabaseSync, hooks: Hook[]): D1Database {
  const inner = new SqliteD1(raw);
  const fire = async (sql: string) => {
    for (const h of hooks) {
      if (!h.done && h.match.test(sql)) {
        h.done = true;
        await h.fire();
      }
    }
  };
  const wrap = (s: SqliteStatement): unknown => ({
    inner: s,
    bind: (...v: unknown[]) => wrap(s.bind(...v)),
    run: async () => { const r = await s.run(); await fire(s.sql); return r; },
    first: async () => { const r = await s.first(); await fire(s.sql); return r; },
    all: async () => { const r = await s.all(); await fire(s.sql); return r; },
  });
  return {
    prepare: (sql: string) => wrap(inner.prepare(sql)),
    batch: (ss: Array<{ inner: SqliteStatement }>) => inner.batch(ss.map((x) => x.inner)),
  } as unknown as D1Database;
}
