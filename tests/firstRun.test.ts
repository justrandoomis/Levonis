/**
 * The first run: «أكمل ملفك الشخصي» once, then «اختر المظهر» once, in that order.
 *
 * The owner: «اجعل اكمال الملف الشخصي تظهر بعد انشاء الحساب لمره واحده … ويظهر
 * اختيار الثيم بعد اغلاق نافذه اكمال الملف الشخصي (سواء تم اغلاقه او تم اكماله)».
 * The profile sheet's "once" is the server's (tests/onboarding.test.ts); this
 * file pins the theme sheet's "once", the ORDER between the two, and that
 * every signup method reaches the same sheet.
 *
 * Run: npx tsx --test tests/firstRun.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THEME_INTRO_KEY,
  getProfileStep,
  isQuietRoute,
  readThemeIntro,
  setProfileStep,
  shouldShowThemeIntro,
  writeThemeIntro,
  type ThemeIntroInput,
} from '../src/lib/firstRun';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// A localStorage for the module's record.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const base: ThemeIntroInput = { userId: 'u1', profileStep: 'none', record: null, hasStoredPreference: false, quiet: false };
const show = (over: Partial<ThemeIntroInput>) => shouldShowThemeIntro({ ...base, ...over });

test('a visitor who is not signed in is never asked', () => {
  assert.equal(show({ userId: null, profileStep: 'closed' }), false);
  assert.equal(show({ userId: null, record: 'owed' }), false);
});

test('THE ORDER: never while the profile sheet is undecided or on screen', () => {
  for (const profileStep of ['pending', 'open'] as const) {
    assert.equal(show({ profileStep }), false, profileStep);
    assert.equal(show({ profileStep, record: 'owed' }), false, `${profileStep}+owed`);
  }
});

test('after the profile sheet closes — completed or dismissed — it is owed, whatever is stored', () => {
  assert.equal(show({ profileStep: 'closed' }), true);
  assert.equal(show({ profileStep: 'closed', hasStoredPreference: true }), true);
  // Owed from an earlier tab (a reload inside the wizard) still counts.
  assert.equal(show({ profileStep: 'none', record: 'owed', hasStoredPreference: true }), true);
});

test('once: after it has been shown, never again', () => {
  for (const profileStep of ['closed', 'none'] as const) {
    assert.equal(show({ profileStep, record: 'seen' }), false, profileStep);
  }
});

test('an existing account is asked once — only where nothing has been chosen', () => {
  assert.equal(show({ profileStep: 'none', hasStoredPreference: false }), true);
  assert.equal(show({ profileStep: 'none', hasStoredPreference: true }), false);
});

test('never on a route where an interruption costs something', () => {
  for (const path of ['/checkout', '/checkout/pay', '/cart', '/welcome', '/auth', '/edit-profile']) {
    assert.equal(isQuietRoute(path), true, path);
    assert.equal(show({ profileStep: 'closed', quiet: isQuietRoute(path) }), false, path);
  }
  assert.equal(isQuietRoute('/'), false);
  assert.equal(isQuietRoute('/cartography'), false);
});

test('the record is per user, and "seen" is final', () => {
  store.clear();
  assert.equal(readThemeIntro('u1'), null);
  writeThemeIntro('u1', 'owed');
  assert.equal(readThemeIntro('u1'), 'owed');
  assert.equal(readThemeIntro('u2'), null, 'another account on the same device is its own record');
  writeThemeIntro('u1', 'seen');
  writeThemeIntro('u1', 'owed');
  assert.equal(readThemeIntro('u1'), 'seen');
  // A corrupted value reads as nothing, not as a crash.
  store.set(THEME_INTRO_KEY, '{not json');
  assert.equal(readThemeIntro('u1'), null);
});

test('closing the profile sheet records the theme sheet as owed, and a stale report cannot reopen it', () => {
  store.clear();
  assert.equal(getProfileStep('u7'), 'pending');
  setProfileStep('u7', 'open');
  assert.equal(getProfileStep('u7'), 'open');
  assert.equal(readThemeIntro('u7'), null, 'owed before the profile sheet closed');
  setProfileStep('u7', 'closed');
  assert.equal(readThemeIntro('u7'), 'owed');
  setProfileStep('u7', 'open');
  assert.equal(getProfileStep('u7'), 'closed');
  // Another account in the same tab starts from 'pending'.
  assert.equal(getProfileStep('u8'), 'pending');
});

test('the full sequence for a new account: profile, then theme, then nothing', () => {
  store.clear();
  const step = () => getProfileStep('n1');
  const input = (hasStoredPreference = true): ThemeIntroInput => ({
    userId: 'n1', profileStep: step(), record: readThemeIntro('n1'), hasStoredPreference, quiet: false,
  });
  assert.equal(shouldShowThemeIntro(input()), false, 'before the profile sheet has reported');
  setProfileStep('n1', 'open');
  assert.equal(shouldShowThemeIntro(input()), false, 'while the profile sheet is up');
  setProfileStep('n1', 'closed');
  assert.equal(shouldShowThemeIntro(input()), true, 'right after it closed');
  writeThemeIntro('n1', 'seen'); // what the sheet does as it opens
  assert.equal(shouldShowThemeIntro(input(false)), false, 'a second time');
});

test('the components wire it the way the functions assume', () => {
  const profile = read('src/components/profile/CompleteProfileSheet.tsx');
  // Every close — dismiss and «أكمل الآن» — goes through the one handover.
  assert.match(profile, /const close = \(\) => \{\s*setOpen\(false\);\s*if \(userId\) setProfileStep\(userId, 'closed'\);/);
  assert.match(profile, /const dismiss = async \(\) => \{\s*close\(\);/);
  assert.match(profile, /const complete = \(\) => \{\s*close\(\);/);
  assert.match(profile, /\/api\/profile\/completion\/seen/, 'the sheet is not stamped when shown');
  assert.match(profile, /user\?\.onboarding === 'new'/);
  const theme = read('src/components/profile/ThemeIntroSheet.tsx');
  assert.match(theme, /shouldShowThemeIntro\(/);
  assert.match(theme, /writeThemeIntro\(userId, 'seen'\)/);
  assert.match(theme, /setThemePreference\(/);
  assert.match(theme, /الإعدادات ← المظهر/);
  for (const v of ["'light'", "'dark'", "'system'"]) assert.ok(theme.includes(v), v);
  const app = read('src/App.tsx');
  assert.ok(app.indexOf('<CompleteProfileSheet />') < app.indexOf('<ThemeIntroSheet />'));
});

test('every signup method lands on the same sheet — none is sent past it to /welcome', () => {
  const auth = read('src/pages/Auth.tsx');
  const finish = auth.slice(auth.indexOf('const finishAuth'), auth.indexOf('const clearMessages'));
  assert.doesNotMatch(finish, /\/welcome/, 'finishAuth routes some signups around the first-run sheet again');
});
