/**
 * Slug rules and the money split.
 *
 * The fee split is checked against the database CHECK it has to satisfy:
 * `platform_fee_iqd + merchant_receivable_iqd = gross_iqd`, on
 * community_orders AND community_escrows. A rounding scheme that can be off
 * by one dinar does not produce a slightly wrong invoice here — it fails
 * every insert, and a customer's accepted offer dies at the last step. So the
 * identity is asserted over a wide sweep of amounts and rates, not a
 * hand-picked few.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { SqliteD1 } from './fixtures/d1';
import { checkSlug, suggestSlug, splitFee, feeFor, feeSettings, badgeFor } from '../worker/lib/merchantOps';

function db(): { raw: DatabaseSync; d1: D1Database } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return { raw, d1: new SqliteD1(raw) as unknown as D1Database };
}

function seedStore(raw: DatabaseSync, id: string, slug: string): void {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u_${id}','X','${id}@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m_${id}','u_${id}','M');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name)
      VALUES ('${id}','m_${id}','u_${id}','${slug}','S');
  `);
}

// ------------------------------------------------------------------ slugs

test('a slug must be shaped like a hostname before anything else is checked', async () => {
  const { d1 } = db();
  assert.equal((await checkSlug(d1, 'ab')).reason, 'too_short');
  assert.equal((await checkSlug(d1, 'x'.repeat(33))).reason, 'too_long');
  for (const bad of ['ali_3d', 'ali.3d', '-ali', 'ali-', 'ali--3d', 'xn--abc']) {
    const r = await checkSlug(d1, bad);
    assert.equal(r.ok, false, `accepted ${bad}`);
    assert.equal(r.reason, 'invalid_characters', `${bad} rejected for the wrong reason: ${r.reason}`);
  }
});

test('case is normalised, not rejected — and the caller is told what it will get', () => {
  // Hostnames are case-insensitive, so "Ali3D" is not an error. But it is not
  // what the merchant ends up with either, and the slug in the address bar is
  // identity rather than formatting — so checkSlug reports the value it would
  // actually store, and the UI shows that back before the merchant commits.
  return (async () => {
    const { d1 } = db();
    const r = await checkSlug(d1, '  Ali3D  ');
    assert.equal(r.ok, true);
    assert.equal(r.slug, 'ali3d', 'the stored slug must be the normalised one');
  })();
});

test('system names are refused even before the database is consulted', async () => {
  const { raw, d1 } = db();
  // Prove the code-level list is what refuses these, by emptying the table
  // first. A mid-migration or accidentally-truncated reserved_slugs must not
  // be able to hand a merchant a live service like studio.levonis-iq.com.
  raw.exec('DELETE FROM reserved_slugs');
  for (const s of ['studio', 'admin', 'api', 'www', 'mail', 'checkout']) {
    assert.equal((await checkSlug(d1, s)).reason, 'reserved', `${s} was available`);
  }
});

test('a name reserved only in the database is still refused', async () => {
  const { raw, d1 } = db();
  raw.exec("INSERT INTO reserved_slugs (slug,reason) VALUES ('newbrand','brand')");
  assert.equal((await checkSlug(d1, 'newbrand')).reason, 'reserved');
});

test('a live slug is taken — except by the store that already holds it', async () => {
  const { raw, d1 } = db();
  seedStore(raw, 'st1', 'ali3d');
  assert.equal((await checkSlug(d1, 'ali3d')).reason, 'taken');
  // Re-saving your own settings must not tell you your own name is taken.
  assert.equal((await checkSlug(d1, 'ali3d', 'st1')).ok, true);
});

test('a released slug is parked, and only the previous owner may take it back', async () => {
  const { raw, d1 } = db();
  seedStore(raw, 'st1', 'newname');
  const future = new Date(Date.now() + 86_400_000).toISOString();
  raw.exec(
    `INSERT INTO merchant_store_slugs (slug,store_id,active,reserved_until)
     VALUES ('oldname','st1',0,'${future}')`
  );
  // A competitor watching for the rename cannot capture the traffic.
  assert.equal((await checkSlug(d1, 'oldname')).reason, 'recently_released');
  // The store that released it can change its mind.
  assert.equal((await checkSlug(d1, 'oldname', 'st1')).ok, true);
});

test('once the reservation lapses the slug is free again', async () => {
  const { raw, d1 } = db();
  seedStore(raw, 'st1', 'newname');
  const past = new Date(Date.now() - 86_400_000).toISOString();
  raw.exec(
    `INSERT INTO merchant_store_slugs (slug,store_id,active,reserved_until)
     VALUES ('oldname','st1',0,'${past}')`
  );
  assert.equal((await checkSlug(d1, 'oldname')).ok, true);
});

test('a free, well-formed slug is available', async () => {
  const { d1 } = db();
  assert.equal((await checkSlug(d1, 'ali3d')).ok, true);
});

test('slug suggestions are only suggestions', () => {
  assert.equal(suggestSlug('Ali 3D'), 'ali-3d');
  assert.equal(suggestSlug('  Ali   3D  Printing!! '), 'ali-3d-printing');
  assert.equal(suggestSlug('علي ثري دي'), '', 'a non-Latin name transliterates to nothing usable');
  // Which is exactly why the caller must re-validate: '' fails checkSlug.
  assert.equal(suggestSlug('A'), 'a');
});

// -------------------------------------------------------------- money split

test('the fee and the receivable always sum back to the gross', () => {
  // The database CHECK requires this exactly. Sweep amounts and rates rather
  // than trusting a few round numbers — 1 IQD at 5% is where naive rounding
  // breaks.
  for (let gross = 0; gross <= 200_000; gross += 997) {
    for (const pct of [0, 1, 250, 500, 1234, 3333, 10_000]) {
      const s = splitFee(gross, pct);
      assert.equal(
        s.platform_fee_iqd + s.merchant_receivable_iqd,
        s.gross_iqd,
        `split does not sum at gross=${gross} pct=${pct}`
      );
      assert.ok(s.platform_fee_iqd >= 0 && s.merchant_receivable_iqd >= 0, 'a negative part');
      assert.ok(Number.isInteger(s.platform_fee_iqd), 'fee is not an integer number of dinars');
    }
  }
});

test('the documented example splits the way the mandate says', () => {
  // §30's worked example is 50,000 IQD -> 5,000 commission -> 45,000 to the
  // merchant. That is a 10% rate, which is the arithmetic being illustrated;
  // the mandate requires the rate to be CONFIGURABLE and never states one, so
  // it is asserted here as the rate that produces those numbers rather than
  // baked in as the platform's choice.
  const s = splitFee(50_000, 1_000);
  assert.equal(s.platform_fee_iqd, 5_000);
  assert.equal(s.merchant_receivable_iqd, 45_000);
});

test('a minimum fee never makes the merchant owe money', () => {
  // On a job smaller than the floor the platform takes the whole amount; the
  // receivable stops at zero rather than going negative and failing the
  // database CHECK.
  const s = splitFee(300, 500, 1_000);
  assert.equal(s.platform_fee_iqd, 300);
  assert.equal(s.merchant_receivable_iqd, 0);
  assert.equal(s.platform_fee_iqd + s.merchant_receivable_iqd, s.gross_iqd);
});

test('a fractional dinar is never invented — the fee floors, the merchant keeps the remainder', () => {
  const s = splitFee(101, 500); // 5.05 IQD
  assert.equal(s.platform_fee_iqd, 5);
  assert.equal(s.merchant_receivable_iqd, 96);
});

test('the commission comes from admin settings, and store and request rates are independent', async () => {
  const { raw, d1 } = db();
  const seeded = await feeSettings(d1);
  assert.equal(seeded.storePercentX100, 500, 'the seeded default is 5%');
  assert.equal(seeded.requestPercentX100, 500);

  raw.exec("UPDATE admin_settings SET value='250' WHERE key='communityFeeStorePercentX100'");
  raw.exec("UPDATE admin_settings SET value='1000' WHERE key='communityFeeRequestPercentX100'");

  const store = await feeFor(d1, 'store', 100_000);
  const request = await feeFor(d1, 'request', 100_000);
  assert.equal(store.platform_fee_iqd, 2_500, 'direct store sales use their own rate');
  assert.equal(request.platform_fee_iqd, 10_000, 'custom request work uses its own rate');
});

test('a corrupt or negative setting falls back to the default instead of charging nonsense', async () => {
  const { raw, d1 } = db();
  raw.exec("UPDATE admin_settings SET value='not a number' WHERE key='communityFeeStorePercentX100'");
  raw.exec("UPDATE admin_settings SET value='-50' WHERE key='communityFeeRequestPercentX100'");
  const s = await feeSettings(d1);
  assert.equal(s.storePercentX100, 500);
  assert.equal(s.requestPercentX100, 500);
});

// -------------------------------------------------------------- badges

test('a badge needs volume as well as a good rating', () => {
  // Five stars from two customers is a good start, not a track record.
  assert.equal(badgeFor({ completed_orders: 2, rating_avg_x100: 500, rating_count: 2, verified: 1 }), 'new');
  assert.equal(badgeFor({ completed_orders: 12, rating_avg_x100: 420, rating_count: 6, verified: 0 }), 'trusted');
  assert.equal(badgeFor({ completed_orders: 50, rating_avg_x100: 460, rating_count: 20, verified: 0 }), 'professional');
  assert.equal(badgeFor({ completed_orders: 120, rating_avg_x100: 480, rating_count: 50, verified: 1 }), 'elite');
  // Elite additionally requires admin verification — volume alone cannot buy it.
  assert.equal(badgeFor({ completed_orders: 120, rating_avg_x100: 480, rating_count: 50, verified: 0 }), 'professional');
});
