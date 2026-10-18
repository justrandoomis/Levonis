import type { Language } from '../../translations';

/**
 * «Your details were accepted, but this browser did not keep you signed in.»
 *
 * Shown by every sign-in screen (src/pages/Auth.tsx, CodeAuth, TelegramAuth)
 * when src/AuthContext.tsx `adoptSession` answers `not_kept`: the server
 * signed the person in, and a fresh /api/auth/me from this browser came back
 * a guest (src/lib/sessionCheck.ts). One sentence, one place, three
 * languages — the Sorani written as Sorani (docs/DECISIONS.md row 183).
 */
export const SESSION_NOT_KEPT: Record<Language, string> = {
  ar: 'قُبلت بياناتك، لكن هذا المتصفح لم يحتفظ بتسجيل الدخول. افتح الموقع عبر https وتأكد أن ملفات تعريف الارتباط غير محظورة وأنك لست في نافذة تصفح خاص، ثم أعد المحاولة.',
  en: 'Your details were accepted, but this browser did not keep you signed in. Open the site over https, make sure cookies are not blocked and you are not in a private tab, then try again.',
  ckb: 'زانیارییەکانت پەسەند کران، بەڵام ئەم وێبگەڕە چوونەژوورەوەکەتی هەڵنەگرت. ماڵپەڕەکە بە https بکەرەوە، دڵنیا بەرەوە کە کووکییەکان بلۆک نەکراون و لە تابێکی تایبەتدا نیت، پاشان دووبارە هەوڵ بدە.',
};

export const sessionNotKeptText = (lang: Language): string => SESSION_NOT_KEPT[lang] ?? SESSION_NOT_KEPT.ar;
