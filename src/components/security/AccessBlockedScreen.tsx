/**
 * «تم رصد نشاط مشبوه وحظر هذا الوصول» — the full-screen notice a blocked
 * browser sees on the pages the app draws (the Worker's own documents get the
 * same three sentences as a page: worker/lib/deception/strings.ts). It names
 * the reference to quote and nothing else: no reason, no expiry, no kind of
 * block. The sign-in link appears only when nobody is signed in — signing in
 * stays reachable, so the owner or a customer on a shared network can.
 *
 * The three languages are stacked, Arabic first, each its own wording.
 */
import { ShieldAlert } from 'lucide-react';

export const ACCESS_BLOCKED_TEXT = {
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

const LANGS = [
  { lang: 'ar', dir: 'rtl' },
  { lang: 'ckb', dir: 'rtl' },
  { lang: 'en', dir: 'ltr' },
] as const;

export default function AccessBlockedScreen({ reference, signedIn }: { reference: string; signedIn: boolean }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="access-blocked-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-canvas px-4 py-8 text-text-primary"
    >
      <div className="w-full max-w-lg rounded-2xl border border-border-subtle bg-surface-raised p-5 shadow-2xl">
        <div className="mb-3 flex justify-center text-amber-400">
          <ShieldAlert className="h-10 w-10" aria-hidden="true" />
        </div>
        {LANGS.map(({ lang, dir }, i) => (
          <section key={lang} lang={lang} dir={dir} className={`py-3 ${i > 0 ? 'border-t border-border-subtle' : ''}`}>
            <h2 id={i === 0 ? 'access-blocked-title' : undefined} className="text-base font-semibold leading-snug">
              {ACCESS_BLOCKED_TEXT.title[lang]}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">{ACCESS_BLOCKED_TEXT.mistake[lang]}</p>
            {reference && (
              <p className="mt-1 text-sm text-amber-300">
                {ACCESS_BLOCKED_TEXT.reference[lang]}: <bdi className="font-mono">{reference}</bdi>
              </p>
            )}
            {!signedIn && (
              <a href="/auth" className="mt-2 inline-block text-sm text-sky-300 underline">
                {ACCESS_BLOCKED_TEXT.signIn[lang]}
              </a>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
