/**
 * «عند تعبئة 50,000 وبعد موافقة التعبئة ظهر 49,994 دينار».
 *
 * Two shapes of the same deposit, both read off the live database on
 * 2026-09-24 (workflow «0 - Diagnose wallet dinars»):
 *
 *   before the 0108 deploy   cents=3571  amount_iqd=NULL   declared=50000 rate=1400
 *   after it                 cents=3571  amount_iqd=50000  rate=1400
 *
 * Both must read 50,000 on the wallet — the balance AND the row. And a tab
 * holding a rate other than the server's must not lose the typed figure: the
 * server now converts the typed dinars to cents itself (`dinarsToCents`), so
 * what is recorded is always what was typed.
 *
 * Run: node --import tsx --test tests/walletTypedDinarsAuthoritative.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, json, get } from './fixtures/app';
import { walletRoutes, dinarsToCents } from '../worker/routes/wallet';
import { productMediaFixtureEnv } from './fixtures/productMedia';

const RATE = 1400;

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
  `);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/wallet', walletRoutes), {
    env: productMediaFixtureEnv().env,
  });
  return { raw, db, app };
}

test('a deposit filed before 0108 — dinars only on the meta row — reads 50,000', async () => {
  const { raw, app } = setup();
  raw.exec(`
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,created_by)
      VALUES ('wtx_old','buyer','deposit','USD',3571,'approved','user');
    INSERT INTO wallet_deposit_meta (tx_id, user_id, declared_amount_cents, declared_amount_iqd, exchange_rate_snapshot)
      VALUES ('wtx_old', 'buyer', 3571, 50000, ${RATE});
  `);
  const body = (await json(await get(app, '/api/wallet'))) as { balance_iqd: number };
  assert.equal(body.balance_iqd, 50_000);
});

test('a deposit filed after 0108 — dinars on the ledger row — reads 50,000', async () => {
  const { raw, app } = setup();
  raw.exec(`
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,created_by,amount_iqd,exchange_rate_snapshot)
      VALUES ('wtx_new','buyer','deposit','USD',3571,'approved','user',50000,${RATE});
    INSERT INTO wallet_deposit_meta (tx_id, user_id, declared_amount_cents, declared_amount_iqd, exchange_rate_snapshot)
      VALUES ('wtx_new', 'buyer', 3571, 50000, ${RATE});
  `);
  const body = (await json(await get(app, '/api/wallet'))) as { balance_iqd: number };
  assert.equal(body.balance_iqd, 50_000);
});

test('the typed dinars are the request: a tab on another rate still files 50,000', () => {
  // The tab floored at 1,395 and sent 3,584 cents; the server's rate is 1,400.
  // Before, the pair failed corroboration and the typed figure was dropped.
  assert.equal(dinarsToCents(50_000, RATE), 3_571);
  assert.equal(dinarsToCents(0, RATE), null, 'no typed figure: keep the cents the client sent');
  assert.equal(dinarsToCents(50_000, 0), null, 'no rate: keep the cents the client sent');
  assert.equal(dinarsToCents(1_000, RATE), null, 'under one dollar is not a request');
});

test('both money routes convert the typed dinars themselves', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../worker/routes/wallet.ts', import.meta.url), 'utf8');
  assert.equal(
    (src.match(/dinarsToCents\(declaredAmountIqd, exchangeRate\) \?\? clientCents/g) || []).length,
    2,
    'the deposit AND the withdrawal route'
  );
});
