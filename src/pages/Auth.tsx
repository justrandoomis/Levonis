import React, { useEffect, useState } from 'react';
import { ArrowLeft, AtSign, CheckCircle2, Lock, Mail, Send, UserRound } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import AuthShell from '../components/auth/AuthShell';
import AuthDivider from '../components/auth/AuthDivider';
import AuthTextField from '../components/auth/AuthTextField';
import GoogleAuthButton from '../components/auth/GoogleAuthButton';
import SocialAuthButton, { TelegramIcon } from '../components/auth/SocialAuthButton';
import TelegramAuth from '../components/auth/TelegramAuth';
import { sanitizeNextPath } from '../components/auth/nextPath';
import FillButton, {
  type FillButtonStatus,
  clamp01,
  isValidEmailAddress,
  emailFieldProgress,
  lengthProgress,
  combineFillProgress,
} from '../components/auth/FillButton';
import { useCapabilities } from '../hooks/useCapabilities';
import { toAsciiDigitsClient } from '../components/auth/PhoneField';
import ReferralBar from '../components/auth/ReferralBar';

/**
 * /auth — the door into LEVONIS, styled as the control surface of a premium
 * 3D-printing machine (AuthShell owns the manufacturing scene behind it).
 *
 * Organization: email/password is the PRIMARY interface, visible immediately
 * — no method tabs. Google and Telegram are secondary actions under an "أو"
 * seam; tapping Telegram swaps the card to the Telegram-verified phone flow
 * (the only route that can prove number ownership), with a way back.
 * Non-sensitive values (email, username, name) survive every swap;
 * passwords/OTP never touch localStorage/analytics/logs.
 *
 * FillButton (§2.2): the submit button's background fills with REAL
 * validation progress and enables only when every rule passes — never on
 * text length alone and never because an animation finished. Enter submits
 * when (and only when) the button is ready.
 *
 * Server contracts (unchanged by the redesign):
 * - POST /api/auth/login    { identifier (email|username|phone), password }
 *   (the legacy `email` field carries the same value for the current server)
 * - POST /api/auth/register { username, name, email, password, referralCode? }
 * - POST /api/auth/google   { credential, referralCode? }  (GIS credential)
 * - GET  /api/auth/referrer-info?ref=…  (ReferralBar — 404 = honest
 *   "code not found", continuing without a code is always allowed)
 * - POST /api/auth/forgot-password { email, lang } · POST /api/auth/reset-password
 *
 * Return-to-destination: `location.state.from` or `?next=` AFTER
 * sanitizeNextPath() — same-origin relative paths only, else "/".
 */

const STRINGS = {
  ar: {
    signInTitle: 'تسجيل الدخول',
    signInHint: 'أدخل بياناتك للمتابعة إلى حسابك.',
    signUpTitle: 'إنشاء حساب',
    signUpHint: 'أنشئ حسابك الجديد في ليفونيس.',
    forgotTitle: 'إعادة تعيين كلمة المرور',
    forgotHint: 'أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة التعيين.',
    resetTitle: 'اختر كلمة مرور جديدة',
    resetHint: 'أدخل كلمة مرور جديدة لحسابك. رابط إعادة التعيين يصلح لمرة واحدة فقط.',
    identifier: 'البريد الإلكتروني أو اسم المستخدم أو رقم الهاتف',
    identifierPlaceholder: 'email@example.com',
    googleNote: 'سنستخدم اسمك وبريدك من Google فقط. لن نصل إلى أي شيء آخر في حسابك.',
    email: 'البريد الإلكتروني',
    username: 'اسم المستخدم',
    fullName: 'الاسم',
    password: 'كلمة المرور',
    newPassword: 'كلمة المرور الجديدة',
    confirmPassword: 'تأكيد كلمة المرور',
    showPassword: 'إظهار كلمة المرور',
    hidePassword: 'إخفاء كلمة المرور',
    forgotLink: 'نسيت كلمة المرور؟',
    orLabel: 'أو',
    backLabel: 'رجوع',
    continueWithTelegram: 'المتابعة باستخدام تيليغرام',
    googleWorking: 'جارٍ المتابعة عبر Google…',
    errPasswordMismatch: 'كلمتا المرور غير متطابقتين',
    signInCta: 'تسجيل الدخول',
    signingIn: 'جارٍ تسجيل الدخول…',
    signedIn: 'تم تسجيل الدخول',
    signUpCta: 'إنشاء الحساب',
    signingUp: 'جارٍ إنشاء الحساب…',
    signedUp: 'تم إنشاء الحساب',
    sendResetCta: 'إرسال رابط إعادة التعيين',
    sendingReset: 'جارٍ الإرسال…',
    resetSent: 'تم إرسال الطلب',
    setPasswordCta: 'تعيين كلمة المرور الجديدة',
    settingPassword: 'جارٍ الحفظ…',
    hintIdentifier: 'أدخل بريدك الإلكتروني أو اسم المستخدم (3 أحرف على الأقل)',
    hintPasswordLogin: 'أدخل كلمة المرور',
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
    errLoginFailed: 'البريد أو اسم المستخدم أو الهاتف أو كلمة المرور غير صحيحة. إن أنشأت حسابك عبر Google أو تيليغرام فاستخدم زره.',
    errEmailTaken: 'يوجد حساب بهذا البريد بالفعل. سجّل الدخول بدلًا من ذلك.',
    errUsernameTaken: 'اسم المستخدم هذا محجوز بالفعل. جرّب اسمًا آخر.',
    errUsernameReserved: 'اسم المستخدم هذا محجوز للمنصّة.',
    errUsernameShort: 'اسم المستخدم يجب أن يكون ٣ أحرف على الأقل.',
    errUsernameChars: 'اسم المستخدم يقبل الأحرف الإنجليزية والأرقام و . _ - فقط.',
    errMailOff: 'خدمة البريد غير مهيأة على هذه النسخة، لذلك لا يمكن إرسال رسالة الآن. تواصل مع الدعم.',
    errGoogleNeedsVerify: 'يوجد حساب بهذا البريد لم يُوثَّق بعد. سجّل الدخول بكلمة المرور ووثّق بريدك، ثم سيُربط Google تلقائيًا.',
    errResetLink: 'رابط إعادة التعيين غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
    errTooMany: 'محاولات كثيرة جدًا. انتظر قليلًا ثم حاول مرة أخرى.',
    errNetwork: 'تعذّر الاتصال. تحقّق من اتصالك وحاول مرة أخرى.',
  },
  en: {
    signInTitle: 'Sign in',
    signInHint: 'Enter your details to continue.',
    signUpTitle: 'Create account',
    signUpHint: 'Create your new LEVONIS account.',
    forgotTitle: 'Reset password',
    forgotHint: "Enter your email address and we'll send you a reset link.",
    resetTitle: 'Choose a new password',
    resetHint: 'Enter a new password for your account. The reset link can only be used once.',
    identifier: 'Email, username or phone',
    identifierPlaceholder: 'email@example.com',
    googleNote: 'We only use your name and email from Google. Nothing else in your account is touched.',
    email: 'Email',
    username: 'Username',
    fullName: 'Name',
    password: 'Password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    forgotLink: 'Forgot password?',
    orLabel: 'or',
    backLabel: 'Back',
    continueWithTelegram: 'Continue with Telegram',
    googleWorking: 'Continuing with Google…',
    errPasswordMismatch: 'Passwords do not match',
    signInCta: 'Sign in',
    signingIn: 'Signing in…',
    signedIn: 'Signed in',
    signUpCta: 'Create account',
    signingUp: 'Creating account…',
    signedUp: 'Account created',
    sendResetCta: 'Send reset link',
    sendingReset: 'Sending…',
    resetSent: 'Request sent',
    setPasswordCta: 'Set new password',
    settingPassword: 'Saving…',
    hintIdentifier: 'Enter your email or username (at least 3 characters)',
    hintPasswordLogin: 'Enter your password',
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
    errLoginFailed: 'Incorrect email, username, phone or password. If you created your account with Google or Telegram, use that button.',
    errEmailTaken: 'An account with this email already exists. Sign in instead.',
    errUsernameTaken: 'That username is already taken. Try another one.',
    errUsernameReserved: 'That username is reserved for the platform.',
    errUsernameShort: 'A username must be at least 3 characters.',
    errUsernameChars: 'A username may only contain letters, numbers and . _ -',
    errMailOff: 'The mail service is not configured on this deployment, so nothing can be sent right now. Please contact support.',
    errGoogleNeedsVerify: 'An account with this email exists but was never verified. Sign in with your password and verify your email — Google then links automatically.',
    errResetLink: 'That reset link is invalid or has expired. Request a new one.',
    errTooMany: 'Too many attempts. Wait a moment and try again.',
    errNetwork: 'Could not reach the server. Check your connection and try again.',
  },
  ckb: {
    signInTitle: 'چوونەژوورەوە',
    signInHint: 'زانیارییەکانت بنووسە بۆ بەردەوامبوون.',
    signUpTitle: 'دروستکردنی هەژمار',
    signUpHint: 'هەژمارە نوێیەکەت لە LEVONIS دروست بکە.',
    forgotTitle: 'ڕێکخستنەوەی وشەی نهێنی',
    forgotHint: 'ئیمەیلەکەت بنووسە، بەستەری ڕێکخستنەوەت بۆ دەنێرین.',
    resetTitle: 'وشەی نهێنی نوێ هەڵبژێرە',
    resetHint: 'وشەی نهێنیيەکی نوێ بۆ هەژمارەکەت بنووسە. ئەم بەستەرە تەنها جارێک کاردەکات.',
    identifier: 'ئیمەیل، ناوی بەکارهێنەر یان ژمارەی تەلەفۆن',
    identifierPlaceholder: 'email@example.com',
    googleNote: 'تەنها ناو و ئیمەیلەکەت لە Google بەکاردەهێنین. هیچی تر لە هەژمارەکەت دەستی لێنادرێت.',
    email: 'ئیمەیل',
    username: 'ناوی بەکارهێنەر',
    fullName: 'ناو',
    password: 'وشەی نهێنی',
    newPassword: 'وشەی نهێنی نوێ',
    confirmPassword: 'دووپاتکردنەوەی وشەی نهێنی',
    showPassword: 'پیشاندانی وشەی نهێنی',
    hidePassword: 'شاردنەوەی وشەی نهێنی',
    forgotLink: 'وشەی نهێنیت لەبیر چووە؟',
    orLabel: 'یان',
    backLabel: 'گەڕانەوە',
    continueWithTelegram: 'بەردەوامبوون بە تێلێگرام',
    googleWorking: 'بەردەوامبوون بە Google…',
    errPasswordMismatch: 'وشە نهێنیيەکان یەک ناگرنەوە',
    signInCta: 'چوونەژوورەوە',
    signingIn: 'چاوەڕوان بە…',
    signedIn: 'چوویتە ژوورەوە',
    signUpCta: 'دروستکردنی هەژمار',
    signingUp: 'چاوەڕوان بە…',
    signedUp: 'هەژمار دروستکرا',
    sendResetCta: 'ناردنی بەستەری ڕێکخستنەوە',
    sendingReset: 'دەنێردرێت…',
    resetSent: 'داواکارییەکە نێردرا',
    setPasswordCta: 'دانانی وشەی نهێنی نوێ',
    settingPassword: 'پاشەکەوت دەکرێت…',
    hintIdentifier: 'ئیمەیل یان ناوی بەکارهێنەرت بنووسە (لانیکەم ٣ پیت)',
    hintPasswordLogin: 'وشەی نهێنیت بنووسە',
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
    errLoginFailed: 'ئیمەیل، ناوی بەکارهێنەر، ژمارە یان وشەی نهێنی هەڵەیە. ئەگەر هەژمارەکەت بە Google یان تەلەگرام دروستکردووە، ئەو دوگمەیە بەکاربهێنە.',
    errEmailTaken: 'هەژمارێک بەم ئیمەیلە هەیە. لەبری ئەوە بچۆرەژوورەوە.',
    errUsernameTaken: 'ئەم ناوە پێشتر وەرگیراوە. یەکێکی تر تاقی بکەرەوە.',
    errUsernameReserved: 'ئەم ناوە بۆ پلاتفۆرمەکە پاراستراوە.',
    errUsernameShort: 'ناوی بەکارهێنەر دەبێت لانیکەم ٣ پیت بێت.',
    errUsernameChars: 'ناوی بەکارهێنەر تەنها پیت و ژمارە و . _ - قبوڵ دەکات.',
    errMailOff: 'خزمەتگوزاری ئیمەیل لەسەر ئەم وەشانە ڕێکنەخراوە، بۆیە ئێستا هیچ نانێردرێت. پەیوەندی بە پشتگیری بکە.',
    errGoogleNeedsVerify: 'هەژمارێک بەم ئیمەیلە هەیە بەڵام پشتڕاست نەکراوەتەوە. بە وشەی نهێنی بچۆرەژوورەوە و ئیمەیلەکەت پشتڕاست بکەرەوە، پاشان Google خۆکارانە دەبەسترێتەوە.',
    errResetLink: 'ئەم بەستەرەی ڕێکخستنەوە نادروستە یان بەسەرچووە. بەستەرێکی نوێ داوا بکە.',
    errTooMany: 'هەوڵی زۆر. کەمێک چاوەڕێ بکە و دووبارە هەوڵ بدە.',
    errNetwork: 'نەتوانرا پەیوەندی بکرێت. پەیوەندییەکەت بپشکنە و دووبارە هەوڵ بدە.',
  },
};

type AuthView = 'signin' | 'signup' | 'forgot';
/** What the card is currently showing inside a view. */
type AuthPanel = 'form' | 'telegram';

/** Client mirror of worker/lib/http.ts USERNAME_RE (server lowercases). */
const USERNAME_SHAPE_RE = /^[a-zA-Z0-9._-]{3,30}$/;

/**
 * Does what somebody typed into the identifier field LOOK like a phone
 * number? Used only to decide whether to offer the Telegram route after a
 * failed sign-in — never to validate anything, and never fed by the server,
 * so it leaks nothing about which accounts exist.
 */
export function looksLikePhone(identifier: string): boolean {
  const digits = toAsciiDigitsClient(identifier).replace(/[\s\-().+]/g, '');
  return /^\d{7,15}$/.test(digits) && !identifier.includes('@');
}

export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { loginWithGoogle, refreshUser } = useAuth();
  const { lang, dir } = useLanguage();
  const s = STRINGS[lang];
  // Respect the OS "reduce motion" setting everywhere on this screen — the
  // step transitions become plain cross-fades and the stagger collapses.
  const reduceMotion = useReducedMotion();
  const slide = reduceMotion ? 0 : 6;

  const resetToken = searchParams.get('reset') || '';
  // Friend-invite referral code from ?ref=CODE — user-editable in the
  // ReferralBar (§2.6), page-level so it survives view/panel switches and
  // later URL cleanups. The user's explicitly chosen code wins.
  const [referralCode, setReferralCode] = useState(() => searchParams.get('ref') || '');
  const [refFromLink] = useState(() => !!searchParams.get('ref'));
  // ?next= return destination, captured once for the same reason.
  const [nextFromQuery] = useState(() => searchParams.get('next') || '');
  // ProtectedRoute redirects can pass location.state.from (string or location
  // object). Sanitized to a same-origin relative path; falls back to "/".
  const stateFrom = (location.state as { from?: unknown } | null)?.from;
  const dest = sanitizeNextPath(stateFrom ?? nextFromQuery);

  // §2.6: someone who followed an invite link is here to CREATE an account,
  // so the sign-up step (the only one that carries the referral bar) opens
  // first and the inviter's name is resolved before they finish registering.
  const [view, setView] = useState<AuthView>(() => (searchParams.get('ref') ? 'signup' : 'signin'));
  const [panel, setPanel] = useState<AuthPanel>('form');
  const [submitting, setSubmitting] = useState(false);
  // Which action is in flight. The form CTA and the Google slot are both on
  // screen now, so a Google roundtrip must never animate the form button.
  const [via, setVia] = useState<'form' | 'google' | null>(null);
  // A REAL success (the server answered 2xx), never assumed: it is set only
  // after a resolved request and drives the FillButton's success state.
  const [succeeded, setSucceeded] = useState(false);
  const [serverError, setServerError] = useState('');
  // Set only when the SERVER says phone sign-up needs ownership proof — the
  // page then offers the Telegram verification path instead of pretending.
  const [phoneNeedsTelegram, setPhoneNeedsTelegram] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');
  const [emailNotConfigured, setEmailNotConfigured] = useState(false);

  // Field values are PAGE-level so switching panel/view never loses
  // non-sensitive input. Passwords live only in memory here — never in
  // localStorage/analytics/logs.
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [resetDone, setResetDone] = useState(false);
  const [resetTokenError, setResetTokenError] = useState<'' | 'used' | 'expired'>('');

  /**
   * WHICH METHODS THIS DEPLOYMENT ACTUALLY HAS, asked at runtime.
   *
   * One answer, from the deployment itself (/api/auth/capabilities); the
   * build carries no provider configuration at all. `null` means the answer
   * has not arrived; email/password is rendered meanwhile because it is the
   * platform's own and needs no configuration. An unconfigured provider is
   * not shown as a disabled button with an explanation — it is simply not
   * offered.
   */
  const caps = useCapabilities();
  const googleConfigured = !!caps?.google;
  const googleClientId = caps?.googleClientId ?? '';
  const resetConfigured = caps?.passwordReset ?? false;
  const telegramConfigured = caps?.telegram ?? false;

  /**
   * If the open Telegram panel stops being offered — the capabilities answer
   * arrives and says Telegram is off, or a stale state is restored — fall
   * back to the form instead of rendering an empty panel.
   */
  useEffect(() => {
    if (panel === 'telegram' && caps && !caps.telegram) setPanel('form');
  }, [caps, panel]);

  /**
   * A refusal, in the reader's language.
   *
   * Server messages are written for every caller and several are bilingual
   * ("… / …") because they have no idea who is reading. The UI does know, so
   * a KNOWN code is rendered from this page's own strings and only an
   * unrecognised one falls through to the server's wording — which is still
   * better than a generic "something went wrong" that hides a real answer.
   */
  const CODE_MESSAGES: Record<string, string> = {
    LOGIN_FAILED: s.errLoginFailed,
    EMAIL_TAKEN: s.errEmailTaken,
    USERNAME_TAKEN: s.errUsernameTaken,
    USERNAME_RESERVED: s.errUsernameReserved,
    USERNAME_TOO_SHORT: s.errUsernameShort,
    USERNAME_BAD_CHARACTERS: s.errUsernameChars,
    EMAIL_NOT_CONFIGURED: s.errMailOff,
    GOOGLE_NOT_CONFIGURED: s.googleServerNotConfigured,
    EMAIL_NOT_VERIFIED: s.errGoogleNeedsVerify,
    BAD_TOKEN: s.errResetLink,
    TOKEN_USED: s.errResetLink,
    TOKEN_EXPIRED: s.errResetLink,
    RATE_LIMITED: s.errTooMany,
  };

  const errMsg = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code && CODE_MESSAGES[err.code]) return CODE_MESSAGES[err.code];
      if (err.status === 429) return s.errTooMany;
      if (err.status === 0) return s.errNetwork;
    }
    return err instanceof Error && err.message ? err.message : s.genericError;
  };

  const finishAuth = (createdAccount = false) => {
    // A brand-new account goes through setup first, carrying the intended
    // destination with it so the person still lands where they were going.
    // Signing IN never does — asking an existing customer to "set up their
    // account" every time they log in is the behaviour this whole feature is
    // meant to avoid.
    if (createdAccount && !dest.startsWith('/api/')) {
      navigate(`/welcome?next=${encodeURIComponent(dest)}`, { replace: true });
      return;
    }
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
    setPhoneNeedsTelegram(false);
    setSucceeded(false);
    setForgotMessage('');
    setEmailNotConfigured(false);
  };

  const switchView = (next: AuthView) => {
    clearMessages();
    setPanel('form');
    setView(next);
  };

  const openTelegram = () => {
    clearMessages();
    setPanel('telegram');
  };

  // Editing ANY field leaves a previous success state behind: the meter and
  // the button must always describe the CURRENT input, so a sent request can
  // never leave the button stuck in a stale success (§2.2).
  const clearSuccessOnEdit = () => {
    if (succeeded) setSucceeded(false);
  };
  const onEmailChange = (v: string) => {
    clearSuccessOnEdit();
    setEmail(v);
  };
  const onUsernameChange = (v: string) => {
    clearSuccessOnEdit();
    setUsername(v);
  };
  const onNameChange = (v: string) => {
    clearSuccessOnEdit();
    setName(v);
  };
  const onPasswordChange = (v: string) => {
    clearSuccessOnEdit();
    setPassword(v);
  };
  const onConfirmChange = (v: string) => {
    clearSuccessOnEdit();
    setConfirmPassword(v);
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

  const forgotFill = combineFillProgress([{ progress: emailProgress, valid: emailValid }]);
  const resetFill = combineFillProgress([newPwPart, confirmPart]);

  // First missing requirement — the not-ready button's visible reason (§2.2).
  const signinEmailHint = !signinIdValid ? s.hintIdentifier : !password ? s.hintPasswordLogin : '';
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

  // Inline errors only where they genuinely help while typing.
  const confirmMismatchError =
    confirmPassword && password && confirmPassword.length >= password.length && confirmPassword !== password
      ? s.errPasswordMismatch
      : undefined;

  // ---------------------------------------------------------------- submits

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!signinEmailFill.ready) return; // button is disabled; belt-and-suspenders
    clearMessages();
    // One field, three kinds of identifier — the server has always matched
    // email, username OR verified phone against this value.
    const identifier = trimmedEmail;
    setVia('form');
    setSubmitting(true);
    try {
      // Auth-server contract: identifier = email | username | phone. The
      // legacy `email` field carries the same value so the current server
      // keeps working until that slice lands.
      await api.post('/api/auth/login', { identifier, email: identifier, password });
      await refreshUser();
      setSucceeded(true); // the server answered — this is not an assumption
      finishAuth();
    } catch (err) {
      setServerError(errMsg(err));
      // A sign-in that failed on something the person typed as a PHONE
      // NUMBER is the one case where the next step is not "try again": an
      // account created through Telegram may have no password at all. The
      // offer is made from what they typed, never from anything the server
      // revealed about whether that account exists.
      setPhoneNeedsTelegram(telegramConfigured && looksLikePhone(trimmedEmail));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!signupEmailFill.ready) return;
    clearMessages();
    const referral = referralCode.trim();
    setVia('form');
    setSubmitting(true);
    try {
      await api.post('/api/auth/register', {
        username: trimmedUsername,
        name: trimmedName,
        email: trimmedEmail,
        password,
        locale: lang,
        ...(referral ? { referralCode: referral } : {}),
      });
      await refreshUser();
      setSucceeded(true);
      finishAuth(true);
    } catch (err) {
      setServerError(errMsg(err));
      // The server still refuses to create an account on an unproven phone
      // number, and it always will. The signup form no longer offers one, so
      // this can only be reached by a client that sent one anyway — the reply
      // is still the real path rather than a bare error.
      setPhoneNeedsTelegram(
        telegramConfigured && err instanceof ApiError && err.code === 'PHONE_REQUIRES_VERIFICATION'
      );
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
    setVia('google');
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
      setSucceeded(true);
      // Google does not tell the browser whether the account was created or
      // matched, and it does not need to: /welcome sends anyone who has
      // already finished setup straight on to where they were going.
      finishAuth(view === 'signup');
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
    setVia('form');
    setSubmitting(true);
    try {
      // lang tells the server which language to write the reset email in.
      await api.post<{ message?: string }>('/api/auth/forgot-password', { email: trimmedEmail, lang });
      setForgotMessage(s.forgotSent);
      setSucceeded(true);
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
    setVia('form');
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

  // -------------------------------------------------------- motion recipes
  // One orchestrated entrance per screen: title, then fields, CTA, seam,
  // providers, footer — 50ms apart. Collapses to nothing under reduced
  // motion. The outer AnimatePresence still cross-fades between screens.

  const listV = {
    hidden: {},
    show: { transition: { staggerChildren: reduceMotion ? 0 : 0.05 } },
  };
  const itemV = {
    hidden: { opacity: 0, y: reduceMotion ? 0 : 10 },
    show: { opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease: 'easeOut' as const } },
  };

  // ---------------------------------------------------------- shared pieces

  const backLink = (onClick: () => void, label: string = s.backToSignIn) => (
    <button
      type="button"
      onClick={onClick}
      className="-ms-2 mb-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-zinc-400 transition-colors hover:text-white"
    >
      <ArrowLeft className={`h-4 w-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
      {label}
    </button>
  );

  const heading = (title: string, hint: string) => (
    <div className="mb-5">
      <h1 className="text-[24px] font-extrabold leading-tight text-white">{title}</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{hint}</p>
    </div>
  );

  const errorSummary = serverError ? (
    <div
      role="alert"
      className="mb-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300"
    >
      <p className="leading-relaxed">{serverError}</p>
      {phoneNeedsTelegram && (
        /* The server refused to create a phone account without ownership
           proof — hand the user the real path instead of a dead end. */
        <button
          type="button"
          onClick={openTelegram}
          className="mt-2.5 inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-gold/40 bg-gold/10 px-3.5 text-[13px] font-bold text-gold transition-colors hover:bg-gold/20"
        >
          <Send className="h-4 w-4" aria-hidden />
          {s.continueWithTelegram}
        </button>
      )}
    </div>
  ) : null;

  const revealLabels = { show: s.showPassword, hide: s.hidePassword };

  // incomplete/ready → idle, then submitting → success | error (§2.2). Only
  // the FORM's own roundtrips drive the form CTA; a Google roundtrip dims
  // the Google slot instead.
  const buttonStatus: FillButtonStatus =
    submitting && via === 'form'
      ? 'submitting'
      : succeeded && via === 'form'
        ? 'success'
        : serverError && via === 'form'
          ? 'error'
          : 'idle';

  const googleBusy = submitting && via === 'google';

  const passwordField = (
    autoComplete: 'current-password' | 'new-password',
    label: string = s.password
  ) => (
    <AuthTextField
      id={autoComplete === 'new-password' ? 'new-password' : 'current-password'}
      label={label}
      type="password"
      value={password}
      onChange={onPasswordChange}
      autoComplete={autoComplete}
      minLength={autoComplete === 'new-password' ? 8 : undefined}
      icon={<Lock className="h-[18px] w-[18px]" />}
      revealLabels={revealLabels}
    />
  );

  const confirmField = (
    <AuthTextField
      id="confirm-password"
      label={s.confirmPassword}
      type="password"
      value={confirmPassword}
      onChange={onConfirmChange}
      autoComplete="new-password"
      minLength={8}
      error={confirmMismatchError}
      icon={<Lock className="h-[18px] w-[18px]" />}
      revealLabels={revealLabels}
    />
  );

  // Offering "forgot password" when no mail provider is configured sends a
  // person to a screen whose only possible answer is "we cannot email you".
  const forgotRow = !resetConfigured ? null : (
    <div className="mt-1 flex justify-end">
      <button
        type="button"
        onClick={() => switchView('forgot')}
        className="inline-flex min-h-[44px] items-center px-1 text-[12px] font-medium text-zinc-400 transition-colors hover:text-gold"
      >
        {s.forgotLink}
      </button>
    </div>
  );

  /**
   * The secondary sign-in actions: an "أو" seam, then Google (its official
   * credential button, staged) and Telegram as full-width quiet buttons.
   * Providers this deployment does not have simply do not appear.
   */
  const providerBlock =
    googleConfigured || telegramConfigured ? (
      <>
        <motion.div variants={itemV}>
          <AuthDivider label={s.orLabel} />
        </motion.div>
        <div className="space-y-2.5">
          {googleConfigured && (
            <motion.div variants={itemV}>
              <GoogleAuthButton
                onCredential={handleGoogleCredential}
                onError={() => setServerError(s.googleFailed)}
                view={view === 'signup' ? 'signup' : 'signin'}
                busy={googleBusy}
              />
              <span className="sr-only" role="status">
                {googleBusy ? s.googleWorking : ''}
              </span>
            </motion.div>
          )}
          {telegramConfigured && (
            <motion.div variants={itemV}>
              <SocialAuthButton
                icon={<TelegramIcon />}
                label={s.continueWithTelegram}
                onClick={openTelegram}
                disabled={submitting}
              />
            </motion.div>
          )}
        </div>
        {googleConfigured && (
          <motion.div variants={itemV}>
            <p className="mt-2.5 text-center text-[11px] leading-relaxed text-zinc-600">{s.googleNote}</p>
          </motion.div>
        )}
      </>
    ) : null;

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
          <button type="button" onClick={backToLoginFromReset} className="lv-btn-gold">
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
          <button type="button" onClick={switchToForgotForm} className="lv-btn-gold">
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
          <div className="mt-6">
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
          onChange={onEmailChange}
          autoComplete="email"
          inputMode="email"
          placeholder="email@example.com"
          valueDir="ltr"
          autoCapitalize="none"
          spellCheck={false}
          icon={<Mail className="h-[18px] w-[18px]" />}
        />
        <div className="mt-6">
          <FillButton
            id="forgot-submit"
            label={s.sendResetCta}
            workingLabel={s.sendingReset}
            successLabel={s.resetSent}
            progress={forgotFill.progress}
            ready={forgotFill.ready}
            status={buttonStatus}
            hint={!emailValid ? s.hintEmail : undefined}
          />
        </div>
      </form>
    );
  } else if (view === 'signup') {
    screenKey = `signup:${panel}`;
    screen =
      panel === 'telegram' && telegramConfigured ? (
        <div>
          {backLink(() => setPanel('form'), s.backLabel)}
          {heading(s.signUpTitle, s.signUpHint)}
          {errorSummary}
          {/* TelegramAuth owns its own <form>; rendering it alone in the
              panel keeps the no-nested-forms rule trivially true. */}
          <TelegramAuth
            mode="signup"
            onSuccess={() => finishAuth(true)}
            onSwitchMode={switchView}
            referralCode={referralCode}
          />
        </div>
      ) : (
        <motion.div variants={listV} initial="hidden" animate="show">
          <motion.div variants={itemV}>{backLink(() => switchView('signin'))}</motion.div>
          <motion.div variants={itemV}>{heading(s.signUpTitle, s.signUpHint)}</motion.div>
          {/* §2.6 — optional referral bar; the code survives every panel
              switch and is attributed server-side only when an account is
              actually created. It NEVER blocks signup. */}
          <motion.div variants={itemV} className="mb-4">
            <ReferralBar
              code={referralCode}
              onCodeChange={setReferralCode}
              fromLink={refFromLink}
              disabled={submitting}
            />
          </motion.div>
          {errorSummary}
          <form onSubmit={handleSignUp} noValidate aria-busy={submitting && via === 'form'}>
            <div className="space-y-4">
              <motion.div variants={itemV}>
                <AuthTextField
                  id="username"
                  label={s.username}
                  value={username}
                  onChange={onUsernameChange}
                  autoComplete="username"
                  placeholder="username123"
                  minLength={3}
                  valueDir="ltr"
                  autoCapitalize="none"
                  spellCheck={false}
                  icon={<AtSign className="h-[18px] w-[18px]" />}
                />
              </motion.div>
              <motion.div variants={itemV}>
                <AuthTextField
                  id="name"
                  label={s.fullName}
                  value={name}
                  onChange={onNameChange}
                  autoComplete="name"
                  valueDir="auto"
                  icon={<UserRound className="h-[18px] w-[18px]" />}
                />
              </motion.div>
              <motion.div variants={itemV}>
                <AuthTextField
                  id="email"
                  label={s.email}
                  type="email"
                  value={email}
                  onChange={onEmailChange}
                  autoComplete="email"
                  inputMode="email"
                  placeholder="email@example.com"
                  valueDir="ltr"
                  autoCapitalize="none"
                  spellCheck={false}
                  icon={<Mail className="h-[18px] w-[18px]" />}
                />
              </motion.div>
              <motion.div variants={itemV}>{passwordField('new-password')}</motion.div>
              <motion.div variants={itemV}>{confirmField}</motion.div>
            </div>
            <motion.div variants={itemV} className="mt-6">
              <FillButton
                id="signup-submit"
                label={s.signUpCta}
                workingLabel={s.signingUp}
                successLabel={s.signedUp}
                progress={signupEmailFill.progress}
                ready={signupEmailFill.ready}
                status={buttonStatus}
                hint={signupEmailHint || undefined}
              />
            </motion.div>
          </form>
          {providerBlock}
          <motion.div variants={itemV}>
            <p className="mt-4 text-center text-[12px] leading-relaxed text-zinc-500">
              {s.termsPrefix}{' '}
              <Link to="/policies" className="font-semibold text-gold hover:underline">
                {s.termsLink}
              </Link>
            </p>
            <p className="mt-1 text-center text-[13px] text-zinc-400">
              {s.haveAccount}{' '}
              <button
                type="button"
                onClick={() => switchView('signin')}
                className="inline-flex min-h-[44px] items-center px-1 align-middle font-bold text-gold hover:underline"
              >
                {s.signInAction}
              </button>
            </p>
          </motion.div>
        </motion.div>
      );
  } else {
    screenKey = `signin:${panel}`;
    screen =
      panel === 'telegram' && telegramConfigured ? (
        <div>
          {backLink(() => setPanel('form'), s.backLabel)}
          {heading(s.signInTitle, s.signInHint)}
          {errorSummary}
          <TelegramAuth mode="signin" onSuccess={() => finishAuth(false)} onSwitchMode={switchView} />
        </div>
      ) : (
        <motion.div variants={listV} initial="hidden" animate="show">
          <motion.div variants={itemV}>{heading(s.signInTitle, s.signInHint)}</motion.div>
          {errorSummary}
          <form onSubmit={handleSignIn} noValidate aria-busy={submitting && via === 'form'}>
            <div className="space-y-4">
              <motion.div variants={itemV}>
                <AuthTextField
                  id="identifier"
                  label={s.identifier}
                  value={email}
                  onChange={onEmailChange}
                  autoComplete="username"
                  inputMode="email"
                  placeholder={s.identifierPlaceholder}
                  valueDir="ltr"
                  autoCapitalize="none"
                  spellCheck={false}
                  icon={<UserRound className="h-[18px] w-[18px]" />}
                />
              </motion.div>
              <motion.div variants={itemV}>
                {passwordField('current-password')}
                {forgotRow}
              </motion.div>
            </div>
            <motion.div variants={itemV} className="mt-5">
              <FillButton
                id="signin-submit"
                label={s.signInCta}
                workingLabel={s.signingIn}
                successLabel={s.signedIn}
                progress={signinEmailFill.progress}
                ready={signinEmailFill.ready}
                status={buttonStatus}
                hint={signinEmailHint || undefined}
              />
            </motion.div>
          </form>
          {providerBlock}
          <motion.div variants={itemV}>
            <p className="mt-5 text-center text-[13px] text-zinc-400">
              {s.noAccount}{' '}
              <button
                type="button"
                onClick={() => switchView('signup')}
                className="inline-flex min-h-[44px] items-center px-1 align-middle font-bold text-gold hover:underline"
              >
                {s.signUpAction}
              </button>
            </p>
          </motion.div>
        </motion.div>
      );
  }

  // ------------------------------------------------------------------ page

  /**
   * The provider is mounted ONCE for the whole page and only when there is a
   * real client id to give it. Not around the app (that is what forced a
   * build-time value in the first place), and not inside the animated panel:
   * `@react-oauth/google` injects and removes Google's script on mount and
   * unmount, so putting it in the panel would tear the script down and
   * re-add it on every screen switch.
   */
  const withGoogle = (node: React.ReactNode) =>
    googleClientId ? <GoogleOAuthProvider clientId={googleClientId}>{node}</GoogleOAuthProvider> : node;

  return withGoogle(
    <AuthShell dir={dir}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={screenKey}
          initial={{ opacity: 0, y: slide }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -slide }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
        >
          {screen}
        </motion.div>
      </AnimatePresence>
    </AuthShell>
  );
}
