/**
 * The account menu's words (./AccountMenu.tsx) — kept beside the menu, in its
 * lazy chunk, not in the frame's table (./strings.ts): the frame's closure
 * budget has no room for words only the menu shows (tests/bundleBudget.test.ts).
 * The Sorani is the app's own: «هەژمار» and «چوونەدەرەوە» from Settings,
 * «زمان» from the language sheet, «پشتگیری و یارمەتی» from the help pages.
 */
import type { Words } from './strings';

export const ACCOUNT_WORDS = {
  you: ['حسابك', 'Your account', 'هەژمارەکەت'],
  language: ['اللغة', 'Language', 'زمان'],
  currentLanguage: ['اللغة الحالية', 'Current language', 'زمانی ئێستا'],
  account: ['الحساب', 'Account', 'هەژمار'],
  help: ['المساعدة والدعم', 'Help and support', 'پشتگیری و یارمەتی'],
  signOut: ['تسجيل الخروج', 'Sign out', 'چوونەدەرەوە'],
} as const satisfies Record<string, Words>;
