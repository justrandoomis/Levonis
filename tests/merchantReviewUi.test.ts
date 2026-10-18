/**
 * THE MERCHANT APPLICATION'S TWO SCREENS (Community V3 push 1.2, DECISIONS
 * row 257) — the reviewer's «طلبات اعتماد التجار» tab and the applicant's
 * form and tracker at /merchant/start — held to what the owner decided:
 *
 *   - every word in Arabic, English and real Sorani: the three tables have the
 *     same keys, and no `ckb` is a copy of the Arabic (DECISIONS row 183);
 *   - every application state has its own sentence in all three languages,
 *     for the applicant (form, dashboard, workspace pill) and the reviewer;
 *   - the reviewer tab is a hint (`can_review_merchants === true`) mounted
 *     lazily like AdminKyc; decisions wait for the server (no optimistic
 *     state) and the photo is the protected, audited <img>;
 *   - applying sells nothing: no PLUS upsell before the application (C3), no
 *     /subscription link from the store dashboard, «قدّم من جديد» right after
 *     a rejection (C8); the date of birth is a date input with an 18+ bound,
 *     checked in the browser too; nothing is kept in browser storage.
 *
 * Run: node --import tsx --test tests/merchantReviewUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEWER_STRINGS } from '../src/components/merchantApplication/reviewerStrings';
import { APPLICANT_STRINGS } from '../src/components/merchantApplication/applicantStrings';
import { applicationCta, applicationStateWord, approvalReason, type Loc } from '../src/components/merchantApplication/approvalWords';
import { storeStatus } from '../src/components/merchant/shell/status';
import { W } from '../src/components/merchant/shell/strings';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { ageOn, latestAdultDob, namePartOk, socialLinkOk } from '../src/lib/merchantApplication';
import type { ApplicationState, MerchantMe } from '../src/lib/merchant';

const ROOT = join(import.meta.dirname, '..');
/** The source without its comments — comments quote what the code must not do. */
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const STATES: ApplicationState[] = ['draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'rejected', 'withdrawn'];
/** Letters Sorani writes and Arabic does not. */
const SORANI_ONLY = /[ڕڵێۆەڤگچژپ]/;

type Tree = { [k: string]: string | Tree };
function leaves(t: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === 'string') out.set(`${prefix}${k}`, v);
    else for (const [kk, vv] of leaves(v, `${prefix}${k}.`)) out.set(kk, vv);
  }
  return out;
}

function threeLanguages(name: string, table: { ar: unknown; en: unknown; ckb: unknown }) {
  const ar = leaves(table.ar as Tree);
  const en = leaves(table.en as Tree);
  const ckb = leaves(table.ckb as Tree);
  assert.deepEqual([...en.keys()].sort(), [...ar.keys()].sort(), `${name}: en has the Arabic keys`);
  assert.deepEqual([...ckb.keys()].sort(), [...ar.keys()].sort(), `${name}: ckb has the Arabic keys`);
  for (const [k, a] of ar) {
    if (a === '—') continue;
    const c = ckb.get(k)!;
    const e = en.get(k)!;
    assert.ok(c.trim() && e.trim(), `${name}.${k} is written in all three`);
    assert.notEqual(c, a, `${name}.${k}: the Sorani is a copy of the Arabic`);
    assert.notEqual(e, a, `${name}.${k}: the English is the Arabic`);
    if (c.length > 12) assert.match(c, SORANI_ONLY, `${name}.${k}: «${c}» does not read as Sorani`);
  }
  return ar.size;
}

test('the reviewer and applicant words: three languages, same keys, real Sorani', () => {
  assert.ok(threeLanguages('REVIEWER_STRINGS', REVIEWER_STRINGS) > 80);
  assert.ok(threeLanguages('APPLICANT_STRINGS', APPLICANT_STRINGS) > 70);
});

test('every application state has its own sentence, in every language, on every screen', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const r = REVIEWER_STRINGS[lang];
    const a = APPLICANT_STRINGS[lang];
    for (const s of STATES) {
      assert.ok(r.states[s], `reviewer ${lang} ${s}`);
      assert.ok(a.states[s], `applicant ${lang} ${s}`);
      assert.ok(a.explain[s], `applicant ${lang} explains ${s}`);
    }
    assert.ok(a.explain.none);
    assert.equal(new Set(STATES.map((s) => a.states[s])).size, STATES.length, `${lang}: two states share a label`);
  }
  // The applicant reads «قدّم من جديد» after a rejection, in three languages (C8).
  assert.equal(APPLICANT_STRINGS.ar.applyAgain, 'قدّم من جديد');
  assert.equal(APPLICANT_STRINGS.en.applyAgain, 'Apply again');
  assert.match(APPLICANT_STRINGS.ckb.applyAgain, SORANI_ONLY);
  // The reviewer's computed flag, never the KYC values.
  assert.equal(REVIEWER_STRINGS.ar.proIdentity, 'هوية PRO موثّقة');
  assert.equal(REVIEWER_STRINGS.ar.yes, 'نعم');
  assert.equal(REVIEWER_STRINGS.ar.no, 'لا');
  assert.equal(REVIEWER_STRINGS.ar.title, 'طلبات اعتماد التجار');

  // The store dashboard's and the workspace pill's words for the same states.
  const say = (lang: 'ar' | 'en' | 'ckb'): Loc => (ar, en, ckb) => (lang === 'ar' ? ar : lang === 'en' ? en : (ckb ?? `MISSING:${ar}`));
  for (const s of STATES) {
    const words = (['ar', 'en', 'ckb'] as const).map((l) => applicationStateWord(s, say(l)));
    assert.equal(new Set(words).size, 3, `${s}: three different words`);
    assert.ok(!words[2]!.startsWith('MISSING'), `${s}: Sorani written`);
    const app = { state: s, revision: 1, reason_public: s === 'changes_requested' || s === 'rejected' ? 'ADD-A-CLEARER-PHOTO' : '' };
    const reasons = (['ar', 'en', 'ckb'] as const).map((l) => approvalReason(app, say(l)));
    assert.equal(new Set(reasons).size, 3, `${s}: three different reasons`);
    for (const r of reasons) assert.ok(!r.startsWith('MISSING'));
    if (app.reason_public) for (const r of reasons) assert.match(r, /ADD-A-CLEARER-PHOTO/, `${s}: the reviewer's public reason is said`);
    const ctas = (['ar', 'en', 'ckb'] as const).map((l) => applicationCta(app, say(l)));
    assert.equal(new Set(ctas).size, 3);
  }
  assert.ok(!approvalReason(null, say('ckb')).startsWith('MISSING'));
  assert.equal(W.approval.length, 3, 'the pill word in Sorani too');
  assert.equal(W.approvalWhy.length, 3, 'and its sentence');
});

test('every new refusal is written in three languages', () => {
  for (const c of [
    'MERCHANT_REVIEW_FORBIDDEN',
    'APPLICATION_REVISION_REQUIRED',
    'DECISION_REASON_REQUIRED',
    'CAPABILITY_GRANT_TARGET_INVALID',
    'CAPABILITY_GRANT_NOT_NEEDED',
  ]) {
    const s = REFUSAL_STRINGS[c]!;
    assert.ok(s, c);
    assert.notEqual(s.ckb, s.ar, c);
    assert.match(s.ckb, SORANI_ONLY, c);
  }
});

test('the workspace pill: an explicit false is «بانتظار الاعتماد» with the reason; an older answer is not', () => {
  const me = (extra: Partial<MerchantMe>) =>
    ({ store: { status: 'active', merchant: { status: 'active' } }, selling: { canSell: true, reason: '' }, ...extra }) as unknown as MerchantMe;
  const loc: Loc = (ar, en) => en || ar;
  assert.equal(storeStatus(me({})).key, 'open', 'no field from the server: nothing said about approval');
  assert.equal(storeStatus(me({ approved: true })).key, 'open');
  const waiting = storeStatus(me({ approved: false, application: { state: 'changes_requested', revision: 2, reason_public: 'Add a clearer photo' } }));
  assert.equal(waiting.key, 'approval');
  assert.equal(waiting.tone, 'warning');
  assert.match(waiting.reason(loc), /needs merchant approval.*Add a clearer photo/);
  assert.equal(storeStatus(me({ approved: false, application: null })).reason(loc), 'Your store needs merchant approval; follow your application.');
  // A reason is the reviewer's public words only once they asked for changes or refused.
  assert.doesNotMatch(storeStatus(me({ approved: false, application: { state: 'in_review', revision: 1, reason_public: 'stale words' } })).reason(loc), /stale/);
  const ckb: Loc = (_ar, _en, c) => c ?? 'MISSING';
  assert.match(waiting.reason(ckb), SORANI_ONLY);
  // Levonis's own suspension still comes first.
  const suspended = storeStatus({ ...me({ approved: false }), store: { status: 'suspended', merchant: { status: 'active' } } } as unknown as MerchantMe);
  assert.equal(suspended.key, 'suspended');
});

test('the browser checks what it can before the server does: three name parts, a real date, 18+, a social link', () => {
  assert.equal(namePartOk('عبد الله'), true, 'a compound part is one part');
  assert.equal(namePartOk('Abdul Rahman'), true);
  assert.equal(namePartOk('a'), false);
  assert.equal(namePartOk('Zayd3'), false);
  assert.equal(ageOn('2008-10-18', '2026-10-18'), 18);
  assert.equal(ageOn('2008-10-19', '2026-10-18'), 17);
  assert.equal(ageOn('2026-02-30', '2026-10-18'), null);
  assert.equal(ageOn('2030-01-01', '2026-10-18'), null);
  assert.equal(latestAdultDob('2026-10-18'), '2008-10-18');
  assert.equal(latestAdultDob('2028-02-29'), '2010-02-28', 'no 29 February in 2010');
  assert.equal(socialLinkOk('instagram.com/orbit.prints'), true);
  assert.equal(socialLinkOk('https://www.facebook.com/orbitprints'), true);
  assert.equal(socialLinkOk('https://example.com/orbit'), false);
  assert.equal(socialLinkOk('https://instagram.com/'), false);
});

test('Admin: the reviewer tab is a hint, lazily mounted like AdminKyc', () => {
  const admin = code('src/pages/Admin.tsx');
  assert.match(admin, /const AdminMerchantApplications = React\.lazy\(\(\) => import\('\.\.\/components\/merchantApplication\/AdminMerchantApplications'\)\);/);
  assert.match(admin, /const canReviewMerchants = user\?\.can_review_merchants === true;/);
  assert.match(admin, /\.\.\.\(canReviewMerchants\s*\?\s*\[\{ id: 'merchant_applications'/);
  assert.match(admin, /loc\('طلبات اعتماد التجار', 'Merchant applications', 'داواکارییەکانی پەسەندکردنی بازرگان'\)/);
  assert.match(admin, /activeTab === 'merchant_applications' && canReviewMerchants && \(\s*<AdminMerchantApplications \/>/);
});

test('the reviewer screen: decisions wait for the server; the photo is the protected <img>; no money, no browser dialogs', () => {
  const ui = code('src/components/merchantApplication/AdminMerchantApplications.tsx');
  // Not optimistic: the state shown after a decision is the one the answer carries, then the detail is read again.
  const decide = ui.slice(ui.indexOf('const decide = async'), ui.indexOf('const chip ='));
  const call = decide.indexOf('await reviewApi.decide(');
  assert.ok(call > 0, 'the decision is a server call');
  assert.ok(decide.indexOf('res.application.state') > call, 'the shown state comes from the answer');
  assert.ok(decide.indexOf('setDetail(fresh.application)') > call, 'the detail is re-read after the answer');
  assert.ok(!/setDetail\(\{/.test(decide) && !/setRows\(/.test(decide), 'nothing is drawn before the answer');
  assert.match(ui, /revision: app\.revision,\s*operation_id: operationFor\(app, action\)/);
  assert.match(ui, /<img\s+src=\{reviewApi\.photoUrl\(shown\.id\)\}/);
  assert.match(ui, /reason_public: reason, note_internal: noteInternal\.trim\(\)/);
  assert.match(ui, /t\.proIdentity\}: <span className="font-bold">\{shown\.checks\.pro_identity_verified \? t\.yes : t\.no\}/);
  assert.match(ui, /user\?\.is_owner === true && <ReviewerGrants \/>/);
  assert.doesNotMatch(ui, /window\.(confirm|prompt|alert)|\balert\(/);
  assert.doesNotMatch(ui, /wallet|escrow|payout|cost_iqd|finance/i);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
});

test('the applicant screen: no PLUS before applying (C3), honest states, apply again at once (C8), date-only DOB, nothing stored', () => {
  const panel = code('src/components/merchantApplication/MerchantApplicationPanel.tsx');
  const words = JSON.stringify(APPLICANT_STRINGS);
  assert.doesNotMatch(words, /PLUS|اشتراك|subscription|بەشداری/i, 'the application sells no subscription');
  assert.doesNotMatch(panel, /\/subscription|membership_tier|subscription_plan/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|window\.(confirm|prompt|alert)/);
  assert.match(panel, /type="date"/);
  assert.match(panel, /max=\{latestAdultDob\(today\)\}/);
  assert.match(panel, /if \(age < MIN_APPLICANT_AGE\) return t\.underAge;/);
  assert.match(panel, /finished && !editing && answer\.can\?\.apply !== false/, '«قدّم من جديد» right after a rejection or a withdrawal');
  assert.match(panel, /app\?\.reason_public && \(state === 'changes_requested' \|\| state === 'rejected' \|\| state === 'approved'\)/);
  assert.match(panel, /state === 'approved' && \(\s*<button onClick=\{onApproved\}/, 'approved → on to the store setup');
  assert.match(panel, /<Link to="\/settings"/, 'the way to verify the phone (C6)');
  // The private values are typed, never filled from the server, and forgotten once saved.
  assert.doesNotMatch(panel, /setGiven\(app|setDob\(app|setSocial\(app/);
  assert.match(panel, /await applicationApi\.save\(p\);\s*clearPrivate\(\);/);

  const start = code('src/pages/MerchantStart.tsx');
  const gate = start.indexOf('if (me && me.approved !== true)');
  assert.ok(gate > 0, 'the application comes before anything else');
  assert.ok(gate < start.indexOf('if (!me?.eligible)'), 'and before the PLUS gate');
  assert.match(start, /<MerchantApplicationPanel/);
  assert.match(start, /if \(d\.store && d\.approved === true\) navigate\('\/merchant', \{ replace: true \}\);/);

  const dash = code('src/pages/MerchantDashboardPage.tsx');
  assert.doesNotMatch(dash, /\/subscription/, 'the dashboard no longer sends anyone to /subscription');
  // The no-store answer is the application's state, lazily (the frame's byte budget).
  assert.match(dash, /const NoStoreApplication = lazy\(\(\) => import\('\.\.\/components\/merchantApplication\/NoStoreApplication'\)\);/);
  assert.match(dash, /if \(!me\.store\) \{[\s\S]*?<NoStoreApplication me=\{me\} \/>/);
  const card = code('src/components/merchantApplication/NoStoreApplication.tsx');
  assert.doesNotMatch(card, /\/subscription/);
  assert.match(card, /approvalReason\(me\.application, loc\)/);
  assert.match(card, /applicationStateWord\(me\.application\.state, loc\)/);
  assert.match(card, /<Link to="\/merchant\/start"/);
});
