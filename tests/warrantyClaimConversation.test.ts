/**
 * «المحادثة التي تخص الضمان لا يوجد هنالك توضيح أو زر معين يظهر أن عند الضغط
 *  على مطالباتي … تفتح المحادثة ولا يرسل الإشعار إلى المستخدم بأن هناك رسالة
 *  جديدة تخص الضمان».
 *
 * TWO HALVES OF ONE SILENCE, and each is pinned here through the door the
 * owner's customer actually uses:
 *
 *   · THE NOTIFICATION. POST /api/devices/claims/:id/messages told the owner's
 *     «🔥 Warranty support» topic about every CUSTOMER message and told the
 *     customer about no STAFF message — no bell row, no outbox row, nothing.
 *     A stage decision (rejected, approved, replaced) was told to nobody.
 *   · THE DOOR. «مطالباتي» listed claims with nothing that said a tap opens a
 *     conversation, nothing that counted its messages and nothing that said a
 *     new answer was waiting — and the list route returned no data a screen
 *     could have said it with.
 *
 * And the admin queue, which filtered by stage AFTER `LIMIT 300` and so hid
 * every older claim at the stage an admin picked.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, post, patch, json, count, all, pending } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';

const ENV = {
  EMAIL_API_KEY: 're_k',
  EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
  TELEGRAM_BOT_TOKEN: '111:TOKEN',
};

// Nothing in here may reach a real provider; every outbound call answers ok.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

async function drain(): Promise<void> {
  while (pending.length) await Promise.all(pending.splice(0, pending.length));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** The buyer can be reached by email AND Telegram; the admin is 'boss'. */
function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('boss','Admin','boss@x.co','boss','h','admin','2026-01-01T00:00:00.000Z','ar');
    INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
      VALUES ('buyer', 4242, 555, '+9647701234567', '2026-01-01T00:00:00.000Z');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'2026-01-04T10:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi1','ORD-1','p1','Bambu A1',1,899000,899000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
       delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
     VALUES ('u1','ORD-1','oi1','p1','buyer',1,'2026-01-04T10:00:00.000Z',12,'2026-01-04T10:00:00.000Z','2099-01-04T10:00:00.000Z');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer');
  `);
  return raw;
}

const customer = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'sara@x.co' }, (a) => a.route('/api/devices', deviceRoutes), { env: ENV });
const admin = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/devices', deviceRoutes), { env: ENV });

async function openClaim(raw: DatabaseSync): Promise<string> {
  const res = await json(
    await post(customer(raw), '/api/devices/units/u1/claims', {
      subject: 'Nozzle clog',
      description: 'It stopped extruding after two prints.',
      idempotencyKey: 'idem-key-conversation',
    })
  );
  assert.equal(res.success, true, JSON.stringify(res));
  return res.id as string;
}

const bellRows = (raw: DatabaseSync, kind: string) =>
  all<{ user_id: string; link: string; entity_type: string; entity_id: string; event_key: string; title_ar: string; body_ar: string; body_en: string }>(
    raw,
    'SELECT user_id, link, entity_type, entity_id, event_key, title_ar, body_ar, body_en FROM user_notifications WHERE kind = ? ORDER BY created_at, rowid',
    kind
  );
const outboxFor = (raw: DatabaseSync, prefix: string) =>
  all<{ kind: string; event_key: string; payload: string }>(
    raw,
    "SELECT kind, event_key, payload FROM outbox WHERE event_key LIKE ? || '%' ORDER BY event_key",
    prefix
  );

// ------------------------------------------------------------------ replies

test('a staff reply reaches the claimant: one bell row that opens the thread, and the outbound channels', async () => {
  const raw = seed();
  try {
    const claimId = await openClaim(raw);
    const sent = await json(await post(admin(raw), `/api/devices/claims/${claimId}/messages`, { body: 'Please send a photo of the nozzle.' }));
    assert.equal(sent.success, true, JSON.stringify(sent));
    await drain();

    const rows = bellRows(raw, 'warranty_reply');
    assert.equal(rows.length, 1, 'exactly one in-app row for one reply');
    assert.equal(rows[0].user_id, 'buyer');
    // The link is the thread itself, which the Warranty page opens from `claim`.
    assert.equal(rows[0].link, `/warranty?claim=${claimId}`);
    assert.equal(rows[0].entity_type, 'claim');
    assert.equal(rows[0].entity_id, claimId);
    assert.equal(rows[0].event_key, `claim.reply:${sent.id}`);

    const out = outboxFor(raw, `claim.reply:${sent.id}:`);
    assert.deepEqual(
      out.map((o) => o.kind).sort(),
      ['email', 'telegram'],
      'the claimant is reached on every channel they have'
    );

    // A second answer is news too — keyed on the message, not the claim.
    await post(admin(raw), `/api/devices/claims/${claimId}/messages`, { body: 'Thank you, received.' });
    await drain();
    assert.equal(bellRows(raw, 'warranty_reply').length, 2);
  } finally {
    raw.close();
  }
});

test('the customer\'s own message notifies the customer of nothing', async () => {
  const raw = seed();
  try {
    const claimId = await openClaim(raw);
    await post(customer(raw), `/api/devices/claims/${claimId}/messages`, { body: 'Here is more detail about the clog.' });
    await drain();
    assert.equal(count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE kind = 'warranty_reply'"), 0);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'claim.%'"), 0);
  } finally {
    raw.close();
  }
});

test('what the team wrote never travels through a third party, and never into the bell', async () => {
  const raw = seed();
  try {
    const claimId = await openClaim(raw);
    const secret = 'Replacement serial SN-SECRET-9911 ships Tuesday';
    const sent = await json(await post(admin(raw), `/api/devices/claims/${claimId}/messages`, { body: secret }));
    await drain();
    for (const o of outboxFor(raw, `claim.reply:${sent.id}:`)) assert.doesNotMatch(o.payload, /SN-SECRET-9911/);
    const [bell] = bellRows(raw, 'warranty_reply');
    assert.doesNotMatch(bell.body_ar + bell.body_en, /SN-SECRET-9911/);
    // It names the printer, which is how the customer recognises the claim.
    assert.match(bell.body_ar, /Bambu A1/);
  } finally {
    raw.close();
  }
});

test('the POST answers with the stored message, so the thread appends instead of reloading', async () => {
  const raw = seed();
  try {
    const claimId = await openClaim(raw);
    const sent = await json(await post(customer(raw), `/api/devices/claims/${claimId}/messages`, { body: 'Photo coming.' }));
    const stored = all<{ id: string; created_at: string }>(raw, 'SELECT id, created_at FROM claim_messages WHERE claim_id = ?', claimId);
    assert.equal(stored.length, 1);
    assert.deepEqual(
      { id: sent.message.id, created_at: sent.message.created_at, body: sent.message.body, mine: sent.message.mine, is_staff: sent.message.is_staff },
      { id: stored[0].id, created_at: stored[0].created_at, body: 'Photo coming.', mine: true, is_staff: false }
    );
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------------- stages

test('a stage move tells the claimant where the claim stands — with the reason in the bell, not on WhatsApp', async () => {
  const raw = seed();
  try {
    const claimId = await openClaim(raw);
    const reason = 'The nozzle was forced with a metal tool';
    const moved = await json(await patch(admin(raw), `/api/devices/admin/claims/${claimId}`, { stage: 'rejected', reason }));
    assert.equal(moved.success, true, JSON.stringify(moved));
    await drain();

    const rows = bellRows(raw, 'warranty_stage');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].link, `/warranty?claim=${claimId}`);
    assert.match(rows[0].body_ar, /مرفوضة/);
    assert.match(rows[0].body_ar, /metal tool/, 'the customer is owed the reason, behind their login');

    const out = outboxFor(raw, `claim.stage:${claimId}:rejected:`);
    assert.ok(out.length >= 1, 'the decision reaches the claimant outside the site too');
    for (const o of out) assert.doesNotMatch(o.payload, /metal tool/);
  } finally {
    raw.close();
  }
});

test('re-saving the same stage is not news; reaching a stage a second time is', async () => {
  const raw = seed();
  try {
    const claimId = await openClaim(raw);
    const a = admin(raw);
    await patch(a, `/api/devices/admin/claims/${claimId}`, { stage: 'rejected', reason: 'Not covered: physical damage' });
    await drain();
    // Amending the reason on a claim already rejected.
    await patch(a, `/api/devices/admin/claims/${claimId}`, { stage: 'rejected', reason: 'Not covered: physical damage to the hotend' });
    await drain();
    assert.equal(bellRows(raw, 'warranty_stage').length, 1);

    // Reopened for another look, then refused again: two real decisions.
    await patch(a, `/api/devices/admin/claims/${claimId}`, { stage: 'diagnosing' });
    await drain();
    await new Promise((r) => setTimeout(r, 5));
    await patch(a, `/api/devices/admin/claims/${claimId}`, { stage: 'rejected', reason: 'Confirmed after inspection' });
    await drain();
    const rows = bellRows(raw, 'warranty_stage');
    assert.equal(rows.length, 3);
    // The reopen carries no stale rejection reason.
    assert.doesNotMatch(rows[1].body_ar, /physical damage/);
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------ the door: «مطالباتي»

test('«مطالباتي» says how big each conversation is and when the team wrote since the customer looked', async () => {
  const raw = seed();
  try {
    const claimId = await openClaim(raw);
    const c = customer(raw);
    const a = admin(raw);
    const mine = async () => (await json(await get(c, '/api/devices/claims'))).claims.find((x: { id: string }) => x.id === claimId);

    let cl = await mine();
    assert.equal(cl.message_count, 0);
    assert.equal(cl.unread, false);

    await post(a, `/api/devices/claims/${claimId}/messages`, { body: 'Please send a photo.' });
    cl = await mine();
    assert.equal(cl.message_count, 1);
    assert.equal(cl.unread, true, '«رد جديد من الفريق»');
    assert.ok(cl.last_staff_message_at);

    // An ADMIN opening the thread is not the customer reading it.
    await get(a, `/api/devices/claims/${claimId}`);
    assert.equal((await mine()).unread, true);

    // The customer opening it is.
    await get(c, `/api/devices/claims/${claimId}`);
    assert.equal((await mine()).unread, false);

    await new Promise((r) => setTimeout(r, 5));
    await post(a, `/api/devices/claims/${claimId}/messages`, { body: 'Any news?' });
    assert.equal((await mine()).unread, true);

    // Answering is proof of having read.
    await new Promise((r) => setTimeout(r, 5));
    await post(c, `/api/devices/claims/${claimId}/messages`, { body: 'Sending it now.' });
    cl = await mine();
    assert.equal(cl.unread, false);
    assert.equal(cl.message_count, 3);
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------ the admin queue

test('the admin queue filters in SQL before it pages — the oldest claims at a stage are not cut off', async () => {
  const raw = seed();
  try {
    const insert = raw.prepare(
      `INSERT INTO warranty_claims (id, user_id, product_name, description, status, stage, created_at)
       VALUES (?, 'buyer', 'Bambu A1', 'x', ?, ?, ?)`
    );
    // Ten OLD received claims, then three hundred newer ones being diagnosed.
    for (let i = 0; i < 10; i++) insert.run(`wc_old_${i}`, 'submitted', 'received', `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z`);
    for (let i = 0; i < 300; i++) {
      insert.run(`wc_new_${i}`, 'in_review', 'diagnosing', new Date(Date.parse('2026-02-01T00:00:00.000Z') + i * 60_000).toISOString());
    }
    // A claim from before the stage column: NULL stage, legacy 'in_review' —
    // listed as «diagnosing», so it must be FILTERED as «diagnosing».
    insert.run('wc_legacy', 'in_review', null, '2024-06-01T00:00:00.000Z');

    const a = admin(raw);
    const received = await json(await get(a, '/api/devices/admin/claims?stage=received'));
    assert.equal(received.total, 10);
    assert.equal(received.claims.length, 10, 'every received claim, although 300 newer ones outrank them');
    assert.ok(received.claims.every((x: { stage: string }) => x.stage === 'received'));

    const diag = await json(await get(a, '/api/devices/admin/claims?stage=diagnosing&limit=100'));
    assert.equal(diag.total, 301);
    assert.equal(diag.claims.length, 100);
    assert.equal(diag.has_more, true);
    const last = await json(await get(a, '/api/devices/admin/claims?stage=diagnosing&limit=100&page=4'));
    assert.equal(last.claims.length, 1);
    assert.equal(last.claims[0].id, 'wc_legacy');
    assert.equal(last.has_more, false);

    const everything = await json(await get(a, '/api/devices/admin/claims'));
    assert.equal(everything.counts.all, 311);
    assert.equal(everything.counts.received, 10);
    assert.equal(everything.counts.diagnosing, 301);

    assert.equal((await get(a, '/api/devices/admin/claims?stage=bogus')).status, 400);
  } finally {
    raw.close();
  }
});

test('«عرض المزيد» continues from the last claim seen — a claim moved away meanwhile does not hide the next one', async () => {
  const raw = seed();
  try {
    const insert = raw.prepare(
      `INSERT INTO warranty_claims (id, user_id, product_name, description, status, stage, created_at)
       VALUES (?, 'buyer', 'Bambu A1', 'x', 'submitted', 'received', ?)`
    );
    // Newest first: wc_5 … wc_1.
    for (let i = 1; i <= 5; i++) insert.run(`wc_${i}`, `2026-03-0${i}T00:00:00.000Z`);
    const a = admin(raw);
    const first = await json(await get(a, '/api/devices/admin/claims?stage=received&limit=2'));
    assert.deepEqual(first.claims.map((x: { id: string }) => x.id), ['wc_5', 'wc_4']);
    assert.equal(first.has_more, true);
    // Another admin moves wc_5 to «diagnosing» while this page is open. With an
    // OFFSET the next page would start at the 3rd remaining row and skip wc_3.
    raw.exec("UPDATE warranty_claims SET stage = 'diagnosing' WHERE id = 'wc_5'");
    const qs = new URLSearchParams({ stage: 'received', limit: '2', after: first.next_cursor });
    const second = await json(await get(a, `/api/devices/admin/claims?${qs.toString()}`));
    assert.deepEqual(second.claims.map((x: { id: string }) => x.id), ['wc_3', 'wc_2']);
    assert.equal(second.has_more, true);
    const third = await json(
      await get(a, `/api/devices/admin/claims?${new URLSearchParams({ stage: 'received', limit: '2', after: second.next_cursor }).toString()}`)
    );
    assert.deepEqual(third.claims.map((x: { id: string }) => x.id), ['wc_1']);
    assert.equal(third.has_more, false);
    assert.equal((await get(a, '/api/devices/admin/claims?after=nonsense')).status, 400);
  } finally {
    raw.close();
  }
});

test('the admin queue says which conversations are waiting on the team', async () => {
  const raw = seed();
  try {
    const claimId = await openClaim(raw);
    await post(customer(raw), `/api/devices/claims/${claimId}/messages`, { body: 'Is anyone there?' });
    let q = (await json(await get(admin(raw), '/api/devices/admin/claims'))).claims.find((x: { id: string }) => x.id === claimId);
    assert.equal(q.awaiting_staff, true);
    assert.equal(q.message_count, 1);
    await new Promise((r) => setTimeout(r, 5));
    await post(admin(raw), `/api/devices/claims/${claimId}/messages`, { body: 'Yes — looking now.' });
    q = (await json(await get(admin(raw), '/api/devices/admin/claims'))).claims.find((x: { id: string }) => x.id === claimId);
    assert.equal(q.awaiting_staff, false);
  } finally {
    raw.close();
  }
});

// ------------------------------------------------------------ the client half

/**
 * The server half is worth nothing if the screen never reads it — the
 * failure this project keeps repeating. These pin the four client joints.
 */
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the claim card says it opens a conversation, counts it, and shows «رد جديد»', () => {
  const card = src('src/components/warranty/ClaimCard.tsx');
  assert.match(card, /\{s\.openThread\}/);
  assert.match(card, /s\.messagesCount\(/);
  assert.match(card, /claim\.unread === true/);
  assert.match(card, /\{s\.newReply\}/);
  const strings = src('src/components/warranty/strings.ts');
  assert.match(strings, /openThread: 'فتح المحادثة'/);
  assert.match(strings, /newReply: 'رد جديد من الفريق'/);
});

test('the page opens the thread a notification names, and explains the tap under «مطالباتي»', () => {
  const page = src('src/pages/Warranty.tsx');
  assert.match(page, /searchParams\.get\('claim'\)/);
  assert.match(page, /setOpenClaimId\(deepClaim\)/);
  assert.match(page, /\{s\.claimsHint\}/);
});

test('a replayed submit is said out loud and opens the conversation', () => {
  const form = src('src/components/warranty/ClaimForms.tsx');
  assert.match(form, /onSubmitted\(\{ id: res\.id, replay: res\.replay === true \}\)/);
  const page = src('src/pages/Warranty.tsx');
  assert.match(page, /if \(result\.replay\) \{[\s\S]*?s\.claimReplayNotice[\s\S]*?setOpenClaimId\(result\.id\)/);
});

test('the bell draws the warranty kinds with the warranty shield', () => {
  const bell = src('src/components/notifications/NotificationBell.tsx');
  assert.match(bell, /case 'warranty_reply':\s*case 'warranty_stage':\s*return ShieldCheck;/);
});
