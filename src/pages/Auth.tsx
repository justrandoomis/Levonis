import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, Gift } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import AuthTextField from '../components/auth/AuthTextField';
import TelegramAuth from '../components/auth/TelegramAuth';
import { sanitizeNextPath } from '../components/auth/nextPath';
import '../components/auth/auth.css';

/**
 * /auth — one dark LEVONIS screen with four clearly separated steps:
 * sign-in, create-account, forgot-password and reset-password (?reset=TOKEN).
 *
 * All server contracts are unchanged from the previous version:
 * - POST /api/auth/login    { email (or username), password }
 * - POST /api/auth/register { username, name, email, password, referralCode? }
 * - POST /api/auth/google   { credential, referralCode? }  (GIS credential flow)
 * - POST /api/auth/forgot-password { email, lang }
 * - POST /api/auth/reset-password  { token, password }
 *
 * Return-to-destination: `location.state.from` (a ProtectedRoute redirect) or
 * `?next=` is honored AFTER sanitizeNextPath() — only same-origin relative
 * paths; everything else falls back to "/" (the previous behavior).
 */

const STRINGS = {
  ar: {
    tagline: 'حسابك في متجر ليفونيس',
    signInTitle: 'تسجيل الدخول',
    signInHint: 'ادخل إلى حسابك للمتابعة.',
    signUpTitle: 'إنشاء حساب',
    signUpHint: 'أنشئ حسابًا جديدًا خلال دقيقة.',
    forgotTitle: 'إعادة تعيين كلمة المرور',
    forgotHint: 'أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة التعيين.',
    resetTitle: 'اختر كلمة مرور جديدة',
    resetHint: 'أدخل كلمة مرور جديدة لحسابك. رابط إعادة التعيين يصلح لمرة واحدة فقط.',
    identifier: 'البريد الإلكتروني أو اسم المستخدم',
    email: 'البريد الإلكتروني',
    username: 'اسم المستخدم',
    fullName: 'الاسم',
    password: 'كلمة المرور',
    newPassword: 'كلمة المرور الجديدة',
    confirmPassword: 'تأكيد كلمة المرور',
    showPassword: 'إظهار كلمة المرور',
    hidePassword: 'إخفاء كلمة المرور',
    forgotLink: 'هل نسيت كلمة المرور؟',
    signInCta: 'تسجيل الدخول',
    signingIn: 'جارٍ تسجيل الدخول…',
    signUpCta: 'إنشاء الحساب',
    signingUp: 'جارٍ إنشاء الحساب…',
    sendResetCta: 'إرسال رابط إعادة التعيين',
    sendingReset: 'جارٍ الإرسال…',
    setPasswordCta: 'تعيين كلمة المرور الجديدة',
    settingPassword: 'جارٍ الحفظ…',
    backToSignIn: 'العودة لتسجيل الدخول',
    noAccount: 'ليس لديك حساب؟',
    signUpAction: 'أنشئ حسابًا',
    haveAccount: 'لديك حساب بالفعل؟',
    signInAction: 'سجّل الدخول',
    orContinueWith: 'أو تابع عبر',
    googleUnavailable: 'تسجيل الدخول عبر Google غير مفعّل على هذه النسخة بعد (معرّف العميل غير مضبوط في البناء).',
    googleServerNotConfigured: 'تسجيل الدخول عبر Google غير مهيأ على الخادم بعد.',
    googleNoCredential: 'لم تُرجع Google بيانات الدخول. حاول مرة أخرى.',
    googleFailed: 'تعذر تسجيل الدخول عبر Google. حاول مرة أخرى.',
    summaryTitle: 'يتعذر المتابعة — راجع الحقول التالية:',
    errRequired: 'هذا الحقل مطلوب',
    errEmail: 'أدخل بريدًا إلكترونيًا صحيحًا',
    errUsernameMin: 'اسم المستخدم يجب ألا يقل عن 3 أحرف',
    errPasswordMin: 'كلمة المرور يجب ألا تقل عن 8 أحرف',
    errPasswordMismatch: 'كلمتا المرور غير متطابقتين',
    forgotSent: 'إذا كان هناك حساب بهذا البريد، فقد أُرسل إليه رابط إعادة التعيين.',
    emailNotConfigured:
      'إرسال بريد إعادة التعيين غير متاح بعد لأن خدمة البريد غير مهيأة على الخادم. يرجى التواصل مع الدعم.',
    resetDoneTitle: 'تم تغيير كلمة المرور بنجاح',
    resetDoneBody: 'يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.',
    resetUsedTitle: 'استُخدم هذا الرابط سابقًا',
    resetExpiredTitle: 'انتهت صلاحية الرابط',
    resetDeadBody: 'روابط إعادة التعيين تصلح لمرة واحدة ولمدة 30 دقيقة فقط. اطلب رابطًا جديدًا للمتابعة.',
    requestNewLink: 'طلب رابط جديد',
    referral: (code: string) => `دعوة صديق: ${code}`,
    genericError: 'حدث خطأ ما. حاول مرة أخرى.',
  },
  en: {
    tagline: 'Your LEVONIS store account',
    signInTitle: 'Sign in',
    signInHint: 'Access your account to continue.',
    signUpTitle: 'Create account',
    signUpHint: 'Set up a new account in a minute.',
    forgotTitle: 'Reset password',
    forgotHint: "Enter your email address and we'll send you a reset link.",
    resetTitle: 'Choose a new password',
    resetHint: 'Enter a new password for your account. The reset link can only be used once.',
    identifier: 'Email or username',
    email: 'Email',
    username: 'Username',
    fullName: 'Name',
    password: 'Password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    forgotLink: 'Forgot password?',
    signInCta: 'Sign in',
    signingIn: 'Signing in…',
    signUpCta: 'Create account',
    signingUp: 'Creating account…',
    sendResetCta: 'Send reset link',
    sendingReset: 'Sending…',
    setPasswordCta: 'Set new password',
    settingPassword: 'Saving…',
    backToSignIn: 'Back to sign in',
    noAccount: "Don't have an account?",
    signUpAction: 'Create one',
    haveAccount: 'Already have an account?',
    signInAction: 'Sign in',
    orContinueWith: 'Or continue with',
    googleUnavailable: 'Google sign-in is not enabled on this deployment yet (no client id was configured at build time).',
    googleServerNotConfigured: "Google sign-in isn't configured on the server yet.",
    googleNoCredential: 'Google did not return a credential. Please try again.',
    googleFailed: 'Google sign-in failed. Please try again.',
    summaryTitle: 'Please fix the following:',
    errRequired: 'This field is required',
    errEmail: 'Enter a valid email address',
    errUsernameMin: 'Username must be at least 3 characters',
    errPasswordMin: 'Password must be at least 8 characters',
    errPasswordMismatch: 'Passwords do not match',
    forgotSent: 'If an account exists for that email, a reset link has been sent.',
    emailNotConfigured:
      'Password reset email is not available yet because no email service is configured on the server. Please contact support.',
    resetDoneTitle: 'Password updated',
    resetDoneBody: 'You can now sign in with your new password.',
    resetUsedTitle: 'This link has already been used',
    resetExpiredTitle: 'This link has expired',
    resetDeadBody: 'Reset links work once and expire after 30 minutes. Request a new link to continue.',
    requestNewLink: 'Request a new link',
    referral: (code: string) => `Friend invite: ${code}`,
    genericError: 'Something went wrong. Please try again.',
  },
  ckb: {
    tagline: 'هەژمارەکەت لە فرۆشگای LEVONIS',
    signInTitle: 'چوونەژوورەوە',
    signInHint: 'بچۆرە ناو هەژمارەکەت بۆ بەردەوامبوون.',
    signUpTitle: 'دروستکردنی هەژمار',
    signUpHint: 'هەژمارێکی نوێ لە خولەکێکدا دروست بکە.',
    forgotTitle: 'ڕێکخستنەوەی وشەی نهێنی',
    forgotHint: 'ئیمەیلەکەت بنووسە، بەستەری ڕێکخستنەوەت بۆ دەنێرین.',
    resetTitle: 'وشەی نهێنی نوێ هەڵبژێرە',
    resetHint: 'وشەی نهێنیيەکی نوێ بۆ هەژمارەکەت بنووسە. ئەم بەستەرە تەنها جارێک کاردەکات.',
    identifier: 'ئیمەیل یان ناوی بەکارهێنەر',
    email: 'ئیمەیل',
    username: 'ناوی بەکارهێنەر',
    fullName: 'ناو',
    password: 'وشەی نهێنی',
    newPassword: 'وشەی نهێنی نوێ',
    confirmPassword: 'دووپاتکردنەوەی وشەی نهێنی',
    showPassword: 'پیشاندانی وشەی نهێنی',
    hidePassword: 'شاردنەوەی وشەی نهێنی',
    forgotLink: 'وشەی نهێنیت لەبیر چووە؟',
    signInCta: 'چوونەژوورەوە',
    signingIn: 'چاوەڕوان بە…',
    signUpCta: 'دروستکردنی هەژمار',
    signingUp: 'چاوەڕوان بە…',
    sendResetCta: 'ناردنی بەستەری ڕێکخستنەوە',
    sendingReset: 'دەنێردرێت…',
    setPasswordCta: 'دانانی وشەی نهێنی نوێ',
    settingPassword: 'پاشەکەوت دەکرێت…',
    backToSignIn: 'گەڕانەوە بۆ چوونەژوورەوە',
    noAccount: 'هەژمارت نییە؟',
    signUpAction: 'هەژمار دروست بکە',
    haveAccount: 'پێشتر هەژمارت هەیە؟',
    signInAction: 'بچۆرە ژوورەوە',
    orContinueWith: 'یان بەردەوام بە لەگەڵ',
    googleUnavailable: 'چوونەژوورەوە بە Google لەسەر ئەم وەشانە هێشتا چالاک نەکراوە (ناسنامەی کڕیار لە بنیاتنان دانەنراوە).',
    googleServerNotConfigured: 'چوونەژوورەوە بە Google لەسەر ڕاژەکار هێشتا ڕێکنەخراوە.',
    googleNoCredential: 'Google زانیاری چوونەژوورەوەی نەگەڕاندەوە. دووبارە هەوڵ بدە.',
    googleFailed: 'چوونەژوورەوە بە Google سەرکەوتوو نەبوو. دووبارە هەوڵ بدە.',
    summaryTitle: 'تکایە ئەم خانانە چاک بکە:',
    errRequired: 'ئەم خانەیە پێویستە',
    errEmail: 'ئیمەیلێکی دروست بنووسە',
    errUsernameMin: 'ناوی بەکارهێنەر دەبێت لانیکەم ٣ پیت بێت',
    errPasswordMin: 'وشەی نهێنی دەبێت لانیکەم ٨ پیت بێت',
    errPasswordMismatch: 'وشە نهێنیيەکان یەک ناگرنەوە',
    forgotSent: 'ئەگەر هەژمارێک بەم ئیمەیلە هەبێت، بەستەری ڕێکخستنەوەی بۆ نێردراوە.',
    emailNotConfigured:
      'ناردنی ئیمەیلی ڕێکخستنەوە هێشتا بەردەست نییە چونکە خزمەتگوزاری ئیمەیل لەسەر ڕاژەکار ڕێکنەخراوە. تکایە پەیوەندی بە پشتگیری بکە.',
    resetDoneTitle: 'وشەی نهێنی بە سەرکەوتوویی گۆڕدرا',
    resetDoneBody: 'ئێستا دەتوانیت بە وشەی نهێنی نوێ بچیتە ژوورەوە.',
    resetUsedTitle: 'ئەم بەستەرە پێشتر بەکارهێنراوە',
    resetExpiredTitle: 'ماوەی ئەم بەستەرە تەواو بووە',
    resetDeadBody: 'بەستەرەکانی ڕێکخستنەوە تەنها جارێک و بۆ ٣٠ خولەک کاردەکەن. بەستەرێکی نوێ داوا بکە.',
    requestNewLink: 'داواکردنی بەستەری نوێ',
    referral: (code: string) => `بانگهێشتی هاوڕێ: ${code}`,
    genericError: 'هەڵەیەک ڕوویدا. دووبارە هەوڵ بدە.',
  },
};

type AuthView = 'signin' | 'signup' | 'forgot';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { login, loginWithGoogle, register, refreshUser } = useAuth();
  const { lang, dir } = useLanguage();
  const s = STRINGS[lang];

  const resetToken = searchParams.get('reset') || '';
  // Friend-invite referral code from ?ref=CODE — kept in state so it survives
  // later URL cleanups (e.g. clearing the reset token param).
  const [referralCode] = useState(() => searchParams.get('ref') || '');
  // ?next= return destination, captured once for the same reason.
  const [nextFromQuery] = useState(() => searchParams.get('next') || '');
  // ProtectedRoute redirects can pass location.state.from (string or location
  // object). Sanitized to a same-origin relative path; falls back to "/".
  const stateFrom = (location.state as { from?: unknown } | null)?.from;
  const dest = sanitizeNextPath(stateFrom ?? nextFromQuery);

  const [view, setView] = useState<AuthView>('signin');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [forgotMessage, setForgotMessage] = useState('');
  const [emailNotConfigured, setEmailNotConfigured] = useState(false);

  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [resetDone, setResetDone] = useState(false);
  const [resetTokenError, setResetTokenError] = useState<'' | 'used' | 'expired'>('');

  // Honest not-configured state: without a build-time client id the Google
  // button could only ever fail, so we say so instead of rendering it.
  const rawGoogleClientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '';
  const googleConfigured = rawGoogleClientId.length > 0 && rawGoogleClientId !== 'YOUR_GOOGLE_CLIENT_ID';

  const errMsg = (err: unknown): string =>
    err instanceof Error && err.message ? err.message : s.genericError;

  const finishAuth = () => {
    navigate(dest, { replace: true });
  };

  const clearMessages = () => {
    setServerError('');
    setFieldErrors({});
    setForgotMessage('');
    setEmailNotConfigured(false);
  };

  const switchView = (next: AuthView) => {
    clearMessages();
    setView(next);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const errs: Record<string, string> = {};
    if (!email.trim()) errs.identifier = s.errRequired;
    if (!password) errs.password = s.errRequired;
    setFieldErrors(errs);
    setServerError('');
    if (Object.keys(errs).length > 0) return;
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      finishAuth();
    } catch (err) {
      setServerError(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const errs: Record<string, string> = {};
    if (username.trim().length < 3) errs.username = username.trim() ? s.errUsernameMin : s.errRequired;
    if (!name.trim()) errs.name = s.errRequired;
    if (!email.trim()) errs.email = s.errRequired;
    else if (!EMAIL_RE.test(email.trim())) errs.email = s.errEmail;
    if (password.length < 8) errs.password = password ? s.errPasswordMin : s.errRequired;
    if (confirmPassword !== password) errs.confirmPassword = s.errPasswordMismatch;
    setFieldErrors(errs);
    setServerError('');
    if (Object.keys(errs).length > 0) return;
    setSubmitting(true);
    try {
      if (referralCode) {
        // Referral-aware signup: send the invite code so the server can
        // attribute it, then refresh the session user from /me.
        await api.post('/api/auth/register', {
          username: username.trim(),
          name: name.trim(),
          email: email.trim(),
          password,
          referralCode,
        });
        await refreshUser();
      } else {
        await register(username.trim(), name.trim(), email.trim(), password);
      }
      finishAuth();
    } catch (err) {
      setServerError(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleCredential = async (credential: string | undefined) => {
    if (submitting) return;
    clearMessages();
    if (!credential) {
      setServerError(s.googleNoCredential);
      return;
    }
    setSubmitting(true);
    try {
      if (referralCode) {
        // The server attributes the referral only when this sign-in CREATES
        // a new account; existing accounts are never re-attributed.
        await api.post('/api/auth/google', { credential, referralCode });
        await refreshUser();
      } else {
        await loginWithGoogle(credential);
      }
      finishAuth();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 503 || err.code === 'GOOGLE_NOT_CONFIGURED')) {
        setServerError(s.googleServerNotConfigured);
      } else {
        setServerError(errMsg(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    clearMessages();
    if (!email.trim()) {
      setFieldErrors({ email: s.errRequired });
      return;
    }
    setSubmitting(true);
    try {
      // lang tells the server which language to write the reset email in.
      await api.post<{ message?: string }>('/api/auth/forgot-password', { email: email.trim(), lang });
      setForgotMessage(s.forgotSent);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 503 || err.code === 'EMAIL_NOT_CONFIGURED')) {
        // Honest disabled state: the server has no email service configured.
        setEmailNotConfigured(true);
      } else {
        setServerError(errMsg(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const errs: Record<string, string> = {};
    if (password.length < 8) errs.password = password ? s.errPasswordMin : s.errRequired;
    if (confirmPassword !== password) errs.confirmPassword = s.errPasswordMismatch;
    setFieldErrors(errs);
    setServerError('');
    if (Object.keys(errs).length > 0) return;
    setSubmitting(true);
    try {
      // The reset token is consumed ONLY here, on explicit submit — the page
      // never verifies (and therefore never burns) the token on load.
      await api.post('/api/auth/reset-password', { token: resetToken, password });
      setPassword('');
      setConfirmPassword('');
      setResetDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOKEN_USED') {
        setResetTokenError('used');
      } else if (err instanceof ApiError && err.code === 'TOKEN_EXPIRED') {
        setResetTokenError('expired');
      } else {
        setServerError(errMsg(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const switchToForgotForm = () => {
    // Leaves the dead-token screen for the forgot form: clear the token from
    // the URL and open the "send me a new link" flow.
    setSearchParams({}, { replace: true });
    setResetTokenError('');
    setResetDone(false);
    clearMessages();
    setView('forgot');
  };

  const backToLoginFromReset = () => {
    setSearchParams({}, { replace: true });
    setResetTokenError('');
    setResetDone(false);
    clearMessages();
    setView('signin');
  };

  // ---------------------------------------------------------- shared pieces

  const spinner = (
    <span
      aria-hidden
      className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-black/25 border-t-black motion-reduce:animate-none"
    />
  );

  const primaryButton = (label: string, workingLabel: string) => (
    <button
      type="submit"
      disabled={submitting}
      className="flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-2xl bg-gold text-[15px] font-bold text-black transition-all hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {submitting ? (
        <>
          {spinner}
          <span>{workingLabel}</span>
        </>
      ) : (
        label
      )}
    </button>
  );

  const backLink = (onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="-ms-2 mb-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-zinc-400 transition-colors hover:text-white"
    >
      <ArrowLeft className={`h-4 w-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
      {s.backToSignIn}
    </button>
  );

  const heading = (title: string, hint: string) => (
    <div className="mb-5">
      <h1 className="text-[22px] font-bold text-white">{title}</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{hint}</p>
    </div>
  );

  const fieldErrorList = Object.values(fieldErrors);
  const errorSummary =
    serverError || fieldErrorList.length > 0 ? (
      <div
        role="alert"
        className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[13px] text-red-300"
      >
        {serverError && <p className="font-medium">{serverError}</p>}
        {fieldErrorList.length > 0 && (
          <>
            <p className="font-medium">{s.summaryTitle}</p>
            <ul className="mt-1 list-disc space-y-0.5 ps-5">
              {fieldErrorList.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    ) : null;

  const referralChip = referralCode ? (
    /* Friend-invite chip: the ?ref=CODE is attributed server-side when this
       visit ends in a NEW account. */
    <div className="mb-4 flex justify-center">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/10 px-3 py-1.5 text-[12px] font-medium text-gold">
        <Gift className="h-3.5 w-3.5" />
        {s.referral(referralCode)}
      </span>
    </div>
  ) : null;

  const revealLabels = { show: s.showPassword, hide: s.hidePassword };

  const providerSection = (
    <div className="mt-6">
      <div className="flex items-center gap-3 py-1">
        <span aria-hidden className="h-px flex-1 bg-zinc-800" />
        <span className="text-[12px] text-zinc-500">{s.orContinueWith}</span>
        <span aria-hidden className="h-px flex-1 bg-zinc-800" />
      </div>
      <div className="mt-4 flex flex-col items-center gap-3">
        {googleConfigured ? (
          <GoogleLogin
            onSuccess={(credentialResponse) => handleGoogleCredential(credentialResponse.credential)}
            onError={() => setServerError(s.googleFailed)}
            theme="filled_black"
            text={view === 'signup' ? 'signup_with' : 'signin_with'}
          />
        ) : (
          <div className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-center text-[12px] leading-relaxed text-zinc-400">
            {s.googleUnavailable}
          </div>
        )}
        {/* Continue-with-Telegram method slot (component built separately). */}
        <div className="w-full">
          <TelegramAuth
            mode={view === 'signup' ? 'signup' : 'signin'}
            onSuccess={finishAuth}
            onSwitchMode={switchView}
          />
        </div>
      </div>
    </div>
  );

  // ---------------------------------------------------------------- screens

  let screenKey: string;
  let screen: React.ReactNode;

  if (resetToken) {
    if (resetDone) {
      screenKey = 'reset-done';
      screen = (
        <div className="flex flex-col items-center pt-2 text-center">
          <CheckCircle2 className="mb-4 h-12 w-12 text-gold" />
          <h1 className="mb-1.5 text-[20px] font-bold text-white">{s.resetDoneTitle}</h1>
          <p className="mb-7 max-w-xs text-[13px] leading-relaxed text-zinc-400">{s.resetDoneBody}</p>
          <button
            type="button"
            onClick={backToLoginFromReset}
            className="flex min-h-[52px] w-full items-center justify-center rounded-2xl bg-gold text-[15px] font-bold text-black transition-all hover:brightness-110 active:scale-[0.99]"
          >
            {s.signInCta}
          </button>
        </div>
      );
    } else if (resetTokenError) {
      screenKey = 'reset-dead';
      screen = (
        /* Dead-token screen: used vs expired, each with a way forward. */
        <div className="flex flex-col items-center pt-2 text-center">
          <h1 className="mb-1.5 text-[20px] font-bold text-white">
            {resetTokenError === 'used' ? s.resetUsedTitle : s.resetExpiredTitle}
          </h1>
          <p className="mb-7 max-w-xs text-[13px] leading-relaxed text-zinc-400">{s.resetDeadBody}</p>
          <button
            type="button"
            onClick={switchToForgotForm}
            className="flex min-h-[52px] w-full items-center justify-center rounded-2xl bg-gold text-[15px] font-bold text-black transition-all hover:brightness-110 active:scale-[0.99]"
          >
            {s.requestNewLink}
          </button>
          <button
            type="button"
            onClick={backToLoginFromReset}
            className="mt-4 inline-flex min-h-[44px] items-center justify-center gap-1.5 text-[13px] font-medium text-zinc-400 transition-colors hover:text-white"
          >
            <ArrowLeft className={`h-4 w-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
            {s.backToSignIn}
          </button>
        </div>
      );
    } else {
      screenKey = 'reset';
      screen = (
        <form onSubmit={handleReset} noValidate aria-busy={submitting}>
          {heading(s.resetTitle, s.resetHint)}
          {errorSummary}
          <div className="space-y-4">
            <AuthTextField
              id="new-password"
              label={s.newPassword}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              minLength={8}
              error={fieldErrors.password}
              revealLabels={revealLabels}
            />
            <AuthTextField
              id="confirm-password"
              label={s.confirmPassword}
              type="password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              minLength={8}
              error={fieldErrors.confirmPassword}
              revealLabels={revealLabels}
            />
          </div>
          <div className="mt-7">{primaryButton(s.setPasswordCta, s.settingPassword)}</div>
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={backToLoginFromReset}
              className="inline-flex min-h-[44px] items-center justify-center gap-1.5 text-[13px] font-medium text-zinc-400 transition-colors hover:text-white"
            >
              <ArrowLeft className={`h-4 w-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
              {s.backToSignIn}
            </button>
          </div>
        </form>
      );
    }
  } else if (view === 'forgot') {
    screenKey = 'forgot';
    screen = (
      <form onSubmit={handleForgot} noValidate aria-busy={submitting}>
        {backLink(() => switchView('signin'))}
        {heading(s.forgotTitle, s.forgotHint)}
        {emailNotConfigured && (
          /* Honest disabled state — the email service is not configured on
             the server, so no reset link can be sent yet. */
          <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] font-medium text-amber-300">
            {s.emailNotConfigured}
          </div>
        )}
        {forgotMessage && (
          <div
            role="status"
            className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-[13px] font-medium text-emerald-300"
          >
            {forgotMessage}
          </div>
        )}
        {errorSummary}
        <AuthTextField
          id="email"
          label={s.email}
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          inputMode="email"
          placeholder="email@example.com"
          valueDir="ltr"
          autoCapitalize="none"
          spellCheck={false}
          error={fieldErrors.email}
        />
        <div className="mt-7">{primaryButton(s.sendResetCta, s.sendingReset)}</div>
      </form>
    );
  } else if (view === 'signup') {
    screenKey = 'signup';
    // NOTE: providerSection contains TelegramAuth's own <form>; HTML forbids
    // nested forms (the browser drops the inner tag and its submit button
    // would submit THIS form instead), so it must sit outside the element.
    screen = (
      <>
      <form onSubmit={handleSignUp} noValidate aria-busy={submitting}>
        {backLink(() => switchView('signin'))}
        {heading(s.signUpTitle, s.signUpHint)}
        {referralChip}
        {errorSummary}
        <div className="space-y-4">
          <AuthTextField
            id="username"
            label={s.username}
            value={username}
            onChange={setUsername}
            autoComplete="username"
            placeholder="username123"
            minLength={3}
            valueDir="ltr"
            autoCapitalize="none"
            spellCheck={false}
            error={fieldErrors.username}
          />
          <AuthTextField
            id="name"
            label={s.fullName}
            value={name}
            onChange={setName}
            autoComplete="name"
            valueDir="auto"
            error={fieldErrors.name}
          />
          <AuthTextField
            id="email"
            label={s.email}
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            inputMode="email"
            placeholder="email@example.com"
            valueDir="ltr"
            autoCapitalize="none"
            spellCheck={false}
            error={fieldErrors.email}
          />
          <AuthTextField
            id="new-password"
            label={s.password}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            minLength={8}
            error={fieldErrors.password}
            revealLabels={revealLabels}
          />
          <AuthTextField
            id="confirm-password"
            label={s.confirmPassword}
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            minLength={8}
            error={fieldErrors.confirmPassword}
            revealLabels={revealLabels}
          />
        </div>
        <div className="mt-7">{primaryButton(s.signUpCta, s.signingUp)}</div>
      </form>
      {providerSection}
      <p className="mt-6 text-center text-[13px] text-zinc-400">
        {s.haveAccount}{' '}
        <button
          type="button"
          onClick={() => switchView('signin')}
          className="inline-flex min-h-[44px] items-center px-1 align-middle font-bold text-gold hover:underline"
        >
          {s.signInAction}
        </button>
      </p>
      </>
    );
  } else {
    screenKey = 'signin';
    // Same nested-form constraint as the signup screen above.
    screen = (
      <>
      <form onSubmit={handleSignIn} noValidate aria-busy={submitting}>
        {heading(s.signInTitle, s.signInHint)}
        {referralChip}
        {errorSummary}
        <div className="space-y-4">
          <AuthTextField
            id="identifier"
            label={s.identifier}
            value={email}
            onChange={setEmail}
            autoComplete="username"
            inputMode="email"
            placeholder="email@example.com"
            valueDir="ltr"
            autoCapitalize="none"
            spellCheck={false}
            error={fieldErrors.identifier}
          />
          <div>
            <AuthTextField
              id="current-password"
              label={s.password}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              error={fieldErrors.password}
              revealLabels={revealLabels}
            />
            <div className="mt-1.5 flex justify-end">
              <button
                type="button"
                onClick={() => switchView('forgot')}
                className="inline-flex min-h-[44px] items-center px-1 text-[12px] font-medium text-zinc-400 transition-colors hover:text-gold"
              >
                {s.forgotLink}
              </button>
            </div>
          </div>
        </div>
        <div className="mt-4">{primaryButton(s.signInCta, s.signingIn)}</div>
      </form>
      {providerSection}
      <p className="mt-6 text-center text-[13px] text-zinc-400">
        {s.noAccount}{' '}
        <button
          type="button"
          onClick={() => switchView('signup')}
          className="inline-flex min-h-[44px] items-center px-1 align-middle font-bold text-gold hover:underline"
        >
          {s.signUpAction}
        </button>
      </p>
      </>
    );
  }

  // ------------------------------------------------------------------ page

  return (
    <div
      dir={dir}
      className="lv-auth min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden bg-gradient-to-br from-black via-black to-olive-dark font-sans text-white"
    >
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="m-auto w-full py-4">
          {/* Brand: LEVONIS wordmark in the site's gold, calm and balanced. */}
          <div className="mb-6 flex flex-col items-center">
            <Link
              to="/"
              aria-label="LEVONIS"
              className="flex min-h-[44px] items-center justify-center"
            >
              <span
                dir="ltr"
                className="text-[26px] font-black leading-none text-gold"
                style={{ letterSpacing: '0.35em', paddingInlineStart: '0.35em' }}
              >
                LEVONIS
              </span>
            </Link>
            <span
              aria-hidden
              className="mt-2 h-px w-24 bg-gradient-to-r from-transparent via-gold/70 to-transparent"
            />
            <p className="mt-2 text-[12px] text-zinc-500">{s.tagline}</p>
          </div>

          <div className="w-full rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-5 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.8)] backdrop-blur-md sm:p-7">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={screenKey}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
              >
                {screen}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
