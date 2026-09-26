import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, CheckCircle2, AlertCircle, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { api, ApiError, isNotConfigured } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import OtpBoxes from './OtpBoxes';
import PhoneField, { emptyPhoneValue, type PhoneValue } from './PhoneField';
import FillButton, { combineFillProgress, lengthProgress } from './FillButton';
import TelegramOpen from './TelegramOpen';

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
    phoneLabel: 'رقم الهاتف',
    countryLabel: 'الدولة',
    commonCountries: 'الأكثر استخدامًا',
    allCountries: 'كل الدول',
    countrySearch: 'ابحث عن دولة أو رمز',
    countryEmpty: 'لا توجد دولة بهذا الاسم أو الرمز',
    phoneHint: 'اختر دولتك ثم اكتب رقمك بدون صفر البداية. تُقبل الأرقام العربية أيضًا.',
    phoneInvalid: 'هذا الرقم غير صحيح للدولة المختارة. تحقق من الدولة ومن الرقم.',
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
    otpHint: 'أدخل الأرقام الستة المرسلة إلى محادثتك.',
    passwordLabel: 'كلمة مرور (اختيارية)',
    passwordHint: '8 محارف على الأقل. تتيح لك الدخول لاحقًا بالرقم + كلمة المرور دون تيليغرام.',
    passwordShow: 'إظهار كلمة المرور',
    passwordHide: 'إخفاء كلمة المرور',
    passwordTooShort: 'كلمة المرور يجب أن تكون 8 محارف على الأقل، أو اتركها فارغة.',
    referralApplied: 'كود الدعم المرفق:',
  },
  en: {
    introSignin: 'Sign in with your Telegram-verified phone number — no password.',
    introSignup: 'Create your account with your phone number, verified via Telegram.',
    phoneLabel: 'Phone number',
    countryLabel: 'Country',
    commonCountries: 'Frequently used',
    allCountries: 'All countries',
    countrySearch: 'Search a country or code',
    countryEmpty: 'No country matches that',
    phoneHint: 'Pick your country, then type your number without the leading zero. Arabic digits are accepted too.',
    phoneInvalid: 'That is not a valid number for the selected country. Check the country and the number.',
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
    otpHint: 'Enter the six digits sent to your chat.',
    passwordLabel: 'Password (optional)',
    passwordHint: 'At least 8 characters. It lets you sign in later with phone + password, without Telegram.',
    passwordShow: 'Show password',
    passwordHide: 'Hide password',
    passwordTooShort: 'The password must be at least 8 characters, or left empty.',
    referralApplied: 'Support code attached:',
  },
  ckb: {
    introSignin: 'بە ژمارە تەلەفۆنە پشتڕاستکراوەکەت لە ڕێگەی تەلەگرامەوە بچۆرەژوورەوە — بەبێ وشەی نهێنی.',
    introSignup: 'هەژمارەکەت بە ژمارەی تەلەفۆنەکەت دروستبکە دوای پشتڕاستکردنەوەی لە تەلەگرام.',
    phoneLabel: 'ژمارەی تەلەفۆن',
    countryLabel: 'وڵات',
    commonCountries: 'زۆرترین بەکارهاتوو',
    allCountries: 'هەموو وڵاتان',
    countrySearch: 'گەڕان بە ناوی وڵات یان کۆد',
    countryEmpty: 'هیچ وڵاتێک نەدۆزرایەوە',
    phoneHint: 'وڵاتەکەت هەڵبژێرە، پاشان ژمارەکەت بەبێ سفری سەرەتا بنووسە. ژمارە عەرەبییەکانیش قبوڵن.',
    phoneInvalid: 'ئەم ژمارەیە بۆ وڵاتی هەڵبژێردراو دروست نییە. وڵات و ژمارەکە بپشکنە.',
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
    otpHint: 'ئەو شەش ژمارەیە بنووسە کە بۆ گفتوگۆکەت نێردرا.',
    passwordLabel: 'وشەی نهێنی (ئارەزوومەندانە)',
    passwordHint: 'لانیکەم ٨ نووسە. ڕێگەت پێدەدات دواتر بە ژمارە + وشەی نهێنی بچیتەژوورەوە بەبێ تەلەگرام.',
    passwordShow: 'پیشاندانی وشەی نهێنی',
    passwordHide: 'شاردنەوەی وشەی نهێنی',
    passwordTooShort: 'وشەی نهێنی دەبێت لانیکەم ٨ نووسە بێت، یان بەتاڵی بهێڵەرەوە.',
    referralApplied: 'کۆدی پاڵپشتی هاوپێچ:',
  },
} as const;

type Purpose = 'signup' | 'login';

interface TelegramAuthProps {
  mode: 'signin' | 'signup';
  /**
   * §2.6 — the referral code the /auth page resolved (from ?ref= or the
   * "have a referral code?" bar). It is forwarded to /telegram/start, which
   * resolves it to a STABLE user id and stores it on the challenge, so an
   * invite survives the Safari → Telegram → Safari app switch; it is sent
   * again at /complete, where a code supplied there overrides. Never
   * resolved or trusted in the browser.
   */
  referralCode?: string;
  /**
   * A number already chosen on the screen before this one. It only PRE-FILLS
   * the field — the person still presses the button, and the server still
   * proves the number through Telegram. Asking twice for something somebody
   * just typed is how a flow loses people; skipping their confirmation is how
   * a flow sends a code to a typo.
   */
  initialPhone?: PhoneValue | null;
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

/**
 * Early feedback only — the server is still the authority and re-normalizes
 * everything it is sent. What changed: this used to be `7 to 15 digits`,
 * which called `+971 00000 0000` a UAE number. It is now the real numbering
 * plan for the selected country, via the shared PhoneField value.
 */
function phoneLooksValid(value: PhoneValue): boolean {
  return value.valid && !!value.e164;
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

export default function TelegramAuth({ mode, onSuccess, onSwitchMode, referralCode, initialPhone = null }: TelegramAuthProps) {
  const { lang } = useLanguage();
  const s = STRINGS[lang] || STRINGS.ar;
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  const purpose: Purpose = mode === 'signup' ? 'signup' : 'login';

  const [flow, setFlow] = useState<StoredFlow | null>(() => loadStored(purpose));
  const [phase, setPhase] = useState<Phase>(() => (loadStored(purpose) ? 'waiting' : 'phone'));
  const [serverState, setServerState] = useState<string>('pending');
  const [hint, setHint] = useState<string | null>(null);

  const [phone, setPhone] = useState<PhoneValue>(() => initialPhone ?? emptyPhoneValue('IQ'));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [uname, setUname] = useState('');
  // §2.1 — the OPTIONAL password that turns this into a phone + password
  // account. Empty means the pure OTP path: the mandate forbids demanding a
  // password this flow does not need, so the verify button never waits on it.
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
    setPassword('');
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
  // `pageshow` covers the iPhone case the other two miss: coming BACK to this
  // page from t.me in the same tab restores it from the back/forward cache,
  // which fires neither focus nor visibilitychange reliably.
  useEffect(() => {
    const shouldPoll = phase === 'waiting' && !!flow;
    let id: number | null = null;
    const onWake = () => {
      if (document.visibilityState === 'visible' && (phaseRef.current === 'waiting' || phaseRef.current === 'otp')) {
        fetchStatus();
      }
    };
    window.addEventListener('focus', onWake);
    window.addEventListener('pageshow', onWake);
    document.addEventListener('visibilitychange', onWake);
    if (shouldPoll) {
      id = window.setInterval(() => {
        if (document.visibilityState === 'visible') fetchStatus();
      }, 3000);
    }
    return () => {
      if (id !== null) window.clearInterval(id);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('pageshow', onWake);
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
      const ref = (referralCode ?? '').trim();
      const data = await api.post<StartResp>('/api/auth/telegram/start', {
        phone: phone.e164 as string,
        purpose,
        // Captured server-side at START (it survives the app switch and a
        // tab reload); an unknown code never blocks the sign-up.
        ...(purpose === 'signup' && ref ? { ref } : {}),
      });
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
        // Optional: only sent when the person actually typed one. The server
        // hashes it and audits password_set; it is never stored here.
        if (password) body.password = password;
        const ref = (referralCode ?? '').trim();
        if (ref) body.referralCode = ref;
        // The language this page is being read in becomes the account's own,
        // so its Telegram and WhatsApp notices arrive in it. Without this the
        // server stored the column's English default for every phone account.
        body.lang = lang;
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

  // A password is optional; once the person starts typing one it must reach
  // the server's own minimum (8) before the button may enable.
  const passwordTouchedInvalid = purpose === 'signup' && password.length > 0 && password.length < 8;
  const otpFill = combineFillProgress([
    { progress: lengthProgress(code, 6), valid: code.length === 6 },
    ...(purpose === 'signup' && password.length > 0
      ? [{ progress: lengthProgress(password, 8), valid: password.length >= 8 }]
      : []),
  ]);

  return (
    <div className="w-full" dir={lang === 'en' ? 'ltr' : 'rtl'}>
      <div className="lv-tg__intro">
        <div className="lv-tg__badge">
          <Send />
        </div>
        <p>{mode === 'signup' ? s.introSignup : s.introSignin}</p>
      </div>

      {notConfigured && (
        <div className="lv-notice lv-notice--warn" role="status">
          <AlertCircle />
          <p>{s.notConfigured}</p>
        </div>
      )}

      {phase === 'phone' && !notConfigured && (
        <form onSubmit={handleStart} noValidate>
          <PhoneField
            id="tg-auth-phone"
            label={s.phoneLabel}
            countryLabel={s.countryLabel}
            commonLabel={s.commonCountries}
            allLabel={s.allCountries}
            searchLabel={s.countrySearch}
            emptyLabel={s.countryEmpty}
            value={phone}
            onChange={setPhone}
            lang={lang}
            hint={s.phoneHint}
          />
          {startError && (
            <div className="lv-tg__inline-alert" role="alert">
              <AlertCircle />
              <p>{startError}</p>
            </div>
          )}
          <button
            type="submit"
            disabled={starting || !phone.valid}
            className="lv-btn-quiet mt-4"
          >
            {starting ? (
              <>
                <span className="lv-dots" aria-hidden /> {s.starting}
              </>
            ) : (
              <>
                <Send /> {s.continueTg}
              </>
            )}
          </button>
          <p className="lv-tg__small">{s.validFor}</p>
        </form>
      )}

      {phase === 'waiting' && flow && (
        <div>
          <p className="lv-tg__masked" dir="ltr">
            {flow.phone_masked}
          </p>
          <TelegramOpen deepLink={flow.deep_link}>
            <p className="lv-tg__hint">{s.openHint}</p>

            {serverState === 'contact_received' ? (
              <div className="lv-notice lv-notice--warn lv-notice--tight" role="status">
                <AlertCircle />
                <p>{s.mismatchRetry}</p>
              </div>
            ) : serverState === 'send_failed' ? (
              <div className="lv-notice lv-notice--warn lv-notice--tight" role="status">
                <AlertCircle />
                <p>{s.sendFailed}</p>
              </div>
            ) : (
              <div className="lv-tg__waiting" role="status" aria-live="polite">
                <span className="lv-dots" aria-hidden />
                <span>{s.waitingShare}</span>
              </div>
            )}
          </TelegramOpen>

          <button
            type="button"
            onClick={reset}
            className="lv-textbtn mt-2"
          >
            {s.restart}
          </button>
        </div>
      )}

      {phase === 'otp' && flow && (
        <form onSubmit={handleComplete} noValidate>
          <div className="lv-notice lv-notice--ok" role="status">
            <CheckCircle2 />
            <p>
              {s.codeSent} <span dir="ltr">{flow.phone_masked}</span>
            </p>
          </div>

          {/* §2.4 — six linked boxes: paste, one-time-code autofill, Arabic
              digits and Backspace navigation all handled by OtpBoxes. Six
              digits mean READY TO SEND, never "verified": only the server's
              answer to /telegram/complete decides that. */}
          <label className="lv-field__label" htmlFor="tg-auth-code-0">
            {s.codeLabel}
          </label>
          <OtpBoxes
            idPrefix="tg-auth-code"
            label={s.codeLabel}
            value={code}
            onChange={setCode}
            disabled={completing}
            autoFocus
          />
          <p className="lv-tg__otp-hint">{s.otpHint}</p>

          {purpose === 'signup' && (
            <div className="lv-fields mt-4">
              <div>
                <label className="lv-field__label" htmlFor="tg-auth-name">
                  {s.nameLabel}
                </label>
                <input
                  id="tg-auth-name"
                  type="text"
                  autoComplete="name"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="lv-field__input"
                />
              </div>
              <div>
                <label className="lv-field__label" htmlFor="tg-auth-username">
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
                  className="lv-field__input"
                />
                <p className="lv-field__help">{s.usernameHint}</p>
              </div>
              {/* §2.1 — the ONLY route by which a phone + password account is
                  created. Optional on purpose: leaving it empty keeps the pure
                  Telegram-OTP account, and the verify button never waits on a
                  field this path does not require. */}
              <div>
                <label className="lv-field__label" htmlFor="tg-auth-password">
                  {s.passwordLabel}
                </label>
                <div className="lv-field__frame" dir="ltr">
                  <input
                    id="tg-auth-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    maxLength={200}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={passwordTouchedInvalid || undefined}
                    aria-describedby="tg-auth-password-hint"
                    className="lv-field__input has-reveal"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? s.passwordHide : s.passwordShow}
                    aria-pressed={showPassword}
                    className="lv-field__reveal"
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </button>
                </div>
                <p
                  id="tg-auth-password-hint"
                  className={`lv-field__help${passwordTouchedInvalid ? ' is-bad' : ''}`}
                >
                  {passwordTouchedInvalid ? s.passwordTooShort : s.passwordHint}
                </p>
              </div>
              {(referralCode ?? '').trim() && (
                <p className="lv-tg__ref">
                  {s.referralApplied} <b>{(referralCode ?? '').trim()}</b>
                </p>
              )}
            </div>
          )}

          {otpError && (
            <div className="lv-tg__inline-alert" role="alert">
              <AlertCircle />
              <p>{otpError}</p>
            </div>
          )}

          {/* §2.2/§2.4 — the fill goes 0/6 → 6/6 as digits arrive and regresses
              the instant one is deleted. `ready` is real validation only: six
              digits, plus a valid password WHEN one is being typed. The
              animation never enables the button. */}
          <div className="mt-4">
            <FillButton
              id="tg-auth-verify"
              label={s.verify}
              workingLabel={s.verifying}
              progress={otpFill.progress}
              ready={otpFill.ready && !completing}
              status={completing ? 'submitting' : otpError ? 'error' : 'idle'}
              hint={passwordTouchedInvalid ? s.passwordTooShort : code.length === 6 ? undefined : s.otpHint}
            />
          </div>

          <div className="lv-tg__row">
            <button
              type="button"
              onClick={handleResend}
              disabled={resending || resendIn > 0}
              className="lv-textbtn"
            >
              {resending ? <span className="lv-dots" aria-hidden /> : <RefreshCw className="w-3.5 h-3.5" />}
              {resendIn > 0 ? s.resendIn.replace('{s}', String(resendIn)) : s.resend}
            </button>
            <button
              type="button"
              onClick={reset}
              className="lv-textbtn"
            >
              {s.restart}
            </button>
          </div>
          {resendNotice && (
            <p className="lv-tg__small" role="status" aria-live="polite">
              {resendNotice}
            </p>
          )}
        </form>
      )}

      {phase === 'blocked' && (
        <div>
          <div className="lv-notice lv-notice--warn" role="alert">
            <AlertCircle />
            <p>{blockedText}</p>
          </div>
          <div className="lv-tg__stack">
            {hint === 'use_login' && (
              <button
                type="button"
                onClick={() => switchTo('signin')}
                className="lv-btn-quiet"
              >
                {s.goLogin}
              </button>
            )}
            {hint === 'use_signup' && (
              <button
                type="button"
                onClick={() => switchTo('signup')}
                className="lv-btn-quiet"
              >
                {s.goSignup}
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className="lv-textbtn"
            >
              {s.restart}
            </button>
          </div>
        </div>
      )}

      {phase === 'expired' && (
        <div>
          <div className="lv-notice lv-notice--warn" role="alert">
            <AlertCircle />
            <p>{s.expired}</p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="lv-btn-quiet"
          >
            <RefreshCw /> {s.restart}
          </button>
        </div>
      )}

      {phase === 'done' && (
        <div className="lv-notice lv-notice--ok" role="status">
          <CheckCircle2 />
          <p>{mode === 'signup' ? s.doneSignup : s.doneSignin}</p>
        </div>
      )}
    </div>
  );
}
