import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditStatements, audit, auditDetailsSchemaSql, pruneAuditDetailsStatement } from '../src/audit';
import { outboxSchemaSql, OutboxProbe } from '../src/outbox';
import { memoryDb, count, row } from './_sqlite';

const LEGACY = 'CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime()));';
const clock = { now: () => Date.UTC(2026, 8, 7, 10, 0, 0) };

test('bus off: the facade writes exactly today audit_log row and nothing else', async () => {
  const { db, raw } = memoryDb(LEGACY);
  const ctx = { enabled: 'off', prefix: 'core', source: 'core', correlationId: 'cid', legacyAuditLog: true, probe: new OutboxProbe(), clock };
  const { statements, eventId } = await auditStatements(db, ctx, 'usr_admin', 'wallet.credit', 'usr_01', { amount: 10000 });
  assert.equal(statements.length, 1);
  assert.equal(eventId, null);
  await audit(db, ctx, 'usr_admin', 'wallet.credit', 'usr_01', { amount: 10000 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_log'), 1);
  assert.equal(row(raw, 'SELECT detail FROM audit_log')!.detail, '{"amount":10000}');
});

test('bus on: dual-write — audit_log + AuditRecorded outbox row + the detail body in <svc>_audit_details, all in one batch', async () => {
  const { db, raw } = memoryDb(LEGACY + outboxSchemaSql('core') + auditDetailsSchemaSql('core'));
  const ctx = { enabled: 'on', prefix: 'core', source: 'core', correlationId: 'cid', legacyAuditLog: true, probe: new OutboxProbe(), clock };
  const { statements, eventId } = await auditStatements(db, ctx, 'usr_admin', 'wallet.credit', 'usr_01', { amount: 10000, token: 'never-in-the-envelope' });
  assert.equal(statements.length, 3);
  assert.ok(eventId);
  await db.batch(statements);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_log'), 1);
  const out = row<{ event_type: string; envelope: string }>(raw, 'SELECT event_type, envelope FROM core_outbox_events')!;
  assert.equal(out.event_type, 'AuditRecorded');
  const env = JSON.parse(out.envelope) as { pii_class: string; payload: Record<string, unknown> };
  assert.equal(env.pii_class, 'personal');
  assert.equal(env.payload.detail_ref, eventId);
  assert.ok(!JSON.stringify(env).includes('never-in-the-envelope'), 'the detail body does not travel in the envelope');
  assert.equal(row(raw, 'SELECT detail FROM core_audit_details')!.detail, '{"amount":10000,"token":"never-in-the-envelope"}');
  // pruning drops only acked (dispatched) details older than the cutoff
  await pruneAuditDetailsStatement(db, 'core', '2999-01-01T00:00:00.000Z').run();
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_audit_details'), 1, 'not dispatched yet');
  raw.prepare("UPDATE core_outbox_events SET dispatched_at = '2026-09-07T10:01:00.000Z'").run();
  await pruneAuditDetailsStatement(db, 'core', '2999-01-01T00:00:00.000Z').run();
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_audit_details'), 0);
});

test('a service without the legacy table writes only the outbox pair; a failing standalone audit() never throws', async () => {
  const { db, raw } = memoryDb(outboxSchemaSql('invoices') + auditDetailsSchemaSql('invoices'));
  const ctx = { enabled: 'on', prefix: 'invoices', source: 'invoices', correlationId: 'cid', probe: new OutboxProbe(), clock };
  const { statements } = await auditStatements(db, ctx, null, 'invoice.issued', 'inv_1');
  assert.equal(statements.length, 2);
  const broken = memoryDb('').db;
  const orig = console.error;
  console.error = () => {};
  try {
    await audit(broken, { ...ctx, legacyAuditLog: true, probe: new OutboxProbe() }, null, 'x', 'y');
  } finally {
    console.error = orig;
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM invoices_outbox_events'), 0);
});
