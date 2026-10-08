import React, { useCallback, useEffect, useRef, useState } from 'react';
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
 * (POST /api/auth/verify-email/send). Its link is confirmed by
 * EmailVerifyBanner, and for the owner's address only from a session of this
 * same account (VERIFY_SIGN_IN_REQUIRED otherwise), so the sentence says to
 * open it in this browser. After a send the button waits a minute and becomes
 * «Resend»: every send cancels the previous link, so a second press must not
 * be the reason the first email fails. A quiet text action asks the server
 * directly (GET /api/auth/verify-email/status, read fresh from the row) for an
 * owner who verified in another tab, and the card also re-reads the session
 * whenever the window regains focus — the server reads `email_verified_at`
 * fresh on every request, so cost opens on the next read with no new sign-in
 * and no redeploy. A sign-in with Google ALREADY connected to the same address
 * stamps it too; there is no Google link button in Settings, so nothing here
 * sends the owner looking for one.
 *
 * The status line is always in the accessibility tree (visually hidden while
 * empty), so "sent" and "failed" are announced when they appear.
 *
 * Shown only where the hint (`=== true`) or the refusal code says so; it reads
 * nothing but the account's own session and holds nothing in browser storage.
 */

const RESEND_COOLDOWN_S = 60;

type SendState =
  | 'idle'
  | 'sent'
  | 'not_configured'
  | 'too_many'
  | 'failed'
  | 'still_unverified'
  | 'check_failed';

type Email = React.ReactNode;

const STRINGS = {
  ar: {
    title: 'أكّد بريدك لفتح بيانات التكلفة',
    compact: 'التكلفة مخفية حتى تؤكّد بريد حسابك.',
    send: 'إرسال رسالة التأكيد',
    resend: 'إعادة إرسال الرسالة',
    sending: 'جارٍ الإرسال…',
    cooldown: (s: number) => `يمكن إعادة الإرسال بعد ${s} ثانية`,
    recheck: 'أكّدته — تحقّق الآن',
    checking: 'جارٍ التحقق…',
    sent: (e: Email) => (
      <>
        أُرسلت رسالة التأكيد إلى {e}. افتحها في هذا المتصفح وأنت مسجّل الدخول بهذا الحساب، واضغط «تأكيد بريدي الآن»؛
        تنفتح بيانات التكلفة هنا عند عودتك. الرابط في أحدث رسالة وحده يعمل.
      </>
    ),
    notConfigured: (e: Email) => (
      <>
        خدمة البريد غير مهيّأة على الخادم بعد (EMAIL_API_KEY و EMAIL_FROM)، فلا يمكن إرسال رسالة التأكيد الآن. وإن كان
        حساب Google مربوطًا بـ {e} فتسجيل الدخول به يؤكّد البريد.
      </>
    ),
    tooMany: 'محاولات كثيرة — انتظر قليلًا ثم أعد المحاولة.',
    failed: 'تعذّر الإرسال. تحقّق من اتصالك وأعد المحاولة.',
    still: 'لم يُؤكَّد البريد بعد. افتح رسالة التأكيد واضغط زرّها، ثم عُد إلى هنا.',
    checkFailed: 'تعذّر التحقق الآن. تحقّق من اتصالك وأعد المحاولة.',
    afterSave: 'بيانات التكلفة مفتوحة الآن. احفظ تعديلاتك لتظهر حقول التكلفة بقيمها المحفوظة — هذا الحفظ لا يغيّر التكلفة المخزّنة.',
  },
  en: {
    title: 'Verify your email to open cost data',
    compact: 'Cost stays hidden until you verify your account’s email.',
    send: 'Send verification email',
    resend: 'Resend email',
    sending: 'Sending…',
    cooldown: (s: number) => `You can resend in ${s}s`,
    recheck: 'I’ve verified — check now',
    checking: 'Checking…',
    sent: (e: Email) => (
      <>
        Verification email sent to {e}. Open it in this browser, signed in to this account, and press “Confirm my email
        now”; cost data opens here when you come back. Only the link in the newest email works.
      </>
    ),
    notConfigured: (e: Email) => (
      <>
        The server has no email service set up yet (EMAIL_API_KEY and EMAIL_FROM), so the verification email cannot be
        sent now. If Google is already connected to {e}, signing in with it verifies the address.
      </>
    ),
    tooMany: 'Too many attempts — wait a moment and try again.',
    failed: 'Could not send. Check your connection and try again.',
    still: 'Not verified yet. Open the verification email and press its button, then come back here.',
    checkFailed: 'Could not check right now. Check your connection and try again.',
    afterSave: 'Cost data is open now. Save your changes and the cost fields appear with their stored values — this save leaves the stored cost as it is.',
  },
  ckb: {
    title: 'ئیمەیڵەکەت پشتڕاست بکەرەوە بۆ کردنەوەی زانیارییەکانی تێچوو',
    compact: 'تێچوو شاردراوە دەمێنێتەوە تا ئیمەیڵی هەژمارەکەت پشتڕاست دەکەیتەوە.',
    send: 'ناردنی ئیمەیڵی پشتڕاستکردنەوە',
    resend: 'دووبارە ناردنەوەی ئیمەیڵ',
    sending: 'دەنێردرێت…',
    cooldown: (s: number) => `دووبارە ناردن دوای ${s} چرکە`,
    recheck: 'پشتڕاستم کردەوە — ئێستا بپشکنە',
    checking: 'دەپشکنرێت…',
    sent: (e: Email) => (
      <>
        ئیمەیڵی پشتڕاستکردنەوە بۆ {e} نێردرا. لەم وێبگەڕەدا و بەم هەژمارەوە کە تێیدا چوویتەتە ژوورەوە بیکەرەوە و «ئێستا
        ئیمەیڵەکەم پشتڕاست بکەرەوە» دابگرە؛ کاتێک دەگەڕێیتەوە زانیارییەکانی تێچوو لێرە دەکرێنەوە. تەنها بەستەری نوێترین
        ئیمەیڵ کار دەکات.
      </>
    ),
    notConfigured: (e: Email) => (
      <>
        خزمەتگوزاری ئیمەیڵ هێشتا لەسەر سێرڤەرەکە ڕێکنەخراوە (EMAIL_API_KEY و EMAIL_FROM)، بۆیە ئێستا ناتوانرێت ئیمەیڵی
        پشتڕاستکردنەوە بنێردرێت. ئەگەر Google پێشتر بەم ئیمەیڵە بەستراوە: {e}، چوونەژوورەوە بە Google ئیمەیڵەکە پشتڕاست
        دەکاتەوە.
      </>
    ),
    tooMany: 'هەوڵی زۆر — کەمێک چاوەڕوان بە و دووبارە هەوڵبدەرەوە.',
    failed: 'نەتوانرا بنێردرێت. پەیوەندییەکەت بپشکنە و دووبارە هەوڵبدەرەوە.',
    still: 'ئیمەیڵەکە هێشتا پشتڕاست نەکراوەتەوە. ئیمەیڵی پشتڕاستکردنەوە بکەرەوە و دوگمەکەی دابگرە، پاشان بگەڕێوە ئێرە.',
    checkFailed: 'ئێستا نەتوانرا بپشکنرێت. پەیوەندییەکەت بپشکنە و دووبارە هەوڵبدەرەوە.',
    afterSave: 'زانیارییەکانی تێچوو ئێستا کراونەتەوە. گۆڕانکارییەکانت پاشەکەوت بکە بۆ ئەوەی خانەکانی تێچوو بە نرخە هەڵگیراوەکانیانەوە دەربکەون — ئەم پاشەکەوتکردنە تێچووی هەڵگیراو ناگۆڕێت.',
  },
} as const;

interface VerifyStatus {
  verified?: boolean;
  emailConfigured?: boolean;
}

export interface OwnerCostVerifyCardProps {
  /** A single quiet row inside a working screen (product form, inventory, pricing) instead of the full card. */
  compact?: boolean;
}

export default function OwnerCostVerifyCard({ compact = false }: OwnerCostVerifyCardProps) {
  const { user, refreshUser } = useAuth();
  const { lang, dir } = useLanguage();
  const t = STRINGS[lang] ?? STRINGS.ar;
  const [state, setState] = useState<SendState>('idle');
  const [checking, setChecking] = useState(false);
  const [sentOnce, setSentOnce] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const email = user?.email ?? '';
  const emailNode = <bdi dir="ltr">{email}</bdi>;

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

  /**
   * Whether a message CAN be sent, before anyone presses the button: with no
   * email service the honest state is shown up front, not after a failed press.
   * A failed read changes nothing — the button then finds out by itself.
   */
  useEffect(() => {
    let live = true;
    api
      .get<VerifyStatus>('/api/auth/verify-email/status')
      .then((s) => {
        if (live && s?.emailConfigured === false) setState('not_configured');
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    },
    []
  );

  const startCooldown = useCallback(() => {
    setCooldown(RESEND_COOLDOWN_S);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1 && cooldownTimer.current) {
          clearInterval(cooldownTimer.current);
          cooldownTimer.current = null;
        }
        return Math.max(0, s - 1);
      });
    }, 1000);
  }, []);

  const send = useCallback(async () => {
    if (cooldown > 0) return;
    try {
      const res = await api.post<{ verified?: boolean }>('/api/auth/verify-email/send');
      // Already verified (another tab, a Google sign-in): the session just needs re-reading.
      if (res?.verified === true) {
        await refreshUser();
        return;
      }
      setState('sent');
      setSentOnce(true);
      startCooldown();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 503 || e.code === 'EMAIL_NOT_CONFIGURED')) setState('not_configured');
      else if (e instanceof ApiError && e.status === 429) setState('too_many');
      else setState('failed');
    }
  }, [cooldown, refreshUser, startCooldown]);

  /**
   * «I've verified — check now» asks the SERVER, from the row as it is now —
   * not the session re-read, which swallows a network error and would let a
   * failed request read as "not verified yet".
   */
  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const s = await api.get<VerifyStatus>('/api/auth/verify-email/status');
      if (s?.verified === true) {
        await refreshUser();
        return;
      }
      setState('still_unverified');
    } catch {
      setState('check_failed');
    } finally {
      setChecking(false);
    }
  }, [refreshUser]);

  const message: React.ReactNode =
    state === 'sent'
      ? t.sent(emailNode)
      : state === 'not_configured'
        ? t.notConfigured(emailNode)
        : state === 'too_many'
          ? t.tooMany
          : state === 'failed'
            ? t.failed
            : state === 'still_unverified'
              ? t.still
              : state === 'check_failed'
                ? t.checkFailed
                : null;
  const tone = state === 'failed' || state === 'too_many' || state === 'check_failed' ? 'text-danger' : 'text-text-secondary';
  const canSend = state !== 'not_configured';
  const sendLabel = sentOnce ? t.resend : t.send;
  const waitNote = cooldown > 0 ? <span className="text-ui-xs text-text-muted">{t.cooldown(cooldown)}</span> : null;

  if (compact) {
    return (
      <div dir={dir} data-owner-verify="compact" className="lv-surface my-3 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <MailCheck aria-hidden className="h-4 w-4 shrink-0 text-warning" />
        <p className="min-w-0 flex-1 text-ui-sm text-text-secondary">{t.compact}</p>
        {canSend && (
          <Button variant="secondary" size="sm" onClick={send} disabled={cooldown > 0} loadingLabel={t.sending}>
            {sendLabel}
          </Button>
        )}
        {waitNote}
        <p role="status" aria-live="polite" className={message ? `basis-full text-ui-xs leading-[1.8] ${tone}` : 'sr-only'}>
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
        {canSend && (
          <Button variant="primary" onClick={send} disabled={cooldown > 0} loadingLabel={t.sending}>
            {sendLabel}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={recheck} loading={checking} loadingLabel={t.checking}>
          {t.recheck}
        </Button>
        {waitNote}
      </div>
      <p role="status" aria-live="polite" className={message ? `mt-3 text-ui-xs leading-[1.8] ${tone}` : 'sr-only'}>
        {message}
      </p>
    </section>
  );
}

/**
 * The owner verified while a product form with unsaved edits was open: cost is
 * now allowed, but the form was read without it. Its save keeps every stored
 * cost (`cost_loaded: false`) and the read-back brings the cost fields in.
 */
export function CostOpensAfterSave() {
  const { lang, dir } = useLanguage();
  const t = STRINGS[lang] ?? STRINGS.ar;
  return (
    <div dir={dir} data-owner-verify="after-save" className="lv-surface my-3 flex items-start gap-3 px-3 py-2.5">
      <MailCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <p className="min-w-0 flex-1 text-ui-sm leading-[1.8] text-text-secondary">{t.afterSave}</p>
    </div>
  );
}
