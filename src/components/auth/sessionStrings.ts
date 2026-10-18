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

/**
 * The same moment after a sign-in that CREATED the account (the e-mailed
 * finish link, a code or Telegram sign-up, a password sign-up): its token or
 * ticket is spent, so «try again» would only fail. It says the account exists
 * and points at signing in to it; the page shows no retry beside it
 * (src/lib/sessionCheck.ts `notKeptNext`).
 */
export const ACCOUNT_CREATED_NOT_KEPT: Record<Language, string> = {
  ar: 'أُنشئ حسابك، لكن هذا المتصفح لم يحتفظ بتسجيل الدخول. لا داعي لإنشائه من جديد: سجّل الدخول إليه الآن. وإن تكرر ذلك فافتح الموقع عبر https وتأكد أن ملفات تعريف الارتباط غير محظورة وأنك لست في نافذة تصفح خاص.',
  en: 'Your account was created, but this browser did not keep you signed in. There is no need to create it again: sign in to it now. If this happens again, open the site over https and make sure cookies are not blocked and you are not in a private tab.',
  ckb: 'هەژمارەکەت دروستکرا، بەڵام ئەم وێبگەڕە چوونەژوورەوەکەتی هەڵنەگرت. پێویست ناکات دووبارە دروستی بکەیتەوە: ئێستا بە هەژمارەکەت بچۆرە ژوورەوە. ئەگەر دووبارە ڕوویدا، ماڵپەڕەکە بە https بکەرەوە و دڵنیا بەرەوە کە کووکییەکان بلۆک نەکراون و لە تابێکی تایبەتدا نیت.',
};

export const accountCreatedNotKeptText = (lang: Language): string =>
  ACCOUNT_CREATED_NOT_KEPT[lang] ?? ACCOUNT_CREATED_NOT_KEPT.ar;
