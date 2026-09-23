/**
 * TWO ADMIN REPORTS FROM THE SAME iPad SESSION.
 *
 *   «في التحقق والعناوين في لوحة الإدارة عند الضغط عليها يصبح الموقع بالكامل
 *    أسود شاشة سوداء.»
 *   «في لوحة الإدارة عند طلب تعبئة محفظة اجعله يكون العملة هي العملة العراقية
 *    بالافتراضي وليس الدولار.»
 *
 * The crash is proved by MOUNTING the panel — scripts/e2e-admin-panels.mjs,
 * because `strictNullChecks` is off and a null dereference in this codebase is
 * invisible to `npm run check`. This file holds the two source rules that a
 * mount cannot state: that the guard is the LATCH the house uses rather than a
 * scattering of `?.`, and that no admin screen prints the ledger's raw cents
 * as the headline figure.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const kyc = read('src/components/AdminKyc.tsx');

test('the KYC case window is not built while it is closed', () => {
  // THE BUG. The children of `<Overlay open={!!detail}>` are an ordinary eager
  // JSX argument — built while the props object is constructed, before the
  // Overlay is called and long before it decides whether it is open. So
  // `{detail.user_email}` ran on the first render with `detail` null and threw,
  // and ChunkBoundary painted the black screen. Mounting the tab was enough;
  // no data and no click were needed.
  const open = kyc.indexOf('<Overlay\n        open={!!detail}');
  assert.ok(open > 0, 'the case window still exists');
  const guard = kyc.lastIndexOf('{shownCase && (', open);
  assert.ok(guard > 0 && open - guard < 200, 'the window is not guarded — it will build while closed');

  // Below the guard, the body reads the LATCHED value, never the state.
  const close = kyc.indexOf('</Overlay>', open);
  assert.ok(close > open);
  const body = kyc.slice(kyc.indexOf('      >\n', open), close);
  const raw = body.match(/(?<![\w?.])detail\./g) ?? [];
  assert.deepEqual(raw, [], 'the window body reads `detail` directly again — that is the crash');
  assert.ok(body.includes('shownCase.'), 'the body should read the latched case');

  // The three props that DRIVE open/closed must keep reading the state itself.
  const head = kyc.slice(open, kyc.indexOf('      >\n', open));
  assert.match(head, /open=\{!!detail\}/);
  assert.match(head, /onClose=\{\(\) => setDetail\(null\)\}/);
  assert.match(head, /label=\{detail\?\.user_email/);
});

test('the latch is the house pattern, not a scattering of optional chains', () => {
  // `detail` going null IS the close, but the panel is still on screen for the
  // length of its exit spring; reading the state would blank a decrypted
  // identity document out from under the animation. AdminUsers documents this.
  assert.match(kyc, /const lastDetailRef = useRef<CaseDetail \| null>\(null\);/);
  assert.match(kyc, /if \(detail\) lastDetailRef\.current = detail;/);
  assert.match(kyc, /const shownCase = detail \?\? lastDetailRef\.current;/);
  const users = read('src/components/AdminUsers.tsx');
  assert.match(users, /const lastEditedRef = useRef<AdminUserRow \| null>\(null\);/, 'the precedent moved');

  // «توثيق (قرار نهائي)» and «رفض» are still on screen during the exit spring,
  // and a stray click on an audited identity decision is not cosmetic.
  assert.match(kyc, /\$\{detail \? '' : ' pointer-events-none'\}/);
});

test('every Overlay whose body reads a nullable state is guarded', () => {
  // The defect arrived with the migration from a hand-rolled `{detail && (…)}`
  // to the Overlay primitive: `open={!!x}` replaced the guard, and the body was
  // left reading `x.` unguarded. Any caller that repeats that shape is the same
  // crash waiting for a tab to be opened.
  for (const file of [
    'src/components/AdminKyc.tsx',
    'src/components/AdminUsers.tsx',
    'src/components/AdminSerials.tsx',
    'src/components/adminUsers/MemberDetailModal.tsx',
  ]) {
    const src = read(file);
    const re = /<Overlay\b[\s\S]{0,400}?open=\{!!(\w+)\}/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const state = m[1];
      const bodyStart = src.indexOf('      >\n', m.index);
      const bodyEnd = src.indexOf('</Overlay>', m.index);
      assert.ok(bodyStart > 0 && bodyEnd > bodyStart, `${file}: could not read the ${state} window body`);
      const body = src.slice(bodyStart, bodyEnd);

      // THE REAL RULE is not where the guard sits — it is that no read of the
      // nullable state is reachable while it is null. Two shapes satisfy it,
      // and the codebase uses both: a guard OUTSIDE the Overlay (AdminKyc,
      // AdminUsers) so the body is never built, or an inner `{state && (…)}`
      // (AdminSerials) so every read sits behind it. What must never happen is
      // a read that comes BEFORE any guard — that is the crash.
      const firstRead = body.search(new RegExp(`(?<![\\w?.])${state}\\.`));
      if (firstRead < 0) continue; // the body never reads it at all
      const outerGuard = new RegExp(`\\{\\s*\\w+\\s*&&\\s*\\(`).test(
        src.slice(Math.max(0, m.index - 220), m.index)
      );
      const innerGuard = body.indexOf(`{${state} && (`);
      assert.ok(
        outerGuard || (innerGuard >= 0 && innerGuard < firstRead),
        `${file}: the ${state} window reads ${state}. before any guard — it will throw the moment the panel mounts`
      );
    }
  }
});

test('no admin screen shows a wallet amount as the ledger’s raw dollars', () => {
  // The ledger really IS USD cents — migrations/0001_init.sql says so, and
  // 0015_wallet_holds.sql states in writing that the stored unit stays USD
  // cents because changing it would be a destructive rewrite of live balances.
  // So «$35.72» was a true stored number, shown in the wrong unit for the
  // person reading it. Dinars are the headline now; the dollars stay as a
  // named secondary so a reconciliation against the ledger is still possible.
  const ledger = read('migrations/0001_init.sql');
  assert.match(ledger, /US cents/, 'the ledger stopped declaring its unit');

  for (const [file, field] of [
    ['src/components/AdminOverview.tsx', 'stats.incoming_usd_cents'],
    ['src/components/AdminOverview.tsx', 'stats.outgoing_usd_cents'],
    ['src/components/AdminOverview.tsx', 'req.amount'],
    ['src/components/AdminWalletRequests.tsx', 't.amount'],
    ['src/components/adminUsers/MemberDetailModal.tsx', 'view.financial.wallet_usd_cents'],
  ] as const) {
    const src = read(file);
    assert.ok(
      src.includes(`formatWalletIqd(${field}`),
      `${file}: ${field} is not shown in dinars`
    );
  }

  // The conversion goes through ONE helper so the four screens cannot drift.
  const api = read('src/lib/api.ts');
  assert.match(
    api,
    /export function formatWalletIqd\(cents: number, exchangeRate: number\): string \{\n\s*return formatIqd\(usdCentsToIqd\(cents, exchangeRate\)\);/
  );
  // …at the admin's own rate, not a constant typed into a component.
  for (const file of [
    'src/components/AdminOverview.tsx',
    'src/components/AdminWalletRequests.tsx',
    'src/components/adminUsers/MemberDetailModal.tsx',
  ]) {
    const src = read(file);
    assert.match(src, /const \{ exchangeRate \} = useWallet\(\);/, `${file} invents its own rate`);
    // Comments stripped — a component may NAME the default in prose; what it
    // must not do is compute with a number of its own.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\b1400\b/.test(code), `${file} hard-codes the exchange rate`);
  }
});

test('the dollar figure is kept, named and quiet — not deleted', () => {
  // Deleting it would make the dinars look like the stored number and leave a
  // reviewer unable to reconcile a deposit against the ledger. The Telegram
  // review card already carries both plus the rate, for the same reason.
  const requests = read('src/components/AdminWalletRequests.tsx');
  assert.ok(requests.includes('formatUsdCents(t.amount)'), 'the ledger value was dropped');
  assert.match(requests, /exchangeRate\.toLocaleString\(\)\} IQD\/USD/, 'the rate is not stated');
  const notify = read('worker/lib/walletNotify.ts');
  assert.match(notify, /الدفتر: \$\{formatUsdCents/, 'the precedent this copies has moved');
});

/**
 * THE THIRD RULE THIS FILE NOW CARRIES: a setting the SERVER reads has to have
 * a screen SOMEBODY can reach.
 *
 * `giniPolicy` was a stored setting the worker read on every checkout, with a
 * generic PUT that accepted it and not one client that ever called it. Its own
 * doc comment in worker/lib/settings.ts is the reason the text lives in a
 * setting at all — «the day Rafidain widens it past its own staff, the owner
 * edits a form instead of waiting for a deploy» — and there was no form. The
 * owner could not switch Gini off, could not move the 24-hour hold, and could
 * not correct the bank's own wording without a release.
 */
test('the owner can govern Gini from the admin, not only from a deploy', () => {
  const store = read('src/components/AdminStoreSettings.tsx');

  // It is written from the screen that already loads the admin settings, so no
  // second GET and no second source of truth appears beside shippingPolicy.
  assert.ok(
    store.includes("api.put('/api/admin/settings/giniPolicy'"),
    'nothing in the admin writes giniPolicy — the switch is still a deploy'
  );
  assert.ok(
    store.includes('res.settings?.giniPolicy'),
    'the panel does not hydrate from the settings GET it already makes'
  );
  assert.match(store, /data-admin="gini-policy"/, 'the panel is not rendered');

  // All four governable fields, not just the switch: the hold is what the
  // sweep cancels on and the conditions are what the customer reads.
  for (const field of ['enabled', 'hold_hours', 'app_url', 'conditions']) {
    assert.ok(store.includes(field), `giniPolicy.${field} has no control`);
  }

  // THE HOLD IS CLAMPED BEFORE IT IS SAVED. PUT /settings/:key stores the
  // object verbatim, and a 0 typed into the box would freeze an already-expired
  // `gini_hold_until` onto every new order for the sweep to cancel on sight.
  assert.match(store, /const GINI_HOLD_MIN_HOURS = 1;/);
  assert.match(store, /const GINI_HOLD_MAX_HOURS = 168;/);
  assert.match(
    store,
    /Math\.min\(GINI_HOLD_MAX_HOURS, Math\.max\(GINI_HOLD_MIN_HOURS, hours\)\)/,
    'a hold typed outside the usable range reaches the server'
  );

  // THE CONDITION TEXT IS CUSTOMER-FACING, SO IT CARRIES ITS THREE LANGUAGES,
  // and the defaults offered are the hand-written ones the server already
  // ships — nothing here is machine-translated into Sorani.
  const settings = read('worker/lib/settings.ts');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const match = new RegExp(`${lang}: '([^']+)'`).exec(
      settings.slice(settings.indexOf('giniPolicy: {'), settings.indexOf('proPriorityDelivery'))
    );
    assert.ok(match, `the server default for conditions.${lang} moved`);
    assert.ok(
      store.includes(match[1]),
      `the admin default for conditions.${lang} is not the server's hand-written string`
    );
  }
});
