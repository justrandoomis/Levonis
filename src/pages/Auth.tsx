import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, Mail, Phone as PhoneIcon, Send, Chrome } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import AuthTextField from '../components/auth/AuthTextField';
import TelegramAuth from '../components/auth/TelegramAuth';
import { sanitizeNextPath } from '../components/auth/nextPath';
import FillButton, {
  clamp01,
  isValidEmailAddress,
  emailFieldProgress,
  lengthProgress,
  combineFillProgress,
} from '../components/auth/FillButton';
import PhoneField, { emptyPhoneValue, type PhoneValue } from '../components/auth/PhoneField';
import MethodSwitch, {
  methodPanelId,
  methodTabId,
  type AuthMethod,
} from '../components/auth/MethodSwitch';
import ReferralBar from '../components/auth/ReferralBar';
import '../components/auth/auth.css';

/**
 * /auth — one dark LEVONIS screen (integrated mandate §2).
 *
 * Organization (§2.1): sign-in / create-account / forgot / reset stay
 * separate steps, and INSIDE sign-in & sign-up the four methods
 * (email / phone / Google / Telegram) are a segmented MethodSwitch — never
 * one long column of every form at once. Non-sensitive values (email,
 * username, name, phone) survive method switches; passwords/OTP never touch
 * localStorage/analytics/logs.
 *
 * FillButton (§2.2): the submit button's background fills with REAL
 * validation progress and enables only when every rule passes — never on
 * text length alone and never because an animation finished. Enter submits
 * when (and only when) the button is ready.
 *
 * Server contracts:
 * - POST /api/auth/login    { identifier (email|username|phone), password }
 *   (the legacy `email` field carries the same value for the current server)
 * - POST /api/auth/register { username, name, email, password, referralCode? }
 *   and — once the auth-server slice enables it — { phone, ... }; until then
 *   the server's rejection is shown honestly, never faked around.
 * - POST /api/auth/google   { credential, referralCode? }  (GIS credential)
 * - GET  /api/auth/referrer-info?ref=…  (ReferralBar, §2.6 — 404 = honest
 *   "code not found", continuing without a code is always allowed)
 * - POST /api/auth/forgot-password { email, lang } · POST /api/auth/reset-password
 *
 * Return-to-destination: `location.state.from` or `?next=` AFTER
 * sanitizeNextPath() — same-origin relative paths only, else "/".
 */

const STRINGS = {
  ar: {
    tagline: 'حسابك في متجر ليفونيس',
    signInTitle: 'تسجيل الدخول',
    signInHint: 'اختر طريقة الدخول ثم أكمل بياناتك.',
    signUpTitle: 'إنشاء حساب',
    signUpHint: 'أنشئ حسابًا جديدًا بالطريقة التي تناسبك.',
    forgotTitle: 'إعادة تعيين كلمة المرور',
    forgotHint: 'أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة التعيين.',
    resetTitle: 'اختر كلمة مرور جديدة',
    resetHint: 'أدخل كلمة مرور جديدة لحسابك. رابط إعادة التعيين يصلح لمرة واحدة فقط.',
    methodsLabel: 'طريقة الدخول',
    methodEmail: 'البريد',
    methodPhone: 'الهاتف',
    methodTelegram: 'تيليغرام',
    identifier: 'البريد الإلكتروني أو اسم المستخدم',
    email: 'البريد الإلكتروني',
    username: 'اسم المستخدم',
    fullName: 'الاسم',
    optionalSuffix: ' (اختياري)',
    password: 'كلمة المرور',
    newPassword: 'كلمة المرور الجديدة',
    confirmPassword: 'تأكيد كلمة المرور',
    showPassword: 'إظهار كلمة المرور',
    hidePassword: 'إخفاء كلمة المرور',
    forgotLink: 'هل نسيت كلمة المرور؟',
    phoneLabel: 'رقم الهاتف',
    countryLabel: 'الدولة',
    phoneOwnershipNote: 'إثبات ملكية الرقم مطلوب لإكمال تسجيل الهاتف.',
    phoneRegisterUnavailable:
      'التسجيل برقم الهاتف وكلمة مرور غير مفعّل على الخادم بعد. يمكنك التسجيل بالبريد أو عبر تيليغرام.',
    errPhone: 'أدخل رقم هاتف صحيحًا (لموبايل عراقي: يبدأ بـ 7 وطوله 10 أرقام بعد +964)',
    errPasswordMismatch: 'كلمتا المرور غير متطابقتين',
    signInCta: 'تسجيل الدخول',
    signingIn: 'جارٍ تسجيل الدخول…',
    signUpCta: 'إنشاء الحساب',
    signingUp: 'جارٍ إنشاء الحساب…',
    sendResetCta: 'إرسال رابط إعادة التعيين',
    sendingReset: 'جارٍ الإرسال…',
    setPasswordCta: 'تعيين كلمة المرور الجديدة',
    settingPassword: 'جارٍ الحفظ…',
    hintIdentifier: 'أدخل بريدك الإلكتروني أو اسم المستخدم (3 أحرف على الأقل)',
    hintPasswordLogin: 'أدخل كلمة المرور',
    hintPhone: 'أكمل رقم الهاتف',
    hintUsername: 'اسم المستخدم: 3–30 من الأحرف الإنجليزية أو الأرقام أو . _ -',
    hintName: 'أدخل الاسم',
    hintEmail: 'أدخل بريدًا إلكترونيًا صحيحًا',
    hintPassword: 'كلمة المرور: 8 محارف على الأقل',
    hintConfirm: 'أعد كتابة كلمة المرور نفسها للتأكيد',
    backToSignIn: 'العودة لتسجيل الدخول',
    noAccount: 'ليس لديك حساب؟',
    signUpAction: 'أنشئ حسابًا',
    haveAccount: 'لديك حساب بالفعل؟',
    signInAction: 'سجّل الدخول',
    termsPrefix: 'بإنشاء الحساب فأنت توافق على',
    termsLink: 'الشروط وسياسة الخصوصية',
    googleUnavailable: 'تسجيل الدخول عبر Google غير مفعّل على هذه النسخة بعد (معرّف العميل غير مضبوط في البناء).',
    googleServerNotConfigured: 'تسجيل الدخول عبر Google غير مهيأ على الخادم بعد.',
    googleNoCredential: 'لم تُرجع Google بيانات الدخول. حاول مرة أخرى.',
    googleFailed: 'تعذر تسجيل الدخول عبر Google. حاول مرة أخرى.',
    forgotSent: 'إذا كان هناك حساب بهذا البريد، فقد أُرسل إليه رابط إعادة التعيين.',
    emailNotConfigured:
      'إرسال بريد إعادة التعيين غير متاح بعد لأن خدمة البريد غير مهيأة على الخادم. يرجى التواصل مع الدعم.',
    resetDoneTitle: 'تم تغيير كلمة المرور بنجاح',
    resetDoneBody: 'يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.',
    resetUsedTitle: 'استُخدم هذا الرابط سابقًا',
    resetExpiredTitle: 'انتهت صلاحية الرابط',
    resetDeadBody: 'روابط إعادة التعيين تصلح لمرة واحدة ولمدة 30 دقيقة فقط. اطلب رابطًا جديدًا للمتابعة.',
    requestNewLink: 'طلب رابط جديد',
    genericError: 'حدث خطأ ما. حاول مرة أخرى.',
  },
  en: {
    tagline: 'Your LEVONIS store account',
    signInTitle: 'Sign in',
    signInHint: 'Pick a method, then complete your details.',
    signUpTitle: 'Create account',
    signUpHint: 'Create a new account with the method that suits you.',
    forgotTitle: 'Reset password',
    forgotHint: "Enter your email address and we'll send you a reset link.",
    resetTitle: 'Choose a new password',
    resetHint: 'Enter a new password for your account. The reset link can only be used once.',
    methodsLabel: 'Sign-in method',
    methodEmail: 'Email',
    methodPhone: 'Phone',
    methodTelegram: 'Telegram',
    identifier: 'Email or username',
    email: 'Email',
    username: 'Username',
    fullName: 'Name',
    optionalSuffix: ' (optional)',
    password: 'Password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    forgotLink: 'Forgot password?',
    phoneLabel: 'Phone number',
    countryLabel: 'Country',
    phoneOwnershipNote: 'Proving you own the number is required to complete phone sign-up.',
    phoneRegisterUnavailable:
      'Phone + password registration is not enabled on the server yet. You can sign up with email or via Telegram.',
    errPhone: 'Enter a valid phone number (Iraqi mobile: starts with 7, 10 digits after +964)',
    errPasswordMismatch: 'Passwords do not match',
    signInCta: 'Sign in',
    signingIn: 'Signing in…',
    signUpCta: 'Create account',
    signingUp: 'Creating account…',
    sendResetCta: 'Send reset link',
    sendingReset: 'Sending…',
    setPasswordCta: 'Set new password',
    settingPassword: 'Saving…',
    hintIdentifier: 'Enter your email or username (at least 3 characters)',
    hintPasswordLogin: 'Enter your password',
    hintPhone: 'Complete the phone number',
    hintUsername: 'Username: 3–30 letters, digits or . _ -',
    hintName: 'Enter your name',
    hintEmail: 'Enter a valid email address',
    hintPassword: 'Password: at least 8 characters',
    hintConfirm: 'Repeat the same password to confirm',
    backToSignIn: 'Back to sign in',
    noAccount: "Don't have an account?",
    signUpAction: 'Create one',
    haveAccount: 'Already have an account?',
    signInAction: 'Sign in',
    termsPrefix: 'By creating an account you agree to the',
    termsLink: 'Terms & Privacy Policy',
    googleUnavailable: 'Google sign-in is not enabled on this deployment yet (no client id was configured at build time).',
    googleServerNotConfigured: "Google sign-in isn't configured on the server yet.",
    googleNoCredential: 'Google did not return a credential. Please try again.',
    googleFailed: 'Google sign-in failed. Please try again.',
    forgotSent: 'If an account exists for that email, a reset link has been sent.',
    emailNotConfigured:
      'Password reset email is not available yet because no email service is configured on the server. Please contact support.',
    resetDoneTitle: 'Password updated',
    resetDoneBody: 'You can now sign in with your new password.',
    resetUsedTitle: 'This link has already been used',
    resetExpiredTitle: 'This link has expired',
    resetDeadBody: 'Reset links work once and expire after 30 minutes. Request a new link to continue.',
    requestNewLink: 'Request a new link',
    genericError: 'Something went wrong. Please try again.',
  },
  ckb: {
    tagline: 'هەژمارەکەت لە فرۆشگای LEVONIS',
    signInTitle: 'چوونەژوورەوە',
    signInHint: 'شێوازێک هەڵبژێرە و زانیارییەکانت تەواو بکە.',
    signUpTitle: 'دروستکردنی هەژمار',
    signUpHint: 'بەو شێوازەی گونجاوە هەژمارێکی نوێ دروست بکە.',
    forgotTitle: 'ڕێکخستنەوەی وشەی نهێنی',
    forgotHint: 'ئیمەیلەکەت بنووسە، بەستەری ڕێکخستنەوەت بۆ دەنێرین.',
    resetTitle: 'وشەی نهێنی نوێ هەڵبژێرە',
    resetHint: 'وشەی نهێنیيەکی نوێ بۆ هەژمارەکەت بنووسە. ئەم بەستەرە تەنها جارێک کاردەکات.',
    methodsLabel: 'شێوازی چوونەژوورەوە',
    methodEmail: 'ئیمەیل',
    methodPhone: 'مۆبایل',
    methodTelegram: 'تێلێگرام',
    identifier: 'ئیمەیل یان ناوی بەکارهێنەر',
    email: 'ئیمەیل',
    username: 'ناوی بەکارهێنەر',
    fullName: 'ناو',
    optionalSuffix: ' (ئارەزوومەندانە)',
    password: 'وشەی نهێنی',
    newPassword: 'وشەی نهێنی نوێ',
    confirmPassword: 'دووپاتکردنەوەی وشەی نهێنی',
    showPassword: 'پیشاندانی وشەی نهێنی',
    hidePassword: 'شاردنەوەی وشەی نهێنی',
    forgotLink: 'وشەی نهێنیت لەبیر چووە؟',
    phoneLabel: 'ژمارەی مۆبایل',
    countryLabel: 'وڵات',
    phoneOwnershipNote: 'بۆ تەواوکردنی تۆمارکردن بە مۆبایل، سەلماندنی خاوەندارێتی ژمارەکە پێویستە.',
    phoneRegisterUnavailable:
      'تۆمارکردن بە ژمارەی مۆبایل و وشەی نهێنی هێشتا لەسەر ڕاژەکار چالاک نەکراوە. دەتوانیت بە ئیمەیل یان تێلێگرام تۆمار بیت.',
    errPhone: 'ژمارەیەکی دروست بنووسە (مۆبایلی عێراقی: بە 7 دەست پێدەکات و 10 ژمارەیە دوای +964)',
    errPasswordMismatch: 'وشە نهێنیيەکان یەک ناگرنەوە',
    signInCta: 'چوونەژوورەوە',
    signingIn: 'چاوەڕوان بە…',
    signUpCta: 'دروستکردنی هەژمار',
    signingUp: 'چاوەڕوان بە…',
    sendResetCta: 'ناردنی بەستەری ڕێکخستنەوە',
    sendingReset: 'دەنێردرێت…',
    setPasswordCta: 'دانانی وشەی نهێنی نوێ',
    settingPassword: 'پاشەکەوت دەکرێت…',
    hintIdentifier: 'ئیمەیل یان ناوی بەکارهێنەرت بنووسە (لانیکەم ٣ پیت)',
    hintPasswordLogin: 'وشەی نهێنیت بنووسە',
    hintPhone: 'ژمارەی مۆبایلەکە تەواو بکە',
    hintUsername: 'ناوی بەکارهێنەر: ٣–٣٠ لە پیتی ئینگلیزی، ژمارە یان . _ -',
    hintName: 'ناوەکەت بنووسە',
    hintEmail: 'ئیمەیلێکی دروست بنووسە',
    hintPassword: 'وشەی نهێنی: لانیکەم ٨ پیت',
    hintConfirm: 'هەمان وشەی نهێنی دووبارە بنووسە بۆ دووپاتکردنەوە',
    backToSignIn: 'گەڕانەوە بۆ چوونەژوورەوە',
    noAccount: 'هەژمارت نییە؟',
    signUpAction: 'هەژمار دروست بکە',
    haveAccount: 'پێشتر هەژمارت هەیە؟',
    signInAction: 'بچۆرە ژوورەوە',
    termsPrefix: 'بە دروستکردنی هەژمار ڕازیت بە',
    termsLink: 'مەرجەکان و سیاسەتی تایبەتمەندی',
    googleUnavailable: 'چوونەژوورەوە بە Google لەسەر ئەم وەشانە هێشتا چالاک نەکراوە (ناسنامەی کڕیار لە بنیاتنان دانەنراوە).',
    googleServerNotConfigured: 'چوونەژوورەوە بە Google لەسەر ڕاژەکار هێشتا ڕێکنەخراوە.',
    googleNoCredential: 'Google زانیاری چوونەژوورەوەی نەگەڕاندەوە. دووبارە هەوڵ بدە.',
    googleFailed: 'چوونەژوورەوە بە Google سەرکەوتوو نەبوو. دووبارە هەوڵ بدە.',
    forgotSent: 'ئەگەر هەژمارێک بەم ئیمەیلە هەبێت، بەستەری ڕێکخستنەوەی بۆ نێردراوە.',
    emailNotConfigured:
      'ناردنی ئیمەیلی ڕێکخستنەوە هێشتا بەردەست نییە چونکە خزمەتگوزاری ئیمەیل لەسەر ڕاژەکار ڕێکنەخراوە. تکایە پەیوەندی بە پشتگیری بکە.',
    resetDoneTitle: 'وشەی نهێنی بە سەرکەوتوویی گۆڕدرا',
    resetDoneBody: 'ئێستا دەتوانیت بە وشەی نهێنی نوێ بچیتە ژوورەوە.',
    resetUsedTitle: 'ئەم بەستەرە پێشتر بەکارهێنراوە',
    resetExpiredTitle: 'ماوەی ئەم بەستەرە تەواو بووە',
    resetDeadBody: 'بەستەرەکانی ڕێکخستنەوە تەنها جارێک و بۆ ٣٠ خولەک کاردەکەن. بەستەرێکی نوێ داوا بکە.',
    requestNewLink: 'داواکردنی بەستەری نوێ',
    genericError: 'هەڵەیەک ڕوویدا. دووبارە هەوڵ بدە.',
  },
};

type AuthView = 'signin' | 'signup' | 'forgot';

/** Client mirror of worker/lib/http.ts USERNAME_RE (server lowercases). */
const USERNAME_SHAPE_RE = /^[a-zA-Z0-9._-]{3,30}$/;

const METHOD_ID_PREFIX = 'auth-method';

export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { loginWithGoogle, refreshUser } = useAuth();
  const { lang, dir } = useLanguage();
  const s = STRINGS[lang];

  const resetToken = searchParams.get('reset') || '';
  // Friend-invite referral code from ?ref=CODE — user-editable in the
  // ReferralBar (§2.6), page-level so it survives view/method switches and
  // later URL cleanups. The user's explicitly chosen code wins.
  const [referralCode, setReferralCode] = useState(() => searchParams.get('ref') || '');
  const [refFromLink] = useState(() => !!searchParams.get('ref'));
  // ?next= return destination, captured once for the same reason.
  const [nextFromQuery] = useState(() => searchParams.get('next') || '');
  // ProtectedRoute redirects can pass location.state.from (string or location
  // object). Sanitized to a same-origin relative path; falls back to "/".
  const stateFrom = (location.state as { from?: unknown } | null)?.from;
  const dest = sanitizeNextPath(stateFrom ?? nextFromQuery);

  const [view, setView] = useState<AuthView>('signin');
  const [method, setMethod] = useState<AuthMethod>('email');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const [forgotMessage, setForgotMessage] = useState('');
  const [emailNotConfigured, setEmailNotConfigured] = useState(false);

  // Field values are PAGE-level so switching method/view never loses
  // non-sensitive input (§2.1). Passwords live only in memory here — never
  // in localStorage/analytics/logs.
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState<PhoneValue>(() => emptyPhoneValue());
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
    // The Studio sign-in resume leg is a WORKER route, not an SPA page:
    // react-router would only render the catch-all for it. A full navigation
    // lets the worker mint the single-use handoff code and 302 onward to the
    // Studio host. dest already passed sanitizeNextPath (relative,
    // same-origin), so this cannot become an open redirect.
    if (dest.startsWith('/api/studio/handoff/start')) {
      window.location.assign(dest);
      return;
    }
    navigate(dest, { replace: true });
  };

  const clearMessages = () => {
    setServerError('');
    setForgotMessage('');
    setEmailNotConfigured(false);
  };

  const switchView = (next: AuthView) => {
    clearMessages();
    setView(next);
  };

  const switchMethod = (next: AuthMethod) => {
    // Values are intentionally KEPT (only messages clear) — §2.1.
    clearMessages();
    setMethod(next);
  };

  // ------------------------------------------------- real-validation state
  // Readiness comes ONLY from these rules (never text length alone, never
  // the animation). Recomputed every render ⇒ deleting a character regresses
  // both the fill and the clickability instantly.

  const trimmedEmail = email.trim();
  const trimmedUsername = username.trim();
  const trimmedName = name.trim();

  const emailValid = isValidEmailAddress(trimmedEmail);
  const emailProgress = emailFieldProgress(trimmedEmail);

  // Sign-in identifier: an email must be a valid email; a username needs
  // its minimum shape. (The server stays the authority on the credentials.)
  const signinIdValid = trimmedEmail.includes('@') ? emailValid : trimmedEmail.length >= 3;
  const signinIdProgress = trimmedEmail.includes('@') ? emailProgress : clamp01(trimmedEmail.length / 3);
  // Existing-account password: required, but NOT held to the new-account
  // minimum — old valid accounts must never be locked out by UI rules (§2.2).
  const loginPwPart = { progress: password ? 1 : 0, valid: password.length > 0 };

  const signinEmailFill = combineFillProgress([
    { progress: signinIdProgress, valid: signinIdValid },
    loginPwPart,
  ]);
  const signinPhoneFill = combineFillProgress([
    { progress: phone.progress, valid: phone.valid },
    loginPwPart,
  ]);

  // New-account password: minimum 8 characters of ANY kind (§2.2).
  const newPwValid = password.length >= 8 && password.length <= 128;
  const newPwPart = { progress: lengthProgress(password, 8), valid: newPwValid };
  const confirmValid = newPwValid && confirmPassword === password;
  const confirmPart = {
    progress: confirmValid ? 1 : password ? clamp01(confirmPassword.length / password.length) : 0,
    valid: confirmValid,
  };

  const usernameValid = USERNAME_SHAPE_RE.test(trimmedUsername);
  const signupEmailFill = combineFillProgress([
    { progress: clamp01(trimmedUsername.length / 3), valid: usernameValid },
    { progress: trimmedName ? 1 : 0, valid: trimmedName.length > 0 },
    { progress: emailProgress, valid: emailValid },
    newPwPart,
    confirmPart,
  ]);

  // Phone sign-up: username/name optional (a phone account is not a fake
  // email account — absent fields stay absent, §2.3).
  const usernameOptValid = trimmedUsername === '' || usernameValid;
  const signupPhoneFill = combineFillProgress([
    { progress: phone.progress, valid: phone.valid },
    { progress: trimmedUsername === '' ? 1 : clamp01(trimmedUsername.length / 3), valid: usernameOptValid },
    newPwPart,
    confirmPart,
  ]);

  const forgotFill = combineFillProgress([{ progress: emailProgress, valid: emailValid }]);
  const resetFill = combineFillProgress([newPwPart, confirmPart]);

  // First missing requirement — the not-ready button's visible reason (§2.2).
  const signinEmailHint = !signinIdValid ? s.hintIdentifier : !password ? s.hintPasswordLogin : '';
  const signinPhoneHint = !phone.valid ? s.hintPhone : !password ? s.hintPasswordLogin : '';
  const signupEmailHint = !usernameValid
    ? s.hintUsername
    : !trimmedName
      ? s.hintName
      : !emailValid
        ? s.hintEmail
        : !newPwValid
          ? s.hintPassword
          : !confirmValid
            ? s.hintConfirm
            : '';
  const signupPhoneHint = !phone.valid
    ? s.hintPhone
    : !usernameOptValid
      ? s.hintUsername
      : !newPwValid
        ? s.hintPassword
        : !confirmValid
          ? s.hintConfirm
          : '';

  // Inline errors only where they genuinely help while typing.
  const confirmMismatchError =
    confirmPassword && password && confirmPassword.length >= password.length && confirmPassword !== password
      ? s.errPasswordMismatch
      : undefined;
  const phoneInlineError =
    phone.national && !phone.valid &&
    ((phone.iso === 'IQ' && !phone.national.startsWith('7')) || phone.national.length >= 10)
      ? s.errPhone
      : undefined;

  // ---------------------------------------------------------------- submits

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const fill = method === 'phone' ? signinPhoneFill : signinEmailFill;
    if (!fill.ready) return; // button is disabled; belt-and-suspenders
    clearMessages();
    const identifier = method === 'phone' ? (phone.e164 as string) : trimmedEmail;
    setSubmitting(true);
    try {
      // Auth-server contract: identifier = email | username | phone. The
      // legacy `email` field carries the same value so the current server
      // keeps working until that slice lands.
      await api.post('/api/auth/login', { identifier, email: identifier, password });
      await refreshUser();
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
    const fill = method === 'phone' ? signupPhoneFill : signupEmailFill;
    if (!fill.ready) return;
    clearMessages();
    const referral = referralCode.trim();
    setSubmitting(true);
    try {
      if (method === 'phone') {
        // Enabled by the auth-server slice; until then the server's honest
        // rejection is surfaced below — never faked around.
        await api.post('/api/auth/register', {
          phone: phone.e164,
          ...(trimmedUsername ? { username: trimmedUsername } : {}),
          ...(trimmedName ? { name: trimmedName } : {}),
          password,
          ...(referral ? { referralCode: referral } : {}),
        });
      } else {
        await api.post('/api/auth/register', {
          username: trimmedUsername,
          name: trimmedName,
          email: trimmedEmail,
          password,
          ...(referral ? { referralCode: referral } : {}),
        });
      }
      await refreshUser();
      finishAuth();
    } catch (err) {
      if (
        method === 'phone' &&
        err instanceof ApiError &&
        (err.code === 'PHONE_REGISTER_DISABLED' || (err.status === 400 && /email/i.test(err.message)))
      ) {
        // The server (still) requires an email — phone+password registration
        // isn't enabled there yet. Say so honestly.
        setServerError(s.phoneRegisterUnavailable);
      } else {
        setServerError(errMsg(err));
      }
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
    const referral = referralCode.trim();
    setSubmitting(true);
    try {
      if (referral) {
        // The server attributes the referral only when this sign-in CREATES
        // a new account; existing accounts are never re-attributed.
        await api.post('/api/auth/google', { credential, referralCode: referral });
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
    if (!forgotFill.ready) return;
    clearMessages();
    setSubmitting(true);
    try {
      // lang tells the server which language to write the reset email in.
      await api.post<{ message?: string }>('/api/auth/forgot-password', { email: trimmedEmail, lang });
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
    if (!resetFill.ready) return;
    setServerError('');
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

  const errorSummary = serverError ? (
    <div
      role="alert"
      className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300"
    >
      {serverError}
    </div>
  ) : null;

  const revealLabels = { show: s.showPassword, hide: s.hidePassword };

  const buttonStatus = submitting ? 'submitting' : serverError ? 'error' : 'idle';

  const methodOptions = [
    { id: 'email' as const, label: s.methodEmail, icon: <Mail className="h-5 w-5" /> },
    { id: 'phone' as const, label: s.methodPhone, icon: <PhoneIcon className="h-5 w-5" /> },
    { id: 'google' as const, label: 'Google', icon: <Chrome className="h-5 w-5" /> },
    { id: 'telegram' as const, label: s.methodTelegram, icon: <Send className="h-5 w-5" /> },
  ];

  const methodPanel = (m: AuthMethod, children: React.ReactNode) => (
    <div role="tabpanel" id={methodPanelId(METHOD_ID_PREFIX, m)} aria-labelledby={methodTabId(METHOD_ID_PREFIX, m)}>
      {children}
    </div>
  );

  const googlePanel = (
    <div className="flex flex-col items-center gap-3 pt-1">
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
    </div>
  );

  /** Animated wrapper around the active method's panel. */
  const methodArea = (children: React.ReactNode) => (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={method}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.15 }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );

  const passwordField = (
    autoComplete: 'current-password' | 'new-password',
    label: string = s.password
  ) => (
    <AuthTextField
      id={autoComplete === 'new-password' ? 'new-password' : 'current-password'}
      label={label}
      type="password"
      value={password}
      onChange={setPassword}
      autoComplete={autoComplete}
      minLength={autoComplete === 'new-password' ? 8 : undefined}
      revealLabels={revealLabels}
    />
  );

  const confirmField = (
    <AuthTextField
      id="confirm-password"
      label={s.confirmPassword}
      type="password"
      value={confirmPassword}
      onChange={setConfirmPassword}
      autoComplete="new-password"
      minLength={8}
      error={confirmMismatchError}
      revealLabels={revealLabels}
    />
  );

  const forgotRow = (
    <div className="mt-1.5 flex justify-end">
      <button
        type="button"
        onClick={() => switchView('forgot')}
        className="inline-flex min-h-[44px] items-center px-1 text-[12px] font-medium text-zinc-400 transition-colors hover:text-gold"
      >
        {s.forgotLink}
      </button>
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
            {passwordField('new-password', s.newPassword)}
            {confirmField}
          </div>
          <div className="mt-7">
            <FillButton
              id="reset-submit"
              label={s.setPasswordCta}
              workingLabel={s.settingPassword}
              progress={resetFill.progress}
              ready={resetFill.ready}
              status={buttonStatus}
              hint={!newPwValid ? s.hintPassword : !confirmValid ? s.hintConfirm : undefined}
            />
          </div>
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
        />
        <div className="mt-7">
          <FillButton
            id="forgot-submit"
            label={s.sendResetCta}
            workingLabel={s.sendingReset}
            progress={forgotFill.progress}
            ready={forgotFill.ready}
            status={buttonStatus}
            hint={!emailValid ? s.hintEmail : undefined}
          />
        </div>
      </form>
    );
  } else if (view === 'signup') {
    screenKey = 'signup';
    screen = (
      <>
        {backLink(() => switchView('signin'))}
        {heading(s.signUpTitle, s.signUpHint)}
        {/* §2.6 — optional referral bar; the code survives every method
            switch and is attributed server-side only when an account is
            actually created. It NEVER blocks signup. */}
        <div className="mb-4">
          <ReferralBar
            code={referralCode}
            onCodeChange={setReferralCode}
            fromLink={refFromLink}
            disabled={submitting}
          />
        </div>
        <MethodSwitch
          options={methodOptions}
          value={method}
          onChange={switchMethod}
          ariaLabel={s.methodsLabel}
          dir={dir}
          idPrefix={METHOD_ID_PREFIX}
        />
        <div className="mt-5">
          {errorSummary}
          {methodArea(
            method === 'email' ? (
              methodPanel(
                'email',
                <form onSubmit={handleSignUp} noValidate aria-busy={submitting}>
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
                    />
                    <AuthTextField
                      id="name"
                      label={s.fullName}
                      value={name}
                      onChange={setName}
                      autoComplete="name"
                      valueDir="auto"
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
                    />
                    {passwordField('new-password')}
                    {confirmField}
                  </div>
                  <div className="mt-7">
                    <FillButton
                      id="signup-submit"
                      label={s.signUpCta}
                      workingLabel={s.signingUp}
                      progress={signupEmailFill.progress}
                      ready={signupEmailFill.ready}
                      status={buttonStatus}
                      hint={signupEmailHint || undefined}
                    />
                  </div>
                </form>
              )
            ) : method === 'phone' ? (
              methodPanel(
                'phone',
                <form onSubmit={handleSignUp} noValidate aria-busy={submitting}>
                  <div className="space-y-4">
                    <PhoneField
                      id="signup-phone"
                      label={s.phoneLabel}
                      countryLabel={s.countryLabel}
                      value={phone}
                      onChange={setPhone}
                      lang={lang}
                      error={phoneInlineError}
                      hint={s.phoneOwnershipNote}
                      disabled={submitting}
                    />
                    <AuthTextField
                      id="username"
                      label={`${s.username}${s.optionalSuffix}`}
                      value={username}
                      onChange={setUsername}
                      autoComplete="username"
                      placeholder="username123"
                      valueDir="ltr"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    <AuthTextField
                      id="name"
                      label={`${s.fullName}${s.optionalSuffix}`}
                      value={name}
                      onChange={setName}
                      autoComplete="name"
                      valueDir="auto"
                    />
                    {passwordField('new-password')}
                    {confirmField}
                  </div>
                  <div className="mt-7">
                    <FillButton
                      id="signup-phone-submit"
                      label={s.signUpCta}
                      workingLabel={s.signingUp}
                      progress={signupPhoneFill.progress}
                      ready={signupPhoneFill.ready}
                      status={buttonStatus}
                      hint={signupPhoneHint || undefined}
                    />
                  </div>
                </form>
              )
            ) : method === 'google' ? (
              methodPanel('google', googlePanel)
            ) : (
              methodPanel(
                'telegram',
                /* TelegramAuth owns its own <form>; rendering it as its own
                   panel keeps the no-nested-forms rule trivially true. */
                <TelegramAuth mode="signup" onSuccess={finishAuth} onSwitchMode={switchView} />
              )
            )
          )}
        </div>
        <p className="mt-4 text-center text-[12px] leading-relaxed text-zinc-500">
          {s.termsPrefix}{' '}
          <Link to="/policies" className="font-semibold text-gold hover:underline">
            {s.termsLink}
          </Link>
        </p>
        <p className="mt-4 text-center text-[13px] text-zinc-400">
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
    screen = (
      <>
        {heading(s.signInTitle, s.signInHint)}
        <MethodSwitch
          options={methodOptions}
          value={method}
          onChange={switchMethod}
          ariaLabel={s.methodsLabel}
          dir={dir}
          idPrefix={METHOD_ID_PREFIX}
        />
        <div className="mt-5">
          {errorSummary}
          {methodArea(
            method === 'email' ? (
              methodPanel(
                'email',
                <form onSubmit={handleSignIn} noValidate aria-busy={submitting}>
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
                    />
                    <div>
                      {passwordField('current-password')}
                      {forgotRow}
                    </div>
                  </div>
                  <div className="mt-4">
                    <FillButton
                      id="signin-submit"
                      label={s.signInCta}
                      workingLabel={s.signingIn}
                      progress={signinEmailFill.progress}
                      ready={signinEmailFill.ready}
                      status={buttonStatus}
                      hint={signinEmailHint || undefined}
                    />
                  </div>
                </form>
              )
            ) : method === 'phone' ? (
              methodPanel(
                'phone',
                <form onSubmit={handleSignIn} noValidate aria-busy={submitting}>
                  <div className="space-y-4">
                    <PhoneField
                      id="signin-phone"
                      label={s.phoneLabel}
                      countryLabel={s.countryLabel}
                      value={phone}
                      onChange={setPhone}
                      lang={lang}
                      error={phoneInlineError}
                      disabled={submitting}
                    />
                    <div>
                      {passwordField('current-password')}
                      {forgotRow}
                    </div>
                  </div>
                  <div className="mt-4">
                    <FillButton
                      id="signin-phone-submit"
                      label={s.signInCta}
                      workingLabel={s.signingIn}
                      progress={signinPhoneFill.progress}
                      ready={signinPhoneFill.ready}
                      status={buttonStatus}
                      hint={signinPhoneHint || undefined}
                    />
                  </div>
                </form>
              )
            ) : method === 'google' ? (
              methodPanel('google', googlePanel)
            ) : (
              methodPanel(
                'telegram',
                <TelegramAuth mode="signin" onSuccess={finishAuth} onSwitchMode={switchView} />
              )
            )
          )}
        </div>
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
      {/* Balanced card: full width minus padding on phones, a fixed
          comfortable max on iPad/desktop — the form never stretches across
          a large screen (§2.1). */}
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-0">
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
