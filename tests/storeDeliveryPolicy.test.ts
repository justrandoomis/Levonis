/**
 * «إدارة التوصيل» — the store's delivery policy (owner decisions 2026-10-18;
 * packages/shipping/src/storeDelivery.ts). Pure: the charge, the combination
 * rule, the governorate exceptions, the waivers on top, and the strict writer
 * against the tolerant reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteShipping, type ShippingConfig, type ShippingItem } from '../worker/lib/shipping';
import { serializeDoc, validateProductDoc } from '../worker/lib/productModel';
import {
  DELIVERY_POLICY_FALLBACK,
  deliveryCharge,
  groupChargeIqd,
  normalizeDeliveryPolicy,
  resolveDeliveryGroup,
  validateDeliveryPolicy,
  type DeliveryPolicy,
  type DeliveryRuleGroup,
} from '../worker/lib/storeDelivery';

const group = (over: Partial<DeliveryRuleGroup> & Pick<DeliveryRuleGroup, 'id'>): DeliveryRuleGroup => ({
  name: { ar: 'قاعدة', en: 'Rule', ckb: 'یاسا' },
  enabled: true,
  mode: 'flat',
  fee_iqd: 0,
  block_size: 1,
  catalog_ids: [],
  product_ids: [],
  ...over,
});

/** The owner's starting rules, as migration 0203 seeds them. */
const SEEDED: DeliveryPolicy = {
  version: 1,
  default_fee_iqd: 5_000,
  governorates: {},
  groups: [
    group({ id: 'g_printers', mode: 'per_piece', fee_iqd: 10_000, catalog_ids: ['cat_printers', 'cat_laser_machines', 'cat_used_printers'] }),
    group({ id: 'g_printers_large', mode: 'per_piece', fee_iqd: 25_000, product_ids: ['h2s', 'h2d'] }),
    group({ id: 'g_filament', mode: 'per_block', fee_iqd: 5_000, block_size: 10, catalog_ids: ['cat_materials_fdm'] }),
  ],
  updated_at: '2026-10-18T00:00:00Z',
  updated_by: 'test',
};

const PRINTER_PATH = ['cat_printers_fdm', 'cat_printers'];
const FILAMENT_PATH = ['cat_materials_fdm', 'cat_materials'];
const ACCESSORY_PATH = ['cat_pacc_fdm', 'cat_pacc'];

const printer = (qty: number, id = 'x1c'): ShippingItem => ({ product_id: id, qty, size_class: null, is_printer: true, category_path: PRINTER_PATH });
const filament = (qty: number, id = 'pla'): ShippingItem => ({ product_id: id, qty, size_class: null, category_path: FILAMENT_PATH });
const accessory = (qty: number, id = 'nozzle'): ShippingItem => ({ product_id: id, qty, size_class: null, category_path: ACCESSORY_PATH });

const cfg = (over: Partial<ShippingConfig> = {}): ShippingConfig => ({
  ordinary_iqd: 5000,
  printer_small_iqd: null,
  printer_large_iqd: null,
  pro_threshold_iqd: 75000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'all',
  prime_threshold_iqd: 150000,
  prime_waiver_covers: 'ordinary_only',
  carton_threshold_spools: null,
  carton_fee_iqd: null,
  printer_advance_required: true,
  protected_iqd: 4000,
  ...over,
});

const quote = (items: ShippingItem[], over: Partial<Parameters<typeof quoteShipping>[0]> = {}) =>
  quoteShipping({
    items,
    deliveryMethod: 'standard',
    merchandiseIqd: 10_000,
    tier: 'free',
    tierActive: false,
    atApprovedDefaultAddress: false,
    deliveryPolicy: SEEDED,
    config: cfg(),
    ...over,
  });

test('printers pay per piece; large printers are product exceptions at 25,000 each', () => {
  assert.equal(quote([printer(1)]).total_iqd, 10_000);
  assert.equal(quote([printer(10)]).total_iqd, 100_000);
  assert.equal(quote([printer(2, 'h2d')]).total_iqd, 50_000);
  assert.equal(quote([printer(1, 'h2d'), printer(1)]).total_iqd, 35_000);
});

test('filament: 5,000 per started block of 10, pooled across colours', () => {
  for (const [n, fee] of [[9, 5_000], [10, 5_000], [11, 10_000], [14, 10_000], [20, 10_000], [21, 15_000]] as const) {
    assert.equal(quote([filament(n)]).total_iqd, fee, `${n} spools`);
  }
  const q = quote([filament(4, 'red'), filament(4, 'blue'), filament(4, 'green')]);
  assert.equal(q.total_iqd, 10_000);
  assert.equal(q.components.length, 1);
  assert.deepEqual(q.components[0].product_ids, ['red', 'blue', 'green']);
  assert.equal(q.components[0].rule_id, 'g_filament');
  assert.equal(q.components[0].block_size, 10);
});

test('the default: 5,000 flat for the whole order, unlimited pieces', () => {
  assert.equal(quote([accessory(1)]).total_iqd, 5_000);
  assert.equal(quote([accessory(50)]).total_iqd, 5_000);
  const q = quote([accessory(3)]);
  assert.equal(q.components[0].kind, 'ordinary');
  assert.equal(q.components[0].rule_id, 'default');
  assert.equal(q.components[0].fee_source, 'default');
});

test('combination: the sum of every group present, and the default is dropped when any group is present', () => {
  const q = quote([printer(1), filament(12), accessory(1)]);
  assert.equal(q.total_iqd, 20_000);
  assert.deepEqual(q.components.map((c) => c.rule_id).sort(), ['g_filament', 'g_printers']);
  // A group priced 0 still counts as present.
  const free: DeliveryPolicy = { ...SEEDED, groups: [...SEEDED.groups, group({ id: 'g_free', catalog_ids: ['cat_gift'] })] };
  assert.equal(quote([{ product_id: 'card', qty: 1, size_class: null, category_path: ['cat_gift'] }, accessory(1)], { deliveryPolicy: free }).total_iqd, 0);
});

test('most specific wins: product > sub-section > section > default', () => {
  const policy: DeliveryPolicy = {
    ...SEEDED,
    groups: [
      group({ id: 'section', mode: 'flat', fee_iqd: 7_000, catalog_ids: ['cat_printers'] }),
      group({ id: 'sub', mode: 'flat', fee_iqd: 8_000, catalog_ids: ['cat_printers_fdm'] }),
      group({ id: 'product', mode: 'flat', fee_iqd: 9_000, product_ids: ['x1c'] }),
    ],
  };
  assert.equal(resolveDeliveryGroup({ product_id: 'x1c', category_path: PRINTER_PATH }, policy)?.id, 'product');
  assert.equal(resolveDeliveryGroup({ product_id: 'p1s', category_path: PRINTER_PATH }, policy)?.id, 'sub');
  assert.equal(resolveDeliveryGroup({ product_id: 'k1', category_path: ['cat_printers_resin', 'cat_printers'] }, policy)?.id, 'section');
  assert.equal(resolveDeliveryGroup({ product_id: 'nozzle', category_path: ACCESSORY_PATH }, policy), null);
  // A disabled group is never matched.
  const off = { ...policy, groups: policy.groups.map((g) => (g.id === 'product' ? { ...g, enabled: false } : g)) };
  assert.equal(resolveDeliveryGroup({ product_id: 'x1c', category_path: PRINTER_PATH }, off)?.id, 'sub');
});

test('a stopped governorate: no components, the quote says so; a governorate price replaces only the default', () => {
  const stopped: DeliveryPolicy = { ...SEEDED, governorates: { anbar: { stopped: true } } };
  const q = quote([accessory(1)], { deliveryPolicy: stopped, governorate: 'anbar' });
  assert.equal(q.components.length, 0);
  assert.equal(q.total_iqd, 0);
  assert.ok(q.needs_config.includes('governorate:anbar:stopped'));
  assert.equal(q.delivery_unavailable, 'governorate_stopped');
  assert.equal(q.delivery_policy?.governorate_rule, 'stopped');

  const baghdad: DeliveryPolicy = { ...SEEDED, governorates: { baghdad: { fee_iqd: 3_000 } } };
  const acc = quote([accessory(2)], { deliveryPolicy: baghdad, governorate: 'baghdad' });
  assert.equal(acc.total_iqd, 3_000);
  assert.equal(acc.components[0].fee_source, 'governorate');
  assert.equal(quote([printer(1), accessory(1)], { deliveryPolicy: baghdad, governorate: 'baghdad' }).total_iqd, 10_000);
  // Another governorate keeps the default.
  assert.equal(quote([accessory(2)], { deliveryPolicy: baghdad, governorate: 'basra' }).total_iqd, 5_000);
});

test('a product in a «لا يُوصَّل» group refuses standard for that product', () => {
  const policy: DeliveryPolicy = { ...SEEDED, groups: [...SEEDED.groups, group({ id: 'g_stopped', mode: 'stopped', product_ids: ['bulky'] })] };
  const q = quote([accessory(1, 'bulky'), accessory(1)], { deliveryPolicy: policy });
  assert.ok(q.needs_config.includes('product:bulky:standard_unavailable'));
});

test('the fallback (no stored row) reproduces the pre-policy tariff', () => {
  const fb = (items: ShippingItem[]) => quote(items, { deliveryPolicy: undefined });
  assert.equal(fb([printer(2)]).total_iqd, 10_000);
  assert.equal(fb([printer(1), accessory(1)]).total_iqd, 10_000);
  assert.equal(fb([accessory(3)]).total_iqd, 5_000);
  assert.equal(fb([filament(30)]).total_iqd, 5_000);
  assert.equal(DELIVERY_POLICY_FALLBACK.groups[0].mode, 'flat');
});

test('waivers stay on top: PRO waives every rule component, a ceiling caps the sum, the wallet takes all but protected', () => {
  const pro = quote([printer(2), filament(12)], {
    tier: 'pro', tierActive: true, proShippingEntitled: true, atApprovedDefaultAddress: true, merchandiseIqd: 500_000,
  });
  assert.equal(pro.total_before_waiver_iqd, 30_000);
  assert.equal(pro.total_iqd, 0);
  assert.ok(pro.components.every((c) => c.waived));

  const capped = quote([printer(2), filament(12)], {
    tier: 'pro', tierActive: true, proShippingEntitled: true, atApprovedDefaultAddress: true, merchandiseIqd: 500_000,
    membershipShipping: { rule_id: 'r1', eligible: true, threshold_iqd: 0, basis_iqd: 500_000, max_subsidy_iqd: 12_000, reason: 'applied' },
  });
  assert.equal(capped.membership_subsidy_iqd, 12_000);
  assert.equal(capped.total_iqd, 18_000);

  const wallet = quote([printer(1), accessory(1)], { walletFreeDelivery: true, protectedDelivery: true });
  assert.equal(wallet.wallet_waiver_iqd, 10_000);
  assert.equal(wallet.total_iqd, 4_000, 'protected delivery stays charged');
});

test('advance is asked only for a group that holds a printer line', () => {
  assert.equal(quote([printer(1)]).advance_due_iqd, 10_000);
  assert.equal(quote([filament(5)]).advance_due_iqd, 0);
});

test('groupChargeIqd and deliveryCharge over server-resolved parts (the cart estimate)', () => {
  assert.equal(groupChargeIqd({ mode: 'per_block', fee_iqd: 5_000, block_size: 10 }, 0), 0);
  assert.equal(groupChargeIqd({ mode: 'per_block', fee_iqd: 5_000, block_size: 10 }, 30), 15_000);
  assert.equal(groupChargeIqd({ mode: 'flat', fee_iqd: 7_000, block_size: 1 }, 99), 7_000);
  assert.equal(groupChargeIqd({ mode: 'stopped', fee_iqd: 7_000, block_size: 1 }, 3), 0);
  const r = deliveryCharge({
    parts: [
      { product_id: 'a', qty: 11, rule_id: 'g_filament' },
      { product_id: 'b', qty: 1, rule_id: null },
    ],
    policy: SEEDED,
  });
  assert.equal(r.total_iqd, 10_000);
});

const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(SEEDED));

test('validateDeliveryPolicy refuses what the reader would have to drop, in three languages', () => {
  assert.equal(validateDeliveryPolicy(valid()).ok, true);
  const refusals: Array<[string, (v: Record<string, unknown>) => void]> = [
    ['duplicate catalog', (v) => ((v.groups as DeliveryRuleGroup[])[2].catalog_ids = ['cat_printers'])],
    ['duplicate product', (v) => ((v.groups as DeliveryRuleGroup[])[0].product_ids = ['h2s'])],
    ['unknown governorate', (v) => (v.governorates = { atlantis: { fee_iqd: 1 } })],
    ['per_block below 2', (v) => ((v.groups as DeliveryRuleGroup[])[2].block_size = 1)],
    ['non-integer fee', (v) => ((v.groups as DeliveryRuleGroup[])[0].fee_iqd = 10.5)],
    ['ckb copy of ar', (v) => ((v.groups as DeliveryRuleGroup[])[0].name = { ar: 'الطابعات', en: 'Printers', ckb: 'الطابعات' })],
    ['no target', (v) => ((v.groups as DeliveryRuleGroup[])[0].catalog_ids = [])],
    ['bad default', (v) => (v.default_fee_iqd = -1)],
  ];
  for (const [label, mutate] of refusals) {
    const v = valid();
    mutate(v);
    const r = validateDeliveryPolicy(v);
    assert.equal(r.ok, false, label);
    if (!r.ok) {
      assert.equal(r.error.code, 'DELIVERY_POLICY_INVALID');
      assert.ok(r.error.message.ar && r.error.message.en && r.error.message.ckb, `${label}: three languages`);
      assert.notEqual(r.error.message.ckb, r.error.message.ar);
    }
  }
  // A duplicate in a DISABLED group is allowed (it can never match).
  const v = valid();
  (v.groups as DeliveryRuleGroup[]).push({ ...SEEDED.groups[0], id: 'g_old', enabled: false });
  assert.equal(validateDeliveryPolicy(v).ok, true);
});

test('normalizeDeliveryPolicy drops a malformed group or governorate entry and keeps the rest', () => {
  const v = valid();
  (v.groups as unknown[]).push({ id: 'broken', mode: 'per_block', fee_iqd: 5000, block_size: 1, enabled: true, catalog_ids: ['x'] });
  (v.groups as unknown[]).push({ id: 'g_empty', mode: 'flat', fee_iqd: 5000, enabled: true, catalog_ids: [], product_ids: [] });
  v.governorates = { baghdad: { fee_iqd: 3000 }, basra: { fee_iqd: 'cheap' }, atlantis: { stopped: true } };
  const n = normalizeDeliveryPolicy(v);
  assert.deepEqual(n.groups.map((g) => g.id), ['g_printers', 'g_printers_large', 'g_filament']);
  assert.deepEqual(n.governorates, { baghdad: { fee_iqd: 3000 } });
  assert.equal(normalizeDeliveryPolicy('nonsense'), DELIVERY_POLICY_FALLBACK);
  assert.equal(normalizeDeliveryPolicy({ ...v, default_fee_iqd: 'x' }).default_fee_iqd, 5_000);
});

test('a printer by the owner\'s flag that no group names is priced by the printers group, never the default', () => {
  // «أجهزة الليزر» itself is a printer catalog the seeded rule leaves out (it holds accessories too).
  const laser = { product_id: 'lz', qty: 2, category_path: ['cat_laser'], is_printer: true };
  assert.equal(resolveDeliveryGroup(laser, SEEDED)?.id, 'g_printers');
  assert.equal(deliveryCharge({ parts: [laser], policy: SEEDED }).total_iqd, 20_000);
  // With filament the printer still adds its own charge.
  const spools = { product_id: 'pla', qty: 12, category_path: ['cat_materials_fdm'] };
  assert.equal(deliveryCharge({ parts: [laser, spools], policy: SEEDED }).total_iqd, 30_000);
  // A product or section rule still wins over the flag; a non-printer stays on the default.
  assert.equal(resolveDeliveryGroup({ product_id: 'h2s', category_path: ['cat_laser'], is_printer: true }, SEEDED)?.id, 'g_printers_large');
  assert.equal(resolveDeliveryGroup({ product_id: 'acc', category_path: ['cat_laser'] }, SEEDED), null);
  // The missing-row fallback reproduces the old tariff for ANY flagged printer: one flat 10,000.
  assert.equal(deliveryCharge({ parts: [{ ...laser, qty: 3 }], policy: DELIVERY_POLICY_FALLBACK }).total_iqd, 10_000);
  assert.equal(deliveryCharge({ parts: [{ ...laser, qty: 1 }, spools], policy: DELIVERY_POLICY_FALLBACK }).total_iqd, 10_000);
  // The printers group switched off: the flag alone prices nothing extra.
  const off: DeliveryPolicy = { ...SEEDED, groups: SEEDED.groups.map((g) => (g.id === 'g_printers' ? { ...g, enabled: false } : g)) };
  assert.equal(deliveryCharge({ parts: [laser], policy: off }).total_iqd, 5_000);
});

test('every rule component carries its group\'s name in the three languages for the checkout breakdown', () => {
  const charge = deliveryCharge({
    parts: [{ product_id: 'pla', qty: 12, category_path: ['cat_materials_fdm'] }],
    policy: SEEDED,
  });
  assert.deepEqual(charge.components[0].rule_name, { ar: 'قاعدة', en: 'Rule', ckb: 'یاسا' });
  const q = quote([filament(12)]);
  assert.equal(q.components[0].kind, 'rule');
  assert.deepEqual(q.components[0].rule_name, { ar: 'قاعدة', en: 'Rule', ckb: 'یاسا' });
  assert.equal(q.total_iqd, 10_000);
  // Through the quote, the printer FACT on a line reaches the printers group too.
  const lz = quote([{ product_id: 'lz', qty: 2, size_class: 'ordinary', category_path: ['cat_laser'], is_printer: true } as ShippingItem]);
  assert.equal(lz.total_iqd, 20_000);
});

test('a product save can never re-create the retired per-product delivery_options', () => {
  const rule = (enabled: boolean, fee: number) => ({ enabled, quantity_step: 1, fee_iqd: fee });
  // The old form's defaults (a stale admin tab, a new product's blank doc): dropped, not stored.
  const doc = validateProductDoc({
    name_en: 'Probe',
    price_iqd: 100_000,
    delivery_options: { standard: rule(true, 5_000), personal: rule(true, 10_000) },
    ops_policy: { delivery_options: { standard: rule(true, 5_000), personal: rule(true, 10_000) }, keep: 1 },
  });
  assert.equal(doc.delivery_options, null);
  const ops = JSON.parse(String(serializeDoc({ ...doc, ops_policy: { ...doc.ops_policy, delivery_options: { stale: true } } }).ops_policy));
  assert.equal('delivery_options' in ops, false);
  assert.equal(ops.keep, 1, 'the rest of ops_policy is carried');
  // Asking to STOP a product's delivery here is refused in words, never silently ignored.
  assert.throws(
    () => validateProductDoc({ name_en: 'Probe', price_iqd: 100_000, delivery_options: { standard: rule(false, 5_000), personal: rule(true, 10_000) } }),
    (err: unknown) => /delivery_options/.test(String((err as Error).message)) && /Delivery management/.test(String((err as Error).message))
  );
});
