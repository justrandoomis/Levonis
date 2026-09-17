/**
 * §11 / §12 — "cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد
 * الأدمن العادي لا يراها في API ولا في HTML ولا في export", and its acceptance
 * row: "اختبارات صلاحيات تثبت أن مساعد الأدمن لا يرى Cost أو البيانات المالية
 * حتى باستدعاء API مباشرة".
 *
 * scripts/e2e-permissions.mjs proves the rule over real HTTP. This file pins
 * the two decisions that rule is made of, so a regression fails in `npm run
 * test:unit` rather than only in a suite that needs a running worker:
 *
 *   canViewFinancials       WHO may see money
 *   stripFinancials         WHAT is removed, at every depth
 *   attemptedFinancialWrites  what a request actually TRIED to change —
 *                           where absent must not be read as "set to null"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptedFinancialWrites,
  canViewFinancials,
  carryStoredCostForward,
  isOwner,
  normalizeAdminScope,
  projectForAdmin,
  stripFinancials,
  type CostBearing,
} from '../worker/lib/adminScope';
import type { Env, SessionUser } from '../worker/lib/types';

const env = { INITIAL_ADMIN_EMAIL: 'owner@levonis-iq.com' } as unknown as Env;
const user = (over: Partial<SessionUser>): SessionUser =>
  ({
    id: 'u1',
    email: 'someone@example.com',
    role: 'customer',
    admin_scope: null,
    ...over,
  }) as SessionUser;

// ------------------------------------------------------------------- who

test('a customer never sees financials, admin flag or not', () => {
  assert.equal(canViewFinancials(env, user({ role: 'customer' })), false);
  assert.equal(canViewFinancials(env, user({ role: 'merchant', admin_scope: 'full' })), false);
  assert.equal(canViewFinancials(env, null), false);
  assert.equal(canViewFinancials(env, undefined), false);
});

test('an admin with no scope is unrestricted — the migration must not demote anyone', () => {
  // 0021 added the column with NULL for every existing admin. NULL meaning
  // "assistant" would have silently locked the owner out on deploy day.
  assert.equal(canViewFinancials(env, user({ role: 'admin', admin_scope: null })), true);
  assert.equal(canViewFinancials(env, user({ role: 'admin', admin_scope: 'full' })), true);
});

test('an assistant admin does not see financials', () => {
  assert.equal(canViewFinancials(env, user({ role: 'admin', admin_scope: 'assistant' })), false);
});

test('the owner is financial even if their row says assistant', () => {
  // A compromised assistant must not be able to lock the owner out of their
  // own numbers, so the owner check wins over the stored scope.
  const owner = user({ role: 'admin', email: 'Owner@LEVONIS-IQ.com', admin_scope: 'assistant' });
  assert.equal(isOwner(env, owner), true, 'the owner match is case- and space-insensitive');
  assert.equal(canViewFinancials(env, owner), true);
});

test('with no INITIAL_ADMIN_EMAIL configured nobody is the owner', () => {
  const blank = {} as unknown as Env;
  assert.equal(isOwner(blank, user({ role: 'admin', email: '' })), false);
  assert.equal(isOwner(blank, user({ role: 'admin', email: 'anyone@example.com' })), false);
});

test('an ABSENT scope is unrestricted; an UNRECOGNISED one is not', () => {
  assert.equal(normalizeAdminScope('assistant'), 'assistant');
  assert.equal(normalizeAdminScope('full'), 'full');

  // ABSENT stays unrestricted. This is the documented upgrade path: migration
  // 0021 added the column and could not be allowed to demote every live admin
  // overnight, so NULL means "no restriction was ever recorded".
  assert.equal(normalizeAdminScope(undefined), null);
  assert.equal(normalizeAdminScope(null), null);
  assert.equal(normalizeAdminScope(''), null);
  assert.equal(normalizeAdminScope('   '), null);

  // UNRECOGNISED resolves to the LEAST privilege, and this assertion is the
  // reverse of what this test used to say. The old behaviour bundled 'nonsense'
  // with undefined and returned null for both — so `'assisstant'` with a typo,
  // a value written by an older build, or a half-finished manual UPDATE all
  // read as "not an assistant" and granted the cost, the margin and the
  // supplier price. The module's own rationale only ever justified the ABSENT
  // case; nothing justified failing open on a value nobody could parse. The
  // one thing certain about such a value is that somebody meant to restrict
  // something.
  assert.equal(normalizeAdminScope('nonsense'), 'assistant');
  assert.equal(normalizeAdminScope('readonly'), 'assistant');
  assert.equal(normalizeAdminScope('assisstant'), 'assistant', 'a typo must not widen access');
  assert.equal(normalizeAdminScope('FULL'), 'assistant', 'the values are matched exactly, not case-folded');
  assert.equal(normalizeAdminScope(42), 'assistant');
  assert.equal(normalizeAdminScope({}), 'assistant');
});

test('an unparseable scope cannot see financials', () => {
  // The consequence of the rule above, at the call site that matters.
  assert.equal(canViewFinancials(env, user({ role: 'admin', admin_scope: 'nonsense' })), false);
  assert.equal(canViewFinancials(env, user({ role: 'admin', admin_scope: 'assisstant' })), false);
  // ...and the documented default is untouched.
  assert.equal(canViewFinancials(env, user({ role: 'admin', admin_scope: null })), true);
  assert.equal(canViewFinancials(env, user({ role: 'admin', admin_scope: 'full' })), true);
});

// ------------------------------------------------------------------ what

test('stripFinancials removes every financial field at every depth', () => {
  const payload = {
    id: 'p1',
    name: 'Printer',
    price_iqd: 900000,
    product_cost_iqd: 613377,
    margin_iqd: 286623,
    margin_percent: 31.8,
    options: [{ id: 'o1', name: 'Bundle', cost_iqd: 41221, price_delta_iqd: 15000 }],
    colors: [{ id: 'c1', name: 'Black', cost_iqd: 27113, stock: 3 }],
    variants: [{ id: 'v1', combo: 'o1', supplier_price_iqd: 500000, stock: 1 }],
    nested: { deeper: { list: [{ cost_iqd: 5 }] } },
  };
  const out = stripFinancials(payload);
  const raw = JSON.stringify(out);
  for (const f of ['cost_iqd', 'product_cost_iqd', 'margin_iqd', 'margin_percent', 'supplier_price_iqd']) {
    assert.ok(!raw.includes(f), `${f} survived the strip`);
  }
  // Everything else must survive — an assistant still runs the catalogue.
  assert.equal(out.price_iqd, 900000);
  assert.equal(out.options[0].price_delta_iqd, 15000);
  assert.equal(out.colors[0].stock, 3);
  assert.equal(out.variants[0].stock, 1);
  assert.equal(out.nested.deeper.list.length, 1);
});

test('stripFinancials leaves the original payload untouched', () => {
  const payload = { product_cost_iqd: 7, name: 'x' };
  stripFinancials(payload);
  assert.equal(payload.product_cost_iqd, 7, 'the caller-owned object was mutated');
});

test('projectForAdmin strips for an assistant and passes through for a full admin', () => {
  const payload = { product_cost_iqd: 613377, price_iqd: 900000 };
  const asAssistant = projectForAdmin(env, user({ role: 'admin', admin_scope: 'assistant' }), payload);
  assert.equal('product_cost_iqd' in asAssistant, false);
  assert.equal(asAssistant.price_iqd, 900000);

  const asFull = projectForAdmin(env, user({ role: 'admin', admin_scope: 'full' }), payload);
  assert.equal(asFull.product_cost_iqd, 613377);
});

// ---------------------------------------------------------------- writes

const stored: CostBearing = {
  product_cost_iqd: 613377,
  options: [{ id: 'o1', cost_iqd: 41221 }],
  colors: [{ id: 'c1', cost_iqd: 27113 }],
};
/** What validateProductDoc produces from a body with no cost keys: nulls. */
const strippedDoc = (): CostBearing => ({
  product_cost_iqd: null,
  options: [{ id: 'o1', cost_iqd: null }],
  colors: [{ id: 'c1', cost_iqd: null }],
});

test('a save that never mentions cost attempts nothing — the bug this exists for', () => {
  // The assistant's GET removed the keys, so their panel posts the document
  // back without them. Reading that as "set every cost to null" refused the
  // save outright and left an assistant unable to edit the NAME of any priced
  // product. Absent is not an attempt.
  const raw = { id: 'p1', name_en: 'Renamed by the assistant', options: [{ id: 'o1' }], colors: [{ id: 'c1' }] };
  assert.deepEqual(attemptedFinancialWrites(raw, strippedDoc(), stored), []);
});

test('and that save keeps every stored cost exactly as it was', () => {
  const doc = strippedDoc();
  carryStoredCostForward(doc, stored);
  assert.equal(doc.product_cost_iqd, 613377);
  assert.equal(doc.options[0].cost_iqd, 41221);
  assert.equal(doc.colors[0].cost_iqd, 27113);
});

test('sending a DIFFERENT product cost is an attempt, and is named', () => {
  const raw = { id: 'p1', product_cost_iqd: 1 };
  const doc = { ...strippedDoc(), product_cost_iqd: 1 };
  assert.deepEqual(attemptedFinancialWrites(raw, doc, stored), ['product_cost_iqd']);
});

test('sending the SAME product cost back is not an attempt to change it', () => {
  const raw = { id: 'p1', product_cost_iqd: 613377 };
  const doc = { ...strippedDoc(), product_cost_iqd: 613377 };
  assert.deepEqual(attemptedFinancialWrites(raw, doc, stored), []);
});

test('explicitly sending null over a stored cost IS an attempt to blank it', () => {
  // The one case absent and present must be told apart: a client that really
  // says {"product_cost_iqd": null} is trying to erase a number it never saw.
  const raw = { id: 'p1', product_cost_iqd: null };
  assert.deepEqual(attemptedFinancialWrites(raw, strippedDoc(), stored), ['product_cost_iqd']);
});

test('option and colour cost are checked per id, and named per id', () => {
  const raw = {
    id: 'p1',
    options: [{ id: 'o1', cost_iqd: 9 }],
    colors: [{ id: 'c1', cost_iqd: 27113 }], // unchanged
  };
  const doc: CostBearing = {
    product_cost_iqd: null,
    options: [{ id: 'o1', cost_iqd: 9 }],
    colors: [{ id: 'c1', cost_iqd: 27113 }],
  };
  assert.deepEqual(attemptedFinancialWrites(raw, doc, stored), ['option:o1.cost_iqd']);
});

test('a brand-new option carrying a cost is an attempt even with nothing stored', () => {
  const raw = { id: 'p1', options: [{ id: 'oNEW', cost_iqd: 500 }] };
  const doc: CostBearing = { product_cost_iqd: null, options: [{ id: 'oNEW', cost_iqd: 500 }], colors: [] };
  assert.deepEqual(attemptedFinancialWrites(raw, doc, stored), ['option:oNEW.cost_iqd']);
});

test('creating a product with a cost is an attempt (prev is null)', () => {
  const raw = { product_cost_iqd: 100 };
  const doc: CostBearing = { product_cost_iqd: 100, options: [], colors: [] };
  assert.deepEqual(attemptedFinancialWrites(raw, doc, null), ['product_cost_iqd']);
});

test('a malformed body cannot crash the check or smuggle a cost past it', () => {
  const doc: CostBearing = { product_cost_iqd: null, options: [], colors: [] };
  assert.deepEqual(attemptedFinancialWrites({ options: 'not-an-array' }, doc, stored), []);
  assert.deepEqual(attemptedFinancialWrites({ options: [null, 5, { cost_iqd: 1 }] }, doc, stored), []);
});

test('carryStoredCostForward nulls a cost that has no stored counterpart', () => {
  // A new option must not inherit some other option's cost, and must not keep
  // whatever the assistant's client happened to put there.
  const doc: CostBearing = {
    product_cost_iqd: 999,
    options: [{ id: 'oNEW', cost_iqd: 500 }],
    colors: [{ id: 'cNEW', cost_iqd: 500 }],
  };
  carryStoredCostForward(doc, stored);
  assert.equal(doc.product_cost_iqd, 613377);
  assert.equal(doc.options[0].cost_iqd, null);
  assert.equal(doc.colors[0].cost_iqd, null);
});


// ------------------------------------------- §11.4: the composition preview

test('a bundle preview loses component cost for an assistant and keeps every operational figure', () => {
  // §11.4: cost and margin are financial; a pool weight, a probability and an
  // availability count are OPERATIONAL and stay visible to an assistant admin.
  // The preview is shaped exactly as `worker/routes/adminBundles.ts` sends it.
  const preview = {
    component_total_iqd: 945000,
    bundle_price_iqd: 850000,
    saving_percent: 10,
    availability: { state: 'in_stock', max_bundles: 3, blocking: [] },
    components: [
      { component_id: 'bc_1', name: 'Printer', qty_per_bundle: 1, unit_iqd: 900000, available: 5, cost_iqd: 700000 },
      { component_id: 'bc_2', name: 'Spool', qty_per_bundle: 2, unit_iqd: 20000, available: 6, cost_iqd: 12000 },
    ],
  };
  const owner = projectForAdmin(env, user({ role: 'admin', email: 'owner@levonis-iq.com' }), preview);
  assert.equal(owner.components[0].cost_iqd, 700000, 'the owner sees component cost');

  const assistant = projectForAdmin(env, user({ role: 'admin', admin_scope: 'assistant' }), preview);
  assert.equal(JSON.stringify(assistant).includes('cost_iqd'), false, 'an assistant never sees a component cost');
  assert.equal(JSON.stringify(assistant).includes('700000'), false, 'nor the figure itself');
  assert.equal(assistant.availability.max_bundles, 3, 'availability is operational, not financial');
  assert.equal(assistant.saving_percent, 10, 'the saving the customer is offered is not a cost');
  assert.equal(assistant.components[0].unit_iqd, 900000, 'the price a customer pays is not a cost either');
});
