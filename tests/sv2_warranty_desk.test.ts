/**
 * SERVICES V2 — THE WARRANTY DESK (stage S-P0a, services-v2/warranty.md §B.9
 * «S0»): one definition of «open» (W-5), a closed claim's thread (W-4), the
 * returned-device answer (W-6), the decision the desk now sends, staff
 * attachments in a reply, the sheets that replaced `window.prompt`, and the
 * evidence label that no longer says «optional».
 *
 * Run: node --import tsx --test tests/sv2_warranty_desk.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, post, patch, json, row, all, memoryBucket, type StubUser } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';
import { CLAIM_STAGES, claimIsOpen, closedClaimSql, effectiveClaimStage, effectiveClaimStageSql } from '../worker/lib/deviceOps';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { WARRANTY_STRINGS } from '../src/components/warranty/strings';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'sara@x.co' };
const OTHER: StubUser = { id: 'omar', role: 'customer', email: 'omar@x.co' };
const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };

function seed(): DatabaseSync {
  const raw = freshDb();
  const delivered = iso(Date.now() - 60 * DAY);
  const end = iso(Date.now() + 300 * DAY);
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale,admin_scope) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('omar','Omar','omar@x.co','omar','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('boss','Owner','boss@x.co','boss','h','admin','2026-01-01T00:00:00.000Z','ar',NULL),
      ('helper','Helper','helper@x.co','helper','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'${delivered}');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi1','ORD-1','p1','Bambu A1',2,899000,1798000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
       delivered_at, warranty_base_months, warranty_start_at, warranty_end_at) VALUES
      ('u1','ORD-1','oi1','p1','buyer',1,'${delivered}',12,'${delivered}','${end}'),
      ('u2','ORD-1','oi1','p1','buyer',2,'${delivered}',12,'${delivered}','${end}');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer');
  `);
  return raw;
}
const as = (raw: DatabaseSync, who: StubUser, env: Record<string, unknown> = {}) =>
  stubApp(asD1(raw), who, (a) => a.route('/api/devices', deviceRoutes), { env });

async function file(raw: DatabaseSync, key = 'desk-key-00001') {
  const res = await json(
    await post(as(raw, BUYER), '/api/devices/units/u1/claims', {
      subject: 'Nozzle clogs',
      description: 'The nozzle clogs after every second print.',
      idempotencyKey: key,
    })
  );
  assert.equal(res.success, true, JSON.stringify(res));
  return res.id as string;
}
const move = (raw: DatabaseSync, who: StubUser, id: string, body: Record<string, unknown>) =>
  patch(as(raw, who), `/api/devices/admin/claims/${id}`, body);
const say = (raw: DatabaseSync, who: StubUser, id: string, body: Record<string, unknown>) =>
  post(as(raw, who), `/api/devices/claims/${id}/messages`, body);
const messages = (raw: DatabaseSync, id: string) =>
  Number(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM claim_messages WHERE claim_id = ?', id)!.n);

// ------------------------------------------------------------- W-5, one rule
test('one definition of «open»: the TypeScript and the SQL agree on every stage and every legacy status', () => {
  const raw = seed();
  try {
    const stages: Array<string | null> = [...CLAIM_STAGES, null, 'unknown_stage'];
    const statuses = ['submitted', 'in_review', 'approved', 'rejected'];
    let n = 0;
    // unit_id NULL: since 0191 one device holds one open case (W-3), and this
    // matrix is about the definition, not the device.
    const insert = raw.prepare(
      `INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status)
       VALUES (?, 'buyer', 'oi1', 'Bambu A1', 'matrix row', NULL, ?, ?)`
    );
    for (const stage of stages) for (const status of statuses) insert.run(`wc_m${n++}`, stage, status);
    const rows = all<{ id: string; stage: string | null; status: string; eff: string; open: number }>(
      raw,
      `SELECT wc.id, wc.stage, wc.status, ${effectiveClaimStageSql('wc')} AS eff, NOT ${closedClaimSql('wc')} AS open
         FROM warranty_claims wc`
    );
    assert.equal(rows.length, stages.length * statuses.length);
    for (const r of rows) {
      assert.equal(r.eff, effectiveClaimStage(r.stage, r.status), `effective stage of (${r.stage}, ${r.status})`);
      assert.equal(r.open === 1, claimIsOpen(r.stage, r.status), `open of (${r.stage}, ${r.status})`);
    }
    // The legacy rows the survey found (W-5): «approved» before stages existed
    // was the end of the claim; «in_review» is still being looked at.
    assert.equal(effectiveClaimStage(null, 'approved'), 'resolved');
    assert.equal(claimIsOpen(null, 'approved'), false);
    assert.equal(claimIsOpen(null, 'in_review'), true);
    assert.equal(claimIsOpen('replaced', 'approved'), false);
    assert.equal(claimIsOpen('repairing', 'approved'), true);
    // The database's own «one open case per device» (0191, W-3) spells «open»
    // with this very text — for the new row, the old row and every other claim
    // on the unit. Whitespace aside, a change here that is not made there fails.
    const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    const migration = flat(read('migrations/0191_services_integrity.sql'));
    for (const alias of ['NEW', 'OLD', 'wc']) {
      assert.ok(migration.includes(flat(closedClaimSql(alias))), `0191 spells «closed» for ${alias} as closedClaimSql('${alias}')`);
    }
  } finally {
    raw.close();
  }
});

test('every reader carries the same «open»: the customer list, the claim view and the desk queue', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const flags = async () => {
      const list = await json(await get(as(raw, BUYER), '/api/devices/claims'));
      const one = await json(await get(as(raw, BUYER), `/api/devices/claims/${id}`));
      const queue = await json(await get(as(raw, OWNER), '/api/devices/admin/claims?stage=all'));
      const mine = await json(await get(as(raw, BUYER), '/api/devices/mine'));
      return [
        list.claims[0].open,
        one.claim.open,
        queue.claims.find((c: { id: string }) => c.id === id).open,
        mine.devices.find((d: { unit_id: string }) => d.unit_id === 'u1').open_claims > 0,
      ];
    };
    assert.deepEqual(await flags(), [true, true, true, true]);
    assert.equal((await move(raw, OWNER, id, { stage: 'rejected', decision: 'misuse', reason: 'Burnt by a wrong voltage' })).status, 200);
    assert.deepEqual(await flags(), [false, false, false, false]);
  } finally {
    raw.close();
  }
});

test('a legacy approved claim reads «resolved» on the desk, and the desk has no move left on it', async () => {
  const raw = seed();
  try {
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, status)
              VALUES ('wc_old','buyer','oi1','Bambu A1','approved before stages existed','u1','approved')`);
    const queue = await json(await get(as(raw, OWNER), '/api/devices/admin/claims?stage=resolved'));
    assert.deepEqual(queue.claims.map((c: { id: string }) => c.id), ['wc_old']);
    assert.equal(queue.counts.resolved, 1);
    assert.equal(queue.counts.approved, 0);
    const res = await move(raw, OWNER, 'wc_old', { stage: 'repairing' });
    assert.equal(res.status, 400, JSON.stringify(await json(res)));
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------- W-4, the thread
test('a closed claim takes no message from either side; reopening a rejected claim opens its thread again', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    assert.equal((await say(raw, BUYER, id, { body: 'Photo of the nozzle coming.' })).status, 200);
    assert.equal((await say(raw, ASSISTANT, id, { body: 'Thanks, we will look at it.' })).status, 200);
    assert.equal((await move(raw, OWNER, id, { stage: 'rejected', decision: 'reject', reason: 'Clog from wet filament' })).status, 200);

    const before = messages(raw, id);
    for (const who of [BUYER, ASSISTANT, OWNER]) {
      const res = await say(raw, who, id, { body: 'One more thing' });
      assert.equal(res.status, 409, `${who.id} wrote into a rejected claim`);
      assert.equal((await json(res)).code, 'CLAIM_CLOSED');
    }
    assert.equal(messages(raw, id), before, 'no message row was written');

    // Policy 5.9: a rejected claim may be reopened for another look — and then talked about again.
    assert.equal((await move(raw, ASSISTANT, id, { stage: 'diagnosing' })).status, 200);
    assert.equal((await say(raw, BUYER, id, { body: 'Here is a new video.' })).status, 200);
  } finally {
    raw.close();
  }
});

test('a replaced claim is closed too', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    assert.equal((await move(raw, OWNER, id, { stage: 'approved', decision: 'replace', reason: 'Mainboard failure confirmed' })).status, 200);
    raw.exec(`UPDATE order_item_units SET replaced_by_unit_id = 'u2' WHERE id = 'u1'`);
    assert.equal((await move(raw, OWNER, id, { stage: 'replaced', reason: 'New unit handed over' })).status, 200);
    const res = await say(raw, BUYER, id, { body: 'Thanks!' });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'CLAIM_CLOSED');
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------- the decision
test('the decision sent with a move is stored, and an assistant cannot send one', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const refused = await move(raw, ASSISTANT, id, { stage: 'approved', decision: 'repair', reason: 'Hotend swap' });
    assert.equal(refused.status, 403);
    assert.equal((await json(refused)).code, 'FINANCIAL_SCOPE_REQUIRED');
    assert.equal((await move(raw, OWNER, id, { stage: 'approved', decision: 'replace', reason: 'Board cannot be repaired' })).status, 200);
    const stored = row<{ stage: string; decision: string | null }>(raw, 'SELECT stage, decision FROM warranty_claims WHERE id = ?', id)!;
    assert.deepEqual({ ...stored }, { stage: 'approved', decision: 'replace' });
    // The assistant moves the accepted claim into repair, which keeps a decision that fits.
    assert.equal((await move(raw, ASSISTANT, id, { stage: 'repairing' })).status, 200);
    assert.equal(row<{ decision: string }>(raw, 'SELECT decision FROM warranty_claims WHERE id = ?', id)!.decision, 'replace');
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------- staff attachments
test('a staff reply carries a photo the claimant can open, and nobody else', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const bucket = memoryBucket();
    const key = 'claims/boss/photos/nozzle-closeup.jpg';
    await bucket.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]), { httpMetadata: { contentType: 'image/jpeg' } });
    const env = { BUCKET: bucket };

    // Staff may attach only their OWN uploads.
    const foreign = await say(raw, OWNER, id, { body: 'see', file_key: 'claims/buyer/photos/x.jpg' });
    assert.equal(foreign.status, 400);

    const sent = await json(await post(as(raw, OWNER, env), `/api/devices/claims/${id}/messages`, { body: 'This is the clog.', file_key: key }));
    assert.equal(sent.success, true, JSON.stringify(sent));
    assert.equal(sent.message.file_url, `/api/devices/claim-files/${key}`);

    const thread = await json(await get(as(raw, BUYER, env), `/api/devices/claims/${id}`));
    const staffMsg = thread.messages.find((m: { is_staff: boolean }) => m.is_staff);
    assert.equal(staffMsg.file_url, `/api/devices/claim-files/${key}`);
    assert.equal((await get(as(raw, BUYER, env), staffMsg.file_url)).status, 200, 'the claimant opens the staff photo');
    assert.equal((await get(as(raw, OTHER, env), staffMsg.file_url)).status, 403, 'another customer does not');
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------- W-6, a variant
test('a returned device is refused with DEVICE_NOT_WITH_CUSTOMER even while its link still stands', async () => {
  const raw = seed();
  try {
    raw.exec(`UPDATE order_item_units SET warranty_closed_at = '2026-10-01T00:00:00.000Z', warranty_closed_reason = 'returned' WHERE id = 'u1'`);
    const res = await post(as(raw, BUYER), '/api/devices/units/u1/claims', {
      subject: 'Broken',
      description: 'It does not power on any more.',
      idempotencyKey: 'desk-w6-key-0001',
    });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'DEVICE_NOT_WITH_CUSTOMER');
    assert.equal(Number(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM warranty_claims')!.n), 0);
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------- refusal copy
test('CLAIM_CLOSED reads in Arabic, English and Sorani of its own', () => {
  const e = REFUSAL_STRINGS.CLAIM_CLOSED;
  assert.ok(e && e.ar && e.en && e.ckb);
  assert.notEqual(e.ckb, e.ar);
  assert.notEqual(e.ckb, e.en);
});

// ------------------------------------------------------------- the screens
test('the desk asks in sheets, sends the decision, and lets staff attach a photo or video', () => {
  const src = read('src/components/AdminSerials.tsx');
  assert.doesNotMatch(src, /window\.prompt\s*\(/, 'no browser prompt is left on the desk');
  // The delivery correction: a date-and-time field in a sheet, sent as an ISO instant.
  assert.match(src, /type="datetime-local"/);
  assert.match(src, /\{ kind: 'delivery'; device: AdminDevice \}/);
  assert.match(src, /api\.patch\(`\/api\/devices\/admin\/units\/\$\{pending\.device\.unit_id\}\/delivery`, \{ delivered_at: deliveredAt, reason \}\)/);
  // The claim move: the decision goes with the move.
  assert.match(src, /testId="admin-claim-move"/);
  assert.match(src, /decision: options\.length > 0 \? moveDecision : undefined/);
  assert.match(src, /approved: \['repair', 'replace'\],\s*rejected: \['reject', 'misuse'\]/);
  // A staff reply may carry a file, uploaded through the staff member's own prefix.
  assert.match(src, /'\/api\/devices\/claims\/upload'/);
  assert.match(src, /\{ body: text, file_key: fileKey \}/);
  // A closed claim's thread shows why there is no reply box.
  assert.match(src, /!claimIsOpen\(cl\) \?/);
  // The replacement note no longer says the rule is pending (row 193 decided it).
  assert.doesNotMatch(src, /pending owner decision|بانتظار قرار المالك|چاوەڕوانی بڕیاری خاوەنە/);
  assert.doesNotMatch(read('worker/routes/devices.ts'), /pending an owner decision/);
});

test('every new desk string exists in the three languages, and the Sorani is not the Arabic', () => {
  const src = read('src/components/AdminSerials.tsx');
  const keys = [
    'deliveryTitle', 'deliveryBody', 'deliveryLabel', 'deliveryCurrent', 'deliveryLaterOwner', 'deliveryInvalid',
    'saveDelivery', 'deliverySaved', 'replacedOk', 'decision', 'decisionPick', 'decisionRequired', 'reasonToCustomer',
    'noteToCustomer', 'financialOnly', 'replacedFirst', 'confirmMove', 'threadClosed', 'threadReopen', 'attachFile',
    'uploading', 'video', 'awaitingStaff', 'loadMore',
  ];
  for (const key of keys) {
    const values = [...src.matchAll(new RegExp(`\\n    ${key}: '([^']+)'`, 'g'))].map((m) => m[1]);
    assert.equal(values.length, 3, `${key}: one value per language (found ${values.length})`);
    const [ar, en, ckb] = values;
    assert.notEqual(ckb, ar, `${key}: the Sorani is the Arabic`);
    assert.notEqual(ckb, en, `${key}: the Sorani is the English`);
    assert.notEqual(ar, en, `${key}: the Arabic is the English`);
  }
  const titles = [...src.matchAll(/\n {4}moveTitle: \(stage: string\) => `([^`]+)`/g)].map((m) => m[1]);
  assert.equal(new Set(titles).size, 3);
});

test('the claim form says what the policy asks for, never «optional»; a closed thread says so', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = WARRANTY_STRINGS[lang];
    assert.doesNotMatch(s.attachments, /optional|اختياري|ئارەزوومەندانە/i, `${lang}: the evidence label`);
    assert.match(s.evidenceHint, /5\.7/, `${lang}: the hint names the policy article`);
    assert.ok(s.threadClosed.length > 20, `${lang}: the closed-thread note`);
  }
  assert.match(read('src/components/warranty/ClaimForms.tsx'), /\{s\.evidenceHint\}/);
  const thread = read('src/components/warranty/ClaimThreadOverlay.tsx');
  assert.match(thread, /const closed = !!detail && !claimOpen\(detail\.claim\)/);
  assert.match(thread, /\{s\.threadClosed\}/);
  assert.match(thread, /e\.code === 'CLAIM_CLOSED'/);
});
