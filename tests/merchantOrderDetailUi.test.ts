/**
 * THE ORDER SCREEN, THE CUSTOMERS SCREEN AND THE PROMPT DIALOG (W3-B) — the
 * pure parts and the source rules:
 *
 *   - every timeline event kind the server sends has words, and an expected
 *     release never reads as done;
 *   - the order and customer addresses are real workspace routes (a customer
 *     by an ORDER id, never a user id), and each screen is its own lazy chunk;
 *   - the prompt dialog refuses an empty required answer and a bad number in
 *     place, and trims;
 *   - the community admin has no native prompt left.
 *
 * Run: node --import tsx --test tests/merchantOrderDetailUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventText, actorText } from '../src/components/merchant/orders/timelineText';
import type { TimelineEvent } from '../src/components/merchant/orders/api';
import { ORDER_FLOW, orderStatusLabel } from '../src/components/merchant/orders/labels';
import { checkPromptValue } from '../src/components/ui/PromptDialog';
import { searchTerm } from '../src/components/merchant/customers/api';
import { merchantHref, parseMerchantPath } from '../packages/contracts/src/merchantRoutes';
import { resolveWorkspaceRoute } from '../src/components/merchant/shell/routeTable';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const en = (_ar: string, e: string) => e;
const ar = (a: string) => a;
const money = (v: number) => `${v} IQD`;

const ALL: TimelineEvent[] = [
  { kind: 'placed', at: 't', actor: 'customer', total_iqd: 23000 },
  { kind: 'status', at: 't', status: 'shipped', stage: 'shipped', actor: 'store' },
  { kind: 'cancelled', at: 't', actor: 'levonis' },
  { kind: 'refunded', at: 't', actor: 'system' },
  { kind: 'receipt_confirmed', at: 't', actor: 'customer' },
  { kind: 'credit_recorded', at: 't', bucket: 'pending', lines: [{ kind: 'sale_gross', amount_iqd: 20000 }, { kind: 'commission', amount_iqd: -1000 }] },
  { kind: 'credit_reversed', at: 't', bucket: 'pending', lines: [{ kind: 'refund', amount_iqd: -20000 }, { kind: 'commission_refund', amount_iqd: 1000 }] },
  { kind: 'credit_released', at: 't', amount_iqd: 19000, actor: 'system' },
  { kind: 'ledger_adjustment', at: 't', amount_iqd: -500, bucket: 'available' },
  { kind: 'dispute_opened', at: 't', source: 'complaint' },
  { kind: 'dispute_closed', at: 't', source: 'ticket' },
  { kind: 'chat_started', at: 't' },
  { kind: 'release_due', at: 't', expected: true, frozen: false },
  { kind: 'release_due', at: 't', expected: true, frozen: true },
];

test('every event kind has words in both languages; the money is the sum of its lines', () => {
  for (const e of ALL) {
    for (const loc of [en, ar]) {
      const t = eventText(e, loc, money);
      assert.ok(t.title && !/undefined|NaN|\[object/.test(`${t.title} ${t.detail ?? ''}`), `${e.kind}: ${t.title}`);
    }
  }
  assert.equal(eventText(ALL[5], en, money).title, '19000 IQD recorded for you — pending');
  assert.equal(eventText(ALL[6], en, money).title, '19000 IQD reversed from your balance');
  assert.equal(eventText(ALL[1], en, money).detail, 'You');
  assert.equal(eventText(ALL[7], en, money).detail, 'Automatically, 3 days after delivery');
});

test('an expected release is worded as a future, and a frozen one says why', () => {
  assert.match(eventText(ALL[12], en, money).title, /becomes available automatically/);
  assert.match(eventText(ALL[13], en, money).title, /on hold/);
  assert.equal(actorText('courier', en), 'The courier');
});

test('the order flow and its words mirror the server\'s', () => {
  const server = read('worker/routes/merchant.ts');
  for (const [from, to] of Object.entries(ORDER_FLOW)) {
    assert.match(server, new RegExp(`${from}: \\[${to.map((s) => `'${s}'`).join(', ')}\\]`), `${from} differs from MERCHANT_ORDER_FLOW`);
    assert.notEqual(orderStatusLabel(from, en), from);
  }
});

test('addresses: an order and a customer are real workspace routes; a customer is keyed by an order id', () => {
  assert.equal(merchantHref.customer('ORD-1'), '/merchant/customers/ORD-1');
  assert.deepEqual(parseMerchantPath('/merchant/customers/ORD-1'), { section: 'customers', id: 'ORD-1' });
  assert.deepEqual(resolveWorkspaceRoute('/admin/customers/ORD-1', '/admin'), { kind: 'section', section: 'customers', id: 'ORD-1' });
  assert.deepEqual(resolveWorkspaceRoute('/merchant/orders/ORD-1', '/merchant'), { kind: 'section', section: 'orders', id: 'ORD-1' });
  assert.equal(merchantHref.customer('../x'), '/merchant/customers', 'a key outside the shape opens the list');
});

test('each screen is its own lazy chunk; the list links to the order screen', () => {
  const sections = read('src/components/merchant/shell/sections.tsx');
  assert.match(sections, /orders: lazy\(\(\) => import\('\.\/sections\/OrdersSection'\)\)/);
  const orders = read('src/components/merchant/shell/sections/OrdersSection.tsx');
  assert.match(orders, /lazy\(\(\) => import\('\.\.\/\.\.\/orders\/OrderDetailScreen'\)\)/);
  assert.match(orders, /lazy\(\(\) => import\('\.\.\/\.\.\/dashboard\/SalesTabs'\)/);
  assert.match(read('src/components/merchant/dashboard/SalesTabs.tsx'), /data-open-order/);
  const detail = read('src/components/merchant/orders/OrderDetailScreen.tsx');
  assert.match(detail, /useConfirm\(\)/, 'status moves ask first');
  assert.doesNotMatch(detail, /\.message\b|window\.(confirm|alert|prompt)/);
  assert.match(detail, /import '\.\/orderPrint\.css'/, 'the print styles load with the screen, nowhere else');
});

test('customers search: empty (all) or 2–60 characters', () => {
  assert.equal(searchTerm('  '), '');
  assert.equal(searchTerm('a'), null);
  assert.equal(searchTerm(' سارة '), 'سارة');
  assert.equal(searchTerm('x'.repeat(61)), null);
});

test('the prompt dialog: trims, refuses an empty required answer and a validator\'s «no» in place', () => {
  assert.deepEqual(checkPromptValue('  reason  ', { required: true }, 'required'), { ok: true, value: 'reason' });
  assert.deepEqual(checkPromptValue('   ', { required: true }, 'required'), { ok: false, error: 'required' });
  assert.deepEqual(checkPromptValue('', {}, 'required'), { ok: true, value: '' }, 'an optional note may be empty');
  const points = (v: string) => (/^[-+]?\d{1,6}$/.test(v) && Number(v) !== 0 ? null : 'whole number');
  assert.deepEqual(checkPromptValue('0', { validate: points }, 'r'), { ok: false, error: 'whole number' });
  assert.deepEqual(checkPromptValue(' -5 ', { validate: points }, 'r'), { ok: true, value: '-5' });
});

test('the community admin asks in the panel\'s own dialog: seven prompts, none native', () => {
  const src = read('src/components/adminCommunity/AdminCommunity.tsx');
  assert.doesNotMatch(src, /window\.prompt|[^.\w]prompt\(\s*t\(/);
  assert.equal((src.match(/await prompt\(\{/g) ?? []).length, 7);
  assert.equal((src.match(/\{promptDialog\}/g) ?? []).length, 3, 'each asking component renders its dialog once');
});
