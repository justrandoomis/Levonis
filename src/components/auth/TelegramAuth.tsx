import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, CheckCircle2, AlertCircle, RefreshCw, ExternalLink, Loader2, KeyRound } from 'lucide-react';
import { api, ApiError, isNotConfigured } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';

/**
 * Telegram-verified phone + OTP registration & sign-in (§4), embedded by the
 * /auth page.
 *
 * Flow: enter phone → server issues a deep link + a continuation token that
 * stays in THIS browser (sessionStorage, so the iPad Safari→Telegram→Safari
 * app switch never loses the pending flow) → the customer shares their own
 * contact inside the PRIVATE bot chat → the server verifies ownership and
 * sends a one-time code into that same chat → the code is entered here and
 * the session is created only after the server confirms.
 *
 * Honesty rules respected throughout: every state shown mirrors a server
 * state (no fake progress), a 503 renders the explicit not-configured
 * notice, and nothing succeeds before /telegram/complete returns the user.
 */

const STRINGS = {
  ar: {
    introSignin: 'سجّل الدخول برقم هاتفك الموثّق عبر تيليغرام — بدون كلمة مرور.',
    introSignup: 'أنشئ حسابك برقم هاتفك بعد توثيقه عبر تيليغرام.',
    phoneLabel: 'رقم الهاتف (موبايل عراقي)',
    phonePlaceholder: '07XXXXXXXXX',
    phoneInvalid: 'أدخل رقم موبايل عراقي صحيح مثل 07XXXXXXXXX (تُقبل الأرقام العربية أيضًا).',
    continueTg: 'المتابعة عبر تيليغرام',
    starting: 'جارٍ التجهيز…',
    openTelegram: 'فتح البوت في تيليغرام',
    openHint: 'داخل المحادثة اضغط «ابدأ» ثم زر «مشاركة رقم هاتفي». بعدها ارجع إلى هذه الصفحة.',
    waitingShare: 'بانتظار مشاركة رقمك في تيليغرام…',
    mismatchRetry: 'الرقم الذي شاركته لا يطابق الرقم المُدخل هنا، أو جهة الاتصال ليست لك. أعد المحاولة داخل تيليغرام أو ابدأ من جديد.',
    codeSent: 'أرسلنا رمز التحقق إلى محادثتك الخاصة مع البوت.',
    codeLabel: 'رمز التحقق (6 أرقام)',
    verify: 'تأكيد الرمز',
    verifying: 'جارٍ التحقق…',
    resend: 'إعادة إرسال الرمز',
    resendIn: 'إعادة الإرسال بعد {s} ثانية',
    resent: 'أُعيد إرسال الرمز.',
    sendFailed: 'تعذر إرسال الرمز عبر تيليغرام. سنعيد المحاولة تلقائيًا — تأكد أنك لم تحظر البوت.',
    expired: 'انتهت مهلة هذه المحاولة.',
    restart: 'البدء من جديد',
    notConfigured: 'الدخول عبر تيليغرام غير مُفعّل بعد — لم يهيّئه المسؤول. هذه حالة صادقة وليست عطلًا.',
    loadFailed: 'حدث خطأ. أعد المحاولة.',
    retry: 'إعادة المحاولة',
    blockedSignup: 'هذا الرقم مرتبط بحساب موجود بالفعل. سجّل الدخول بدلًا من إنشاء حساب جديد.',
    blockedLogin: 'لا يوجد حساب موثّق بهذا الرقم. أنشئ حسابًا جديدًا أولًا.',
    blockedSupport: 'تعذر إكمال العملية بهذا الرقم. تواصل مع الدعم إذا كان الرقم رقمك.',
    goLogin: 'الذهاب لتسجيل الدخول',
    goSignup: 'إنشاء حساب جديد',
    nameLabel: 'الاسم (اختياري)',
    usernameLabel: 'اسم المستخدم (اختياري)',
    usernameHint: 'أحرف إنجليزية صغيرة وأرقام و . _ - (من 3 إلى 30)',
    doneSignin: 'تم تسجيل الدخول بنجاح.',
    doneSignup: 'تم إنشاء حسابك وتسجيل الدخول.',
    validFor: 'صالح لمدة 15 دقيقة',
    cancel: 'إلغاء',
  },
  en: {
    introSignin: 'Sign in with your Telegram-verified phone number — no password.',
    introSignup: 'Create your account with your phone number, verified via Telegram.',
    phoneLabel: 'Phone number (Iraqi mobile)',
    phonePlaceholder: '07XXXXXXXXX',
    phoneInvalid: 'Enter a valid Iraqi mobile number like 07XXXXXXXXX (Arabic digits are accepted too).',
    continueTg: 'Continue with Telegram',
    starting: 'Preparing…',
    openTelegram: 'Open the bot in Telegram',
    openHint: "Inside the chat tap Start, then the 'Share my phone number' button. Then come back to this page.",
    waitingShare: 'Waiting for you to share your number in Telegram…',
    mismatchRetry: 'The number you shared does not match the one entered here, or the contact was not your own. Try again inside Telegram or start over.',
    codeSent: 'We sent a verification code to your private chat with the bot.',
    codeLabel: 'Verification code (6 digits)',
    verify: 'Verify code',
    verifying: 'Verifying…',
    resend: 'Resend code',
    resendIn: 'Resend in {s}s',
    resent: 'The code was resent.',
    sendFailed: 'The code could not be delivered via Telegram. We will retry automatically — make sure you have not blocked the bot.',
    expired: 'This attempt has expired.',
    restart: 'Start over',
    notConfigured: 'Telegram sign-in is not configured yet — the administrator has not set it up. This is an honest state, not a bug.',
    loadFailed: 'Something went wrong. Please try again.',
    retry: 'Retry',
    blockedSignup: 'This number already belongs to an account. Sign in instead of creating a new one.',
    blockedLogin: 'No verified account exists for this number. Create an account first.',
    blockedSupport: 'This number cannot be used to continue. Contact support if it is yours.',
    goLogin: 'Go to sign in',
    goSignup: 'Create a new account',
    nameLabel: 'Name (optional)',
    usernameLabel: 'Username (optional)',
    usernameHint: 'Lowercase letters, numbers and . _ - (3–30 chars)',
    doneSignin: 'Signed in successfully.',
    doneSignup: 'Your account was created and you are signed in.',
    validFor: 'Valid for 15 minutes',
    cancel: 'Cancel',
  },
  ckb: {
    introSignin: 'بە ژمارە تەلەفۆنە پشتڕاستکراوەکەت لە ڕێگەی تەلەگرامەوە بچۆرەژوورەوە — بەبێ وشەی نهێنی.',
    introSignup: 'هەژمارەکەت بە ژمارەی تەلەفۆنەکەت دروستبکە دوای پشتڕاستکردنەوەی لە تەلەگرام.',
    phoneLabel: 'ژمارەی تەلەفۆن (مۆبایلی عێراقی)',
    phonePlaceholder: '07XXXXXXXXX',
    phoneInvalid: 'ژمارەیەکی مۆبایلی عێراقی دروست بنووسە وەک 07XXXXXXXXX (ژمارە عەرەبییەکانیش قبوڵن).',
    continueTg: 'بەردەوامبوون لە ڕێگەی تەلەگرام',
    starting: 'ئامادەکردن…',
    openTelegram: 'کردنەوەی بۆتەکە لە تەلەگرام',
    openHint: 'لەناو گفتوگۆکە «دەستپێبکە» دابگرە، پاشان دوگمەی «هاوبەشکردنی ژمارەی تەلەفۆنم». دواتر بگەڕێوە بۆ ئەم پەڕەیە.',
    waitingShare: 'چاوەڕوانی هاوبەشکردنی ژمارەکەت لە تەلەگرام…',
    mismatchRetry: 'ئەو ژمارەیەی هاوبەشت کرد لەگەڵ ژمارەی ئێرە یەک ناگرێتەوە، یان کۆنتاکتەکە هی خۆت نەبوو. لەناو تەلەگرام هەوڵبدەرەوە یان لە سەرەتاوە دەستپێبکەرەوە.',
    codeSent: 'کۆدی پشتڕاستکردنەوەمان نارد بۆ گفتوگۆ تایبەتەکەت لەگەڵ بۆتەکە.',
    codeLabel: 'کۆدی پشتڕاستکردنەوە (٦ ژمارە)',
    verify: 'پشتڕاستکردنەوەی کۆد',
    verifying: 'پشتڕاستکردنەوە…',
    resend: 'دووبارە ناردنی کۆد',
    resendIn: 'دووبارە ناردن دوای {s} چرکە',
    resent: 'کۆدەکە دووبارە نێردرا.',
    sendFailed: 'نەتوانرا کۆدەکە لە ڕێگەی تەلەگرامەوە بنێردرێت. خۆکارانە هەوڵدەدەینەوە — دڵنیابە بۆتەکەت بلۆک نەکردووە.',
    expired: 'کاتی ئەم هەوڵە بەسەرچوو.',
    restart: 'دەستپێکردنەوە',
    notConfigured: 'چوونەژوورەوە بە تەلەگرام هێشتا ڕێکنەخراوە — بەڕێوەبەر دایننەناوە. ئەمە دۆخێکی ڕاستگۆیانەیە، نەک هەڵە.',
    loadFailed: 'هەڵەیەک ڕوویدا. هەوڵبدەرەوە.',
    retry: 'هەوڵدانەوە',
    blockedSignup: 'ئەم ژمارەیە پێشتر هی هەژمارێکی هەیە. لەبری دروستکردنی هەژماری نوێ، بچۆرەژوورەوە.',
    blockedLogin: 'هیچ هەژمارێکی پشتڕاستکراو بەم ژمارەیە نییە. سەرەتا هەژمارێک دروستبکە.',
    blockedSupport: 'ناتوانرێت بەم ژمارەیە بەردەوام ببیت. پەیوەندی بە پشتگیرییەوە بکە ئەگەر ژمارەکە هی تۆیە.',
    goLogin: 'بڕۆ بۆ چوونەژوورەوە',
    goSignup: 'دروستکردنی هەژماری نوێ',
    nameLabel: 'ناو (ئارەزوومەندانە)',
    usernameLabel: 'ناوی بەکارهێنەر (ئارەزوومەندانە)',
    usernameHint: 'پیتی بچووکی ئینگلیزی، ژمارە و . _ - (لە ٣ بۆ ٣٠)',
    doneSignin: 'بە سەرکەوتوویی چوویتەژوورەوە.',
    doneSignup: 'هەژمارەکەت دروستکرا و چوویتەژوورەوە.',
    validFor: 'بۆ ماوەی ١٥ خولەک کارایە',
    cancel: 'هەڵوەشاندنەوە',
  },
} as const;

type Purpose = 'signup' | 'login';

interface TelegramAuthProps {
  mode: 'signin' | 'signup';
  /** Called after a confirmed successful completion (session already
   *  created and the auth context refreshed). Defaults to navigate('/'). */
  onSuccess?: () => void;
  /** Lets the parent switch signin/signup when the server (post phone-proof)
   *  says the other flow is the right one. Optional — a plain notice is
   *  shown when absent. */
  onSwitchMode?: (mode: 'signin' | 'signup') => void;
}

interface StoredFlow {
  token: string;
  deep_link: string;
  expires_at: string;
  phone_masked: string;
  purpose: Purpose;
}

interface StatusResp {
  state: string;
  purpose: Purpose;
  phone_masked: string;
  expires_at: string;
  resend_in: number | null;
  hint: string | null;
}

interface StartResp {
  deep_link: string;
  continuation_token: string;
  expires_at: string;
  phone_masked: string;
  purpose: Purpose;
}

const STORE_KEY = 'levo_tg_auth';

/** Arabic-Indic + Eastern Arabic-Indic digits → ASCII (matches the server;
 *  the worker helper cannot be imported into the src bundle). */
function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/** Light client-side plausibility check for early feedback only — the server
 *  performs the authoritative normalization. */
function phoneLooksValid(raw: string): boolean {
  const s = toAsciiDigits(raw).trim().replace(/[\s\-().]/g, '');
  const digits = s.startsWith('+') ? s.slice(1) : s.startsWith('00') ? s.slice(2) : s;
  return /^\d{7,15}$/.test(digits);
}

function loadStored(purpose: Purpose): StoredFlow | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredFlow>;
    if (
      typeof v.token !== 'string' ||
      typeof v.deep_link !== 'string' ||
      typeof v.expires_at !== 'string' ||
      typeof v.phone_masked !== 'string' ||
      v.purpose !== purpose
    ) {
      return null;
    }
    if (new Date(v.expires_at).getTime() <= Date.now()) return null;
    return v as StoredFlow;
  } catch {
    return null;
  }
}

function storeFlow(v: StoredFlow | null) {
  try {
    if (v) sessionStorage.setItem(STORE_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable — the flow simply won't survive a reload */
  }
}

type Phase = 'phone' | 'waiting' | 'otp' | 'blocked' | 'expired' | 'done';

export default function TelegramAuth({ mode, onSuccess, onSwitchMode }: TelegramAuthProps) {
  const { lang } = useLanguage();
  const s = STRINGS[lang] || STRINGS.ar;
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  const purpose: Purpose = mode === 'signup' ? 'signup' : 'login';

  const [flow, setFlow] = useState<StoredFlow | null>(() => loadStored(purpose));
  const [phase, setPhase] = useState<Phase>(() => (loadStored(purpose) ? 'waiting' : 'phone'));
  const [serverState, setServerState] = useState<string>('pending');
  const [hint, setHint] = useState<string | null>(null);

  const [phone, setPhone] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [uname, setUname] = useState('');
  const [completing, setCompleting] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  const [resendIn, setResendIn] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const completingRef = useRef(false);

  const reset = useCallback(() => {
    storeFlow(null);
    setFlow(null);
    setPhase('phone');
    setServerState('pending');
    setHint(null);
    setCode('');
    setOtpError(null);
    setStartError(null);
    setResendNotice(null);
    setResendIn(0);
  }, []);

  // Switching signin/signup mid-flow drops the other purpose's pending flow
  // — a challenge for one purpose can never complete the other anyway.
  useEffect(() => {
    if (flowRef.current && flowRef.current.purpose !== purpose) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purpose]);

  const finish = useCallback(async () => {
    storeFlow(null);
    await refreshUser();
    if (!mountedRef.current) return;
    setPhase('done');
    if (onSuccess) onSuccess();
    else navigate('/');
  }, [refreshUser, onSuccess, navigate]);

  const fetchStatus = useCallback(async () => {
    const f = flowRef.current;
    if (!f || completingRef.current) return;
    try {
      const data = await api.get<StatusResp>(`/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`);
      if (!mountedRef.current || completingRef.current) return;
      setServerState(data.state);
      setHint(data.hint);
      switch (data.state) {
        case 'pending':
        case 'contact_received':
        case 'send_failed':
          setPhase('waiting');
          break;
        case 'otp_sent':
          setPhase('otp');
          if (typeof data.resend_in === 'number') setResendIn(data.resend_in);
          break;
        case 'not_linkable':
          setPhase('blocked');
          break;
        case 'expired':
          setPhase('expired');
          break;
        case 'completed':
          // Another tab of THIS browser finished — the session cookie is
          // already set; confirm through /me before showing success.
          await finish();
          break;
      }
    } catch (e) {
      if (!mountedRef.current) return;
      if (isNotConfigured(e)) setNotConfigured(true);
      else if (e instanceof ApiError && (e.code === 'NO_CHALLENGE' || e.status === 400)) setPhase('expired');
      // Network errors: keep the current view; the next poll retries.
    }
  }, [finish]);

  useEffect(() => {
    mountedRef.current = true;
    if (flowRef.current) fetchStatus();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while Telegram-side steps are pending; pause when hidden and resume
  // immediately on focus/visibility (iPad Safari → Telegram → Safari).
  useEffect(() => {
    const shouldPoll = phase === 'waiting' && !!flow;
    let id: number | null = null;
    const onWake = () => {
      if (document.visibilityState === 'visible' && (phaseRef.current === 'waiting' || phaseRef.current === 'otp')) {
        fetchStatus();
      }
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    if (shouldPoll) {
      id = window.setInterval(() => {
        if (document.visibilityState === 'visible') fetchStatus();
      }, 3000);
    }
    return () => {
      if (id !== null) window.clearInterval(id);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [phase, flow, fetchStatus]);

  // Resend cooldown countdown (display only — the server enforces it too).
  useEffect(() => {
    if (phase !== 'otp' || resendIn <= 0) return;
    const id = window.setInterval(() => setResendIn((v) => (v > 0 ? v - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [phase, resendIn > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (starting) return;
    setStartError(null);
    if (!phoneLooksValid(phone)) {
      setStartError(s.phoneInvalid);
      return;
    }
    setStarting(true);
    try {
      const data = await api.post<StartResp>('/api/auth/telegram/start', { phone: toAsciiDigits(phone.trim()), purpose });
      const f: StoredFlow = {
        token: data.continuation_token,
        deep_link: data.deep_link,
        expires_at: data.expires_at,
        phone_masked: data.phone_masked,
        purpose,
      };
      storeFlow(f);
      if (!mountedRef.current) return;
      setFlow(f);
      setServerState('pending');
      setHint(null);
      setCode('');
      setOtpError(null);
      setPhase('waiting');
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotConfigured(err)) setNotConfigured(true);
      else setStartError(err instanceof ApiError ? err.message : s.loadFailed);
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = flowRef.current;
    if (!f || completing) return;
    setCompleting(true);
    completingRef.current = true;
    setOtpError(null);
    try {
      const body: Record<string, string> = { token: f.token, code: toAsciiDigits(code.trim()) };
      if (purpose === 'signup') {
        if (name.trim()) body.name = name.trim();
        if (uname.trim()) body.username = uname.trim();
      }
      await api.post('/api/auth/telegram/complete', body);
      await finish();
    } catch (err) {
      completingRef.current = false;
      if (!mountedRef.current) return;
      if (err instanceof ApiError) {
        if (err.code === 'CHALLENGE_EXPIRED' || err.code === 'CHALLENGE_CONSUMED' || err.code === 'NO_CHALLENGE') {
          setPhase('expired');
        } else {
          setOtpError(err.message);
        }
      } else {
        setOtpError(s.loadFailed);
      }
    } finally {
      if (mountedRef.current) setCompleting(false);
      if (phaseRef.current !== 'done') completingRef.current = false;
    }
  };

  const handleResend = async () => {
    const f = flowRef.current;
    if (!f || resending || resendIn > 0) return;
    setResending(true);
    setResendNotice(null);
    setOtpError(null);
    try {
      const data = await api.post<{ resend_in: number }>('/api/auth/telegram/resend', { token: f.token });
      if (!mountedRef.current) return;
      setResendIn(typeof data.resend_in === 'number' ? data.resend_in : 60);
      setResendNotice(s.resent);
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && (err.code === 'CHALLENGE_EXPIRED' || err.code === 'NO_CHALLENGE')) setPhase('expired');
      else setResendNotice(err instanceof ApiError ? err.message : s.loadFailed);
    } finally {
      if (mountedRef.current) setResending(false);
    }
  };

  const switchTo = (m: 'signin' | 'signup') => {
    reset();
    if (onSwitchMode) onSwitchMode(m);
  };

  const blockedText =
    hint === 'use_login' ? s.blockedSignup : hint === 'use_signup' ? s.blockedLogin : s.blockedSupport;

  return (
    <div className="w-full text-white" dir={lang === 'en' ? 'ltr' : 'rtl'}>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-full bg-gold/10 border border-gold/20 flex items-center justify-center shrink-0">
          <Send className="w-5 h-5 text-gold" />
        </div>
        <p className="text-zinc-400 text-[13px]">{mode === 'signup' ? s.introSignup : s.introSignin}</p>
      </div>

      {notConfigured && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-3 mb-3" role="status">
          <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[13px] text-amber-200">{s.notConfigured}</p>
        </div>
      )}

      {phase === 'phone' && !notConfigured && (
        <form onSubmit={handleStart} noValidate>
          <label className="block text-[13px] text-zinc-400 mb-1.5" htmlFor="tg-auth-phone">
            {s.phoneLabel}
          </label>
          <input
            id="tg-auth-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={s.phonePlaceholder}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-2xl px-4 py-3.5 text-[15px] text-white placeholder-zinc-500 outline-none focus:border-gold transition-colors"
          />
          {startError && (
            <div className="mt-2 flex items-start gap-2" role="alert">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-[13px] text-red-300">{startError}</p>
            </div>
          )}
          <button
            type="submit"
            disabled={starting || !phone.trim()}
            className="mt-3 w-full min-h-[48px] bg-[#111111] text-gold border border-gold/20 hover:bg-black/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-[14px] px-4 py-3.5 text-[14px] font-bold transition-colors flex items-center justify-center gap-2"
          >
            {starting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> {s.starting}
              </>
            ) : (
              <>
                <Send className="w-4 h-4" /> {s.continueTg}
              </>
            )}
          </button>
          <p className="mt-2 text-[11px] text-zinc-500">{s.validFor}</p>
        </form>
      )}

      {phase === 'waiting' && flow && (
        <div>
          <p className="text-[13px] text-zinc-300 mb-3" dir="ltr">
            {flow.phone_masked}
          </p>
          <a
            href={flow.deep_link}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full min-h-[48px] bg-[#111111] text-gold border border-gold/20 hover:bg-black/90 rounded-[14px] px-4 py-3.5 text-[14px] font-bold transition-colors flex items-center justify-center gap-2"
          >
            <ExternalLink className="w-4 h-4" /> {s.openTelegram}
          </a>
          <p className="mt-3 text-[13px] text-zinc-400">{s.openHint}</p>

          {serverState === 'contact_received' ? (
            <div className="mt-3 flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-3" role="status">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[13px] text-amber-200">{s.mismatchRetry}</p>
            </div>
          ) : serverState === 'send_failed' ? (
            <div className="mt-3 flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-3" role="status">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[13px] text-amber-200">{s.sendFailed}</p>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 text-zinc-400 text-[13px]" role="status" aria-live="polite">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>{s.waitingShare}</span>
            </div>
          )}

          <button
            type="button"
            onClick={reset}
            className="mt-4 min-h-[44px] text-[13px] text-zinc-400 hover:text-white underline underline-offset-4 transition-colors"
          >
            {s.restart}
          </button>
        </div>
      )}

      {phase === 'otp' && flow && (
        <form onSubmit={handleComplete} noValidate>
          <div className="flex items-start gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-3 mb-3" role="status">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
            <p className="text-[13px] text-emerald-300">
              {s.codeSent} <span dir="ltr">{flow.phone_masked}</span>
            </p>
          </div>

          <label className="block text-[13px] text-zinc-400 mb-1.5" htmlFor="tg-auth-code">
            {s.codeLabel}
          </label>
          <input
            id="tg-auth-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9٠-٩۰-۹]*"
            maxLength={6}
            dir="ltr"
            value={code}
            onChange={(e) => setCode(toAsciiDigits(e.target.value).replace(/\D/g, '').slice(0, 6))}
            placeholder="••••••"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-2xl px-4 py-3.5 text-[18px] tracking-[0.4em] text-center text-white placeholder-zinc-600 outline-none focus:border-gold transition-colors"
          />

          {purpose === 'signup' && (
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-[13px] text-zinc-400 mb-1.5" htmlFor="tg-auth-name">
                  {s.nameLabel}
                </label>
                <input
                  id="tg-auth-name"
                  type="text"
                  autoComplete="name"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-2xl px-4 py-3.5 text-[15px] text-white placeholder-zinc-500 outline-none focus:border-gold transition-colors"
                />
              </div>
              <div>
                <label className="block text-[13px] text-zinc-400 mb-1.5" htmlFor="tg-auth-username">
                  {s.usernameLabel}
                </label>
                <input
                  id="tg-auth-username"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={30}
                  dir="ltr"
                  value={uname}
                  onChange={(e) => setUname(e.target.value.toLowerCase())}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-2xl px-4 py-3.5 text-[15px] text-white placeholder-zinc-500 outline-none focus:border-gold transition-colors"
                />
                <p className="mt-1 text-[11px] text-zinc-500">{s.usernameHint}</p>
              </div>
            </div>
          )}

          {otpError && (
            <div className="mt-2 flex items-start gap-2" role="alert">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-[13px] text-red-300">{otpError}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={completing || code.length !== 6}
            className="mt-3 w-full min-h-[48px] bg-[#111111] text-gold border border-gold/20 hover:bg-black/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-[14px] px-4 py-3.5 text-[14px] font-bold transition-colors flex items-center justify-center gap-2"
          >
            {completing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> {s.verifying}
              </>
            ) : (
              <>
                <KeyRound className="w-4 h-4" /> {s.verify}
              </>
            )}
          </button>

          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleResend}
              disabled={resending || resendIn > 0}
              className="min-h-[44px] text-[13px] text-zinc-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed underline underline-offset-4 transition-colors flex items-center gap-1.5"
            >
              {resending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {resendIn > 0 ? s.resendIn.replace('{s}', String(resendIn)) : s.resend}
            </button>
            <button
              type="button"
              onClick={reset}
              className="min-h-[44px] text-[13px] text-zinc-500 hover:text-white transition-colors"
            >
              {s.restart}
            </button>
          </div>
          {resendNotice && (
            <p className="mt-1 text-[12px] text-zinc-400" role="status" aria-live="polite">
              {resendNotice}
            </p>
          )}
        </form>
      )}

      {phase === 'blocked' && (
        <div>
          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-3" role="alert">
            <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-[13px] text-amber-200">{blockedText}</p>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {hint === 'use_login' && (
              <button
                type="button"
                onClick={() => switchTo('signin')}
                className="w-full min-h-[48px] bg-[#111111] text-gold border border-gold/20 hover:bg-black/90 rounded-[14px] px-4 py-3.5 text-[14px] font-bold transition-colors"
              >
                {s.goLogin}
              </button>
            )}
            {hint === 'use_signup' && (
              <button
                type="button"
                onClick={() => switchTo('signup')}
                className="w-full min-h-[48px] bg-[#111111] text-gold border border-gold/20 hover:bg-black/90 rounded-[14px] px-4 py-3.5 text-[14px] font-bold transition-colors"
              >
                {s.goSignup}
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className="min-h-[44px] text-[13px] text-zinc-400 hover:text-white underline underline-offset-4 transition-colors"
            >
              {s.restart}
            </button>
          </div>
        </div>
      )}

      {phase === 'expired' && (
        <div>
          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-3" role="alert">
            <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-[13px] text-amber-200">{s.expired}</p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="mt-3 w-full min-h-[48px] bg-[#111111] text-gold border border-gold/20 hover:bg-black/90 rounded-[14px] px-4 py-3.5 text-[14px] font-bold transition-colors flex items-center justify-center gap-2"
          >
            <RefreshCw className="w-4 h-4" /> {s.restart}
          </button>
        </div>
      )}

      {phase === 'done' && (
        <div className="flex items-start gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-3" role="status">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
          <p className="text-[13px] text-emerald-300">{mode === 'signup' ? s.doneSignup : s.doneSignin}</p>
        </div>
      )}
    </div>
  );
}
