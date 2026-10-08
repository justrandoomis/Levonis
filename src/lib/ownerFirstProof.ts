import { loc } from '../LanguageContext';
import { toast } from './toastStore';

/**
 * «تأكّد بريد الأدمن الرئيسي» — WHAT THE FIRST PROOF OF THE OWNER'S ADDRESS
 * ENDED, SAID TO THE PERSON WHO MADE IT (review of the S1 amendment, finding 5).
 *
 * The first proof of INITIAL_ADMIN_EMAIL — a code sign-in, the emailed link, a
 * Google sign-in or link — ends every other way into that account in the same
 * batch as the stamp (worker/lib/emailStamp.ts): its other sessions, its
 * password, its Telegram link, its phone sign-in and any Google account that
 * is not the proof. The route answers `owner_first_proof: { sessions_ended }`
 * exactly then, and never for any other address or any later proof, so the
 * field reaches only the person who just proved the owner's mailbox.
 *
 * The card that sends the link says this beforehand (OWNER_EMAIL_UNVERIFIED),
 * and so does the confirm card, above its button, for the owner's own
 * unverified session (`before`: the compact row in a working screen sends the
 * link without the card's sentence). `body` says it afterwards, because "my password stopped working" with no
 * reason given reads as a break-in. The email link's confirm card shows it in
 * place (EmailVerifyBanner); a sign-in navigates away at once, so it is a toast
 * that stays until dismissed.
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

export const OWNER_FIRST_PROOF_STRINGS = {
  ar: {
    before:
      'التأكيد يُنهي جلسات هذا الحساب على الأجهزة الأخرى ويزيل كلمة مروره وربط تيليغرام والدخول بالهاتف وأي حساب Google آخر. بعده تدخل برمز يصل إلى هذا البريد.',
    title: 'تأكّد بريد الأدمن الرئيسي',
    body: (n: number) =>
      `هذا أول تأكيد لهذا البريد، فأُنهي للأمان كل طريق آخر إلى الحساب: الجلسات الأخرى (${n})، وكلمة المرور، وربط تيليغرام، والدخول بالهاتف، وأي حساب Google آخر. ادخل من الآن برمز يصل إلى هذا البريد، ولك أن تعيّن كلمة مرور جديدة من الإعدادات.`,
  },
  en: {
    before:
      "Confirming ends this account's sessions on other devices and removes its password, Telegram link, phone sign-in and any other Google account. Afterwards you sign in with a code sent to this email.",
    title: 'Main admin email verified',
    body: (n: number) =>
      `This was the first verification of this address, so for safety every other way into the account ended: other sessions (${n}), the password, the Telegram link, phone sign-in and any other Google account. From now on, sign in with a code sent to this email; you can set a new password in Settings.`,
  },
  ckb: {
    before:
      'پشتڕاستکردنەوە دانیشتنەکانی ئەم هەژمارە لە ئامێرەکانی تر کۆتایی پێدەهێنێت و وشەی نهێنی و بەستنەوەی تێلێگرام و چوونەژوورەوە بە ژمارەی مۆبایل و هەر هەژمارێکی تری Google لادەبات. دواتر بە کۆدێک دەچیتە ژوورەوە کە بۆ ئەم ئیمەیڵە دەنێردرێت.',
    title: 'ئیمەیڵی بەڕێوەبەری سەرەکی پشتڕاست کرایەوە',
    body: (n: number) =>
      `ئەمە یەکەم پشتڕاستکردنەوەی ئەم ئیمەیڵەیە، بۆیە بۆ پاراستن هەموو ڕێگایەکی تری چوونە ناو هەژمارەکە داخرا: دانیشتنەکانی تر (${n})، وشەی نهێنی، بەستنەوەی تێلێگرام، چوونەژوورەوە بە ژمارەی مۆبایل و هەر هەژمارێکی تری Google. لەمەودوا بە کۆدێک بچۆ ژوورەوە کە بۆ ئەم ئیمەیڵە دەنێردرێت؛ دەتوانیت لە ڕێکخستنەکانەوە وشەی نهێنییەکی نوێ دابنێیت.`,
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

/** After a sign-in: says it in a toast that stays until dismissed. Silent when the answer carries no first proof. */
export function announceOwnerFirstProof(res: unknown): void {
  const proof = ownerFirstProofOf(res);
  if (!proof) return;
  const t = ownerFirstProofText(proof);
  toast.info(t.title, { description: t.body, duration: Infinity, id: 'owner-first-proof' });
}
