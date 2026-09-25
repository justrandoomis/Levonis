/**
 * REVIEW W2-5 p7 — THE WORKSPACE SEARCH IS NOT A PHONE ORACLE.
 *
 * GET /api/merchant/search matched customers on users.phone_e164 by
 * substring, so a merchant could rebuild a buyer's ACCOUNT phone digit by
 * digit (~50 queries) even when the buyer gave a different phone on every
 * order. Now only the phones the store was given on its own orders (the
 * address snapshot) are matched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, get, json } from './fixtures/app';
import { seedW2E, addOrder, appOf, OWNER } from './fixtures/merchantW2E';
import { merchantSearchRoutes } from '../worker/routes/merchantWorkspace';

function world() {
  const raw = seedW2E(freshDb());
  raw.exec(`UPDATE users SET phone_e164 = '+9647701234567' WHERE id = 'buyer'`);
  addOrder(raw, { id: 'O-1', user: 'buyer', total: 10000 });
  raw.exec(`UPDATE orders SET address_snapshot = '{"governorate":"baghdad","phone":"07809999999"}' WHERE id = 'O-1'`);
  const app = appOf(raw, OWNER, (a) => a.route('/api/merchant/search', merchantSearchRoutes));
  const hit = async (q: string) =>
    ((await json(await get(app, `/api/merchant/search?q=${encodeURIComponent(q)}`))).customers ?? []).some(
      (c: { name: string }) => c.name === 'Sara Ahmed'
    );
  return { hit };
}

test('the account phone is never matched — not a prefix, not the whole number', async () => {
  const { hit } = world();
  for (const q of ['7701', '770123', '7701234567', '+9647701234567', '07701234567']) assert.equal(await hit(q), false, q);
});

test('the digit-by-digit rebuild recovers nothing', async () => {
  const { hit } = world();
  let known = '';
  for (const seed of ['7701', '7702', '7711', '7801', '7501']) if (await hit(seed)) { known = seed; break; }
  while (known && known.length < 10) {
    let grew = false;
    for (let d = 0; d <= 9; d++) if (await hit(known + d)) { known += d; grew = true; break; }
    if (!grew) break;
  }
  assert.notEqual(known, '7701234567');
  assert.ok(!'7701234567'.startsWith(known) || known === '', `recovered a prefix: ${known}`);
});

test('the phone the customer gave THIS store on an order still finds them', async () => {
  const { hit } = world();
  assert.equal(await hit('0780 999'), true);
  assert.equal(await hit('+9647809999999'), true);
});
