/**
 * PRODUCT DISCOUNT — THE ADMIN DOOR (docs/ux/PRODUCT-DISCOUNT.md §5, §12 "Server: the door").
 *
 * The product form's «تخفيض السعر» card and the «العروض الخاصة» tab write ONE row through ONE door
 * (`PUT /api/admin/offers/:id`), against the real routes and migrations through 0197:
 *   - roles: the owner reads dollars and the below-cost flags; an editor reads dollars on a
 *     price-first product only, and a dollar save on a cost-first one is 403 PRICING_V2_OWNER_ONLY;
 *     no answer carries the rate, an exact IQD, R, T or a `v2_*` key;
 *   - the preview writes nothing (no row, no audit, no purge);
 *   - every §5.8 refusal, in three languages, the Sorani never a copy of the Arabic;
 *   - a sale below cost is never refused: the owner is warned, an editor's save rings the owner's
 *     bell once with no figure, and the editor hears nothing;
 *   - the dollar set: kept by a save that does not name it, cleared by a mode change, deleted with
 *     the window (the redemptions stay);
 *   - lost updates (`expected_updated_at`) are refused inside the batch; the audit row carries the
 *     set; the catalogue is purged after PUT and DELETE, never after the preview.
 *
 * Run: npx tsx --test tests/productDiscountAdmin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, row } from './fixtures/app';
import { COST_PID, discountWorld, M1, M2, PID, SLUG, SHAPES, seedShapes, writeV2Uniform, type DiscountWorld } from './fixtures/productDiscount';
import { OFFER_DOOR_SENTENCES } from '../worker/routes/offers';
import { OFFER_DISCOUNT_REFUSALS, OFFER_DISCOUNT_WARNINGS } from '../packages/contracts/src/offerRefusals';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const perModel = (p1s: string | null, combo: string | null) => ({
  offer_price_mode: 'fixed_usd',
  offer_usd_prices: [...(p1s ? [{ model_id: M1, usd: p1s }] : []), ...(combo ? [{ model_id: M2, usd: combo }] : [])],
});

/** Keys no admin answer of this door may carry (§5.1, §11): the rate, the exact IQD, R, T, any `v2_*`, any cost. */
const PRIVATE_KEYS = /"(usd_iqd_rate|exact_iqd|direct_exact_iqd|replacement_[a-z_]+|target_[a-z_]+|v2_[a-z_]+|cost_iqd|price_usd_cents|usd_ceil6)"/;

function trapPurges() {
  const g = globalThis as { caches?: unknown };
  const before = g.caches;
  const paths: string[] = [];
  g.caches = { default: { delete: async (req: Request) => (paths.push(new URL(req.url).pathname), true), match: async () => undefined, put: async () => undefined } };
  return { paths, restore: () => (before === undefined ? delete g.caches : (g.caches = before)) };
}

const codeOf = (r: { body: Record<string, unknown> }) => String(r.body.code ?? '');

/* ------------------------------------------------------------------ roles -- */

test('roles: the owner reads dollars and the owner flags; an editor reads dollars on price-first only; nobody reads the rate, R, T or a v2 key', async () => {
  const w = await discountWorld();
  const owner = await w.readOffer(w.owner);
  assert.equal(owner.status, 200);
  const d = owner.body.discount;
  assert.equal(d.viewer, 'owner');
  assert.equal(d.method, 'usd');
  assert.equal(d.published, true);
  assert.deepEqual(d.usd, { available: true, reason: null, scopes: ['model'] }, 'two models at two prices: per model only');
  assert.deepEqual(
    d.rows.map((r: Record<string, unknown>) => [r.model_id, r.channel, r.before_iqd, r.before_usd, r.before_usd_exact]),
    [
      [M1, 'direct_sale', 900_000, '600.00', true],
      [M1, 'pre_order_land', 825_000, '550.00', true],
      [M2, 'direct_sale', 1_125_000, '750.00', true],
      [M2, 'pre_order_land', 1_050_000, '700.00', true],
    ]
  );
  assert.ok(d.write_seq > 0);
  const ownerPreview = await w.previewOffer(w.owner, perModel('500', '640'));
  assert.ok(ownerPreview.body.rows.every((r: Record<string, unknown>) => r.owner && typeof r.owner === 'object'), 'the owner reads the flags');

  // An editor on a PRICE-FIRST product: the same dollars, no flags.
  const editor = await w.readOffer(w.editor);
  assert.equal(editor.body.discount.viewer, 'editor');
  assert.equal(editor.body.discount.rows[0].before_usd, '600.00');
  const editorPreview = await w.previewOffer(w.editor, perModel('500', '640'));
  assert.equal(editorPreview.status, 200);
  assert.ok(editorPreview.body.rows.every((r: Record<string, unknown>) => !('owner' in r)), 'an editor never reads a cost flag');
  assert.equal(editorPreview.body.rows[0].after_iqd, 750_000);

  // An editor on a COST-FIRST product: no dollars at all, the segment says why, a dollar save is the owner's.
  const cost = await w.readOffer(w.editor, COST_PID);
  assert.equal(cost.body.discount.method, 'cost');
  assert.deepEqual(cost.body.discount.usd, { available: false, reason: 'OWNER_ONLY', scopes: [] });
  assert.ok(cost.body.discount.rows.every((r: Record<string, unknown>) => r.before_usd === null && r.before_usd_exact === false));
  const refused = await w.saveOffer(w.editor, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] }, COST_PID);
  assert.equal(refused.status, 403);
  assert.equal(codeOf(refused), 'PRICING_V2_OWNER_ONLY');
  assert.equal(refused.body.details.section, 3);
  const costPreview = await w.previewOffer(w.editor, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] }, COST_PID);
  assert.ok(costPreview.body.rows.every((r: Record<string, unknown>) => r.after_iqd === null), 'no dollar preview for an editor on cost-first — a rate oracle');
  assert.equal(costPreview.body.issues[0].code, 'PRICING_V2_OWNER_ONLY');
  // The owner on cost-first sees «≈» dollars (not exact).
  const ownerCost = await w.readOffer(w.owner, COST_PID);
  assert.ok(ownerCost.body.discount.rows.every((r: Record<string, unknown>) => typeof r.before_usd === 'string' && r.before_usd_exact === false));

  for (const answer of [owner, ownerPreview, editor, editorPreview, cost, costPreview, ownerCost]) {
    assert.doesNotMatch(JSON.stringify(answer.body), PRIVATE_KEYS, 'no private key in any answer of the door');
  }
});

/* --------------------------------------------------------------- preview -- */

test('the preview writes nothing: no window, no dollar row, no audit, no purge', async () => {
  const w = await discountWorld();
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log');
  const trap = trapPurges();
  try {
    const p = await w.previewOffer(w.owner, perModel('500', '640'));
    assert.equal(p.status, 200);
    assert.deepEqual(
      p.body.rows.map((r: Record<string, unknown>) => [r.channel, r.before_iqd, r.after_iqd, r.offer_saving_percent, r.state]),
      [
        ['direct_sale', 900_000, 750_000, 17, 'lowered'],
        ['pre_order_land', 825_000, 675_000, 18, 'lowered'],
        ['direct_sale', 1_125_000, 960_000, 15, 'lowered'],
        ['pre_order_land', 1_050_000, 885_000, 16, 'lowered'],
      ]
    );
    assert.equal(p.body.rows[0].after_usd, '500.00', 'the typed dollars on the direct line');
    assert.equal(p.body.rows[1].after_usd, '450.00', 'the route: its IQD ÷ its own rate, to the cent');
    assert.deepEqual(trap.paths, [], 'a preview purges nothing');
  } finally {
    trap.restore();
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_windows'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_usd_prices'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log'), audits);
});

/* ------------------------------------------------------------- the saves -- */

test('PUT per model: one window, the set in cents, the answer carries the set as text, the audit row inside the batch carries it too', async () => {
  const w = await discountWorld();
  const trap = trapPurges();
  let saved;
  try {
    saved = await w.saveOffer(w.owner, { ...perModel('500', '640'), ends_at: '2099-01-01T00:00', expected_updated_at: null });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    for (const path of ['/api/products', '/api/home', `/api/products/${SLUG}`]) assert.ok(trap.paths.includes(path), `purged ${path}`);
  } finally {
    trap.restore();
  }
  assert.equal(saved.body.offer.offer_price_mode, 'fixed_usd');
  // In the product's model order, each model row with its names (§7, the tab's read-only line).
  assert.deepEqual(saved.body.offer.offer_usd_prices, [
    { model_id: M1, usd: '500.00', names: { ar: 'P1S', en: 'P1S', ckb: 'P1S' } },
    { model_id: M2, usd: '640.00', names: { ar: 'P1S كومبو', en: 'P1S Combo', ckb: 'P1S کۆمبۆ' } },
  ]);
  assert.equal(saved.body.offer.ends_at, '2098-12-31T21:00:00.000Z', 'a zone-less time is Baghdad time (D11)');
  assert.deepEqual(
    all(w.raw, 'SELECT model_id, price_usd_cents FROM offer_usd_prices ORDER BY model_id'),
    [{ model_id: M2, price_usd_cents: 64_000 }, { model_id: M1, price_usd_cents: 50_000 }].sort((a, b) => a.model_id.localeCompare(b.model_id))
  );
  const win = row<Record<string, unknown>>(w.raw, "SELECT * FROM offer_windows WHERE subject_id = ?", PID)!;
  assert.deepEqual([win.offer_price_mode, win.offer_price_iqd, win.discount_percent, win.discount_iqd], ['fixed_usd', null, null, null]);
  const audit = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'offer.update' ORDER BY rowid DESC LIMIT 1")!;
  assert.match(audit.detail, /"offer_usd_prices":\[\{"model_id":"[^"]+","usd":"(500|640)\.00"/);
  assert.equal(saved.body.warnings.some((x: { code: string }) => x.code === 'OFFER_PRICE_NEVER_ENDS'), false, 'it ends');
});

test("PUT for the whole product: one '' row when every model sells direct at one price", async () => {
  const w = await discountWorld();
  await writeV2Uniform(w); // both models at $600
  const read = await w.readOffer(w.owner);
  assert.deepEqual(read.body.discount.usd.scopes, ['product', 'model']);
  const saved = await w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.rows.map((r: Record<string, unknown>) => r.after_iqd), [750_000, 675_000, 750_000, 675_000]);
  // The trigger backstops a mixed scope from any other writer.
  assert.throws(() => w.raw.exec(`INSERT INTO offer_usd_prices (subject_type, subject_id, model_id, price_usd_cents) VALUES ('product', '${PID}', '${M1}', 100)`), /OFFER_USD_SCOPE_MIXED/);
});

/* ------------------------------------------------------------ refusals -- */

test('every §5.8 refusal, with its status and three sentences (the Sorani never a copy of the Arabic)', async () => {
  const w = await discountWorld();
  await seedShapes(w);
  const cases: Array<[string, number, () => Promise<{ status: number; body: Record<string, unknown> }>]> = [
    ['OFFER_USD_ORDINARY_ONLY', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] }, SHAPES.bundle)],
    ['OFFER_USD_NOT_PRICED', 409, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] }, SHAPES.unpriced)],
    ['OFFER_USD_PRICE_SHAPE', 400, () => w.saveOffer(w.owner, perModel('500.123', null))],
    ['OFFER_USD_PRICE_SHAPE', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: 500.5 }] })],
    ['OFFER_USD_PRICE_SHAPE', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: 500 }] })],
    ['OFFER_USD_PRICE_SHAPE', 400, () => w.saveOffer(w.owner, perModel('0', null))],
    ['OFFER_USD_PRICE_SHAPE', 400, () => w.saveOffer(w.owner, perModel('100000.01', null))],
    ['OFFER_USD_SCOPE_MIXED', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }, { model_id: M1, usd: '500' }] })],
    ['OFFER_USD_MODEL_UNKNOWN', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: 'not_a_model', usd: '500' }] })],
    ['OFFER_USD_PER_MODEL', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] })],
    ['OFFER_USD_MIXED_PRICES', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] }, SHAPES.colours)],
    ['OFFER_USD_NOT_DIRECT', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] }, SHAPES.preorderOnly)],
    ['OFFER_PRICE_INCOMPLETE', 400, () => w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd' })],
    ['OFFER_NOT_LOWER', 400, () => w.saveOffer(w.owner, perModel('700', null))],
    ['OFFER_ROUTE_BELOW_FLOOR', 400, () => w.saveOffer(w.owner, perModel('50', null))],
  ];
  for (const [code, status, run] of cases) {
    const r = await run();
    assert.equal(codeOf(r), code, `${code}: ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.equal(r.status, status, code);
    const said = (r.body.details as { errors?: Array<Record<string, string>> } | undefined)?.errors?.[0];
    assert.ok(said && said.ar && said.en && said.ckb, `${code}: three sentences`);
    assert.notEqual(said.ckb, said.ar, `${code}: the Sorani is not the Arabic`);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_windows'), 0, 'nothing was written by any refusal');
  // Every new code the door can say has its three sentences in the client table too (src/lib/refusalStrings.ts),
  // the very ones the door answers with.
  for (const code of [...Object.keys(OFFER_DISCOUNT_REFUSALS), ...Object.keys(OFFER_DISCOUNT_WARNINGS)]) {
    assert.deepEqual(
      { ...(OFFER_DOOR_SENTENCES as Record<string, unknown>)[code] as object },
      { ...(REFUSAL_STRINGS as Record<string, unknown>)[code] as object },
      `${code}: one sentence set for the door and the table`
    );
    const entry = (REFUSAL_STRINGS as Record<string, { ar: string; en: string; ckb: string }>)[code];
    assert.ok(entry, `refusalStrings has ${code}`);
    assert.notEqual(entry.ckb, entry.ar, code);
  }
  // The shapes' read model says why before anyone types.
  assert.equal((await w.readOffer(w.owner, SHAPES.colours)).body.discount.usd.reason, 'MIXED_PRICES');
  assert.equal((await w.readOffer(w.owner, SHAPES.preorderOnly)).body.discount.usd.reason, 'NOT_DIRECT');
  assert.equal((await w.readOffer(w.owner, SHAPES.unpriced)).body.discount.usd.reason, 'NOT_PUBLISHED');
  assert.equal((await w.readOffer(w.owner, SHAPES.bundle)).body.discount.composition, true);
});

test('warnings: a model not lowered, an open-ended sale, and below cost — the last to the owner only', async () => {
  const w = await discountWorld();
  const partly = await w.saveOffer(w.owner, perModel('500', '760'));
  assert.equal(partly.status, 200);
  const codes = partly.body.warnings.map((x: { code: string }) => x.code);
  assert.ok(codes.includes('OFFER_PARTLY_NOT_LOWER'));
  assert.ok(codes.includes('OFFER_PRICE_NEVER_ENDS'));
  assert.deepEqual(partly.body.rows.map((r: Record<string, unknown>) => r.state), ['lowered', 'lowered', 'not_lower', 'not_lower']);

  // Cost-first, 60% off: below cost. The owner is warned and nobody's bell rings.
  const bells0 = count(w.raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'fx_attention'");
  const owner = await w.saveOffer(w.owner, { offer_price_mode: 'discount_percent', discount_percent: 60 }, COST_PID);
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.ok(owner.body.warnings.some((x: { code: string }) => x.code === 'OFFER_BELOW_COST'));
  assert.ok(owner.body.rows.some((r: { owner?: { below_cost: boolean } }) => r.owner?.below_cost));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'fx_attention'"), bells0, 'the owner’s own save rings no bell');
});

test('not refused for cost: an editor’s below-cost save saves, rings ONE owner bell with no figure, and says nothing to the editor', async () => {
  const w = await discountWorld();
  const res = await w.saveOffer(w.editor, { offer_price_mode: 'discount_percent', discount_percent: 60 }, COST_PID);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const said = JSON.stringify(res.body);
  assert.doesNotMatch(said, /OFFER_BELOW_COST|below_cost|below_min_profit|"owner"/, 'no cost signal to an editor');
  assert.doesNotMatch(said, PRIVATE_KEYS);
  const bells = all<{ user_id: string; title_ar: string; body_ar: string; meta: string; link: string; event_key: string }>(
    w.raw,
    "SELECT user_id, title_ar, body_ar, meta, link, event_key FROM user_notifications WHERE kind = 'fx_attention'"
  );
  assert.equal(bells.length, 1);
  assert.equal(bells[0]!.user_id, 'usr_owner');
  assert.equal(bells[0]!.title_ar, 'تخفيض تحت التكلفة');
  assert.match(bells[0]!.event_key, new RegExp(`^pricing\\.offer\\.below_cost:${COST_PID}:`));
  assert.equal(bells[0]!.link, `/admin?tab=products&edit=${COST_PID}&section=3`);
  assert.doesNotMatch(bells[0]!.body_ar + bells[0]!.meta, /\d{4,}/, 'the bell carries no figure');
  assert.ok(JSON.parse(bells[0]!.meta).title_ckb);
  assert.equal(row<{ discount_percent: number }>(w.raw, 'SELECT discount_percent FROM offer_windows WHERE subject_id = ?', COST_PID)?.discount_percent, 60, 'saved, not moved');
});

/* ---------------------------------------------------- the set, the row -- */

test('a card save keeps the tiers, the limits and locked_preview it was given; a save without the set keeps it; a mode change clears it; DELETE removes it and keeps redemptions', async () => {
  const w = await discountWorld();
  // The tab: a members-only percent offer with limits.
  const tab = await w.saveOffer(w.owner, { offer_price_mode: 'discount_percent', discount_percent: 10, required_tiers: ['pro'], max_per_user: 2, max_global: 9, locked_preview: false });
  assert.equal(tab.status, 200);
  // The card: the whole row as loaded, with the dollar set.
  const loaded = (await w.readOffer(w.owner)).body.offer;
  const card = await w.saveOffer(w.owner, { ...loaded, ...perModel('500', '640'), expected_updated_at: loaded.updated_at });
  assert.equal(card.status, 200, JSON.stringify(card.body));
  assert.deepEqual(card.body.offer.required_tiers, ['pro']);
  assert.equal(card.body.offer.max_per_user, 2);
  assert.equal(card.body.offer.max_global, 9);
  assert.equal(card.body.offer.locked_preview, false);
  // The tab re-saves the schedule without naming the set: the set is kept.
  const again = await w.saveOffer(w.owner, { ...card.body.offer, offer_usd_prices: undefined, ends_at: '2099-01-01T00:00:00Z' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_usd_prices'), 2);
  // A mode change clears it.
  const percent = await w.saveOffer(w.owner, { ...again.body.offer, offer_price_mode: 'discount_percent', discount_percent: 10, offer_usd_prices: undefined });
  assert.equal(percent.status, 200);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_usd_prices'), 0);
  assert.deepEqual(percent.body.offer.offer_usd_prices, []);
  // Back to dollars, public, and a real order under it (its redemption row); then DELETE: window, limits
  // and dollars go; the redemption stays.
  const pub = await w.saveOffer(w.owner, { ...perModel('500', '640'), required_tiers: [], max_per_user: null, max_global: null });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal((await w.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty: 1, fulfillmentType: 'direct_sale' })).status, 200);
  const order = await w.placeOrder();
  assert.equal(order.status, 200, JSON.stringify(order.body).slice(0, 300));
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 1, 'the checkout counted the sale');
  const trap = trapPurges();
  try {
    const del = await w.deleteOffer(w.owner);
    assert.equal(del.status, 200);
    assert.ok(trap.paths.includes(`/api/products/${SLUG}`), 'the product page is purged with the window');
  } finally {
    trap.restore();
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_windows'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_limits'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_usd_prices'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 1);
});

test('lost updates: a stale stamp, or "no row" against a row, is 409 SPECIAL_OFFER_CHANGED and writes nothing', async () => {
  const w = await discountWorld();
  const first = await w.saveOffer(w.owner, { ...perModel('500', '640'), expected_updated_at: null });
  assert.equal(first.status, 200);
  const stamp = first.body.offer.updated_at as string;
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log');
  const stale = await w.saveOffer(w.owner, { ...perModel('450', '600'), expected_updated_at: '2020-01-01T00:00:00.000Z' });
  assert.equal(stale.status, 409);
  assert.equal(codeOf(stale), 'SPECIAL_OFFER_CHANGED');
  assert.notEqual(stale.body.details.errors[0].ckb, stale.body.details.errors[0].ar);
  const none = await w.saveOffer(w.owner, { ...perModel('450', '600'), expected_updated_at: null });
  assert.equal(none.status, 409);
  assert.equal(codeOf(none), 'SPECIAL_OFFER_CHANGED');
  assert.deepEqual(all(w.raw, 'SELECT price_usd_cents FROM offer_usd_prices ORDER BY price_usd_cents').map((r) => r.price_usd_cents), [50_000, 64_000], 'nothing written');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log'), audits, 'no audit for a refused save');
  // The right stamp saves.
  const ok = await w.saveOffer(w.owner, { ...perModel('450', '600'), expected_updated_at: stamp });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('the list carries each row’s dollar set; the purge middleware skips only the preview', async () => {
  const w = await discountWorld();
  await w.saveOffer(w.owner, perModel('500', '640'));
  const list = await w.call(w.owner, 'GET', '/api/admin/offers');
  assert.equal(list.status, 200);
  const mine = list.body.offers.find((o: { subject_id: string }) => o.subject_id === PID);
  assert.equal(mine.offer_usd_prices.length, 2);
  assert.doesNotMatch(JSON.stringify(list.body), PRIVATE_KEYS);
});

export type { DiscountWorld };

/* ---------------------------------------------------- review: the tab -- */

test('a cost-first dollar save refused to an editor carries its own three sentences (the Sorani its own); the tab knows not to offer it', async () => {
  const { COST_REFUSALS } = await import('../packages/contracts/src/costRefusals');
  const w = await discountWorld();
  const body = { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] };
  const refused = await w.saveOffer(w.editor, body, COST_PID);
  assert.equal(refused.status, 403);
  assert.equal(codeOf(refused), 'PRICING_V2_OWNER_ONLY');
  assert.equal(refused.body.details.section, 3);
  const [e] = refused.body.details.errors;
  assert.equal(e.code, 'PRICING_V2_OWNER_ONLY');
  assert.deepEqual([e.ar, e.en, e.ckb], [COST_REFUSALS.PRICING_V2_OWNER_ONLY.ar, COST_REFUSALS.PRICING_V2_OWNER_ONLY.en, COST_REFUSALS.PRICING_V2_OWNER_ONLY.ckb]);
  assert.notEqual(e.ckb, e.ar);
  assert.equal(e.message, COST_REFUSALS.PRICING_V2_OWNER_ONLY.en);
  const preview = await w.previewOffer(w.editor, body, COST_PID);
  assert.equal(preview.body.issues[0].ckb, COST_REFUSALS.PRICING_V2_OWNER_ONLY.ckb, 'the card’s preview says it in Sorani too');
  // A typed dinar price on an ordinary product (the tab's «سعر ثابت»): the same three-sentence shape.
  const dinar = await w.saveOffer(w.editor, { offer_price_mode: 'fixed', offer_price_iqd: 700_000 }, PID);
  assert.equal(codeOf(dinar), 'PRICING_V2_MANAGED');
  assert.equal(dinar.body.details.errors[0].ckb, COST_REFUSALS.PRICING_V2_MANAGED.ckb);
  // The list tells the tab, per row, whether this viewer may type a dollar sale price there (D7).
  assert.equal((await w.saveOffer(w.owner, { offer_price_mode: 'discount_percent', discount_percent: 10 }, COST_PID)).status, 200);
  assert.equal((await w.saveOffer(w.owner, { offer_price_mode: 'discount_percent', discount_percent: 10 }, PID)).status, 200);
  const rowsFor = async (app: typeof w.owner) => (await w.call(app, 'GET', '/api/admin/offers')).body.offers as Array<{ subject_id: string; usd_allowed: boolean }>;
  const byEditor = await rowsFor(w.editor);
  assert.equal(byEditor.find((r) => r.subject_id === COST_PID)!.usd_allowed, false, 'an editor on a cost-first product');
  assert.equal(byEditor.find((r) => r.subject_id === PID)!.usd_allowed, true, 'an editor on a price-first product');
  assert.ok((await rowsFor(w.owner)).every((r) => r.usd_allowed === true), 'the owner everywhere');
});

test('the tab reads each dollar row with its model’s names, in the product’s model order', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
  const list = (await w.call(w.owner, 'GET', '/api/admin/offers')).body.offers as Array<Record<string, unknown>>;
  const row = list.find((r) => r.subject_id === PID)!;
  assert.deepEqual(row.offer_usd_prices, [
    { model_id: M1, usd: '500.00', names: { ar: 'P1S', en: 'P1S', ckb: 'P1S' } },
    { model_id: M2, usd: '640.00', names: { ar: 'P1S كومبو', en: 'P1S Combo', ckb: 'P1S کۆمبۆ' } },
  ]);
  const one = await w.readOffer(w.owner);
  assert.deepEqual(one.body.offer.offer_usd_prices, row.offer_usd_prices, 'the single read says the same');
  // The whole-product row has no model and no names.
  await writeV2Uniform(w);
  assert.equal((await w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] })).status, 200);
  const whole = ((await w.call(w.owner, 'GET', '/api/admin/offers')).body.offers as Array<Record<string, unknown>>).find((r) => r.subject_id === PID)!;
  assert.deepEqual(whole.offer_usd_prices, [{ model_id: '', usd: '500.00' }]);
});

test('a refused draft’s preview says `refused`: the card shows the before column, «—» and the sentence — never «بلا تخفيض»', async () => {
  const w = await discountWorld({ costFirst: false });
  const typo = await w.previewOffer(w.owner, perModel('200000', '640'));
  assert.equal(typo.status, 200);
  assert.equal(typo.body.refused, true);
  assert.deepEqual(typo.body.issues.map((i: { code: string }) => i.code), ['OFFER_USD_PRICE_SHAPE']);
  assert.ok(typo.body.issues[0].ckb && typo.body.issues[0].ckb !== typo.body.issues[0].ar);
  const inverted = await w.previewOffer(w.owner, { ...perModel('500', '640'), starts_at: '2026-12-01T00:00', ends_at: '2026-11-01T00:00' });
  assert.equal(inverted.body.refused, true);
  assert.equal(inverted.body.issues[0].code, 'SCHEDULE_INVERTED');
  // A priced draft is not `refused` (its step-7 sentences ride beside priced rows).
  const fine = await w.previewOffer(w.owner, perModel('500', '640'));
  assert.equal(fine.body.refused, undefined);
});
