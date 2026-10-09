/**
 * THE OWNER'S EXCHANGE-RATE BELL (FX programme plan §12 "The owner bell",
 * critique F15).
 *
 * It goes to the VERIFIED owner only — the admin row holding
 * INITIAL_ADMIN_EMAIL with a verification stamp — never to an unverified
 * owner row, a customer holding the address, or another admin; never by
 * address alone. It carries NO figure: no digit in any language. Each ring has
 * an event key, so a retried run never rings twice. Its Sorani is Sorani.
 *
 * Run: node --import tsx --test tests/fxNotify.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, all } from './fixtures/app';
import { FX_NOTICE_BODY, FX_NOTICE_TITLE, fxNoticeText, notifyOwnerFx, verifiedOwnerId } from '../worker/lib/fx/notify';
import type { Env } from '../worker/lib/types';
import type { FxAttention } from '../worker/lib/fx/decide';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;
const env = (raw: ReturnType<typeof freshDb>) => ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'Boss@X.co ' }) as unknown as Env;

test('to the verified owner only — not an unverified owner row, not a customer holding the address, not another admin', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES
    ('u_cust','C','boss@x.co','h','customer','2026-01-01T00:00:00.000Z'),
    ('u_admin','A','other@x.co','h','admin','2026-01-01T00:00:00.000Z')`);
  assert.equal(await verifiedOwnerId(env(raw)), null);
  raw.exec("INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('u_unverified','O','boss2@x.co','h','admin','   ')");
  assert.equal(await verifiedOwnerId({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss2@x.co' } as Env), null, 'a blank stamp is no stamp');
  raw.exec("UPDATE users SET role = 'admin' WHERE id = 'u_cust'");
  assert.equal(await verifiedOwnerId(env(raw)), 'u_cust', 'the owner, by the verified admin row');
  await notifyOwnerFx(env(raw), [{ pair: 'USD_IQD', kind: 'review', key: 'fx:USD_IQD:review:k1' }]);
  assert.deepEqual(all(raw, "SELECT user_id FROM user_notifications WHERE kind = 'fx_attention'"), [{ user_id: 'u_cust' }]);
  assert.equal((await verifiedOwnerId({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: '' } as Env)), null, 'no owner address, no bell');
});

test('the same ring twice is one notification (event key)', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('usr_owner','O','boss@x.co','h','admin','2026-01-01T00:00:00.000Z')");
  const a: FxAttention = { pair: 'EUR_USD', kind: 'failing', key: 'fx:EUR_USD:failing:2026-10-08' };
  await notifyOwnerFx(env(raw), [a]);
  await notifyOwnerFx(env(raw), [a]);
  assert.equal(all(raw, "SELECT id FROM user_notifications WHERE kind = 'fx_attention'").length, 1);
});

test('no figure in any language: no digit at all, in every reason and every pair; real Sorani', () => {
  for (const pair of ['USD_IQD', 'EUR_USD', 'CNY_USD'] as const) {
    for (const kind of Object.keys(FX_NOTICE_BODY) as FxAttention['kind'][]) {
      const t = fxNoticeText({ pair, kind });
      for (const [k, v] of Object.entries(t)) assert.doesNotMatch(v, /[0-9٠-٩۰-۹]/, `${pair} ${kind} ${k}`);
      assert.notEqual(t.body_ckb, t.body_ar);
      assert.match(t.body_ckb, SORANI_ONLY);
      assert.doesNotMatch(t.body_ckb, ARABIC_ONLY, `${pair} ${kind}: an Arabic-only letter in the Sorani`);
      assert.doesNotMatch(t.body_en, /[؀-ۿ]/);
    }
  }
  assert.match(FX_NOTICE_TITLE.ckb, SORANI_ONLY);
  assert.doesNotMatch(FX_NOTICE_TITLE.ckb, ARABIC_ONLY);
});
