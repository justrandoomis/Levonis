/**
 * LEVONIS PRINT CLOUD — review fixes for the catalogue and the settings
 * (worker/lib/printCloud/catalog.ts, settings.ts).
 *
 *   c13  the terms that decide what a customer pays — a promotion's or a
 *        package's switch, window and limits, a tier's switch, a printer
 *        model's tier, a machine moved to another tier's model — are money
 *        acts: refused to an operator, recorded in pc_price_changes;
 *   c15  PATCH /settings merges nested objects key by key over the stored
 *        configuration, and refuses a value it would otherwise have replaced
 *        with a default;
 *   c27  null for an optional NOT NULL catalogue column is a VALIDATION
 *        refusal, never an SQL NULL that answers 500.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-catalog-settings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, API, call, ok, pcWorld, refused, row, rows, seedCatalog, type Json, type World } from './fixtures/printCloud';
import { ENTITIES } from '../worker/lib/printCloud/catalog';
import type { App } from './fixtures/app';

const names = (en: string, ar: string, ckb: string) => ({ name_en: en, name_ar: ar, name_ckb: ckb });

/** The call must be refused 403 FORBIDDEN for want of money scope, naming the field. */
async function needsMoney(app: App, path: string, body: Record<string, unknown>): Promise<void> {
  const r = await refused(app, 'PATCH', path, body, 'FORBIDDEN');
  assert.equal(r.details.reason, 'financial_scope_required', `${path} ${JSON.stringify(body)}`);
  assert.equal(r.details.field, Object.keys(body)[0]);
}

const quote24h = async (w: World, packageId: string) => ok(w.b, 'POST', `${API}/quotes`, { lines: [{ kind: 'credit_package', package_id: packageId }] });

const priceChanges = (w: World, entityId: string) =>
  rows<{ before_json: string; after_json: string; actor_id: string }>(w, 'SELECT before_json, after_json, actor_id FROM pc_price_changes WHERE entity_id = ? ORDER BY created_at, id', entityId);

test('c13: an operator cannot re-arm a promotion, reopen an offer or re-tier a machine; a full admin can, and it is recorded as a price', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);

  // A full admin's automatic half-price promotion, spent and switched off.
  const promo = await ok(w.full, 'POST', `${ADMIN}/catalog/promotions`, {
    ...names('Half price', 'نصف السعر', 'نیوەی نرخ'),
    scope: 'all',
    percent_bps: 5000,
    ends_at: '2026-01-02T00:00:00.000Z',
    max_redemptions: 1,
  });
  await ok(w.full, 'PATCH', `${ADMIN}/catalog/promotions/${promo.id}`, { active: false });
  const before = await quote24h(w, cat.packages.h24);
  assert.equal(before.total_iqd, 36000);
  assert.equal(before.discount_iqd, 0);

  // The operator cannot switch it back on, widen its window or lift its cap.
  const promoPath = `${ADMIN}/catalog/promotions/${promo.id}`;
  await needsMoney(w.assistant, promoPath, { active: true });
  await needsMoney(w.assistant, promoPath, { starts_at: '2026-01-01T00:00:00.000Z' });
  await needsMoney(w.assistant, promoPath, { ends_at: '2099-01-01T00:00:00.000Z' });
  await needsMoney(w.assistant, promoPath, { max_redemptions: 10_000_000 });
  const after = await quote24h(w, cat.packages.h24);
  assert.equal(after.total_iqd, 36000, 'the customer still pays the full price');
  assert.equal(row(w, 'SELECT active FROM pc_promotions WHERE id = ?', promo.id)?.active, 0);

  // A package's switch, window and limits are the terms of an offer.
  const pkgPath = `${ADMIN}/catalog/packages/${cat.packages.h24}`;
  for (const body of [{ active: false }, { valid_from: '2026-01-01T00:00:00.000Z' }, { valid_until: '2099-01-01T00:00:00.000Z' }, { max_per_customer: 1 }, { min_quantity: 2 }, { max_quantity: 5 }]) {
    await needsMoney(w.assistant, pkgPath, body);
  }
  // A tier's switch opens or closes its hourly sale.
  await needsMoney(w.assistant, `${ADMIN}/catalog/tiers/${cat.tier}`, { active: false });

  // A cheap tier the full admin created: the operator may not bill the X2D from it.
  const cheap = await ok(w.full, 'POST', `${ADMIN}/catalog/tiers`, { code: 'cheap', ...names('Cheap hours', 'ساعات رخيصة', 'کاتژمێری هەرزان'), hourly_rate_iqd: 100 });
  await needsMoney(w.assistant, `${ADMIN}/catalog/printer_models/${cat.model}`, { tier_id: cheap.id });
  assert.equal(row(w, 'SELECT tier_id FROM pc_printer_models WHERE id = ?', cat.model)?.tier_id, cat.tier);
  // Creating a model names the tier that bills it: a money act too.
  const modelBody = (code: string, tierId: string) => ({ tier_id: tierId, code, brand: 'Bambu Lab', model_name: code, build_x_mm: 256, build_y_mm: 256, build_z_mm: 256 });
  const created = await call(w.assistant, 'POST', `${ADMIN}/catalog/printer_models`, modelBody('A1-CHEAP', cheap.id));
  assert.equal(created.status, 403);
  assert.equal(created.json.details.reason, 'financial_scope_required');

  // Moving a machine to a model of ANOTHER tier reprices it; within one tier it is the operator's.
  const cheapModel = await ok(w.full, 'POST', `${ADMIN}/catalog/printer_models`, modelBody('A1-CHEAP', cheap.id));
  const sameTier = await ok(w.full, 'POST', `${ADMIN}/catalog/printer_models`, modelBody('X2D-B', cat.tier));
  await needsMoney(w.assistant, `${ADMIN}/catalog/printers/${cat.printers[0]}`, { model_id: cheapModel.id });
  assert.equal(row(w, 'SELECT model_id FROM pc_printers WHERE id = ?', cat.printers[0])?.model_id, cat.model);
  await ok(w.assistant, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { model_id: sameTier.id });
  assert.equal(priceChanges(w, cat.printers[0]).length, 0, 'a move within one tier changes no price');

  // The full admin may do all of it, and every change is a pc_price_changes row with before and after.
  await ok(w.full, 'PATCH', promoPath, { active: true, ends_at: '2099-01-01T00:00:00.000Z', max_redemptions: 100 });
  const promoChange = priceChanges(w, promo.id).at(-1)!;
  assert.deepEqual(JSON.parse(promoChange.before_json), { ends_at: '2026-01-02T00:00:00.000Z', max_redemptions: 1, active: 0 });
  assert.deepEqual(JSON.parse(promoChange.after_json), { ends_at: '2099-01-01T00:00:00.000Z', max_redemptions: 100, active: 1 });
  assert.equal(promoChange.actor_id, 'usr_full');
  assert.equal((await quote24h(w, cat.packages.h24)).total_iqd, 18000, 'the re-armed promotion is a price');

  await ok(w.full, 'PATCH', pkgPath, { max_per_customer: 3 });
  assert.deepEqual(JSON.parse(priceChanges(w, cat.packages.h24).at(-1)!.after_json), { max_per_customer: 3 });
  await ok(w.full, 'PATCH', `${ADMIN}/catalog/tiers/${cheap.id}`, { active: false });
  assert.deepEqual(JSON.parse(priceChanges(w, cheap.id).at(-1)!.before_json), { active: 1 });
  await ok(w.full, 'PATCH', `${ADMIN}/catalog/printer_models/${sameTier.id}`, { tier_id: cheap.id });
  assert.deepEqual(JSON.parse(priceChanges(w, sameTier.id).at(-1)!.after_json), { tier_id: cheap.id });
  await ok(w.full, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[1]}`, { model_id: cheapModel.id });
  const move = priceChanges(w, cat.printers[1]).at(-1)!;
  assert.deepEqual(JSON.parse(move.before_json), { model_id: cat.model, tier_id: cat.tier });
  assert.deepEqual(JSON.parse(move.after_json), { model_id: cheapModel.id, tier_id: cheap.id });
});

test('c13: an operator’s same-tier move aborts when the target model is re-tiered before it commits', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const modelBody = (code: string, tierId: string) => ({ tier_id: tierId, code, brand: 'Bambu Lab', model_name: code, build_x_mm: 256, build_y_mm: 256, build_z_mm: 256 });
  const cheap = await ok(w.full, 'POST', `${ADMIN}/catalog/tiers`, { code: 'cheap', ...names('Cheap hours', 'ساعات رخيصة', 'کاتژمێری هەرزان'), hourly_rate_iqd: 100 });
  const sameTier = await ok(w.full, 'POST', `${ADMIN}/catalog/printer_models`, modelBody('X2D-B', cat.tier));
  // The operator read X2D-B on the X2D tier; the full admin moves X2D-B to the cheap tier just before the batch.
  w.race.when = (sqls) => sqls.some((s) => s.startsWith('UPDATE pc_printers SET'));
  w.race.hook = async () => {
    await ok(w.full, 'PATCH', `${ADMIN}/catalog/printer_models/${sameTier.id}`, { tier_id: cheap.id });
  };
  await refused(w.assistant, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { model_id: sameTier.id }, 'STATE_CHANGED');
  assert.equal(row(w, 'SELECT model_id FROM pc_printers WHERE id = ?', cat.printers[0])?.model_id, cat.model, 'the machine stays on its tier');
});

// ------------------------------------------------------------------ c15 settings

async function patchSettings(w: World, config: Record<string, unknown>, app: App = w.owner): Promise<{ status: number; json: Json }> {
  const current = await ok(app, 'GET', `${ADMIN}/settings`);
  return call(app, 'PATCH', `${ADMIN}/settings`, { version: current.version, config });
}

const stored = (w: World): Json => JSON.parse(String(row(w, "SELECT value_json FROM pc_settings WHERE key = 'config'")?.value_json));

test('c15: a nested settings patch changes the keys it names and keeps every sibling the owner set', async () => {
  const w = pcWorld();
  const first = await patchSettings(w, {
    delivery: { enabled: false, pickup_enabled: true, flat_fee_iqd: 5000, fee_by_governorate: { baghdad: 4000 } },
    failure_policy: { customer: 'no_charge' },
    stock_hold_minutes: 240,
  });
  assert.equal(first.status, 200, JSON.stringify(first.json));

  const second = await patchSettings(w, { delivery: { flat_fee_iqd: 7000 }, failure_policy: { model: 'no_charge' } });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const s = stored(w);
  assert.deepEqual(s.delivery, { enabled: false, pickup_enabled: true, flat_fee_iqd: 7000, fee_by_governorate: { baghdad: 4000 } });
  assert.deepEqual(s.failure_policy, { workshop: 'no_charge', customer: 'no_charge', model: 'no_charge', undetermined: 'manual_review' });
  assert.equal(s.stock_hold_minutes, 240);
  assert.deepEqual(second.json.data.config.delivery, s.delivery, 'the answer is what was stored');

  // Governorate fees merge one by one; null removes one.
  assert.equal((await patchSettings(w, { delivery: { fee_by_governorate: { erbil: 6000 } } })).status, 200);
  assert.deepEqual(stored(w).delivery.fee_by_governorate, { baghdad: 4000, erbil: 6000 });
  assert.equal((await patchSettings(w, { delivery: { fee_by_governorate: { baghdad: null } } })).status, 200);
  assert.deepEqual(stored(w).delivery.fee_by_governorate, { erbil: 6000 });
  assert.equal(stored(w).delivery.enabled, false, 'delivery stays closed through every fee change');
});

test('c15: a settings value out of range or of the wrong type is refused, never replaced by a default', async () => {
  const w = pcWorld();
  assert.equal((await patchSettings(w, { stock_hold_minutes: 240, delivery: { fee_by_governorate: { baghdad: 4000 } } })).status, 200);
  const version = row(w, "SELECT version FROM pc_settings WHERE key = 'config'")?.version;
  const kept = stored(w);
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ stock_hold_minutes: 2 }, 'stock_hold_minutes', 'out_of_range'],
    [{ stock_hold_minutes: 90.5 }, 'stock_hold_minutes', 'integer_required'],
    [{ quote_ttl_minutes: null }, 'quote_ttl_minutes', 'integer_required'],
    [{ enabled: 'yes' }, 'enabled', 'boolean_required'],
    [{ time_overage_policy: 'charge_everything' }, 'time_overage_policy', 'not_allowed'],
    [{ failure_policy: { customer: 'charge_everything' } }, 'failure_policy.customer', 'not_allowed'],
    [{ failure_policy: { nobody: 'no_charge' } }, 'failure_policy.nobody', 'unknown_setting'],
    [{ failure_policy: 'no_charge' }, 'failure_policy', 'object_required'],
    [{ delivery: true }, 'delivery', 'object_required'],
    [{ delivery: { flat_fee_iqd: -1 } }, 'delivery.flat_fee_iqd', 'out_of_range'],
    [{ delivery: { enabled: 1 } }, 'delivery.enabled', 'boolean_required'],
    [{ delivery: { surcharge_iqd: 1 } }, 'delivery.surcharge_iqd', 'unknown_setting'],
    [{ delivery: { fee_by_governorate: { 'Bad Key': 1000 } } }, 'delivery.fee_by_governorate.Bad Key', 'not_allowed'],
    [{ delivery: { fee_by_governorate: { basra: 1.5 } } }, 'delivery.fee_by_governorate.basra', 'integer_required'],
    [{ delivery: { fee_by_governorate: { basra: 2_000_000 } } }, 'delivery.fee_by_governorate.basra', 'out_of_range'],
    [{ delivery: { fee_by_governorate: [] } }, 'delivery.fee_by_governorate', 'object_required'],
    [{ import_providers: { id: 'x' } }, 'import_providers', 'array_required'],
    [{ import_providers: [{ id: 'evil', hosts: ['127.0.0.1'] }] }, 'import_providers[0]', 'invalid_value'],
    [{ import_providers: [{ id: 'printables', hosts: ['printables.com', 'not a host'] }] }, 'import_providers[0].hosts', 'invalid_value'],
    [{ import_providers: [{ id: 'printables', hosts: ['printables.com'], api_url: 'http://insecure.example.com/{id}' }] }, 'import_providers[0].api_url', 'not_allowed'],
    [{ import_providers: [{ id: 'printables', hosts: ['printables.com'], token: 'x' }] }, 'import_providers[0].token', 'unknown_setting'],
    [
      { import_providers: [{ id: 'printables', hosts: ['printables.com'] }, { id: 'printables', hosts: ['www.printables.com'] }] },
      'import_providers',
      'duplicate',
    ],
  ];
  for (const [config, field, reason] of cases) {
    const r = await patchSettings(w, config);
    assert.equal(r.status, 400, `${JSON.stringify(config)} → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    assert.equal(r.json.code, 'VALIDATION');
    assert.equal(r.json.details.field, field, JSON.stringify(config));
    assert.equal(r.json.details.reason, reason, JSON.stringify(config));
  }
  assert.equal(row(w, "SELECT version FROM pc_settings WHERE key = 'config'")?.version, version, 'no refused patch was written');
  assert.deepEqual(stored(w), kept);
  // A provider that leaves out its optional keys takes their documented defaults.
  assert.equal((await patchSettings(w, { import_providers: [{ id: 'printables', hosts: ['printables.com'] }] })).status, 200);
  assert.deepEqual(stored(w).import_providers, [{ id: 'printables', hosts: ['printables.com'], api_url: '', download_hosts: [], enabled: true }]);
});

// ------------------------------------------------------------------ c27 null on a NOT NULL column

test('c27: every catalogue field says whether its column takes NULL, exactly as the schema does', () => {
  const w = pcWorld();
  for (const spec of Object.values(ENTITIES)) {
    const cols = new Map(rows<{ name: string; notnull: number }>(w, `PRAGMA table_info(${spec.table})`).map((c) => [c.name, Number(c.notnull)]));
    for (const f of spec.fields) {
      assert.ok(cols.has(f.name), `${spec.table}.${f.name} is a column`);
      const nullable = 'nullable' in f && f.nullable === true;
      assert.equal(nullable, cols.get(f.name) === 0, `${spec.table}.${f.name}: nullable in the spec must match the schema`);
    }
  }
});

test('c27: null for an optional NOT NULL column is refused VALIDATION, never a 500; a nullable column is cleared', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const second = await ok(w.full, 'POST', `${ADMIN}/catalog/tiers`, { code: 'p1s', ...names('P1S hours', 'ساعات P1S', 'کاتژمێرەکانی P1S'), hourly_rate_iqd: 1000 });
  const rule = await ok(w.full, 'POST', `${ADMIN}/catalog/conversion_rules`, { from_tier_id: cat.tier, to_tier_id: second.id, ratio_num: 3, ratio_den: 2 });
  const promo = await ok(w.full, 'POST', `${ADMIN}/catalog/promotions`, { ...names('Ten off', 'خصم عشرة', 'داشکاندنی دە'), scope: 'all', percent_bps: 1000, max_redemptions: 5 });
  const location = await ok(w.owner, 'POST', `${ADMIN}/catalog/locations`, { code: 'RACK-A', name: 'Rack A' });
  const ids: Record<string, string> = {
    tiers: cat.tier,
    printer_models: cat.model,
    printers: cat.printers[0],
    packages: cat.packages.h24,
    conversion_rules: rule.id,
    products: String(row(w, 'SELECT product_id FROM pc_variants WHERE id = ?', cat.white)?.product_id),
    variants: cat.white,
    promotions: promo.id,
    locations: location.id,
    accessory_rules: String(row(w, 'SELECT id FROM pc_accessory_rules ORDER BY keyword DESC LIMIT 1')?.id),
  };
  let refusedCount = 0;
  let cleared = 0;
  for (const [key, spec] of Object.entries(ENTITIES)) {
    for (const f of spec.fields) {
      if (('required' in f && f.required) || ('immutable' in f && f.immutable)) continue;
      const r = await call(w.owner, 'PATCH', `${ADMIN}/catalog/${key}/${ids[key]}`, { [f.name]: null });
      if ('nullable' in f && f.nullable) {
        assert.equal(r.status, 200, `${key}.${f.name}: null clears a nullable column → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
        assert.equal(r.json.data[f.name] ?? null, null);
        cleared++;
      } else {
        assert.equal(r.status, 400, `${key}.${f.name}: null → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
        assert.equal(r.json.code, 'VALIDATION');
        assert.deepEqual([r.json.details.field, r.json.details.reason], [f.name, 'null_not_allowed'], key);
        refusedCount++;
      }
    }
  }
  assert.ok(refusedCount > 40 && cleared > 15, `${refusedCount} refused, ${cleared} cleared`);
  // The finding's own cases, through the doors the reviewers used.
  await refused(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { location: null }, 'VALIDATION');
  await refused(w.assistant, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { notes: null }, 'VALIDATION');
  const brand = await refused(w.owner, 'POST', `${ADMIN}/catalog/products`, { category_code: 'magnets', brand: null, ...names('Magnets', 'مغانط', 'موگناتیس') }, 'VALIDATION');
  assert.equal(brand.details.reason, 'null_not_allowed');
  // A required field stays 'required', and the agent can still be unassigned.
  assert.equal((await refused(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { name: null }, 'VALIDATION')).details.reason, 'required');
  await ok(w.assistant, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { agent_id: null });
});
