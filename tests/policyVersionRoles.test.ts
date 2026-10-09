/**
 * THE DECISION-7 POLICY VERSIONS, SEEN BY EVERY ROLE, AND NOBODY ASKED TO
 * ACCEPT AGAIN (owner decision 7, 2026-10-09; DECISIONS row 190).
 *
 * «علاوة» left the customer's text as new versions of the four documents
 * that carried it — purchase 6, faq 5, membership 5, price_protection 4 —
 * and of no other. The consent documents (terms 4, privacy 3, quick_buy 1)
 * contain no such word and did not move: bumping one would re-ask every
 * checkout and switch off every Quick Buy profile, for a wording change in a
 * document nobody signs. So this file proves both halves on the real routes:
 *   - anonymous, customer, merchant and admin callers read the same new
 *     versions and the same text, in all three languages;
 *   - the version each one replaced is still readable through `?version=`,
 *     out of the archive the previous deploy wrote, untouched by the sync;
 *   - checkout still asks for terms 4 and privacy 3, a Quick Buy profile that
 *     consented at terms 4 / privacy 3 / quick_buy 1 needs no new consent,
 *     and a session opened under that consent still becomes an order.
 *
 * The version numbers are written out on purpose, not read from the
 * registry: a test that compared the registry with itself would stay green
 * the day a consent document moved.
 *
 * Run: node --import tsx --test tests/policyVersionRoles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, json, get, post, row, count, pending, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { policiesRoutes } from '../worker/routes/policies';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { quickBuyRoutes } from '../worker/routes/quickBuy';
import { POLICY_DOCUMENTS } from '../worker/lib/policies';
import { CHECKOUT_POLICY_KEYS, QUICK_BUY_POLICY_KEYS } from '../worker/lib/policyOps';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { needsConsent, loadProfile } from '../worker/lib/quickBuy/profile';
import { finalizeDueQuickBuySessions } from '../worker/lib/quickBuy/finalize';
import type { Env } from '../worker/lib/types';
import { seedCatalogue, orderBody } from './lib/bundles';

const EFFECTIVE = '2026-10-09';
const MOVED = { purchase: 6, faq: 5, membership: 5, price_protection: 4 } as const;
const CONSENT = { terms: 4, privacy: 3, quick_buy: 1 } as const;
const NAME = { ar: 'زيادة البيع المباشر', en: 'Direct Sale Extra', ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ' } as const;
const LANGS = ['ar', 'en', 'ckb'] as const;
const LEDGER = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'policyHashes.json'), 'utf8')) as Record<string, string>;

const ROLES: ReadonlyArray<[string, StubUser | null]> = [
  ['anonymous', null],
  ['customer', { id: 'u_c', role: 'customer', email: 'c@x.co' }],
  ['merchant', { id: 'u_m', role: 'merchant', email: 'm@x.co' }],
  ['admin', { id: 'u_a', role: 'admin', email: 'a@x.co' }],
];
const policyApp = (raw: DatabaseSync, user: StubUser | null) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/policies', policiesRoutes));

test('only the four reworded documents moved, all on one date; the consent documents and the consent sets did not', () => {
  const version = (key: string) => POLICY_DOCUMENTS.find((d) => d.key === key)!;
  for (const [key, v] of Object.entries(MOVED)) {
    assert.equal(version(key).version, v, key);
    assert.equal(version(key).effective_at, EFFECTIVE, `${key}: one date for the whole change, the day it was published`);
  }
  for (const [key, v] of Object.entries(CONSENT)) assert.equal(version(key).version, v, `${key} moved: every consent would be asked again`);
  assert.deepEqual([...CHECKOUT_POLICY_KEYS], ['terms', 'privacy']);
  assert.deepEqual([...QUICK_BUY_POLICY_KEYS], ['terms', 'privacy', 'quick_buy']);
});

test('every role reads the same new versions and the same text, in all three languages', async () => {
  const raw = freshDb();
  resetPolicyCorpusMemo();
  const seen = new Map<string, string>();
  for (const [role, user] of ROLES) {
    const list = await json(await get(policyApp(raw, user), '/api/policies'));
    assert.equal(list.success, true, `${role}: ${JSON.stringify(list)}`);
    const versions = Object.fromEntries((list.policies as Array<{ key: string; version: number }>).map((p) => [p.key, p.version]));
    for (const [key, v] of Object.entries({ ...MOVED, ...CONSENT })) assert.equal(versions[key], v, `${role}: ${key}`);
    const fingerprint: string[] = [JSON.stringify(list.policies)];

    for (const lang of LANGS) {
      const res = await json(await get(policyApp(raw, user), `/api/policies/purchase?lang=${lang}`));
      assert.equal(res.success, true, `${role}/${lang}: ${JSON.stringify(res)}`);
      assert.equal(res.policy.version, MOVED.purchase);
      assert.equal(res.policy.lang, lang, `${role}: ${lang} fell back to another language`);
      assert.equal(res.policy.hash, LEDGER[`purchase@${MOVED.purchase}:${lang}`], `${role}/${lang}: not the ledgered text`);
      assert.ok(String(res.policy.body).includes(NAME[lang]), `${role}/${lang}: «${NAME[lang]}» missing`);
      assert.doesNotMatch(String(res.policy.body), /علاوة|premium/, `${role}/${lang}`);
      fingerprint.push(res.policy.hash, res.policy.body);
    }
    for (const key of ['faq', 'membership', 'price_protection'] as const) {
      const res = await json(await get(policyApp(raw, user), `/api/policies/${key}?lang=en`));
      assert.equal(res.policy.version, MOVED[key], `${role}: ${key}`);
      fingerprint.push(res.policy.hash);
    }
    seen.set(role, fingerprint.join('\n'));
  }
  const reference = seen.get('anonymous');
  for (const [role, fp] of seen) assert.equal(fp, reference, `${role} reads something an anonymous visitor does not`);
});

test('?version=5 still serves the archived purchase 5 after the sync writes 6 beside it — the old rows untouched', async () => {
  const raw = freshDb();
  resetPolicyCorpusMemo();
  // The archive as the previous deploy left it: purchase 5, in three
  // languages, under the hash the ledger records for it.
  const OLD_BODY = { ar: 'نص الإصدار 5 كما قُبل', en: 'The version 5 text as accepted', ckb: 'دەقی وەشانی 5 وەک قبووڵکرا' } as const;
  for (const lang of LANGS) {
    raw
      .prepare(
        `INSERT INTO policy_documents (id,key,version,lang,title,body,hash,status,published_at,effective_at)
         VALUES (?, 'purchase', 5, ?, 'Purchase Policy', ?, ?, 'published', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')`
      )
      .run(`pol_v5_${lang}`, lang, OLD_BODY[lang], LEDGER[`purchase@5:${lang}`]);
  }

  // A plain read serves 6 from the code and mirrors it into the archive —
  // after the response, through waitUntil, so the test waits for it.
  const current = await json(await get(policyApp(raw, null), '/api/policies/purchase?lang=en'));
  assert.equal(current.policy.version, 6);
  await Promise.all(pending.splice(0));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM policy_documents WHERE key = 'purchase' AND version = 6 AND status = 'published'"), 3);

  for (const lang of LANGS) {
    const old = await json(await get(policyApp(raw, { id: 'u_c', role: 'customer', email: 'c@x.co' }), `/api/policies/purchase?lang=${lang}&version=5`));
    assert.equal(old.success, true, JSON.stringify(old));
    assert.equal(old.policy.version, 5);
    assert.equal(old.policy.body, OLD_BODY[lang], `${lang}: the accepted text is what a customer re-reads`);
    assert.equal(old.policy.hash, LEDGER[`purchase@5:${lang}`]);
    const stored = row<{ body: string; hash: string }>(raw, "SELECT body, hash FROM policy_documents WHERE id = ?", `pol_v5_${lang}`)!;
    assert.deepEqual({ ...stored }, { body: OLD_BODY[lang], hash: LEDGER[`purchase@5:${lang}`] }, `${lang}: the sync touched version 5`);
  }
  resetPolicyCorpusMemo();
});

test('checkout still asks for terms 4 and privacy 3 — the quote lists exactly those', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
  const app = stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });
  const added = await json(await post(app, '/api/cart/items', { productId: 'p_pla', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const quote = await json(await post(app, '/api/orders/quote', orderBody()));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.deepEqual(quote.quote.policies, [{ key: 'terms', version: CONSENT.terms }, { key: 'privacy', version: CONSENT.privacy }]);
});

/** A Quick Buy world: one funded buyer with an address and a spool on the shelf. */
function quickBuyWorld(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area) VALUES
      ('addr','buyer','Home','Sara','+9647701234567','Karrada 12','Near the bridge',1,'Baghdad','Karrada');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,sku) VALUES
      ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','[]','PLA1');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('wt_fund','buyer','deposit','USD',${Math.ceil((2_000_000 * 100) / 1400)},'approved','test funding');
  `);
  return raw;
}

test('a Quick Buy profile that consented at terms 4 / privacy 3 / quick_buy 1 needs no new consent, and its open session still becomes an order', async () => {
  const raw = quickBuyWorld();
  const db = asD1(raw);
  const app = stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => {
    a.route('/api/quick-buy', quickBuyRoutes);
    a.route('/api/orders', orderRoutes);
  });
  // The consent a customer gave before this change, written out, not read
  // from the registry.
  const activated = await json(
    await post(app, '/api/quick-buy/activate', {
      policyAcceptance: [
        { key: 'terms', version: CONSENT.terms },
        { key: 'privacy', version: CONSENT.privacy },
        { key: 'quick_buy', version: CONSENT.quick_buy },
      ],
      walletConsent: true,
      addressId: 'addr',
      idempotencyKey: 'qb-roles-activate',
    })
  );
  assert.equal(activated.success, true, JSON.stringify(activated));
  const profile = await loadProfile(db, 'buyer');
  assert.deepEqual(
    { terms: profile!.terms_version, privacy: profile!.privacy_version, quick_buy: profile!.policy_version },
    { terms: CONSENT.terms, privacy: CONSENT.privacy, quick_buy: CONSENT.quick_buy }
  );
  assert.equal(needsConsent(profile), false, 'the reworded documents ask nobody to accept again');

  const added = await json(await post(app, '/api/quick-buy/items', { productId: 'p_pla', qty: 1, idempotencyKey: 'qb-roles-add' }));
  assert.equal(added.success, true, JSON.stringify(added));
  raw
    .prepare("UPDATE quick_buy_sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE user_id = 'buyer' AND state = 'open'")
    .run();
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p.catch(() => undefined)); }, passThroughOnException() {} } as unknown as ExecutionContext;
  await finalizeDueQuickBuySessions({ DB: db } as Env, ctx);
  await Promise.all(waited);
  const session = row<{ state: string; order_id: string | null }>(raw, "SELECT state, order_id FROM quick_buy_sessions WHERE user_id = 'buyer'")!;
  assert.equal(session.state, 'submitted', JSON.stringify(session));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'buyer'"), 1);
  // The order's own consent names the same unchanged versions.
  const accepted = raw
    .prepare("SELECT d.key, d.version FROM policy_acceptances a JOIN policy_documents d ON d.id = a.document_id WHERE a.user_id = 'buyer' ORDER BY d.key")
    .all() as Array<{ key: string; version: number }>;
  assert.ok(accepted.length >= 2, `only ${accepted.length} acceptance rows`);
  for (const a of accepted) assert.equal(a.version, CONSENT[a.key as keyof typeof CONSENT], `${a.key}@${a.version}`);
});
