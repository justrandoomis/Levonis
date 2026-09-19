/**
 * «اجعله الان عام» — THE HALF OF THAT INSTRUCTION THAT WAS STILL SILENT.
 *
 * The owner named two things: «الباقات والفيلم العشوائي». The random filament
 * turned out never to have been gated at all — worker/routes/mystery.ts
 * defaults `required_tiers` to [], and worker/routes/bundles.ts computes
 * `entitled` but never filters a listing on it, so an ungated bundle is public
 * to a guest too.
 *
 * THE BUNDLES HALF IS NOT DONE, AND THE DATABASE IS WHY. Migration 0063
 * INSERTED `["plus","prime","pro"]` onto every MIGRATED bundle — every
 * `prd_bnd_*` subject — and those rows are still there. `offerEligible` still
 * turns a non-empty set into MEMBERSHIP_REQUIRED, re-asked independently by the
 * card, the cart and the checkout door. So the honest answer to "can a guest
 * buy it now?" is: for the filament yes, for a migrated bundle NO.
 *
 * Clearing those rows is a DATA UPDATE and belongs to the owner: it would
 * overwrite whatever an admin deliberately configured, and `required_tiers` is
 * the only mechanism that can express a members-only promotion at all. What
 * this file pins instead is that the surviving gate ANNOUNCES ITSELF on the
 * screen where it can be cleared — because the way an instruction like this one
 * gets quietly half-done is that the only place the tier set ever appeared was
 * two clicks deep inside one offer's eligibility tab.
 *
 * It is a WARNING, never a refusal. A refusal would destroy the ability the
 * warning exists to protect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp, type StubUser } from './fixtures/app';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import type { DatabaseSync } from 'node:sqlite';

const BOSS: StubUser = { id: 'usr_boss', role: 'admin', email: 'boss@x.co', admin_scope: null };

const BUNDLE = 'prd_bnd_legacy';

/** A migrated bundle, shaped the way migration 0063 left it: a composition
 *  product with an `offer_windows` row demanding all three paid tiers. */
function seed(gate: string[] | null): DatabaseSync {
  const raw = freshDb();
  raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, price_iqd, status, stock, composition)
     VALUES (?, 'legacy-bundle', 'Legacy bundle', 'باقة قديمة', 'پاکێجی کۆن', 300000, 'active', 5, 'bundle')`
  ).run(BUNDLE);
  if (gate) {
    raw.prepare(
      `INSERT INTO offer_windows (subject_type, subject_id, id, required_tiers, active)
       VALUES ('product', ?, 'ofw_bnd_legacy', ?, 1)`
    ).run(BUNDLE, JSON.stringify(gate));
  }
  return raw;
}

const adminApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), BOSS, (a) => a.route('/api/admin/bundles', adminBundlesRoutes));

test('a bundle still carrying 0063’s members-only gate says so on the list the owner opens', async () => {
  const raw = seed(['plus', 'prime', 'pro']);
  const body = await json(await get(adminApp(raw), '/api/admin/bundles'));
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 300));

  const row = (body.bundles as Record<string, unknown>[]).find((b) => b.id === BUNDLE);
  assert.ok(row, 'the migrated bundle is not on the list at all');

  // Published as its own key so the listing can FILTER on it, not only print it.
  assert.equal(row!.members_only, true);
  assert.deepEqual(row!.required_tiers, ['plus', 'prime', 'pro']);

  const notice = (row!.warning_details as Record<string, unknown>[]).find(
    (w) => w.code === 'BUNDLE_MEMBERS_ONLY_RESTRICTION'
  );
  assert.ok(notice, `the gate is not disclosed: ${JSON.stringify(row!.warnings)}`);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(String(notice![lang]).length > 20, `the notice has no real ${lang} sentence`);
  }
  // ckb is a LANGUAGE here, not a direction that resolves to Arabic.
  assert.notEqual(notice!.ar, notice!.ckb);
  // It names the tiers, or the owner cannot tell which switch to clear.
  assert.match(String(notice!.en), /PLUS/);

  // AND IT IS A WARNING, NOT A REFUSAL. The row is still returned, still
  // active, still editable — the ability to run a members-only promotion is
  // exactly what this notice is protecting.
  assert.equal(row!.status, 'active');
});

test('opening that bundle repeats the notice, so it is not a listing-only fact', async () => {
  const raw = seed(['plus', 'prime', 'pro']);
  const body = await json(await get(adminApp(raw), `/api/admin/bundles/${BUNDLE}`));
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 300));
  assert.ok(
    (body.warning_details as Record<string, unknown>[]).some(
      (w) => w.code === 'BUNDLE_MEMBERS_ONLY_RESTRICTION'
    ),
    'the admin who opened one bundle to ask why a guest cannot buy it is told nothing'
  );
});

test('a bundle with no gate carries no notice — the warning must not become wallpaper', async () => {
  for (const gate of [null, [] as string[]]) {
    const raw = seed(gate);
    const body = await json(await get(adminApp(raw), '/api/admin/bundles'));
    const row = (body.bundles as Record<string, unknown>[]).find((b) => b.id === BUNDLE)!;
    assert.equal(row.members_only, false, `gate ${JSON.stringify(gate)} is not a gate`);
    assert.deepEqual(row.required_tiers, []);
    assert.equal(
      (row.warning_details as Record<string, unknown>[]).some(
        (w) => w.code === 'BUNDLE_MEMBERS_ONLY_RESTRICTION'
      ),
      false,
      'a notice on every row is a notice nobody reads'
    );
  }
});
