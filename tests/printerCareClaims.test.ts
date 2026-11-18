/**
 * PRINTER SERVICES PHASE 3 — LEVO CARE CLAIMS ON THE WARRANTY DESK (owner rulings 2026-11-18;
 * DECISIONS row 347; migration 0236).
 *
 * Pinned here: the one price of a Care quote (eligible parts, labour / shipping per the terms, the
 * money cap, the claim cap); Care follows the device's root unit and is judged on the day the claim
 * was filed; no stacking with an active warranty (except misuse); the customer accepts THE quote
 * they saw; a care claim is accepted only by approving its quote (CARE_APPROVAL_REQUIRED), which is a
 * finance-scope money act (an assistant is refused, owner ruling D3) with the caps re-checked; the
 * co-pay collected once is service income (1000 Dr / 4300 Cr, owner ruling D2); the Care terms are
 * frozen per version at the publish (owner ruling D1: the first published terms are v1 for every
 * holder); and a database without 0236 answers care: null everywhere.
 *
 * Run: node --import tsx --test tests/printerCareClaims.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, get, post, patch, json, row, all, type StubUser } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';
import { priceCareQuote, parseCareQuote, CARE_REFUSALS } from '../worker/lib/careClaims';
import { publishDraft } from '../worker/lib/printerServices';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { DEFAULT_PRINTER_SERVICES, type CareTerms } from '../packages/pricing/src/printerServices';
import { HttpError } from '../worker/lib/http';
import { serviceClaimsSummary } from '../worker/lib/printerFinance';
import { baghdadDay } from '../worker/lib/operations';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'sara@x.co' };
const OTHER: StubUser = { id: 'omar', role: 'customer', email: 'omar@x.co' };
const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const FINANCE: StubUser = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };

const TERMS: CareTerms = {
  eligible_parts: [
    { key: 'nozzle', label: { ar: 'الفوهة', en: 'Nozzle', ckb: 'نۆزڵ' } },
    { key: 'fan', label: { ar: 'المروحة', en: 'Fan', ckb: 'پانکە' } },
  ],
  discount_pct: 50,
  max_claims: 2,
  max_benefit_iqd: 30_000,
  labor: 'discounted',
  shipping: 'full_price',
  exclusions: [{ ar: 'الحريق', en: 'Fire', ckb: 'ئاگر' }],
};
const SNAPSHOT = JSON.stringify({
  lines: [
    { service: 'warranty', choice: 'w12', fee_iqd: 25_000, policy_version: 1 },
    { service: 'care', choice: 'c12', fee_iqd: 19_000, policy_version: 1 },
  ],
  fee_iqd: 44_000, package_discount_iqd: 0, warranty_months: 12, care_months: 12, revision: 1,
});
const QUOTE = {
  parts: [{ key: 'nozzle', qty: 1, unit_iqd: 20_000 }, { key: 'fan', qty: 2, unit_iqd: 5_000 }],
  labor_iqd: 10_000, shipping_iqd: 5_000, other_iqd: 3_000, note: 'Clogged nozzle, worn fans',
};

/** u1: Care, warranty over (0 months bought); u2: Care AND a warranty still in force; u3: no Care. */
function seed(raw: DatabaseSync = freshDb(), opts: { terms?: boolean } = {}): DatabaseSync {
  const delivered = iso(Date.now() - 60 * DAY);
  const end = iso(Date.now() + 300 * DAY);
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale,admin_scope) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('omar','Omar','omar@x.co','omar','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('boss','Owner','boss@x.co','boss','h','admin','2026-01-01T00:00:00.000Z','ar',NULL),
      ('staff','Staff','staff@x.co','staff','h','admin','2026-01-01T00:00:00.000Z','ar','full'),
      ('helper','Helper','helper@x.co','helper','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',1886000,0,1400,1886000,0,'${delivered}');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi1','ORD-1','p1','Bambu A1',2,943000,1886000), ('oi2','ORD-1','p1','Bambu A1',1,899000,899000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
       delivered_at, warranty_base_months, warranty_start_at, warranty_end_at) VALUES
      ('u1','ORD-1','oi1','p1','buyer',1,'${delivered}',0,'${delivered}','${delivered}'),
      ('u2','ORD-1','oi1','p1','buyer',2,'${delivered}',12,'${delivered}','${end}'),
      ('u3','ORD-1','oi2','p1','buyer',1,'${delivered}',0,'${delivered}','${delivered}');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer'), ('u2','buyer'), ('u3','buyer');
  `);
  try {
    raw.prepare('UPDATE order_items SET services_snapshot = ? WHERE id = ?').run(SNAPSHOT, 'oi1');
  } catch {
    /* a database before 0234 */
  }
  if (opts.terms !== false) {
    try {
      raw.prepare('INSERT INTO printer_care_policies (policy_version, terms, published_at, published_by) VALUES (1, ?, ?, ?)').run(JSON.stringify(TERMS), iso(Date.now()), 'boss');
    } catch {
      /* a database before 0236 */
    }
  }
  return raw;
}
const as = (raw: DatabaseSync, who: StubUser) => stubApp(asD1(raw), who, (a) => a.route('/api/devices', deviceRoutes));

async function file(raw: DatabaseSync, unit = 'u1', key = `care-key-${unit}-${Math.random().toString(36).slice(2, 8)}`) {
  const res = await json(await post(as(raw, BUYER), `/api/devices/units/${unit}/claims`, {
    subject: 'Nozzle clogs', description: 'The nozzle clogs after every second print.', idempotencyKey: key,
  }));
  assert.equal(res.success, true, JSON.stringify(res));
  return res.id as string;
}
const quote = (raw: DatabaseSync, who: StubUser, id: string, body: Record<string, unknown> = QUOTE) => post(as(raw, who), `/api/devices/admin/claims/${id}/care-quote`, body);

// ------------------------------------------------------------------ the price

test('the one price of a Care quote: eligible parts (+ labour when discounted), the money cap, the co-pay', () => {
  const q = parseCareQuote(QUOTE);
  const p = priceCareQuote(TERMS, q, { claims: 0, benefit_iqd: 0 });
  assert.deepEqual([p.parts_iqd, p.list_iqd, p.eligible_iqd, p.benefit_iqd, p.copay_iqd], [30_000, 48_000, 40_000, 20_000, 28_000]);
  // Shipping discounted too: eligible 45,000 → 22,500.
  assert.equal(priceCareQuote({ ...TERMS, shipping: 'discounted' }, q, { claims: 0, benefit_iqd: 0 }).benefit_iqd, 22_500);
  // The money cap trims the benefit, never refuses: 10,000 left.
  const capped = priceCareQuote(TERMS, q, { claims: 1, benefit_iqd: 20_000 });
  assert.deepEqual([capped.benefit_iqd, capped.copay_iqd], [10_000, 38_000]);
  // No money cap (null): the full discount. Odd amounts floor.
  assert.equal(priceCareQuote({ ...TERMS, max_benefit_iqd: null }, parseCareQuote({ parts: [{ key: 'fan', qty: 1, unit_iqd: 999 }] }), { claims: 0, benefit_iqd: 0 }).benefit_iqd, 499);
  // The claim cap and a part outside the terms refuse.
  assert.throws(() => priceCareQuote(TERMS, q, { claims: 2, benefit_iqd: 0 }), (e: unknown) => e instanceof HttpError && e.code === 'CARE_CLAIM_LIMIT');
  assert.throws(() => priceCareQuote(TERMS, parseCareQuote({ parts: [{ key: 'motherboard', qty: 1, unit_iqd: 1 }] }), { claims: 0, benefit_iqd: 0 }),
    (e: unknown) => e instanceof HttpError && e.code === 'CARE_PART_NOT_ELIGIBLE');
  // Fractions and negatives never reach the price.
  for (const bad of [{ labor_iqd: 1.5 }, { labor_iqd: -1 }, { parts: [{ key: 'fan', qty: 0, unit_iqd: 1 }] }, { parts: 'x' }]) {
    assert.throws(() => parseCareQuote(bad as never), (e: unknown) => e instanceof HttpError && e.code === 'CARE_QUOTE_INVALID');
  }
});

test('every Care refusal has a real ar / en / ckb sentence on the server and on the screens', () => {
  for (const [code, t] of Object.entries(CARE_REFUSALS)) {
    const screen = REFUSAL_STRINGS[code];
    assert.ok(screen, `${code} missing from src/lib/refusalStrings.ts`);
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(screen[lang], t[lang], `${code}.${lang}`);
    assert.notEqual(t.ckb, t.ar);
    assert.notEqual(t.ckb, t.en);
  }
});

// ------------------------------------------------------------------ the desk flow

test('quote → the claimant accepts → a financial admin approves; the stage alone never accepts a Care claim', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    // Any admin writes the quote (an assistant included): it moves no money.
    const q = await json(await quote(raw, ASSISTANT, id));
    assert.equal(q.success, true, JSON.stringify(q));
    assert.equal(q.claim.claim_kind, 'care');
    assert.deepEqual([q.quote.state, q.quote.benefit_iqd, q.quote.copay_iqd, q.quote.version], ['quoted', 20_000, 28_000, 1]);
    assert.equal(q.costs, null, 'an assistant does not read what a claim cost');
    assert.equal(q.care.state, 'active');

    // The claimant sees the Care and the quote (never a cost); the part names come from the terms.
    const mine = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
    assert.equal(mine.claim.claim_kind, 'care');
    assert.equal(mine.care.entitlement.state, 'active');
    assert.equal(mine.care.entitlement.claims_left, 2);
    assert.equal(mine.care.quote.parts[0].label.ckb, 'نۆزڵ');
    assert.equal(mine.care.quote.quoted_by, undefined, 'who quoted is the desk’s');
    assert.ok(!JSON.stringify(mine).includes('costs'), 'no claim cost reaches the customer');

    // Someone else's claim is not there to accept; a stale version is refused.
    assert.equal((await post(as(raw, OTHER), `/api/devices/claims/${id}/care-quote/accept`, { version: 1 })).status, 404);
    const stale = await json(await post(as(raw, BUYER), `/api/devices/claims/${id}/care-quote/accept`, { version: 9 }));
    assert.equal(stale.code, 'CARE_QUOTE_CHANGED');

    // Approving before acceptance is refused, and moving the stage never accepts a Care claim.
    assert.equal((await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-approve`, { version: 1, reason: 'Nozzle and fans' }))).code, 'CARE_QUOTE_NOT_ACCEPTED');
    const viaStage = await json(await patch(as(raw, OWNER), `/api/devices/admin/claims/${id}`, { stage: 'approved', decision: 'repair', reason: 'Covered by Care' }));
    assert.equal(viaStage.code, 'CARE_APPROVAL_REQUIRED');

    const ok = await json(await post(as(raw, BUYER), `/api/devices/claims/${id}/care-quote/accept`, { version: 1 }));
    assert.equal(ok.quote.state, 'accepted');
    // A retry of the same acceptance is the same answer.
    assert.equal((await json(await post(as(raw, BUYER), `/api/devices/claims/${id}/care-quote/accept`, { version: 1 }))).already, true);

    // An assistant is refused at the door (owner ruling D3: the finance scope decides, not only the owner).
    const helper = await post(as(raw, ASSISTANT), `/api/devices/admin/claims/${id}/care-approve`, { version: 1, reason: 'Nozzle and fans' });
    assert.equal(helper.status, 403);
    assert.equal((await json(helper)).code, 'FINANCIAL_SCOPE_REQUIRED');

    const approved = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-approve`, { version: 1, reason: 'Nozzle and fans' }));
    assert.equal(approved.success, true, JSON.stringify(approved));
    assert.equal(approved.quote.state, 'approved');
    assert.equal(approved.claim.stage, 'approved');
    const claim = row<{ stage: string; decision: string; claim_kind: string }>(raw, 'SELECT stage, decision, claim_kind FROM warranty_claims WHERE id = ?', id)!;
    assert.deepEqual([claim.stage, claim.decision, claim.claim_kind], ['approved', 'repair', 'care']);
    assert.ok(row(raw, "SELECT 1 FROM audit_log WHERE action = 'warranty.care_approved' AND target = ?", id));

    // Approved is frozen: no re-quote, and the database refuses a changed figure.
    assert.equal((await json(await quote(raw, OWNER, id))).code, 'CARE_CLAIM_NOT_OPEN');
    assert.throws(() => raw.prepare('UPDATE care_claim_benefits SET benefit_iqd = 1, copay_iqd = list_iqd - 1 WHERE claim_id = ?').run(id), /CARE_BENEFIT_FROZEN/);

    // The device card counts the approved claim against the caps.
    const devices = await json(await get(as(raw, BUYER), '/api/devices/mine'));
    const card = devices.devices.find((d: { unit_id: string }) => d.unit_id === 'u1');
    assert.deepEqual([card.care.state, card.care.claims_left, card.care.benefit_left_iqd, card.care.discount_pct], ['active', 1, 10_000, 50]);
    assert.equal(devices.devices.find((d: { unit_id: string }) => d.unit_id === 'u3').care, null, 'no Care bought, no Care block');

    // The queue carries the kind and the benefit; the cost total is the owner's to read.
    const q1 = await json(await get(as(raw, FINANCE), '/api/devices/admin/claims?stage=all'));
    const listed = q1.claims.find((c: { id: string }) => c.id === id);
    assert.deepEqual([listed.claim_kind, listed.care_benefit.state, listed.costs_total_iqd], ['care', 'approved', null]);
    const q2 = await json(await get(as(raw, OWNER), '/api/devices/admin/claims?stage=all'));
    assert.equal(q2.claims.find((c: { id: string }) => c.id === id).costs_total_iqd, 0);
  } finally {
    raw.close();
  }
});

test('the caps: the second claim gets what is left of the money cap; past max_claims a quote is refused', async () => {
  const raw = seed();
  try {
    const approveOne = async (expectBenefit: number) => {
      const id = await file(raw);
      const q = await json(await quote(raw, OWNER, id));
      assert.equal(q.quote.benefit_iqd, expectBenefit, JSON.stringify(q));
      await post(as(raw, BUYER), `/api/devices/claims/${id}/care-quote/accept`, { version: q.quote.version });
      const a = await json(await post(as(raw, OWNER), `/api/devices/admin/claims/${id}/care-approve`, { version: q.quote.version, reason: 'Covered by Care' }));
      assert.equal(a.success, true, JSON.stringify(a));
      // Close it so the device can open the next one (one open case per device).
      assert.equal((await patch(as(raw, OWNER), `/api/devices/admin/claims/${id}`, { stage: 'resolved', reason: 'Repaired and returned' })).status, 200);
      return id;
    };
    await approveOne(20_000);
    await approveOne(10_000);
    const third = await file(raw);
    assert.equal((await json(await quote(raw, OWNER, third))).code, 'CARE_CLAIM_LIMIT');
  } finally {
    raw.close();
  }
});

test('the caps are re-checked inside the approval: two accepted quotes racing on one device cannot both pass', async () => {
  const raw = seed();
  try {
    // Two claims on the device, quoted and accepted while neither was approved (the second filed
    // after the first is set aside, then reopened — the desk's real race is two admins, modelled here).
    const a = await file(raw);
    const qa = await json(await quote(raw, OWNER, a));
    await post(as(raw, BUYER), `/api/devices/claims/${a}/care-quote/accept`, { version: qa.quote.version });
    // A forged approved benefit on another claim of the same device eats the money cap and one claim.
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status, claim_kind)
              VALUES ('wc_old','buyer','oi1','Bambu A1','old claim','u1','resolved','approved','care')`);
    raw.prepare(`INSERT INTO care_claim_benefits (id, claim_id, entitlement_unit_id, order_item_id, policy_version, quote_json, list_iqd, eligible_iqd,
                   discount_pct, benefit_iqd, copay_iqd, state, quoted_at, decided_at) VALUES ('ccb_old','wc_old','u1','oi1',1,'{}',40000,40000,50,20000,20000,'approved',?,?)`)
      .run(iso(Date.now()), iso(Date.now()));
    // 20,000 + 20,000 > 30,000: the approval re-checks and refuses; nothing moved.
    const res = await json(await post(as(raw, OWNER), `/api/devices/admin/claims/${a}/care-approve`, { version: qa.quote.version, reason: 'Covered by Care' }));
    assert.equal(res.code, 'CARE_QUOTE_CHANGED');
    assert.equal(row<{ state: string }>(raw, 'SELECT state FROM care_claim_benefits WHERE claim_id = ?', a)!.state, 'accepted');
    assert.notEqual(row<{ stage: string }>(raw, 'SELECT stage FROM warranty_claims WHERE id = ?', a)!.stage, 'approved');
  } finally {
    raw.close();
  }
});

test('no stacking: while the warranty covers the device the claim is a warranty claim, unless the desk found misuse', async () => {
  const raw = seed();
  try {
    const id = await file(raw, 'u2');
    assert.equal((await json(await quote(raw, OWNER, id))).code, 'CARE_NOT_WARRANTY');
    const misuse = await json(await quote(raw, OWNER, id, { ...QUOTE, misuse: true }));
    assert.equal(misuse.success, true, JSON.stringify(misuse));
    // A device without Care is refused with its state.
    const other = await file(raw, 'u3');
    const none = await json(await quote(raw, OWNER, other));
    assert.equal(none.code, 'CARE_NOT_ACTIVE');
  } finally {
    raw.close();
  }
});

test('Care follows the ROOT unit: a replacement device carries the Care and the caps of the unit first sold', async () => {
  const raw = seed();
  try {
    const delivered = iso(Date.now() - 10 * DAY);
    raw.exec(`
      INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months,
         warranty_start_at, warranty_end_at, replacement_of_unit_id) VALUES ('u1r','ORD-1','oi2','p1','buyer',9,'${delivered}',0,'${delivered}','${delivered}','u1');
      UPDATE order_item_units SET replaced_by_unit_id = 'u1r' WHERE id = 'u1';
      INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1r','buyer');
    `);
    const id = await file(raw, 'u1r');
    const q = await json(await quote(raw, OWNER, id));
    assert.equal(q.success, true, JSON.stringify(q));
    assert.equal(q.care.root_unit_id, 'u1');
    assert.equal(row<{ entitlement_unit_id: string }>(raw, 'SELECT entitlement_unit_id FROM care_claim_benefits WHERE claim_id = ?', id)!.entitlement_unit_id, 'u1');
    // The window runs from the ROOT's delivery (60 days ago), not the replacement's.
    assert.equal(Date.parse(q.care.start_at), Date.parse(row<{ d: string }>(raw, "SELECT delivered_at AS d FROM order_item_units WHERE id = 'u1'")!.d));
    // A device that came back (its unit closed) has no Care.
    raw.exec(`UPDATE order_item_units SET warranty_closed_at = '${iso(Date.now() - DAY)}' WHERE id = 'u1r'`);
    const mine = await json(await get(as(raw, BUYER), '/api/devices/mine'));
    const card = mine.devices.find((d: { unit_id: string }) => d.unit_id === 'u1r');
    assert.ok(card, 'the replacement is on the card list');
    assert.equal(card.care.state, 'closed');
  } finally {
    raw.close();
  }
});

test('terms never published for the line’s version: the device reads terms_missing and the desk is told so', async () => {
  const raw = seed(freshDb(), { terms: false });
  try {
    const id = await file(raw);
    assert.equal((await json(await quote(raw, OWNER, id))).code, 'CARE_TERMS_MISSING');
    const mine = await json(await get(as(raw, BUYER), '/api/devices/mine'));
    assert.equal(mine.devices.find((d: { unit_id: string }) => d.unit_id === 'u1').care.state, 'terms_missing');
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------------ void and co-pay

test('the co-pay collected once is service income (1000 Dr / 4300 Cr); afterwards the approval cannot be voided', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const q = await json(await quote(raw, OWNER, id));
    // Nothing to collect before the approval.
    assert.equal((await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-copay`, { operation_id: 'copay-op-0001' }))).code, 'CARE_NO_COPAY');
    await post(as(raw, BUYER), `/api/devices/claims/${id}/care-quote/accept`, { version: q.quote.version });
    await post(as(raw, OWNER), `/api/devices/admin/claims/${id}/care-approve`, { version: q.quote.version, reason: 'Covered by Care' });
    assert.equal((await post(as(raw, ASSISTANT), `/api/devices/admin/claims/${id}/care-copay`, { operation_id: 'copay-op-0001' })).status, 403);
    const got = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-copay`, { operation_id: 'copay-op-0001' }));
    assert.equal(got.success, true, JSON.stringify(got));
    assert.equal(got.quote.copay_collected, true);
    const lines = all<{ account_code: string; debit_iqd: number; credit_iqd: number }>(raw,
      `SELECT l.account_code, l.debit_iqd, l.credit_iqd FROM accounting_lines l JOIN accounting_entries e ON e.id = l.entry_id
        WHERE e.event_key = ? ORDER BY l.account_code`, `care-copay:${id}`);
    assert.deepEqual(lines.map((l) => [l.account_code, l.debit_iqd, l.credit_iqd]), [['1000', 28_000, 0], ['4300', 0, 28_000]]);
    assert.equal(row<{ name: string }>(raw, "SELECT name FROM accounting_accounts WHERE code = '4300'")!.name, 'إيرادات خدمات الصيانة');
    // Idempotent on its operation id; another id is refused; no second journal.
    assert.equal((await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-copay`, { operation_id: 'copay-op-0001' }))).already, true);
    assert.equal((await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-copay`, { operation_id: 'copay-op-0002' }))).code, 'CARE_COPAY_COLLECTED');
    assert.equal(all(raw, "SELECT id FROM accounting_entries WHERE source_type = 'care_copay'").length, 1);
    // Collected: the approval stays.
    assert.equal((await json(await post(as(raw, OWNER), `/api/devices/admin/claims/${id}/care-void`, { reason: 'Customer changed mind' }))).code, 'CARE_COPAY_COLLECTED');
  } finally {
    raw.close();
  }
});

test('a void (finance scope) frees the claim and the caps; a voided quote can be written again', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const q = await json(await quote(raw, OWNER, id));
    await post(as(raw, BUYER), `/api/devices/claims/${id}/care-quote/accept`, { version: q.quote.version });
    await post(as(raw, OWNER), `/api/devices/admin/claims/${id}/care-approve`, { version: q.quote.version, reason: 'Covered by Care' });
    assert.equal((await post(as(raw, ASSISTANT), `/api/devices/admin/claims/${id}/care-void`, { reason: 'Wrong device' })).status, 403);
    const v = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-void`, { reason: 'Wrong device' }));
    assert.equal(v.quote.state, 'void');
    assert.equal(v.care.used_claims, 0, 'a voided approval no longer counts against the caps');
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------------ the terms, frozen per version

test('publishing freezes the Care terms per version: the first terms are v1 for everyone; a changed reuse is refused', async () => {
  const raw = freshDb();
  try {
    raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Owner','boss@x.co','h','admin')");
    const db = asD1(raw);
    const config = (version: number, terms: CareTerms) => ({
      ...DEFAULT_PRINTER_SERVICES, revision: 1, products: { p1: { warranty_family: 'a1', delivery_class: 'd1' } },
      care: { ...DEFAULT_PRINTER_SERVICES.care, policy_version: version, terms },
    });
    const store = (c: unknown) => raw.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('printerServices', ?)").run(JSON.stringify({ draft: c, published: null, published_at: null, published_by: null }));
    // The owner's live list is already on version 3 when the first terms are published: 1..3 all get them.
    store(config(3, TERMS));
    await publishDraft(db, 'boss', 1, iso(Date.now()));
    assert.deepEqual(all<{ v: number }>(raw, 'SELECT policy_version AS v FROM printer_care_policies ORDER BY 1').map((r) => r.v), [1, 2, 3]);
    // Same version, changed terms: refused; the stored terms stand.
    const st = JSON.parse(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key = 'printerServices'")!.value);
    st.draft.care.terms = { ...TERMS, discount_pct: 60 };
    raw.prepare("UPDATE admin_settings SET value = ? WHERE key = 'printerServices'").run(JSON.stringify(st));
    await assert.rejects(publishDraft(db, 'boss', st.draft.revision, iso(Date.now())), (e: unknown) => e instanceof HttpError && e.code === 'CARE_POLICY_VERSION_REUSED');
    // A new version for new buyers: only v4 is written.
    st.draft.care.policy_version = 4;
    raw.prepare("UPDATE admin_settings SET value = ? WHERE key = 'printerServices'").run(JSON.stringify(st));
    await publishDraft(db, 'boss', st.draft.revision, iso(Date.now()));
    assert.equal(JSON.parse(row<{ t: string }>(raw, 'SELECT terms AS t FROM printer_care_policies WHERE policy_version = 4')!.t).discount_pct, 60);
    assert.equal(JSON.parse(row<{ t: string }>(raw, 'SELECT terms AS t FROM printer_care_policies WHERE policy_version = 1')!.t).discount_pct, 50);
    // The rows are frozen.
    assert.throws(() => raw.exec('UPDATE printer_care_policies SET published_by = NULL'), /CARE_POLICY_FROZEN/);
    assert.throws(() => raw.exec('DELETE FROM printer_care_policies'), /CARE_POLICY_FROZEN/);
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------------ code ahead of its migration

test('a database without 0236: care is null on /mine and on a claim, the panel says installed:false, the doors answer 503', async () => {
  const raw = seed(dbThrough('0235'));
  try {
    const id = await file(raw);
    const mine = await json(await get(as(raw, BUYER), '/api/devices/mine'));
    assert.equal(mine.success, true, JSON.stringify(mine));
    assert.ok(mine.devices.every((d: { care: unknown }) => d.care === null));
    const one = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
    assert.equal(one.care, null);
    assert.equal(one.claim.claim_kind, 'warranty');
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    assert.equal(panel.installed, false);
    const q = await quote(raw, OWNER, id);
    assert.equal(q.status, 503);
    assert.equal((await json(q)).code, 'CARE_NOT_INSTALLED');
    // The queue and the decision still work as before.
    const queue = await json(await get(as(raw, OWNER), '/api/devices/admin/claims?stage=all'));
    assert.equal(queue.claims[0].care_benefit, null);
    assert.equal((await patch(as(raw, OWNER), `/api/devices/admin/claims/${id}`, { stage: 'diagnosing' })).status, 200);
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------------ review fixes (2026-11-18)

/** File, quote, accept and approve a Care claim on u1; returns the claim id. */
async function approvedCare(raw: DatabaseSync): Promise<string> {
  const id = await file(raw);
  const q = await json(await quote(raw, OWNER, id));
  assert.equal(q.success, true, JSON.stringify(q));
  await post(as(raw, BUYER), `/api/devices/claims/${id}/care-quote/accept`, { version: q.quote.version });
  const a = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-approve`, { version: q.quote.version, reason: 'Covered by Care' }));
  assert.equal(a.success, true, JSON.stringify(a));
  return id;
}
const claimRow = (raw: DatabaseSync, id: string) =>
  row<{ stage: string; decision: string | null; decision_reason: string | null; claim_kind: string | null }>(raw, 'SELECT stage, decision, decision_reason, claim_kind FROM warranty_claims WHERE id = ?', id)!;

test('no stacking is judged AT FILING: a claim filed inside the warranty stays a warranty claim after it ends', async () => {
  const raw = seed();
  try {
    // Filed while u2's warranty was in force (the claim records the cover it was filed under) …
    const id = await file(raw, 'u2');
    // … and the warranty ends afterwards: still no Care on this claim.
    raw.exec(`UPDATE order_item_units SET warranty_end_at = '${iso(Date.now() - DAY)}' WHERE id = 'u2'`);
    assert.equal((await json(await quote(raw, OWNER, id))).code, 'CARE_NOT_WARRANTY');
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    assert.equal(panel.warranty.state, 'active', 'the panel shows the cover at filing, not today');
    raw.exec(`UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = '${id}'`);

    // An older claim without a recorded cover is judged at its created_at: filed a day ago, the warranty ended 12 hours ago.
    raw.exec(`UPDATE order_item_units SET warranty_end_at = '${iso(Date.now() - DAY / 2)}' WHERE id = 'u2'`);
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status, created_at)
              VALUES ('wc_old_u2','buyer','oi1','Bambu A1','older claim','u2','diagnosing','in_review','${iso(Date.now() - DAY)}')`);
    assert.equal((await json(await quote(raw, OWNER, 'wc_old_u2'))).code, 'CARE_NOT_WARRANTY');
    // Filed after the warranty ended: Care may take it.
    raw.exec(`UPDATE order_item_units SET warranty_end_at = '${iso(Date.now() - 2 * DAY)}' WHERE id = 'u2'`);
    const ok = await json(await quote(raw, OWNER, 'wc_old_u2'));
    assert.equal(ok.success, true, JSON.stringify(ok));
    assert.equal(ok.warranty.state, 'expired');
  } finally {
    raw.close();
  }
});

test('voiding a quote that was never approved makes the claim an ordinary warranty claim again (claim_kind NULL)', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const q = await json(await quote(raw, OWNER, id));
    await post(as(raw, BUYER), `/api/devices/claims/${id}/care-quote/accept`, { version: q.quote.version });
    assert.equal(claimRow(raw, id).claim_kind, 'care');
    const v = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-void`, { reason: 'Handled as warranty' }));
    assert.equal(v.success, true, JSON.stringify(v));
    assert.equal(v.quote.state, 'void');
    assert.equal(v.claim.claim_kind, 'warranty');
    assert.equal(claimRow(raw, id).claim_kind, null);
    // Now the desk decides it as any warranty claim.
    const res = await patch(as(raw, OWNER), `/api/devices/admin/claims/${id}`, { stage: 'approved', decision: 'repair', reason: 'Covered by warranty' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(claimRow(raw, id).stage, 'approved');
  } finally {
    raw.close();
  }
});

test('voiding an APPROVED Care hands the claim back to diagnosis with no decision; a re-quote is possible', async () => {
  const raw = seed();
  try {
    const id = await approvedCare(raw);
    assert.deepEqual([claimRow(raw, id).stage, claimRow(raw, id).decision], ['approved', 'repair']);
    const v = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-void`, { reason: 'Wrong parts quoted' }));
    assert.equal(v.success, true, JSON.stringify(v));
    assert.equal(v.claim.stage, 'diagnosing');
    const after = claimRow(raw, id);
    assert.deepEqual([after.stage, after.decision, after.decision_reason, after.claim_kind], ['diagnosing', null, null, null]);
    assert.ok(row(raw, "SELECT 1 FROM audit_log WHERE action = 'warranty.care_voided' AND target = ?", id));
    // The advice of CARE_ALREADY_APPROVED is achievable: void, then quote again.
    const again = await json(await quote(raw, OWNER, id));
    assert.equal(again.success, true, JSON.stringify(again));
    assert.equal(again.quote.state, 'quoted');
    assert.equal(again.claim.claim_kind, 'care');
  } finally {
    raw.close();
  }
});

test('rejecting a claim voids its approved Care in the same move; never once the co-pay was collected', async () => {
  const raw = seed();
  try {
    const id = await approvedCare(raw);
    const res = await patch(as(raw, OWNER), `/api/devices/admin/claims/${id}`, { stage: 'rejected', decision: 'misuse', reason: 'Burnt by a power surge' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(row<{ state: string }>(raw, 'SELECT state FROM care_claim_benefits WHERE claim_id = ?', id)!.state, 'void');
    assert.deepEqual([claimRow(raw, id).stage, claimRow(raw, id).claim_kind], ['rejected', null]);
    // Nothing to collect on a rejected claim.
    assert.equal((await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-copay`, { operation_id: 'copay-rej-0001' }))).code, 'CARE_COPAY_CLAIM_REJECTED');
    // An older row (approved benefit, rejected claim) is refused the co-pay too.
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status, claim_kind)
              VALUES ('wc_rej','buyer','oi1','Bambu A1','old','u3','rejected','rejected','care')`);
    raw.prepare(`INSERT INTO care_claim_benefits (id, claim_id, entitlement_unit_id, order_item_id, policy_version, quote_json, list_iqd, eligible_iqd,
                   discount_pct, benefit_iqd, copay_iqd, state, quoted_at, decided_at) VALUES ('ccb_rej','wc_rej','u3','oi2',1,'{}',40000,40000,50,20000,20000,'approved',?,?)`)
      .run(iso(Date.now()), iso(Date.now()));
    assert.equal((await json(await post(as(raw, FINANCE), '/api/devices/admin/claims/wc_rej/care-copay', { operation_id: 'copay-rej-0002' }))).code, 'CARE_COPAY_CLAIM_REJECTED');
    assert.equal(row<{ c: string | null }>(raw, "SELECT copay_collected_at AS c FROM care_claim_benefits WHERE claim_id = 'wc_rej'")!.c, null);
  } finally {
    raw.close();
  }
  const raw2 = seed();
  try {
    const id = await approvedCare(raw2);
    const got = await json(await post(as(raw2, FINANCE), `/api/devices/admin/claims/${id}/care-copay`, { operation_id: 'copay-col-0001' }));
    assert.equal(got.success, true, JSON.stringify(got));
    const res = await patch(as(raw2, OWNER), `/api/devices/admin/claims/${id}`, { stage: 'rejected', decision: 'reject', reason: 'Changed our mind' });
    assert.equal(res.status, 409, await res.clone().text());
    assert.equal((await json(res)).code, 'CARE_REJECT_COPAY_COLLECTED');
    assert.deepEqual([claimRow(raw2, id).stage, claimRow(raw2, id).claim_kind], ['approved', 'care']);
    assert.equal(row<{ state: string }>(raw2, 'SELECT state FROM care_claim_benefits WHERE claim_id = ?', id)!.state, 'approved');
    // The void route answers the same money in its own words.
    assert.equal((await json(await post(as(raw2, FINANCE), `/api/devices/admin/claims/${id}/care-void`, { reason: 'Changed our mind' }))).code, 'CARE_COPAY_COLLECTED');
  } finally {
    raw2.close();
  }
});

test('a co-pay operation id already spent on another claim is refused (CLAIM_COST_OPERATION_REUSED), never a 500', async () => {
  const raw = seed();
  try {
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status, claim_kind)
              VALUES ('wc_other','buyer','oi2','Bambu A1','other','u3','resolved','approved','care')`);
    raw.prepare(`INSERT INTO care_claim_benefits (id, claim_id, entitlement_unit_id, order_item_id, policy_version, quote_json, list_iqd, eligible_iqd,
                   discount_pct, benefit_iqd, copay_iqd, state, quoted_at, decided_at, copay_collected_at, copay_collected_day, copay_operation_id)
                 VALUES ('ccb_other','wc_other','u3','oi2',1,'{}',40000,40000,50,20000,20000,'approved',?,?,?,?,'copay-shared-01')`)
      .run(iso(Date.now()), iso(Date.now()), iso(Date.now()), baghdadDay());
    const id = await approvedCare(raw);
    const res = await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-copay`, { operation_id: 'copay-shared-01' });
    assert.equal(res.status, 409, await res.clone().text());
    assert.equal((await json(res)).code, 'CLAIM_COST_OPERATION_REUSED');
    assert.equal(row<{ c: string | null }>(raw, 'SELECT copay_collected_at AS c FROM care_claim_benefits WHERE claim_id = ?', id)!.c, null);
  } finally {
    raw.close();
  }
});

test('a cost recorded before the claim became Care is reported as Care (the claim’s kind at report time); the expense is not rewritten', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const day = baghdadDay();
    const cost = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/costs`, { kind: 'courier', amount_iqd: 6_000, cost_day: day, operation_id: 'cost-kind-0001' }));
    assert.equal(cost.cost.claim_kind, 'warranty', JSON.stringify(cost));
    const before = (await serviceClaimsSummary(asD1(raw), { from: day, to: day }, { laborIqd: null }))!;
    assert.deepEqual([before.warranty_cost_iqd, before.care_cost_iqd], [6_000, 0]);
    await quote(raw, OWNER, id);
    const care = (await serviceClaimsSummary(asD1(raw), { from: day, to: day }, { laborIqd: null }))!;
    assert.deepEqual([care.warranty_cost_iqd, care.care_cost_iqd], [0, 6_000]);
    // The recorded expense keeps its category and journal (no closed period is ever rewritten).
    assert.equal(row<{ c: string }>(raw, 'SELECT e.category_id AS c FROM operating_expenses e JOIN service_claim_costs s ON s.expense_id = e.id WHERE s.claim_id = ?', id)!.c, 'exp_warranty_claims');
    // Its Care voided, the claim is a warranty claim again — and so is its cost.
    await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/care-void`, { reason: 'Handled as warranty' });
    const back = (await serviceClaimsSummary(asD1(raw), { from: day, to: day }, { laborIqd: null }))!;
    assert.deepEqual([back.warranty_cost_iqd, back.care_cost_iqd], [6_000, 0]);
  } finally {
    raw.close();
  }
});

test('/mine shows no Care on a device the user transferred away', async () => {
  const raw = seed();
  try {
    raw.exec("UPDATE order_item_units SET owner_user_id = 'omar' WHERE id = 'u1'");
    const mine = await json(await get(as(raw, BUYER), '/api/devices/mine'));
    const card = mine.devices.find((d: { unit_id: string }) => d.unit_id === 'u1');
    assert.ok(card, 'the transferred device is still on the list');
    assert.equal(card.transferred, true);
    assert.equal(card.care, null);
    assert.equal(mine.devices.find((d: { unit_id: string }) => d.unit_id === 'u2').care.state, 'active', 'a device still held keeps its Care');
  } finally {
    raw.close();
  }
});

test('PERIOD_CLOSED has words on the screens (ar / en / ckb)', () => {
  const t = REFUSAL_STRINGS.PERIOD_CLOSED;
  assert.ok(t && t.ar && t.en && t.ckb);
  assert.notEqual(t.ckb, t.ar);
});
