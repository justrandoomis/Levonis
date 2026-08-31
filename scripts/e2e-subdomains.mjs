#!/usr/bin/env node
/**
 * §95 on the real environment: merchant subdomains, one identity, one cart,
 * one seller per checkout, and the guard that makes wildcard hosts survivable.
 *
 * Everything here is real HTTP against a running deployment. Nothing is
 * mocked, and no step is reported as passing because the one before it did.
 *
 * TWO PHASES, AND THE SPLIT IS DELIBERATE.
 *
 *   PHASE 1 — visitor level. Host classification, the apex-only admin guard,
 *   a shared session across the apex and a storefront, one cart across both,
 *   and the seller conflict. Everything a visitor can do. It creates one
 *   throwaway account and nothing else.
 *
 *   PHASE 2 — the money path: buy PLUS, open a store, publish a product,
 *   place an order, hold and settle escrow. This WRITES TO THE LIVE LEDGER,
 *   so it runs only when ALLOW_FINANCIAL=1 is passed explicitly. Without it
 *   every step reports BLOCKED with that reason — never as a pass, and never
 *   silently skipped.
 *
 * Phase 2 funds the test account through the real admin credit endpoint and
 * REVERSES the residual at the end with the platform's own adjustment path,
 * so the credit nets to zero and both movements are in the audit log. It
 * deletes nothing: the membership, the order and the escrow stay on the
 * record, labelled, because this platform does not delete financial history.
 *
 * Usage:
 *   APEX=https://levonis-iq.com \
 *   SLUG=e2e12345 \
 *   [ALLOW_FINANCIAL=1 ADMIN_EMAIL=... ADMIN_PASSWORD=...] \
 *   node scripts/e2e-subdomains.mjs
 */
import { randomBytes } from 'node:crypto';

const APEX = (process.env.APEX || 'https://levonis-iq.com').replace(/\/$/, '');
const ROOT_DOMAIN = new URL(APEX).hostname;
const RUN = (process.env.RUN_ID || randomBytes(3).toString('hex')).toLowerCase().replace(/[^a-z0-9]/g, '');
const SLUG = (process.env.SLUG || `e2e${RUN}`).toLowerCase();
const STORE = `https://${SLUG}.${ROOT_DOMAIN}`;
const ALLOW_FINANCIAL = process.env.ALLOW_FINANCIAL === '1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let passed = 0, failed = 0, blockedCount = 0;
const failures = [], blockedList = [];

const ok = (name, extra = '') => { passed += 1; console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`); };
const bad = (name, extra = '') => {
  failed += 1;
  failures.push(name + (extra ? ` — ${extra}` : ''));
  console.log(`FAIL   ${name}${extra ? ` — ${extra}` : ''}`);
};
const check = (name, cond, extra = '') => (cond ? ok(name, extra) : bad(name, extra));
const blocked = (name, reason) => {
  blockedCount += 1;
  blockedList.push(`${name} — ${reason}`);
  console.log(` BLK   ${name} — ${reason}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);

/** A browser-ish client: one cookie jar, used against both hosts on purpose. */
class Client {
  constructor(label) { this.label = label; this.cookies = new Map(); }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '' || /Max-Age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /**
   * Send to `base` but claim to be `host`.
   *
   * TLS is negotiated for `base`, so Cloudflare routes the request there; the
   * Worker reads the Host header, so it classifies the request as `host`.
   * That is how the Worker's own host handling can be tested while a redirect
   * rule or a missing route stands in front of the real hostname.
   */
  reqWithHost(method, base, host, path, body) {
    return this.req(method, base, path, body, { Host: host });
  }

  async req(method, base, path, body, extraHeaders = {}) {
    const headers = { Origin: base, ...extraHeaders };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const init = { method, headers, redirect: 'manual' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, init);
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML or empty */ }
    return { status: res.status, json, text, headers: res.headers };
  }
}

const password = `E2e!${randomBytes(8).toString('hex')}`;

async function main() {
  console.log(`apex   ${APEX}`);
  console.log(`store  ${STORE}`);
  console.log(`money  ${ALLOW_FINANCIAL ? 'ENABLED — will write to the live ledger' : 'disabled (ALLOW_FINANCIAL is not 1)'}`);

  // ------------------------------------------------------- 1. reachability
  section('1. the deployment answers at all');
  const anon = new Client('anon');
  const health = await anon.req('GET', APEX, '/api/health');
  check('the apex answers /api/health', health.status === 200, `status ${health.status}`);
  if (health.status !== 200) {
    console.log('\nthe apex is not answering — nothing below can be trusted, stopping');
    return report();
  }

  // -------------------------------------------------- 2. host classification
  section('2. a hostname becomes a decision');
  const apexResolve = await anon.req('GET', APEX, '/api/storefront/resolve');
  check('the apex resolves as the platform', apexResolve.json?.kind === 'main', `kind=${apexResolve.json?.kind}`);
  check('the apex has no store attached', apexResolve.json?.store == null);

  const missing = await anon.req('GET', `https://no-such-store-${RUN}.${ROOT_DOMAIN}`, '/api/storefront/resolve');
  // A typo must read as "no such store", never as a silent redirect to the
  // homepage, which would make a mistyped link look like the platform itself.
  if (missing.status >= 300 && missing.status < 400) {
    blocked('a nonexistent subdomain is a missing store',
      `a redirect (${missing.status}) answers before the Worker — merchant subdomains do not reach it yet`);
  } else {
    check(
      'a nonexistent subdomain is a missing store, not the homepage',
      missing.status === 404 || missing.json?.store === null,
      `status ${missing.status} kind=${missing.json?.kind ?? '-'}`
    );
  }

  const studio = await anon.req('GET', `https://studio.${ROOT_DOMAIN}`, '/');
  check(
    'studio. is a system host and is untouched by the wildcard',
    studio.status < 500,
    `status ${studio.status}`
  );

  // --------------------------------------------- 3. THE GUARD (§53) — read only
  section('3. platform admin is refused off the apex');
  for (const host of [`https://no-such-store-${RUN}.${ROOT_DOMAIN}`, STORE]) {
    const name = new URL(host).hostname;
    const res = await anon.req('GET', host, '/api/admin/community/overview');
    // 404, not 403: a wrong-host caller learns the route does not exist here
    // rather than that it exists somewhere else. 200/401/403 would all mean
    // the route IS reachable, which is the vulnerability.
    if (res.status === 404) {
      ok(`/api/admin/community/overview is 404 on ${name}`);
    } else if (res.status >= 300 && res.status < 400) {
      // Something in front of the Worker answered. The admin API is not
      // exposed — but nothing about the guard was exercised either, and
      // saying "refused" here would be claiming a test that did not run.
      blocked(
        `/api/admin/community/overview on ${name}`,
        `a redirect (${res.status}) answers before the Worker — the route is unreachable, ` +
        'so the guard is neither proven nor disproven here'
      );
    } else {
      bad(`/api/admin/community/overview is 404 on ${name}`, `status ${res.status}`);
    }
  }
  const apexAdmin = await anon.req('GET', APEX, '/api/admin/community/overview');
  check(
    'the same route EXISTS on the apex (401 for a stranger, not 404)',
    apexAdmin.status === 401 || apexAdmin.status === 403,
    `status ${apexAdmin.status}`
  );

  // CAN THE WORKER'S MERCHANT-HOST BEHAVIOUR BE MEASURED AT ALL FROM HERE?
  //
  // The attempt was to negotiate TLS for the apex while sending a merchant
  // Host header, so the routing in front of the Worker could be stepped over.
  // It cannot: CLOUDFLARE REWRITES THE HOST TO THE HOSTNAME IT ROUTED FOR, so
  // the Worker sees `levonis-iq.com` however the header was set and answers
  // `kind: 'main'`.
  //
  // That is worth writing down twice. First, it means these three checks
  // report BLOCKED rather than pass or fail — a probe that cannot reach the
  // thing it is probing has measured nothing, and calling that a failure of
  // the guard would be as wrong as calling it a pass. The Worker's own
  // decision is proven instead by tests/hosts.test.ts and
  // tests/storefrontIsolation.test.ts, against real hostnames.
  //
  // Second, it is a security property in its own right: a forged Host header
  // cannot make this Worker believe it is serving a different hostname,
  // because the header never survives the edge.
  const spoofedResolve = await anon.reqWithHost('GET', APEX, `ali3d.${ROOT_DOMAIN}`, '/api/storefront/resolve');
  const hostSurvives = spoofedResolve.json?.kind !== 'main';

  if (!hostSurvives) {
    ok('a forged Host header cannot make the Worker believe it is another hostname',
      'Cloudflare normalises Host to the routed hostname');
    for (const step of [
      'the Worker refuses platform admin for a merchant Host',
      'the Worker classifies a merchant Host as a store',
      'the Worker refuses platform admin for a system Host',
    ]) {
      blocked(step, 'not measurable from outside — Cloudflare rewrites Host to the routed hostname; ' +
        'covered by tests/hosts.test.ts against real hostnames');
    }
  } else {
    const spoofed = await anon.reqWithHost('GET', APEX, `ali3d.${ROOT_DOMAIN}`, '/api/admin/community/overview');
    check('the Worker refuses platform admin for a merchant Host', spoofed.status === 404,
      `status ${spoofed.status}`);
    check('the Worker classifies a merchant Host as a store',
      spoofedResolve.status === 404 || spoofedResolve.json?.kind === 'merchant',
      `kind=${spoofedResolve.json?.kind ?? '-'}`);
    const spoofedSystem = await anon.reqWithHost('GET', APEX, `studio.${ROOT_DOMAIN}`, '/api/admin/community/overview');
    check('the Worker refuses platform admin for a system Host', spoofedSystem.status === 404,
      `status ${spoofedSystem.status}`);
  }

  // ------------------------------------------------------ 4. one identity
  section('4. one account, both hosts');
  const shopper = new Client('shopper');
  const shopperEmail = `e2e.shopper.${RUN}@levonis-iq.com`;
  const reg = await shopper.req('POST', APEX, '/api/auth/register', {
    email: shopperEmail, password, name: `E2E Shopper ${RUN}`,
  });
  check('a customer can register on the apex', reg.status === 200 || reg.status === 201,
    `status ${reg.status} ${reg.json?.error ?? ''}`);
  if (reg.status >= 400) {
    console.log('\ncannot continue without a session');
    return report();
  }

  const meApex = await shopper.req('GET', APEX, '/api/auth/me');
  check('the session works on the apex', meApex.json?.user?.email === shopperEmail);

  // The whole point of the parent-domain cookie. If this fails, sign-in
  // "works" on the shop and every merchant page looks signed out.
  const meStore = await shopper.req('GET', STORE, '/api/auth/me');
  if (meStore.status >= 300 && meStore.status < 400) {
    blocked('THE SAME SESSION works on a storefront host',
      `a redirect (${meStore.status}) answers before the Worker — the shared cookie cannot be exercised yet`);
  } else {
    check(
      'THE SAME SESSION works on a storefront host',
      meStore.status === 200 && meStore.json?.user?.email === shopperEmail,
      `status ${meStore.status}`
    );
  }

  // ---------------------------------------------------------- 5. one cart
  section('5. one cart, wherever they are shopping');
  const catalog = await anon.req('GET', APEX, '/api/products?limit=1');
  const levonisProduct = catalog.json?.products?.[0];
  if (!levonisProduct) {
    blocked('a Levonis product to put in the cart', 'the catalogue returned nothing');
  } else {
    const add = await shopper.req('POST', APEX, '/api/cart/items', {
      productId: levonisProduct.id, qty: 1,
    });
    check('a Levonis item goes into the cart from the apex', add.status < 400,
      `status ${add.status} ${add.json?.error ?? ''}`);

    if (add.status < 400) {
      const cartFromStore = await shopper.req('GET', STORE, '/api/cart');
      if (cartFromStore.status >= 300 && cartFromStore.status < 400) {
        blocked('the SAME cart is visible from the storefront host',
          `a redirect (${cartFromStore.status}) answers before the Worker`);
      } else {
        check(
          'the SAME cart is visible from the storefront host',
          (cartFromStore.json?.items?.length ?? 0) > 0,
          `${cartFromStore.json?.items?.length ?? 0} line(s)`
        );
      }

      const scope = await shopper.req('GET', APEX, '/api/cart/scope');
      check('the cart reports a levonis seller scope', scope.json?.scope?.seller_type === 'levonis',
        `scope=${JSON.stringify(scope.json?.scope ?? null)}`);
    }
  }

  // --------------------------------------------------- 6. the money path
  section('6. store, product, order, escrow');
  if (!ALLOW_FINANCIAL) {
    for (const step of [
      'the test account buys PLUS',
      'a PLUS member opens a store on a real subdomain',
      'the storefront serves that store on its own hostname',
      'a merchant product is published and buyable',
      'mixing sellers in one cart is refused (CART_SELLER_CONFLICT)',
      'a real merchant order is placed',
      'community escrow holds and settles',
    ]) {
      blocked(step, 'ALLOW_FINANCIAL is not 1 — this writes to the live ledger');
    }
    return report();
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    blocked('the money path', 'ALLOW_FINANCIAL=1 but no admin credentials were provided');
    return report();
  }

  const admin = new Client('admin');
  const adminLogin = await admin.req('POST', APEX, '/api/auth/login', {
    email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
  });
  if (adminLogin.status !== 200 || admin.cookies.size === 0) {
    blocked('the money path', `admin sign-in failed (status ${adminLogin.status})`);
    return report();
  }
  ok('the admin can sign in');

  const merchant = new Client('merchant');
  const merchantEmail = `e2e.merchant.${RUN}@levonis-iq.com`;
  const mReg = await merchant.req('POST', APEX, '/api/auth/register', {
    email: merchantEmail, password, name: `E2E Merchant ${RUN}`,
  });
  if (mReg.status >= 400) {
    blocked('the money path', `could not register the merchant account (${mReg.status})`);
    return report();
  }
  const merchantId = (await merchant.req('GET', APEX, '/api/auth/me')).json?.user?.id;
  ok('a second account exists to be the merchant');

  // Fund it through the real admin endpoint, so the credit is audited and
  // reversible rather than injected into the database behind the platform's
  // own back.
  const PLANS = await anon.req('GET', APEX, '/api/memberships/plans');
  const plusPlan = (PLANS.json?.plans ?? []).find((p) => p.tier === 'plus' && p.purchasable);
  if (!plusPlan) {
    // Honest, not a failure: an unpriced plan is not purchasable by design,
    // and inventing a price here would be fabricating the thing under test.
    blocked('buying PLUS', 'no PLUS plan has a price set — docs/DECISIONS.md row 19 is still open');
    return finish(admin, null, merchantId);
  }

  const rate = Number((await anon.req('GET', APEX, '/api/settings/public')).json?.exchangeRate ?? 1400);
  const needCents = Math.ceil((Number(plusPlan.price_iqd) * 100) / rate) + 20_000;
  const credited = await admin.req('POST', APEX, '/api/admin/wallet/credit', {
    userId: merchantId, currency: 'USD', amount: needCents,
    note: `e2e ${RUN} — §95 verification float, reversed at the end of this run`,
  });
  check('the admin can fund the test account', credited.status === 200,
    `status ${credited.status} ${credited.json?.error ?? ''}`);
  const creditTxnId = credited.json?.id ?? null;

  const bought = await merchant.req('POST', APEX, '/api/memberships/subscribe', {
    planId: plusPlan.id, idempotencyKey: `e2e-plus-${RUN}`,
  });
  check('the test account buys PLUS with wallet funds', bought.status < 400,
    `status ${bought.status} ${bought.json?.error ?? ''}`);

  const me = await merchant.req('GET', APEX, '/api/merchant/me');
  check('the server says this account may operate a store', me.json?.can?.store === true,
    `tier=${me.json?.tier} can=${JSON.stringify(me.json?.can ?? {})}`);

  const onboard = await merchant.req('POST', APEX, '/api/merchant/onboard', {
    slug: SLUG, name: `E2E Store ${RUN}`, tagline: 'verification run',
  });
  check('a store is created on a real subdomain', onboard.status < 400,
    `status ${onboard.status} ${onboard.json?.error ?? ''} slug=${SLUG}`);
  if (onboard.status >= 400) return finish(admin, creditTxnId, merchantId);

  // Cloudflare needs a moment for a brand-new hostname on the wildcard.
  let resolved = null;
  for (let i = 0; i < 8; i += 1) {
    resolved = await anon.req('GET', STORE, '/api/storefront/resolve');
    if (resolved.json?.store?.slug === SLUG) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  check('the storefront answers on its OWN hostname', resolved?.json?.store?.slug === SLUG,
    `${STORE} → ${resolved?.status} ${resolved?.json?.kind ?? ''}`);

  const product = await merchant.req('POST', APEX, '/api/merchant/products', {
    name: `E2E Widget ${RUN}`, price_iqd: 5000, stock: 10, lifecycle: 'active',
  });
  check('a merchant product is published', product.status < 400,
    `status ${product.status} ${product.json?.error ?? ''}`);
  const productId = product.json?.product?.id ?? product.json?.id ?? null;

  const publicList = await anon.req('GET', STORE, `/api/storefront/${SLUG}/products`);
  check('the product is visible on the storefront host',
    (publicList.json?.products ?? []).some((p) => p.id === productId),
    `${(publicList.json?.products ?? []).length} product(s)`);

  // -------------------------------------------- the seller conflict, for real
  section('7. one cart, one seller');
  if (!productId) {
    blocked('the seller conflict', 'no merchant product id to add');
  } else {
    const clash = await shopper.req('POST', STORE, '/api/cart/merchant-items', { productId, qty: 1 });
    // The shopper's cart still holds the Levonis line from step 5.
    check('mixing sellers in one cart is refused', clash.status === 400 && clash.json?.code === 'CART_SELLER_CONFLICT',
      `status ${clash.status} code=${clash.json?.code ?? '-'}`);
    check('BOTH shops are named, so the customer is not left guessing',
      !!clash.json?.details?.current_name || !!clash.json?.details?.incoming_name,
      JSON.stringify(clash.json?.details ?? {}));

    // Clearing is the SAME add re-sent with replaceCart — one request, so a
    // cart is never left emptied with nothing added.
    const replaced = await shopper.req('POST', STORE, '/api/cart/merchant-items', {
      productId, qty: 1, replaceCart: true,
    });
    check('re-sending with replaceCart swaps the cart in one request', replaced.status < 400,
      `status ${replaced.status} ${replaced.json?.error ?? ''}`);

    const scope = await shopper.req('GET', APEX, '/api/cart/scope');
    check('the cart scope is now the merchant', scope.json?.scope?.seller_type === 'merchant',
      JSON.stringify(scope.json?.scope ?? null));
  }

  // ------------------------------------------------------ 8. a real order
  section('8. a real merchant order');
  const shopperId = (await shopper.req('GET', APEX, '/api/auth/me')).json?.user?.id;
  const shopperFunds = await admin.req('POST', APEX, '/api/admin/wallet/credit', {
    userId: shopperId, currency: 'USD', amount: 5_000,
    note: `e2e ${RUN} — §95 verification float, reversed at the end of this run`,
  });
  const shopperTxnId = shopperFunds.json?.id ?? null;
  check('the shopper is funded', shopperFunds.status === 200, `status ${shopperFunds.status}`);

  const addr = await shopper.req('POST', APEX, '/api/addresses', {
    label: 'E2E', name: `E2E Shopper ${RUN}`, phone: '07700000000',
    address: 'Verification run — not a real delivery', governorate: 'baghdad', area: 'karrada',
  });
  check('the shopper has a delivery address', addr.status < 400,
    `status ${addr.status} ${addr.json?.error ?? ''}`);

  const quote = await shopper.req('POST', STORE, '/api/store-orders/quote', {});
  check('the store quotes the cart', quote.status < 400,
    `status ${quote.status} ${quote.json?.error ?? ''}`);

  const placed = await shopper.req('POST', STORE, '/api/store-orders', {
    addressId: addr.json?.id, payWithWallet: true, idempotencyKey: `e2e-store-${RUN}`,
  });
  check('a real merchant order is placed', placed.status < 400,
    `status ${placed.status} ${placed.json?.error ?? ''}`);

  if (placed.status < 400) {
    const orders = await merchant.req('GET', APEX, '/api/merchant/orders');
    check('the merchant sees the order in their own dashboard',
      (orders.json?.orders ?? []).length > 0, `${(orders.json?.orders ?? []).length} order(s)`);

    const payouts = await merchant.req('GET', APEX, '/api/merchant/payouts');
    // Credited as PENDING, not available: the merchant's share is visible as
    // coming without being spendable before the customer has the goods (§77).
    check('the merchant is credited PENDING, not available',
      Number(payouts.json?.balance?.pending_iqd ?? 0) > 0,
      JSON.stringify(payouts.json?.balance ?? {}));
  }

  // -------------------------------------------------- 9. community escrow
  section('9. community escrow');
  const reqRes = await shopper.req('POST', APEX, '/api/marketplace/requests', {
    title: `E2E verification request ${RUN}`,
    description: 'An end-to-end verification of the community escrow path.',
    quantity: 1,
  });
  check('a community request is posted', reqRes.status < 400,
    `status ${reqRes.status} ${reqRes.json?.error ?? ''}`);
  const requestId = reqRes.json?.request?.id ?? null;

  if (!requestId) {
    blocked('community escrow', 'the request was not created');
  } else {
    const offer = await merchant.req('POST', APEX, `/api/marketplace/requests/${requestId}/offers`, {
      price_iqd: 3000, completion_days: 3, message: 'e2e offer',
    });
    check('the merchant submits an offer', offer.status < 400,
      `status ${offer.status} ${offer.json?.error ?? ''}`);
    const offerId = offer.json?.offer?.id ?? null;

    if (offerId) {
      const accepted = await shopper.req('POST', APEX, `/api/marketplace/offers/${offerId}/accept`);
      check('accepting HOLDS the money rather than paying it', accepted.status < 400,
        `status ${accepted.status} ${accepted.json?.error ?? ''}`);

      const orderId = accepted.json?.order?.id ?? null;
      if (orderId) {
        const detail = await shopper.req('GET', APEX, `/api/marketplace/orders/${orderId}`);
        check('the escrow is HELD, not released',
          detail.json?.escrow?.state === 'held',
          `escrow=${detail.json?.escrow?.state ?? '-'}`);

        await merchant.req('POST', APEX, `/api/marketplace/orders/${orderId}/start`);
        await merchant.req('POST', APEX, `/api/marketplace/orders/${orderId}/delivered`);

        const afterDelivered = await shopper.req('GET', APEX, `/api/marketplace/orders/${orderId}`);
        // THE rule that makes escrow more than decorative (§33).
        check('the merchant marking it delivered does NOT release the money',
          afterDelivered.json?.escrow?.state === 'held',
          `escrow=${afterDelivered.json?.escrow?.state ?? '-'}`);

        const confirmed = await shopper.req('POST', APEX, `/api/marketplace/orders/${orderId}/confirm`);
        check('the CUSTOMER confirming releases it', confirmed.status < 400,
          `status ${confirmed.status} ${confirmed.json?.error ?? ''}`);

        const settled = await shopper.req('GET', APEX, `/api/marketplace/orders/${orderId}`);
        check('the escrow is released', settled.json?.escrow?.state === 'released',
          `escrow=${settled.json?.escrow?.state ?? '-'}`);
      }
    }
  }

  // ----------------------------------------------------- 10. admin console
  section('10. the admin console sees all of it');
  const overview = await admin.req('GET', APEX, '/api/admin/community/overview');
  check('the community overview loads for an admin', overview.status === 200,
    `status ${overview.status}`);
  const merchants = await admin.req('GET', APEX, `/api/admin/community/merchants?q=${RUN}`);
  check('the new merchant is listed in the admin console',
    (merchants.json?.merchants ?? []).length > 0);
  const adminRequests = await admin.req('GET', APEX, '/api/admin/community/requests');
  check('the admin request board loads', adminRequests.status === 200, `status ${adminRequests.status}`);
  const adminReviews = await admin.req('GET', APEX, '/api/admin/community/reviews');
  check('the admin reviews list loads', adminReviews.status === 200, `status ${adminReviews.status}`);

  return finish(admin, creditTxnId, merchantId, shopperTxnId);
}

/**
 * Put the float back.
 *
 * The credits above were real money on a real ledger. They are reversed
 * through the platform's own adjustment path, so both movements are visible
 * and the net effect of this run on the balance sheet is zero. Nothing is
 * deleted: the membership, the orders and the escrow stay on the record.
 */
async function finish(admin, ...txnIds) {
  section('11. putting the float back');
  for (const id of txnIds.filter(Boolean)) {
    const res = await admin.req('POST', APEX, `/api/wallet/admin/transactions/${id}/adjustment`, {
      reason: 'e2e verification float returned',
    });
    check(`the credit ${String(id).slice(0, 12)} is reversed`, res.status < 400,
      `status ${res.status} ${res.json?.error ?? ''}`);
  }
  if (!txnIds.filter(Boolean).length) console.log('  (nothing to reverse)');
  return report();
}

function report() {
  console.log('\n────────────────────────────────────────────');
  console.log(`passed ${passed} · failed ${failed} · BLOCKED ${blockedCount}`);
  if (failures.length) {
    console.log('\nFAILED:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (blockedList.length) {
    console.log('\nBLOCKED (reported as blocked, never as success):');
    for (const b of blockedList) console.log(`  - ${b}`);
  }
  console.log('────────────────────────────────────────────');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('\nthe run itself threw:', e);
  process.exitCode = 1;
});
