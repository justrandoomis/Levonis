import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send, CheckCircle2, AlertCircle, RefreshCw, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import { api, ApiError, isNotConfigured } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

/**
 * Telegram phone-ownership linking card (final-phase §2), embedded on the
 * Settings/Profile page.
 *
 * Flow: enter phone → server issues a single-use deep link → customer taps
 * "Share my phone number" inside the PRIVATE bot chat → this ORIGINATING
 * session polls status and finalizes with an explicit Confirm. Polling
 * pauses while the tab is hidden and resumes on focus/visibility so the
 * iPad app-switch (Safari → Telegram → back) never loses the pending state.
 * No success UI is shown before the server confirms.
 */

const STRINGS = {
  ar: {
    title: 'ربط تيليغرام والتحقق من الهاتف',
    desc: 'اربط حسابك بمحادثة تيليغرام خاصة للتحقق من ملكية رقم هاتفك واستلام رموز الأمان.',
    linkedAs: 'مرتبط بالرقم',
    verifiedOn: 'تم التحقق في',
    relink: 'إعادة الربط برقم آخر',
    phoneLabel: 'رقم الهاتف (موبايل عراقي)',
    phonePlaceholder: '07XXXXXXXXX',
    next: 'التالي',
    starting: 'جارٍ التجهيز…',
    openTelegram: 'فتح تيليغرام',
    openHint: 'افتح محادثة البوت واضغط زر «مشاركة رقم هاتفي». ثم ارجع إلى هذه الصفحة.',
    waitingShare: 'بانتظار مشاركة جهة الاتصال في تيليغرام…',
    mismatch: 'الرقم الذي شاركته في تيليغرام لا يطابق الرقم المُدخل هنا. تحقق من الرقم وابدأ من جديد.',
    verifiedReady: 'تم التحقق من رقمك في تيليغرام. اضغط «تأكيد الربط» لإكمال العملية من هذا المتصفح.',
    confirm: 'تأكيد الربط',
    confirming: 'جارٍ التأكيد…',
    expired: 'انتهت صلاحية طلب الربط.',
    restart: 'البدء من جديد',
    cancel: 'إلغاء',
    notConfigured: 'ربط تيليغرام غير مُفعّل بعد — لم يهيّئه المسؤول. هذه حالة صادقة وليست عطلًا.',
    loadFailed: 'تعذر تحميل حالة الربط.',
    retry: 'إعادة المحاولة',
    linkExpiresSoon: 'صالح لمدة 15 دقيقة',
    successLinked: 'تم ربط تيليغرام بحسابك بنجاح.',
  },
  en: {
    title: 'Telegram link & phone verification',
    desc: 'Link your account to a private Telegram chat to prove you own your phone number and receive security codes.',
    linkedAs: 'Linked to',
    verifiedOn: 'Verified on',
    relink: 'Re-link with another number',
    phoneLabel: 'Phone number (Iraqi mobile)',
    phonePlaceholder: '07XXXXXXXXX',
    next: 'Next',
    starting: 'Preparing…',
    openTelegram: 'Open Telegram',
    openHint: "Open the bot chat and tap 'Share my phone number'. Then come back to this page.",
    waitingShare: 'Waiting for you to share your contact in Telegram…',
    mismatch: 'The number you shared in Telegram does not match the number entered here. Check the number and start again.',
    verifiedReady: 'Your number is verified in Telegram. Tap "Confirm link" to finish from this browser.',
    confirm: 'Confirm link',
    confirming: 'Confirming…',
    expired: 'The linking request has expired.',
    restart: 'Start over',
    cancel: 'Cancel',
    notConfigured: 'Telegram linking is not configured yet — the administrator has not set it up. This is an honest state, not a bug.',
    loadFailed: 'Could not load the linking status.',
    retry: 'Retry',
    linkExpiresSoon: 'Valid for 15 minutes',
    successLinked: 'Telegram is now linked to your account.',
  },
  ckb: {
    title: 'بەستنەوەی تەلەگرام و پشتڕاستکردنەوەی ژمارە',
    desc: 'هەژمارەکەت ببەستەوە بە گفتوگۆیەکی تایبەتی تەلەگرام بۆ سەلماندنی خاوەندارێتی ژمارەکەت و وەرگرتنی کۆدە ئەمنییەکان.',
    linkedAs: 'بەستراوە بە',
    verifiedOn: 'پشتڕاستکراوەتەوە لە',
    relink: 'دووبارە بەستنەوە بە ژمارەیەکی تر',
    phoneLabel: 'ژمارەی تەلەفۆن (مۆبایلی عێراقی)',
    phonePlaceholder: '07XXXXXXXXX',
    next: 'دواتر',
    starting: 'ئامادەکردن…',
    openTelegram: 'کردنەوەی تەلەگرام',
    openHint: 'گفتوگۆی بۆتەکە بکەرەوە و دوگمەی «هاوبەشکردنی ژمارەی تەلەفۆنم» دابگرە. پاشان بگەڕێوە بۆ ئەم پەڕەیە.',
    waitingShare: 'چاوەڕوانی هاوبەشکردنی کۆنتاکتەکەت لە تەلەگرام…',
    mismatch: 'ئەو ژمارەیەی لە تەلەگرام هاوبەشت کرد لەگەڵ ژمارەی ئێرە یەک ناگرێتەوە. ژمارەکە بپشکنە و دووبارە دەستپێبکەرەوە.',
    verifiedReady: 'ژمارەکەت لە تەلەگرام پشتڕاستکرایەوە. «پشتڕاستکردنەوەی بەستنەوە» دابگرە بۆ تەواوکردن لەم وێبگەڕەوە.',
    confirm: 'پشتڕاستکردنەوەی بەستنەوە',
    confirming: 'پشتڕاستکردنەوە…',
    expired: 'داواکاری بەستنەوەکە بەسەرچوو.',
    restart: 'دەستپێکردنەوە',
    cancel: 'هەڵوەشاندنەوە',
    notConfigured: 'بەستنەوەی تەلەگرام هێشتا ڕێکنەخراوە — بەڕێوەبەر دایننەناوە. ئەمە دۆخێکی ڕاستگۆیانەیە، نەک هەڵە.',
    loadFailed: 'نەتوانرا دۆخی بەستنەوە بار بکرێت.',
    retry: 'هەوڵدانەوە',
    linkExpiresSoon: 'بۆ ماوەی ١٥ خولەک کارایە',
    successLinked: 'تەلەگرام بە هەژمارەکەتەوە بەسترایەوە.',
  },
} as const;

interface StatusChallenge {
  state: string;
  expires_at: string;
  phone_masked: string;
}
interface StatusResp {
  linked: boolean;
  phone_masked: string | null;
  verified_at: string | null;
  challenge: StatusChallenge | null;
}
interface StartResp {
  deep_link: string;
  expires_at: string;
  phone_masked: string;
}

const DEEPLINK_STORE_KEY = 'levo_tg_link';

function loadStoredDeepLink(): { deep_link: string; expires_at: string } | null {
  try {
    const raw = sessionStorage.getItem(DEEPLINK_STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { deep_link?: string; expires_at?: string };
    if (typeof v.deep_link !== 'string' || typeof v.expires_at !== 'string') return null;
    if (new Date(v.expires_at).getTime() <= Date.now()) return null;
    return { deep_link: v.deep_link, expires_at: v.expires_at };
  } catch {
    return null;
  }
}
function storeDeepLink(v: { deep_link: string; expires_at: string } | null) {
  try {
    if (v) sessionStorage.setItem(DEEPLINK_STORE_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(DEEPLINK_STORE_KEY);
  } catch {
    /* storage unavailable — the button simply won't survive a reload */
  }
}

export default function TelegramLink() {
  const { lang } = useLanguage();
  const s = STRINGS[lang] || STRINGS.ar;

  const [status, setStatus] = useState<StatusResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const [relinking, setRelinking] = useState(false);
  const [phone, setPhone] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [deepLink, setDeepLink] = useState<{ deep_link: string; expires_at: string } | null>(loadStoredDeepLink);

  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [justLinked, setJustLinked] = useState(false);

  const pollRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.get<StatusResp>('/api/telegram/link/status');
      if (!mountedRef.current) return;
      setStatus(data);
      setLoadError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      // Polling errors must not wipe a working view — only surface them
      // when we have nothing to show yet.
      if (!status) setLoadError(e instanceof ApiError ? e.message : STRINGS.ar.loadFailed);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status === null]);

  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const challenge = status?.challenge ?? null;
  const challengeActive =
    !!challenge && (challenge.state === 'pending' || challenge.state === 'contact_received' || challenge.state === 'phone_verified');
  const view: 'loading' | 'error' | 'linked' | 'enter' | 'challenge' =
    loading && !status
      ? 'loading'
      : !status
        ? 'error'
        : status.linked && !relinking && !challengeActive
          ? 'linked'
          : challengeActive && !relinking
            ? 'challenge'
            : 'enter';

  // Poll while a challenge is waiting on the Telegram side; resume
  // immediately when the tab regains focus/visibility (iPad app switch).
  useEffect(() => {
    const shouldPoll = view === 'challenge' && challenge != null && challenge.state !== 'phone_verified';
    const clear = () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    const onWake = () => {
      if (document.visibilityState === 'visible') fetchStatus();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    if (shouldPoll) {
      pollRef.current = window.setInterval(() => {
        if (document.visibilityState === 'visible') fetchStatus();
      }, 3000);
    }
    return () => {
      clear();
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, challenge?.state, fetchStatus]);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (starting) return;
    setStarting(true);
    setStartError(null);
    setJustLinked(false);
    try {
      const data = await api.post<StartResp>('/api/telegram/link/start', { phone });
      const dl = { deep_link: data.deep_link, expires_at: data.expires_at };
      setDeepLink(dl);
      storeDeepLink(dl);
      setRelinking(false);
      setConfirmError(null);
      await fetchStatus();
    } catch (err) {
      if (isNotConfigured(err)) setNotConfigured(true);
      else setStartError(err instanceof ApiError ? err.message : STRINGS.ar.loadFailed);
    } finally {
      setStarting(false);
    }
  };

  const handleConfirm = async () => {
    if (confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await api.post('/api/telegram/link/confirm', {});
      storeDeepLink(null);
      setDeepLink(null);
      setJustLinked(true);
      setRelinking(false);
      await fetchStatus();
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : STRINGS.ar.loadFailed);
      // The server may have expired/consumed the challenge — refresh.
      fetchStatus();
    } finally {
      setConfirming(false);
    }
  };

  const handleRestart = () => {
    storeDeepLink(null);
    setDeepLink(null);
    setStartError(null);
    setConfirmError(null);
    setRelinking(true);
  };

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ');
    } catch {
      return iso;
    }
  };

  return (
    <div className="lv-surface p-4 text-text-primary w-full">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-md bg-info/10 flex items-center justify-center shrink-0">
          <Send className="w-5 h-5 text-sky-400" />
        </div>
        <div className="min-w-0">
          <h3 className="font-bold text-[16px] leading-tight">{s.title}</h3>
          <p className="text-zinc-400 text-[12px] mt-0.5">{s.desc}</p>
        </div>
      </div>

      {notConfigured && (
        <div className="lv-alert lv-alert-warning mt-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
          <p className="text-[13px] text-text-secondary">{s.notConfigured}</p>
        </div>
      )}

      {view === 'loading' && (
        <div className="mt-4 flex items-center gap-2 text-zinc-400 text-[13px]">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>…</span>
        </div>
      )}

      {view === 'error' && (
        <div className="mt-4">
          <div className="lv-alert lv-alert-danger flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-danger mt-0.5 shrink-0" />
            <p className="text-[13px] text-text-secondary">{loadError || s.loadFailed}</p>
          </div>
          <button
            onClick={() => {
              setLoading(true);
              setLoadError(null);
              fetchStatus();
            }}
            className="lv-button lv-button-secondary mt-3"
          >
            <RefreshCw className="w-4 h-4" /> {s.retry}
          </button>
        </div>
      )}

      {view === 'linked' && status && (
        <div className="mt-4">
          {justLinked && (
            <div className="lv-alert lv-alert-success flex items-start gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
              <p className="text-[13px] text-text-secondary">{s.successLinked}</p>
            </div>
          )}
          <div className="flex items-center gap-3 bg-surface-raised rounded-md p-3">
            <ShieldCheck className="w-6 h-6 text-success shrink-0" />
            <div className="min-w-0">
              <p className="text-[14px] font-bold" dir="ltr">
                {s.linkedAs} {status.phone_masked}
              </p>
              {status.verified_at && (
                <p className="text-zinc-400 text-[12px] mt-0.5">
                  {s.verifiedOn} {fmtDate(status.verified_at)}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={handleRestart}
            className="mt-3 text-[13px] text-zinc-400 hover:text-white underline underline-offset-4 transition-colors"
          >
            {s.relink}
          </button>
        </div>
      )}

      {view === 'enter' && (
        <form onSubmit={handleStart} className="mt-4">
          <label className="block text-[13px] text-zinc-400 mb-1.5" htmlFor="tg-phone">
            {s.phoneLabel}
          </label>
          <input
            id="tg-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={s.phonePlaceholder}
            className="lv-input text-[15px]"
          />
          {startError && (
            <div className="mt-2 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-[13px] text-red-300">{startError}</p>
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="submit"
              disabled={starting || !phone.trim()}
              className="lv-button lv-button-primary flex-1"
            >
              {starting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> {s.starting}
                </>
              ) : (
                s.next
              )}
            </button>
            {(status?.linked || challengeActive) && (
              <button
                type="button"
                onClick={() => setRelinking(false)}
                className="text-[13px] text-zinc-400 hover:text-white px-2 transition-colors"
              >
                {s.cancel}
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">{s.linkExpiresSoon}</p>
        </form>
      )}

      {view === 'challenge' && challenge && (
        <div className="mt-4">
          <p className="text-[13px] text-zinc-300 mb-3" dir="ltr">
            {challenge.phone_masked}
          </p>

          {(challenge.state === 'pending' || challenge.state === 'contact_received') && (
            <>
              {deepLink ? (
                <a
                  href={deepLink.deep_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lv-button lv-button-primary w-full"
                >
                  <ExternalLink className="w-4 h-4" /> {s.openTelegram}
                </a>
              ) : null}
              <p className="mt-3 text-[13px] text-zinc-400">{s.openHint}</p>

              {challenge.state === 'contact_received' ? (
                <div className="lv-alert lv-alert-warning mt-3 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
                  <p className="text-[13px] text-text-secondary">{s.mismatch}</p>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-zinc-400 text-[13px]">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>{s.waitingShare}</span>
                </div>
              )}
            </>
          )}

          {challenge.state === 'phone_verified' && (
            <>
              <div className="lv-alert lv-alert-success flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
                <p className="text-[13px] text-text-secondary">{s.verifiedReady}</p>
              </div>
              <button
                onClick={handleConfirm}
                disabled={confirming}
                className="lv-button lv-button-primary mt-3 w-full"
              >
                {confirming ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> {s.confirming}
                  </>
                ) : (
                  s.confirm
                )}
              </button>
            </>
          )}

          {confirmError && (
            <div className="lv-alert lv-alert-danger mt-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-danger mt-0.5 shrink-0" />
              <p className="text-[13px] text-text-secondary">{confirmError}</p>
            </div>
          )}

          <button
            onClick={handleRestart}
            className="mt-3 text-[13px] text-zinc-400 hover:text-white underline underline-offset-4 transition-colors"
          >
            {s.restart}
          </button>
        </div>
      )}

      {/* An expired challenge drops challengeActive, so the card returns to
          the entry form; the expiry itself is announced inline there. */}
      {view === 'enter' && challenge?.state === 'expired' && !startError && (
        <div className="lv-alert lv-alert-warning mt-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
          <p className="text-[13px] text-text-secondary">{s.expired}</p>
        </div>
      )}
    </div>
  );
}
