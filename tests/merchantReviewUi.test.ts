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
import { APPLICANT_STRINGS, LIST_SEPARATOR } from '../src/components/merchantApplication/applicantStrings';
import { applicationCta, applicationStateWord, approvalReason, type Loc } from '../src/components/merchantApplication/approvalWords';
import { storeStatus } from '../src/components/merchant/shell/status';
import { W } from '../src/components/merchant/shell/strings';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { ageOn, latestAdultDob, namePartOk, socialLinkOk } from '../src/lib/merchantApplication';
import type { ApplicationState, MerchantMe } from '../src/lib/merchant';
import { parseSocialLink } from '../worker/lib/merchantApproval';

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
    'APPROVAL_REVOKE_STORE_EXISTS',
  ]) {
    const s = REFUSAL_STRINGS[c]!;
    assert.ok(s, c);
    assert.notEqual(s.ckb, s.ar, c);
    assert.match(s.ckb, SORANI_ONLY, c);
  }
});

test('the workspace pill keeps the store\'s REAL state; approval is its own notice beside it, never the pill', () => {
  const me = (extra: Partial<MerchantMe>) =>
    ({ store: { status: 'active', merchant: { status: 'active' } }, selling: { canSell: true, reason: '' }, ...extra }) as unknown as MerchantMe;
  const loc: Loc = (ar, en) => en || ar;
  assert.equal(storeStatus(me({})).key, 'open');
  assert.equal(storeStatus(me({})).approval, null, 'no field from the server: nothing said about approval');
  assert.equal(storeStatus(me({ approved: true })).approval, null);

  // A merchant from before the gate (C1), not approved yet, in every operational state:
  // the pill — and the open/pause switch's word — is the store's own state, and the
  // approval notice rides beside it in every one of them.
  const unapproved = { approved: false, application: null } as Partial<MerchantMe>;
  const cases: Array<[string, Partial<MerchantMe>, string, string]> = [
    ['open', {}, 'open', 'success'],
    ['paused', { store: { status: 'paused', merchant: { status: 'active' } } } as unknown as Partial<MerchantMe>, 'paused', 'warning'],
    ['lapsed', { selling: { canSell: false, reason: 'subscription_inactive' } } as unknown as Partial<MerchantMe>, 'lapsed', 'warning'],
    ['restricted', { store: { status: 'active', merchant: { status: 'restricted' } } } as unknown as Partial<MerchantMe>, 'restricted', 'warning'],
    ['suspended', { store: { status: 'suspended', merchant: { status: 'active' } } } as unknown as Partial<MerchantMe>, 'suspended', 'danger'],
  ];
  for (const [name, extra, key, tone] of cases) {
    const st = storeStatus(me({ ...unapproved, ...extra }));
    assert.equal(st.key, key, `${name}: the operational key comes first`);
    assert.equal(st.tone, tone, `${name}: its own tone`);
    assert.notEqual(st.label, W.approval, `${name}: the pill never reads «بانتظار الاعتماد»`);
    assert.equal(st.approval?.(loc), 'Your store needs merchant approval; follow your application.', `${name}: the approval notice is still there`);
    // The same answer with approval says exactly the same about the store.
    const approved = storeStatus(me({ approved: true, ...extra }));
    assert.equal(approved.key, st.key);
    assert.equal(approved.reason(loc), st.reason(loc), `${name}: the reason is the store's, not the application's`);
    assert.equal(approved.approval, null);
  }
  assert.match(storeStatus(me({ ...unapproved, selling: { canSell: false, reason: 'subscription_inactive' } } as Partial<MerchantMe>)).reason(loc), /PLUS/, 'a lapsed PLUS still says PLUS');

  const waiting = storeStatus(me({ approved: false, application: { state: 'changes_requested', revision: 2, reason_public: 'Add a clearer photo' } }));
  assert.equal(waiting.key, 'open');
  assert.match(waiting.approval!(loc), /needs merchant approval.*Add a clearer photo/);
  // A reason is the reviewer's public words only once they asked for changes or refused.
  assert.doesNotMatch(storeStatus(me({ approved: false, application: { state: 'in_review', revision: 1, reason_public: 'stale words' } })).approval!(loc), /stale/);
  const ckb: Loc = (_ar, _en, c) => c ?? 'MISSING';
  assert.match(waiting.approval!(ckb), SORANI_ONLY);

  // The shell says it in its own notice, with the link to the application; the
  // switch reads the operational label; Today's pulse never sees an approval key.
  const shell = code('src/components/merchant/shell/MerchantShell.tsx');
  assert.match(shell, /status\.approval && \(/);
  assert.match(shell, /data-approval-notice[\s\S]{0,400}data-approval-link[\s\S]{0,80}status\.approval\(loc\)/);
  assert.doesNotMatch(code('src/components/merchant/shell/status.ts'), /key: 'approval'/);
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
  // Revoking an approval (row 257): offered only for an approved application with no store, behind an
  // inline confirmation, and SAID as a revoke so a late reject never revokes.
  assert.match(ui, /const canRevoke = shown\?\.state === 'approved' && shown\.has_store === false;/);
  assert.match(ui, /\{canRevoke && \(\s*<button onClick=\{\(\) => setConfirming\('revoke'\)\}/);
  assert.match(ui, /confirming === 'revoke' \? t\.revokeApprovalConfirm/);
  assert.match(ui, /\.\.\.\(revoke \? \{ revoke: true as const \} : \{\}\)/);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(REVIEWER_STRINGS[lang].revokeApproval.trim());
  assert.equal(REVIEWER_STRINGS.ar.revokeApproval, 'سحب الاعتماد');
  assert.equal(REVIEWER_STRINGS.en.revokeApproval, 'Revoke approval');
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
  assert.match(panel, /saved = \(await applicationApi\.save\(p\)\)\.application;[\s\S]{0,200}?clearPrivate\(\);/);

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

/** The body of one top-level function of a source file (up to the next top-level declaration). */
function fnBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `${signature} not found`);
  const rest = src.slice(at + signature.length);
  const end = rest.search(/\n(?:export default |export )?(?:function|const|interface|type) /);
  return rest.slice(0, end < 0 ? undefined : end);
}

test('C3 at every entry point: a member with no approval is sent to the application, never to /subscription', () => {
  const hub = fnBody(code('src/pages/Community.tsx'), 'function YourStore(');
  assert.match(hub, /const applying = !me\.store && me\.approved === false;/);
  assert.match(hub, /if \(!me\.store && !applying && !me\.eligible\) return null;/, 'the plan gates only the store, never the application');
  assert.match(hub, /applicationCta\(me\.application, loc\)/);
  assert.doesNotMatch(hub, /\/subscription/);

  const onlooker = fnBody(code('src/pages/community/Request.tsx'), 'function OnlookerCard(');
  assert.match(onlooker, /href="\/merchant\/start"/);
  assert.match(onlooker, /applicationCta\(/);
  assert.doesNotMatch(onlooker, /\/subscription|aboutPlus|me\?\.eligible/);

  const cta = code('src/components/merchant/StoreCta.tsx');
  assert.match(cta, /const applying = !me\.store && me\.approved === false;/);
  assert.match(cta, /if \(!me\.eligible && !me\.store && !applying\) return null;/);
  assert.match(cta, /applying \? applicationCta\(me\.application, loc\)/);
});

test('the applicant form keeps what was typed: a photo upload or a withdrawal never refills the fields from the server', () => {
  const panel = code('src/components/merchantApplication/MerchantApplicationPanel.tsx');
  assert.match(panel, /\(next: ApplicantAnswer, refill = true\) => \{\s*setAnswer\(next\);\s*if \(refill\) fillFrom\(next\.application\);/);
  const upload = panel.slice(panel.indexOf('async function uploadPhoto('), panel.indexOf('async function withdraw('));
  assert.match(upload, /await applicationApi\.photo\(file\);\s*await reload\(false\);/);
  assert.doesNotMatch(upload, /await reload\(\);/);
  const withdraw = panel.slice(panel.indexOf('async function withdraw('), panel.indexOf('if (!answer && loadError)'));
  assert.match(withdraw, /await reload\(false\);/);
});

test('save and send: a failed re-read never turns a done save or send into a failure, and send submits what save answered', () => {
  const panel = code('src/components/merchantApplication/MerchantApplicationPanel.tsx');
  const save = panel.slice(panel.indexOf('async function save()'), panel.indexOf('async function send()'));
  assert.match(save, /Promise<ApplicantView \| null>/);
  // «saved» is said, and the private fields cleared, BEFORE the re-read — which has its own try.
  assert.ok(save.indexOf('setInfo(t.saved)') < save.indexOf('await reload()'));
  assert.match(save, /try \{\s*await reload\(\);\s*\} catch \{/);
  const send = panel.slice(panel.indexOf('async function send()'), panel.indexOf('async function uploadPhoto('));
  assert.match(send, /const current = await save\(\);/);
  assert.doesNotMatch(send, /applicationApi\.get\(/, 'no second, unguarded read');
  assert.match(send, /try \{\s*await reload\(\);\s*\} catch \{/);
});

test('a refused field is NAMED in three languages, lists join in the reader\'s own comma, and the browser checks the link as the server does', () => {
  const panel = code('src/components/merchantApplication/MerchantApplicationPanel.tsx');
  assert.match(panel, /e\.code === 'APPLICATION_FIELD_INVALID' \? e\.details\?\.field/);
  assert.match(panel, /names\.join\(LIST_SEPARATOR\[lang\] \?\? LIST_SEPARATOR\.ar\)/);
  assert.doesNotMatch(panel, /join\('، '\)/);
  assert.deepEqual(LIST_SEPARATOR, { ar: '، ', en: ', ', ckb: '، ' });
  // Every field the server can name in APPLICATION_FIELD_INVALID has a label in every language.
  const server = readFileSync(join(ROOT, 'worker/routes/merchantApplication.ts'), 'utf8');
  const named = [...new Set([...server.matchAll(/fieldInvalid\('([a-z_]+)'\)|, '([a-z_]+)', \d+\)/g)].map((m) => m[1] ?? m[2]))];
  for (const f of ['legal_name', 'dob', 'social_link', 'governorate', 'activity_kind', 'activity_description', 'public_name', 'public_bio', 'public_links']) {
    assert.ok(named.includes(f), `the server names ${f}`);
  }
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(APPLICANT_STRINGS[lang].fieldInvalid.trim());
    for (const f of named) assert.ok(APPLICANT_STRINGS[lang].missingNames[f], `${lang}: no label for ${f}`);
  }
  assert.notEqual(APPLICANT_STRINGS.ckb.fieldInvalid, APPLICANT_STRINGS.ar.fieldInvalid);
  for (const f of named) assert.notEqual(APPLICANT_STRINGS.ckb.missingNames[f], APPLICANT_STRINGS.ar.missingNames[f], `ckb.${f} copies the Arabic`);

  // PARITY: the browser's link check and the server's agree on every case.
  const cases = [
    'instagram.com/orbit.prints',
    'https://www.instagram.com/orbit.prints',
    'http://m.instagram.com/orbit',
    'https://www.facebook.com/orbitprints',
    'https://web.facebook.com/orbitprints/',
    'https://fb.com/orbit',
    'https://m.fb.com/x',
    'https://web.instagram.com/x',
    'https://user@instagram.com/x',
    'https://user:pw@facebook.com/x',
    'https://instagram.com:8443/x',
    'https://instagram.com/',
    'https://example.com/orbit',
    'ftp://instagram.com/x',
    'javascript:alert(1)',
    '',
  ];
  for (const c of cases) assert.equal(socialLinkOk(c), parseSocialLink(c) !== null, `browser and server disagree on «${c}»`);
});

test('AdminKyc: a refusal reads in the admin\'s language by its code, and no admin is offered a decision on their own case', () => {
  const kyc = code('src/components/AdminKyc.tsx');
  assert.doesNotMatch(kyc, /\(err as Error\)\?\.message/, 'a raw «Arabic / English» server sentence');
  assert.match(kyc, /const failure = \(err: unknown\) => apiRefusal\(err, refusalLang\(lang\), t\.actionError\);/);
  assert.match(kyc, /r\.state === 'pending' && r\.user_id !== viewerId && \(/);
  assert.match(kyc, /shownCase\.state === 'reviewing'\) && shownCase\.user_id !== viewerId && \(/);
  assert.match(kyc, /ownRequest: 'ئەمە داواکاریی خۆتە؛ بەڕێوەبەرێکی تر بڕیاری لەسەر دەدات\.'/);
  assert.equal(REFUSAL_STRINGS.SELF_DECISION_FORBIDDEN.ckb === REFUSAL_STRINGS.SELF_DECISION_FORBIDDEN.ar, false);
});
