/**
 * THE DISCUSSION UNDER A REQUEST (docs/COMMUNITY_ECOSYSTEM.md §9.5, migration
 * 0160) over the real routes and migrations:
 *
 *   · a public comment while the job is on the board, from anyone signed in;
 *     the customer hears ONE row per request whose count is PEOPLE;
 *   · a question only from a workshop whose LIVE verdict can make the job
 *     (a resin-only shop cannot ask about an FDM part), and never from the
 *     customer; the customer is told, and told again on the next question;
 *   · only the customer answers, and only a question of this request; the
 *     workshop that asked is told;
 *   · a stranger cannot read a direct (private) request's discussion, nor
 *     write in it; its store and its customer can;
 *   · the server's own rows («أُلغي», «تغيّر») sit inline in the thread;
 *   · removed rows leave the thread, hidden rows reach staff alone, and the
 *     page reads one row more than asked so the cursor is exact;
 *   · a report of a comment rides `community_reports` under target_type
 *     'comment' with the side table naming the real row, and the desk's
 *     listing resolves it.
 *
 * Run: node --import tsx --test tests/requestDiscussion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, send, json, count, row, all, type StubUser, type Mount } from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { requestDiscussionRoutes, writeRequestSystemUpdate } from '../worker/routes/requestDiscussion';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { wavesD1 } from './fixtures/wavesD1';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/marketplace', requestDiscussionRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};

const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'owner', role: 'customer', email: 'owner@x.co' };
const OMAR: StubUser = { id: 'owner2', role: 'customer', email: 'owner2@x.co' };
const NOUR: StubUser = { id: 'stranger', role: 'customer', email: 'stranger@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

/**
 * Sara's job, two workshops and a passer-by: Ali (m1) runs an FDM machine
 * that can make it; Omar (m2) runs a RESIN machine only, so his live verdict
 * for an FDM part fails on PROCESS; Nour has no workshop at all.
 */
function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','owner@x.co','h','customer'),
      ('owner2','Omar','owner2@x.co','h','customer'), ('stranger','Nour','stranger@x.co','h','customer'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max) VALUES
      ('p1','m1','s1','Big FDM','fdm',300,300,300,'[]','ultra'),
      ('p2','m2','s2','Resin only','resin',200,200,200,'[]','ultra');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const as = (raw: DatabaseSync, user: StubUser | null) => stubApp(asD1(raw), user, mount);
const del = (a: ReturnType<typeof as>, path: string) => send(a, 'DELETE', path, {});
const PLA = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1 };

/** Sara publishes an FDM job through the wizard — on the board, matched. */
async function published(raw: DatabaseSync): Promise<string> {
  const created = await json(await post(as(raw, BUYER), '/api/marketplace/requests', { title: 'A phone stand', description: 'A stand for a phone, please' }));
  const id = created.request.id as string;
  const pub = await post(as(raw, BUYER), `/api/marketplace/print/requests/${id}/publish`, PLA);
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return id;
}

const comments = (id: string) => `/api/marketplace/requests/${id}/comments`;
const notes = (raw: DatabaseSync, user: string, kind: string) =>
  all<{ id: string; title_en: string; body_en: string; meta: string; read_at: string | null; event_key: string; link: string }>(
    raw,
    'SELECT id, title_en, body_en, meta, read_at, event_key, link FROM user_notifications WHERE user_id = ? AND kind = ? ORDER BY created_at, rowid',
    user,
    kind
  );

// ============================================================ public comments

test('a public comment while the job is on the board: anyone signed in; the customer hears ONE row whose count is PEOPLE', async () => {
  const raw = seed();
  const id = await published(raw);

  const first = await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body: 'Lovely idea — which colour?' });
  assert.equal(first.status, 201, JSON.stringify(await json(first.clone())));
  const made = (await json(first)).comment;
  assert.equal(made.kind, 'public_comment');
  assert.equal(made.author.role, 'member');
  assert.equal(made.viewer.mine, true);

  let heard = notes(raw, 'buyer', 'request_comment');
  assert.equal(heard.length, 1);
  assert.equal(heard[0].event_key, `request_comment:${id}`);
  assert.equal(JSON.parse(heard[0].meta).count, 1);
  assert.equal(heard[0].title_en, 'Nour commented on your request “A phone stand”');
  assert.match(heard[0].link, /#discussion$/);
  assert.equal(JSON.parse(heard[0].meta).title_ckb.length > 0, true, 'Sorani is stamped');

  // A second PERSON raises the count; the same person again does not.
  assert.equal((await post(as(raw, ALI), comments(id), { kind: 'public_comment', body: 'I can do it in black PLA.' })).status, 201);
  heard = notes(raw, 'buyer', 'request_comment');
  assert.equal(heard.length, 1, 'one row per request');
  assert.equal(JSON.parse(heard[0].meta).count, 2);
  assert.equal(heard[0].title_en, '2 people commented on your request “A phone stand”');
  assert.equal((await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body: 'Or white?' })).status, 201);
  heard = notes(raw, 'buyer', 'request_comment');
  assert.equal(JSON.parse(heard[0].meta).count, 2, 'the count is people, not comments');

  // The customer's own comment tells nobody; a guest reads the board's thread.
  assert.equal((await post(as(raw, BUYER), comments(id), { kind: 'public_comment', body: 'Black, please.' })).status, 201);
  assert.equal(notes(raw, 'buyer', 'request_comment').length, 1);
  const page = await json(await get(as(raw, null), comments(id)));
  assert.equal(page.total, 4);
  assert.deepEqual(
    (page.comments as Array<{ author: { role: string } }>).map((c) => c.author.role),
    ['member', 'merchant', 'member', 'customer']
  );
  assert.equal(page.next_cursor, null);
  assert.deepEqual(page.can, { comment: false, ask: false, answer: false });
});

// ================================================================= questions

test('a question comes only from a workshop whose LIVE verdict can make the job — never from the customer; the customer is told each time', async () => {
  const raw = seed();
  const id = await published(raw);

  const resin = await post(as(raw, OMAR), comments(id), { kind: 'merchant_question', body: 'Which layer height?' });
  assert.equal(resin.status, 403);
  const why = await json(resin);
  assert.equal(why.code, 'COMMENT_KIND_NOT_ALLOWED');
  assert.equal(why.details.reason, 'PROCESS', 'a resin-only shop is not eligible for an FDM part');

  const nobody = await post(as(raw, NOUR), comments(id), { kind: 'merchant_question', body: 'Which layer height?' });
  assert.equal(nobody.status, 403);
  assert.equal((await json(nobody)).details.reason, 'NOT_A_WORKSHOP');

  const own = await post(as(raw, BUYER), comments(id), { kind: 'merchant_question', body: 'Asking myself' });
  assert.equal(own.status, 403);
  assert.equal((await json(own)).details.reason, 'OWN_REQUEST');

  const ok = await post(as(raw, ALI), comments(id), { kind: 'merchant_question', body: 'Do you need supports removed?' });
  assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
  assert.equal((await json(ok)).comment.kind, 'merchant_question');
  let heard = notes(raw, 'buyer', 'request_question');
  assert.equal(heard.length, 1);
  assert.equal(heard[0].title_en, 'Ali asked about your request “A phone stand”');
  assert.equal(JSON.parse(heard[0].meta).count, 1);

  // Read, then a SECOND question from the same workshop: the row comes back
  // unread with the new count — a question is addressed to one person.
  raw.exec("UPDATE user_notifications SET read_at = '2026-01-01T00:00:00.000Z' WHERE kind = 'request_question'");
  assert.equal((await post(as(raw, ALI), comments(id), { kind: 'merchant_question', body: 'And the wall thickness?' })).status, 201);
  heard = notes(raw, 'buyer', 'request_question');
  assert.equal(heard.length, 1, 'still one row per request');
  assert.equal(JSON.parse(heard[0].meta).count, 2);
  assert.equal(heard[0].read_at, null, 'back unread');
  assert.equal(heard[0].title_en, '2 new questions about your request “A phone stand”');
  assert.equal(heard[0].body_en, 'And the wall thickness?');

  // The composer's hint: a workshop sees «ask», the customer «answer».
  assert.equal((await json(await get(as(raw, ALI), comments(id)))).can.ask, true);
  assert.equal((await json(await get(as(raw, NOUR), comments(id)))).can.ask, false);
  assert.deepEqual((await json(await get(as(raw, BUYER), comments(id)))).can, { comment: true, ask: false, answer: true });
});

test('only the customer answers, and only a question of this request; the workshop that asked is told', async () => {
  const raw = seed();
  const id = await published(raw);
  const question = (await json(await post(as(raw, ALI), comments(id), { kind: 'merchant_question', body: 'Supports removed?' }))).comment.id as string;
  const remark = (await json(await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body: 'Nice' }))).comment.id as string;

  const notCustomer = await post(as(raw, ALI), comments(id), { kind: 'customer_answer', body: 'Yes', parent_id: question });
  assert.equal(notCustomer.status, 403);
  assert.equal((await json(notCustomer)).code, 'COMMENT_KIND_NOT_ALLOWED');

  const noParent = await post(as(raw, BUYER), comments(id), { kind: 'customer_answer', body: 'Yes please' });
  assert.equal(noParent.status, 400);
  assert.equal((await json(noParent)).code, 'COMMENT_PARENT_INVALID');
  const wrongParent = await post(as(raw, BUYER), comments(id), { kind: 'customer_answer', body: 'Yes please', parent_id: remark });
  assert.equal(wrongParent.status, 400);
  assert.equal((await json(wrongParent)).code, 'COMMENT_PARENT_INVALID');

  const answered = await post(as(raw, BUYER), comments(id), { kind: 'customer_answer', body: 'Yes please, and sand it lightly.', parent_id: question });
  assert.equal(answered.status, 201, JSON.stringify(await json(answered.clone())));
  const a = (await json(answered)).comment;
  assert.equal(a.kind, 'customer_answer');
  assert.equal(a.parent_id, question);
  assert.equal(a.author.role, 'customer');
  let heard = notes(raw, 'owner', 'request_answer');
  assert.equal(heard.length, 1);
  assert.equal(heard[0].event_key, `request_answer:${question}`);
  assert.equal(heard[0].title_en, 'The customer answered your question on “A phone stand”');
  // A second answer on the same question bumps the same row.
  assert.equal((await post(as(raw, BUYER), comments(id), { kind: 'customer_answer', body: 'Also: black.', parent_id: question })).status, 201);
  heard = notes(raw, 'owner', 'request_answer');
  assert.equal(heard.length, 1);
  assert.equal(JSON.parse(heard[0].meta).count, 2);

  // The server's kind is nobody's to send.
  const sys = await post(as(raw, BUYER), comments(id), { kind: 'system_update', body: 'x' });
  assert.equal(sys.status, 403);
  assert.equal((await json(sys)).code, 'COMMENT_KIND_NOT_ALLOWED');
});

// ============================================================== who may read

test('a stranger can neither read nor write in a direct (private) request\'s discussion; its store and its customer can', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,target_merchant_id,created_by,expires_at)
      VALUES ('rd','buyer','A direct job','For Ali only','open','open','direct','m1','customer','${FUTURE}')`);
  assert.equal((await get(as(raw, NOUR), comments('rd'))).status, 404);
  assert.equal((await get(as(raw, OMAR), comments('rd'))).status, 404);
  assert.equal((await get(as(raw, null), comments('rd'))).status, 404);
  assert.equal((await get(as(raw, BUYER), comments('rd'))).status, 200);
  assert.equal((await get(as(raw, ALI), comments('rd'))).status, 200);

  assert.equal((await post(as(raw, NOUR), comments('rd'), { kind: 'public_comment', body: 'Let me in' })).status, 404);
  // The store it was sent to may ask about it; a board-only «comment» is not a thing on a private job.
  assert.equal((await post(as(raw, ALI), comments('rd'), { kind: 'merchant_question', body: 'Which finish?' })).status, 201);
  const closed = await post(as(raw, ALI), comments('rd'), { kind: 'public_comment', body: 'Hello' });
  assert.equal(closed.status, 403);
  assert.equal((await json(closed)).details.reason, 'REQUEST_CLOSED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_request_comments WHERE request_id = 'rd'"), 1);
  assert.equal((await json(await get(as(raw, NOUR), comments('rd')))).success, false);
});

// =================================================== length, removal, hidden

test('a comment is bounded, its author may remove it (it leaves the thread), and a hidden row reaches staff alone', async () => {
  const raw = seed();
  const id = await published(raw);
  const long = await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body: 'x'.repeat(1001) });
  assert.equal(long.status, 400);
  assert.equal((await json(long)).code, 'COMMENT_TOO_LONG');
  assert.equal((await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body: 'x'.repeat(1000) })).status, 201);

  const mine = (await json(await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body: 'Oops, wrong request' }))).comment.id as string;
  const theirs = (await json(await post(as(raw, ALI), comments(id), { kind: 'public_comment', body: 'Rude words here' }))).comment.id as string;

  const notMine = await del(as(raw, NOUR), `${comments(id)}/${theirs}`);
  assert.equal(notMine.status, 404);
  assert.equal((await json(notMine)).code, 'COMMENT_NOT_FOUND');
  assert.equal((await del(as(raw, NOUR), `${comments(id)}/${mine}`)).status, 200);
  assert.equal((await del(as(raw, NOUR), `${comments(id)}/${mine}`)).status, 200, 'a second press is a replay');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_request_comments WHERE id = ?', mine)!.state, 'removed');
  let page = await json(await get(as(raw, NOUR), comments(id)));
  assert.ok(!(page.comments as Array<{ id: string }>).some((c) => c.id === mine), 'a removed row leaves the thread');
  assert.equal(page.total, 2);

  raw.exec(`UPDATE community_request_comments SET state = 'hidden', admin_hidden_reason = 'abuse' WHERE id = '${theirs}'`);
  page = await json(await get(as(raw, NOUR), comments(id)));
  assert.ok(!(page.comments as Array<{ id: string }>).some((c) => c.id === theirs), 'a hidden row is not served to members');
  const staff = await json(await get(as(raw, BOSS), comments(id)));
  const hidden = (staff.comments as Array<{ id: string; state: string; admin_hidden_reason?: string }>).find((c) => c.id === theirs);
  assert.equal(hidden?.state, 'hidden');
  assert.equal(hidden?.admin_hidden_reason, 'abuse');
});

// ============================================================== system rows

test('the server\'s own rows sit inline in the thread: a cancel is recorded, a revision too, and the board then takes no more comments', async () => {
  const raw = seed();
  const id = await published(raw);
  assert.equal((await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body: 'Following' })).status, 201);
  assert.equal(await writeRequestSystemUpdate(asD1(raw), id, 'revised', { change: 'files', revision: 1 }), true);
  assert.equal((await post(as(raw, BUYER), `/api/marketplace/requests/${id}/cancel`)).status, 200);

  const page = await json(await get(as(raw, BUYER), comments(id)));
  const kinds = (page.comments as Array<{ kind: string; system: { code: string; meta: Record<string, unknown> } | null; author: unknown }>).map((c) => [c.kind, c.system?.code ?? null]);
  assert.deepEqual(kinds, [
    ['public_comment', null],
    ['system_update', 'revised'],
    ['system_update', 'cancelled'],
  ]);
  const revised = (page.comments as Array<{ system: { meta: Record<string, unknown> } | null; author: unknown }>)[1];
  assert.deepEqual(revised.system!.meta, { change: 'files', revision: 1 });
  assert.equal(revised.author, null);
  assert.equal(page.total, 1, 'system rows are not counted as comments');

  // Off the board: the thread is still the customer's to read, not the public's to write in.
  const late = await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body: 'Too late' });
  assert.equal(late.status, 404, 'a cancelled request is no longer visible to a passer-by');
  assert.equal((await get(as(raw, BUYER), comments(id))).status, 200);
});

test('two rows of one millisecond keep the order they were written in — never their random ids — across a page boundary too', async () => {
  const raw = seed();
  const id = await published(raw);
  // Pinned instants and ids that sort OPPOSITE to insertion: the comment is written first
  // with the larger id, the system row second with the smaller — what a wall-clock tie does
  // about one read in five (review 2026-09-30).
  const at = '2026-09-30T10:00:00.000Z';
  raw.exec(`
    INSERT INTO community_request_comments (id, request_id, author_id, parent_id, kind, body, state, created_at, updated_at)
      VALUES ('rqc_zzzz', '${id}', 'stranger', NULL, 'public_comment', 'Following', 'visible', '${at}', '${at}');
    INSERT INTO community_request_comments (id, request_id, author_id, parent_id, kind, body, state, created_at, updated_at)
      VALUES ('rqc_aaaa', '${id}', NULL, NULL, 'system_update', '{"code":"revised","meta":{}}', 'visible', '${at}', '${at}');
    INSERT INTO community_request_comments (id, request_id, author_id, parent_id, kind, body, state, created_at, updated_at)
      VALUES ('rqc_mmmm', '${id}', 'stranger', NULL, 'public_comment', 'Still here', 'visible', '${at}', '${at}');
  `);
  const all3 = await json(await get(as(raw, BUYER), comments(id)));
  assert.deepEqual(all3.comments.map((c: { id: string }) => c.id), ['rqc_zzzz', 'rqc_aaaa', 'rqc_mmmm']);
  assert.equal(all3.total, 2);
  // Paged one at a time through the tie: the same order, nothing skipped or repeated; a cursor page carries no count.
  const seen: string[] = [];
  let cursor = '';
  for (let i = 0; i < 4; i++) {
    const page = await json(await get(as(raw, BUYER), `${comments(id)}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    seen.push(...page.comments.map((c: { id: string }) => c.id));
    if (cursor) assert.equal(page.total, null, 'the count is the first page\'s');
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  assert.deepEqual(seen, ['rqc_zzzz', 'rqc_aaaa', 'rqc_mmmm']);
});

test('a closed creator page is closed from the discussion too (D4): a guest and a member read the name, never the handle; a public page or a workshop keeps its handle', async () => {
  const raw = seed();
  const id = await published(raw);
  raw.exec(`UPDATE users SET username = 'nour_hidden_handle', creator_public = 0 WHERE id = 'stranger';
            UPDATE users SET username = 'ali_workshop', creator_public = 0 WHERE id = 'owner';
            UPDATE users SET username = 'omar_public', creator_public = 1 WHERE id = 'owner2';`);
  for (const [who, body] of [[NOUR, 'Which colour?'], [ALI, 'I can print this'], [OMAR, 'Nice']] as const) {
    assert.equal((await post(as(raw, who), comments(id), { kind: 'public_comment', body })).status, 201);
  }
  for (const reader of [null, BUYER]) {
    const page = await json(await get(as(raw, reader), comments(id)));
    const by = Object.fromEntries((page.comments as Array<{ author: { id: string; name: string; username: string | null } }>).map((c) => [c.author.id, c.author]));
    assert.deepEqual(by.stranger, { id: 'stranger', name: 'Nour', username: null, role: 'member' }, 'a closed page\'s handle reaches nobody');
    assert.equal(by.owner.username, 'ali_workshop', 'a workshop\'s page is its store');
    assert.equal(by.owner2.username, 'omar_public', 'a page its owner opened');
  }
  const res = await get(as(raw, null), comments(id));
  assert.ok(!(await res.text()).includes('nour_hidden_handle'));
});

// ================================================================ the cursor

test('the page reads one row more than asked, so the cursor exists exactly when a next page does', async () => {
  const raw = seed();
  const id = await published(raw);
  for (const body of ['one', 'two', 'three']) assert.equal((await post(as(raw, NOUR), comments(id), { kind: 'public_comment', body })).status, 201);
  const first = await json(await get(as(raw, NOUR), `${comments(id)}?limit=2`));
  assert.equal(first.comments.length, 2);
  assert.ok(first.next_cursor, 'a next page exists');
  const second = await json(await get(as(raw, NOUR), `${comments(id)}?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`));
  assert.equal(second.comments.length, 1);
  assert.equal(second.comments[0].body, 'three');
  assert.equal(second.next_cursor, null);
  const exact = await json(await get(as(raw, NOUR), `${comments(id)}?limit=3`));
  assert.equal(exact.comments.length, 3);
  assert.equal(exact.next_cursor, null, 'a full page with nothing behind it has no cursor');
});

// =================================================================== reports

test('a report of a comment rides community_reports under target_type comment, and the side table resolves the real row for the desk', async () => {
  const raw = seed();
  const id = await published(raw);
  const cid = (await json(await post(as(raw, ALI), comments(id), { kind: 'public_comment', body: 'Buy my other things at …' }))).comment.id as string;

  const missing = await post(as(raw, NOUR), `${comments(id)}/nope/report`, { reason: 'spam' });
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).code, 'REPORT_TARGET_NOT_FOUND');

  const filed = await post(as(raw, NOUR), `${comments(id)}/${cid}/report`, { reason: 'spam', details: 'advertising' });
  assert.equal(filed.status, 201, JSON.stringify(await json(filed.clone())));
  const reportId = (await json(filed)).report_id as string;
  assert.deepEqual(row(raw, 'SELECT target_type, target_id, reason, state FROM community_reports WHERE id = ?', reportId), {
    target_type: 'comment',
    target_id: cid,
    reason: 'spam',
    state: 'open',
  });
  assert.deepEqual(row(raw, 'SELECT kind, target_id FROM community_report_targets WHERE report_id = ?', reportId), { kind: 'request_comment', target_id: cid });

  // Once per reporter per row: the second press files nothing.
  const again = await json(await post(as(raw, NOUR), `${comments(id)}/${cid}/report`, { reason: 'abuse' }));
  assert.equal(again.replayed, true);
  assert.equal(again.report_id, reportId);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_reports'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_report_targets'), 1);

  // The desk reads the comment itself, not an id that opens nothing.
  const queue = await json(await get(as(raw, BOSS), '/api/admin/community/reports'));
  assert.equal(queue.reports.length, 1);
  assert.equal(queue.reports[0].id, reportId);
  assert.equal(queue.reports[0].target.kind, 'request_comment');
  assert.equal(queue.reports[0].target.id, cid);
  assert.equal(queue.reports[0].target.request_id, id);
  assert.equal(queue.reports[0].target.body, 'Buy my other things at …');
  assert.equal(queue.reports[0].reporter_name, 'Nour');
  // Deleting the report takes the side row with it (cascade).
  raw.exec(`DELETE FROM community_reports WHERE id = '${reportId}'`);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_report_targets'), 0);
});

test('a page of the discussion is two round trips after the gate for everyone, and the total is counted on the first page only (perf review 2026-09-30)', async () => {
  // It was four for a signed-in member or workshop (the gate, the request, «is this an engaged workshop», then the
  // list and a COUNT on every page); the engagement and the viewer's store now ride the request's own read.
  const raw = seed();
  const id = await published(raw);
  for (const [i, who] of [NOUR, ALI, BUYER].entries()) {
    assert.equal((await post(as(raw, who), comments(id), { kind: 'public_comment', body: `Comment number ${i}` })).status, 201);
  }
  const { waves, db } = wavesD1(raw);
  const figures: Record<string, number> = {};
  let firstPage: Record<string, unknown> = {};
  for (const [who, user] of [['guest', null], ['owner', BUYER], ['member', NOUR], ['workshop', ALI]] as const) {
    waves.reset();
    const res = await get(stubApp(db, user, mount), `${comments(id)}?limit=2`);
    assert.equal(res.status, 200, who);
    const body = await json(res);
    if (who === 'member') firstPage = body;
    figures[who] = waves.counts.waves;
  }
  console.log(`waves: ${JSON.stringify(figures)}`);
  for (const [who, n] of Object.entries(figures)) assert.ok(n <= 3, `${who}: ${n} waves`);
  assert.equal(typeof firstPage.total, 'number', 'the first page carries the total');
  waves.reset();
  const next = await json(await get(stubApp(db, NOUR, mount), `${comments(id)}?limit=2&cursor=${encodeURIComponent(String(firstPage.next_cursor))}`));
  assert.equal(next.total, null, 'a later page does not count the thread again');
  assert.equal(waves.counts.sqls.some((q) => /COUNT\(\*\)/i.test(q)), false, 'a later page counts the thread again');
});
