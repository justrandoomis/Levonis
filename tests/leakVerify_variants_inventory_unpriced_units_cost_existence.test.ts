/**
 * VARIANT VERIFY (DECISIONS row 219 port, fix/leak-port 5e6f581c) — #26
 * "logs-errors lot-count cost existence oracle".
 *
 * The port's rule, in its own words (worker/routes/adminStockOperations.ts):
 * «Whether the lot has a recorded cost is the owner's to know (DECISIONS row
 * 219): every other counter hears the same answer for a priced lot and an
 * unpriced one.» It removed `unknown_cost` from POST /lot-counts and
 * `unknown_cost_lines` from POST /counts/:id/post for non-owners.
 *
 * The same fact is still a COUNT on two GET routes of the same inventory
 * workspace that every admin reads (worker/routes/adminInventory.ts,
 * `requireAdmin` only):
 *
 *   GET /api/admin/inventory/overview   `unpriced_units`  — on-hand units whose lot has NO recorded cost
 *   GET /api/admin/inventory/lines      `lines[].unpriced_units` — the same, per product / option / colour
 *
 * `projectForAdmin` strips the value columns beside them
 * (`inventory_value_iqd`, `oldest_unit_cost_iqd`…), but `unpriced_units` is not
 * a FINANCIAL_FIELD, so an assistant (and every other non-owner scope) reads
 * exactly which lots the owner has costed. A third door of the same workspace,
 * GET /api/admin/inventory/incoming/:id/receive-preview, answers `ok:false,
 * code:'COST_NOT_STATED', missing:[…]` naming which freight costs of a
 * purchase the owner has not entered.
 *
 * Method (the audit's own, tests/leakAudit_logs-errors_lot_count_cost_existence_oracle):
 * two copies of the role-matrix database that differ ONLY in the owner's
 * private data — lot1's cost recorded vs not, inc1's freight stated vs not —
 * and the SAME GET as each non-owner admin. Any difference in the answer is a
 * private fact reaching them.
 *
 * LOCAL ONLY: role-matrix SQLite copies, the real router, no network.
 * FIXED (DECISIONS row 219, verification pass): `unpriced_units` is now a
 * FINANCIAL_FIELD (both lists), so `projectForAdmin` strips it for everyone
 * but the owner; the receive door tells a non-owner only that the purchase
 * waits for the owner (RECEIVE_AWAITS_OWNER), never which cost is missing.
 *
 * Run: node --import tsx --test tests/leakVerify_variants_inventory_unpriced_units_cost_existence.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { withoutTriggers } from './fixtures/app';
import { ADMIN_ROLES, OWNER, ROLES, appFor, call, seededCopy } from './fixtures/roleMatrix';

/** The owner has not (yet) recorded lot1's cost, nor inc1's freight. Nothing else differs. */
function uncosted(): DatabaseSync {
  const raw = seededCopy();
  const triggers = (raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name IN ('inventory_lots','inventory_lot_cost_versions','incoming_inventory'))").all() as Array<{ name: string }>).map((t) => t.name);
  withoutTriggers(raw, triggers, `
    UPDATE inventory_lots SET unit_cost_iqd = NULL, total_cost_iqd = NULL WHERE id = 'lot1';
    DELETE FROM inventory_lot_cost_versions WHERE lot_id = 'lot1';
    UPDATE incoming_inventory SET shipping_total_iqd = NULL, internal_delivery_total_iqd = NULL WHERE id = 'inc1';
  `);
  return raw;
}

const PATHS = ['/api/admin/inventory/overview', '/api/admin/inventory/lines'];
const PREVIEW = '/api/admin/inventory/incoming/inc1/receive-preview?qty=1';

test('a non-owner admin’s inventory answers do not differ by whether the owner recorded a cost', async () => {
  const costed = seededCopy();
  const bare = uncosted();
  const found: string[] = [];
  for (const role of ADMIN_ROLES) {
    for (const path of PATHS) {
      const a = await call(appFor(costed, ROLES[role]), 'GET', path);
      const b = await call(appFor(bare, ROLES[role]), 'GET', path);
      // Positive control: both worlds answered the route (no refusal hides the difference).
      assert.equal(a.status, 200, `${role} ${path} (costed) → ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
      assert.equal(b.status, 200, `${role} ${path} (uncosted) → ${b.status} ${JSON.stringify(b.body).slice(0, 200)}`);
      const ja = JSON.stringify(a.body), jb = JSON.stringify(b.body);
      if (ja !== jb) {
        const pick = (body: unknown) => {
          const o = body as Record<string, unknown>;
          if ('unpriced_units' in o) return `unpriced_units=${o.unpriced_units}`;
          if (Array.isArray(o.lines)) return `lines[].unpriced_units=${(o.lines as Array<Record<string, unknown>>).map((l) => l.unpriced_units).join(',')}`;
          return ja.slice(0, 120);
        };
        found.push(`${role} GET ${path}: owner costed → ${pick(a.body)} | owner did not → ${pick(b.body)}`);
      }
    }
  }
  assert.deepEqual(found, [], `non-owner admins learn whether the owner recorded a cost:\n  ${found.join('\n  ')}`);
  // Control: the owner still reads how many units sit in unpriced lots.
  const own = await call(appFor(bare, OWNER), 'GET', '/api/admin/inventory/overview');
  assert.ok(Number((own.body as Record<string, unknown>).unpriced_units) > 0, JSON.stringify(own.body).slice(0, 300));
});

/**
 * THE RECEIVE PREVIEW. A purchase whose freight is not stated cannot be
 * received (a receipt freezes the lot's cost), so whoever would press
 * «استلام» must hear that it is not ready — that much is the door's job, not
 * a cost. What it must not hear is WHICH cost is missing, or that it is a
 * cost at all (it said `COST_NOT_STATED`, missing: shipping /
 * internal_delivery): anyone but the owner now reads one answer,
 * RECEIVE_AWAITS_OWNER, with no list.
 */
test('the receive preview tells a non-owner only that the purchase waits for the owner — never which cost is missing', async () => {
  const bare = uncosted();
  for (const role of ADMIN_ROLES) {
    const r = await call(appFor(bare, ROLES[role]), 'GET', PREVIEW);
    assert.equal(r.status, 200, `${role}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const b = r.body as Record<string, unknown>;
    assert.equal(b.ok, false, role);
    assert.equal(b.code, 'RECEIVE_AWAITS_OWNER', `${role}: ${JSON.stringify(b)}`);
    assert.equal('missing' in b, false, `${role}: names the missing cost ${JSON.stringify(b)}`);
    assert.doesNotMatch(JSON.stringify(b), /shipping|internal_delivery|COST_NOT_STATED|تكلفة|cost/i, role);
  }
  // Control: the owner reads which boxes are blank, as before.
  const own = await call(appFor(bare, OWNER), 'GET', PREVIEW);
  assert.equal((own.body as Record<string, unknown>).code, 'COST_NOT_STATED', JSON.stringify(own.body));
});
