/**
 * Referral 9.1 — "one qualifying purchase per friend" must hold at checkout,
 * not only after delivery.
 *
 * The reward row that marks the purchase as used is written when the order is
 * DELIVERED. A printer shipped from abroad is delivered weeks later, and every
 * printer order the friend placed in between also went out with free delivery.
 * Migration 0049 records the referral waiver on the order itself, and the
 * checkout check now reads it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1, createTableSql } from './fixtures/d1';
import { referralFreeDeliveryApplies } from '../worker/lib/membershipOps';
import type { Env } from '../worker/lib/types';

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
  // product_catalogs references products(id); node:sqlite enforces foreign keys.
  raw.exec('CREATE TABLE products (id TEXT PRIMARY KEY)');
  raw.prepare("INSERT INTO products (id) VALUES ('p_printer')").run();
  raw.exec(createTableSql('0001_init.sql', 'orders'));
  raw.exec(createTableSql('0002_products_memberships.sql', 'referral_attributions'));
  raw.exec(createTableSql('0002_products_memberships.sql', 'referral_rewards'));
  raw.exec(createTableSql('0002_products_memberships.sql', 'catalogs'));
  raw.exec(createTableSql('0002_products_memberships.sql', 'product_catalogs'));
  // 0049 also touches coupon_redemptions (index + trigger); the file is applied whole.
  raw.exec(createTableSql('0002_products_memberships.sql', 'coupons'));
  raw.exec(createTableSql('0002_products_memberships.sql', 'coupon_redemptions'));
  raw.exec(readFileSync(join(ROOT, 'migrations', '0049_security_hardening.sql'), 'utf8'));
  for (const u of ['ref', 'friend']) raw.prepare('INSERT INTO users (id) VALUES (?)').run(u);
  raw.prepare("INSERT INTO referral_attributions (id, referrer_id, referred_id, campaign) VALUES ('a1','ref','friend','printer')").run();
  raw.prepare("INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_printers','printers','طابعات',1)").run();
  raw.prepare("INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_printer','cat_printers',1)").run();
  const env = { DB: new SqliteD1(raw) } as unknown as Env;
  return { raw, env };
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function order(raw: DatabaseSync, id: string, status: string, referralWaived: number) {
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, referral_delivery_waived, created_at, updated_at)
       VALUES (?, 'friend', ?, '{}', 'standard', '{}', 'cash', 10000, 0, 1400, 10000, 10000, ?, ${NOW}, ${NOW})`
    )
    .run(id, status, referralWaived);
}

test('the first printer order of a referred friend qualifies', async () => {
  const { env } = freshDb();
  assert.equal(await referralFreeDeliveryApplies(env, 'friend', ['p_printer']), true);
  assert.equal(await referralFreeDeliveryApplies(env, 'friend', ['p_other']), false, 'not a printer');
  assert.equal(await referralFreeDeliveryApplies(env, 'ref', ['p_printer']), false, 'the referrer is not the friend');
});

test('THE WINDOW: an undelivered order that already carries the waiver spends it', async () => {
  const { raw, env } = freshDb();
  order(raw, 'o1', 'pending', 1);
  assert.equal(await referralFreeDeliveryApplies(env, 'friend', ['p_printer']), false);
});

test('a cancelled order gives the waiver back; an ordinary waived order does not count', async () => {
  const { raw, env } = freshDb();
  order(raw, 'o1', 'cancelled', 1);
  assert.equal(await referralFreeDeliveryApplies(env, 'friend', ['p_printer']), true);
  // PRO/PRIME waivers are recorded in delivery_waived, not here.
  order(raw, 'o2', 'pending', 0);
  assert.equal(await referralFreeDeliveryApplies(env, 'friend', ['p_printer']), true);
});

test('after delivery the reward row keeps the rule, as before', async () => {
  const { raw, env } = freshDb();
  raw.prepare("INSERT INTO referral_rewards (id, campaign, referrer_id, referred_id, source_ref, state) VALUES ('rw','printer','ref','friend','o1','pending')").run();
  assert.equal(await referralFreeDeliveryApplies(env, 'friend', ['p_printer']), false);
});
