/**
 * THE FIRST RUN — «أكمل ملفك الشخصي», then «اختر المظهر», each once.
 *
 * The owner: «اجعل اكمال الملف الشخصي تظهر بعد انشاء الحساب لمره واحده … ويظهر
 * اختيار الثيم بعد اغلاق نافذه اكمال الملف الشخصي (سواء تم اغلاقه او تم اكماله)».
 * Two sheets, in that order, and never a second time. This module is the one
 * place their order is decided, as plain functions the tests call directly
 * (tests/firstRun.test.ts); the two components only report and read.
 *
 * WHO REMEMBERS WHAT.
 *  - THE PROFILE SHEET is remembered by the SERVER (worker/lib/profileCompletion.ts,
 *    `shouldPromptCompletion`): every signup route — email, Google, phone,
 *    Telegram — inserts `onboarding_state = 'new'`, the sheet stamps
 *    `profile_prompt_at` the moment it is shown, and closing it moves the
 *    account out of 'new'. So it is once per ACCOUNT, on every device.
 *  - THE THEME SHEET is remembered in THIS BROWSER, per user id. The theme is
 *    a device preference (src/lib/theme.ts — nothing about it reaches the
 *    server), so "has this person chosen a look here" is the device's
 *    question, and a new column to answer it would be a backend for a colour.
 *
 * THE ORDER. The profile sheet reports a step for the signed-in account:
 *   'pending' — not decided yet (loading, or never reported for this user);
 *   'open'    — it is showing, or waiting for a route where it may show;
 *   'closed'  — it was shown and closed in this tab (completed OR dismissed);
 *   'none'    — it will not be shown to this account.
 * The theme sheet never opens while the step is 'pending' or 'open'. On a
 * close the theme sheet is recorded as OWED for that user before anything
 * else, so a reload in between (the «أكمل الآن» wizard, say) still brings it.
 *
 * EXISTING ACCOUNTS (step 'none', nothing owed): they are shown the theme
 * sheet once too — but only if this browser holds no theme choice. The
 * default just changed from light to the device's theme, so for exactly
 * those people the app may have turned dark by itself; one look at the three
 * options, with a note that it lives in Settings, explains that change. A
 * person who already chose in Settings has answered, and is not asked.
 */
import { useSyncExternalStore } from 'react';

export type ProfileStep = 'pending' | 'open' | 'closed' | 'none';
export type ThemeIntroRecord = 'owed' | 'seen' | null;

/** Routes where an interruption costs the person something. Both sheets wait them out. */
export const FIRST_RUN_QUIET_ROUTES = ['/auth', '/welcome', '/checkout', '/cart', '/edit-profile'];

export function isQuietRoute(pathname: string): boolean {
  return FIRST_RUN_QUIET_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export interface ThemeIntroInput {
  /** The signed-in account, or null for a visitor — who is never asked. */
  userId: string | null;
  /** What the profile sheet reported for THIS account. */
  profileStep: ProfileStep;
  /** What this browser remembers about the theme sheet for this account. */
  record: ThemeIntroRecord;
  /** Whether this browser already holds a theme choice. */
  hasStoredPreference: boolean;
  /** On a route where neither sheet may interrupt. */
  quiet: boolean;
}

/** Whether the theme sheet may open now. */
export function shouldShowThemeIntro(i: ThemeIntroInput): boolean {
  if (!i.userId) return false;
  if (i.record === 'seen') return false;
  if (i.quiet) return false;
  // THE ORDER: never before the profile sheet has had its turn.
  if (i.profileStep === 'pending' || i.profileStep === 'open') return false;
  // A new account whose profile sheet closed: owed, whatever is stored.
  if (i.record === 'owed' || i.profileStep === 'closed') return true;
  // An existing account: once, and only where nothing has been chosen.
  return !i.hasStoredPreference;
}

// ------------------------------------------------ the theme sheet's record
export const THEME_INTRO_KEY = 'levonis.themeIntro.v1';

function readAll(): Record<string, ThemeIntroRecord> {
  try {
    const raw = window.localStorage.getItem(THEME_INTRO_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ThemeIntroRecord>) : {};
  } catch {
    return {};
  }
}

export function readThemeIntro(userId: string): ThemeIntroRecord {
  const v = readAll()[userId];
  return v === 'owed' || v === 'seen' ? v : null;
}

/** 'seen' is final: nothing moves a user back to 'owed'. */
export function writeThemeIntro(userId: string, value: 'owed' | 'seen'): void {
  const all = readAll();
  if (all[userId] === 'seen') return;
  all[userId] = value;
  try {
    window.localStorage.setItem(THEME_INTRO_KEY, JSON.stringify(all));
  } catch {
    /* private mode: the in-tab step still carries the order for this visit */
  }
}

// ------------------------------------------------ the profile sheet's step
let state: { userId: string | null; step: ProfileStep } = { userId: null, step: 'pending' };
const listeners = new Set<() => void>();

export function setProfileStep(userId: string, step: ProfileStep): void {
  if (state.userId === userId && state.step === step) return;
  // A close is final for this tab: a late 'open' from a stale fetch cannot undo it.
  if (state.userId === userId && state.step === 'closed' && step !== 'closed') return;
  state = { userId, step };
  if (step === 'closed') writeThemeIntro(userId, 'owed');
  for (const l of listeners) l();
}

export function getProfileStep(userId: string | null): ProfileStep {
  return userId && state.userId === userId ? state.step : 'pending';
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useProfileStep(userId: string | null): ProfileStep {
  return useSyncExternalStore(
    subscribe,
    () => getProfileStep(userId),
    () => 'pending' as ProfileStep
  );
}
