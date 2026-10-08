import { loc } from '../LanguageContext';
import { toast } from './toastStore';

/**
 * WHAT THE FIRST PROOF OF THE OWNER'S ADDRESS ENDS, SAID BEFORE AND AFTER IT
 * (review of the S1 amendment, finding 5, and the review of its fix).
 *
 * The first proof of INITIAL_ADMIN_EMAIL ends every other way into that
 * account in the same batch as the stamp (worker/lib/emailStamp.ts): its other
 * sessions, its password, its Telegram link, its phone sign-in and any Google
 * account under another address (Google on this same address links again at
 * its next sign-in). Two routes can make it — the emailed link, confirmed from
 * the account's own session on EmailVerifyBanner's confirm card, and a sign-in
 * code to that address (CodeAuth) — and each makes it ONLY when the request
 * says the person accepted it (`accept_owner_first_proof`). Without that, the
 * server answers 409 OWNER_FIRST_PROOF_REQUIRED (its three sentences live in
 * the refusal contract) and changes nothing, so the warning does not depend on
 * what the page has loaded: the page shows that sentence with a confirm and a
 * cancel, and asks again with the flag. A Google sign-in never makes the proof.
 *
 * The card that sends the link says it beforehand too (OWNER_EMAIL_UNVERIFIED),
 * and so does the confirm card, above its button, for the owner's own
 * unverified session (`before`: a press under that sentence is the
 * acceptance). The route that proved answers `owner_first_proof:
 * { sessions_ended }` exactly then, and never for any other address or any
 * later proof; `body` says it afterwards — in place on the confirm card, in a
 * toast after a code sign-in, which moves on at once — because "my password
 * stopped working" with no reason given reads as a break-in.
 */
export interface OwnerFirstProof {
  sessions_ended: number;
}

/** The field from a route's answer, or null when the answer has none. */
export function ownerFirstProofOf(res: unknown): OwnerFirstProof | null {
  if (!res || typeof res !== 'object') return null;
  const p = (res as { owner_first_proof?: unknown }).owner_first_proof;
  if (!p || typeof p !== 'object') return null;
  const n = Number((p as { sessions_ended?: unknown }).sessions_ended);
  return { sessions_ended: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 };
}

/** The refusal code the server answers a first proof with until the person accepts it. */
export const OWNER_FIRST_PROOF_REQUIRED = 'OWNER_FIRST_PROOF_REQUIRED';

export const OWNER_FIRST_PROOF_STRINGS = {
  ar: {
    before:
      'التأكيد يُنهي جلسات هذا الحساب على الأجهزة الأخرى ويزيل كلمة مروره وربط تيليغرام والدخول بالهاتف وأي حساب Google ببريد آخر. بعده تدخل برمز يصل إلى هذا البريد أو بـGoogle على البريد نفسه.',
    acceptSignIn: 'أكّد وسجّل الدخول',
    acceptConfirm: 'فهمت، أكّد بريدي',
    cancel: 'إلغاء',
    title: 'تأكّد بريد الأدمن الرئيسي',
    body: (n: number) =>
      `هذا أول تأكيد لهذا البريد، فأُنهي للأمان كل طريق آخر إلى الحساب: الجلسات الأخرى (${n})، وكلمة المرور، وربط تيليغرام، والدخول بالهاتف، وأي حساب Google ببريد آخر. ادخل من الآن برمز يصل إلى هذا البريد أو بـGoogle على البريد نفسه، ولك أن تعيّن كلمة مرور جديدة من الإعدادات.`,
  },
  en: {
    before:
      "Confirming ends this account's sessions on other devices and removes its password, Telegram link, phone sign-in and any Google account with a different email. Afterwards you sign in with a code sent to this email or with Google on this same email.",
    acceptSignIn: 'Confirm and sign in',
    acceptConfirm: 'I understand, confirm my email',
    cancel: 'Cancel',
    title: 'Main admin email verified',
    body: (n: number) =>
      `This was the first verification of this address, so for safety every other way into the account ended: other sessions (${n}), the password, the Telegram link, phone sign-in and any Google account with a different email. From now on, sign in with a code sent to this email or with Google on this same email; you can set a new password in Settings.`,
  },
  ckb: {
    before:
      'پشتڕاستکردنەوە دانیشتنەکانی ئەم هەژمارە لە ئامێرەکانی تر کۆتایی پێدەهێنێت و وشەی نهێنی و بەستنەوەی تێلێگرام و چوونەژوورەوە بە ژمارەی مۆبایل و هەر هەژمارێکی Google بە ئیمەیڵێکی تر لادەبات. دواتر بە کۆدێک کە بۆ ئەم ئیمەیڵە دەنێردرێت یان بە Google بە هەمان ئیمەیڵ دەچیتە ژوورەوە.',
    acceptSignIn: 'پشتڕاستی بکەرەوە و بچۆ ژوورەوە',
    acceptConfirm: 'تێگەیشتم، ئیمەیڵەکەم پشتڕاست بکەرەوە',
    cancel: 'هەڵوەشاندنەوە',
    title: 'ئیمەیڵی بەڕێوەبەری سەرەکی پشتڕاست کرایەوە',
    body: (n: number) =>
      `ئەمە یەکەم پشتڕاستکردنەوەی ئەم ئیمەیڵەیە، بۆیە بۆ پاراستن هەموو ڕێگایەکی تری چوونە ناو هەژمارەکە داخرا: دانیشتنەکانی تر (${n})، وشەی نهێنی، بەستنەوەی تێلێگرام، چوونەژوورەوە بە ژمارەی مۆبایل و هەر هەژمارێکی Google بە ئیمەیڵێکی تر. لەمەودوا بە کۆدێک کە بۆ ئەم ئیمەیڵە دەنێردرێت یان بە Google بە هەمان ئیمەیڵ بچۆ ژوورەوە؛ دەتوانیت لە ڕێکخستنەکانەوە وشەی نهێنییەکی نوێ دابنێیت.`,
  },
} as const;

/** The two lines in the reader's language. */
export function ownerFirstProofText(proof: OwnerFirstProof): { title: string; body: string } {
  const S = OWNER_FIRST_PROOF_STRINGS;
  const n = proof.sessions_ended;
  return {
    title: loc(S.ar.title, S.en.title, S.ckb.title),
    body: loc(S.ar.body(n), S.en.body(n), S.ckb.body(n)),
  };
}

/**
 * After a code sign-in that made the proof (the person accepted it a moment
 * before): says what ended in a toast that stays until dismissed, because the
 * page moves on at once. Silent when the answer carries no first proof.
 */
export function announceOwnerFirstProof(res: unknown): void {
  const proof = ownerFirstProofOf(res);
  if (!proof) return;
  const t = ownerFirstProofText(proof);
  toast.info(t.title, { description: t.body, duration: Infinity, id: 'owner-first-proof' });
}
