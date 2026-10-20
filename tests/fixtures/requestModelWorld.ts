/**
 * THE WORLD THE REQUEST-MODEL TESTS RUN IN (P1-04, docs/DECISIONS.md row 266).
 *
 * Real routes and real migrations through the D1 adapter: a buyer, an FDM
 * workshop (m1, owner) and a resin workshop (m2, owner2), both approved, an
 * admin, a saved address, Levo Community open. `through` builds the database
 * a deploy lands on before its migrations ran (`dbThrough('0207')`: no 0208).
 *
 * Request files are written as rows (and, when a test reads the bytes, as an
 * object in a memory bucket): the model reads file ROWS, and the doors that
 * write them have their own tests (tests/requestFileDoors.test.ts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { approveMerchants, asD1, dbThrough, get, json, MemoryBucket, post, put, stubApp, type Mount } from './app';
import { ROOT } from './d1';
import { marketplaceRoutes } from '../../worker/routes/marketplace';
import { printRequestRoutes } from '../../worker/routes/printRequests';

export const RATE = 1400;

export const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

export function world(through: string | null = null): DatabaseSync {
  const raw = dbThrough(through);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,phone_e164) VALUES
      ('buyer','Sara','s@x.co','h','customer','+9647700000001'), ('owner','Ali','a@x.co','h','customer',NULL),
      ('owner2','Omar','o@x.co','h','customer',NULL), ('stranger','Nour','n@x.co','h','customer',NULL),
      ('admin1','Admin','admin@x.co','h','admin',NULL);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name,phone) VALUES ('m1','owner','Ali 3D','+9647511111111'), ('m2','owner2','Omar Resin','');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,contact_phone) VALUES
      ('s1','m1','owner','ali3d','Ali 3D',''), ('s2','m2','owner2','omarresin','Omar Resin','+9647522222222');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p1','m1','s1','Big FDM','fdm',300,300,300,'[]','ultra'),
             ('p2','m2','s2','Resin','resin',200,200,200,'[]','ultra');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area)
      VALUES ('a1','buyer','Home','Sara K','+9647700000009','Street 12, house 4','near the mosque',1,'baghdad','Karrada');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  // A database before 0204 has no approval column to stamp, and its gate fails closed: give it the column.
  try {
    raw.exec('ALTER TABLE community_merchants ADD COLUMN approved_at TEXT; ALTER TABLE community_merchants ADD COLUMN approved_application_id TEXT;');
  } catch {
    /* 0204 is there */
  }
  approveMerchants(raw);
  return raw;
}

/** Apply migration 0208 to a database built through 0207, as workflow 7 does before it deploys. */
export function apply0208(raw: DatabaseSync): void {
  raw.exec(readFileSync(join(ROOT, 'migrations', '0208_request_sources_parts.sql'), 'utf8'));
}

export const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);

export const as = (raw: DatabaseSync, id: string, opts: { bucket?: MemoryBucket; role?: 'customer' | 'admin' } = {}) =>
  stubApp(asD1(raw), { id, role: opts.role ?? 'customer', email: `${id}@x.co` }, mount, opts.bucket ? { env: { BUCKET: opts.bucket, R2_PRIVATE: opts.bucket, R2_PUBLIC: opts.bucket } } : {});

export const PLA = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1 };

export async function newDraft(raw: DatabaseSync, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await post(as(raw, 'buyer'), '/api/marketplace/requests', {
    title: 'A phone stand', description: 'A stand for a phone, please', ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  return (await json(res)).request.id as string;
}

let fileClock = 0;
/**
 * A file on a request, as a door would leave its row. The created_at is a
 * strictly increasing clock so the `created_at, id` order is the order of the
 * calls. With a bucket, the bytes are stored under the row's key.
 */
export function addFile(
  raw: DatabaseSync,
  requestId: string,
  id: string,
  kind: 'model' | 'reference' | 'document',
  name: string,
  opts: { bucket?: MemoryBucket; analysis?: Record<string, unknown> } = {}
): string {
  fileClock++;
  const created = new Date(Date.UTC(2026, 9, 1, 0, 0, fileClock)).toISOString();
  const key = `requests/buyer/files/${id}.${name.split('.').pop()}`;
  const type = kind === 'model' ? 'model/stl' : kind === 'reference' ? 'image/png' : 'application/pdf';
  raw
    .prepare(
      `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind, analysis, created_at)
       VALUES (?, ?, ?, ?, ?, 64, ?, ?, ?)`
    )
    .run(id, requestId, key, name, type, kind, opts.analysis ? JSON.stringify(opts.analysis) : '', created);
  if (opts.bucket) void opts.bucket.put(key, new Uint8Array(64), { httpMetadata: { contentType: type } });
  return key;
}

export async function publish(raw: DatabaseSync, id: string, body: Record<string, unknown> = PLA) {
  const res = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, body);
  return { status: res.status, body: await json(res) };
}

export async function saveDraft(raw: DatabaseSync, id: string, body: Record<string, unknown>) {
  const res = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, body);
  return { status: res.status, body: await json(res) };
}

export async function readDraft(raw: DatabaseSync, id: string) {
  const res = await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`);
  assert.equal(res.status, 200);
  return (await json(res)).draft;
}

/** A pending offer from Ali's FDM workshop on the request's current revision. */
export async function offerOn(raw: DatabaseSync, id: string, price = 20_000): Promise<{ id: string; revision: number }> {
  const res = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: price, delivery_method: 'pickup' });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const offer = (await json(res)).offer;
  return { id: String(offer.id), revision: Number(offer.revision ?? 1) };
}

/** Every row of a table, in a stable order, as JSON — the byte-identity probe. */
export function dump(raw: DatabaseSync, table: string, order = 'rowid'): string {
  return JSON.stringify(raw.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...(r as object) })));
}
