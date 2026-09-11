/**
 * Printer Farm client — what the game pages are allowed to say and do.
 *
 * Static checks in the subscriptionPage.test.ts style: they read the source
 * the way a reviewer would. The owner's rules pinned here — nothing shown to a
 * player is fabricated, no browser dialogs, every string in three languages,
 * every route the pages name exists, Levonis Points are never touched — are
 * the ones a hurried edit breaks first. The pure helpers (formatting, room
 * geometry, allocation rules, error mapping) are exercised directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { FARM_STRINGS, type FarmStrings } from '../src/pages/farm/strings';
import {
  bidiToken,
  colorSwatch,
  countdown,
  formatCoins,
  formatSignedCoins,
  formatVolume,
  gameDuration,
  leaderboardScore,
  FSI,
  PDI,
  printerName,
  progressFraction,
  starsFromBp,
} from '../src/pages/farm/format';
import { at, gridFor, iso, roomLayout, WALL_H } from '../src/pages/farm/room/iso';
import { compatibleSpools, deadlineRisk, estimateGameSeconds, fits, gramsForQty, offerUrgency, printerFit, remainingQty } from '../src/pages/farm/rules';
import { groupEvents } from '../src/pages/farm/events';
import { capLabel, collectNotice, signedStars } from '../src/pages/farm/collect';
import { farmErrorText, isStateChanged } from '../src/pages/farm/errors';
import { ApiError } from '../src/lib/api';
import {
  batchEnded,
  collectResultOf,
  dailyJobs,
  isFarmState,
  printerCatalog,
  productByKey,
  reputationGainBp,
  statValue,
  type FarmJob,
  type FarmPrinter,
  type FarmProductDef,
  type PublicFarmConfig,
} from '../src/lib/farmApi';
import { nameOf, swatchFor } from '../src/pages/farm/format';

/** A duration with its bidi isolates stripped — what a reader sees, in logical order. */
const plain = (s: string) => s.replace(/[\u2068\u2069]/g, '');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const gameFiles = () => [
  ...walk('src/pages/farm'),
  ...walk('src/pages/games'),
  'src/pages/Games.tsx',
  'src/pages/Leaderboards.tsx',
  'src/lib/farmApi.ts',
];
const allSource = () => gameFiles().map((f) => `// ${f}\n${read(f)}`).join('\n');

// ------------------------------------------------------------ fake copy gone

test('the four fabricated games, the stock imagery and every "coming soon" are gone', () => {
  const src = allSource();
  const banned = [
    'SPEED RACER',
    'ALIENS ATTACK',
    'BIRDS RUSH',
    'SLICE FRUIT',
    'unsplash',
    'dicebear',
    'Impact',
    'Coming soon',
    'coming soon',
    'قريباً',
    'بەم زووانە',
    'daily game tickets',
    'تذاكر ألعاب',
    'aria-disabled="true"',
    ">tribe<",
  ];
  for (const phrase of banned) {
    assert.equal(src.includes(phrase), false, `placeholder copy is back: "${phrase}"`);
  }
  // The Profile's invented membership benefit is gone too.
  const profile = read('src/pages/Profile.tsx');
  assert.equal(profile.includes('Free daily game tickets'), false);
  assert.equal(profile.includes('isPro ? 5 : 3'), false);
  assert.match(profile, /to: '\/games\/printer-farm'/, 'the coins tile leads to the farm');
});

test('no browser dialogs, no canvas, no WebGL, no banned renderer, no recharts in the game chunk', () => {
  const src = allSource();
  assert.equal(/window\.(confirm|alert|prompt)\(/.test(src), false, 'no browser dialogs');
  assert.equal(/\balert\(/.test(src), false, 'no alert()');
  assert.equal(src.includes('<canvas'), false, 'no canvas');
  for (const mod of ["from 'three'", "from 'ogl'", "from 'recharts'", "from 'gsap'", '@react-three']) {
    assert.equal(src.includes(mod), false, `${mod} must not enter the farm chunk`);
  }
});

test('Levonis Points are never touched by the game client', () => {
  const src = allSource();
  for (const phrase of ['/api/wallet', 'refreshWallet', 'useWallet', "'POINT'", '/api/rewards', 'pointBalance']) {
    assert.equal(src.includes(phrase), false, `the game client reaches the points system: ${phrase}`);
  }
  // The redeem page has no conversion action at all.
  const redeem = read('src/pages/games/GameRedeem.tsx');
  assert.equal(/farmApi\.(redeem|convert)/.test(redeem), false);
  assert.equal(/api\.post\(/.test(redeem), false, 'the redeem page posts nothing');
  assert.match(redeem, /enabled === true/, 'conversion is shown open only when the server says enabled');
});

// ----------------------------------------------------------------- strings

function keyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...keyPaths(v, p));
    else out.push(p);
  }
  return out.sort();
}

test('every string exists in ar, en and ckb with the same shape and no empty value', () => {
  const en = keyPaths(FARM_STRINGS.en);
  assert.deepEqual(keyPaths(FARM_STRINGS.ar), en, 'ar differs from en');
  assert.deepEqual(keyPaths(FARM_STRINGS.ckb), en, 'ckb differs from en');
  assert.ok(en.length > 200, `expected a full table, found ${en.length} keys`);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const table = FARM_STRINGS[lang] as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(table)) {
      if (typeof v === 'function') {
        const out = (v as (...a: never[]) => string)(...([3, 'x', 4, 5] as never[]));
        assert.ok(typeof out === 'string' && out.length > 0, `${lang}.${k}() returned an empty string`);
      } else if (typeof v === 'string') {
        assert.ok(v.length > 0, `${lang}.${k} is empty`);
      } else {
        for (const [kk, vv] of Object.entries(v as Record<string, string>)) {
          assert.ok(typeof vv === 'string' && vv.length > 0, `${lang}.${k}.${kk} is empty`);
        }
      }
    }
  }
  // Sorani is written, not copied from Arabic wholesale.
  const same = (Object.keys(FARM_STRINGS.en) as Array<keyof FarmStrings>).filter(
    (k) => typeof FARM_STRINGS.ar[k] === 'string' && FARM_STRINGS.ar[k] === FARM_STRINGS.ckb[k]
  );
  assert.ok(same.length < 8, `too many ckb strings are identical to ar: ${same.join(', ')}`);
});

test('every error code the contract names has a sentence in all three languages', () => {
  const codes = [
    'OFFER_EXPIRED',
    'PRINTER_INCOMPATIBLE_MATERIAL',
    'PRINTER_NO_MULTICOLOR',
    'PART_TOO_LARGE',
    'SPOOL_MISMATCH',
    'SPOOL_INSUFFICIENT',
    'PRINTER_UNAVAILABLE',
    'QTY_MISMATCH',
    'FARM_INSUFFICIENT_COINS',
    // and the codes the engine actually throws
    'INSUFFICIENT_COINS',
    'TOO_MANY_ACTIVE_JOBS',
    'LEVEL_TOO_LOW',
    'JOB_NOT_OFFERED',
    'JOB_NOT_ACTIVE',
    'NOTHING_TO_COLLECT',
    'PRINT_NOT_FINISHED',
    'NO_FREE_SLOT',
    'STORAGE_FULL',
    'PRINTER_BUSY',
    'CONFLICT_RETRY',
    // the 409s the routes added: a moved row, a locked feature, a reused key, the last printer
    'STATE_CHANGED',
    'FEATURE_LOCKED',
    'IDEMPOTENCY_KEY_REUSED',
    'LAST_PRINTER',
  ];
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const c of codes) assert.ok(FARM_STRINGS[lang].errors[c], `${lang}.errors.${c} missing`);
  }
  const s = FARM_STRINGS.en;
  assert.equal(farmErrorText(new ApiError(409, 'x', 'OFFER_EXPIRED'), s), s.errors.OFFER_EXPIRED);
  assert.equal(farmErrorText(new ApiError(429, 'Too many'), s), s.errors.RATE_LIMITED);
  assert.equal(farmErrorText(new ApiError(400, 'Server said so', 'SOMETHING_NEW'), s), 'Server said so', 'an unknown code shows the server message');
  assert.equal(farmErrorText(new Error('boom'), s), s.errGeneric);
});

test('STATE_CHANGED is retried once after a fresh state; FEATURE_LOCKED names the level; a reused key is a refusal', () => {
  const s = FARM_STRINGS.en;
  // FEATURE_LOCKED { min_level } → "Unlocks at level N" in the UI language; without the detail, the generic sentence.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const t = FARM_STRINGS[lang];
    assert.equal(farmErrorText(new ApiError(409, 'locked', 'FEATURE_LOCKED', { min_level: 3 }), t), t.lockedLevel(3));
    assert.equal(farmErrorText(new ApiError(409, 'locked', 'FEATURE_LOCKED'), t), t.errors.FEATURE_LOCKED);
    assert.equal(farmErrorText(new ApiError(409, 'moved', 'STATE_CHANGED'), t), t.errors.STATE_CHANGED);
    assert.equal(farmErrorText(new ApiError(409, 'reused', 'IDEMPOTENCY_KEY_REUSED'), t), t.errors.IDEMPOTENCY_KEY_REUSED);
  }
  assert.match(s.errors.STATE_CHANGED, /Your farm changed, please try again/);
  assert.equal(isStateChanged(new ApiError(409, 'x', 'STATE_CHANGED')), true);
  assert.equal(isStateChanged(new ApiError(409, 'x', 'CONFLICT_RETRY')), false);
  assert.equal(isStateChanged(new ApiError(400, 'x', 'STATE_CHANGED')), false, 'only the 409');
  // The hook: one retry, after `await reload()`, with a fresh key (the old one is deleted first); nothing else is retried.
  const hook = read('src/pages/farm/hooks/useFarmState.ts');
  assert.match(hook, /for \(let attempt = 0; ; attempt\+\+\)/, 'the intent loop');
  assert.match(hook, /keys\.current\.delete\(actionId\);\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(attempt === 0 && isStateChanged\(e\)\) \{\s*await reload\(\);\s*continue;/, 'STATE_CHANGED: key dropped, state re-read, one more attempt');
  assert.equal((hook.match(/continue;/g) || []).length, 1, 'exactly one retry path');
  assert.match(hook, /if \(network\) return \{ ok: false, error: e \};/, 'a network failure keeps its key and is not auto-retried');
  const hookCode = hook.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.equal(hookCode.includes('IDEMPOTENCY_KEY_REUSED'), false, 'a reused key is an ordinary refusal: shown, then the state is re-read like any other');
});

// ---------------------------------------------------------- collect result

/** The collect body as worker/routes/farm.ts answers it (§4, §9a), state fields elided. */
const collectBody = (over: Record<string, unknown>) => ({
  success: true,
  replayed: false,
  now: '2026-09-07T10:00:00.000Z',
  printer_id: 'fp_1',
  collected: { assignment_id: 'fa_1', job_id: 'fjob_1', qty: 3, outcome: 'done', failure_kind: null },
  delivered: null,
  payout_deferred: null,
  ...over,
});
const PAID = { job_id: 'fjob_1', reward_coins: 1250, late: false, reputation_delta_bp: 150, reputation_bp: 150, xp_gained: 40, level: 1, level_up: false };

test('collectResultOf reads the server\'s collect fields and refuses a body without them', () => {
  const r = collectResultOf(collectBody({ delivered: PAID }));
  assert.ok(r, 'a collect body is recognised');
  assert.equal(r.printer_id, 'fp_1');
  assert.equal(r.collected.qty, 3);
  assert.equal(r.collected.outcome, 'done');
  assert.equal(r.delivered?.reward_coins, 1250);
  assert.equal(r.payout_deferred, null);
  assert.equal(r.replayed, false);
  assert.equal(collectResultOf(collectBody({ replayed: true }))?.replayed, true);
  // A malformed delivered / deferred block is treated as "not sent", never as a payment.
  assert.equal(collectResultOf(collectBody({ delivered: { job_id: 'x' } }))?.delivered, null);
  assert.equal(collectResultOf(collectBody({ payout_deferred: { reward_coins: 5 } }))?.payout_deferred, null);
  // Any other mutation body (an accept, a state) carries no collect result.
  assert.equal(collectResultOf({ success: true, now: 'x', profile: {}, printers: [] }), null);
  assert.equal(collectResultOf(collectBody({ collected: { assignment_id: 'a' } })), null);
  assert.equal(collectResultOf(null), null);
  assert.equal(collectResultOf('nope'), null);
});

test('the collect notice: paid renders the server\'s amount and reputation, deferred names the cap, failed names the kind, replayed pays nothing — in all three languages', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = FARM_STRINGS[lang];
    const paid = collectNotice(collectResultOf(collectBody({ delivered: PAID }))!, s, lang);
    assert.equal(paid.kind, 'paid');
    assert.equal(paid.tone, 'gold');
    assert.ok(plain(paid.text).includes('+1,250'), `${lang}: the paid note carries the server's reward: ${paid.text}`);
    assert.ok(plain(paid.text).includes('+0.15★'), `${lang}: and the reputation delta: ${paid.text}`);
    assert.equal(paid.text, s.collectPaid(`\u2068${formatCoins(1250, lang)}\u2069`, '\u2068+0.15\u2069'));
    assert.equal(paid.detail, null);
    assert.equal(paid.printer_id, 'fp_1');
    assert.equal(paid.job_id, 'fjob_1');

    const late = collectNotice(collectResultOf(collectBody({ delivered: { ...PAID, late: true, reputation_delta_bp: -100, level: 2, level_up: true } }))!, s, lang);
    assert.equal(late.kind, 'paid');
    assert.ok(plain(late.text).includes('−0.10★'), `${lang}: a late delivery shows the penalty: ${late.text}`);
    assert.equal(late.text, s.collectPaidLate(`\u2068${formatCoins(1250, lang)}\u2069`, '\u2068−0.10\u2069'));
    assert.equal(late.detail, s.collectLevelUp(2));

    for (const reason of ['daily_jobs_cap', 'daily_coins_cap'] as const) {
      const deferred = collectNotice(collectResultOf(collectBody({ payout_deferred: { job_id: 'fjob_1', reward_coins: 980, day: '2026-09-07', late: false, reason } }))!, s, lang);
      assert.equal(deferred.kind, 'deferred');
      assert.equal(deferred.tone, 'amber');
      assert.ok(plain(deferred.text).includes('980'), `${lang}: the deferred note carries the coins that will arrive: ${deferred.text}`);
      const cap = reason === 'daily_jobs_cap' ? s.capJobs : s.capCoins;
      assert.ok(deferred.text.includes(cap), `${lang}: the deferred note names the ${reason}: ${deferred.text}`);
      assert.equal(capLabel(reason, s), cap);
    }
    // The two cap sentences differ — the player learns WHICH cap held the coins.
    assert.notEqual(s.capJobs, s.capCoins);

    const failed = collectNotice(collectResultOf(collectBody({ collected: { assignment_id: 'fa_1', job_id: 'fjob_1', qty: 2, outcome: 'failed', failure_kind: 'spaghetti' } }))!, s, lang);
    assert.equal(failed.kind, 'failed');
    assert.equal(failed.tone, 'amber');
    assert.ok(s.failureKinds.spaghetti, `${lang}: the failure kind has a label`);
    assert.ok(failed.text.includes(s.failureKinds.spaghetti), `${lang}: the failed note names what failed: ${failed.text}`);
    assert.equal(/\d/.test(failed.text.replace('2', '')), false, `${lang}: a failed batch invents no coins figure`);
    // An unknown kind is shown as the server sent it, not hidden.
    const odd = collectNotice(collectResultOf(collectBody({ collected: { assignment_id: 'fa_1', job_id: 'fjob_1', qty: 2, outcome: 'failed', failure_kind: 'new_kind' } }))!, s, lang);
    assert.ok(odd.text.includes('new_kind'));

    const replayed = collectNotice(collectResultOf(collectBody({ replayed: true, delivered: PAID }))!, s, lang);
    assert.equal(replayed.kind, 'replayed');
    assert.equal(replayed.tone, 'zinc');
    assert.equal(replayed.text, s.collectReplayed);
    assert.equal(/\d/.test(replayed.text), false, `${lang}: a replay claims no amount`);

    const parts = collectNotice(collectResultOf(collectBody({}))!, s, lang);
    assert.equal(parts.kind, 'parts');
    assert.equal(parts.text, s.collectPartsOnly(3));
    assert.ok(/3/.test(parts.text));
  }
  assert.equal(signedStars(150), '+0.15');
  assert.equal(signedStars(-100), '−0.10');
  assert.equal(signedStars(0), '+0.00');
  // Latin digits in every language, and the money token isolated for bidi.
  const ar = collectNotice(collectResultOf(collectBody({ delivered: PAID }))!, FARM_STRINGS.ar, 'ar');
  assert.equal(/[٠-٩]/.test(ar.text), false);
  assert.ok(ar.text.includes(`${FSI}1,250${PDI}`), 'the coins token is FSI…PDI isolated');
});

test('the shell shows the collect result in a live region, the sheet repeats it, jobs with a deferred payout wear a badge', () => {
  const shell = read('src/pages/farm/PrinterFarm.tsx');
  assert.match(shell, /aria-live="polite" data-farm-notice="collect"/, 'one live region for the collect result');
  assert.match(shell, /collectResultOf\(res\)/, 'the result is read from the server answer');
  assert.match(shell, /collectNotice\(lastCollect, s, lang\)/, 'worded at render time in the current language');
  assert.match(shell, /onCollected=\{onCollected\}/);
  assert.match(shell, /lastCollect=\{collectNote\}/, 'the printer sheet gets the notice');
  const farmView = read('src/pages/farm/views/FarmView.tsx');
  assert.match(farmView, /if \(r\.ok\) onCollected\(r\.result\);/, 'the card\'s Collect hands the answer up');
  const sheet = read('src/pages/farm/sheets/PrinterSheet.tsx');
  assert.match(sheet, /else onCollected\(r\.result\);/, 'the sheet\'s Collect hands the answer up');
  assert.match(sheet, /lastCollect\.printer_id === p\.id && <CollectNote/, 'and repeats the notice for this machine only');
  const note = read('src/pages/farm/CollectNote.tsx');
  assert.match(note, /<Note tone=\{notice\.tone\}/, 'the house Note, not a toast');
  assert.match(note, /min-w-\[44px\] min-h-\[44px\]/, 'a 44px close control');
  assert.equal(/toast|sonner|notistack/i.test(note), false);
  const jobs = read('src/pages/farm/views/JobsView.tsx');
  assert.match(jobs, /job\.payout_deferred_day && \(\s*<Chip[^>]*data-farm-payout-pending/, 'the active card badges a deferred payout');
  assert.match(jobs, /s\.payoutPending\b/);
  assert.match(read('src/pages/farm/sheets/JobSheet.tsx'), /data-farm-payout-pending/);
  const api = read('src/lib/farmApi.ts');
  assert.match(api, /api\.post<CollectResponse>/, 'collect is typed with its result');
  assert.match(api, /payout_deferred: PayoutDeferred \| null/);
  assert.match(api, /payout_deferred_day\?: string \| null/, 'the job carries the deferred day');
  // The hook hands the answer back for reading only; the state still comes from apply().
  const hook = read('src/pages/farm/hooks/useFarmState.ts');
  assert.match(hook, /return \{ ok: true, result: res \};/);
});

// -------------------------------------------------------------- formatting

test('coins are grouped integers in Latin digits in every language', () => {
  assert.equal(formatCoins(1500, 'en'), '1,500');
  assert.equal(formatCoins(1500, 'ar'), '1,500');
  assert.equal(formatCoins(1500, 'ckb'), '1,500');
  assert.equal(formatCoins(1500.7, 'en'), '1,500', 'never a fraction of a coin');
  assert.equal(formatSignedCoins(120, 'en'), '+120');
  assert.equal(formatSignedCoins(-45, 'en'), '−45');
  assert.equal(/[٠-٩]/.test(formatCoins(123456, 'ar')), false, 'no Arabic-Indic digits');
});

test('game-time reads "4h 32m"; countdowns read mm:ss under an hour', () => {
  assert.equal(plain(gameDuration(4 * 3600 + 32 * 60, 'en')), '4h 32m');
  assert.equal(plain(gameDuration(4 * 3600 + 32 * 60, 'ar')), '4س 32د');
  assert.equal(plain(gameDuration(45, 'en')), '45s');
  assert.equal(plain(gameDuration(3600, 'en')), '1h');
  assert.equal(plain(gameDuration(3 * 86400 + 2 * 3600, 'en')), '3d 2h');
  assert.equal(countdown(12 * 60_000 + 34_000, 'en'), '12:34');
  assert.equal(plain(countdown(65 * 60_000, 'en')), '1h 05m');
  assert.equal(countdown(-5000, 'en'), '0:00', 'a passed instant never goes negative');
  assert.equal(starsFromBp(4200), '4.20');
  assert.equal(starsFromBp(9999), '5.00');
});

test('durations are bidi-safe: every number+unit token is isolated (FSI…PDI); mm:ss countdowns are left alone', () => {
  assert.equal(FSI, '\u2068', 'first-strong: an Arabic unit makes an RTL island, a Latin unit an LTR one');
  assert.equal(PDI, '\u2069');
  assert.equal(bidiToken(18, 'د'), '\u206818د\u2069');
  // Arabic: "1س 18د" as two isolates around a plain space — the mix that came out "1د18 س" in a dir="ltr" cell.
  // (Measured in Chromium: FSI draws each token as "س1" / "د18" whatever the cell's direction; an LRI would draw "1س".)
  const ar = gameDuration(3600 + 18 * 60, 'ar');
  assert.ok(ar.includes('\u2068') && ar.includes('\u2069'), `ar duration carries the isolates: ${JSON.stringify(ar)}`);
  assert.equal(ar, '\u20681س\u2069 \u206818د\u2069');
  assert.equal(gameDuration(45, 'ar'), '\u206845ث\u2069');
  assert.equal(gameDuration(3 * 86400 + 2 * 3600, 'ckb'), '\u20683ڕ\u2069 \u20682ک\u2069');
  assert.equal(countdown(65 * 60_000 + 5_000, 'ar'), '\u20681س\u2069 \u206805د\u2069');
  assert.equal(countdown(2 * 86400_000 + 3 * 3600_000, 'ar'), '\u20682ي\u2069 \u20683س\u2069');
  // Every isolate is closed, and each holds exactly one number+unit.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const v of [30, 90, 3600, 4 * 3600 + 32 * 60, 3 * 86400]) {
      const out = gameDuration(v, lang);
      assert.equal((out.match(/\u2068/g) || []).length, (out.match(/\u2069/g) || []).length, `balanced isolates in ${JSON.stringify(out)}`);
      for (const tok of out.match(/\u2068[^\u2068\u2069]*\u2069/g) || []) assert.match(tok, /^\u2068\d+\S\u2069$/, `one number+unit per isolate: ${JSON.stringify(tok)}`);
    }
  }
  // Under an hour a countdown is digits and a colon — direction-neutral, no isolates.
  assert.equal(countdown(12 * 60_000 + 34_000, 'ar'), '12:34');
  assert.equal(/[\u2068\u2069]/.test(countdown(59 * 60_000, 'ckb')), false);
  // The cells that carry these durations inherit the page direction — no dir="ltr" around a unit letter.
  for (const f of ['src/pages/farm/views/JobsView.tsx', 'src/pages/farm/views/FarmView.tsx', 'src/pages/farm/sheets/PrinterSheet.tsx', 'src/pages/farm/sheets/JobSheet.tsx', 'src/pages/farm/room/Room.tsx']) {
    const src = read(f);
    for (const m of src.matchAll(/<(dd|span|p)\b([^>]*)>\s*\{[^<]*(?:gameDuration|countdown)\(/g)) {
      assert.equal(/dir="ltr"/.test(m[2]), false, `${f}: a duration cell forces dir="ltr": ${m[0].slice(0, 80)}`);
    }
    assert.match(src, /data-farm-duration=/, `${f} marks its duration cells for the bidi probe`);
  }
  // Build volumes get a break opportunity after each "×", so a narrow column wraps instead of cutting to "180×180×…".
  assert.equal(formatVolume([180, 180, 180]), '180×\u200B180×\u200B180');
});

test('the reputation board score is ALWAYS basis points — a score of 5 is 0.01★, never five stars', () => {
  const s = FARM_STRINGS.en;
  assert.equal(leaderboardScore('reputation', 5, 'en', s), '0.01★');
  assert.equal(leaderboardScore('reputation', 4200, 'en', s), '4.20★');
  assert.equal(leaderboardScore('reputation', 0, 'ar', s), '0.00★');
  assert.equal(leaderboardScore('reputation', 5000, 'ckb', s), '5.00★');
  assert.equal(leaderboardScore('farm_value', 12500, 'en', s), '12,500');
  assert.equal(leaderboardScore('jobs_delivered', 1, 'en', s), s.lbJobs(1));
  const page = read('src/pages/Leaderboards.tsx');
  assert.match(page, /leaderboardScore\(board, row\.score, lang, s\)/);
  assert.equal(/score > 5|score <= 5|formatStars\(score\)/.test(page), false, 'no magnitude guess about the unit');
  // The segment labels fit a third of a 360px screen in every language.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const t = FARM_STRINGS[lang];
    for (const k of ['lbBoardReputation', 'lbBoardFarmValue', 'lbBoardJobs'] as const) assert.ok(t[k].length <= 12, `${lang}.${k} "${t[k]}" is too long for a segment`);
  }
});

test('a nameless printer is named "<model> <slot+1>" at every naming site', () => {
  const p: FarmPrinter = printer({ nickname: '' });
  assert.equal(printerName(p, CONFIG, 'en'), 'A1 mini 1');
  assert.equal(printerName({ ...p, slot: 2 }, CONFIG, 'ar'), 'A1 mini 3');
  assert.equal(printerName({ ...p, nickname: '   ' }, CONFIG, 'ckb'), 'A1 mini 1', 'whitespace is not a name');
  assert.equal(printerName({ ...p, model_key: 'nope' }, CONFIG, 'en'), 'nope 1', 'an unknown model falls back to its key');
  assert.equal(printerName(printer(), CONFIG, 'en'), 'Line one', 'a nickname wins');
  // Every place a machine is named goes through printerName; nothing prints a raw nickname.
  const sites = ['src/pages/farm/views/FarmView.tsx', 'src/pages/farm/room/Room.tsx', 'src/pages/farm/sheets/PrinterSheet.tsx', 'src/pages/farm/sheets/JobSheet.tsx', 'src/pages/farm/views/InventoryView.tsx'];
  for (const f of sites) assert.match(read(f), /printerName\(/, `${f} names machines through printerName`);
  for (const f of gameFiles()) {
    const src = read(f);
    for (const bad of [/\{(?:p|printer)\.nickname\}/, /openPrinter\((?:p|printer)\.nickname\)/, /label=\{(?:p|printer)\.nickname\}/, /sellBody\((?:p|printer)\.nickname/]) {
      assert.equal(bad.test(src), false, `${f} renders a raw nickname: ${bad}`);
    }
  }
  // The only raw reads left are the rename form's own value and the helper itself.
  const rawReads = gameFiles().flatMap((f) => [...read(f).matchAll(/[^\n]*\.nickname\b[^\n]*/g)].map((m) => `${f}: ${m[0].trim()}`));
  for (const line of rawReads) {
    assert.ok(
      /format\.ts: .*p\.nickname \?\? ''/.test(line) || /PrinterSheet\.tsx: .*(setNickname\(p\.nickname\)|next === p\.nickname|p\?\.nickname)/.test(line),
      `unexpected raw nickname read: ${line}`
    );
  }
  const sheet = read('src/pages/farm/sheets/PrinterSheet.tsx');
  assert.match(sheet, /label=\{displayName\} labelledBy=\{titleId\}/, 'the dialog is labelled by the heading that carries the display name');
  assert.match(sheet, /<h3 id=\{titleId\}[^>]*>\s*\{displayName\}/);
  assert.match(read('src/pages/farm/room/Room.tsx'), /aria-label=\{`\$\{s\.openPrinter\(name\)\}/);
});

test('the Overlay merges the caller\'s panel ref with its own, so a phone Sheet still takes initial focus', () => {
  const overlay = read('src/components/ui/Overlay.tsx');
  assert.equal(overlay.includes('{...panelMotion}'), false, 'the raw spread would override the panel ref');
  assert.match(overlay, /const \{ ref: callerRef, \.\.\.panelMotionRest \} = panelMotion \?\? \{\};/);
  assert.match(overlay, /panelRef\.current = el;\s*callerRef\?\.\(el\);/, 'one callback sets both refs');
  const refAt = overlay.indexOf('ref={setPanel}');
  const spreadAt = overlay.indexOf('{...panelMotionRest}');
  assert.ok(refAt > 0 && spreadAt > refAt, 'the spread follows the merged ref and carries no ref of its own');
  assert.match(overlay, /if \(open\) panelRef\.current\?\.focus\(\{ preventScroll: true \}\);/, 'initial focus still goes to the panel');
  assert.match(overlay, /const panelMotion = m\.reduced\s*\?\s*undefined/, 'reduced motion still drops the drag');
  assert.match(overlay, /ref: measure,/, 'the Sheet still measures its panel through the merged ref');
});

test('tab labels stay short, locked tabs are tappable (aria-disabled, never disabled) and explain themselves', () => {
  for (const k of ['tabFarm', 'tabJobs', 'tabMarket', 'tabInventory', 'tabStore', 'tabUpgrades'] as const) {
    assert.ok(FARM_STRINGS.en[k].length <= 9, `en.${k} "${FARM_STRINGS.en[k]}" exceeds 9 characters`);
    for (const lang of ['ar', 'ckb'] as const) assert.ok(FARM_STRINGS[lang][k].length <= 9, `${lang}.${k} "${FARM_STRINGS[lang][k]}" exceeds 9 characters`);
  }
  const bar = read('src/pages/farm/FarmTabBar.tsx');
  assert.equal(/\sdisabled=/.test(bar), false, 'a locked tab must stay tappable');
  assert.match(bar, /aria-disabled=\{lock \? true : undefined\}/);
  assert.match(bar, /if \(lock\) onLocked\?\.\(tab, lock\);\s*else onChange\(tab\);/, 'a locked tap reports the reason and does not switch');
  assert.equal(bar.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').includes('truncate'), false, 'labels wrap to a second line rather than being cut');
  assert.match(bar, /leading-tight text-center break-words/);
  const shell = read('src/pages/farm/PrinterFarm.tsx');
  assert.match(shell, /onLocked=\{\(_, reason\) => setHint\(reason\)\}/);
  assert.match(shell, /data-farm-notice="hint"[\s\S]{0,200}<Note tone="zinc"/, 'the reason is a Note, not the error alert');
  assert.match(shell, /setTimeout\(\(\) => setHint\(null\), 4000\)/, 'and it leaves on its own');
});

test('the sale quote is the server\'s resale_coins; the browser never computes money', () => {
  const sheet = read('src/pages/farm/sheets/PrinterSheet.tsx');
  assert.equal(sheet.includes('resale_factor'), false);
  assert.equal(sheet.includes('Math.floor'), false);
  assert.match(sheet, /typeof p\.resale_coins === 'number' \? p\.resale_coins : null/);
  assert.match(sheet, /resale === null \? s\.sellBodyNoQuote\(displayName\) : s\.sellBody\(displayName, formatCoins\(resale, lang\)\)/);
  assert.match(read('src/lib/farmApi.ts'), /resale_coins\?: number;/);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.equal(/\d/.test(FARM_STRINGS[lang].sellBodyNoQuote('X')), false, `${lang}.sellBodyNoQuote invents no figure`);
  }
});

test('the room: a bedslinger symbol in ≤ 40 path commands, low walls, a shelf with spools and a work table', () => {
  const room = read('src/pages/farm/room/Room.tsx');
  const consts = room.slice(room.indexOf('const BASE_TOP'), room.indexOf('const CSS'));
  let commands = 0;
  for (const m of consts.matchAll(/path\(\[([^\]]*)\](?:,\s*(false))?\)/g)) {
    commands += (m[1].match(/P\(/g) || []).length + (m[2] ? 0 : 1); // M + L… (+ Z when closed)
  }
  assert.ok(commands > 0 && commands <= 40, `printer symbol uses ${commands} path commands`);
  const sym = room.slice(room.indexOf('<symbol id="fp"'), room.indexOf('</symbol>'));
  for (const part of ['BASE_TOP', 'BED', 'COLUMN', 'BEAM', 'HEAD', 'HOLDER', 'LED', 'HEALTH']) assert.match(sym, new RegExp(`d=\\{${part}\\}`), `the symbol draws ${part}`);
  assert.equal((sym.match(/d=\{COLUMN\}/g) || []).length, 1, 'ONE gantry column');
  assert.match(sym, /<circle cx=\{SPOOL\.x\}/, 'the spool disc');
  assert.match(sym, /className="fp-bed"[^>]*stroke="currentColor"/, 'the bed outline carries the state colour');
  assert.match(sym, /className="fp-led"[^>]*stroke="currentColor"/, 'so does the LED');
  assert.equal(/fill="currentColor"[^>]*className="fp-led"|className="fp-led"[^>]*fill="currentColor"/.test(sym), false, 'stroke-based, not filled shapes');
  assert.ok(WALL_H <= 48, `walls are a backdrop (WALL_H=${WALL_H})`);
  for (const n of [1, 2, 6, 14]) {
    const r = roomLayout(n);
    assert.ok(r.viewBox.w / r.viewBox.h >= 1.1, `room for ${n} is wider than tall (${r.viewBox.w}×${r.viewBox.h})`);
    assert.equal(r.shelf.planks.length, 2);
    assert.ok(r.shelf.brackets.length >= 4 && r.shelf.spoolAnchors.length >= 1);
    for (const plank of r.shelf.planks) for (const p of plank) assert.ok(p.y >= -WALL_H - 1, 'the shelf hangs below the wall top');
    assert.ok(r.toolbox.top.length === 4 && r.table.top.length === 4);
  }
  assert.match(room, /data-farm-shelf/);
  assert.match(room, /data-farm-table/);
  assert.match(room, /layout\.toolbox\.(top|left|right)/);
  assert.match(room, /polyline points=\{pts\(layout\.skirting\)\}/);
  // Still: two compositor animations while printing, and nothing per frame.
  assert.match(room, /@keyframes fp-bed \{ from \{ transform: translate\(0, 0\); \} to \{ transform: translate\(/);
  assert.match(room, /@keyframes fp-led \{ from \{ opacity: 0\.3; \} to \{ opacity: 1; \} \}/);
});

test('phone hit areas are 44px, the daily cap is the server\'s, and the hub kicker is Latin-only in English', () => {
  assert.match(read('src/pages/farm/PageChrome.tsx'), /min-w-\[44px\] min-h-\[44px\][^"]*rounded-full/, 'the back button');
  const market = read('src/pages/farm/views/MarketView.tsx');
  assert.match(market, /data-farm-material=\{key\}[\s\S]{0,400}min-h-\[44px\] min-w-\[44px\]/, 'material chips are 44px controls');
  assert.equal(/min-h-\[36px\]/.test(market), false);
  assert.match(market, /<Spec label=\{s\.specVolume\} value=\{formatVolume\(model\.volume_mm\)\} wrap \/>/);
  assert.match(market, /<Spec label=\{s\.specMaterials\} value=\{model\.materials\.join\(' '\)\} wrap \/>/);
  assert.match(read('src/pages/farm/bits.tsx'), /wrap \? 'break-words leading-tight min-h-\[32px\]' : 'truncate'/, 'a wrapped spec reserves two lines');
  const sheet = read('src/pages/farm/sheets/PrinterSheet.tsx');
  assert.equal(/min-(w|h)-\[(36|40)px\]/.test(sheet), false, 'no sub-44 icon buttons in the printer sheet');
  assert.match(read('src/pages/farm/sheets/JobSheet.tsx'), /w-16 min-h-\[44px\] text-center/, 'the parts input');
  const shell = read('src/pages/farm/PrinterFarm.tsx');
  assert.equal((shell.match(/min-w-\[44px\] min-h-\[44px\]/g) || []).length, 2, 'both close buttons are 44px');
  // limits: both numbers from the server or nothing.
  assert.deepEqual(dailyJobs({ daily_jobs_cap: 20, jobs_today: 3 }), { jobs: 3, cap: 20 });
  assert.equal(dailyJobs({ max_active_jobs: 2 }), null);
  assert.equal(dailyJobs(undefined), null);
  assert.match(shell, /data-farm-today[\s\S]{0,120}s\.todayJobs\(today\.jobs, today\.cap\)/);
  assert.match(read('src/pages/games/GameProfile.tsx'), /data-profile-today[\s\S]{0,120}s\.todayJobs\(today\.jobs, today\.cap\)/);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.match(FARM_STRINGS[lang].todayJobs(3, 20), /3.*20/);
  // The kicker: lang/dir (and the letter-spacing that breaks Arabic joining) only when the copy is English.
  const hub = read('src/pages/Games.tsx');
  assert.equal(/lang="en" dir="ltr"/.test(hub), false);
  assert.match(hub, /lang=\{lang === 'en' \? 'en' : undefined\}/);
  assert.match(hub, /dir=\{lang === 'en' \? 'ltr' : undefined\}/);
  assert.match(hub, /\$\{lang === 'en' \? 'uppercase tracking-\[0\.08em\]' : ''\}/);
});

test('progress comes from two server timestamps and is clamped', () => {
  const a = '2026-09-06T10:00:00.000Z';
  const b = '2026-09-06T11:00:00.000Z';
  assert.equal(progressFraction(a, b, Date.parse('2026-09-06T10:30:00.000Z')), 0.5);
  assert.equal(progressFraction(a, b, Date.parse('2026-09-06T12:00:00.000Z')), 1);
  assert.equal(progressFraction(a, b, Date.parse('2026-09-06T09:00:00.000Z')), 0);
  assert.equal(progressFraction(b, a, 0), 0, 'an inverted window is not progress');
  assert.equal(colorSwatch('#abc'), '#abc');
  assert.equal(colorSwatch('Black'), '#111114');
  assert.equal(colorSwatch('nothing-like-this'), '#5B5B62');
});

// --------------------------------------------------------------- the room

test('the 2:1 projection and the room grid', () => {
  assert.deepEqual(iso(0, 0), { x: 0, y: 0 });
  assert.deepEqual(iso(1, 0), { x: 32, y: 16 });
  assert.deepEqual(iso(0, 1), { x: -32, y: 16 });
  assert.deepEqual(iso(1, 1, 10), { x: 0, y: 22 });
  assert.deepEqual(gridFor(2), { cols: 2, rows: 1 });
  assert.deepEqual(gridFor(6), { cols: 3, rows: 2 });
  assert.deepEqual(gridFor(14), { cols: 5, rows: 3 });
  assert.deepEqual(gridFor(40), { cols: 8, rows: 5 });
  for (const n of [1, 2, 6, 14, 40, 120]) {
    const room = roomLayout(n);
    assert.equal(room.tiles.length, n, `one tile per slot for ${n}`);
    assert.equal(new Set(room.tiles.map((t) => t.slot)).size, n);
    assert.ok(room.viewBox.w > 0 && room.viewBox.h > 0);
    for (const t of room.tiles) {
      const pos = at(room.viewBox, { x: t.cx, y: t.cy });
      const left = parseFloat(pos.left);
      const top = parseFloat(pos.top);
      assert.ok(left > 0 && left < 100 && top > 0 && top < 100, `tile ${t.slot} of ${n} lies inside the drawing`);
    }
  }
});

test('the room is one SVG symbol used per slot, two compositor animations, paused when hidden, HTML overlays with 44px targets', () => {
  const room = read('src/pages/farm/room/Room.tsx');
  const jsx = room.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(jsx, /<symbol id="fp"/);
  assert.equal((jsx.match(/<symbol /g) || []).length, 1, 'exactly one printer symbol');
  assert.match(room, /href="#fp"/);
  assert.equal((room.match(/@keyframes/g) || []).length, 2, 'exactly two keyframes');
  assert.match(room, /prefers-reduced-motion: reduce/);
  assert.match(room, /visibilitychange/);
  assert.match(room, /--fp-play/);
  assert.match(room, /max\(44px/, 'hit targets are at least 44px');
  assert.match(room, /<linearGradient/, 'the room lighting');
  assert.equal((room.match(/Gradient id=/g) || []).length, 1, 'no gradient beyond the room lighting');
  assert.equal(room.includes('<text'), false, 'labels are HTML, not SVG text');
  assert.equal(room.includes('requestAnimationFrame'), false, 'no JS per frame');
});

// ------------------------------------------------------------------ rules

const CONFIG: PublicFarmConfig = {
  time: { time_scale: 20, offer_refresh_minutes: 10, away_summary_after_minutes: 30, reference_speed_mms: 500 },
  economy: {
    starter_coins: 1500,
    resale_factor: 0.55,
    spool_sizes_g: [250, 500, 1000],
    maintenance: { cost: 120, minutes: 30, health_restore: 100 },
    repair: { cost: 400, minutes: 60, health: 80 },
    energy: { coins_per_kwh: 2 },
  },
  printers: {
    a1_mini: { name: { ar: 'A1 mini', en: 'A1 mini', ckb: 'A1 mini' }, family: 'A', price: 6000, speed: 500, volume_mm: [180, 180, 180], materials: ['PLA', 'PETG', 'TPU'], ams: false, reliability: 0.96, watts: 150, wear_per_hour: 0.5, min_level: 1, sort: 1 },
    x1c: { name: 'X1C', family: 'X', price: 32000, speed: 1000, volume_mm: [256, 256, 256], materials: ['PLA', 'PETG', 'ABS', 'PA'], ams: true, reliability: 0.98, watts: 350, wear_per_hour: 0.4, min_level: 6, sort: 10 },
  },
  materials: { PLA: { price_per_gram: 1, difficulty: 0.1, min_level: 1, colors: ['black', 'white'] } },
  colors: { black: { name: { ar: 'أسود', en: 'Black', ckb: 'ڕەش' }, hex: '#111827' } },
  products: { stand: { key: 'stand', name: { ar: 'حامل', en: 'Stand', ckb: 'ڕاگر' }, grams_per_part: 40, seconds_per_part: 3600, complexity: 0.2, max_colors: 2, size_mm: [120, 60, 100], materials: ['PLA'], min_tier: 'individual' } },
  customers: {},
  jobs: { offers_visible: 3, offer_lifetime_minutes: 30, late_grace_minutes: 60, max_active_jobs: [1, 2, 3] },
  quality: {
    draft: { time_factor: 0.7, failure_factor: 1.2, reputation_factor: 0.9 },
    standard: { time_factor: 1, failure_factor: 1, reputation_factor: 1 },
    fine: { time_factor: 1.5, failure_factor: 0.9, reputation_factor: 1.1 },
    ultra: { time_factor: 2.2, failure_factor: 0.85, reputation_factor: 1.2 },
  },
  progression: { xp_per_job: 10, xp_per_part: 1, level_thresholds: [0, 100], reputation_start_bp: 0, reputation_cap_bp: 5000, unlocks: { market: 1, inventory: 1, maintenance: 2, store: 3, upgrades: 4 } },
  locations: { tiny_room: { max_printers: 2, storage_grams: 3000, price: 0, min_level: 1 } },
  starter: { printer_model: 'a1_mini', spool: { material: 'PLA', color: 'black', grams: 1000 } },
};

const job = (over: Partial<FarmJob> = {}): FarmJob => ({
  id: 'j1',
  state: 'accepted',
  customer_tier: 'individual',
  customer_name: { ar: 'سارة', en: 'Sara', ckb: 'سارا' },
  title: 'Phone stands',
  product_key: 'stand',
  qty: 4,
  material: 'PLA',
  colors: ['black'],
  grams: 160,
  print_seconds: 4 * 3600,
  quality: 'standard',
  reward_coins: 320,
  reputation_gain_bp: 40,
  late_penalty_bp: 80,
  cancel_penalty_coins: 0,
  cancel_penalty_bp: 120,
  offer_expires_at: null,
  deadline_at: null,
  accepted_at: null,
  delivered_at: null,
  assignments_summary: null,
  ...over,
});

const printer = (over: Partial<FarmPrinter> = {}): FarmPrinter => ({
  id: 'p1',
  model_key: 'a1_mini',
  nickname: 'Line one',
  slot: 0,
  health: 100,
  state: 'idle',
  state_until: null,
  hours: 0,
  prints: 0,
  failures: 0,
  current: null,
  queue: [],
  ...over,
});

test('printer compatibility mirrors the server checks and names the first failing reason', () => {
  assert.deepEqual(printerFit(printer(), job(), CONFIG), { ok: true, reason: null });
  assert.equal(printerFit(printer({ state: 'broken' }), job(), CONFIG).reason, 'broken');
  assert.equal(printerFit(printer({ state: 'maintenance' }), job(), CONFIG).reason, 'maintenance');
  assert.equal(printerFit(printer(), job({ material: 'ABS' }), CONFIG).reason, 'material');
  assert.equal(printerFit(printer(), job({ colors: ['black', 'white'] }), CONFIG).reason, 'multicolor');
  assert.equal(printerFit(printer({ model_key: 'x1c' }), job({ colors: ['black', 'white'] }), CONFIG).ok, true, 'an AMS model takes two colours');
  assert.equal(printerFit(printer(), job({ product_key: 'huge' }), CONFIG).ok, true, 'an unknown product cannot be judged too large');
  assert.equal(printerFit(printer({ model_key: 'nope' }), job(), CONFIG).reason, 'unknown_model');
  assert.equal(fits([120, 60, 200], [180, 180, 180]), false);
  assert.equal(fits([120, 60, 200], [256, 256, 256]), true);
  assert.equal(fits([200, 10, 10], [180, 180, 250]), true, 'orientation is free');
  assert.equal(printerFit(printer(), job(), CONFIG).ok, true);
  // 200 mm tall part on a 180 mm cube: too large on the A1 mini, fine on the X1C.
  const stand = (CONFIG.products as Record<string, FarmProductDef>).stand;
  const tall: PublicFarmConfig = { ...CONFIG, products: { stand: { ...stand, size_mm: [200, 200, 200] } } };
  assert.equal(printerFit(printer(), job(), tall).reason, 'too_large');
  assert.equal(printerFit(printer({ model_key: 'x1c' }), job(), tall).ok, true);
});

test('spools, grams and time estimates derive only from server figures', () => {
  const spools = [
    { id: 's1', material: 'PLA', color: 'black', grams_left: 500, grams_total: 1000, quality: 1 },
    { id: 's2', material: 'PLA', color: 'white', grams_left: 500, grams_total: 1000, quality: 1 },
    { id: 's3', material: 'PETG', color: 'black', grams_left: 500, grams_total: 1000, quality: 1 },
    { id: 's4', material: 'PLA', color: 'black', grams_left: 0, grams_total: 1000, quality: 1 },
  ];
  assert.deepEqual(compatibleSpools(spools, job()).map((s) => s.id), ['s1']);
  assert.equal(gramsForQty(job(), 1), 40);
  assert.equal(gramsForQty(job(), 3), 120);
  assert.equal(gramsForQty(job(), 0), 0);
  // Whole job on the reference machine at standard quality = the quoted seconds.
  assert.equal(estimateGameSeconds(job(), 4, 'a1_mini', 'standard', CONFIG), 4 * 3600);
  // Twice the speed halves it; fine quality is ×1.5.
  assert.equal(estimateGameSeconds(job(), 4, 'x1c', 'standard', CONFIG), 2 * 3600);
  assert.equal(estimateGameSeconds(job(), 2, 'a1_mini', 'fine', CONFIG), 3 * 3600);
  assert.equal(remainingQty(job()), 4, 'no summary → the whole accepted job');
  assert.equal(remainingQty(job({ assignments_summary: { assigned: 3 } })), 1);
  assert.equal(remainingQty(job({ state: 'printing', assignments_summary: null })), 0, 'a printing job without a summary is not re-offered');
  const now = Date.parse('2026-09-06T10:00:00.000Z');
  assert.equal(deadlineRisk(now + 60_000, '2026-09-06T12:00:00.000Z', now), 'on_time');
  assert.equal(deadlineRisk(now + 118 * 60_000, '2026-09-06T12:00:00.000Z', now), 'tight');
  assert.equal(deadlineRisk(now + 3 * 3600_000, '2026-09-06T12:00:00.000Z', now), 'late');
  assert.equal(deadlineRisk(now, null, now), null);
  // 4 game hours at ×20 = 12 real minutes; a 13-minute deadline is urgent, a 3-hour one relaxed.
  assert.equal(offerUrgency(job({ deadline_at: new Date(now + 13 * 60_000).toISOString() }), now, 20), 'urgent');
  assert.equal(offerUrgency(job({ deadline_at: new Date(now + 25 * 60_000).toISOString() }), now, 20), 'tight');
  assert.equal(offerUrgency(job({ deadline_at: new Date(now + 3 * 3600_000).toISOString() }), now, 20), 'relaxed');
});

test('farmApi lookups tolerate both shapes of the config catalog and both spellings of the engine', () => {
  assert.equal(nameOf(productByKey(CONFIG, 'stand')?.name, 'en'), 'Stand');
  assert.equal(nameOf(productByKey({ ...CONFIG, products: [(CONFIG.products as Record<string, FarmProductDef>).stand] }, 'stand')?.name, 'ckb'), 'ڕاگر');
  assert.equal(productByKey(CONFIG, 'missing'), null);
  // Names: a plain string passes through; ckb falls back to Arabic, never to English.
  assert.equal(nameOf('A1', 'ckb'), 'A1');
  assert.equal(nameOf({ ar: 'حامل', en: 'Stand', ckb: '' }, 'ckb'), 'حامل');
  assert.equal(nameOf(null, 'en', 'fallback'), 'fallback');
  // Colours: the config's hex wins, the name table stands in.
  assert.equal(swatchFor(CONFIG, 'black'), '#111827');
  assert.equal(swatchFor(CONFIG, 'red'), '#C0392B');
  // Either spelling of the reputation gain and of the stats.
  assert.equal(reputationGainBp(job()), 40);
  assert.equal(reputationGainBp({ reputation_gain: 25 }), 25);
  assert.equal(statValue({ delivered: 3 }, 'jobs_delivered', 'delivered'), 3);
  assert.equal(statValue({}, 'jobs_delivered', 'delivered'), undefined, 'a stat the server did not send is not a zero');
  // A batch is collectable when the engine says it ended (done or failed), never while printing.
  assert.equal(batchEnded(printer({ state: 'printing', current: { assignment_id: 'a', job_id: 'j', title: 'x', qty: 1, state: 'printing', started_at: '', ends_at: '', progress: 0.4 } })), false);
  assert.equal(batchEnded(printer({ state: 'done', current: { assignment_id: 'a', job_id: 'j', title: 'x', qty: 1, state: 'done', started_at: '', ends_at: '', progress: 1 } })), true);
  assert.equal(batchEnded(printer({ state: 'broken', current: { assignment_id: 'a', job_id: 'j', title: 'x', qty: 1, state: 'failed', started_at: '', ends_at: '', progress: 1 } })), true);
  assert.equal(batchEnded(printer({ state: 'done', current: { assignment_id: 'a', job_id: 'j', title: 'x', qty: 1, started_at: '', ends_at: '', progress: 1 } })), true, 'without a batch state the printer state decides');
  assert.equal(batchEnded(printer()), false);
  assert.deepEqual(
    printerCatalog(CONFIG).map((c) => c.key),
    ['a1_mini', 'x1c']
  );
  assert.equal(isFarmState({ success: true }), false);
  assert.equal(isFarmState({ now: 'x', profile: {}, printers: [], spools: [], jobs: {}, config: {} }), true);
});

test('the away sheet groups the engine\'s event kinds and sums only coins the events carry', () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown> = {}) => ({ id, kind, payload, created_at: '2026-09-06T10:00:00.000Z' });
  const g = groupEvents([
    ev('1', 'print_done'),
    ev('2', 'job_ready'),
    ev('3', 'print_failed'),
    ev('4', 'printer_broken'),
    ev('5', 'job_late'),
    ev('6', 'job_cancelled_by_customer'),
    ev('7', 'offer_expired'),
    ev('8', 'maintenance_done'),
    ev('9', 'repair_done'),
    ev('10', 'level_up'),
    ev('11', 'something_new'),
  ]);
  assert.deepEqual(g, { finished: 2, failed: 2, late: 1, cancelled: 2, maintenance: 2, levelUp: 1, other: 1, coins: null });
  assert.equal(groupEvents([ev('a', 'print_done', { coins: 120 }), ev('b', 'print_failed', { amount: -30 })]).coins, 90);
  assert.equal(groupEvents([]).coins, null, 'no fabricated zero when nothing carried coins');
});

// ---------------------------------------------------------- house rules

test('every button states its type and icon-only buttons carry a label', () => {
  for (const f of gameFiles()) {
    const src = read(f);
    const buttons = (src.match(/<button\b/g) || []).length;
    const typed = (src.match(/type="(button|submit)"/g) || []).length;
    assert.equal(typed, buttons, `${f}: ${buttons} <button> tags but ${typed} type declarations`);
  }
  const room = read('src/pages/farm/room/Room.tsx');
  assert.match(room, /aria-label=\{`\$\{s\.openPrinter/);
  const sheet = read('src/pages/farm/sheets/PrinterSheet.tsx');
  assert.match(sheet, /aria-label=\{s\.moveUp\}/);
  assert.match(sheet, /aria-label=\{s\.moveDown\}/);
  assert.match(sheet, /aria-label=\{s\.rename\}/);
});

test('logical properties, Latin digits and the house primitives', () => {
  const src = allSource();
  for (const physical of ['rounded-bl-', 'rounded-br-', 'rounded-tl-', 'rounded-tr-', ' ml-', ' mr-', ' pl-', ' pr-', 'left-0', 'right-0', 'text-left', 'text-right']) {
    assert.equal(new RegExp(`className="[^"]*${physical.trim()}`).test(src), false, `physical property in a className: ${physical.trim()}`);
  }
  assert.equal(src.includes('formatIqd'), false, 'Farm Coins are not IQD');
  assert.equal(src.includes('toLocaleString('), false, 'numbers go through the Intl helpers');
  for (const f of ['src/pages/farm/sheets/JobSheet.tsx', 'src/pages/farm/views/MarketView.tsx', 'src/pages/Leaderboards.tsx']) {
    assert.match(read(f), /<Segmented/, `${f} uses the house Segmented control`);
  }
  assert.match(read('src/pages/farm/PrinterFarm.tsx'), /<TabPanels/);
  assert.match(read('src/pages/farm/sheets/Window.tsx'), /<Sheet/);
  assert.match(read('src/pages/farm/sheets/Window.tsx'), /<Overlay/);
  assert.match(read('src/pages/farm/sheets/PrinterSheet.tsx'), /<Overlay[\s\S]{0,200}anchor=\{sellBtn\}/, 'selling confirms in a window anchored to its button');
  assert.match(read('src/pages/farm/sheets/JobSheet.tsx'), /<Note/);
  assert.match(read('src/pages/farm/PrinterFarm.tsx'), /<FarmSkeleton/);
  assert.match(read('src/pages/Leaderboards.tsx'), /<EmptyState/);
  assert.match(read('src/pages/Games.tsx'), /<UnauthorizedState/);
  assert.match(read('src/pages/farm/PrinterFarm.tsx'), /<ErrorState/);
  // Type stays restrained: nothing above 22px anywhere but the coins chip.
  for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
    assert.ok(Number(m[1]) <= 24, `type size ${m[1]}px exceeds the cap`);
  }
  assert.equal((src.match(/text-\[24px\]/g) || []).length, 1, 'only the coins chip reaches 24px');
});

test('server authority: idempotency per attempt, no optimistic state, polling and resync', () => {
  const hook = read('src/pages/farm/hooks/useFarmState.ts');
  assert.match(hook, /newIdempotencyKey\(\)/);
  assert.match(hook, /keys\.current\.get\(actionId\) \?\? newIdempotencyKey\(\)/, 'one key per attempt, reused only on a retry');
  assert.match(hook, /isFarmState\(res\)\) apply\(res\)/, 'the screen renders the returned state');
  assert.match(hook, /else await reload\(\)/, 'a response without state triggers a fresh read');
  assert.match(hook, /pollWhileVisibleMs: 20_000/);
  assert.equal(/setState\(\(prev\)/.test(hook), false, 'no optimistic patching of the state');
  const shell = read('src/pages/farm/PrinterFarm.tsx');
  assert.match(shell, /now >= t && busy === null/, 'a countdown reaching a server instant re-reads the state');
  assert.match(shell, /tutorial\?\.done !== true/, 'the intro is driven by the server tutorial object');
  const clock = read('src/pages/farm/hooks/useServerClock.ts');
  assert.match(clock, /offsetRef\.current = t - Date\.now\(\)/, 'countdowns run on the server clock');
  const api = read('src/lib/farmApi.ts');
  for (const path of ['/state', '/ledger', '/events?all=1', '/events/seen', '/leaderboard?board=', '/config', '/accept', '/reject', '/assign', '/cancel', '/queue', '/collect', '/maintain', '/repair', '/rename', '/market/filament', '/market/printers', '/sell']) {
    assert.ok(api.includes(path), `farmApi covers ${path}`);
  }
  // Every mutation sends idempotencyKey in the body: each `api.post<` call,
  // read up to the next call, names the key.
  const posts = api.split('api.post<').slice(1);
  assert.ok(posts.length >= 13, `expected the mutation set, found ${posts.length}`);
  for (const p of posts) assert.match(p.split('\n')[0] + (p.split('\n')[1] ?? ''), /idempotencyKey/, `mutation without an idempotency key: ${p.slice(0, 80)}`);
});

// ------------------------------------------------------------------ routes

test('every route the game pages name exists in App.tsx, and the farm is lazy behind ProtectedRoute + FarmSkeleton', () => {
  const app = read('src/App.tsx');
  const declared = new Set([...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]));
  for (const p of ['/games', '/games/printer-farm', '/games/profile', '/games/redeem', '/leaderboards']) {
    assert.ok(declared.has(p), `App.tsx lacks the route ${p}`);
  }
  const src = allSource();
  const referenced = new Set<string>();
  for (const m of src.matchAll(/(?:navigate\(|to=|next=|fallback=)"?'?(\/[a-z-]+(?:\/[a-z-]+)*)/g)) referenced.add(m[1]);
  for (const r of referenced) {
    if (r === '/auth' || r === '/files') continue;
    assert.ok(declared.has(r), `the game pages link to ${r}, which App.tsx does not declare`);
  }
  assert.match(app, /const PrinterFarm = React\.lazy\(\(\) => import\('\.\/pages\/farm\/PrinterFarm'\)\)/);
  assert.match(app, /path="\/games\/printer-farm"[\s\S]{0,200}<ProtectedRoute>[\s\S]{0,120}<Suspense fallback=\{<FarmSkeleton \/>\}>/);
  // /games and /leaderboards stay open to guests: no ProtectedRoute around them.
  assert.equal(/path="\/games"[\s\S]{0,200}<ProtectedRoute>/.test(app), false);
  assert.equal(/path="\/leaderboards"[\s\S]{0,200}<ProtectedRoute>/.test(app), false);
  assert.match(app, /'\/games', '\/leaderboards'/, 'the full-screen list still covers /games/*');
  // The guest suites still list the two open routes.
  assert.match(read('scripts/e2e-guest.mjs'), /path: '\/games'/);
  assert.match(read('scripts/e2e-guest.mjs'), /path: '\/leaderboards'/);
  assert.match(read('.github/workflows/verify-live-guest.yml'), /\/games \/leaderboards/);
});
