import { useCallback, useEffect, useState } from 'react';
import { MailCheck } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { refusalText } from '../../lib/refusalStrings';
import { Button } from '../ui/Button';

/**
 * «أكّد بريدك لفتح بيانات التكلفة» — THE WAY OUT FOR THE OWNER WHOSE ADDRESS IS
 * NOT VERIFIED YET (DECISIONS row 185, amendment of 2026-10-08).
 *
 * Cost is honoured only for the INITIAL_ADMIN_EMAIL admin row whose address is
 * verified (the owner chose the most secure option). Before that, the server
 * refuses every cost surface with OWNER_EMAIL_UNVERIFIED and sends the
 * `owner_email_unverified` hint on the owner's own session. The cost screens
 * show this card in place of the cost — never a cost value, never a lock with
 * no key.
 *
 * ONE PRIMARY ACTION: send the existing verification email
 * (POST /api/auth/verify-email/send; the link it carries is confirmed by
 * EmailVerifyBanner, which then refreshes the session). A quiet text action
 * re-reads the session for an owner who verified in another tab, and the card
 * also re-reads it whenever the window regains focus — the server reads
 * `email_verified_at` fresh on every request, so cost opens on the next read
 * with no new sign-in and no redeploy. Connecting Google on the same address
 * (Settings, POST /api/auth/google/link) verifies it too, as does a sign-in
 * with an already-connected Google; the refusal sentence says so.
 *
 * Shown only where the hint (`=== true`) or the refusal code says so; it reads
 * nothing but the account's own session and holds nothing in browser storage.
 */

type SendState = 'idle' | 'sent' | 'not_configured' | 'too_many' | 'failed' | 'still_unverified';

const STRINGS = {
  ar: {
    title: 'أكّد بريدك لفتح بيانات التكلفة',
    compact: 'التكلفة مخفية حتى تؤكّد بريد حسابك.',
    send: 'إرسال رسالة التأكيد',
    sending: 'جارٍ الإرسال…',
    recheck: 'أكّدته — تحقّق الآن',
    checking: 'جارٍ التحقق…',
    sent: (email: string) =>
      `أُرسلت رسالة التأكيد إلى ${email}. افتحها واضغط «تأكيد بريدي الآن»، وتنفتح بيانات التكلفة هنا عند عودتك.`,
    notConfigured: (email: string) =>
      `لا يمكن إرسال البريد من الخادم حاليًا. اربط Google على ${email} من إعدادات حسابك ليتأكد البريد فورًا.`,
    tooMany: 'محاولات كثيرة — انتظر قليلًا ثم أعد المحاولة.',
    failed: 'تعذّر الإرسال. تحقّق من اتصالك وأعد المحاولة.',
    still: 'لم يُؤكَّد البريد بعد. افتح رسالة التأكيد واضغط زرّها، ثم عُد إلى هنا.',
  },
  en: {
    title: 'Verify your email to open cost data',
    compact: 'Cost stays hidden until you verify your account’s email.',
    send: 'Send verification email',
    sending: 'Sending…',
    recheck: 'I’ve verified — check now',
    checking: 'Checking…',
    sent: (email: string) =>
      `Verification email sent to ${email}. Open it and press “Confirm my email now”; cost data opens here when you come back.`,
    notConfigured: (email: string) =>
      `Email can’t be sent from the server right now. Connect Google on ${email} in your account settings to verify it at once.`,
    tooMany: 'Too many attempts — wait a moment and try again.',
    failed: 'Could not send. Check your connection and try again.',
    still: 'Not verified yet. Open the verification email and press its button, then come back here.',
  },
  ckb: {
    title: 'ئیمەیڵەکەت پشتڕاست بکەرەوە بۆ کردنەوەی زانیارییەکانی تێچوو',
    compact: 'تێچوو شاردراوە دەمێنێتەوە تا ئیمەیڵی هەژمارەکەت پشتڕاست دەکەیتەوە.',
    send: 'ناردنی ئیمەیڵی پشتڕاستکردنەوە',
    sending: 'دەنێردرێت…',
    recheck: 'پشتڕاستم کردەوە — ئێستا بپشکنە',
    checking: 'دەپشکنرێت…',
    sent: (email: string) =>
      `ئیمەیڵی پشتڕاستکردنەوە بۆ ${email} نێردرا. بیکەرەوە و «ئێستا ئیمەیڵەکەم پشتڕاست بکەرەوە» دابگرە؛ کاتێک دەگەڕێیتەوە زانیارییەکانی تێچوو لێرە دەکرێنەوە.`,
    notConfigured: (email: string) =>
      `لە ئێستادا ناتوانرێت ئیمەیڵ لە سێرڤەرەوە بنێردرێت. لە ڕێکخستنەکانی هەژمارەکەتەوە Google لەسەر ${email} ببەستەوە بۆ ئەوەی ئیمەیڵەکە یەکسەر پشتڕاست بکرێتەوە.`,
    tooMany: 'هەوڵی زۆر — کەمێک چاوەڕوان بە و دووبارە هەوڵبدەرەوە.',
    failed: 'نەتوانرا بنێردرێت. پەیوەندییەکەت بپشکنە و دووبارە هەوڵبدەرەوە.',
    still: 'ئیمەیڵەکە هێشتا پشتڕاست نەکراوەتەوە. ئیمەیڵی پشتڕاستکردنەوە بکەرەوە و دوگمەکەی دابگرە، پاشان بگەڕێوە ئێرە.',
  },
} as const;

export interface OwnerCostVerifyCardProps {
  /** A single quiet row inside a working screen (product form, inventory) instead of the full card. */
  compact?: boolean;
}

export default function OwnerCostVerifyCard({ compact = false }: OwnerCostVerifyCardProps) {
  const { user, refreshUser } = useAuth();
  const { lang, dir } = useLanguage();
  const t = STRINGS[lang] ?? STRINGS.ar;
  const [state, setState] = useState<SendState>('idle');
  const [checking, setChecking] = useState(false);
  const email = user?.email ?? '';

  /**
   * Back from the inbox (another tab, another app): read the session again.
   * The server answers from the row as it is now, so a confirmed address turns
   * this card into the cost screen without a reload.
   */
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState === 'visible') void refreshUser();
    };
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);
    return () => {
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
    };
  }, [refreshUser]);

  const send = useCallback(async () => {
    try {
      const res = await api.post<{ verified?: boolean }>('/api/auth/verify-email/send');
      // Already verified (another tab, a Google sign-in): the session just needs re-reading.
      if (res?.verified === true) {
        await refreshUser();
        return;
      }
      setState('sent');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 503 || e.code === 'EMAIL_NOT_CONFIGURED')) setState('not_configured');
      else if (e instanceof ApiError && e.status === 429) setState('too_many');
      else setState('failed');
    }
  }, [refreshUser]);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      await refreshUser();
    } finally {
      setChecking(false);
    }
    // Still mounted means still unverified: say so instead of doing nothing.
    setState('still_unverified');
  }, [refreshUser]);

  const message =
    state === 'sent'
      ? t.sent(email)
      : state === 'not_configured'
        ? t.notConfigured(email)
        : state === 'too_many'
          ? t.tooMany
          : state === 'failed'
            ? t.failed
            : state === 'still_unverified'
              ? t.still
              : '';
  const tone = state === 'failed' || state === 'too_many' ? 'text-danger' : 'text-text-secondary';

  if (compact) {
    return (
      <div dir={dir} data-owner-verify="compact" className="lv-surface my-3 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <MailCheck aria-hidden className="h-4 w-4 shrink-0 text-warning" />
        <p className="min-w-0 flex-1 text-ui-sm text-text-secondary">{t.compact}</p>
        <Button variant="secondary" size="sm" onClick={send} loadingLabel={t.sending}>
          {t.send}
        </Button>
        <p role="status" aria-live="polite" className={`basis-full text-ui-xs ${tone} empty:hidden`}>
          {message}
        </p>
      </div>
    );
  }

  return (
    <section
      dir={dir}
      data-owner-verify="card"
      aria-labelledby="owner-verify-title"
      className="lv-surface mx-auto my-8 max-w-[34rem] p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border-subtle bg-surface-raised text-warning"
        >
          <MailCheck className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id="owner-verify-title" className="text-ui-lg font-bold text-text-primary">
            {t.title}
          </h2>
          <p className="mt-1.5 text-ui-sm leading-[1.8] text-text-secondary">
            {refusalText('OWNER_EMAIL_UNVERIFIED', lang)}
          </p>
          {email && (
            <p className="mt-1 text-ui-xs text-text-muted">
              <bdi dir="ltr">{email}</bdi>
            </p>
          )}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={send} loadingLabel={t.sending}>
          {t.send}
        </Button>
        <Button variant="ghost" size="sm" onClick={recheck} loading={checking} loadingLabel={t.checking}>
          {t.recheck}
        </Button>
      </div>
      <p role="status" aria-live="polite" className={`mt-3 text-ui-xs leading-[1.8] ${tone} empty:hidden`}>
        {message}
      </p>
    </section>
  );
}
