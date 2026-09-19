/**
 * TRACK D — the assistant grant, the Telegram identity and the member modal.
 *
 * THE ONE DEFECT THAT WOULD MAKE THIS FEATURE A LIABILITY:
 *
 *   «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن
 *    العادي لا يراها في API ولا في HTML ولا في export»
 *
 * The member profile puts a LIFETIME VALUE, a WALLET BALANCE and a BNPL debt
 * on one screen. Every one of those is money, so every one of them is behind
 * the financial scope — and "behind" has to mean ABSENT FROM THE RESPONSE, not
 * hidden by the client. So the first group of tests runs the REAL route
 * against a REAL database built from the REAL migrations and asserts on the
 * RAW RESPONSE TEXT: a restricted admin's JSON must not contain the number at
 * all, in any field, under any name. A test that only checked
 * `body.financial === undefined` would pass on a payload that leaked the same
 * figure as `total_spent`.
 *
 * The second group VERIFIES — rather than re-implements — that the guards
 * already in worker/lib/adminScope.ts hold on the new grant path. They are not
 * copied into the route and they are not copied into these assertions: each
 * test drives `PATCH /api/admin/users/:id`, which is the only path the new
 * screen uses, and asserts the refusal and that NOTHING WAS WRITTEN.
 *
 * The third group pins the parts of the UI that no route test can see, the way
 * tests/uiSystem.test.ts and tests/adminSurfaceDesign.test.ts do: this
 * repository has no browser DOM runner, so the modal's focus contract, its
 * three-language rule and the refusal to accept a @username are asserted over
 * the source.
 *
 * Run: node --import tsx --test tests/adminUserModal.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1, stubApp, get, patch, json, row, all } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';

// =========================================================================
// the fixture: one member with real orders, a real wallet and a real debt
// =========================================================================

const LIFETIME = 4_250_000; // 1,000,000 + 3,250,000 — the two orders that count
const CANCELLED = 9_999_777; // deliberately distinctive: it must never appear
const DELIVERED = 3_250_000;
const WALLET_CENTS = 123_456;
const CREDIT_LIMIT = 800_000;

function build(actor: 'asst' | 'full' | 'boss') {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,admin_scope,membership_tier) VALUES
      ('asst','Assistant','asst@x.co','asst','h','admin','assistant','free'),
      ('full','Finance','full@x.co','full','h','admin','full','free'),
      ('boss','Owner','boss@x.co','boss','h','admin',NULL,'free'),
      ('mem','Member','mem@x.co','mem','h','customer',NULL,'pro');

    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,
                        delivery_method_snapshot,payment_method_id,subtotal_iqd,
                        exchange_rate,total_iqd,due_on_delivery_iqd) VALUES
      ('o1','mem','confirmed','{}','d','{}','cod',1000000,1500,1000000,0),
      ('o2','mem','delivered','{"id":"addr1","name":"Member","address":"Baghdad"}','d','{}','bnpl',${DELIVERED},1500,${DELIVERED},0),
      ('o3','mem','cancelled','{}','d','{}','cod',${CANCELLED},1500,${CANCELLED},0);

    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('w1','mem','deposit','USD',${WALLET_CENTS},'approved'),
      ('w2','mem','deposit','USD',50000,'pending');

    -- THE BNPL DEBT IS SEEDED THE ONLY WAY THE DATABASE ALLOWS ONE TO EXIST.
    -- Migration 0066's BEFORE INSERT trigger refuses a charge that is not a
    -- real, eligible purchase: it must belong to a BNPL order of this member,
    -- by an ACTIVE PRO member, with a VERIFIED identity and an APPROVED address
    -- matching the order's own snapshot, inside an approved credit limit. So
    -- the fixture satisfies all of it rather than working around it — which
    -- also means the 300,000 IQD this test hides from an assistant is a debt
    -- the live rules would actually have produced.
    INSERT INTO membership_plans (id,tier,duration_months,price_iqd) VALUES ('p-pro','pro',12,100000);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,expires_at)
      VALUES ('m1','mem','p-pro','pro','active',12,'2099-01-01T00:00:00.000Z');
    INSERT INTO kyc_cases (id,user_id,state) VALUES ('k1','mem','verified');
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,state,source_address_id)
      VALUES ('a1','mem',1,'Member','+9647700000000','Baghdad','approved','addr1');
    INSERT INTO bnpl_accounts (user_id,state,credit_limit_iqd) VALUES ('mem','approved',${CREDIT_LIMIT});
    INSERT INTO bnpl_ledger (id,user_id,order_id,kind,amount_iqd) VALUES
      ('b1','mem','o2','charge',500000),
      ('b2','mem','o2','repayment',200000);

    INSERT INTO sessions (id,user_id,expires_at) VALUES
      ('s1','mem','2099-01-01T00:00:00.000Z'),
      ('s2','mem','2000-01-01T00:00:00.000Z');

    INSERT INTO restriction_cases (id,user_id,kind,state,reason) VALUES
      ('r1','mem','debt','active','unpaid balance');
  `);
  const scope = actor === 'asst' ? 'assistant' : actor === 'full' ? 'full' : null;
  const app = stubApp(
    asD1(raw),
    { id: actor, role: 'admin', email: `${actor}@x.co`, admin_scope: scope },
    (a) => a.route('/api/admin', adminRoutes),
    { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } }
  );
  return { app, raw };
}

// =========================================================================
// §11 — the money never reaches a restricted admin
// =========================================================================

test('an assistant opening a member gets NO financial key, and no money anywhere in the raw JSON', async () => {
  const { app } = build('asst');
  const res = await get(app, '/api/admin/users/mem/detail');
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;

  assert.equal(body.can_view_financials, false);
  assert.equal('financial' in body, false, 'the key itself must be absent, not null and not empty');

  // THE ASSERTION THAT ACTUALLY PROVES IT. Reading the raw response is what an
  // assistant can do in their own devtools, so the raw response is what is
  // checked — a leak renamed to `total_spent` would still be caught here.
  for (const [what, n] of [
    ['lifetime value', LIFETIME],
    ['delivered value', DELIVERED],
    ['wallet balance', WALLET_CENTS],
    ['BNPL credit limit', CREDIT_LIMIT],
    ['BNPL outstanding', 300000],
  ] as const) {
    assert.equal(text.includes(String(n)), false, `${what} (${n}) leaked into an assistant's response`);
  }

  // And the operational half is still there — an assistant exists to do this
  // work, and stripping their whole screen would be the opposite failure.
  const member = body.member as Record<string, Record<string, unknown>>;
  assert.equal(member.activity.orders_total, 3, 'counting orders is operations, not profit');
  assert.equal(member.active_restrictions, 1);
  assert.equal(member.bnpl_state, 'approved', 'the STATE is operational; only the limit is money');
});

test('a financial admin gets every figure, and a cancelled order is not lifetime value', async () => {
  const { app } = build('full');
  const body = await json(await get(app, '/api/admin/users/mem/detail'));
  assert.equal(body.can_view_financials, true);

  // The cancelled order is the point: including it would inflate every
  // member's worth by everything they ever changed their mind about.
  assert.equal(body.financial.lifetime_value_iqd, LIFETIME);
  assert.equal(body.financial.delivered_value_iqd, DELIVERED);

  // A PENDING deposit is not a balance. `getBalances` counts approved rows
  // only, and the 50,000-cent pending row exists in the fixture to prove it.
  assert.equal(body.financial.wallet_usd_cents, WALLET_CENTS);
  assert.equal(body.financial.bnpl_credit_limit_iqd, CREDIT_LIMIT);
  assert.equal(body.financial.bnpl_outstanding_iqd, 300_000, 'charge minus repayment');
});

test('the owner is financial even though their stored scope is NULL', async () => {
  const { app } = build('boss');
  const body = await json(await get(app, '/api/admin/users/mem/detail'));
  assert.equal(body.can_view_financials, true);
  assert.equal(body.financial.lifetime_value_iqd, LIFETIME);
});

test('the detail reports live sessions and a last sign-in, and says nothing it cannot know', async () => {
  const { app } = build('full');
  const body = await json(await get(app, '/api/admin/users/mem/detail'));
  // One of the two seeded sessions has already expired.
  assert.equal(body.member.activity.live_sessions, 1);
  assert.ok(body.member.activity.newest_session_at, 'the newest surviving session is the floor we can report');
  assert.equal(body.member.activity.orders_delivered, 1);
  assert.equal(body.member.activity.orders_cancelled, 1);
  assert.equal(body.member.activity.orders_open, 1);
});

test('a member who has done nothing yields zeros rather than nulls or a crash', async () => {
  const { app, raw } = build('full');
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('new','New','new@x.co','h','customer');");
  const body = await json(await get(app, '/api/admin/users/new/detail'));
  assert.equal(body.member.activity.orders_total, 0);
  assert.equal(body.financial.lifetime_value_iqd, 0);
  assert.equal(body.financial.wallet_usd_cents, 0);
  assert.equal(body.member.kyc, null);
  assert.deepEqual(body.member.restrictions, []);
  assert.equal(body.member.approved_address, null);
});

test('an unknown member is a 404, not an empty profile', async () => {
  const { app } = build('full');
  assert.equal((await get(app, '/api/admin/users/nobody/detail')).status, 404);
});

// =========================================================================
// the lookup: exactly one account, or none
// =========================================================================

test('the lookup matches the stored address exactly — a prefix is not a match', async () => {
  const { app } = build('full');
  const ok = await json(await get(app, '/api/admin/users/lookup?email=mem@x.co'));
  assert.equal(ok.user.id, 'mem');

  // THE FAILURE THIS FORBIDS. `GET /users?search=` is a LIKE whose pattern D1
  // truncates at 50 BYTES, so a long address silently matches a prefix. A
  // grant is an act against ONE account; a near-miss puts an outsider in the
  // panel. `mem@x.c` is a prefix of a real address and must find nothing.
  assert.equal((await get(app, '/api/admin/users/lookup?email=mem@x.c')).status, 400, 'not even a valid address');
  assert.equal((await get(app, '/api/admin/users/lookup?email=mem2@x.co')).status, 404);
});

test('the lookup is case-insensitive on input and names the owner and the actor', async () => {
  const { app } = build('full');
  // users.email is stored lowercased; email() lowercases what was typed, so
  // the two meet without a function on the column (which would also have
  // defeated the UNIQUE index).
  const m = await json(await get(app, '/api/admin/users/lookup?email=MEM@X.CO'));
  assert.equal(m.user.id, 'mem');
  assert.equal(m.user.is_owner, false);
  assert.equal(m.user.is_self, false);

  const boss = await json(await get(app, '/api/admin/users/lookup?email=boss@x.co'));
  assert.equal(boss.user.is_owner, true, 'the screen must be able to explain why the owner cannot be restricted');

  const self = await json(await get(app, '/api/admin/users/lookup?email=full@x.co'));
  assert.equal(self.user.is_self, true);
});

test('the lookup answers with identity only — it is not a second member profile', async () => {
  const { app } = build('full');
  const text = await (await get(app, '/api/admin/users/lookup?email=mem@x.co')).text();
  for (const n of [LIFETIME, DELIVERED, WALLET_CENTS, CREDIT_LIMIT]) {
    assert.equal(text.includes(String(n)), false, `the lookup leaked ${n}`);
  }
  const body = JSON.parse(text) as { user: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(body.user).sort(),
    ['admin_scope', 'created_at', 'email', 'id', 'is_owner', 'is_self', 'membership_tier', 'name', 'role', 'username']
  );
});

test('an unrecognised stored scope is reported as restricted, exactly as the server treats it', async () => {
  const { app, raw } = build('full');
  // adminScope.ts: present-but-unrecognised resolves to the LEAST privilege.
  // The screen that is about to CHANGE this value must see the same reading,
  // or it would offer to "restrict" an account the server already restricts.
  raw.exec("UPDATE users SET role='admin', admin_scope='assisstant' WHERE id='mem';");
  const body = await json(await get(app, '/api/admin/users/lookup?email=mem@x.co'));
  assert.equal(body.user.admin_scope, 'assistant');
});

// =========================================================================
// the grant path — VERIFYING the guards in adminScope.ts, not re-stating them
// =========================================================================

/** The stored account, as the guards see it after the request. */
const stored = (raw: ReturnType<typeof freshDb>, id: string) =>
  row<{ role: string; admin_scope: string | null }>(raw, 'SELECT role, admin_scope FROM users WHERE id = ?', id)!;

test('the grant is ONE request that writes both columns — no window as a full admin', async () => {
  const { app, raw } = build('full');
  const res = await patch(app, '/api/admin/users/mem', { role: 'admin', admin_scope: 'assistant' });
  assert.equal(res.status, 200);

  // THE WINDOW THIS CLOSES. A fresh admin has admin_scope NULL, and NULL is
  // UNRESTRICTED. Promoting and restricting as two requests would therefore
  // mint a FULL FINANCIAL ADMIN for as long as the second request takes — or
  // forever, if it never arrives. One UPDATE, both columns.
  assert.deepEqual(stored(raw, 'mem'), { role: 'admin', admin_scope: 'assistant' });
});

test('an assistant cannot grant, cannot promote and cannot demote — and writes nothing', async () => {
  for (const body of [
    { role: 'admin', admin_scope: 'assistant' },
    { admin_scope: null },
    { role: 'customer' },
  ]) {
    const { app, raw } = build('asst');
    const before = stored(raw, 'full');
    const res = await patch(app, '/api/admin/users/full', body);
    assert.equal(res.status, 403, `an assistant was allowed to send ${JSON.stringify(body)}`);
    assert.deepEqual(stored(raw, 'full'), before, 'the refusal must also be a no-op');
  }
});

test('the owner can never be restricted or demoted, whoever asks', async () => {
  for (const actor of ['full', 'boss'] as const) {
    const { app, raw } = build(actor);
    const before = stored(raw, 'boss');
    assert.equal((await patch(app, '/api/admin/users/boss', { admin_scope: 'assistant' })).status, 403);
    assert.equal((await patch(app, '/api/admin/users/boss', { role: 'customer' })).status, 403);
    assert.deepEqual(stored(raw, 'boss'), before);
  }
});

test('nobody removes their own administrator role', async () => {
  const { app, raw } = build('full');
  assert.equal((await patch(app, '/api/admin/users/full', { role: 'customer' })).status, 403);
  assert.deepEqual(stored(raw, 'full'), { role: 'admin', admin_scope: 'full' });
});

test('echoing a row back unchanged is not an attempt to change it', async () => {
  // The panel sends the whole row on every save. A value equal to the stored
  // one must not read as a request to change it, or an assistant editing a
  // membership tier would be refused for "promoting" an admin they never
  // touched.
  const { app, raw } = build('asst');
  const res = await patch(app, '/api/admin/users/full', { role: 'admin', membership_tier: 'plus' });
  assert.equal(res.status, 200, 'unchanged role + a tier change is an operations edit');
  assert.equal(stored(raw, 'full').role, 'admin');
  assert.equal(row<{ membership_tier: string }>(raw, 'SELECT membership_tier FROM users WHERE id=?', 'full')!.membership_tier, 'plus');
});

test('a REVOKE is audited with its value — null is a decision, not an absence', async () => {
  const { app, raw } = build('boss');
  await patch(app, '/api/admin/users/mem', { role: 'admin', admin_scope: 'assistant' });
  await patch(app, '/api/admin/users/mem', { admin_scope: null });
  assert.deepEqual(stored(raw, 'mem'), { role: 'admin', admin_scope: null });

  const rows = all<{ detail: string }>(
    raw,
    "SELECT detail FROM audit_log WHERE action='admin.user_update' AND target='mem' ORDER BY id"
  );
  assert.equal(rows.length, 2);
  const revoke = JSON.parse(rows[1].detail) as Record<string, unknown>;
  assert.ok((revoke.fields as string[]).includes('admin_scope'));
  // THE HOLE THIS PINS. `scope ?? undefined` turned the revoke — which is the
  // act of HANDING an account full financial access — into a record that said
  // the column changed and refused to say to what. Grant and revoke were
  // indistinguishable in the one trail an investigator reads.
  assert.equal('admin_scope' in revoke, true, 'the revoked value must be recorded');
  assert.equal(revoke.admin_scope, null);
  assert.equal(JSON.parse(rows[0].detail).admin_scope, 'assistant');
});

// =========================================================================
// the UI contract — no DOM runner here, so it is asserted over the source
// =========================================================================

const ROOT = new URL('../', import.meta.url).pathname;
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * THE SOURCE WITH ITS PROSE REMOVED.
 *
 * Every `doesNotMatch` below is a rule about what the CODE does, and this
 * repository's house style is long comments that name the failure the code
 * prevents — so the comment explaining "we must never decide language from
 * `dir === 'rtl'`" contains the very string the assertion forbids, and a
 * correct file fails a correct test. That is not a hypothetical: five of the
 * assertions in this group failed on their own explanations first.
 *
 * `//` is only treated as a line comment when it follows whitespace or starts
 * the line, so `https://levonis-iq.com` survives; that is the one ambiguity
 * worth spelling out rather than pretending a regex is a parser.
 */
const code = (p: string) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const MODAL = 'src/components/adminUsers/MemberDetailModal.tsx';
const FOCUS = 'src/components/adminUsers/useModalFocus.ts';
const GRANT = 'src/components/adminUsers/AssistantAccess.tsx';
const TG = 'src/components/adminUsers/TelegramIdentities.tsx';
const USERS = 'src/components/AdminUsers.tsx';

test('the member detail is a window anchored to its row, not a block at the foot of the page', () => {
  const modal = src(MODAL);
  const users = src(USERS);
  // The app's own primitive, reused — not a hand-rolled `fixed inset-0`.
  assert.match(modal, /import \{ Overlay \} from '\.\.\/ui\/Overlay'/);
  assert.match(modal, /mode="modal"/);
  assert.match(modal, /anchor=\{anchorRef\}/);
  assert.doesNotMatch(code(MODAL), /fixed inset-0/, 'the overlay owns the layer; a second one would fight it');
  // The row's identity IS the control, and it is a real button so the keyboard
  // and a screen reader can reach it.
  assert.match(users, /detailAnchorRef\.current = e\.currentTarget;\s*\n\s*setDetailUserId\(u\.id\);/);
  assert.match(users, /<MemberDetailModal/);
  // Two windows open out of one row; each keeps the control it was opened from.
  assert.match(users, /const detailAnchorRef = useRef<HTMLElement \| null>\(null\);/);
  assert.match(users, /const editAnchorRef = useRef<HTMLElement \| null>\(null\);/);
});

test('the window traps Tab and gives focus back to the row that opened it', () => {
  const focus = src(FOCUS);
  const modal = src(MODAL);
  assert.match(focus, /e\.key !== 'Tab'/);
  assert.match(focus, /e\.preventDefault\(\);\s*\n\s*last\.focus/);
  assert.match(focus, /e\.preventDefault\(\);\s*\n\s*first\.focus/);
  assert.match(focus, /document\.contains\(returnTo\)/, 'a detached opener would swallow the focus call');
  assert.match(focus, /addEventListener\('keydown', onKeyDown, true\)/, 'capture, or a control could eat Tab');
  // The panel is tabbable only as an initial-focus target, never as a stop.
  assert.match(focus, /\[tabindex\]:not\(\[tabindex="-1"\]\)/);
  assert.match(modal, /panelMotion=\{\{ ref: setPanel \}\}/);
  // Escape and the page-scroll lock belong to Overlay; re-doing either here
  // would break its reference-counted lock for stacked dialogs.
  assert.doesNotMatch(code(FOCUS), /document\.body\.style\.overflow/);
  assert.doesNotMatch(code(FOCUS), /'Escape'/);
});

test('the modal renders money only when the SERVER sent it', () => {
  const modal = src(MODAL);
  // Presence of the key is the whole test: no role check, no can_view_financials
  // read, nothing that could render a number the response did not carry.
  assert.match(modal, /view\.financial \? \(/);
  assert.doesNotMatch(code(MODAL), /can_view_financials/, 'the session hint must not decide what this window draws');
  assert.doesNotMatch(code(MODAL), /admin_scope === 'assistant' \?[\s\S]{0,120}lifetime/i);
});

test('the Telegram identity is a numeric id, never a @username, and is never hard-coded', () => {
  const tg = src(TG);
  assert.match(tg, /\^\[0-9\]\{5,20\}\$/, 'digits only, and long enough to be an account id');
  assert.match(tg, /inputMode="numeric"/);
  assert.match(tg, /role="alert"/);
  assert.match(tg, /tgIdNotUsername/);
  assert.match(tg, /telegramUserId: Number\(tgIdTrimmed\)/);

  // A build that shipped a Telegram id would be shipping an approval
  // credential. The owner's id is DATA THEY ENTER — it is not a default, not a
  // placeholder and not a fallback, anywhere in the tree.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      // `code()` and not the raw file: worker/lib/types.ts uses the owner's id
      // as an EXAMPLE in the doc comment for TELEGRAM_ADMIN_USER_IDS, which is
      // documentation of a configuration value and not a shipped credential.
      else if (/\.(ts|tsx)$/.test(e.name) && code(rel).includes('6404042791')) {
        offenders.push(rel);
      }
    }
  };
  for (const d of ['src', 'worker']) walk(d);
  assert.deepEqual(offenders, [], 'a Telegram admin id is data, never source');
});

test('the grant screen says in Arabic what an assistant can and cannot do, and sends one PATCH', () => {
  const grant = src(GRANT);
  assert.match(grant, /canList/);
  assert.match(grant, /cannotList/);
  // One request, both columns — the window in the header of AssistantAccess.
  assert.match(grant, /\{ role: 'admin', admin_scope: 'assistant' \}/);
  assert.match(grant, /api\.patch\(`\/api\/admin\/users\/\$\{encodeURIComponent\(found\.id\)\}`, body\)/);
  // The lookup must happen before anything can be pressed.
  assert.match(grant, /users\/lookup\?email=/);
  assert.doesNotMatch(code(GRANT), /window\.confirm/, 'a confirmation the admin cannot read in their own language is not one');

  const strings = src('src/components/adminUsers/strings.ts');
  for (const word of ['التكلفة', 'الربح', 'مساعد']) {
    assert.ok(strings.includes(word), `the screen must say «${word}» plainly`);
  }
});

test('every new string asks the LANGUAGE, never the direction — Kurdish is also RTL', () => {
  // `dir === 'rtl' ? ar : en` serves ARABIC to every Kurdish admin and calls it
  // a translation. The bug is invisible to an Arabic reader, which is exactly
  // why it survived in AdminUsers.tsx until this change.
  const files = readdirSync(join(ROOT, 'src/components/adminUsers')).map((f) => `src/components/adminUsers/${f}`);
  for (const f of [...files, USERS]) {
    const text = code(f);
    assert.doesNotMatch(text, /dir === 'rtl'\s*\?/, `${f} decides language from direction`);
    assert.doesNotMatch(text, /dir !== 'rtl'\s*\?/, `${f} decides language from direction`);
  }
  // And the three-language helper is what replaced it.
  assert.match(src('src/components/adminUsers/strings.ts'), /loc\('[^']+', '[^']+', '[^']+'\)/);
});

test('the table shows WHO CAN SEE THE MONEY, which is the point of the scope', () => {
  const users = src(USERS);
  assert.match(users, /admin_scope\?: AdminScope;/);
  assert.match(users, /u\.admin_scope === 'assistant' \? s\.assistantBadge : s\.fullBadge/);
});

test('no financial figure is computed before the gate in the detail handler', () => {
  const route = src('worker/routes/admin.ts');
  const start = route.indexOf("adminRoutes.get('/users/:id/detail'");
  assert.ok(start > 0, 'the detail handler must exist');
  const handler = route.slice(start, route.indexOf("adminRoutes.patch('/users/:id'", start));
  const gate = handler.indexOf('if (!financial) {');
  assert.ok(gate > 0, 'the early return for a restricted admin must exist');

  // THE STRUCTURAL GUARANTEE. Everything that reads money lives AFTER the
  // return, so for a restricted admin those statements are never executed —
  // there is no object to forget to strip and nothing in the raw JSON to find.
  for (const marker of ['getBalances', 'bnplOutstanding', 'lifetime_iqd', 'lifetime_value_iqd']) {
    const at = handler.indexOf(marker);
    assert.ok(at > gate, `${marker} is read before the financial gate`);
  }
});

test('a restricted admin is not OFFERED the Telegram binding — and the screen says the server is the gate', () => {
  const tg = code(TG);
  // Binding an identity hands out payment-proof approval authority, which is
  // money. A restricted assistant must not be handing it out.
  assert.match(tg, /const mayBind = user\?\.can_view_financials !== false;/);
  assert.match(tg, /\{!mayBind \? \(/);
  assert.match(tg, /\{mayBind && !r\.revoked_at &&/, 'revoking is the same authority as granting');

  // AND THE COMMENT IS PART OF THE FIX. `code()` strips prose, so this reads
  // the raw file on purpose: a client-side gate that does not admit it is not
  // an authorization boundary is worse than no gate, because the next reader
  // assumes the server is covered. It is not — see `unresolved`.
  const prose = src(TG);
  assert.match(prose, /requireAdmin` ALONE/);
  assert.match(prose, /resolveAdminActor/);
});

test('the member window keeps its own scroll, its own safe area and a route back to the editor', () => {
  const modal = src(MODAL);
  // The BODY scrolls, not the panel, so the member's name never leaves the
  // screen while their history is being read — the whole complaint again, at
  // a smaller scale.
  assert.match(modal, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  assert.match(modal, /max-h-\[min\(88dvh,46rem\)\]/, 'dvh, so a phone address bar cannot clip the footer');
  assert.match(modal, /env\(safe-area-inset-bottom\)/);
  // Reading a member and changing them are one flow, not two searches.
  assert.match(modal, /onEdit\(m\.identity\.id\)/);
  assert.match(src(USERS), /editAnchorRef\.current = detailAnchorRef\.current;/);
});
