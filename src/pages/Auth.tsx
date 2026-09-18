import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, AtSign, Check, CheckCircle2, Info, Lock, Mail, MailCheck, MessageCircle, UserRound, X } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useMotion } from '../lib/motion';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import AuthShell from '../components/auth/AuthShell';
import AuthDivider from '../components/auth/AuthDivider';
import CountryPicker from '../components/auth/CountryPicker';
import PhoneField, { emptyPhoneValue, type PhoneValue } from '../components/auth/PhoneField';
import AuthTextField from '../components/auth/AuthTextField';
import GoogleAuthButton from '../components/auth/GoogleAuthButton';
import SocialAuthButton, { TelegramIcon } from '../components/auth/SocialAuthButton';
import CodeAuth from '../components/auth/CodeAuth';
import TelegramAuth from '../components/auth/TelegramAuth';
import { sanitizeNextPath } from '../components/auth/nextPath';
import FillButton, {
  type FillButtonStatus,
  clamp01,
  isValidEmailAddress,
  emailFieldProgress,
  lengthProgress,
  combineFillProgress,
  loginPasswordPart,
  signinIdentifierPart,
} from '../components/auth/FillButton';
import { useCapabilities } from '../hooks/useCapabilities';
import { countryNames, flagOf, toAsciiDigitsClient } from '../components/auth/PhoneField';
import ReferralBar from '../components/auth/ReferralBar';
import { useUsernameAvailability } from '../components/auth/useUsernameAvailability';
import { usernameRejection } from '../lib/usernameRules';
import { useShortViewport } from '../components/auth/useShortViewport';
import { onboardingStrings, usernameReasonLabel } from '../components/onboarding/strings';

/**
 * /auth — the door into LEVONIS, drawn as a technical blueprint: the CAD
 * viewport behind (AuthShell/AuthBackground), one thin panel in front.
 *
 * Organization: email/password is the PRIMARY interface, visible
 * immediately — no method tabs. Google and Telegram are secondary actions
 * under an "أو" seam; tapping Telegram swaps the panel to the
 * Telegram-verified phone flow (the only route that can prove number
 * ownership), with a way back. Creating an account is a light three-step
 * flow inside the same panel — email (and, only when the deployment has no
 * mail service, the password), then name, handle and country, then a review —
 * and ONE request: the steps only validate locally, the single
 * POST /api/auth/register happens on the last one. With a mail service the
 * server answers `pending_email` and creates nothing yet: the person opens
 * the emailed link, which lands back here as /auth?finish=TOKEN, chooses the
 * password on that screen, and POST /api/auth/signup/complete creates the
 * account and signs them in (the same shape as the /auth?reset=TOKEN screen).
 * Non-sensitive values survive every step/panel switch; passwords never touch
 * localStorage/analytics/logs.
 *
 * FillButton (§2.2): every step's button fills with REAL validation
 * progress and enables only when every rule of that step passes — never on
 * text length alone and never because an animation finished.
 *
 * Server contracts (unchanged by the redesign):
 * - POST /api/auth/login    { identifier (email|username|phone), password }
 *   (the legacy `email` field carries the same value for the current server)
 * - POST /api/auth/register { username, name, email, password?, locale,
 *   country?, referralCode? } — country is an ISO-2 the server already
 *   accepts (unknown → null, never an error); the password is sent only
 *   when capabilities.emailFirstSignup is false
 * - GET  /api/auth/signup/pending?token=… · POST /api/auth/signup/complete
 *   { token, password } — the finish screen (email-first sign-up)
 * - POST /api/auth/google   { credential, referralCode? }  (GIS credential)
 * - GET  /api/auth/username-available?u=…  (live handle check, informational)
 * - GET  /api/auth/referrer-info?ref=…  (ReferralBar — 404 = honest
 *   "code not found", continuing without a code is always allowed)
 * - POST /api/auth/forgot-password { email, lang } · POST /api/auth/reset-password
 *
 * Return-to-destination: `location.state.from` or `?next=` AFTER
 * sanitizeNextPath() — same-origin relative paths only, else "/".
 */

const STRINGS = {
  ar: {
    signInTitle: 'أهلًا بعودتك',
    signInHint: 'سجّل الدخول للمتابعة إلى حسابك.',
    signUpTitle: 'إنشاء حساب',
    signUpHint: 'ثلاث خطوات قصيرة، وطلب واحد في النهاية.',
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
    signInWithEmailCode: 'رمز إلى بريدي',
    signInWithWhatsapp: 'رمز على واتساب',
    usePhone: 'المتابعة برقم الهاتف',
    phonePanelTitle: 'رقم الهاتف',
    phonePanelHint: 'اكتب رقمك، ثم اختر أين يصلك رمز التحقق.',
    phoneChannelQuestion: 'أين نرسل الرمز؟',
    channelWhatsapp: 'واتساب',
    channelWhatsappHint: 'رسالة فيها رمز من ٦ أرقام',
    channelTelegram: 'تيليغرام',
    channelTelegramHint: 'شارك رقمك مع البوت',
    phoneNoChannel: 'لا توجد قناة متاحة لإرسال الرمز حالياً.',
    signUpWithPhoneHint: 'أنشئ حسابك برقم الهاتف — بدون بريد وبدون كلمة مرور.',
    codeSignInTitle: 'الدخول برمز',
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
    errPasswordLong: 'كلمة المرور طويلة جدًا — 128 محرفًا كحد أقصى.',
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
    errLoginFailed: 'البريد أو اسم المستخدم أو الهاتف أو كلمة المرور غير صحيحة. إن أنشأت حسابك عبر Google أو تيليغرام فاستخدم زره، وإن سجّلت للتو فافتح الرابط الذي وصل بريدك أولًا.',
    errAlreadyRegistered: 'هذا الحساب مُعدّ بالفعل — سجّل الدخول بدلًا من ذلك.',
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
    // three-step signup
    steps: 'خطوات إنشاء الحساب',
    step1Name: 'بيانات الدخول',
    step2Name: 'عنك',
    step3Name: 'المراجعة والإنشاء',
    step1Hint: 'بريدك وكلمة المرور.',
    step2Hint: 'اسمك واسم المستخدم ودولتك.',
    step3Hint: 'راجع بياناتك ثم أنشئ الحساب.',
    next: 'متابعة',
    optional: 'اختياري',
    edit: 'تعديل',
    referralLabel: 'كود الإحالة',
    verifyNote: 'سنرسل رابطًا إلى بريدك — تختار كلمة المرور من داخله، وعندها فقط يُفتح حسابك.',
    hintUsernameTaken: 'اختر اسم مستخدم آخر',
    step1NameEmail: 'البريد الإلكتروني',
    step1HintEmail: 'ابدأ ببريدك — كلمة المرور تختارها من الرابط الذي سنرسله إليه.',
    sendLinkCta: 'إرسال رابط التأكيد',
    sendingLink: 'جارٍ الإرسال…',
    linkSent: 'تم الإرسال',
    pendingTitle: 'تحقق من بريدك',
    pendingHint: 'خطوة أخيرة: اختيار كلمة المرور.',
    pendingBody: (e: string) => `أرسلنا رسالة إلى ${e}. افتح الرابط داخلها لاختيار كلمة المرور — عندها يُفتح حسابك.`,
    pendingSpam: 'لم تصلك؟ تحقق من مجلد الرسائل غير المرغوبة، أو أعد الخطوات بنفس البريد لتصلك رسالة جديدة.',
    pendingSignIn: 'لديك حساب بالفعل؟ سجّل الدخول',
    finishTitle: 'اختر كلمة المرور',
    finishHint: (e: string) => (e ? `آخر خطوة لفتح حساب ${e}. الرابط يصلح لمرة واحدة.` : 'آخر خطوة لفتح حسابك. الرابط يصلح لمرة واحدة.'),
    finishCta: 'فتح الحساب',
    finishing: 'جارٍ فتح الحساب…',
    finished: 'تم فتح الحساب',
    finishLoading: 'جارٍ التحقق من الرابط…',
    finishDeadTitle: 'هذا الرابط لم يعد صالحًا',
    finishDeadBody: 'روابط إكمال التسجيل تصلح لمرة واحدة ولمدة 24 ساعة، ويلغيها طلب تسجيل أحدث بنفس البريد. أعد إنشاء الحساب لتصلك رسالة جديدة.',
    signUpAgain: 'إنشاء الحساب من جديد',
  },
  en: {
    signInTitle: 'Welcome back',
    signInHint: 'Sign in to continue to your account.',
    signUpTitle: 'Create account',
    signUpHint: 'Three short steps, one request at the end.',
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
    signInWithEmailCode: 'Email me a code',
    signInWithWhatsapp: 'Code on WhatsApp',
    usePhone: 'Continue with a phone number',
    phonePanelTitle: 'Phone number',
    phonePanelHint: 'Type your number, then choose where the code should reach you.',
    phoneChannelQuestion: 'Where should the code go?',
    channelWhatsapp: 'WhatsApp',
    channelWhatsappHint: 'A message with a 6-digit code',
    channelTelegram: 'Telegram',
    channelTelegramHint: 'Share your number with the bot',
    phoneNoChannel: 'No channel is available to carry a code right now.',
    signUpWithPhoneHint: 'Open an account on your phone number — no email, no password.',
    codeSignInTitle: 'Sign in with a code',
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
    errPasswordLong: 'That password is too long — 128 characters at most.',
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
    errLoginFailed: 'Incorrect email, username, phone or password. If you created your account with Google or Telegram, use that button; if you just signed up, open the link we emailed you first.',
    errAlreadyRegistered: 'This account is already set up — sign in instead.',
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
    steps: 'Account creation steps',
    step1Name: 'Sign-in details',
    step2Name: 'About you',
    step3Name: 'Review & create',
    step1Hint: 'Your email and password.',
    step2Hint: 'Your name, username and country.',
    step3Hint: 'Check your details, then create the account.',
    next: 'Continue',
    optional: 'Optional',
    edit: 'Edit',
    referralLabel: 'Referral code',
    verifyNote: "We'll email you a link — you choose your password from it, and only then does your account open.",
    hintUsernameTaken: 'Choose a different username',
    step1NameEmail: 'Your email',
    step1HintEmail: 'Start with your email — you choose the password from the link we send there.',
    sendLinkCta: 'Send confirmation link',
    sendingLink: 'Sending…',
    linkSent: 'Sent',
    pendingTitle: 'Check your email',
    pendingHint: 'One last step: choose your password.',
    pendingBody: (e: string) => `We sent a message to ${e}. Open the link inside it to choose your password — that is when your account opens.`,
    pendingSpam: 'Nothing there? Check your spam folder, or repeat the steps with the same address to get a fresh message.',
    pendingSignIn: 'Already have an account? Sign in',
    finishTitle: 'Choose your password',
    finishHint: (e: string) => (e ? `The last step to open the account for ${e}. The link works once.` : 'The last step to open your account. The link works once.'),
    finishCta: 'Open my account',
    finishing: 'Opening your account…',
    finished: 'Account opened',
    finishLoading: 'Checking your link…',
    finishDeadTitle: 'This link no longer works',
    finishDeadBody: 'Sign-up links work once, expire after 24 hours, and are replaced by a newer sign-up with the same address. Sign up again to get a fresh message.',
    signUpAgain: 'Sign up again',
  },
  ckb: {
    signInTitle: 'بەخێربێیتەوە',
    signInHint: 'بچۆرە ژوورەوە بۆ بەردەوامبوون بۆ هەژمارەکەت.',
    signUpTitle: 'دروستکردنی هەژمار',
    signUpHint: 'سێ هەنگاوی کورت، و یەک داواکاری لە کۆتاییدا.',
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
    signInWithEmailCode: 'کۆد بۆ ئیمەیڵەکەم',
    signInWithWhatsapp: 'کۆد لە واتساپ',
    usePhone: 'بەردەوامبوون بە ژمارەی مۆبایل',
    phonePanelTitle: 'ژمارەی مۆبایل',
    phonePanelHint: 'ژمارەکەت بنووسە، پاشان هەڵبژێرە کۆدەکە بۆ کوێ بێت.',
    phoneChannelQuestion: 'کۆدەکە بۆ کوێ بنێرین؟',
    channelWhatsapp: 'واتساپ',
    channelWhatsappHint: 'نامەیەک بە کۆدی ٦ ژمارەیی',
    channelTelegram: 'تێلێگرام',
    channelTelegramHint: 'ژمارەکەت لەگەڵ بۆتەکە هاوبەش بکە',
    phoneNoChannel: 'ئێستا هیچ ڕێگایەک نییە بۆ ناردنی کۆد.',
    signUpWithPhoneHint: 'هەژمار بە ژمارەی مۆبایلەکەت بکەرەوە — بێ ئیمەیڵ، بێ وشەی نهێنی.',
    codeSignInTitle: 'چوونەژوورەوە بە کۆد',
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
    errPasswordLong: 'وشەی نهێنییەکە زۆر درێژە — زۆرترین ١٢٨ پیت.',
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
    errLoginFailed: 'ئیمەیل، ناوی بەکارهێنەر، ژمارە یان وشەی نهێنی هەڵەیە. ئەگەر هەژمارەکەت بە Google یان تەلەگرام دروستکردووە، ئەو دوگمەیە بەکاربهێنە؛ ئەگەر تازە خۆت تۆمار کردووە، سەرەتا بەستەرەکە بکەرەوە کە بۆ ئیمەیلەکەت ناردمان.',
    errAlreadyRegistered: 'ئەم هەژمارە پێشتر ڕێکخراوە — لەبری ئەوە بچۆرەژوورەوە.',
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
    steps: 'هەنگاوەکانی دروستکردنی هەژمار',
    step1Name: 'زانیاری چوونەژوورەوە',
    step2Name: 'دەربارەی تۆ',
    step3Name: 'پێداچوونەوە و دروستکردن',
    step1Hint: 'ئیمەیل و وشەی نهێنی.',
    step2Hint: 'ناو، ناوی بەکارهێنەر و وڵاتەکەت.',
    step3Hint: 'زانیارییەکانت بپشکنە، پاشان هەژمارەکە دروست بکە.',
    next: 'بەردەوامبوون',
    optional: 'ئارەزوومەندانە',
    edit: 'دەستکاری',
    referralLabel: 'کۆدی بانگهێشت',
    verifyNote: 'بەستەرێک بۆ ئیمەیلەکەت دەنێرین — وشەی نهێنی لە ناوەوەی هەڵدەبژێریت، و تەنها ئەو کاتە هەژمارەکەت دەکرێتەوە.',
    hintUsernameTaken: 'ناوی بەکارهێنەرێکی تر هەڵبژێرە',
    step1NameEmail: 'ئیمەیلەکەت',
    step1HintEmail: 'بە ئیمەیلەکەت دەست پێ بکە — وشەی نهێنی لە بەستەرەکە هەڵدەبژێریت کە بۆی دەنێرین.',
    sendLinkCta: 'ناردنی بەستەری پشتڕاستکردنەوە',
    sendingLink: 'دەنێردرێت…',
    linkSent: 'نێردرا',
    pendingTitle: 'ئیمەیلەکەت بپشکنە',
    pendingHint: 'دوا هەنگاو: هەڵبژاردنی وشەی نهێنی.',
    pendingBody: (e: string) => `پەیامێکمان نارد بۆ ${e}. بەستەرەکەی ناوەوە بکەرەوە بۆ هەڵبژاردنی وشەی نهێنی — ئەو کاتە هەژمارەکەت دەکرێتەوە.`,
    pendingSpam: 'نەگەیشت؟ فۆڵدەری سپام بپشکنە، یان هەنگاوەکان بە هەمان ئیمەیل دووبارە بکەرەوە بۆ وەرگرتنی پەیامی نوێ.',
    pendingSignIn: 'پێشتر هەژمارت هەیە؟ بچۆرەژوورەوە',
    finishTitle: 'وشەی نهێنیەکەت هەڵبژێرە',
    finishHint: (e: string) => (e ? `دوا هەنگاو بۆ کردنەوەی هەژماری ${e}. بەستەرەکە تەنها جارێک کاردەکات.` : 'دوا هەنگاو بۆ کردنەوەی هەژمارەکەت. بەستەرەکە تەنها جارێک کاردەکات.'),
    finishCta: 'کردنەوەی هەژمار',
    finishing: 'هەژمار دەکرێتەوە…',
    finished: 'هەژمار کرایەوە',
    finishLoading: 'بەستەرەکە دەپشکنرێت…',
    finishDeadTitle: 'ئەم بەستەرە چیتر کار ناکات',
    finishDeadBody: 'بەستەرەکانی تەواوکردنی خۆتۆمارکردن تەنها جارێک و بۆ ٢٤ کاتژمێر کاردەکەن، و تۆمارکردنێکی نوێتر بە هەمان ئیمەیل جێیان دەگرێتەوە. دووبارە هەژمار دروست بکە بۆ وەرگرتنی پەیامی نوێ.',
    signUpAgain: 'دووبارە هەژمار دروست بکە',
  },
};

type AuthView = 'signin' | 'signup' | 'forgot';
/** What the card is currently showing inside a view. */
type AuthPanel = 'form' | 'telegram' | 'code-email' | 'code-whatsapp' | 'phone';

/**
 * Which road carries the code once a number is on the screen. '' means the
 * person has not chosen yet, which is its own step: the owner asked for the
 * number FIRST and the channel second, because "WhatsApp or Telegram" is a
 * question about a number that already exists, not a way of starting.
 */
type PhoneChannel = '' | 'whatsapp' | 'telegram';
/** The three signup screens (one request, on the last one). */
type SignupStep = 1 | 2 | 3;

/** Client mirror of the server's username shape (worker/lib/usernames.ts; the server lowercases). */
/** Drafting-sheet labels above each screen's title. Technical, LTR, never translated. */
const SHEET = {
  signin: 'SIGN-IN',
  signup: 'CREATE ACCOUNT',
  forgot: 'PASSWORD RESET',
  reset: 'NEW PASSWORD',
  finish: 'CHOOSE PASSWORD',
  telegram: 'TELEGRAM',
  code: 'SIGN-IN CODE',
} as const;

/** Server codes that belong to an earlier step's field: the review step hands the person back there. */
const STEP_FOR_CODE: Record<string, SignupStep> = {
  EMAIL_TAKEN: 1,
  USERNAME_TAKEN: 2,
  USERNAME_RESERVED: 2,
  USERNAME_TOO_SHORT: 2,
  USERNAME_TOO_LONG: 2,
  USERNAME_BAD_CHARACTERS: 2,
  USERNAME_BAD_EDGES: 2,
  USERNAME_REPEATED_PUNCTUATION: 2,
  USERNAME_ALL_DIGITS: 2,
};
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
  const ob = onboardingStrings(lang);
  // Respect the OS "reduce motion" setting: the screen switch becomes a
  // plain cross-fade with no travel.
  // `useMotion()` already answers prefers-reduced-motion (and the writing
  // direction) in one place, so a second hook here would be a second source
  // of truth for the same question.
  const m = useMotion();
  /**
   * WHICH WAY THIS SCREEN CAME FROM.
   *
   * The switch used to be a 160ms cross-fade with 4px of VERTICAL travel, the
   * same in both directions — so going back from step 2 to step 1 looked
   * exactly like going forward from 1 to 2. docs/MOTION.md §3 states the rule
   * it broke: «إن اختفى شيء من جهة، توقّعنا عودته من حيث ذهب» — if something
   * left one way, we expect it back from where it went. A step is a horizontal
   * journey, and a back step has to run the same path in reverse.
   *
   * The sign is stored rather than derived, because by the time the exiting
   * screen animates, `step` already holds the NEW value and the direction is
   * no longer recoverable from state.
   */
  const [stepDir, setStepDir] = useState<1 | -1>(1);
  // Phone browsers with their bars and landscape tablets: the provider
  // buttons become icon-only so every screen fits without scrolling.
  const shortViewport = useShortViewport();

  const resetToken = searchParams.get('reset') || '';
  // Email-first sign-up: the emailed link lands here. Opening it spends
  // nothing — the token is used only by the explicit POST with the password.
  const finishToken = searchParams.get('finish') || '';
  // Friend-invite referral code from ?ref=CODE — user-editable in the
  // ReferralBar (§2.6), page-level so it survives view/panel/step switches
  // and later URL cleanups. The user's explicitly chosen code wins.
  const [referralCode, setReferralCode] = useState(() => searchParams.get('ref') || '');
  const [refFromLink] = useState(() => !!searchParams.get('ref'));
  // ?next= return destination, captured once for the same reason.
  const [nextFromQuery] = useState(() => searchParams.get('next') || '');
  // ProtectedRoute redirects can pass location.state.from (string or location
  // object). Sanitized to a same-origin relative path; falls back to "/".
  const stateFrom = (location.state as { from?: unknown } | null)?.from;
  const dest = sanitizeNextPath(stateFrom ?? nextFromQuery);

  // §2.6: someone who followed an invite link is here to CREATE an account,
  // so the sign-up view (the only one that carries the referral bar) opens
  // first and the inviter's name is resolved before they finish registering.
  const [view, setView] = useState<AuthView>(() => (searchParams.get('ref') ? 'signup' : 'signin'));
  const [panel, setPanel] = useState<AuthPanel>('form');
  const [phoneChannel, setPhoneChannel] = useState<PhoneChannel>('');
  const [phoneValue, setPhoneValue] = useState<PhoneValue>(() => emptyPhoneValue('IQ'));
  const [step, setStep] = useState<SignupStep>(1);
  const [submitting, setSubmitting] = useState(false);
  // Which action is in flight. The form CTA and the Google slot are both on
  // screen now, so a Google roundtrip must never animate the form button.
  const [via, setVia] = useState<'form' | 'google' | null>(null);
  // A REAL success (the server answered 2xx), never assumed: it is set only
  // after a resolved request and drives the FillButton's success state.
  const [succeeded, setSucceeded] = useState(false);
  // Email-first sign-up: the server queued a link and created nothing yet;
  // the page shows "check your inbox" instead of moving on.
  const [pendingEmail, setPendingEmail] = useState(false);
  // The finish screen (/auth?finish=TOKEN): the pending profile behind the
  // link, read once so the person sees which address they are opening.
  const [finishInfo, setFinishInfo] = useState<{ email: string; name: string; username: string | null } | null>(null);
  // The referral a sign-up attempt attached to this address. Shown on the
  // finish screen and sent back explicitly, so the person finishing — not
  // whoever submitted the sign-up — decides who is credited.
  const [finishReferral, setFinishReferral] = useState('');
  const [finishReferralFromLink, setFinishReferralFromLink] = useState(false);
  const [finishState, setFinishState] = useState<'loading' | 'ready' | 'dead'>('loading');
  const [finishLoadFailed, setFinishLoadFailed] = useState(false);
  const [finishLoadRateLimited, setFinishLoadRateLimited] = useState(false);
  const [serverError, setServerError] = useState('');
  // Set only when the SERVER says phone sign-up needs ownership proof — the
  // page then offers the Telegram verification path instead of pretending.
  const [phoneNeedsTelegram, setPhoneNeedsTelegram] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');
  const [emailNotConfigured, setEmailNotConfigured] = useState(false);

  // Field values are PAGE-level so switching panel/view/step never loses
  // non-sensitive input. Passwords live only in memory here — never in
  // localStorage/analytics/logs.
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('');
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
  const emailCodeConfigured = caps?.emailOtp ?? false;
  const whatsappCodeConfigured = caps?.whatsappOtp ?? false;
  const emailVerificationConfigured = caps?.emailVerification ?? false;
  // With a mail service the sign-up collects NO password — it is chosen on
  // the finish screen. Until the answer arrives the password fields are
  // shown (the server in email-first mode ignores a password it is sent).
  const emailFirst = caps?.emailFirstSignup ?? false;

  useEffect(() => {
    if (!finishToken) return;
    let alive = true;
    setFinishState('loading');
    setFinishLoadFailed(false);
    api
      .get<{ email: string; name: string; username: string | null; referral_code?: string | null }>(
        `/api/auth/signup/pending?token=${encodeURIComponent(finishToken)}`
      )
      .then((p) => {
        if (!alive) return;
        setFinishInfo({ email: p.email, name: p.name, username: p.username });
        setFinishReferral(p.referral_code ?? '');
        setFinishReferralFromLink(!!p.referral_code);
        setFinishState('ready');
      })
      .catch((err) => {
        if (!alive) return;
        // A 400 is the server's one generic "this link is dead"; anything
        // else (a rate limit, the network) still lets the person try — the
        // POST is the judge — with an honest word about what happened.
        if (err instanceof ApiError && err.status === 400) setFinishState('dead');
        else {
          setFinishLoadFailed(true);
          setFinishLoadRateLimited(err instanceof ApiError && err.status === 429);
          setFinishState('ready');
        }
      });
    return () => {
      alive = false;
    };
  }, [finishToken]);

  /**
   * If the open Telegram panel stops being offered — the capabilities answer
   * arrives and says Telegram is off, or a stale state is restored — fall
   * back to the form instead of rendering an empty panel.
   */
  useEffect(() => {
    if (!caps) return;
    if (panel === 'telegram' && !caps.telegram) setPanel('form');
    if (panel === 'code-email' && !caps.emailOtp) setPanel('form');
    if (panel === 'code-whatsapp' && !caps.whatsappOtp) setPanel('form');
    // The phone panel needs at least one road for the code. Without one it is
    // a dead end, so it is not a panel this deployment has.
    if (panel === 'phone' && !caps.whatsappOtp && !caps.telegram) setPanel('form');
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
    USERNAME_TOO_LONG: usernameReasonLabel(ob, 'too_long'),
    USERNAME_BAD_CHARACTERS: s.errUsernameChars,
    USERNAME_BAD_EDGES: usernameReasonLabel(ob, 'bad_edges'),
    USERNAME_REPEATED_PUNCTUATION: usernameReasonLabel(ob, 'repeated_punctuation'),
    USERNAME_ALL_DIGITS: usernameReasonLabel(ob, 'all_digits'),
    // The server now names these, so they can be read in Arabic and Kurdish
    // instead of arriving as an English sentence.
    PASSWORD_TOO_SHORT: s.hintPassword,
    PASSWORD_TOO_LONG: s.errPasswordLong,
    EMAIL_NOT_CONFIGURED: s.errMailOff,
    GOOGLE_NOT_CONFIGURED: s.googleServerNotConfigured,
    EMAIL_NOT_VERIFIED: s.errGoogleNeedsVerify,
    BAD_TOKEN: s.errResetLink,
    TOKEN_USED: s.errResetLink,
    TOKEN_EXPIRED: s.errResetLink,
    ALREADY_REGISTERED: s.errAlreadyRegistered,
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
    setPendingEmail(false);
    setPanel('form');
    setStep(1);
    setView(next);
  };

  const openTelegram = () => {
    clearMessages();
    setPanel('telegram');
  };

  const openCodePanel = (next: 'code-email' | 'code-whatsapp') => {
    clearMessages();
    setPanel(next);
  };

  const openPhonePanel = () => {
    clearMessages();
    // The channel choice is reset every time, not remembered: coming back
    // usually means the last road did not work.
    setPhoneChannel('');
    setPanel('phone');
  };

  const goToStep = (next: SignupStep) => {
    setServerError('');
    setStepDir(next >= step ? 1 : -1);
    setStep(next);
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

  // Sign-in identifier: an email must be a valid email; a username needs its
  // minimum shape. The part's ramp is built so its two rule tracks meet —
  // typing "@" after a username no longer drops the bar (see
  // signinIdentifierPart).
  const signinIdPart = signinIdentifierPart(trimmedEmail);
  const signinIdValid = signinIdPart.valid;
  // Existing-account password: the meter fills character by character toward
  // the platform minimum (8) and only completes there. That excludes nobody:
  // every path that ever stored a password enforces the same minimum on the
  // worker, so a shorter attempt could only come back LOGIN_FAILED anyway —
  // see loginPasswordPart for the full argument.
  const loginPwPart = loginPasswordPart(password);

  const signinEmailFill = combineFillProgress([signinIdPart, loginPwPart]);

  // New-account password: minimum 8 characters of ANY kind (§2.2).
  const newPwValid = password.length >= 8 && password.length <= 128;
  const newPwPart = { progress: lengthProgress(password, 8), valid: newPwValid };
  const confirmValid = newPwValid && confirmPassword === password;
  const confirmPart = {
    progress: confirmValid ? 1 : password ? clamp01(confirmPassword.length / password.length) : 0,
    valid: confirmValid,
  };

  // The handle: shape first (client mirror of the server rule), then the
  // server's own availability answer while typing — informational, except
  // that a name the server has ALREADY refused cannot be "ready".
  /**
   * The SERVER's rule, checked here — see src/lib/usernameRules.ts.
   *
   * This was `/^[a-zA-Z0-9._-]{3,30}$/`, which accepts `_ali`, `ali.`,
   * `ali__b` and `12345` — all refused by the server. Because the loose check
   * also GATED the live availability lookup below, someone typing one of those
   * got no feedback at all while typing and a flat refusal on submit. The
   * precise reasons were already written in all three languages; nothing was
   * reaching them.
   */
  const usernameProblem = trimmedUsername ? usernameRejection(trimmedUsername) : null;
  const usernameShapeValid = trimmedUsername.length > 0 && usernameProblem === null;
  const availability = useUsernameAvailability(trimmedUsername, view === 'signup' && usernameShapeValid);
  const usernameValid = usernameShapeValid && availability.state !== 'unavailable';
  const usernamePart = {
    // A username of the right LENGTH but the wrong shape must not push the
    // meter as if it were done; the ramp under-reports until the shape rule
    // actually passes (an honest meter never over-reports, §2.2).
    progress: usernameValid ? 1 : clamp01(trimmedUsername.length / 3) * 0.75,
    valid: usernameValid,
  };
  // Ramp instead of a 0→1 step: a single keystroke must never jump the
  // bar by a whole field's worth — that motion reads as a glitch.
  const namePart = { progress: clamp01(trimmedName.length / 3), valid: trimmedName.length > 0 };
  const emailPart = { progress: emailProgress, valid: emailValid };

  // Each step's button answers for ITS fields; the last one for all of them.
  // Email-first: the password is not a field of this form at all — it is
  // chosen on the finish screen — so the meters answer for the email alone.
  const step1Fill = combineFillProgress(emailFirst ? [emailPart] : [emailPart, newPwPart, confirmPart]);
  const step2Fill = combineFillProgress([namePart, usernamePart]);
  const signupEmailFill = combineFillProgress(
    emailFirst ? [emailPart, usernamePart, namePart] : [emailPart, usernamePart, namePart, newPwPart, confirmPart]
  );

  const forgotFill = combineFillProgress([emailPart]);
  const resetFill = combineFillProgress([newPwPart, confirmPart]);

  // First missing requirement — the not-ready button's visible reason (§2.2).
  const signinEmailHint = !signinIdValid
    ? s.hintIdentifier
    : !password
      ? s.hintPasswordLogin
      : !loginPwPart.valid
        ? s.hintPassword
        : '';
  const step1Hint = !emailValid
    ? s.hintEmail
    : emailFirst
      ? ''
      : !newPwValid
        ? s.hintPassword
        : !confirmValid
          ? s.hintConfirm
          : '';
  const step2Hint = !trimmedName
    ? s.hintName
    : usernameProblem
      // Say WHICH rule it broke, not "handle is invalid".
      ? usernameReasonLabel(ob, usernameProblem)
      : !usernameShapeValid
        ? s.hintUsername
        : availability.state === 'unavailable'
          ? s.hintUsernameTaken
          : '';
  const signupEmailHint = step1Hint || step2Hint;

  // Inline errors only where they genuinely help while typing.
  const confirmMismatchError =
    confirmPassword && password && confirmPassword.length >= password.length && confirmPassword !== password
      ? s.errPasswordMismatch
      : undefined;
  const usernameHelp =
    // The local verdict comes FIRST: it is instant and it is the same rule the
    // server applies, so there is no reason to wait 350ms for a round trip to
    // say that `ali__b` has a doubled separator.
    usernameProblem
      ? usernameReasonLabel(ob, usernameProblem)
      : availability.state === 'checking'
        ? ob.usernameChecking
        : availability.state === 'free'
          ? ob.usernameFree
          : availability.state === 'unavailable'
            ? usernameReasonLabel(ob, availability.reason)
            : s.hintUsername;
  const usernameTone: 'neutral' | 'ok' | 'bad' =
    // A handle that breaks a rule is WRONG, whatever the availability lookup
    // thinks — and the lookup is not even running for it, because it is gated
    // on the shape being valid.
    usernameProblem ? 'bad' : availability.state === 'free' ? 'ok' : availability.state === 'unavailable' ? 'bad' : 'neutral';

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

  // Steps 1 and 2 only validate locally; nothing leaves the browser until
  // the review step's single register call. A per-step request would
  // create half-accounts and burn the register bucket.
  const handleStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!step1Fill.ready) return;
    goToStep(2);
  };
  const handleStep2 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!step2Fill.ready) return;
    goToStep(3);
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
      const created = await api.post<{ pending_email?: boolean }>('/api/auth/register', {
        username: trimmedUsername,
        name: trimmedName,
        email: trimmedEmail,
        // Email-first: no password leaves this page — it is chosen on the
        // finish screen by whoever holds the emailed link.
        ...(emailFirst ? {} : { password }),
        locale: lang,
        ...(country ? { country } : {}),
        ...(referral ? { referralCode: referral } : {}),
      });
      setSucceeded(true);
      // With a mail service the server created nothing yet: the account opens
      // from the link in the inbox, and the answer is the same whether or not
      // the address already had an account (see worker/routes/auth.ts).
      if (created.pending_email) {
        setPendingEmail(true);
        return;
      }
      await refreshUser();
      finishAuth(true);
    } catch (err) {
      setServerError(errMsg(err));
      // A refusal about the email or the handle is answered on the step
      // that owns that field, with the error visible there.
      const owner = err instanceof ApiError && err.code ? STEP_FOR_CODE[err.code] : undefined;
      if (owner) setStep(owner);
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
        // Same server route the context uses, plus the referral code the
        // person chose (server-resolved; unknown codes never block).
        await api.post('/api/auth/google', { credential, referralCode: referral });
        await refreshUser();
      } else {
        await loginWithGoogle(credential);
      }
      setSucceeded(true);
      // The register/login distinction is the server's; the view only says
      // which onboarding the person expected. Google can create an account
      // on the sign-in view too, in which case the worker's response is the
      // authority and /welcome self-skips for existing accounts.
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
      await api.post<{ message?: string }>('/api/auth/forgot-password', { email: trimmedEmail, lang });
      setForgotMessage(s.forgotSent);
      setSucceeded(true);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 503 || err.code === 'EMAIL_NOT_CONFIGURED')) {
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
    clearMessages();
    setVia('form');
    setSubmitting(true);
    try {
      // The token is consumed ONLY here, on submit — opening the link never
      // spends it, so a preview fetch by a mail client cannot burn it.
      await api.post('/api/auth/reset-password', { token: resetToken, password });
      setPassword('');
      setConfirmPassword('');
      setResetDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOKEN_USED') setResetTokenError('used');
      else if (err instanceof ApiError && err.code === 'TOKEN_EXPIRED') setResetTokenError('expired');
      else setServerError(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * The finish screen's one request: the token proved the inbox, the password
   * typed here is the account's, and the server creates the account and signs
   * the person in — then setup, like any brand-new account.
   */
  const handleFinish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!resetFill.ready) return;
    clearMessages();
    setVia('form');
    setSubmitting(true);
    try {
      // referralCode is sent even when empty: an empty string REMOVES a code
      // the person did not want, whereas an absent field would keep it.
      await api.post('/api/auth/signup/complete', { token: finishToken, password, referralCode: finishReferral.trim() });
      setPassword('');
      setConfirmPassword('');
      await refreshUser();
      setSucceeded(true);
      finishAuth(true);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'BAD_TOKEN' || err.code === 'TOKEN_EXPIRED' || err.code === 'TOKEN_USED')) {
        setFinishState('dead');
      } else {
        setServerError(errMsg(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  /** Leave the (dead or finished) link behind so a refresh does not resurrect it. */
  const leaveFinish = (next: AuthView) => {
    const params = new URLSearchParams(searchParams);
    params.delete('finish');
    setSearchParams(params, { replace: true });
    setFinishInfo(null);
    setFinishState('loading');
    setFinishLoadFailed(false);
    switchView(next);
  };

  const switchToForgotForm = () => {
    // Leave the dead reset link behind so a refresh does not resurrect it.
    const next = new URLSearchParams(searchParams);
    next.delete('reset');
    setSearchParams(next, { replace: true });
    setResetTokenError('');
    setResetDone(false);
    clearMessages();
    setView('forgot');
  };

  const backToLoginFromReset = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('reset');
    setSearchParams(next, { replace: true });
    setResetDone(false);
    setResetTokenError('');
    switchView('signin');
  };

  // ------------------------------------------------------------ chrome

  const stepHeadingRef = useRef<HTMLSpanElement>(null);
  const firstStepRender = useRef(true);
  // Moving between steps announces the new step and parks focus on its
  // name, so a screen reader hears where it is and Tab reaches the first
  // field next.
  useEffect(() => {
    if (firstStepRender.current) {
      firstStepRender.current = false;
      return;
    }
    // The previous screen is still exiting when `step` changes (mode="wait");
    // the new stepper mounts after the swap, so the focus waits for it.
    const t = window.setTimeout(() => stepHeadingRef.current?.focus({ preventScroll: true }), 240);
    return () => window.clearTimeout(t);
  }, [step]);

  const backLink = (onClick: () => void, label: string = s.backLabel) => (
    <button type="button" onClick={onClick} className="lv-back">
      <ArrowLeft aria-hidden />
      <span>{label}</span>
    </button>
  );

  const heading = (sheet: string, title: string, hint?: string) => (
    <div className="lv-head">
      <span className="lv-eyebrow lv-mono" aria-hidden>
        {sheet}
      </span>
      <h1 className="lv-title">{title}</h1>
      {hint && <p className="lv-sub">{hint}</p>}
    </div>
  );

  const errorSummary = serverError ? (
    <div className="lv-alert" role="alert">
      <X aria-hidden />
      <div style={{ minWidth: 0 }}>
        <p>{serverError}</p>
        {phoneNeedsTelegram && (
          <button type="button" onClick={openTelegram} className="lv-btn-quiet">
            <TelegramIcon />
            {s.continueWithTelegram}
          </button>
        )}
      </div>
    </div>
  ) : null;

  const buttonStatus: FillButtonStatus =
    submitting && via === 'form'
      ? 'submitting'
      : succeeded && via === 'form'
        ? 'success'
        : serverError && via === 'form'
          ? 'error'
          : 'idle';
  const googleBusy = submitting && via === 'google';

  // Only offered when the deployment can actually send the mail; it sits on
  // the password label's row so it costs no height.
  const forgotLink = resetConfigured ? (
    <button type="button" onClick={() => switchView('forgot')} className="lv-link lv-link--inline">
      {s.forgotLink}
    </button>
  ) : undefined;

  const passwordField = (autoComplete: 'current-password' | 'new-password', label = s.password) => (
    <AuthTextField
      id={autoComplete}
      label={label}
      type="password"
      value={password}
      onChange={onPasswordChange}
      autoComplete={autoComplete}
      icon={<Lock />}
      revealLabels={{ show: s.showPassword, hide: s.hidePassword }}
      disabled={submitting}
      labelEnd={autoComplete === 'current-password' ? forgotLink : undefined}
      {...(autoComplete === 'new-password'
        ? {
            /**
             * THE RULE, BEFORE IT IS BROKEN.
             *
             * `checkPassword` on the server throws «Password must be at least
             * 8 characters» — in English, with no error code, so the client's
             * code table cannot translate it. An Arabic or Kurdish customer
             * therefore met an English sentence at the one moment they are
             * least able to guess what it wants.
             *
             * The requirement was already written in all three languages and
             * was only being used as a hint under the STEP. Showing it on the
             * field turns a refusal into an instruction, and it stops being a
             * refusal at all: it goes green as soon as it is satisfied, so
             * nobody reaches the server's message.
             */
            help: s.hintPassword,
            helpTone: (password.length === 0 ? 'neutral' : newPwValid ? 'ok' : 'bad') as 'neutral' | 'ok' | 'bad',
            ok: newPwValid,
          }
        : {})}
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
      icon={<Lock />}
      revealLabels={{ show: s.showPassword, hide: s.hidePassword }}
      error={confirmMismatchError}
      disabled={submitting}
    />
  );

  /**
   * The provider seam. Google is Google's own iframe (the credential flow
   * needs it), Telegram is a quiet outline button; both sit under the
   * primary form, never above it, and only when the deployment offers them.
   */
  /**
   * A phone is a way IN and a way to START, so the button is offered on both
   * screens — and only when at least one channel can carry the code, because a
   * button that leads to "no channel available" is worse than no button.
   */
  const phoneEntry = whatsappCodeConfigured || telegramConfigured;

  const providerBlock =
    googleConfigured || telegramConfigured || phoneEntry || emailCodeConfigured ? (
      <>
        <div className="lv-provider-row">
          <AuthDivider label={s.orLabel} />
          <div className="lv-providers">
            {googleConfigured && (
              <div>
                <GoogleAuthButton
                  view={view === 'signup' ? 'signup' : 'signin'}
                  busy={googleBusy}
                  compact={shortViewport}
                  onCredential={handleGoogleCredential}
                  onError={() => setServerError(s.googleFailed)}
                />
                {googleBusy && (
                  <span className="sr-only" role="status">
                    {s.googleWorking}
                  </span>
                )}
              </div>
            )}
            {telegramConfigured && (
              <SocialAuthButton
                icon={<TelegramIcon />}
                label={s.continueWithTelegram}
                onClick={openTelegram}
                disabled={submitting}
                compact={shortViewport}
              />
            )}
            {/*
              ON BOTH SCREENS NOW, and that is the change the owner asked for.
              A code used to be sign-in only because it answers "do you control
              this destination" and not "what should this account be called" —
              but the second question has a screen of its own now
              (CodeAuth's profile step), so the first one is enough to start
              from. The server agrees: /otp/verify hands back a ticket instead
              of a session when there is no account yet.
            */}
            {emailCodeConfigured && (
              <SocialAuthButton
                icon={<Mail aria-hidden="true" className="w-5 h-5" />}
                label={s.signInWithEmailCode}
                onClick={() => openCodePanel('code-email')}
                disabled={submitting}
                compact={shortViewport}
              />
            )}
            {/*
              ONE BUTTON FOR THE PHONE, not one per channel. "Which of WhatsApp
              or Telegram" is a question about a number that already exists, so
              it is asked after the number and not instead of it.
            */}
            {phoneEntry && (
              <SocialAuthButton
                icon={<MessageCircle aria-hidden="true" className="w-5 h-5" />}
                label={s.usePhone}
                onClick={openPhonePanel}
                disabled={submitting}
                compact={shortViewport}
              />
            )}
          </div>
        </div>
        {googleConfigured && <p className="lv-note-google">{s.googleNote}</p>}
      </>
    ) : null;

  // The ordering and the search moved into CountryPicker, which is the only
  // thing that needed the list. What is left is the one line the REVIEW step
  // still needs: what to call the country the person chose.
  const countryLabel = country ? `${flagOf(country)} ${countryNames(lang)(country)}` : '';

  const stepper = (
    <div className="lv-stepper" role="group" aria-label={s.steps}>
      <div className="lv-stepper__rail" aria-hidden>
        {[1, 2, 3].map((n) => (
          <span key={n} className={`lv-stepper__seg${n < step ? ' is-done' : n === step ? ' is-active' : ''}`} />
        ))}
      </div>
      <div className="lv-stepper__meta">
        <span ref={stepHeadingRef} tabIndex={-1} className="lv-stepper__name" aria-live="polite" style={{ outline: 'none' }}>
          {step === 1 ? (emailFirst ? s.step1NameEmail : s.step1Name) : step === 2 ? s.step2Name : s.step3Name}
        </span>
        <span className="lv-stepper__count lv-mono">
          <b>0{step}</b> / 03
        </span>
      </div>
    </div>
  );

  const reviewRow = (key: string, value: string, target: SignupStep, ltr = false) => (
    <div className="lv-review__row">
      <span className="lv-review__key">{key}</span>
      <span className={`lv-review__val${value ? '' : ' lv-review__val--empty'}`} dir={ltr ? 'ltr' : 'auto'}>
        {value || '—'}
      </span>
      <button type="button" className="lv-review__edit" onClick={() => goToStep(target)}>
        {s.edit}
      </button>
    </div>
  );

  /**
   * THE CODE PANEL — a six-digit code to an address, on either view.
   *
   * Sign-up reaches it too now: /otp/verify answers a proven destination with
   * no account by handing back a ticket, and CodeAuth's own third screen asks
   * the one question a code cannot answer, which is what to call the person.
   */
  const codePanel = (signup: boolean) => (
    <div>
      {backLink(() => setPanel('form'))}
      {heading(SHEET.code, signup ? s.signUpTitle : s.codeSignInTitle)}
      {errorSummary}
      <CodeAuth
        channel={panel === 'code-email' ? 'email' : 'whatsapp'}
        mode={signup ? 'signup' : 'signin'}
        referralCode={referralCode}
        onSuccess={(created) => finishAuth(created)}
        onSwitchMode={signup ? undefined : switchView}
      />
    </div>
  );

  /**
   * THE PHONE PANEL — one number, then one choice of road.
   *
   * It serves BOTH views: the only difference is the word on the heading and
   * the `mode` the two children get, because "prove this number" is the same
   * act whether an account is waiting at the end of it or is about to be made.
   */
  const phonePanel = (signup: boolean) => {
    if (phoneChannel === 'whatsapp') {
      return (
        <div>
          {backLink(() => setPhoneChannel(''))}
          {heading(SHEET.code, signup ? s.signUpTitle : s.signInTitle)}
          {errorSummary}
          <CodeAuth
            channel="whatsapp"
            mode={signup ? 'signup' : 'signin'}
            initialPhone={phoneValue}
            referralCode={referralCode}
            onSuccess={(created) => finishAuth(created)}
          />
        </div>
      );
    }
    if (phoneChannel === 'telegram') {
      return (
        <div>
          {backLink(() => setPhoneChannel(''))}
          {heading(SHEET.telegram, signup ? s.signUpTitle : s.signInTitle)}
          {errorSummary}
          {/* TelegramAuth renders its own <form>s; never nested in another. */}
          <TelegramAuth
            mode={signup ? 'signup' : 'signin'}
            initialPhone={phoneValue}
            onSuccess={() => finishAuth(signup)}
            onSwitchMode={switchView}
            referralCode={referralCode}
          />
        </div>
      );
    }
    return (
      <div>
        {backLink(() => setPanel('form'))}
        {heading(SHEET.code, s.phonePanelTitle, signup ? s.signUpWithPhoneHint : s.phonePanelHint)}
        {errorSummary}
        <div className="lv-fields">
          <PhoneField
            id="auth-phone"
            label={s.phonePanelTitle}
            countryLabel={ob.country}
            commonLabel={ob.commonCountries}
            allLabel={ob.allCountries}
            searchLabel={ob.countrySearch}
            emptyLabel={ob.countryEmpty}
            value={phoneValue}
            onChange={setPhoneValue}
            lang={lang}
          />
        </div>
        <p className="lv-field__label" style={{ marginTop: 6 }}>
          {s.phoneChannelQuestion}
        </p>
        {/* The roads. Disabled until the number is real for its country, so
            nobody sends a code to a half-typed number and then waits. */}
        <div className="lv-chanpick">
          {whatsappCodeConfigured && (
            <button
              type="button"
              className="lv-chan"
              disabled={!phoneValue.valid}
              onClick={() => {
                clearMessages();
                setPhoneChannel('whatsapp');
              }}
            >
              <MessageCircle aria-hidden="true" />
              <span>
                <b>{s.channelWhatsapp}</b>
                <small>{s.channelWhatsappHint}</small>
              </span>
            </button>
          )}
          {telegramConfigured && (
            <button
              type="button"
              className="lv-chan"
              disabled={!phoneValue.valid}
              onClick={() => {
                clearMessages();
                setPhoneChannel('telegram');
              }}
            >
              <TelegramIcon />
              <span>
                <b>{s.channelTelegram}</b>
                <small>{s.channelTelegramHint}</small>
              </span>
            </button>
          )}
          {!whatsappCodeConfigured && !telegramConfigured && (
            <p className="lv-notice lv-notice--warn" role="status">
              {s.phoneNoChannel}
            </p>
          )}
        </div>
      </div>
    );
  };

  // ------------------------------------------------------------- screens

  let screenKey: string;
  let screen: React.ReactNode;

  if (finishToken) {
    if (finishState === 'loading') {
      screenKey = 'finish-loading';
      screen = (
        <div>
          {heading(SHEET.finish, s.finishTitle)}
          <p className="lv-sub" role="status" aria-live="polite">
            <span className="lv-dots" aria-hidden /> {s.finishLoading}
          </p>
        </div>
      );
    } else if (finishState === 'dead') {
      screenKey = 'finish-dead';
      screen = (
        <div className="lv-center">
          <span className="lv-center__icon" aria-hidden>
            <Mail />
          </span>
          <h1 className="lv-title">{s.finishDeadTitle}</h1>
          <p className="lv-sub">{s.finishDeadBody}</p>
          <button type="button" onClick={() => leaveFinish('signup')} className="lv-btn-gold">
            {s.signUpAgain}
          </button>
          <button type="button" onClick={() => leaveFinish('signin')} className="lv-link" style={{ marginTop: 8 }}>
            {s.backToSignIn}
          </button>
        </div>
      );
    } else {
      screenKey = 'finish';
      screen = (
        <form onSubmit={handleFinish} noValidate aria-busy={submitting && via === 'form'}>
          {heading(SHEET.finish, s.finishTitle, s.finishHint(finishInfo?.email ?? ''))}
          {finishLoadFailed && !serverError && (
            <div className="lv-notice lv-notice--warn" role="status">
              <Info aria-hidden />
              <p>{finishLoadRateLimited ? s.errTooMany : s.errNetwork}</p>
            </div>
          )}
          {/* The referral that will be credited, visible and removable. */}
          <div style={{ marginBottom: 14 }}>
            <ReferralBar code={finishReferral} onCodeChange={setFinishReferral} fromLink={finishReferralFromLink} disabled={submitting} />
          </div>
          {errorSummary}
          <div className="lv-fields">
            {passwordField('new-password')}
            {confirmField}
          </div>
          <div className="lv-cta">
            <FillButton
              id="finish-submit"
              label={s.finishCta}
              workingLabel={s.finishing}
              successLabel={s.finished}
              progress={resetFill.progress}
              ready={resetFill.ready}
              status={buttonStatus}
              hint={!newPwValid ? s.hintPassword : !confirmValid ? s.hintConfirm : ''}
            />
          </div>
          <p className="lv-terms">
            {s.termsPrefix}{' '}
            <Link to="/policies" className="lv-link">
              {s.termsLink}
            </Link>
          </p>
          <p className="lv-foot">
            <button type="button" onClick={() => leaveFinish('signin')} className="lv-link">
              {s.backToSignIn}
            </button>
          </p>
        </form>
      );
    }
  } else if (resetToken) {
    if (resetDone) {
      screenKey = 'reset-done';
      screen = (
        <div className="lv-center">
          <span className="lv-center__icon" aria-hidden>
            <CheckCircle2 />
          </span>
          <h1 className="lv-title">{s.resetDoneTitle}</h1>
          <p className="lv-sub">{s.resetDoneBody}</p>
          <button type="button" onClick={backToLoginFromReset} className="lv-btn-gold">
            {s.signInCta}
          </button>
        </div>
      );
    } else if (resetTokenError) {
      screenKey = 'reset-dead';
      screen = (
        <div className="lv-center">
          <span className="lv-center__icon" aria-hidden>
            <Mail />
          </span>
          <h1 className="lv-title">{resetTokenError === 'used' ? s.resetUsedTitle : s.resetExpiredTitle}</h1>
          <p className="lv-sub">{s.resetDeadBody}</p>
          <button type="button" onClick={switchToForgotForm} className="lv-btn-gold">
            {s.requestNewLink}
          </button>
          <button type="button" onClick={backToLoginFromReset} className="lv-link" style={{ marginTop: 8 }}>
            {s.backToSignIn}
          </button>
        </div>
      );
    } else {
      screenKey = 'reset';
      screen = (
        <form onSubmit={handleReset} noValidate aria-busy={submitting && via === 'form'}>
          {heading(SHEET.reset, s.resetTitle, s.resetHint)}
          {errorSummary}
          <div className="lv-fields">
            {passwordField('new-password', s.newPassword)}
            {confirmField}
          </div>
          <div className="lv-cta">
            <FillButton
              id="reset-submit"
              label={s.setPasswordCta}
              workingLabel={s.settingPassword}
              progress={resetFill.progress}
              ready={resetFill.ready}
              status={buttonStatus}
              hint={!newPwValid ? s.hintPassword : !confirmValid ? s.hintConfirm : ''}
            />
          </div>
          <p className="lv-foot">
            <button type="button" onClick={backToLoginFromReset} className="lv-link">
              {s.backToSignIn}
            </button>
          </p>
        </form>
      );
    }
  } else if (view === 'forgot') {
    screenKey = 'forgot';
    screen = (
      <form onSubmit={handleForgot} noValidate aria-busy={submitting && via === 'form'}>
        {backLink(() => switchView('signin'))}
        {heading(SHEET.forgot, s.forgotTitle, s.forgotHint)}
        {emailNotConfigured && (
          <div className="lv-notice lv-notice--warn" role="status">
            <Info aria-hidden />
            <p>{s.emailNotConfigured}</p>
          </div>
        )}
        {forgotMessage && (
          <div className="lv-notice lv-notice--ok" role="status">
            <MailCheck aria-hidden />
            <p>{forgotMessage}</p>
          </div>
        )}
        {errorSummary}
        <div className="lv-fields">
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
            icon={<Mail />}
            disabled={submitting}
          />
        </div>
        <div className="lv-cta">
          <FillButton
            id="forgot-submit"
            label={s.sendResetCta}
            workingLabel={s.sendingReset}
            successLabel={s.resetSent}
            progress={forgotFill.progress}
            ready={forgotFill.ready}
            status={buttonStatus}
            hint={!emailValid ? s.hintEmail : ''}
          />
        </div>
      </form>
    );
  } else if (view === 'signup') {
    screenKey = pendingEmail
      ? 'signup:pending'
      : `signup:${panel}:${panel === 'form' ? step : 0}:${phoneChannel}`;
    if (pendingEmail) {
      screen = (
        <div>
          {heading(SHEET.signup, s.pendingTitle, s.pendingHint)}
          <div className="lv-notice lv-notice--info" role="status">
            <MailCheck aria-hidden />
            <p>{s.pendingBody(trimmedEmail)}</p>
          </div>
          <p className="lv-sub">{s.pendingSpam}</p>
          <button type="button" onClick={() => switchView('signin')} className="lv-link">
            {s.pendingSignIn}
          </button>
        </div>
      );
    } else if (panel === 'phone') {
      screen = phonePanel(true);
    } else if (panel === 'code-email' || panel === 'code-whatsapp') {
      screen = codePanel(true);
    } else if (panel === 'telegram') {
      screen = (
        <div>
          {backLink(() => setPanel('form'))}
          {heading(SHEET.telegram, s.signUpTitle)}
          {errorSummary}
          {/* TelegramAuth renders its own <form>s; it is never nested in the credentials form. */}
          <TelegramAuth mode="signup" onSuccess={() => finishAuth(true)} onSwitchMode={switchView} referralCode={referralCode} />
        </div>
      );
    } else if (step === 1) {
      screen = (
        <div>
          {backLink(() => switchView('signin'))}
          {heading(SHEET.signup, s.signUpTitle, emailFirst ? s.step1HintEmail : s.step1Hint)}
          {stepper}
          {/* The referral bar sits OUTSIDE the form: it is not a field of the
              account and must never gate the button. */}
          <div style={{ marginBottom: 14 }}>
            <ReferralBar code={referralCode} onCodeChange={setReferralCode} fromLink={refFromLink} disabled={submitting} />
          </div>
          {errorSummary}
          <form onSubmit={handleStep1} noValidate>
            <div className="lv-fields">
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
                icon={<Mail />}
              />
              {!emailFirst && passwordField('new-password')}
              {!emailFirst && confirmField}
            </div>
            <div className="lv-cta">
              <FillButton
                id="signup-next-1"
                label={s.next}
                workingLabel={s.next}
                progress={step1Fill.progress}
                ready={step1Fill.ready}
                hint={step1Hint}
              />
            </div>
          </form>
          {providerBlock}
          <p className="lv-foot lv-foot--optional">
            {s.haveAccount}{' '}
            <button type="button" onClick={() => switchView('signin')} className="lv-link">
              {s.signInAction}
            </button>
          </p>
        </div>
      );
    } else if (step === 2) {
      screen = (
        <div>
          {backLink(() => goToStep(1))}
          {heading(SHEET.signup, s.signUpTitle, s.step2Hint)}
          {stepper}
          {errorSummary}
          <form onSubmit={handleStep2} noValidate>
            <div className="lv-fields">
              <AuthTextField
                id="name"
                label={s.fullName}
                value={name}
                onChange={onNameChange}
                autoComplete="name"
                valueDir="auto"
                maxLength={100}
                icon={<UserRound />}
              />
              <AuthTextField
                id="username"
                label={s.username}
                value={username}
                onChange={onUsernameChange}
                autoComplete="username"
                placeholder="username123"
                valueDir="ltr"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={30}
                icon={<AtSign />}
                help={usernameHelp}
                helpTone={usernameTone}
                ok={availability.state === 'free'}
                trail={
                  availability.state === 'checking' ? (
                    <span className="lv-dots" />
                  ) : availability.state === 'free' ? (
                    <Check />
                  ) : availability.state === 'unavailable' ? (
                    <X />
                  ) : null
                }
              />
              <div>
                <label htmlFor="country" className="lv-field__label">
                  {ob.country} <span style={{ fontWeight: 400, color: 'var(--lv-text-3)' }}>· {s.optional}</span>
                </label>
                {/*
                  The picker, not a native <select>: 245 rows of operating-system
                  chrome in the middle of this page, with no way to type «العراق»
                  or `964`. `unsetLabel` keeps the question optional — a picker
                  with no way back to blank turns "you may tell us" into
                  "you already did".
                */}
                <CountryPicker
                  id="country"
                  label={ob.country}
                  value={country}
                  onChange={setCountry}
                  lang={lang}
                  showDial={false}
                  unsetLabel={ob.countryPlaceholder}
                  commonLabel={ob.commonCountries}
                  allLabel={ob.allCountries}
                  placeholder={ob.countrySearch}
                  emptyLabel={ob.countryEmpty}
                />
              </div>
            </div>
            <div className="lv-cta">
              <FillButton
                id="signup-next-2"
                label={s.next}
                workingLabel={s.next}
                progress={step2Fill.progress}
                ready={step2Fill.ready}
                hint={step2Hint}
              />
            </div>
          </form>
        </div>
      );
    } else {
      screen = (
        <div>
          {backLink(() => goToStep(2))}
          {heading(SHEET.signup, s.signUpTitle, s.step3Hint)}
          {stepper}
          {errorSummary}
          <form onSubmit={handleSignUp} noValidate aria-busy={submitting && via === 'form'}>
            <div className="lv-review">
              {reviewRow(s.email, trimmedEmail, 1, true)}
              {reviewRow(s.username, trimmedUsername ? `@${trimmedUsername}` : '', 2, true)}
              {reviewRow(s.fullName, trimmedName, 2)}
              {reviewRow(ob.country, countryLabel, 2)}
              {referralCode.trim() && reviewRow(s.referralLabel, referralCode.trim(), 1, true)}
            </div>
            {emailVerificationConfigured && (
              <div className="lv-notice lv-notice--info lv-notice--tight" role="note">
                <MailCheck aria-hidden />
                <p>{s.verifyNote}</p>
              </div>
            )}
            <div className="lv-cta">
              <FillButton
                id="signup-submit"
                label={emailFirst ? s.sendLinkCta : s.signUpCta}
                workingLabel={emailFirst ? s.sendingLink : s.signingUp}
                successLabel={emailFirst ? s.linkSent : s.signedUp}
                progress={signupEmailFill.progress}
                ready={signupEmailFill.ready}
                status={buttonStatus}
                hint={signupEmailHint}
              />
            </div>
            <p className="lv-terms">
              {s.termsPrefix}{' '}
              <Link to="/policies" className="lv-link">
                {s.termsLink}
              </Link>
            </p>
          </form>
        </div>
      );
    }
  } else {
    screenKey = `signin:${panel}:${phoneChannel}`;
    if (panel === 'phone') {
      screen = phonePanel(false);
    } else if (panel === 'code-email' || panel === 'code-whatsapp') {
      screen = codePanel(false);
    } else if (panel === 'telegram') {
      screen = (
        <div>
          {backLink(() => setPanel('form'))}
          {heading(SHEET.telegram, s.signInTitle)}
          {errorSummary}
          <TelegramAuth mode="signin" onSuccess={() => finishAuth(false)} onSwitchMode={switchView} />
        </div>
      );
    } else {
      screen = (
        <div>
          {heading(SHEET.signin, s.signInTitle, s.signInHint)}
          {errorSummary}
          <form onSubmit={handleSignIn} noValidate aria-busy={submitting && via === 'form'}>
            <div className="lv-fields">
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
                icon={<UserRound />}
                disabled={submitting}
              />
              {passwordField('current-password')}
            </div>
            <div className="lv-cta">
              <FillButton
                id="signin-submit"
                label={s.signInCta}
                workingLabel={s.signingIn}
                successLabel={s.signedIn}
                progress={signinEmailFill.progress}
                ready={signinEmailFill.ready}
                status={buttonStatus}
                hint={signinEmailHint}
              />
            </div>
          </form>
          {providerBlock}
          <p className="lv-foot">
            {s.noAccount}{' '}
            <button type="button" onClick={() => switchView('signup')} className="lv-link">
              {s.signUpAction}
            </button>
          </p>
        </div>
      );
    }
  }

  // The Google provider is mounted ONCE for the page, only when a client id
  // is configured, and never inside the animated screen (remounting the GIS
  // iframe on every switch would flicker and re-request the script).
  const withGoogle = (node: React.ReactNode) =>
    googleClientId ? <GoogleOAuthProvider clientId={googleClientId}>{node}</GoogleOAuthProvider> : node;

  return withGoogle(
    <AuthShell dir={dir}>
      {/*
        mode="wait": exactly one screen — and one <form> — is mounted at a time.

        The travel is INLINE and DIRECTIONAL: a forward step enters from the
        leading edge and leaves towards the trailing one, and a back step runs
        that path in reverse. `m.inline()` carries the writing direction, so an
        Arabic reader sees the journey mirrored rather than a Latin layout's
        idea of "forward" (§7).

        A spring, not a 160ms curve. A fixed duration cannot be caught and
        reversed halfway, and somebody tapping «رجوع» while the previous step
        is still arriving is the ordinary case this screen has to survive
        (§2). Under reduced motion `m.spring()` collapses to a cross-fade and
        `m.travel()` returns 0, so the screen changes without moving.
      */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={screenKey}
          initial={{ opacity: 0, x: m.inline(m.travel(18) * stepDir) }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: m.inline(m.travel(18) * -stepDir) }}
          transition={m.spring('ui')}
        >
          {screen}
        </motion.div>
      </AnimatePresence>
    </AuthShell>
  );
}
