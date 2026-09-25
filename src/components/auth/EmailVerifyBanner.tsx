import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';

/**
 * Email verification banner (final-phase §3A).
 *
 * Two jobs, one component:
 * 1. When the signed-in user's email is unverified, show a banner with an
 *    honest resend button (cooldown; explicit 503 state when the email
 *    service is not configured).
 * 2. When the page URL carries ?verify_email=<token> (the link from the
 *    verification email), render the explicit confirm card. The GET that
 *    opened the page consumed NOTHING — only the button's POST
 *    /api/auth/verify-email/confirm consumes the one-use token, so mail
 *    scanners following links can never verify an address.
 *
 * Mount once in the app layout (above the routed content).
 */

const RESEND_COOLDOWN_S = 60;

const STRINGS = {
  ar: {
    unverified: 'بريدك الإلكتروني غير مؤكد بعد. أكّده لتصلك فواتير طلباتك ورسائل الأمان.',
    resend: 'إرسال رسالة التأكيد',
    resending: 'جارٍ الإرسال…',
    sent: 'أُرسلت رسالة التأكيد. افتح بريدك واضغط زر التأكيد داخل الصفحة.',
    cooldown: (s: number) => `يمكن إعادة الإرسال بعد ${s} ثانية`,
    notConfigured: 'خدمة البريد غير مهيأة بعد على الخادم — لا يمكن إرسال رسالة التأكيد حاليًا. حاول لاحقًا أو تواصل مع الدعم.',
    tooMany: 'محاولات كثيرة — انتظر قليلًا ثم أعد المحاولة.',
    sendFailed: 'تعذر إرسال رسالة التأكيد. تحقق من اتصالك وأعد المحاولة.',
    confirmTitle: 'تأكيد البريد الإلكتروني',
    confirmHint: 'اضغط الزر لتأكيد بريدك. فتح الرابط وحده لا يؤكد شيئًا.',
    confirmCta: 'تأكيد بريدي الآن',
    confirming: 'جارٍ التأكيد…',
    confirmed: 'تم تأكيد بريدك الإلكتروني بنجاح.',
    confirmFailed: 'رابط التأكيد غير صالح أو منتهي الصلاحية.',
    confirmFailedHint: 'يمكنك طلب رسالة تأكيد جديدة من حسابك.',
    dismiss: 'إغلاق',
  },
  en: {
    unverified: 'Your email is not verified yet. Verify it to receive your order invoices and security messages.',
    resend: 'Send verification email',
    resending: 'Sending…',
    sent: 'Verification email sent. Open your inbox and press the confirm button on the page.',
    cooldown: (s: number) => `You can resend in ${s}s`,
    notConfigured: 'The email service is not configured on the server yet — the verification message cannot be sent right now. Try again later or contact support.',
    tooMany: 'Too many attempts — wait a moment and try again.',
    sendFailed: 'The verification email could not be sent. Check your connection and try again.',
    confirmTitle: 'Verify your email',
    confirmHint: 'Press the button to confirm your email. Opening the link alone confirms nothing.',
    confirmCta: 'Confirm my email now',
    confirming: 'Confirming…',
    confirmed: 'Your email has been verified.',
    confirmFailed: 'This verification link is invalid or has expired.',
    confirmFailedHint: 'You can request a new verification email from your account.',
    dismiss: 'Dismiss',
  },
  ckb: {
    unverified: 'ئیمەیڵەکەت هێشتا پشتڕاست نەکراوەتەوە. پشتڕاستی بکەرەوە بۆ وەرگرتنی پسوولەکانت و پەیامە ئەمنییەکان.',
    resend: 'ناردنی ئیمەیڵی پشتڕاستکردنەوە',
    resending: 'دەنێردرێت…',
    sent: 'ئیمەیڵی پشتڕاستکردنەوە نێردرا. ئیمەیڵەکەت بکەرەوە و دوگمەی پشتڕاستکردنەوە لە پەڕەکەدا دابگرە.',
    cooldown: (s: number) => `دووبارە ناردن دوای ${s} چرکە`,
    notConfigured: 'خزمەتگوزاری ئیمەیڵ هێشتا لە سێرڤەرەکە ڕێکنەخراوە — ئێستا ناتوانرێت پەیامی پشتڕاستکردنەوە بنێردرێت. دواتر هەوڵبدەرەوە یان پەیوەندی بە پشتگیری بکە.',
    tooMany: 'هەوڵی زۆر — کەمێک چاوەڕوان بە و دووبارە هەوڵبدەرەوە.',
    sendFailed: 'نەتوانرا ئیمەیڵی پشتڕاستکردنەوە بنێردرێت. پەیوەندییەکەت بپشکنە و دووبارە هەوڵبدەرەوە.',
    confirmTitle: 'پشتڕاستکردنەوەی ئیمەیڵ',
    confirmHint: 'دوگمەکە دابگرە بۆ پشتڕاستکردنەوەی ئیمەیڵەکەت. تەنها کردنەوەی بەستەرەکە هیچ پشتڕاست ناکاتەوە.',
    confirmCta: 'ئێستا ئیمەیڵەکەم پشتڕاست بکەرەوە',
    confirming: 'پشتڕاست دەکرێتەوە…',
    confirmed: 'ئیمەیڵەکەت بە سەرکەوتوویی پشتڕاست کرایەوە.',
    confirmFailed: 'ئەم بەستەری پشتڕاستکردنەوەیە نادروستە یان بەسەرچووە.',
    confirmFailedHint: 'دەتوانیت لە هەژمارەکەتەوە داوای ئیمەیڵێکی نوێی پشتڕاستکردنەوە بکەیت.',
    dismiss: 'داخستن',
  },
} as const;

interface VerifyStatus {
  email: string;
  verified: boolean;
  emailConfigured: boolean;
}

/**
 * DISMISSING IT HAS TO MEAN SOMETHING.
 *
 * `hidden` was component state, and this component is mounted by the app
 * shell — so it remounts on every navigation and the banner came straight
 * back. Pressing × did nothing that lasted longer than a tap, which is the
 * whole of the "مزعجة" complaint: not that the notice exists, but that it
 * cannot be acknowledged.
 *
 * Snoozed rather than dismissed for good, and keyed by ADDRESS: verification
 * still matters, and a different account on the same device has not dismissed
 * anything. A day is long enough to stop nagging and short enough that an
 * unverified inbox is not forgotten.
 *
 * Every read and write is guarded: storage throws in a private window and
 * returns nothing with site data cleared, and a banner must not be what breaks
 * the page it sits on.
 */
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const snoozeKey = (email: string) => `lv.verify-email.snooze.${email.toLowerCase()}`;

function snoozedUntil(email: string): number {
  try {
    const raw = window.localStorage.getItem(snoozeKey(email));
    const until = raw ? Number(raw) : 0;
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

function snooze(email: string, now: number): void {
  try {
    window.localStorage.setItem(snoozeKey(email), String(now + SNOOZE_MS));
  } catch {
    /* a banner must never be the thing that breaks the page */
  }
}

function tokenFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('verify_email') || '';
  } catch {
    return '';
  }
}

function clearTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('verify_email');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch {
    /* leave the URL as-is */
  }
}

export default function EmailVerifyBanner() {
  const { isAuthenticated, isLoaded } = useAuth();
  const { lang } = useLanguage();
  const t = STRINGS[lang] ?? STRINGS.ar;

  const [status, setStatus] = useState<VerifyStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const dismiss = useCallback(() => {
    setHidden(true);
    if (status?.email) snooze(status.email, Date.now());
  }, [status?.email]);

  // Resend state
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'not_configured' | 'too_many' | 'error'>('idle');
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Confirm-token state (?verify_email=…)
  const [token] = useState<string>(() => tokenFromUrl());
  /**
   * THE HEADER IS `position: fixed`, SO THE TOP OF THE PAGE IS UNDER IT.
   *
   * This component is the first child of the scroll container, and on '/' the
   * store header floats over that container at z-100 — so the banner was drawn
   * beneath it and the owner saw the notice "behind the search bar". Header now
   * measures itself into `--app-header-height` (index.css declares it,
   * Product.tsx already maintains it the same way), and this reads that one
   * live value instead of copying Hero's hand-tuned `pt-[132px]` to a second
   * place. The header renders on '/' and nowhere else, so nowhere else pays for
   * the offset.
   */
  const onHomeRoute = useLocation().pathname === '/';
  // A MARGIN, not padding: padding would grow the notice itself by the height
  // of the header and leave its text stranded at the bottom of a 170px box.
  // The clearance belongs between the header and the card, not inside it.
  const headerClearance = onHomeRoute
    ? 'mt-[calc(var(--app-header-height,132px)+0.75rem)]'
    : 'mt-3';
  const [confirmState, setConfirmState] = useState<'idle' | 'confirming' | 'done' | 'failed'>('idle');

  const loadStatus = useCallback(() => {
    api
      .get<VerifyStatus>('/api/auth/verify-email/status')
      // An answer without an address is no answer (W6: a partial body blank-screened every page this banner sits on).
      .then((data) => setStatus(typeof data?.email === 'string' ? { email: data.email, verified: data.verified, emailConfigured: data.emailConfigured } : null))
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (!isLoaded || !isAuthenticated) {
      setStatus(null);
      return;
    }
    loadStatus();
  }, [isLoaded, isAuthenticated, loadStatus]);

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

  const startCooldown = () => {
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
  };

  const resend = async () => {
    if (sendState === 'sending' || cooldown > 0) return;
    setSendState('sending');
    try {
      await api.post('/api/auth/verify-email/send');
      // Server confirmed the request was accepted — only now show "sent".
      setSendState('sent');
      startCooldown();
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setSendState('not_configured');
      else if (e instanceof ApiError && e.status === 429) setSendState('too_many');
      else setSendState('error');
    }
  };

  const confirm = async () => {
    if (confirmState === 'confirming' || confirmState === 'done') return;
    setConfirmState('confirming');
    try {
      await api.post('/api/auth/verify-email/confirm', { token });
      setConfirmState('done');
      clearTokenFromUrl();
      if (isAuthenticated) loadStatus();
    } catch {
      setConfirmState('failed');
    }
  };

  // ---------------------------------------------------------------- render

  // Confirm card takes precedence: the user followed the email link.
  if (token && confirmState !== 'done') {
    return (
      <div className={`${headerClearance} mx-3 rounded-2xl border border-warning/30 bg-warning/[0.08] p-4 text-sm`}>
        <p className="font-bold text-yellow-500 mb-1">{t.confirmTitle}</p>
        {confirmState === 'failed' ? (
          <>
            <p className="text-red-400 mb-1">{t.confirmFailed}</p>
            <p className="text-gray-400 text-xs">{t.confirmFailedHint}</p>
          </>
        ) : (
          <>
            <p className="text-gray-300 mb-3">{t.confirmHint}</p>
            <button
              type="button"
              onClick={confirm}
              disabled={confirmState === 'confirming'}
              className="w-full sm:w-auto rounded-xl bg-yellow-600 px-5 py-2.5 font-bold text-black disabled:opacity-60"
            >
              {confirmState === 'confirming' ? t.confirming : t.confirmCta}
            </button>
          </>
        )}
      </div>
    );
  }

  if (token && confirmState === 'done') {
    return (
      <div className={`${headerClearance} mx-3 rounded-2xl border border-success/30 bg-success/[0.08] p-4 text-sm flex items-start justify-between gap-3`}>
        <p className="text-green-400">{t.confirmed}</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t.dismiss}
          className="shrink-0 w-11 h-11 -m-2 grid place-items-center rounded-lg text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // Ordinary banner: only for a signed-in, confirmed-unverified account.
  if (hidden || !isLoaded || !isAuthenticated || !status || status.verified) return null;
  // Acknowledged on this device, for this address, within the last day.
  if (Date.now() < snoozedUntil(status.email)) return null;

  // Telegram-signup accounts carry a non-routable placeholder address
  // (tg-<id>@telegram.local) until the user adds a real email. "Verify your
  // email" is meaningless for them — no message could ever arrive — so the
  // banner stays silent instead of offering a control that cannot work.
  // (Adding a real email is a separate flow owned by profile/settings.)
  if (status.email.toLowerCase().endsWith('@telegram.local')) return null;

  return (
    <div className={`${headerClearance} mx-3 rounded-2xl border border-warning/25 bg-warning/[0.07] p-3.5 text-sm`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-text-secondary leading-snug">{t.unverified}</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t.dismiss}
          className="shrink-0 w-11 h-11 -m-2 grid place-items-center rounded-lg text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {sendState === 'not_configured' || !status.emailConfigured ? (
          <p className="text-yellow-500 text-xs">{t.notConfigured}</p>
        ) : (
          <>
            <button
              type="button"
              onClick={resend}
              disabled={sendState === 'sending' || cooldown > 0}
              className="rounded-xl bg-yellow-600 px-4 py-2 font-bold text-black disabled:opacity-60"
            >
              {sendState === 'sending' ? t.resending : t.resend}
            </button>
            {cooldown > 0 && <span className="text-gray-400 text-xs">{t.cooldown(cooldown)}</span>}
            {sendState === 'sent' && <span className="text-green-400 text-xs">{t.sent}</span>}
            {sendState === 'too_many' && <span className="text-red-400 text-xs">{t.tooMany}</span>}
            {sendState === 'error' && <span className="text-red-400 text-xs">{t.sendFailed}</span>}
          </>
        )}
      </div>
    </div>
  );
}
