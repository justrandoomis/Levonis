/**
 * THE ALERT'S LIFECYCLE, PINNED TO THE OWNER'S RULING.
 *
 * The ruling, verbatim, because every assertion below is a sentence of it:
 *
 *   «التنبيه ليس له نهاية حتى يتوفر المنتج في المخزون، وبعدها ينتهي وظيفة،
 *    ويرجع إذا أراد الزبون مرة ثانية يضغط نبّهني — يعني أنه إذا توفر المنتج
 *    بعد مرور خمسة وتسعين يوما يرسل له إشعار، وبعد أسبوع خلص المنتج وبعد
 *    أسبوع توفر مرة ثانية فلا يرسل له، لأنه نبّهه أول مرة»
 *
 * Four facts follow, and all four live in code that nothing else asserts:
 *
 *   1. AN ALERT HAS NO TIME LIMIT. `product_stock_alerts.expires_at` used to be
 *      stamped with `armed_at + 90 days` and was never once read back. It is
 *      now a dead column: nothing writes it, nothing sends it.
 *   2. THE API DOES NOT PUBLISH IT. A field on the wire is a field somebody
 *      renders, and «ينتهي في…» is a promise this system does not make.
 *   3. A FIRED ALERT IS FINISHED, AND THE BUTTON COMES BACK. The product sheet
 *      reads live rows only, so a `notified` row leaves the trigger un-armed
 *      and «نبّهني» is offered afresh. A `dead` row is different and must stay
 *      un-offerable — the wish was invalidated, not satisfied.
 *   4. THE SERVER HONOURS THAT OFFER. The arm upsert puts a notified row back
 *      to 'armed' with no guard on the prior state, so the button can never
 *      offer something the server would refuse.
 *
 * WHAT WOULD MAKE EACH OF THESE FAIL — an assertion nothing can break is
 * theatre, so each test below names the production edit it is standing in
 * front of, and every one of them is an edit somebody could plausibly make
 * while believing they were fixing something.
 *
 * There is no D1 and no DOM in this suite, so the contracts are asserted
 * against the source the way tests/stockAlertsPage.test.ts does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const ROUTE = 'worker/routes/stockAlerts.ts';
const PANEL = 'src/components/product/StockAlertPanel.tsx';
const PAGE = 'src/pages/StockAlerts.tsx';
const TARGETS = 'src/components/product/stockAlertTargets.ts';
const API = 'src/lib/api.ts';
const MIGRATION = 'migrations/0092_stock_alerts.sql';

const route = read(ROUTE);
const panel = read(PANEL);
const page = read(PAGE);

/** Source with every block and line comment removed. The comments here TALK
 *  about `expires_at` on purpose — that is the documentation of the dead
 *  column — so a naive grep over the raw file would fail on the very note that
 *  makes the removal legible. Everything asserted below is asserted against
 *  executable text only. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ------------------------------------------ 1. nothing writes the dead column

test('no executable line in the alert route mentions expires_at or a TTL', () => {
  const body = code(route);
  // WHAT BREAKS THIS: someone re-adds `expires_at = excluded.expires_at` to the
  // ON CONFLICT clause, or reintroduces ALERT_TTL_DAYS to "clean up old
  // alerts". Both were there until the owner ruled that an alert waits as long
  // as it takes, and both are the kind of change that looks like hygiene.
  assert.ok(
    !/expires_at/.test(body),
    `${ROUTE} must not name expires_at outside comments — the column is dead by the owner's ruling`
  );
  assert.ok(!/ALERT_TTL_DAYS/.test(body), 'ALERT_TTL_DAYS is gone and must not return');
  assert.ok(
    !/86_400_000|86400000/.test(body),
    'no day-arithmetic in the alert route: nothing about an alert is measured in days'
  );
});

test('the INSERT and the ON CONFLICT of the arm upsert both omit the column', () => {
  const fn = /function armStatement\([\s\S]*?\n}/.exec(code(route));
  assert.ok(fn, 'armStatement is still the one statement that arms an alert');
  const sql = fn[0];
  assert.ok(/INSERT INTO product_stock_alerts/.test(sql), 'it is still the upsert');
  assert.ok(!/expires_at/.test(sql), 'the upsert names no expiry column');
  // The column list and the VALUES list must still agree, which is the thing a
  // hand-deletion of one `?` gets wrong. Count the columns between the parens
  // and the placeholders plus literals in VALUES.
  const cols = /\(id, user_id,([\s\S]*?)\)\s*\n\s*VALUES \(([^)]*)\)/.exec(sql);
  assert.ok(cols, 'the upsert still lists its columns and its VALUES explicitly');
  const nCols = ('id, user_id,' + cols[1]).split(',').length;
  const nVals = cols[2].split(',').length;
  assert.equal(nVals, nCols, 'the VALUES list has exactly one entry per named column');
});

test('the dead column is documented where the code that abandoned it lives', () => {
  // WHAT BREAKS THIS: a future reader finds `expires_at` in migration 0092,
  // sees nothing writing it, and "restores" the write. The note is the only
  // thing standing between them and that. Migrations here are additive-only
  // and a shipped one is never edited, so the explanation has to live here.
  assert.ok(
    /expires_at/.test(route) && /additive/i.test(route),
    `${ROUTE} must explain, in a comment, why the column stays in the schema unused`
  );
  assert.ok(
    /expires_at TEXT NOT NULL DEFAULT ''/.test(read(MIGRATION)),
    'the column itself still stands in 0092 — SQLite cannot drop one without a table rebuild'
  );
});

// --------------------------------------------- 2. the API does not publish it

test('no alert response shape carries expires_at, on either side of the wire', () => {
  // WHAT BREAKS THIS: a client type is "completed" from the D1 schema, or the
  // list SELECT gets `a.*`. Either way TypeScript starts promising a date that
  // never arrives, and the first render of it is «ينتهي في…» — a lapse that
  // will not happen.
  assert.ok(!/expires_at/.test(code(route)), 'the route sends no expires_at');
  const rowType = /export interface StockAlertRow \{[\s\S]*?\n\}/.exec(read(TARGETS));
  assert.ok(rowType, 'stockAlertTargets.ts still declares the stored-row shape');
  assert.ok(!/expires_at:/.test(rowType[0]), 'the picker’s row type declares no expiry');
  const api = read(API);
  for (const name of ['StockAlertRow', 'StockAlertListEntry']) {
    const decl = new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(api);
    assert.ok(decl, `src/lib/api.ts still declares ${name}`);
    assert.ok(!/expires_at:/.test(decl[0]), `${name} declares no expiry field`);
  }
});

test('«تنبيهاتي» renders no expiry and no lapse wording', () => {
  assert.ok(!/expires_at/.test(code(page)), 'the list page reads no expiry');
  // The Arabic a lapse would be written in. Guarding the words and not only the
  // field name is the point: the harm is the sentence, not the identifier.
  // The Arabic a lapse would be written in, checked against executable text:
  // the comment above DEAD_REASON_TEXT quotes «ينتهي في…» in order to forbid
  // it, and a test that could not tell the prohibition from the offence would
  // have to be deleted the first time someone documented the rule properly.
  assert.ok(!/ينتهي في/.test(code(page)), 'no «ينتهي في…» rendered on a screen where nothing expires');
});

// ------------------------- 3. the button comes back, but only for a fired one

test('the product sheet reads live rows only, which is what un-arms the button', () => {
  // WHAT BREAKS THIS: widening armedForProduct to `state IN ('armed','firing',
  // 'notified')` so the customer "can see their history on the product page".
  // That single edit pre-ticks a spent alert and lights the armed tick, and the
  // sheet then tells a customer they are waiting for a message already sent.
  const fn = /async function armedForProduct\([\s\S]*?\n}/.exec(route);
  assert.ok(fn, 'armedForProduct is still the product sheet’s only read');
  const states = /state IN \(([^)]*)\)/.exec(fn[0]);
  assert.ok(states, 'it still filters on state');
  assert.equal(
    states[1].replace(/\s/g, ''),
    "'armed','firing'",
    "the sheet must see 'armed' and 'firing' and nothing else — a notified row is spent, a dead row is void"
  );
  // And the trigger's armed face is driven by that read, not by a separate idea
  // of armed-ness that could survive the row leaving the list.
  assert.ok(
    /const hasArmed = \(armed\?\.length \?\? 0\) > 0;/.test(panel),
    'the armed tick is derived from the live rows the server returned'
  );
});

test('a dead row is still refused the button, and for a different reason', () => {
  // WHAT BREAKS THIS: reading the ruling as "a finished alert can always be
  // re-armed" and offering «نبّهني مرة ثانية» on every non-live row. `dead`
  // means the target itself can never come back, so armRefusal would refuse the
  // identical wish with the reason already printed on the row.
  assert.ok(
    /armRefusal/.test(page),
    'the list page still explains why a dead row links to the product instead of offering a button'
  );
  assert.ok(
    /const dead = a\.state === 'dead';/.test(page),
    'the dead row is still a distinct surface on the list'
  );
  const live = /const LIVE_STATES = new Set\(\[([^\]]*)\]\)/.exec(page);
  assert.ok(live, 'the page still names the states the server will still cancel');
  assert.equal(
    live[1].replace(/\s/g, ''),
    "'armed','firing'",
    'the bin is offered exactly where DELETE guards — a notified row is finished, not cancellable'
  );
});

// --------------------------------- 4. the server honours the offer it makes

test('the arm upsert really does re-arm a notified row', () => {
  // WHAT BREAKS THIS: adding `WHERE product_stock_alerts.state <> 'notified'`
  // to the DO UPDATE, or a prior-state check in the handler, to "stop duplicate
  // alerts". The button would then offer «نبّهني» — because the sheet legibly
  // shows no live row — and the server would silently keep the row spent. The
  // customer taps, sees success, and is never told again.
  const fn = /function armStatement\([\s\S]*?\n}/.exec(code(route));
  assert.ok(fn, 'armStatement still exists');
  const conflict = /ON CONFLICT\(([\s\S]*?)\) DO UPDATE SET([\s\S]*?)`/.exec(fn[0]);
  assert.ok(conflict, 'the upsert still resolves the unique target with a DO UPDATE');
  const setClause = conflict[2];
  assert.ok(/state = 'armed'/.test(setClause), "the conflicting row goes back to 'armed'");
  assert.ok(
    !/\bWHERE\b/.test(setClause),
    'the DO UPDATE carries no WHERE — no prior state may block a re-arm, including notified'
  );
  assert.ok(
    /arm_seq = product_stock_alerts\.arm_seq \+/.test(setClause),
    'arm_seq advances, so a re-armed row is distinguishable from a never-fired one'
  );
  assert.ok(
    /CASE WHEN product_stock_alerts\.state <> 'armed' THEN 1 ELSE 0 END/.test(setClause),
    "the counter advances precisely when the row was NOT already armed — which is the notified case"
  );
  assert.ok(/notified_at = ''/.test(setClause), 'the old notification timestamp is cleared');
  assert.ok(/dead_reason = ''/.test(setClause), 'a stale reason cannot survive a re-arm');
});

test('armRefusal judges the target and never the row, so the offer cannot be a lie', () => {
  // WHAT BREAKS THIS: giving the arm door access to the existing row and
  // teaching it to refuse a second arming. That is the one change that would
  // make the un-armed button on a notified product dishonest, so the door's
  // signature is the thing pinned.
  const resolve = read('worker/lib/stockAlertResolve.ts');
  const sig = /export function armRefusal\(([^)]*)\)/.exec(resolve);
  assert.ok(sig, 'armRefusal is still the arm door');
  const params = sig[1].split(',').map((x) => x.trim()).filter(Boolean);
  assert.equal(params.length, 2, 'armRefusal still takes exactly two arguments');
  assert.match(params[0], /: *AlertProductContext$/, 'the first is the product context');
  assert.match(params[1], /: *AlertWish$/, 'the second is the wish being armed');
  // The row itself is deliberately absent. A third parameter of any shape — the
  // existing alert, its state, its arm_seq — is the door learning the history
  // it must not judge, and that is the change that would turn the product
  // page's un-armed «نبّهني» into a button the server quietly refuses.
  assert.ok(
    !/product_stock_alerts/.test(/export function armRefusal\([\s\S]*?\n}/.exec(resolve)![0]),
    'armRefusal reads no alert row of its own'
  );
});

// ------------------------------------------------- the Kurdish, once reviewed

test('the Sorani review is recorded so nobody re-opens a settled question', () => {
  // WHAT BREAKS THIS: deleting the note as clutter, after which the next reader
  // either re-litigates the translations or — worse — "harmonises" them with
  // the Arabic, which is the exact failure the house rule about ckb exists to
  // stop and which looks like an improvement while it happens.
  const block = /EVERY REASON THE SERVER CAN KILL AN ALERT WITH[\s\S]*?\*\//.exec(page);
  assert.ok(block, 'the note above DEAD_REASON_TEXT still stands');
  assert.ok(/REVIEWED/i.test(block[0]), 'it records that the Sorani was reviewed, not assumed');
  for (const term of ['ئاگادارکردنەوە', 'هەڵوەشێنرایەوە', 'کۆگا']) {
    assert.ok(block[0].includes(term), `the note names the reviewed term ${term}`);
  }
});
