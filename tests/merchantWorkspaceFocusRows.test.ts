/**
 * A NOTIFICATION'S LINK OPENS THE ROW IT NAMES (review of the live merchant
 * platform, F10).
 *
 * Every custom-order notification links to `/merchant/…/custom_orders/<id>`
 * and a coupon's to `/merchant/coupons/<id>` (merchantHref). The shell parsed
 * the id and then dropped it: CustomOrdersTab and CouponsTab were mounted
 * without it, so the merchant landed on the list and had to find the row
 * themselves. The id now reaches both tabs (like OrdersTab's `focusOrderId`),
 * which scroll to, focus and ring that row. Plus the notification kinds the
 * review added (F4, F11) have their icons, and the two that ask for action
 * are drawn in the warning tone.
 *
 * Run: node --import tsx --test tests/merchantWorkspaceFocusRows.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { merchantHref } from '../packages/contracts/src/merchantRoutes';
import { resolveWorkspaceRoute } from '../src/components/merchant/shell/routeTable';
import { ATTENTION_KINDS, kindIcon } from '../src/components/merchant/notifications/notificationKinds';
import { MERCHANT_KINDS, KIND_PREF } from '../worker/lib/merchantNotify';
import { Bell } from 'lucide-react';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the custom-order and coupon addresses carry their id to the section', () => {
  const custom = resolveWorkspaceRoute(merchantHref.customOrder('cord_1'), '/merchant');
  assert.deepEqual(custom, { kind: 'section', section: 'custom_orders', id: 'cord_1' });
  const coupon = resolveWorkspaceRoute(merchantHref.coupon('mcp_1'), '/merchant');
  assert.deepEqual(coupon, { kind: 'section', section: 'coupons', id: 'mcp_1' });
});

test('the sections hand the id to CustomOrdersTab and CouponsTab', () => {
  const sections = read('src/components/merchant/shell/sections.tsx');
  assert.match(sections, /<m\.CustomOrdersTab focusOrderId=\{id \?\? null\} \/>/);
  assert.match(sections, /<m\.CouponsTab[^>]*focusCouponId=\{id \?\? null\}/);
});

test('the tabs scroll to, focus and mark the named row', () => {
  const tabs = read('src/components/merchant/dashboard/SalesTabs.tsx');
  assert.match(tabs, /export function CustomOrdersTab\(\{ focusOrderId = null \}/);
  assert.match(tabs, /focusCouponId = null,/);
  for (const ref of ['focusRow', 'focusCoupon']) {
    assert.match(tabs, new RegExp(`${ref}\\.current\\?\\.scrollIntoView`));
    assert.match(tabs, new RegExp(`${ref}\\.current\\?\\.focus\\(`));
  }
  assert.match(tabs, /data-custom-order=\{o\.id\}/);
  assert.match(tabs, /data-coupon=\{cp\.id\}/);
});

test('every merchant kind has an icon and a switch; the new money kinds ask for attention', () => {
  for (const kind of MERCHANT_KINDS) {
    assert.notEqual(kindIcon(kind), Bell, `${kind} has no icon in the notification centre`);
    assert.ok(KIND_PREF[kind], `${kind} has no switch`);
  }
  for (const kind of ['payout_failed', 'balance_reversed']) assert.ok(ATTENTION_KINDS.has(kind));
  assert.equal(KIND_PREF.dispute_resolved, 'complaints');
});
