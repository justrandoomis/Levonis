/**
 * ACCEPTANCE TEST 45: A MODEL CAN NEVER ACT FOR A CUSTOMER (push B plan §16
 * #10; invariant I5).
 *
 *   - `ROUTABLE_INTENTS` holds no write: no `cancel_order`, no `open_ticket`,
 *     nothing that orders, pays, books or changes an account;
 *   - a SQL spy proves that every routable handler, reached through a model's
 *     reading, and every read route issue no INSERT, UPDATE or DELETE outside
 *     the ledger (`ai_spend_day`, `ai_usage`, `ai_provider_health`) and the
 *     rate limiter (`rate_limits`);
 *   - a ticket still needs the customer's own POST with `confirm`.
 *
 * Run: node --import tsx --test tests/aiNoActions.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { aiHarness, FULL, photoReading, provide, providerCalls, resetProvider, seedShop, textReading, tinyJpeg } from './fixtures/aiRoutes';
import { answer } from './fixtures/aiLayer';
import { asD1, freshDb } from './fixtures/app';
import { ROUTABLE_INTENTS } from '../worker/lib/assist/ai/adapter';
import { ensurePolicyCorpus, resetPolicyCorpusMemo } from '../worker/lib/policySync';

afterEach(() => resetProvider());

const ALLOWED_WRITES = new Set(['ai_spend_day', 'ai_usage', 'ai_provider_health', 'rate_limits']);

/** The tables the statements write, by name. */
function writtenTables(statements: readonly string[]): string[] {
  const out = new Set<string>();
  for (const sql of statements) {
    const m = /^\s*(?:WITH\b[\s\S]*?\)\s*)?(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+["`]?(\w+)/i.exec(sql);
    if (m) out.add(m[2]!.toLowerCase());
  }
  return [...out].sort();
}

test('no write intent is routable', () => {
  for (const write of ['cancel_order', 'open_ticket', 'product_search', 'compare_products', 'printer_problem', 'price_question', 'stock_question']) {
    assert.ok(!(ROUTABLE_INTENTS as readonly string[]).includes(write), `${write} is routable`);
  }
  // Exactly the plan's read-only list (§6.1): a new entry is a decision, made here on purpose.
  assert.deepEqual([...ROUTABLE_INTENTS].sort(), [
    'account_help', 'bot_identity', 'choose_printer', 'contact_info', 'delivery_estimate', 'greeting', 'human_handoff', 'materials_help',
    'membership_status', 'my_devices', 'offers_help', 'order_status', 'password_help', 'payment_methods', 'points_balance', 'policy_question',
    'power_usage', 'return_help', 'shipping_cost', 'studio_help', 'thanks', 'wallet_help', 'warranty_status',
  ]);
});

test('every routable handler, reached through a reading, writes nothing but the ledger and the limiter', async () => {
  const raw = freshDb();
  await seedShop(raw);
  // The policy archive mirror is the legacy handler's own idempotent sync: done before the spy, as on a live isolate.
  resetPolicyCorpusMemo();
  await ensurePolicyCorpus(asD1(raw));
  const text = 'شي غريب يصير ما ادري شنو';
  for (const who of ['owner', '']) {
    // What push A itself writes for this text with the layer off: the limiter, and for a signed-in
    // viewer the lazy refresh of their OWN membership tier the pricing context runs on any free text.
    const basic = aiHarness({ ...FULL, enabled: false, raw, spy: true });
    assert.equal((await basic.assistant(who, { text })).reply.intent, 'clarify');
    const pushA = new Set(writtenTables(basic.statements));
    raw.exec('DELETE FROM rate_limits');
    for (const intent of ROUTABLE_INTENTS) {
      const h = aiHarness({ ...FULL, raw, spy: true });
      provide(() => answer(textReading({ action: 'intent', intent })));
      const reply = (await h.assistant(who, { text })).reply;
      assert.equal(providerCalls(), 1, intent);
      assert.equal(reply.mode, 'ai', `${intent}: ${JSON.stringify(reply).slice(0, 160)}`);
      const writes = writtenTables(h.statements).filter((t) => !ALLOWED_WRITES.has(t) && !pushA.has(t));
      assert.deepEqual(writes, [], `${intent} (${who || 'guest'}) wrote ${writes.join(', ')}`);
      raw.exec('DELETE FROM rate_limits');
    }
    // And push A's own writes are the viewer's own rows only: never an order, a ticket, a wallet or a cart.
    for (const t of pushA) assert.ok(ALLOWED_WRITES.has(t) || t === 'memberships' || t === 'users', `push A wrote ${t}`);
  }
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM support_tickets').get() as { n: number }).n), 0, 'no ticket was opened');
});

test('the read routes write nothing but the ledger and the limiter, and put nothing to R2', async () => {
  const h = aiHarness({ ...FULL, spy: true });
  provide(() => answer(photoReading({ hms_codes: ['0300-0100-0001-0003'], symptom: 'clog' })));
  const photo = h.seedFile('owner', 'attachments', new Uint8Array([1, 2, 3]), 'image/webp');
  const clip = h.seedFile('owner', 'video', new Uint8Array([1, 2, 3]), 'video/mp4');
  const voice = h.seedFile('owner', 'audio', new Uint8Array([1, 2, 3]), 'audio/webm');
  h.statements.length = 0;
  assert.equal((await h.read('owner', { kind: 'photo', key: photo })).status, 200);
  assert.equal((await h.readFrames('owner', { key: clip, consent: '1', f0: tinyJpeg(), f1: tinyJpeg() })).status, 200);
  assert.equal((await h.read('owner', { kind: 'voice', key: voice, locale: 'en' })).status, 200);
  assert.equal((await h.readiness('owner')).status, 200);
  assert.deepEqual(writtenTables(h.statements).filter((t) => !ALLOWED_WRITES.has(t)), []);
  assert.ok(writtenTables(h.statements).includes('ai_usage'), 'the ledger did record the calls');
  assert.equal(h.privateBucket.puts + h.publicBucket.puts, 0);
});

test('«تحدث مع الفريق» through a reading opens no ticket: the customer’s own confirmed POST does', async () => {
  const h = aiHarness(FULL);
  provide(() => answer(textReading({ action: 'intent', intent: 'human_handoff' })));
  const reply = (await h.assistant('owner', { text: 'شي غريب يصير ما ادري شنو' })).reply;
  assert.equal(reply.handoff, true);
  assert.equal(Number((h.raw.prepare('SELECT COUNT(*) AS n FROM support_tickets').get() as { n: number }).n), 0);
  const unconfirmed = await h.postJson('owner', '/api/support/tickets', { subject: 'Nozzle', body: 'Clogged nozzle, nothing comes out.' });
  assert.equal(unconfirmed.status, 400, 'no confirm, no ticket');
  assert.equal(Number((h.raw.prepare('SELECT COUNT(*) AS n FROM support_tickets').get() as { n: number }).n), 0);
});
