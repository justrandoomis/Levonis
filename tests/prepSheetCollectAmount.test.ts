/**
 * THE PREP SHEET'S COPYABLE FIGURE IS WHAT THE COURIER COLLECTS.
 *
 * Owner, 2026-09-25 (ORD-45279D4CAF): «يجب أن يكون 1732992 بدلا من 1783000» —
 * total 1,783,000, 50,008 paid from the wallet, 1,732,992 left at the door.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { collectOnDeliveryIqd } from '../src/components/adminOrders/collectAmount';

test('the owner’s order: the door amount, not the pre-wallet total', () => {
  assert.equal(collectOnDeliveryIqd({ due_on_delivery_iqd: 1_732_992 }, 1_783_000), 1_732_992);
});

test('fully prepaid and BNPL collect nothing at the door; no financial block falls back to the total', () => {
  assert.equal(collectOnDeliveryIqd({ due_on_delivery_iqd: 0 }, 250_000), 0);
  assert.equal(collectOnDeliveryIqd(null, 250_000), 250_000);
  assert.equal(collectOnDeliveryIqd(undefined, undefined), 0);
  assert.equal(collectOnDeliveryIqd({ due_on_delivery_iqd: -5 }, 10), 0, 'never negative');
});

test('the sheet labels it «المتبقي عند التسليم», copies it digits-only, and keeps the total beside it', () => {
  const src = readFileSync(join(ROOT, 'src/components/adminOrders/OrderDetailModal.tsx'), 'utf8');
  assert.ok(!src.includes('الإجمالي بعد كل الخصومات'), 'the old label is gone');
  assert.match(src, /label=\{loc\('المتبقي عند التسليم'[^}]*\}\s*value=\{String\(collectIqd\)\}/);
  assert.match(src, /collectOnDeliveryIqd\(fin, detail\?\.total_iqd\)/);
  assert.match(src, /\{loc\('الإجمالي', 'Total', 'کۆی گشتی'\)\}: \{formatIqd\(detail\.total_iqd\)\}/);
});

test('the sticker, receipt and Telegram card already print the door amount, not the total', () => {
  const admin = readFileSync(join(ROOT, 'worker/routes/admin.ts'), 'utf8');
  assert.match(admin, /cod_iqd: Math\.max\(0, Number\(order\.due_on_delivery_iqd\) \|\| 0\)/);
  const receipts = readFileSync(join(ROOT, 'worker/lib/receipts.ts'), 'utf8');
  assert.match(receipts, /iqd\(data\.due_on_delivery_iqd\)/);
  const topic = readFileSync(join(ROOT, 'worker/lib/adminTopicRouting.ts'), 'utf8');
  assert.match(topic, /المستحق عند التسليم: \$\{iqd\(input\.dueOnDeliveryIqd\)\}/);
});
