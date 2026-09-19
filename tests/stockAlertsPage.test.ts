/**
 * «تنبيهاتي» — THE LIST SCREEN, PINNED.
 *
 * The product page could arm an alert long before anything could show one. The
 * three things that decide whether this screen tells the truth are the three
 * things asserted here:
 *
 *   1. EVERY `dead_reason` THE SERVER CAN WRITE HAS A SENTENCE. A reconciled
 *      alert with no words on it is indistinguishable from one still waiting,
 *      and migration 0092 chose reconciliation over a silent DELETE precisely
 *      so the customer could read the reason. The set of reasons is READ OUT OF
 *      THE WORKER (`AlertDeadReason` in worker/lib/stockAlertResolve.ts), not
 *      copied here, so a ninth reason added server-side fails this test on the
 *      day it lands instead of rendering as an empty line months later.
 *
 *   2. THE CANCEL WAITS FOR THE SERVER. `DELETE /api/stock-alerts/:id` is rate
 *      limited and answers 404 for a row that is no longer live. A row removed
 *      before the answer arrives is a customer who believes they cancelled and
 *      still gets the message — the one outcome this feature cannot survive.
 *
 *   3. THE THREE LANGUAGES, AND NOT THE `dir === 'rtl'` IDIOM. 'ckb' is also
 *      RTL, so `dir === 'rtl' ? ar : en` silently serves Arabic to every
 *      Kurdish customer. This file refuses to let a 265th instance in through
 *      the new page.
 *
 * There is no browser DOM runner in this repository, so the markup contracts
 * are asserted against the source the way tests/uiSystem.test.ts does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PAGE = 'src/pages/StockAlerts.tsx';
const APP = 'src/App.tsx';
const PROFILE = 'src/pages/Profile.tsx';
const RESOLVE = 'worker/lib/stockAlertResolve.ts';
const ROUTE = 'worker/routes/stockAlerts.ts';

const page = read(PAGE);

/** The `AlertDeadReason` union, taken from the worker's own source. */
function serverDeadReasons(): string[] {
  const src = read(RESOLVE);
  const decl = /export type AlertDeadReason =([\s\S]*?);/.exec(src);
  assert.ok(decl, 'AlertDeadReason is still a union declared in ' + RESOLVE);
  const names = [...decl[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 8, 'the union parsed to at least the eight known reasons');
  return names;
}

/** The keys of the page's own `DEAD_REASON_TEXT` table, parsed from source
 *  rather than imported: the module is a React page, and this repository's
 *  tests do not stand up a DOM to read one constant. */
function pageDeadReasons(): string[] {
  const block = /export const DEAD_REASON_TEXT[\s\S]*?\n};/.exec(page);
  assert.ok(block, 'the page still exports a DEAD_REASON_TEXT table');
  return [...block[0].matchAll(/^ {2}([A-Z_]+): \{$/gm)].map((m) => m[1]);
}

// ------------------------------------------------------- the reason column

test('every dead_reason the server can write has a sentence on the list', () => {
  const server = serverDeadReasons().sort();
  const ui = pageDeadReasons().sort();
  assert.deepEqual(
    ui,
    server,
    'DEAD_REASON_TEXT must cover exactly the reasons worker/lib/stockAlertResolve.ts can store'
  );
});

test('each reason is written in all three languages, and ckb is not the English one', () => {
  const block = /export const DEAD_REASON_TEXT[\s\S]*?\n};/.exec(page)![0];
  for (const reason of pageDeadReasons()) {
    const entry = new RegExp(`${reason}: \\{([\\s\\S]*?)\\n  \\},`).exec(block);
    assert.ok(entry, `${reason} has an entry`);
    const body = entry[1];
    const ar = /\bar: '([^']+)'/.exec(body);
    const en = /\ben: '([^']+)'/.exec(body);
    const ckb = /\bckb: '([^']+)'/.exec(body);
    assert.ok(ar && ar[1].trim(), `${reason} has Arabic`);
    assert.ok(en && en[1].trim(), `${reason} has English`);
    assert.ok(ckb && ckb[1].trim(), `${reason} has Sorani`);
    // The failure this guards is a copy-paste that leaves one language holding
    // another's sentence — which reads as a translation and is not one.
    assert.notEqual(ar![1], en![1], `${reason}: Arabic and English differ`);
    assert.notEqual(ckb![1], en![1], `${reason}: Sorani is not the English string`);
  }
});

test('a dead_reason this build has never heard of still gets a true sentence', () => {
  // The worker ships separately from the app a customer has cached, so an
  // unknown reason must not render as a red icon over an empty line.
  assert.match(page, /DEAD_REASON_FALLBACK/);
  assert.match(page, /DEAD_REASON_TEXT\[[^\]]+\]\)\s*\|\|\s*DEAD_REASON_FALLBACK/);
  for (const key of ['ar', 'en', 'ckb']) {
    assert.match(
      page,
      new RegExp(`const DEAD_REASON_FALLBACK[\\s\\S]{0,400}?\\b${key}: '[^']+'`),
      `the fallback is written in ${key}`
    );
  }
});

test('a cancelled alert is visibly not a waiting one', () => {
  // The whole argument for this page: the dead row carries the reason, its own
  // surface and its own marker, so «ملغي» is never mistaken for «بالانتظار».
  assert.match(page, /data-alert-dead=/);
  assert.match(page, /data-alert-state=\{a\.state\}/);
  assert.match(page, /dead\s*\?\s*'border-danger\/35 bg-danger\/\[0\.07\]'/);
  assert.match(page, /<CircleSlash/);
  // The reason is printed from the table, in the reader's own language.
  assert.match(page, /\{reason\[l\]\}/);
});

// ------------------------------------------------------------- the cancel

test('cancelling waits for the round trip and never removes the row first', () => {
  const body = /const cancel = async[\s\S]*?\n {2}\};/.exec(page);
  assert.ok(body, 'the page still has a cancel handler');
  const src = body[0];
  const del = src.indexOf('await api.delete');
  const drop = src.indexOf('setAlerts(');
  assert.ok(del > 0, 'the cancel calls DELETE /api/stock-alerts/:id');
  assert.ok(
    drop > del,
    'the list must only change AFTER the server answered — an optimistic removal ' +
      'leaves a customer who still gets the message believing they cancelled'
  );
  assert.match(src, /api\.delete<[^>]*>\(`\/api\/stock-alerts\/\$\{encodeURIComponent\(id\)\}`\)/);
  // One round trip at a time — and EVERY bin says so, not just the one that is
  // waiting. `disabled={busy}` left the other rows looking live while the guard
  // below silently swallowed their taps: the customer gets no spinner, no
  // error, no change of any kind, reads that as a broken button, and taps it
  // again. `disabled={!!busyId}` is what makes `if (busyId) return;`
  // belt-and-braces instead of the only thing standing between the customer and
  // a silent no-op. `aria-busy` stays per-row, because one row is working.
  assert.match(page, /disabled=\{!!busyId\}/);
  assert.match(page, /aria-busy=\{busy\}/);
  assert.match(src, /if \(busyId\) return;/);
});

test('every refusal the cancel can meet is named, and 404 is not treated as one', () => {
  const src = /const cancel = async[\s\S]*?\n {2}\};/.exec(page)![0];
  // 404 means the row is already not live (cancelled elsewhere, or reconciled
  // by the sweep): dropping it is the honest outcome, not an error.
  assert.match(src, /e\.status === 404[\s\S]{0,200}setAlerts\(\(prev\) => prev\.filter/);
  // 401 goes to AsyncStates, which renders the sign-in prompt with ?next=.
  assert.match(src, /e\.status === 401[\s\S]{0,60}setError\(e\)/);
  // 429 is the route's own limiter and its server message is English-only.
  assert.match(src, /e\.status === 429/);
  // Anything else keeps the row and says the alert is STILL live.
  assert.match(src, /setRowError/);
  assert.match(page, /role="alert"/);
});

test('the bin is offered only where the server will honour it', () => {
  // DELETE guards with state IN ('armed','firing') — a bin on a notified or
  // dead row is a button whose only outcome is a 404.
  assert.match(page, /const LIVE_STATES = new Set\(\['armed', 'firing'\]\)/);
  assert.match(page, /const live = LIVE_STATES\.has\(a\.state\)/);
  assert.match(page, /\{live \? \([\s\S]{0,2200}?data-alert-cancel/);
  assert.match(read(ROUTE), /SET state = 'cancelled'[\s\S]{0,200}state IN \('armed','firing'\)/);
  // Re-arming is the product page's job: POST from here could only be refused.
  assert.doesNotMatch(page, /api\.post/);
});

// -------------------------------------------------------- the other states

test('loading, empty and error reuse the storefront components rather than new ones', () => {
  assert.match(page, /from '\.\.\/components\/ui\/AsyncStates'/);
  assert.match(page, /<ErrorState error=\{error\} onRetry=\{load\}/);
  assert.match(page, /<EmptyState/);
  assert.match(page, /from '\.\.\/components\/ui\/Skeleton'/);
  assert.match(page, /<SkeletonGroup/);
});

test('an empty list is a sentence and a way back to the catalogue', () => {
  const empty = /<EmptyState[\s\S]*?\n {10}\/>/.exec(page);
  assert.ok(empty, 'the empty state is rendered');
  assert.match(empty[0], /title=\{loc\(/);
  assert.match(empty[0], /description=\{loc\(/);
  assert.match(empty[0], /to="\/products"/);
});

test('a signed-out visitor is stopped at the route and never told the list is empty', () => {
  const app = read(APP);
  assert.match(app, /const StockAlerts = React\.lazy\(\(\) => import\('\.\/pages\/StockAlerts'\)\)/);
  assert.match(
    app,
    /<Route path="\/stock-alerts" element=\{<ProtectedRoute><StockAlerts \/><\/ProtectedRoute>\} \/>/
  );
  // The route is the gate; the page's own 401 branch covers an expired cookie,
  // and AsyncStates turns that into a sign-in prompt carrying the return path.
  assert.match(page, /next="\/stock-alerts"/);
  assert.match(read(ROUTE), /stockAlertRoutes\.use\('\*', requireAuth\)/);
});

test('the account page carries the one entry point', () => {
  const profile = read(PROFILE);
  assert.match(profile, /data-profile-stock-alerts/);
  assert.match(profile, /navigate\('\/stock-alerts'\)/);
  assert.match(profile, /loc\('تنبيهاتي', 'My alerts', 'ئاگادارکردنەوەکانم'\)/);
});

// -------------------------------------------------- the house design rules

test('the page never serves Arabic to a Kurdish reader through the rtl idiom', () => {
  // 'ckb' is RTL too, so `dir === 'rtl' ? ar : en` is a silent language bug.
  assert.doesNotMatch(page, /dir === 'rtl' \?\s*'/);
  assert.doesNotMatch(page, /lang === 'ar' \? '[^']*' : '/);
  // A THIRD SHAPE, and the one that actually got through: `lang === 'en' ? x :
  // y`. It looks like an English special case rather than a language branch,
  // but its else-arm is the Arabic one, so it hands Arabic to every Kurdish
  // reader exactly like the two above. It shipped in `formatDate`, which dated
  // a Sorani row «19 أيلول 2026» while every other string on the page was
  // properly three-way. A two-armed branch on a three-language page is the bug
  // whatever it is spelled as, so all three spellings are refused here.
  // Comments are stripped first: the file's header and `formatDate`'s own note
  // QUOTE these idioms in order to name the bug they avoid, and a guard that
  // cannot tell an explanation from code would forbid explaining it.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const m of code.matchAll(/lang === 'en'[\s\S]{0,140}/g)) {
    assert.match(m[0], /lang === 'ckb'/, `a two-way language branch: ${m[0].slice(0, 90)}`);
  }
  // Every user-facing string goes through loc(ar, en, ckb) or a three-key table.
  assert.match(page, /loc\('[^']+', '[^']+', '[^']+'\)/);
});

test('no invisible character can hide inside a string on this page', () => {
  // A U+200C zero-width non-joiner reached PREORDER_ONLY's Sorani sentence.
  // ZWNJ word-joining is a PERSIAN convention — Sorani does not use it — so it
  // is both wrong and a reliable tell of text written by a non-speaker. It is
  // invisible, which means no reviewer and no Kurdish reader would ever have
  // caught it by eye; only a machine can. U+FEFF is here too because a raw byte
  // order mark has already been pasted into a source file once in this project.
  const hits = [...page.matchAll(/[\u200b-\u200f\ufeff]/g)].map(
    (m) => `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} at ${m.index}`
  );
  assert.deepEqual(hits, [], 'invisible characters in the page source');
});

test('the Sorani empty state quotes the button that actually exists', () => {
  // The empty state tells the customer which control to look for on the product
  // page. The Arabic and English arms are exact quotations of StockAlertPanel's
  // own labels; the Sorani arm was a paraphrase, so a Kurdish customer scanning
  // for that phrase would not have found it. A sentence that sends someone
  // looking for a button by a name it does not have is the one thing this
  // screen must never do.
  const panel = readFileSync(new URL('../src/components/product/StockAlertPanel.tsx', import.meta.url), 'utf8');
  for (const cta of [...panel.matchAll(/cta: '([^']+)'/g)].map((m) => m[1])) {
    assert.ok(page.includes(cta), `the empty state must quote the real CTA «${cta}»`);
  }
});

test('every arbitrary text size states its own line height', () => {
  // An arbitrary `text-[13px]` sets font-size ONLY: Tailwind's preset line
  // height goes with the preset size, so a bare arbitrary size inherits
  // whatever the ancestor had and Arabic descenders clip at the next breakpoint.
  for (const m of page.matchAll(/className=\{?[`"][^`"]*text-\[[0-9.]+px\][^`"]*[`"]/g)) {
    assert.match(m[0], /leading-/, `an arbitrary text size without a leading-: ${m[0]}`);
  }
});

test('the page is written in logical properties only', () => {
  // Physical sides are wrong in one of the two directions this shop ships in.
  assert.doesNotMatch(page, /\b(ml|mr|pl|pr)-[0-9[]/);
  assert.doesNotMatch(page, /\b(left|right)-[0-9[]/);
  assert.doesNotMatch(page, /\btext-(left|right)\b/);
  assert.doesNotMatch(page, /\bborder-[lr]-[0-9]/);
  assert.match(page, /border-s-2/);
  assert.match(page, /\bps-/);
});

test('nothing affords itself through hover alone, and every target is thumb-sized', () => {
  // Tailwind v4 gates `hover:` behind @media (hover: hover) — on the phones
  // this shop sells to, a hover-only control gives no feedback at all.
  for (const m of page.matchAll(/className=\{?[`"][^`"]*hover:[^`"]*[`"]/g)) {
    assert.match(
      m[0],
      /active:|focus-visible:/,
      `a hover: with no touch or keyboard affordance: ${m[0]}`
    );
  }
  for (const m of page.matchAll(/<button[\s\S]{0,700}?className=\{?[`"][^`"]*[`"]/g)) {
    assert.match(m[0], /min-h-\[44px\]/, `a button under the 44px floor: ${m[0].slice(0, 120)}`);
  }
});
