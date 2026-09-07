/**
 * The boundaries lint (`01-TARGET.md` §2.3 item 2, `02-MIGRATION-PLAN.md` §11).
 *
 * For every `services/<name>/src` file: the tables its SQL literals name are in
 * the service's OWNERSHIP.json (`owns` written, `reads` read, its own platform
 * tables implied); it imports nothing from `worker/` or another service (the
 * one exception is a sibling package's `statements.ts` inside one
 * deployable, ADR-004); never `worker/lib/{ratelimit,audit,session}`; no bare
 * `fetch(`; no `eventKey` built from request input. The core's remaining
 * foreign writes are enumerated in `worker/OWNERSHIP.tolerance.json` and may
 * only shrink: every entry must exist in the reviewed snapshot and name a
 * writer symbol that still exists.
 *
 * The scanner itself is exercised against inline samples first, so a green run
 * over zero services is a proof of the rules, not of an empty loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSource, listServices, readManifest, tsFiles, importSpecifiers, sqlLiterals, writerExists, type ToleranceEntry } from './lib/boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = { service: 'invoices', owns: ['invoices'], reads: ['orders'], calls: ['NOTIFICATIONS.send', 'AUDIT.deliver'] };
const ctx = (file = 'services/invoices/src/http/public.ts') => ({ root: ROOT, service: 'invoices', file: join(ROOT, file), manifest });

test('the scanner accepts a clean service file', () => {
  const src = `
    import { Hono } from 'hono';
    import { ownedDb } from '@levonis/platform-kit/db';
    import { fetchWithBudget } from '@levonis/platform-kit/httpx';
    import type { InvoiceIssuedV1 } from '@levonis/contracts/events/v1/InvoiceIssued';
    import { invoiceStatements } from '../statements';
    export async function list(db: D1Database, orderId: string) {
      const rows = await db.prepare('SELECT i.id, i.total_iqd FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.id = ?').bind(orderId).all();
      await db.prepare(\`INSERT INTO \${'invoices'} (id) VALUES (?)\`).bind('x').run();
      await db.prepare('INSERT INTO invoices_outbox_events (event_id) VALUES (?)').bind('e').run();
      const eventKey = \`invoices:invoice:\${rows.results[0].id}:issue\`;
      await fetchWithBudget('https://api.resend.com', {}, { timeoutMs: 8000 });
      return { rows, eventKey };
    }`;
  assert.deepEqual(checkSource(ctx(), src), []);
});

test('the scanner catches every rule: foreign SQL, core/service imports, the three core libs, bare fetch, eventKey from request input', () => {
  const src = `
    import { rateLimit } from '../../../../worker/lib/ratelimit';
    import { audit } from 'worker/lib/audit';
    import { something } from '../../../commerce/src/orders/index';
    import { sibling } from '../admin/internal';
    export async function bad(db: D1Database, c: { req: { header(n: string): string } }, body: { key: string }) {
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('paid', 'o').run();
      await db.prepare('SELECT email FROM users WHERE id = ?').bind('u').first();
      await db.prepare('INSERT INTO ledger_outbox_events (event_id) VALUES (?)').bind('e').run();
      const res = await fetch('https://example.com');
      const eventKey = 'inv:' + c.req.header('Idempotency-Key');
      const eventKey2 = body.key;
      return { res, eventKey, eventKey2 };
    }`;
  const v = checkSource(ctx('services/invoices/src/http/admin.ts'), src);
  const expect = (re: RegExp) => assert.ok(v.some((x) => re.test(x)), `expected a violation matching ${re}\n${v.join('\n')}`);
  expect(/writes table "orders"/);
  expect(/reads table "users"/);
  expect(/writes table "ledger_outbox_events"/);
  expect(/imports a core lib \(.*worker\/lib\/ratelimit\)/);
  expect(/imports the core \(.*worker\/lib\/ratelimit\)/);
  expect(/imports the core or another service \(worker\/lib\/audit\)/);
  expect(/imports another service \(.*commerce/);
  expect(/sibling package's internals/);
  expect(/bare fetch\(/);
  expect(/eventKey from request input/);
  assert.equal(v.filter((x) => /eventKey/.test(x)).length, 1, 'the request-input rule matches the statement, not every eventKey mention');
});

test('the one allowed cross-package import is a sibling statements.ts inside the same deployable; SQL inside a string value is not a reference', () => {
  const ok = checkSource(ctx('services/invoices/src/http/admin.ts'), "import { s } from '../ledger/statements';\nconst note = 'FROM users';");
  assert.deepEqual(ok, []);
  assert.deepEqual(importSpecifiers("import a from './a';\nexport { b } from \"../b\";\nconst c = await import('./c');\nimport './side';"), ['./a', '../b', './c', './side']);
  assert.deepEqual(sqlLiterals('const x = `SELECT 1 FROM ${table} WHERE id = ${id}`; const y = "plain text";'), ['SELECT 1 FROM  ?  WHERE id =  ? ']);
});

test('every service under services/ has an ownership manifest and every src file passes the scanner', () => {
  const services = listServices(ROOT);
  for (const svc of services) {
    const dir = join(ROOT, 'services', svc);
    const m = readManifest(dir);
    assert.ok(m, `services/${svc}: OWNERSHIP.json is missing (owns, reads, calls, publishes, consumes, secrets, legacyRoutes)`);
    const violations: string[] = [];
    for (const file of tsFiles(join(dir, 'src'))) violations.push(...checkSource({ root: ROOT, service: svc, file, manifest: m! }, readFileSync(file, 'utf8')));
    assert.deepEqual(violations, [], `services/${svc} violates the boundaries:\n${violations.join('\n')}`);
  }
});

test('the core tolerance list only shrinks: every entry is in the reviewed snapshot and names a writer that still exists', () => {
  const tolerancePath = join(ROOT, 'worker', 'OWNERSHIP.tolerance.json');
  const snapshotPath = join(ROOT, 'tests', 'fixtures', 'tolerance.snapshot.json');
  assert.ok(existsSync(tolerancePath) && existsSync(snapshotPath));
  const tolerance = JSON.parse(readFileSync(tolerancePath, 'utf8')) as { entries: ToleranceEntry[] };
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { entries: Array<{ table: string; writer: string }> };
  assert.ok(Array.isArray(tolerance.entries) && tolerance.entries.length > 0);
  const seen = new Set<string>();
  for (const e of tolerance.entries) {
    const key = `${e.table} <- ${e.writer}`;
    assert.ok(!seen.has(key), `duplicate tolerance entry ${key}`);
    seen.add(key);
    assert.ok(snapshot.entries.some((s) => s.table === e.table && s.writer === e.writer), `new tolerance entry ${key} — a foreign write in the core needs a reviewed snapshot change, not a silent addition`);
    assert.match(e.removed_in, /^\d+(\.\d+|[a-z](-i+)?)?$|^0\.\d$/, `${key}: removed_in names the plan slice`);
    assert.ok(e.reason.length > 10, `${key}: reason`);
    const w = writerExists(ROOT, e);
    assert.ok(w.ok, `${key}: ${w.why} — re-key the entry on the symbol that replaced it`);
  }
  // the snapshot never lists an entry the live file dropped (a removed write is a snapshot shrink, in the same commit)
  for (const s of snapshot.entries) {
    assert.ok(tolerance.entries.some((e) => e.table === s.table && e.writer === s.writer), `snapshot entry ${s.table} <- ${s.writer} is no longer tolerated: shrink the snapshot too`);
  }
});
