/**
 * Scenario 2 (§23, gifts) over HTTP against the REAL local Worker and D1.
 * Every state is read back from the database as well as from the answers.
 */
import { BASE, TOKENS, sql } from './stack.mjs';
const REPO = process.argv[2];
let passed = 0, failed = 0, retries = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`FAIL  ${name} ${extra}`); } };
const call = async (who, method, path, body, attempt = 0) => {
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: { cookie: `levonis_session=${TOKENS[who]}`, 'content-type': 'application/json', origin: BASE, connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) { if (attempt) throw e; retries++; return call(who, method, path, body, 1); }
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
};
const one = (q) => sql(REPO, q)[0] ?? null;
const NOTE = 'تعويض عن تأخير الطلب السابق — ملاحظة داخلية';
const run = Date.now().toString(36);

// 1. The admin names level 3 and fills it with two real products.
let r = await call('owner', 'PUT', '/api/gifts/admin/levels/3', { name_ar: 'الهدية الذهبية', name_en: 'Gold gift', name_ckb: 'دیاریی زێڕین', description_ar: 'قطعة أصلية لطابعتك', description_en: 'A genuine part for your printer', description_ckb: 'پارچەیەکی ڕەسەن بۆ چاپکەرەکەت' });
check('level 3 named in three languages', r.status === 200 && r.data?.success, JSON.stringify(r).slice(0, 300));
const nozzle = await call('owner', 'POST', '/api/gifts/admin/levels/3/items', { productId: 'p_e2e_nozzle', saleType: 'direct_sale', optionValueIds: [], colorId: '' });
const plate = await call('owner', 'POST', '/api/gifts/admin/levels/3/items', { productId: 'p_e2e_plate', saleType: 'direct_sale', optionValueIds: [], colorId: '' });
check('two real store products in the level', nozzle.status === 200 && plate.status === 200, JSON.stringify([nozzle, plate]).slice(0, 400));

// 2. Grant Sara a level-3 gift with an internal note; a double press is one grant.
const grantBody = { userId: 'u_sara', mode: 'level', level: 3, reason: 'compensation', note: NOTE, idempotencyKey: `e2e-grant-${run}` };
r = await call('owner', 'POST', '/api/gifts/admin/grants', grantBody);
const r2 = await call('owner', 'POST', '/api/gifts/admin/grants', grantBody);
const giftId = r.data?.grant?.id;
check('granted once, whatever the double press', r.status === 200 && r2.data?.grant?.id === giftId && Number(one(`SELECT COUNT(*) n FROM gift_entitlements WHERE user_id='u_sara'`).n) === 1, JSON.stringify([r, r2]).slice(0, 300));
check('Sara is notified', Number(one(`SELECT COUNT(*) n FROM user_notifications WHERE user_id='u_sara' AND kind='gift_granted'`).n) === 1);

// 3. Sara sees it, without the internal note.
r = await call('sara', 'GET', '/api/gifts');
const raw = JSON.stringify(r.data);
let card = r.data?.gifts?.find((g) => g.id === giftId);
check('Sara sees GRANTED with the two choices', card?.status === 'GRANTED' && card?.choices?.length === 2, raw.slice(0, 300));
check('the internal note never reaches her', !raw.includes('ملاحظة داخلية'));

// 4. Choose, then redeem — once.
const itemId = card.choices.find((c) => c.product_id === 'p_e2e_nozzle')?.item_id ?? card.choices.find((c) => c.product_id === 'p_e2e_nozzle')?.id ?? nozzle.data?.item?.id;
r = await call('sara', 'POST', `/api/gifts/${giftId}/choose`, { itemId });
check('chosen: READY_TO_REDEEM', r.data?.gift?.status === 'READY_TO_REDEEM', JSON.stringify(r).slice(0, 300));
r = await call('sara', 'POST', `/api/gifts/${giftId}/redeem`, {});
check('redeemed: «تم استرداد الهدية»', r.data?.gift?.status === 'REDEEMED', JSON.stringify(r).slice(0, 300));
const [d1, d2] = await Promise.all([call('sara', 'POST', `/api/gifts/${giftId}/redeem`, {}), call('sara', 'POST', `/api/gifts/${giftId}/redeem`, {})]);
check('redeeming again (twice at once) changes nothing', [d1, d2].every((x) => x.status === 200 && x.data?.gift?.status === 'REDEEMED') && Number(one(`SELECT COUNT(*) n FROM gift_redemptions WHERE entitlement_id='${giftId}'`)?.n ?? 1) <= 1, JSON.stringify([d1.data, d2.data]).slice(0, 300));
r = await call('sara', 'POST', `/api/gifts/${giftId}/choose`, { itemId: card.choices.find((c) => c.product_id === 'p_e2e_plate')?.item_id ?? plate.data?.item?.id });
check('the choice is final after redemption', r.status === 409, JSON.stringify(r).slice(0, 200));

// 5. Into the cart at 0 — once.
r = await call('sara', 'POST', '/api/cart/gift-items', { giftId });
const giftLine = (r.data?.items ?? []).find((i) => i.kind === 'gift');
check('the gift line is in the cart at 0 IQD, locked', r.status === 200 && giftLine?.unit_price_iqd === 0 && giftLine?.locked === true, JSON.stringify(r).slice(0, 300));
r = await call('sara', 'POST', '/api/cart/gift-items', { giftId });
check('adding it again is the same line', r.data?.already_in_cart === true, JSON.stringify(r).slice(0, 200));

// 6. Checkout: the order is a gift order linked to the gift.
const prof = (await call('sara', 'GET', '/api/quick-buy/profile')).data?.profile?.required ?? {};
r = await call('sara', 'POST', '/api/orders', { addressId: 'addr_home', deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: `e2e-gift-checkout-${run}`, policyAcceptance: [{ key: 'terms', version: prof.terms }, { key: 'privacy', version: prof.privacy }] });
const order = r.data?.order;
check('the gift order is placed', r.status === 200 && !!order?.id, JSON.stringify(r).slice(0, 400));
const row = one(`SELECT order_kind, subtotal_iqd FROM orders WHERE id='${order?.id}'`);
check('order_kind gift, goods subtotal 0', row?.order_kind === 'gift' && Number(row?.subtotal_iqd) === 0, JSON.stringify(row));
check('the order line names the gift', Number(one(`SELECT COUNT(*) n FROM order_items WHERE order_id='${order?.id}' AND gift_entitlement_id='${giftId}'`).n) === 1);
check('the gift reserved its real stock', Number(one(`SELECT stock_reserved FROM products WHERE id='p_e2e_nozzle'`).stock_reserved) === 1);

// 7. Ordered: linked to the order, and nothing orders it twice — not even the API.
r = await call('sara', 'GET', '/api/gifts');
card = r.data?.gifts?.find((g) => g.id === giftId);
check('«تم طلب هذه الهدية» with the order number', card?.status === 'ORDERED' && card?.order?.id === order?.id, JSON.stringify(card).slice(0, 300));
r = await call('sara', 'POST', '/api/cart/gift-items', { giftId });
check('adding it to a cart again is refused: GIFT_ALREADY_ORDERED', r.data?.code === 'GIFT_ALREADY_ORDERED', JSON.stringify(r).slice(0, 200));
r = await call('sara', 'POST', `/api/gifts/${giftId}/redeem`, {});
check('a late redeem changes nothing', r.data?.gift?.status === 'ORDERED', JSON.stringify(r).slice(0, 200));
r = await call('sara', 'POST', '/api/orders', { addressId: 'addr_home', deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: `e2e-gift-checkout2-${run}`, policyAcceptance: [{ key: 'terms', version: prof.terms }, { key: 'privacy', version: prof.privacy }] });
check('a second checkout has nothing to order', r.status !== 200, JSON.stringify(r).slice(0, 200));
check('still exactly one order line for the gift', Number(one(`SELECT COUNT(*) n FROM order_items WHERE gift_entitlement_id='${giftId}'`).n) === 1);

// 8. The admin's timeline.
r = await call('owner', 'GET', `/api/gifts/admin/grants/${giftId}`);
const actions = (r.data?.audit ?? []).map((x) => x.action);
check('the audit timeline names every step', ['gift.grant', 'gift.choose', 'gift.redeem', 'gift.order'].every((a) => actions.includes(a)), JSON.stringify(actions));
check('the admin still sees the internal note', r.data?.grant?.note === NOTE);

console.log(`\n${passed} passed, ${failed} failed (${retries} dropped connection(s) retried)`);
process.exit(failed ? 1 : 0);
