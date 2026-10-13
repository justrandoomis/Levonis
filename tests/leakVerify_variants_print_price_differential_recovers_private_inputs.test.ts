/**
 * VARIANT VERIFY (DECISIONS row 220 port, fix/leak-port 5e6f581c) — the print
 * calculator's FINAL PRICE is a fixed, public function of the owner's private
 * inputs, so two anonymous quotes that differ in one input hand back that
 * input exactly. Variants of:
 *
 *   #6 / #17  "accessory buying cost public" — reported "already fixed
 *             upstream (row 216)": GET /api/print-quote/accessories no longer
 *             carries `cost_iqd`, and the quote answers carry no cost line.
 *   #5 / #11 / #19 / #29  "print-service rates" — the port made the
 *             machine-hour rate, setup fee and margin owner-only («the rates
 *             themselves, like the margin, are inputs of the print price and
 *             are never published»).
 *   #10 / #32  the platform's own price per kilo (`print_materials.
 *             default_iqd_per_kg`), which the port withholds from merchants as
 *             «the owner's figure».
 *
 * WHY THE FIELD REMOVALS DO NOT CLOSE IT. POST /api/print-quote/grams-quote is
 * open to a signed-out visitor (60/h) and lets the CALLER choose the grams, the
 * print minutes and the accessory basket. The price is
 *
 *     price = (Σ cost lines + failure reserve) / (1 − 0.35)
 *
 * where 0.35 is `PLATFORM_TARGET_MARGIN_PERCENT`, a constant in the PUBLIC
 * repository, the HARDWARE line sits outside the failure reserve, and the
 * reserve on a printer with no owner calibration is (1/0.9 − 1) × 0.45 of the
 * variable lines (`resolveSuccessRate`, `DEFAULT_FAILURE_FRACTION`, public).
 * So, with the answer's own `machine_hours`:
 *
 *     accessory cost / piece = Δprice(+N pieces) × 0.65 / N
 *     machine-hour rate      = Δprice(+M minutes) × 0.65 / (Δmachine_hours × 1.05)
 *     platform price per kg  = Δprice(+500 g) × 0.65 / (0.5 × 1.05)
 *
 * Each comes out to the dinar. The test sets owner values that appear in no
 * answer (asserted), derives them back from the anonymous answers alone, then
 * changes them and derives the new values — so the derivation is the owner's
 * data and not a coincidence of the seed.
 *
 * Not fixed by changing a projection: only a price that is not a public
 * function of the private input closes it (the same class as #21, pinned for
 * an owner ruling). Customers keep their prices; this test records that the
 * owner's buying price and rates still reach every visitor through them.
 *
 * LOCAL ONLY: role-matrix SQLite copy, the real route modules, no network.
 * Run: node --import tsx --test tests/leakVerify_variants_print_price_differential_recovers_private_inputs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { ROLES, appFor, call, seededCopy } from './fixtures/roleMatrix';
import { PLATFORM_TARGET_MARGIN_PERCENT } from '../worker/routes/printQuote';
import { DEFAULT_FAILURE_FRACTION } from '../worker/lib/printQuote/cost';

/**
 * Kept, failing, as `todo` — the owner rules (the same class as #21, pinned in
 * tests/leakAudit_customer-api_route_price_spread_reveals_freight). Every
 * figure below is recovered from FINAL PRICES the calculator must answer, and
 * no projection can hide an input of a price that is a public function of it:
 * closing it means a different price (a margin the owner sets privately in
 * place of the public 35 %, accessories at their own catalogue price, coarser
 * steps) or no anonymous calculator — what every customer pays changes.
 */
const OWNER_RULING =
  'OWNER RULING NEEDED (DECISIONS row 220): the print price is a public function of the accessory cost, the machine-hour rate, the per-kilo price and the margin, so quotes that differ in one input give that input; only a change to the price (or to who may quote) closes it';

/** Everything the attacker uses is in the public repository. */
const KEEP = 1 - PLATFORM_TARGET_MARGIN_PERCENT / 100; // 0.65
const RESERVE = 1 + (1 / 0.9 - 1) * DEFAULT_FAILURE_FRACTION; // 1.05 — resolveSuccessRate's 0.9 default

interface Owner {
  accessoryCost: number;
  machineHourFdm: number;
  plaPerKg: number;
}

function ownerSets(raw: DatabaseSync, o: Owner) {
  const accessories = [
    { id: 'privacy-magnet', name_ar: 'مغناطيس', name_en: 'Magnet', name_ckb: 'ماگنێت', unit: 'piece', category: 'magnet', active: true, cost_iqd: o.accessoryCost },
  ];
  raw.prepare("UPDATE admin_settings SET value = ? WHERE key = 'printAccessories'").run(JSON.stringify(accessories));
  const cfg = JSON.parse(String((raw.prepare("SELECT value FROM admin_settings WHERE key = 'printPricingConfig'").get() as { value: string }).value));
  cfg.machine_hour_iqd = { ...cfg.machine_hour_iqd, fdm: o.machineHourFdm };
  raw.prepare("UPDATE admin_settings SET value = ? WHERE key = 'printPricingConfig'").run(JSON.stringify(cfg));
  raw.prepare("UPDATE print_materials SET default_iqd_per_kg = ? WHERE id = 'pla'").run(o.plaPerKg);
}

async function gramsQuote(raw: DatabaseSync, body: Record<string, unknown>) {
  const res = await call(appFor(raw, ROLES.guest), 'POST', '/api/print-quote/grams-quote', { printer_model_id: 'bbl-a1m', ...body });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  return res.body as { quote: { price_iqd: number; machine_hours: number } } & Record<string, unknown>;
}

/** What a signed-out visitor recovers from four anonymous answers. */
async function derive(raw: DatabaseSync) {
  const base = await gramsQuote(raw, { rows: [{ material_id: 'pla', grams: 500 }] });
  const parts = await gramsQuote(raw, { rows: [{ material_id: 'pla', grams: 500 }], accessories: [{ id: 'privacy-magnet', qty: 100 }] });
  const timed = await gramsQuote(raw, { rows: [{ material_id: 'pla', grams: 500 }], print_minutes: 20_160 });
  const heavy = await gramsQuote(raw, { rows: [{ material_id: 'pla', grams: 1000 }] });
  const answers = [base, parts, timed, heavy];
  return {
    answers,
    accessoryCost: Math.round(((parts.quote.price_iqd - base.quote.price_iqd) * KEEP) / 100),
    machineHourFdm: Math.round(((timed.quote.price_iqd - base.quote.price_iqd) * KEEP) / ((timed.quote.machine_hours - base.quote.machine_hours) * RESERVE)),
    plaPerKg: Math.round(((heavy.quote.price_iqd - base.quote.price_iqd) * KEEP) / (0.5 * RESERVE)),
  };
}

for (const owner of [
  { accessoryCost: 47_321, machineHourFdm: 5_917, plaPerKg: 31_750 },
  { accessoryCost: 8_650, machineHourFdm: 7_402, plaPerKg: 22_000 },
] satisfies Owner[]) {
  test(`a signed-out visitor recovers the owner's accessory cost, machine-hour rate and per-kilo price from final prices (owner values ${JSON.stringify(owner)})`, { todo: OWNER_RULING }, async () => {
    const raw = seededCopy();
    ownerSets(raw, owner);
    const got = await derive(raw);

    // Control: the port's projections hold — no private value is IN any answer.
    for (const a of got.answers) {
      const text = JSON.stringify(a);
      const numbers = new Set((text.match(/\d+(\.\d+)?/g) ?? []).map(Number));
      for (const v of Object.values(owner)) assert.ok(!numbers.has(v), `answer carries ${v} verbatim: ${text.slice(0, 300)}`);
      assert.ok(!/cost|lines|margin|machine_iqd|per_kg/i.test(Object.keys(a.quote).join(',')), `quote fields: ${Object.keys(a.quote)}`);
    }

    const recovered: string[] = [];
    if (Math.abs(got.accessoryCost - owner.accessoryCost) <= 1) {
      recovered.push(`printAccessories[privacy-magnet].cost_iqd = ${owner.accessoryCost} (derived ${got.accessoryCost}) — the buying price row 216 / #6 / #17 removed from GET /accessories`);
    }
    if (Math.abs(got.machineHourFdm - owner.machineHourFdm) <= 1) {
      recovered.push(`printPricingConfig.machine_hour_iqd.fdm = ${owner.machineHourFdm} (derived ${got.machineHourFdm}) — a COST_SETTING_KEY, owner-only by worker/routes/admin.ts`);
    }
    if (Math.abs(got.plaPerKg - owner.plaPerKg) <= 1) {
      recovered.push(`print_materials[pla].default_iqd_per_kg = ${owner.plaPerKg} (derived ${got.plaPerKg}) — «the owner's figure» the port withholds from merchants`);
    }
    assert.deepEqual(
      recovered,
      [],
      `four anonymous POST /api/print-quote/grams-quote answers (price_iqd, machine_hours) + public constants ` +
        `(PLATFORM_TARGET_MARGIN_PERCENT=${PLATFORM_TARGET_MARGIN_PERCENT}, DEFAULT_FAILURE_FRACTION=${DEFAULT_FAILURE_FRACTION}, success 0.9) give back:\n  ${recovered.join('\n  ')}`
    );
  });
}

/**
 * The same differential on the customer's print-REQUEST wizard (Engine A,
 * POST /api/marketplace/print/quote, any signed-in customer, no rate limit):
 * the hardware sits inside the owner's PRIVATE target margin
 * (`printPricingConfig.target_margin_percent`, a COST_SETTING_KEY), so with
 * the accessory cost recovered above, two estimates give that margin back:
 *     margin = 1 − (N × accessory cost) / Δprice(+N pieces)
 * printRequests.ts says of exactly this: «a competitor should not be able to
 * read the shop's margins off a public wizard».
 */
test('a signed-in customer recovers the owner’s private Engine A target margin from two print-request estimates', { todo: OWNER_RULING }, async () => {
  const raw = seededCopy();
  ownerSets(raw, { accessoryCost: 47_321, machineHourFdm: 5_917, plaPerKg: 31_750 });
  const cfg = JSON.parse(String((raw.prepare("SELECT value FROM admin_settings WHERE key = 'printPricingConfig'").get() as { value: string }).value));
  cfg.target_margin_percent = 41;
  raw.prepare("UPDATE admin_settings SET value = ? WHERE key = 'printPricingConfig'").run(JSON.stringify(cfg));

  // Step 1 (anonymous, Engine B): the accessory's buying price, as above.
  const { accessoryCost } = await derive(raw);
  // Step 2 (customer, Engine A): two estimates of one typed job, without and with 500 magnets.
  const customer = appFor(raw, ROLES.customer);
  const estimate = async (accessories: unknown[]) => {
    const res = await call(customer, 'POST', '/api/marketplace/print/quote', {
      process: 'fdm', material_id: 'pla', quality: 'standard', infill_percent: 20, quantity: 1, volume_cm3: 40, accessories,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const q = (res.body as { quote: Record<string, unknown> }).quote;
    // Control: the port's projection holds — no margin, cost or floor field.
    for (const k of ['margin_percent', 'cost_iqd', 'cost_lines', 'floor_iqd', 'accessory_lines']) assert.ok(!(k in q), `quote carries ${k}`);
    return Number(q.price_iqd);
  };
  const p0 = await estimate([]);
  const p1 = await estimate([{ id: 'privacy-magnet', qty: 500 }]);
  const margin = Math.round((1 - (500 * accessoryCost) / (p1 - p0)) * 1000) / 10;
  assert.notEqual(
    margin,
    41,
    `POST /api/marketplace/print/quote ${p0} → ${p1} with 500 × ${accessoryCost} (the recovered buying price) gives ` +
      `printPricingConfig.target_margin_percent = ${margin}% — the owner's private Engine A margin (set to 41)`
  );
});

/**
 * The anonymous, EDGE-CACHED printer catalogue (GET /api/print-quote/printers)
 * labels each machine with a `price_group` built from a signature that
 * includes the owner's model-card economics (purchase, residual, useful
 * hours, maintenance — the requireCostRead printer-economics editor;
 * `printerPriceSignature`). Two databases that differ ONLY in whether the
 * owner entered the X1C's economics give a guest two different catalogues:
 * which machines the owner has costed, and which share one costing, is public.
 */
test('the anonymous printer catalogue’s price groups change with the owner’s private model-card economics', { todo: OWNER_RULING }, async () => {
  const costed = seededCopy();
  const bare = seededCopy();
  bare.exec("UPDATE printer_models SET purchase_iqd = NULL, residual_iqd = NULL, useful_print_hours = NULL, maintenance_iqd_per_hour = NULL WHERE id = 'bbl-x1c'");
  const groups = async (raw: DatabaseSync) => {
    const res = await call(appFor(raw, ROLES.guest), 'GET', '/api/print-quote/printers');
    assert.equal(res.status, 200);
    const printers = (res.body as { printers: Array<{ id: string; price_group: string }> }).printers;
    for (const p of printers) assert.ok(!/purchase|residual|maintenance|useful/.test(Object.keys(p).join(',')), 'no economics field (control)');
    return Object.fromEntries(printers.map((p) => [p.id, p.price_group]));
  };
  const a = await groups(costed), b = await groups(bare);
  const changed = Object.keys(a).filter((id) => a[id] !== b[id]).map((id) => `${id}: ${a[id]} (owner costed the X1C) vs ${b[id]} (not)`);
  assert.deepEqual(changed, [], `a guest’s GET /api/print-quote/printers differs only by the owner’s private printer economics:\n  ${changed.join('\n  ')}`);
});
