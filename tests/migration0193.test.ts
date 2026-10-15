/**
 * MIGRATION 0193 — «طلب السعر» (DECISIONS row 240; spec §4.1, §7.5).
 *
 * Additive only: two new tables and their indexes. Proves:
 *   - it applies on the schema before it (0191, and 0192 when that file is
 *     present), and re-applying it changes nothing;
 *   - the file never updates, deletes, drops, alters a table or adds a
 *     trigger (comments aside);
 *   - its CHECKs refuse a bad state, close reason, selection, notify flag,
 *     cycle or click count, and the stats' negative counts;
 *   - the UNIQUE (user, product, selection) index refuses a second plain
 *     INSERT — one row per person and selection is the schema's, not only the
 *     route's;
 *   - the open-rows index serves the per-selection count.
 *
 * Run: node --import tsx --test tests/migration0193.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { all, dbThrough, row } from './fixtures/app';
import { ROOT } from './fixtures/d1';

const FILE = '0193_price_requests.sql';
const SQL = readFileSync(join(ROOT, 'migrations', FILE), 'utf8');
const code = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

const before = () => {
  const has0192 = readdirSync(join(ROOT, 'migrations')).some((f) => f.startsWith('0192_'));
  return dbThrough(has0192 ? '0192' : '0191');
};

function seeded() {
  const raw = before();
  raw.exec(SQL);
  raw.exec(`
    INSERT INTO users (id, name, email, password_hash, role) VALUES ('u1', 'A', 'a@x.co', 'h', 'customer'), ('u2', 'B', 'b@x.co', 'h', 'customer');
    INSERT INTO products (id, slug, name, status, price_iqd) VALUES ('p1', 'p-1', 'P1', 'active', 0);
  `);
  return raw;
}

test('it applies on the schema before it, and re-applying it is a no-op', () => {
  const raw = before();
  assert.equal(all(raw, "SELECT name FROM sqlite_master WHERE name LIKE 'product_price_request%'").length, 0, 'not there before');
  raw.exec(SQL);
  const objects = () => all<{ type: string; name: string }>(raw, "SELECT type, name FROM sqlite_master WHERE tbl_name LIKE 'product_price_request%' ORDER BY type, name");
  const first = objects();
  assert.deepEqual(
    first.map((o) => `${o.type}:${o.name}`),
    [
      'index:idx_price_request_stats_rank',
      'index:idx_price_requests_open',
      'index:idx_price_requests_sweep',
      'index:idx_price_requests_target',
      'index:idx_price_requests_user',
      'index:sqlite_autoindex_product_price_request_stats_1',
      'index:sqlite_autoindex_product_price_requests_1',
      'table:product_price_request_stats',
      'table:product_price_requests',
    ]
  );
  raw.exec("INSERT INTO users (id, name, email, password_hash, role) VALUES ('u1', 'A', 'a@x.co', 'h', 'customer')");
  raw.exec("INSERT INTO products (id, slug, name, status, price_iqd) VALUES ('p1', 'p-1', 'P1', 'active', 0)");
  raw.exec("INSERT INTO product_price_requests (id, user_id, product_id) VALUES ('r1', 'u1', 'p1')");
  raw.exec(SQL);
  assert.deepEqual(objects(), first);
  assert.equal(all(raw, 'SELECT id FROM product_price_requests').length, 1, 'a second run keeps every row');
});

test('additive only: no UPDATE, DELETE, DROP, ALTER TABLE or CREATE TRIGGER in the file', () => {
  // Every statement is a CREATE TABLE or a CREATE INDEX (an `ON DELETE CASCADE` clause is not a DELETE).
  const statements = code.split(';').map((st) => st.trim()).filter(Boolean);
  for (const st of statements) assert.match(st, /^CREATE (?:TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS /, st.slice(0, 80));
  for (const banned of [/\bUPDATE\s+\w+\s+SET\b/i, /^\s*DELETE\s+FROM\b/im, /\bDROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/i, /\bALTER\s+TABLE\b/i, /\bCREATE\s+TRIGGER\b/i, /\bINSERT\s+INTO\b/i]) {
    assert.doesNotMatch(code, banned, String(banned));
  }
  assert.equal((code.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 2, 'two new tables');
  assert.doesNotMatch(code, /CREATE TABLE (?!IF NOT EXISTS)/, 'every create is idempotent');
  // A Wrangler migration file is split on semicolons: no apostrophe inside a comment may open a phantom string.
  assert.doesNotMatch(SQL.split('\n').filter((l) => l.trim().startsWith('--')).join('\n'), /'/);
});

test('the defaults: open, one click, cycle 1, no consent, the product itself', () => {
  const raw = seeded();
  raw.exec("INSERT INTO product_price_requests (id, user_id, product_id) VALUES ('r1', 'u1', 'p1')");
  const r = row<Record<string, unknown>>(raw, "SELECT * FROM product_price_requests WHERE id = 'r1'")!;
  assert.equal(r.selection, '');
  assert.equal(r.state, 'open');
  assert.equal(r.close_reason, '');
  assert.equal(r.notify, 0, 'the schema never assumes consent');
  assert.equal(r.cycle, 1);
  assert.equal(r.click_count, 1);
  assert.match(String(r.requested_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(r.checked_at, '');
});

test('the CHECKs refuse a bad state, reason, selection, flag, cycle or click count', () => {
  const raw = seeded();
  let n = 0;
  const refused = (cols: string, vals: string) => {
    n += 1;
    assert.throws(
      () => raw.exec(`INSERT INTO product_price_requests (id, user_id, product_id, ${cols}) VALUES ('bad${n}', 'u1', 'p1', ${vals})`),
      /CHECK constraint failed/,
      `${cols} = ${vals}`
    );
  };
  refused('state', "'pending'");
  refused('close_reason', "'expired'");
  refused('state, close_reason', "'closed', 'other'");
  refused('selection', "'x:1'");
  refused('selection', "'o:'");
  refused('selection', "'c:'");
  refused('selection', `'o:${'a'.repeat(400)}'`);
  refused('notify', '2');
  refused('cycle', '0');
  refused('click_count', '0');
  for (const col of ['requesters', 'selections', 'clicks', 'digest_requesters']) {
    assert.throws(() => raw.exec(`INSERT INTO product_price_request_stats (product_id, ${col}) VALUES ('p1', -1)`), /CHECK constraint failed/, col);
  }
  // What the route writes passes.
  raw.exec(`INSERT INTO product_price_requests (id, user_id, product_id, selection, notify) VALUES
    ('ok1', 'u1', 'p1', 'o:v1|c:c1', 1), ('ok2', 'u1', 'p1', 'c:c1', 0), ('ok3', 'u2', 'p1', 'o:v1', 0)`);
  raw.exec("UPDATE product_price_requests SET state = 'closed', close_reason = 'withdrawn' WHERE id = 'ok1'");
  raw.exec("UPDATE product_price_requests SET state = 'notified' WHERE id = 'ok2'");
  raw.exec("UPDATE product_price_requests SET state = 'priced' WHERE id = 'ok3'");
});

test('one row per person, product and selection: a plain second INSERT is refused; the route’s upsert is the only way', () => {
  const raw = seeded();
  raw.exec("INSERT INTO product_price_requests (id, user_id, product_id, selection) VALUES ('r1', 'u1', 'p1', 'c:c1')");
  assert.throws(() => raw.exec("INSERT INTO product_price_requests (id, user_id, product_id, selection) VALUES ('r2', 'u1', 'p1', 'c:c1')"), /UNIQUE constraint failed/);
  // Another selection, another person: allowed.
  raw.exec("INSERT INTO product_price_requests (id, user_id, product_id, selection) VALUES ('r3', 'u1', 'p1', ''), ('r4', 'u2', 'p1', 'c:c1')");
  raw.exec(`INSERT INTO product_price_requests (id, user_id, product_id, selection) VALUES ('r5', 'u1', 'p1', 'c:c1')
            ON CONFLICT(user_id, product_id, selection) DO UPDATE SET click_count = click_count + 1`);
  assert.equal(row<{ click_count: number }>(raw, "SELECT click_count FROM product_price_requests WHERE id = 'r1'")!.click_count, 2);
  // The per-selection count uses the open-rows index.
  const plan = all<{ detail: string }>(
    raw,
    "EXPLAIN QUERY PLAN SELECT selection, COUNT(*) FROM product_price_requests WHERE product_id = 'p1' AND state = 'open' GROUP BY selection"
  );
  assert.ok(plan.some((p) => /idx_price_requests_open/.test(p.detail)), JSON.stringify(plan));
});
