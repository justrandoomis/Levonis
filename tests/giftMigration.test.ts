/**
 * MIGRATION 0175 KEEPS EVERY GIFT IT FOUND (docs/GIFTS_QUICK_BUY.md D1).
 *
 * `gift_entitlements` is the one table this feature rebuilds — SQLite cannot
 * widen a CHECK or drop a NOT NULL, and a manual grant has no review reward.
 * The rebuild must not touch a byte of what is already there: every legacy row
 * in each of its four states, with its `gift_redemptions` child (a NO ACTION
 * foreign key that a careless DROP leaves dangling), comes through unchanged
 * and reads as `grant_mode = 'legacy'`.
 *
 * The database is built through 0174 exactly as `wrangler d1 migrations apply`
 * left the live one, filled with legacy data, and 0175 is applied the way D1
 * applies a file: one transaction, foreign keys on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { all, dbThrough, row } from './fixtures/app';

const LEGACY_COLUMNS =
  'id, reward_id, user_id, max_level, chosen_level, chosen_options, contents, state, created_at, selected_at, fulfilled_at';

function seedLegacy(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u1','Sara','s@x.co','h','customer'), ('u2','Omar','o@x.co','h','customer');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('pr1','printer-1','Printer',900000), ('pr2','printer-2','Printer 2',900000);
    INSERT INTO reviews (id,user_id,product_id,stars,body,status) VALUES
      ('rv1','u1','pr1',5,'body one','published'), ('rv2','u1','pr2',5,'body two','published'),
      ('rv3','u2','pr1',5,'body three','published'), ('rv4','u2','pr2',4,'body four','published');
    INSERT INTO review_rewards (id,review_id,user_id,kind,state,quality_score) VALUES
      ('rr1','rv1','u1','printer_gift','approved',3), ('rr2','rv2','u1','printer_gift','approved',5),
      ('rr3','rv3','u2','printer_gift','approved',2), ('rr4','rv4','u2','printer_gift','approved',4);
    INSERT INTO gift_entitlements (id,reward_id,user_id,max_level,chosen_level,chosen_options,contents,state,created_at,selected_at,fulfilled_at) VALUES
      ('ge_avail','rr1','u1',3,NULL,'{}','[]','available','2026-08-01T10:00:00.000Z',NULL,NULL),
      ('ge_sel','rr2','u1',5,5,'{"nozzle_size":"0.4","plate_item_id":"gpi_p"}','[{"item_id":"gpi_n","kind":"nozzle","label_ar":"نوزل"}]','selected','2026-08-02T10:00:00.000Z','2026-08-03T11:00:00.123Z',NULL),
      ('ge_ful','rr3','u2',2,2,'{"nozzle_size":null}','[{"item_id":"gpi_f","kind":"filament","label_ar":"فلمنت"}]','fulfilled','2026-08-04T10:00:00.000Z','2026-08-05T10:00:00.000Z','2026-08-09T09:30:00.000Z'),
      ('ge_can','rr4','u2',4,NULL,'{}','[]','cancelled','2026-08-06T10:00:00.000Z',NULL,NULL);
    INSERT INTO gift_redemptions (entitlement_id,user_id,level,options,contents,created_at) VALUES
      ('ge_sel','u1',5,'{"nozzle_size":"0.4"}','[{"item_id":"gpi_n"}]','2026-08-03T11:00:00.123Z'),
      ('ge_ful','u2',2,'{}','[{"item_id":"gpi_f"}]','2026-08-05T10:00:00.000Z');
    INSERT INTO gift_pool_items (id,level,kind,label_ar,label_en,stock,active) VALUES
      ('gpi_n',4,'nozzle','نوزل','Nozzle',3,1), ('gpi_f',2,'filament','فلمنت','Filament',0,1);
  `);
}

function apply0175(raw: DatabaseSync) {
  // The way D1 applies one file: a single transaction with foreign keys on.
  raw.exec('BEGIN');
  try {
    raw.exec(readFileSync(join(ROOT, 'migrations', '0175_gift_lifecycle.sql'), 'utf8'));
    raw.exec('COMMIT');
  } catch (e) {
    raw.exec('ROLLBACK');
    throw e;
  }
}

test('0175 keeps every legacy gift byte for byte, in all four states, with its redemption rows', () => {
  const raw = dbThrough('0174');
  seedLegacy(raw);
  const before = all(raw, `SELECT ${LEGACY_COLUMNS} FROM gift_entitlements ORDER BY id`);
  const redemptionsBefore = all(raw, 'SELECT * FROM gift_redemptions ORDER BY entitlement_id');
  const itemsBefore = all(raw, 'SELECT * FROM gift_pool_items ORDER BY id');
  assert.equal(before.length, 4);

  apply0175(raw);

  assert.deepEqual(all(raw, `SELECT ${LEGACY_COLUMNS} FROM gift_entitlements ORDER BY id`), before, 'every original column, every row');
  assert.deepEqual(all(raw, 'SELECT * FROM gift_redemptions ORDER BY entitlement_id'), redemptionsBefore, 'the child rows came back');
  const itemsAfter = all<Record<string, unknown>>(raw, 'SELECT * FROM gift_pool_items ORDER BY id');
  for (const [i, it] of itemsBefore.entries()) {
    for (const [k, v] of Object.entries(it)) assert.deepEqual(itemsAfter[i][k], v, `gift_pool_items.${k} kept`);
    assert.equal(itemsAfter[i].product_id, null, 'a legacy item stays label-only');
  }
  for (const g of all<Record<string, unknown>>(raw, 'SELECT * FROM gift_entitlements')) {
    assert.equal(g.grant_mode, 'legacy');
    assert.equal(g.reason, 'legacy');
    assert.equal(g.level, null);
    assert.equal(g.version, 1);
    assert.equal(g.admin_note, '');
    assert.equal(g.order_seq, 0);
    assert.equal(g.gift_product_id, null);
  }
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling foreign key');
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '_mig0175_%'")!.n, 0, 'the stash is gone');
  assert.equal(
    row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_gift_entitlements_user'")!.n,
    1,
    'the user index was re-created'
  );
});

test('0175 seeds the five canonical levels and the three order triggers', () => {
  const raw = dbThrough('0174');
  apply0175(raw);
  const levels = all<{ id: string; level: number; active: number; name_ar: string; name_en: string; name_ckb: string }>(
    raw,
    "SELECT id, level, active, name_ar, name_en, name_ckb FROM gift_pools WHERE id LIKE 'gift_level_%' ORDER BY level"
  );
  assert.deepEqual(levels.map((l) => [l.id, l.level, l.active]), [1, 2, 3, 4, 5].map((n) => [`gift_level_${n}`, n, 1]));
  for (const l of levels) assert.ok(l.name_ar && l.name_en && l.name_ckb && l.name_ckb !== l.name_ar, `level ${l.level} is named in three languages`);
  const triggers = all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_orders_gift_%' ORDER BY name").map((t) => t.name);
  assert.deepEqual(triggers, ['trg_orders_gift_cancelled', 'trg_orders_gift_delivered', 'trg_orders_gift_reopen_guard', 'trg_orders_gift_undelivered']);
});

test('the rebuilt table refuses a state that does not belong to its mode, and a manual grant needs no reward', () => {
  const raw = dbThrough(null);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('pr1','printer-1','Printer',900000);
  `);
  // A manual level grant: no reward, a level, a reason.
  raw.exec(`INSERT INTO gift_entitlements (id,user_id,max_level,level,state,grant_mode,reason)
            VALUES ('g_ok','u1',3,3,'granted','level','compensation')`);
  const refuse = (sql: string, why: string) => assert.throws(() => raw.exec(sql), /CHECK|NOT NULL/, why);
  refuse(`INSERT INTO gift_entitlements (id,user_id,max_level,level,state,grant_mode,reason)
          VALUES ('g1','u1',3,3,'available','level','review')`, 'a new grant cannot hold a legacy state');
  refuse(`INSERT INTO gift_entitlements (id,user_id,max_level,state,grant_mode,reason)
          VALUES ('g2','u1',3,'granted','legacy','legacy')`, 'a legacy row cannot hold a new state');
  refuse(`INSERT INTO gift_entitlements (id,user_id,max_level,state) VALUES ('g3','u1',3,'available')`, 'a legacy row always has a reward');
  refuse(`INSERT INTO gift_entitlements (id,user_id,max_level,level,state,grant_mode,reason)
          VALUES ('g4','u1',3,3,'redeemed','level','review')`, 'nothing is redeemed without the frozen product');
  refuse(`INSERT INTO gift_entitlements (id,user_id,max_level,level,state,grant_mode,reason,gift_product_id,gift_sale_type)
          VALUES ('g5','u1',3,3,'ordered','product','review','pr1','direct_sale')`, 'an ordered gift names its order');
  refuse(`INSERT INTO gift_entitlements (id,user_id,max_level,level,state,grant_mode,reason,gift_product_id,gift_sale_type)
          VALUES ('g6','u1',3,3,'ready_to_redeem','product','review','pr1','pre_order')`, 'a pre-order gift travels on a route');
  refuse(`INSERT INTO gift_entitlements (id,user_id,max_level,level,state,grant_mode,reason)
          VALUES ('g7','u1',3,3,'granted','level','legacy')`, 'a new grant states why');
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements')!.n, 1);
});
