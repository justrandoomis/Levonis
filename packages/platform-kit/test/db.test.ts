import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tablesInSql, checkStatement, ownedDb, OwnershipViolation } from '../src/db';
import { inList, chunk, placeholders, selectIn } from '../src/inList';
import { memoryDb } from './_sqlite';

const manifest = { service: 'invoices', owns: ['invoices'], reads: ['orders'] };

test('tablesInSql finds read and write positions and ignores names inside string literals and comments', () => {
  assert.deepEqual(tablesInSql('SELECT i.id FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.status = ?'), { reads: ['invoices', 'orders'], writes: [] });
  assert.deepEqual(tablesInSql("INSERT INTO invoices (id, note) VALUES (?, 'FROM users')"), { reads: [], writes: ['invoices'] });
  assert.deepEqual(tablesInSql('UPDATE invoices SET paid = 1 WHERE order_id IN (SELECT id FROM orders) -- FROM wallet_transactions'), { reads: ['orders'], writes: ['invoices'] });
  assert.deepEqual(tablesInSql('DELETE FROM "invoices" WHERE id = ?'), { reads: [], writes: ['invoices'] });
  assert.deepEqual(tablesInSql('INSERT OR IGNORE INTO invoices_processed_events (event_id) VALUES (?)').writes, ['invoices_processed_events']);
});

test('checkStatement: owns may be written, reads only read, own platform tables implied, anything else is a violation', () => {
  assert.equal(checkStatement(manifest, 'SELECT * FROM invoices'), null);
  assert.equal(checkStatement(manifest, 'SELECT * FROM orders'), null);
  assert.equal(checkStatement(manifest, 'INSERT INTO invoices_outbox_events (event_id) VALUES (?)'), null);
  assert.equal(checkStatement(manifest, 'UPDATE pump_lock SET locked_until = ?'), null);
  const w = checkStatement(manifest, 'UPDATE orders SET status = ?');
  assert.ok(w instanceof OwnershipViolation);
  assert.equal(w?.access, 'write');
  assert.equal(w?.table, 'orders');
  const r = checkStatement(manifest, 'SELECT email FROM users WHERE id = ?');
  assert.equal(r?.access, 'read');
  assert.equal(checkStatement(manifest, 'INSERT INTO ledger_outbox_events (event_id) VALUES (?)')?.table, 'ledger_outbox_events', 'another service platform table is foreign');
});

test('ownedDb throws in dark and logs in the first production release, for prepare and exec alike', async () => {
  const { db, raw } = memoryDb('CREATE TABLE invoices (id TEXT PRIMARY KEY); CREATE TABLE orders (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY);');
  const strict = ownedDb(db, manifest, { mode: 'throw' });
  await strict.prepare("INSERT INTO invoices (id) VALUES ('i1')").run();
  assert.throws(() => strict.prepare('SELECT * FROM users'), OwnershipViolation);
  await assert.rejects(async () => strict.exec("INSERT INTO users (id) VALUES ('u1')"), OwnershipViolation);
  const seen: OwnershipViolation[] = [];
  const soft = ownedDb(db, manifest, { mode: 'log', onViolation: (v) => void seen.push(v) });
  const origError = console.error;
  console.error = () => {};
  try {
    await soft.prepare("INSERT INTO users (id) VALUES ('u1')").run();
  } finally {
    console.error = origError;
  }
  assert.equal(seen.length, 1);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1, 'log mode lets the statement through');
  // batch of guarded statements still works
  await strict.batch([strict.prepare("INSERT INTO invoices (id) VALUES ('i2')"), strict.prepare("INSERT INTO invoices (id) VALUES ('i3')")]);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n, 3);
});

test('inList splits at 90 and merges: 200 ids against a real SQLite table come back complete and in one list', async () => {
  const { db, raw } = memoryDb('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
  const ids = Array.from({ length: 200 }, (_, i) => `usr_${String(i).padStart(3, '0')}`);
  raw.exec('BEGIN');
  for (const id of ids) raw.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, `name ${id}`);
  raw.exec('COMMIT');
  const seenChunks: number[] = [];
  const rows = await inList(ids, async (part, marks) => {
    seenChunks.push(part.length);
    assert.equal(marks, placeholders(part.length));
    assert.ok(part.length <= 90, 'never more than 90 bound ids');
    return (await db.prepare(`SELECT id, name FROM users WHERE id IN (${marks})`).bind(...part).all<{ id: string; name: string }>()).results;
  });
  assert.equal(rows.length, 200);
  assert.deepEqual(seenChunks, [90, 90, 20]);
  assert.deepEqual(new Set(rows.map((r) => r.id)), new Set(ids));
  // duplicates are collapsed, empty input runs nothing, the D1 helper works the same
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
  assert.deepEqual(await inList([], async () => [1]), []);
  const viaHelper = await selectIn<{ id: string }>(db, (marks) => `SELECT id FROM users WHERE id IN (${marks})`, [...ids, ...ids]);
  assert.equal(viaHelper.length, 200);
  assert.throws(() => placeholders(0), RangeError);
});
