/**
 * TRACK E — the old members screen becomes a window too.
 *
 * «أما البند الذي لم ينجز شاشة الأعضاء القديمة انقل هذا أيضا» — the owner had
 * already been given this for the users table and asked for it here. The PRO
 * member detail used to render at the FOOT of the members list, so pressing a
 * member scrolled that member off the screen and left an admin reading a
 * subscription, a debt and a restriction history with no visible answer to
 * "whose are these?".
 *
 * There is no browser DOM runner in this repository, so — exactly as
 * tests/adminUserModal.test.ts, tests/uiSystem.test.ts and
 * tests/adminSurfaceDesign.test.ts do — the contract is asserted over the
 * source, plus one group that IMPORTS the strings module and checks its real
 * behaviour rather than its spelling.
 *
 * Each assertion below is written against a PRODUCTION CHANGE that would make
 * it fail; where that is not obvious from the assertion, it is named.
 *
 * Run: node --import tsx --test tests/adminMembershipsModal.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * THE SOURCE WITH ITS PROSE REMOVED.
 *
 * This repository's house style is long comments naming the failure the code
 * prevents, so the comment explaining "the window is NOT `{selected &&
 * <MemberDetail …>}` any more" contains the very string the assertion forbids,
 * and a correct file would fail a correct test. `//` counts as a line comment
 * only after whitespace or at the start of a line, so `https://levonis-iq.com`
 * survives — the one ambiguity worth spelling out rather than pretending a
 * regex is a parser. (The same helper, for the same reason, as
 * tests/adminUserModal.test.ts.)
 */
const code = (p: string) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const CONSOLE = 'src/components/AdminMemberships.tsx';
const MODAL = 'src/components/adminMemberships/MemberDetailModal.tsx';
const ACTIONS = 'src/components/adminMemberships/actions.tsx';
const TYPES = 'src/components/adminMemberships/types.ts';
const STRINGS = 'src/components/adminMemberships/strings.ts';
const FOLDER = 'src/components/adminMemberships';
const folderFiles = () => readdirSync(join(ROOT, FOLDER)).map((f) => `${FOLDER}/${f}`);

/** The members table only — the support queue below it is another surface. */
function membersSection(): string {
  const text = code(CONSOLE);
  const start = text.indexOf('function MembersSection');
  const end = text.indexOf('function QueueSection');
  assert.ok(start > 0 && end > start, 'the members table must still be a section of its own');
  return text.slice(start, end);
}

// =========================================================================
// 1 — the detail is no longer a block at the foot of the page
// =========================================================================

test('the member detail is gone from the foot of the members list and is a window instead', () => {
  const console_ = code(CONSOLE);

  // The component that WAS the block at the bottom of the page. Re-adding an
  // inline `MemberDetail` — or re-rendering the window as `{selected && …}`,
  // which is what tore the old one out of the DOM mid-animation — fails here.
  assert.doesNotMatch(console_, /function MemberDetail\s*\(/, 'the foot-of-page detail is back');
  assert.doesNotMatch(console_, /\{selected && </, 'the window must be mounted unconditionally, or it has no exit');

  assert.match(console_, /<MemberDetailModal/);
  assert.match(console_, /userId=\{selected\}/);
  assert.match(console_, /anchorRef=\{detailAnchorRef\}/);
  assert.match(console_, /import MemberDetailModal from '\.\/adminMemberships\/MemberDetailModal'/);

  // And it is a real window, not a hand-rolled layer: `Overlay` owns the
  // scrim, the stacking and the page-scroll lock, and a second `fixed inset-0`
  // would sit under the bottom navigation exactly as the old sheets did.
  assert.doesNotMatch(code(MODAL), /fixed inset-0/);
});

test('pressing a member is pressing a BUTTON, and the button is what the window returns to', () => {
  const members = membersSection();

  // A clickable <tr> is unreachable by keyboard, silent to a screen reader,
  // and — the part this window depends on — is not an element the panel can
  // grow out of or hand focus back to.
  assert.doesNotMatch(members, /<tr[\s\S]{0,200}?onClick=/, 'the member row opens the profile from a <tr> again');
  assert.match(members, /detailAnchorRef\.current = e\.currentTarget;\s*\n\s*setSelected\(m\.id\);/);
  assert.match(members, /const detailAnchorRef = useRef<HTMLElement \| null>\(null\);/);
  // The control says what it opens, in the reader's own language.
  assert.match(members, /aria-label=\{`\$\{s\.openMember\}/);
});

// =========================================================================
// 2 — it is the SAME window as the users table's, not a second one
// =========================================================================

test('the window reuses the users table\'s modal parts rather than growing a second set', () => {
  const modal = src(MODAL);

  // The four presentational levels and the focus hook are IMPORTED. A copy of
  // `Section`/`Row`/`Stat`/`Pill` here would drift from the other member
  // window the first time either was touched, and an admin would have to learn
  // the panel twice.
  assert.match(modal, /import \{ Overlay \} from '\.\.\/ui\/Overlay'/);
  assert.match(modal, /import \{ Pill, Row, Section, Stat \} from '\.\.\/adminUsers\/ui'/);
  assert.match(modal, /import \{ useModalFocus \} from '\.\.\/adminUsers\/useModalFocus'/);

  // Anchored to the row, in modal mode, with the trap wired to the panel.
  assert.match(modal, /mode="modal"/);
  assert.match(modal, /anchor=\{anchorRef\}/);
  assert.match(modal, /panelMotion=\{\{ ref: setPanel \}\}/);
  assert.match(modal, /const \{ setPanel \} = useModalFocus\(open, anchorRef\);/);

  // The pieces it reuses are the ones that exist.
  for (const sym of ['export function Section', 'export function Row', 'export function Stat', 'export function Pill']) {
    assert.ok(src('src/components/adminUsers/ui.tsx').includes(sym), `adminUsers/ui.tsx no longer exports ${sym}`);
  }
  assert.ok(src('src/components/adminUsers/useModalFocus.ts').includes('export function useModalFocus'));
});

test('Escape, the focus trap and the page lock stay with the primitives that own them', () => {
  // A second implementation of any of the three would FIGHT the first:
  // `Overlay`'s body lock is reference counted, so a raw
  // `document.body.style.overflow` here would release the page early; a second
  // Escape listener would close two things at once; a second Tab handler would
  // preventDefault twice and stall the cycle.
  for (const f of folderFiles()) {
    const text = code(f);
    assert.doesNotMatch(text, /document\.body\.style\.overflow/, `${f} locks the page itself`);
    assert.doesNotMatch(text, /'Escape'/, `${f} listens for Escape itself`);
    assert.doesNotMatch(text, /e\.key === 'Tab'/, `${f} traps Tab itself`);
  }

  // And the trap it delegates to is the one that restores focus to the row.
  const focus = src('src/components/adminUsers/useModalFocus.ts');
  assert.match(focus, /document\.contains\(returnTo\)/);
  assert.match(focus, /addEventListener\('keydown', onKeyDown, true\)/);

  // The page behind is locked because the window is a MODAL overlay, and the
  // lock is reference counted so a window over a window cannot release it.
  const overlay = src('src/components/ui/Overlay.tsx');
  assert.match(overlay, /if \(!open \|\| mode !== 'modal'\) return;\s*\n\s*return acquireModalLock\(\);/);
});

test('the reason for a grant or a resume is typed INSIDE the window, never in a second one', () => {
  // A dialog opened over this dialog breaks all three promises above: both
  // Overlays would answer one Escape, the trap would pull focus back out of
  // the inner panel, and an inner window at the default z would render BELOW
  // a profile opened at z=50. So the prompt is inline — importing `Overlay`
  // into the actions file is the production change that reintroduces all of it.
  assert.doesNotMatch(code(ACTIONS), /from '\.\.\/ui\/Overlay'/);
  assert.match(src(ACTIONS), /export function ReasonPrompt/);
  assert.match(src(MODAL), /<ReasonPrompt/);
  // And it is still a written reason, not a browser prompt nobody can read in
  // their own language.
  for (const f of folderFiles()) {
    assert.doesNotMatch(code(f), /window\.(confirm|prompt)|(^|\s)alert\(/, `${f} asks with a browser dialog`);
  }
});

// =========================================================================
// 3 — the aria wiring of the dialog itself
// =========================================================================

test('the dialog is named by its own heading, and the name reaches the element that carries role="dialog"', () => {
  const modal = src(MODAL);
  assert.match(modal, /const TITLE_ID = 'admin-membership-member-title';/);
  assert.match(modal, /labelledBy=\{TITLE_ID\}/);
  assert.match(modal, /<h3 id=\{TITLE_ID\}/);
  assert.match(modal, /aria-label=\{s\.close\}/, 'the X must say what it does');

  // THE HALF THAT IS NOT IN THIS FILE. `labelledBy` is only a promise until
  // the primitive spends it: the panel is the element with role="dialog", and
  // it is the one that has to carry aria-labelledby and aria-modal. If Overlay
  // ever stopped forwarding it, every dialog in the app would announce itself
  // as an unnamed group and this assertion is where that is caught.
  const overlay = src('src/components/ui/Overlay.tsx');
  assert.match(overlay, /role="dialog"/);
  assert.match(overlay, /aria-modal=\{mode === 'modal'\}/);
  assert.match(overlay, /aria-labelledby=\{labelledBy\}/);
});

// =========================================================================
// 4 — §11: no figure of money is drawn without the server having sent it
// =========================================================================

test('every financial field of this screen is OPTIONAL on the wire', () => {
  const types = src(TYPES);
  // «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي» — a required
  // field is a field the screen may read unconditionally. Dropping the `?`
  // from any of these is the production change that lets a lifetime figure be
  // rendered without anyone proving it arrived.
  //
  // `| null` rides with the `?` because a server gate is written two ways —
  // deleting the keys (which worker/routes/support.ts does) or nulling them —
  // and `Math.round(null)` is 0, so the second spelling would print a
  // confident «0 د.ع» outstanding debt if the type pretended it could not
  // happen. Declaring it is what makes the guard in `Money` load-bearing
  // rather than defensive.
  for (const field of [
    'price_paid_iqd',
    'amount_iqd',
    'available_iqd',
    'credit_limit_iqd',
    'outstanding_iqd',
  ]) {
    assert.match(types, new RegExp(`${field}\\?: number \\| null;`), `${field} is no longer optional-and-nullable`);
  }
  assert.match(types, /ledger\?: BnplLedgerRow\[\];/);
});

test('the window draws money in exactly ONE place, and that place asks whether it arrived', () => {
  const modal = code(MODAL);

  // ONE call site. Six sections each formatting their own figure means the
  // scope rule has to be remembered six times, and the seventh is the leak.
  const calls = modal.match(/formatIqd\(/g) ?? [];
  assert.equal(calls.length, 1, `formatIqd is called ${calls.length} times in the member window`);

  // …and that call site is inside `Money`, after the branch that replaces an
  // absent figure with the sentence saying why it is absent.
  const start = modal.indexOf('function Money(');
  assert.ok(start > 0, 'the single money component must exist');
  const body = modal.slice(start, modal.indexOf('export default function', start));
  // ABSENT HAS THREE SPELLINGS AND ALL THREE MUST REACH THE LOCKED BRANCH.
  // A gate that nulls the fields rather than deleting the keys would otherwise
  // reach formatIqd — `Math.round(null)` is 0 — and every money row would read
  // «0 د.ع». A confident zero outstanding debt is a worse answer than NaN,
  // because nobody would question it, and the BNPL controls follow the figure.
  assert.match(body, /if \(iqd === undefined \|\| iqd === null \|\| !Number\.isFinite\(iqd\)\)/);
  assert.ok(body.indexOf('s.moneyHidden') < body.indexOf('formatIqd('), 'the locked branch must come first');
  assert.ok(modal.indexOf('formatIqd(') > start, 'a figure is formatted outside Money');

  // Every figure on the screen goes through it.
  const jsx = src(MODAL);
  for (const field of ['credit_limit_iqd', 'outstanding_iqd', 'available_iqd']) {
    assert.match(jsx, new RegExp(`<Money iqd=\\{view\\.debt\\.${field}\\}`), `${field} is not drawn by Money`);
  }
  assert.match(jsx, /<Money iqd=\{m\.price_paid_iqd\}/);
  assert.match(jsx, /<Money iqd=\{l\.amount_iqd\}/);
});

test('the window never decides for itself who may see money, and never merely hides it', () => {
  const modal = code(MODAL);

  // THE RULE IS THE RESPONSE, NOT THE SESSION. A hidden number is still in the
  // HTML and still in the JSON an assistant can read in their own devtools, so
  // a class or a role test here would be a boundary that is not one.
  assert.doesNotMatch(modal, /can_view_financials/, 'the session hint must not decide what this window draws');
  assert.doesNotMatch(modal, /admin_scope/, 'the scope is the server\'s to read, not this screen\'s');
  assert.doesNotMatch(modal, /\bis_owner\b/);
  assert.doesNotMatch(modal, /(hidden|opacity-0|blur-sm)[^\n]{0,80}(formatIqd|credit_limit|outstanding|price_paid)/);

  // The credit-limit CONTROLS follow the figure, and for a second reason:
  // `PUT /admin/bnpl/:userId` upserts whatever limit the request carries, so
  // suspending without one in hand would write the member's line down to 0.
  assert.match(src(MODAL), /const storedLimit = view\?\.debt\.credit_limit_iqd;/);
  assert.match(src(MODAL), /\{storedLimit === undefined \? \(/);
  assert.match(src(MODAL), /updateBnpl\('suspended', storedLimit\)/);
  assert.match(src(MODAL), /credit_limit_iqd: state === 'approved' \? limit : storedLimit,/);
});

// =========================================================================
// 5 — three languages, and the layout rules of tests/uiSystem.test.ts
// =========================================================================

test('the three languages are three languages — the strings answer to ckb, not to a direction', async () => {
  const mod = await import('../src/components/adminMemberships/strings');
  const keys = (o: object) => Object.keys(o).sort();
  assert.deepEqual(keys(mod.STRINGS.ar), keys(mod.STRINGS.en), 'ar and en have different keys');
  assert.deepEqual(keys(mod.STRINGS.ckb), keys(mod.STRINGS.en), 'ckb has fallen behind en');

  // ONE TABLE, IN ONE FILE. strings.ts's own header names the defect: a second
  // copy in the console or in the window drifts, and one screen ends up saying
  // «الأرقام المالية محجوبة» while the other says nothing at all. So the
  // declaration must live in strings.ts and every other file must IMPORT it —
  // which is also what makes the key-parity assertions above worth anything,
  // since a table they never see cannot be held to them.
  assert.match(code(STRINGS), /export const STRINGS = \{/, 'the trilingual table left strings.ts');
  for (const f of [...folderFiles(), CONSOLE]) {
    if (f === STRINGS) continue;
    assert.doesNotMatch(code(f), /const STRINGS\s*=\s*\{/, `${f} declares a SECOND copy of the trilingual table`);
  }

  // And not one of the three is allowed to be blank: an empty Sorani string
  // renders as a gap in the panel, which reads as "this member has none of
  // that" rather than as "nobody translated this label yet".
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const [k, v] of Object.entries(mod.STRINGS[lang])) {
      assert.equal(typeof v, 'string', `STRINGS.${lang}.${k} is not a string`);
      assert.notEqual(String(v).trim(), '', `STRINGS.${lang}.${k} is empty`);
    }
  }

  // A BEHAVIOURAL test, not a spelling one: Sorani is ALSO right-to-left, so
  // `dir === 'rtl' ? ar : en` serves Arabic to every Kurdish admin and is
  // invisible to an Arabic-reading reviewer. Kurdish must differ from Arabic.
  assert.notEqual(mod.benefitLabel('proPricing', 'ckb'), mod.benefitLabel('proPricing', 'ar'));
  assert.notEqual(mod.benefitLabel('proPricing', 'en'), mod.benefitLabel('proPricing', 'ar'));
  assert.equal(mod.benefitLabel('nonexistentFlag', 'ckb'), 'nonexistentFlag', 'an unknown flag shows its own name');
  assert.equal(mod.STRINGS.ar.moneyHidden === mod.STRINGS.ckb.moneyHidden, false);

  for (const f of [...folderFiles(), CONSOLE]) {
    assert.doesNotMatch(code(f), /dir [=!]== 'rtl'\s*\?/, `${f} decides language from direction`);
  }
});

test('the window obeys the layout contracts the rest of the app is held to', () => {
  const modal = src(MODAL);
  // The BODY scrolls, not the panel, so the member's name never leaves the
  // screen while their history is read — the owner's complaint at a smaller
  // scale. The cap is in DYNAMIC viewport units, or a phone's address bar
  // clips the footer off the bottom of the window.
  assert.match(modal, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  assert.match(modal, /max-h-\[min\(88dvh,46rem\)\]/);
  assert.match(modal, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(code(MODAL), /fixed bottom-0/);

  for (const f of folderFiles()) {
    const text = code(f);
    // LOGICAL PROPERTIES ONLY. `ltr:right-2 rtl:left-2` is the same bug as
    // `dir === 'rtl'`: two spellings of one edge, and one of them is wrong in
    // Kurdish the moment somebody edits only the other.
    assert.doesNotMatch(text, /className="[^"]*\b(ml|mr|pl|pr)-[0-9]/, `${f} uses a physical margin`);
    assert.doesNotMatch(text, /\b(ltr|rtl):/, `${f} branches a class on direction`);
    assert.doesNotMatch(text, /\bclass(Name)?="[^"]*\b(left|right)-[0-9]/, `${f} pins a physical edge`);

    // Tailwind v4 here: an arbitrary text size sets FONT-SIZE ONLY, so a
    // `text-[13px]` without a `leading-` inherits whatever line-height the
    // parent had — which on a 13px label under a 16px row is a line that
    // overlaps the one above it.
    for (const line of text.split('\n')) {
      if (!/text-\[[0-9.]+px\]/.test(line)) continue;
      assert.match(line, /leading-/, `${f}: an arbitrary text size with no leading-\n  ${line.trim()}`);
    }
  }
});
