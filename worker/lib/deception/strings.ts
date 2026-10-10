/**
 * WHAT THE BLOCKED PARTY AND THE OWNER ARE TOLD (design §4.4, §4.5), in
 * Arabic, English and Sorani — every `ckb` its own wording, never the Arabic
 * copied across (DECISIONS row 183).
 *
 * THE BLOCK ANSWER NEVER SAYS WHY: no reason, no score, no expiry, no kind of
 * block, and never the canary that triggered it — only that suspicious
 * activity was detected, and a reference to quote.
 */
import type { Context } from 'hono';
import type { AppContext } from '../types';

export const BLOCK_STRINGS = {
  title: {
    ar: 'تم رصد نشاط مشبوه وحظر هذا الوصول',
    en: 'Suspicious activity was detected and this access has been blocked',
    ckb: 'چالاکییەکی گوماناوی دەستنیشان کرا و ئەم دەستگەیشتنە قەدەغە کرا',
  },
  reference: { ar: 'الرقم المرجعي', en: 'Reference', ckb: 'ژمارەی ئاماژە' },
  mistake: {
    ar: 'إن كنت ترى أن هذا خطأ، تواصل معنا واذكر هذا الرقم.',
    en: 'If you believe this is a mistake, contact us and quote this reference.',
    ckb: 'ئەگەر پێت وایە ئەمە هەڵەیە، پەیوەندیمان پێوە بکە و ئەم ژمارەیە بنێرە.',
  },
  signIn: { ar: 'لديك حساب؟ سجّل الدخول', en: 'Have an account? Sign in', ckb: 'هەژمارت هەیە؟ بچۆ ژوورەوە' },
} as const;

/** The owner's bell — no figures, no address, no token. */
export const DECEPTION_BELL = {
  blocked: {
    title: {
      ar: 'رُصدت محاولة اختراق وحُظر صاحبها',
      en: 'A break-in attempt was detected and blocked',
      ckb: 'هەوڵێکی دزەکردن دەستنیشان کرا و خاوەنەکەی قەدەغە کرا',
    },
    body: {
      ar: 'طلب أحدهم ملفاً وهمياً أو استعمل بيانات فخّ، فأُعطي بيانات مزيّفة وحُظر وصوله. افتح «الأمان» للتفاصيل أو لرفع الحظر.',
      en: 'Someone requested a decoy file or used trap data; they were served fake data and blocked. Open Security for the details or to lift the block.',
      ckb: 'کەسێک داوای پەڕگەیەکی ساختەی کرد یان زانیاریی تەڵەی بەکارهێنا؛ زانیاریی ساختەی پێدرا و دەستگەیشتنی قەدەغە کرا. بۆ وردەکاری یان لابردنی قەدەغەکردن «ئاسایش» بکەرەوە.',
    },
  },
  ownCanary: {
    title: {
      ar: 'استُعملت بيانات فخّ من حسابك',
      en: 'Trap data was used from your account',
      ckb: 'زانیاریی تەڵە لە هەژمارەکەتەوە بەکارهات',
    },
    body: {
      ar: 'لم يُحظر حسابك. إن لم تكن أنت، فأنهِ الجلسات الأخرى من «الإعدادات» وغيّر كلمة المرور.',
      en: 'Your account was not blocked. If this was not you, end the other sessions in Settings and change your password.',
      ckb: 'هەژمارەکەت قەدەغە نەکرا. ئەگەر تۆ نەبوویت، لە «ڕێکخستنەکان» دانیشتنەکانی تر کۆتایی پێبهێنە و وشەی نهێنییەکەت بگۆڕە.',
    },
  },
  ownDecoy: {
    title: {
      ar: 'فُتح ملف وهمي من حسابك',
      en: 'A decoy file was opened from your account',
      ckb: 'پەڕگەیەکی ساختە لە هەژمارەکەتەوە کرایەوە',
    },
    body: {
      ar: 'لم يُحظر حسابك ولم تُعطَ أي بيانات. إن لم تكن أنت، فأنهِ الجلسات الأخرى من «الإعدادات» وغيّر كلمة المرور.',
      en: 'Your account was not blocked and nothing was served. If this was not you, end the other sessions in Settings and change your password.',
      ckb: 'هەژمارەکەت قەدەغە نەکرا و هیچ زانیارییەک نەدرا. ئەگەر تۆ نەبوویت، لە «ڕێکخستنەکان» دانیشتنەکانی تر کۆتایی پێبهێنە و وشەی نهێنییەکەت بگۆڕە.',
    },
  },
} as const;

export const ACCESS_BLOCKED = 'ACCESS_BLOCKED';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The JSON body of a blocked API request. */
export function blockedJson(reference: string) {
  return {
    success: false,
    code: ACCESS_BLOCKED,
    error: `${BLOCK_STRINGS.title.ar}. / ${BLOCK_STRINGS.title.en}.`,
    details: {
      reference,
      message: {
        ar: `${BLOCK_STRINGS.title.ar}. ${BLOCK_STRINGS.mistake.ar}`,
        en: `${BLOCK_STRINGS.title.en}. ${BLOCK_STRINGS.mistake.en}`,
        ckb: `${BLOCK_STRINGS.title.ckb}. ${BLOCK_STRINGS.mistake.ckb}`,
      },
    },
  };
}

/** The block page: RTL first, the three languages stacked, the reference, no script, its own policy. */
export function blockedHtml(reference: string, offerSignIn: boolean): string {
  const block = (lang: 'ar' | 'en' | 'ckb', dir: 'rtl' | 'ltr') =>
    `<section lang="${lang}" dir="${dir}"><h1>${esc(BLOCK_STRINGS.title[lang])}</h1><p>${esc(BLOCK_STRINGS.mistake[lang])}</p><p class="ref">${esc(BLOCK_STRINGS.reference[lang])}: <bdi>${esc(reference)}</bdi></p>${offerSignIn ? `<p><a href="/auth">${esc(BLOCK_STRINGS.signIn[lang])}</a></p>` : ''}</section>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(BLOCK_STRINGS.title.en)}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0d;color:#f4f4f5;font-family:system-ui,sans-serif}main{max-width:560px;padding:24px 16px}section{padding:16px 0;border-bottom:1px solid #27272a}section:last-child{border:0}h1{font-size:20px;margin:0 0 8px}p{margin:6px 0;color:#d4d4d8;line-height:1.6}.ref{font-family:ui-monospace,monospace;color:#fbbf24}a{color:#93c5fd}</style></head><body><main>${block('ar', 'rtl')}${block('ckb', 'rtl')}${block('en', 'ltr')}</main></body></html>`;
}

const BLOCK_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The block answer for this request: JSON under /api, the page elsewhere. 403, no-store. */
export function blockedResponse(c: Context<AppContext>, reference: string, offerSignIn: boolean): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/files/')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(blockedJson(reference)), { status: 403, headers });
  }
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', BLOCK_CSP);
  return new Response(c.req.method === 'HEAD' ? null : blockedHtml(reference, offerSignIn), { status: 403, headers });
}
