/**
 * Request attachments over the real routes.
 *
 * `attachments.test.ts` proves the classifier cannot be fooled by a file.
 * This proves the ROUTES cannot be fooled by a caller: uploading to someone
 * else's request, reading a file you have no relationship to, changing the
 * attachments a merchant already quoted against, and — the one that matters
 * most — learning the R2 key from any response.
 *
 * Real SQLite through the D1 adapter, plus an in-memory stand-in for R2 so
 * the row/object pairing is actually observable: a test can assert that a
 * failed insert left no orphan and that a delete removed both halves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { marketplaceRoutes } from '../worker/routes/marketplace';

// ---------------------------------------------------------------- harness

/** Just enough R2 to observe what the routes put, get and delete. */
class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value);
  }

  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) return null;
    return { body: new Blob([v as unknown as BlobPart]).stream(), httpEtag: `"${key}"` };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

type Session = { id: string; role?: string } | null;

function app(db: D1Database, bucket: MemoryBucket, session: Session) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (session) c.set('user', { role: 'customer', ...session } as never);
    c.env = { DB: db, BUCKET: bucket } as never;
    await next();
  });
  a.route('/api/marketplace', marketplaceRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  });
  return a;
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('buyer','Sara','s@x.co','h'), ('owner','Ali','a@x.co','h'),
      ('stranger','Nour','n@x.co','h'), ('boss','Admin','ad@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name)
      VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO community_requests (id,customer_id,title,description,state,visibility)
      VALUES ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','public');
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database, bucket: new MemoryBucket() };
}

const PNG = (() => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
})();

function upload(
  a: ReturnType<typeof app>,
  requestId: string,
  bytes: Uint8Array = PNG,
  name = 'photo.png'
) {
  const form = new FormData();
  form.append('file', new File([bytes as unknown as BlobPart], name));
  return a.request(`/api/marketplace/requests/${requestId}/files`, { method: 'POST', body: form });
}

const json = async (r: Response) => (await r.json()) as Record<string, never>;

// -------------------------------------------------------------- uploading

test('the customer can attach a file, and it lands as a row AND an object', async () => {
  const { db, bucket, raw } = setup();
  const res = await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  assert.equal(res.status, 201);

  const rows = raw.prepare('SELECT * FROM community_request_files WHERE request_id = ?').all('r1') as
    Array<Record<string, string | number>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content_type, 'image/png');
  assert.equal(rows[0].kind, 'reference');
  assert.equal(rows[0].size_bytes, PNG.byteLength);

  // The row points at an object that is really there.
  assert.equal(bucket.objects.size, 1);
  assert.ok(bucket.objects.has(String(rows[0].file_key)));
});

test('the storage key is outside every public prefix', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const key = String(
    (raw.prepare('SELECT file_key FROM community_request_files').get() as { file_key: string }).file_key
  );
  // `/files/*` serves products/, avatars/ and community/ publicly. An
  // attachment must not be reachable that way at all.
  assert.ok(key.startsWith('requests/buyer/'), key);
  for (const publicPrefix of ['products/', 'avatars/', 'community/']) {
    assert.ok(!key.startsWith(publicPrefix), key);
  }
});

test('THE KEY IS NEVER IN A RESPONSE — not on upload, not on read', async () => {
  const { db, bucket, raw } = setup();
  const a = app(db, bucket, { id: 'buyer' });
  const created = await json(await upload(a, 'r1'));
  const key = String(
    (raw.prepare('SELECT file_key FROM community_request_files').get() as { file_key: string }).file_key
  );

  assert.ok(!JSON.stringify(created).includes(key));

  const detail = await json(await a.request('/api/marketplace/requests/r1'));
  const body = JSON.stringify(detail);
  assert.ok(!body.includes(key));
  assert.ok(!body.includes('file_key'));
  // What it gets instead is a route that re-checks the caller every time.
  assert.ok(body.includes('/api/marketplace/requests/r1/files/'));
});

test('a stranger cannot attach a file to someone else\'s request', async () => {
  const { db, bucket } = setup();
  const res = await upload(app(db, bucket, { id: 'stranger' }), 'r1');
  assert.equal(res.status, 404);
  assert.equal(bucket.objects.size, 0);
});

test('an anonymous caller cannot attach anything', async () => {
  const { db, bucket } = setup();
  const res = await upload(app(db, bucket, null), 'r1');
  assert.equal(res.status, 401);
});

test('a file that is not what it claims is refused, and nothing is stored', async () => {
  const { db, bucket, raw } = setup();
  const exe = new Uint8Array(64);
  exe.set([0x4d, 0x5a, 0x90, 0x00], 0);          // MZ, renamed to .stl
  const res = await upload(app(db, bucket, { id: 'buyer' }), 'r1', exe, 'model.stl');
  assert.equal(res.status, 400);
  assert.equal(bucket.objects.size, 0);
  assert.equal(
    Number((raw.prepare('SELECT COUNT(*) AS n FROM community_request_files').get() as { n: number }).n),
    0
  );
});

test('attachments stop changing once the request stops taking offers', async () => {
  const { db, bucket, raw } = setup();
  raw.exec("UPDATE community_requests SET state = 'in_progress' WHERE id = 'r1'");
  // A merchant priced against these files. Adding one now would change the
  // job under a contract that has already been signed.
  const res = await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  assert.equal(res.status, 409);
  assert.equal(bucket.objects.size, 0);
});

test('a request is capped at six attachments', async () => {
  const { db, bucket } = setup();
  const a = app(db, bucket, { id: 'buyer' });
  for (let i = 0; i < 6; i += 1) {
    assert.equal((await upload(a, 'r1')).status, 201);
  }
  assert.equal((await upload(a, 'r1')).status, 400);
  assert.equal(bucket.objects.size, 6);
});

// ------------------------------------------------------------ downloading

async function uploadedFileId(raw: DatabaseSync): Promise<string> {
  return String((raw.prepare('SELECT id FROM community_request_files').get() as { id: string }).id);
}

test('the customer can read their own attachment', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);

  const res = await app(db, bucket, { id: 'buyer' })
    .request(`/api/marketplace/requests/r1/files/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  // Sandboxed even for a picture: a file that somehow passed classification
  // still cannot be run as script.
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
});

test('any signed-in merchant may read a public, open request — they have to quote it', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);

  const res = await app(db, bucket, { id: 'owner' })
    .request(`/api/marketplace/requests/r1/files/${id}`);
  assert.equal(res.status, 200);
});

test('when the request closes, the general permission closes with it', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);
  raw.exec("UPDATE community_requests SET state = 'in_progress' WHERE id = 'r1'");

  // A merchant who never engaged loses access; the customer keeps it.
  assert.equal(
    (await app(db, bucket, { id: 'stranger' }).request(`/api/marketplace/requests/r1/files/${id}`)).status,
    404
  );
  assert.equal(
    (await app(db, bucket, { id: 'buyer' }).request(`/api/marketplace/requests/r1/files/${id}`)).status,
    200
  );
});

test('the ENGAGED merchant keeps access after the request closes', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);
  raw.exec(`
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state)
      VALUES ('o1','r1','m1','s1',50000,'accepted');
    UPDATE community_requests SET state = 'in_progress' WHERE id = 'r1';
  `);

  const res = await app(db, bucket, { id: 'owner' })
    .request(`/api/marketplace/requests/r1/files/${id}`);
  assert.equal(res.status, 200);
});

test('a private request is not readable by an uninvolved merchant even while open', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);
  raw.exec("UPDATE community_requests SET visibility = 'private' WHERE id = 'r1'");

  assert.equal(
    (await app(db, bucket, { id: 'owner' }).request(`/api/marketplace/requests/r1/files/${id}`)).status,
    404
  );
});

test('an admin can read an attachment, so a reported request can be moderated', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);
  raw.exec("UPDATE community_requests SET visibility = 'private', state = 'in_progress' WHERE id = 'r1'");

  const res = await app(db, bucket, { id: 'boss', role: 'admin' })
    .request(`/api/marketplace/requests/r1/files/${id}`);
  assert.equal(res.status, 200);
});

test('a file id from another request is not readable through this request', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);
  raw.exec(
    `INSERT INTO community_requests (id,customer_id,title,description,state,visibility)
     VALUES ('r2','buyer','Other','Another job','receiving_offers','public')`
  );

  const res = await app(db, bucket, { id: 'buyer' })
    .request(`/api/marketplace/requests/r2/files/${id}`);
  assert.equal(res.status, 404);
});

// -------------------------------------------------------------- deleting

test('deleting removes the row and the object together', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);

  const res = await app(db, bucket, { id: 'buyer' })
    .request(`/api/marketplace/requests/r1/files/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);

  assert.equal(
    Number((raw.prepare('SELECT COUNT(*) AS n FROM community_request_files').get() as { n: number }).n),
    0
  );
  assert.equal(bucket.objects.size, 0);
});

test('a stranger cannot delete an attachment', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);

  const res = await app(db, bucket, { id: 'stranger' })
    .request(`/api/marketplace/requests/r1/files/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 404);
  assert.equal(bucket.objects.size, 1);
});

test('an attachment cannot be removed after a merchant quoted against it', async () => {
  const { db, bucket, raw } = setup();
  await upload(app(db, bucket, { id: 'buyer' }), 'r1');
  const id = await uploadedFileId(raw);
  raw.exec("UPDATE community_requests SET state = 'in_progress' WHERE id = 'r1'");

  const res = await app(db, bucket, { id: 'buyer' })
    .request(`/api/marketplace/requests/r1/files/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.equal(bucket.objects.size, 1);
});
