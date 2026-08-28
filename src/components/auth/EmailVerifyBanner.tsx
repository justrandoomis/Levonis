import React, { useCallback, useEffect, useRef, useState } from 'react';
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

  // Resend state
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'not_configured' | 'too_many' | 'error'>('idle');
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Confirm-token state (?verify_email=…)
  const [token] = useState<string>(() => tokenFromUrl());
  const [confirmState, setConfirmState] = useState<'idle' | 'confirming' | 'done' | 'failed'>('idle');

  const loadStatus = useCallback(() => {
    api
      .get<VerifyStatus>('/api/auth/verify-email/status')
      .then((data) => setStatus({ email: data.email, verified: data.verified, emailConfigured: data.emailConfigured }))
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
      <div className="mx-3 mt-3 rounded-2xl border border-yellow-700/50 bg-[#171304] p-4 text-sm">
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
      <div className="mx-3 mt-3 rounded-2xl border border-green-700/50 bg-[#06170a] p-4 text-sm flex items-start justify-between gap-3">
        <p className="text-green-400">{t.confirmed}</p>
        <button type="button" onClick={() => setHidden(true)} aria-label={t.dismiss} className="text-gray-400 px-1">
          ×
        </button>
      </div>
    );
  }

  // Ordinary banner: only for a signed-in, confirmed-unverified account.
  if (hidden || !isLoaded || !isAuthenticated || !status || status.verified) return null;

  return (
    <div className="mx-3 mt-3 rounded-2xl border border-yellow-700/40 bg-[#171304] p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-gray-200">{t.unverified}</p>
        <button type="button" onClick={() => setHidden(true)} aria-label={t.dismiss} className="text-gray-400 px-1">
          ×
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
