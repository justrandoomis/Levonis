/**
 * Settings (integrated mandate §10).
 *
 * Every row below was audited against a REAL endpoint, a real permission and
 * a real stored value. What exists is wired; what has no backend is either
 * gone or visibly disabled with the actual reason — never a control that
 * pretends to save something.
 *
 * WIRED (server-backed):
 *  - Account            → /edit-profile (PATCH /api/profile: name, username
 *                         with the server's 14-day cooldown, avatar, bio…)
 *  - Email verification → GET  /api/auth/verify-email/status
 *                         POST /api/auth/verify-email/send
 *  - Change email       → POST /api/auth/change-email  (re-auth with the
 *                         current password; applies only after the new inbox
 *                         confirms — this page never says "changed")
 *  - Change password    → POST /api/auth/change-password (min 8 chars,
 *                         server-verified current password). The server
 *                         revokes every OTHER session on success, which is
 *                         exactly what this page tells the user.
 *  - Telegram link      → <TelegramLink/> (GET/POST /api/auth/telegram/*)
 *  - Addresses          → GET /api/addresses (count, default, PRO approved
 *                         snapshot) and the /addresses page for edits
 *  - Language           → setLang + PATCH /api/profile { locale }, so the
 *                         choice survives refresh, sign-out and other devices
 *  - Policies / Support → /policies, /support
 *  - Sign out           → POST /api/auth/logout
 *
 * FIXED, AND THE ENTRY IS KEPT SO IT IS NOT RE-BROKEN: the Google row's
 * «مرتبط / غير مرتبط» state used to be listed below as unavailable, and it was
 * — but for a reason nobody had noticed. `publicUser` derives `has_google`
 * from `google_sub`, and `loadSessionUser` deleted that column before the
 * object reached the request context, so GET /api/auth/me answered false for
 * every account in existence while login and /auth/google answered true. See
 * worker/lib/session.ts and tests/googleLinkSurvivesSession.test.ts.
 *
 * HONESTLY DISABLED (no backend exists today — stated, not simulated):
 *  - Session/device list and "sign out other devices" as a standalone action:
 *    no endpoint enumerates or revokes sessions on demand.
 *  - Google LINKING from inside this page: the row reports the state (see
 *    below) but cannot change it. POST /api/auth/google/link exists and needs
 *    a Google credential flow plus the current password, and the copy for that
 *    button and its refusals is not written yet.
 *  - Unlinking any sign-in method: no endpoint — so the "never lock yourself
 *    out by removing the last method" rule cannot be violated from here.
 *  - Per-account display currency: none is stored; the ledger is IQD.
 *  - Web Push delivery: no server-side push service. The browser permission
 *    state is shown as what it is; permission is never presented as
 *    "notifications enabled".
 *
 * REMOVED: the old "Appearance" (System/Light/Dark) row wrote localStorage
 * and NOTHING read it — a control with no effect — and the "All elements" /
 * "Setup extension" placeholders. Preferences that are real live below.
 *
 * Data safety: no PATCH from this page can touch role, balance or verified
 * flags — those fields are not accepted by /api/profile, and every write is
 * authorised server-side against the session's own user id.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, User, MapPin, Bell, Globe, LogOut, ShieldCheck, Mail, KeyRound, Link2, FileText, LifeBuoy, Loader2, Check, Coins, CheckCircle2, Download } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, listSessions, revokeSession, revokeOtherSessions, type ApiSession } from '../lib/api';
import TelegramLink from '../components/security/TelegramLink';
import { MotionCharacterHome } from '../components/bloub/MotionCharacterAnchor';
import { useCapabilities } from '../hooks/useCapabilities';
import { useInstallApp } from '../hooks/useInstallApp';
import InstallAppButton from '../components/pwa/InstallAppButton';

const PASSWORD_MIN = 8; // mirrors worker/routes/auth.ts checkPassword
const USERNAME_COOLDOWN_DAYS = 14; // mirrors worker/routes/profile.ts

const STRINGS = {
  ar: {
    title: 'الإعدادات', back: 'رجوع',
    secAccount: 'الحساب', secSecurity: 'الأمان', secLinking: 'الربط',
    secAddresses: 'العناوين', secPrefs: 'التفضيلات', secNotifications: 'الإشعارات',
    secPrivacy: 'الخصوصية والمساعدة',
    guest: 'زائر', editProfile: 'تعديل الملف الشخصي',
    accountRow: 'بيانات الحساب والصورة واسم المستخدم',
    usernameNote: `رابط إحالتك يعتمد اسم المستخدم الحالي؛ بعد تغييره شارك الرابط الجديد. الخادم يسمح بالتغيير مرة كل ${USERNAME_COOLDOWN_DAYS} يومًا.`,
    email: 'البريد الإلكتروني', emailVerified: 'موثّق', emailUnverified: 'غير موثّق',
    sendVerify: 'إرسال رابط التحقق', sending: 'جارٍ الإرسال…',
    verifySent: 'إن كان بريدك بحاجة إلى تحقق فقد أُرسلت الرسالة إليه.',
    emailNotConfigured: 'خدمة البريد غير مهيأة على الخادم بعد، لذا لا يمكن إرسال رسائل التحقق أو تغيير البريد.',
    changeEmail: 'تغيير البريد', newEmail: 'البريد الجديد',
    changeEmailNote: 'لا يتغير البريد إلا بعد تأكيدك من الصندوق الجديد.',
    emailFormInvalid: 'صيغة البريد غير صحيحة — اكتبه هكذا: name@example.com',
    notifEmailReady: 'جاهز لاستقبال الفواتير ورسائل الأمان.',
    notifEmailNeedsVerify: 'أكّد بريدك أولاً لتصلك الفواتير ورسائل الأمان.',
    notifGoTelegram: 'اذهب إلى الربط',
    notifWhatsapp: 'واتساب',
    notifWhatsappWhy: 'غير متاح بعد: لم يهيّئ المسؤول مزوّد واتساب. لا نعرض زرًا لا يعمل.',
    waReady: 'مُفعّل',
    waNeedsPhone: 'يحتاج رقمًا',
    waReadyNote: 'ستصلك تحديثات طلبك على واتساب على الرقم الموثّق في حسابك، ويمكنك تسجيل الدخول برمز يصل إليه.',
    waNeedsPhoneNote: 'لا يوجد رقم موثّق على حسابك بعد. وثّق رقمك عبر تيليغرام ليعمل واتساب.',
    waGoVerify: 'توثيق رقمي',
    changePassword: 'تغيير كلمة المرور', currentPassword: 'كلمة المرور الحالية',
    newPassword: 'كلمة المرور الجديدة', confirmPassword: 'تأكيد كلمة المرور',
    pwMin: `الحد الأدنى ${PASSWORD_MIN} أحرف.`, pwMismatch: 'كلمتا المرور غير متطابقتين.',
    pwChanged: 'تم تغيير كلمة المرور. سُجّل الخروج من الأجهزة الأخرى.',
    pwOtherSessions: 'تغيير كلمة المرور يُنهي جلسات كل الأجهزة الأخرى — وهذا هو المسار المدعوم لإخراج جهاز آخر.',
    forgotPassword: 'نسيت كلمة المرور؟ استخدم الاستعادة من صفحة الدخول.',
    sessionsRow: 'قائمة الجلسات والأجهزة',
    sessionsIntro: 'الأجهزة التي سجّلت الدخول إلى حسابك. إن رأيت جهازًا لا تعرفه، أنهِ جلسته وغيّر كلمة المرور.',
    sessionsThisDevice: 'هذا الجهاز',
    sessionsSince: 'منذ',
    sessionsUntil: 'تنتهي',
    sessionsEnd: 'إنهاء',
    sessionsEndOthers: 'إنهاء كل الجلسات الأخرى',
    sessionsOnlyThis: 'لا توجد جلسات أخرى — هذا هو الجهاز الوحيد الداخل على حسابك.',
    sessionsEnded: 'تم إنهاء الجلسة.',
    sessionsEndedOthers: 'تم إنهاء الجلسات الأخرى.',
    sessionsFailed: 'تعذّر تحميل الجلسات.',
    sessionsUnknownDevice: 'جهاز غير معروف',
    telegram: 'تيليغرام', google: 'Google',
    googleConnected: 'مرتبط',
    googleNotConnected: 'غير مرتبط',
    googleConnectedNote: 'يمكنك تسجيل الدخول بزر Google مباشرة.',
    googleConnectHint: 'سجّل الخروج ثم استخدم زر Google بنفس بريدك الموثّق لربطه بحسابك.',
    unlinkNote: 'فك الربط غير متاح من هنا — لا توجد واجهة له، وبذلك لا يمكن أن تفقد آخر وسيلة دخول بالخطأ.',
    addressesRow: 'عناويني', addressesCount: 'العناوين المحفوظة: {n}',
    addressesDefault: 'العنوان الافتراضي: {label}', addressesNone: 'لا توجد عناوين محفوظة بعد.',
    approvedYes: 'يوجد عنوان PRO معتمد (نسخة ثابتة).',
    approvedNo: 'لا يوجد عنوان PRO معتمد.',
    approvedNote: 'العنوان المعتمد نسخة مجمّدة: تعديل العنوان المحفوظ لا يغيّرها. تغيير النسخة المعتمدة يمر بطلب دعم وموافقة الإدارة، والعنوان البديل يأخذ التسعير العادي دون حذف اشتراكك.',
    language: 'اللغة', direction: 'اتجاه الصفحة', rtl: 'من اليمين إلى اليسار', ltr: 'من اليسار إلى اليمين',
    langSaved: 'حُفظت اللغة في حسابك.', langSaveFailed: 'تعذر حفظ اللغة على الخادم — التغيير مطبّق في هذا المتصفح فقط.',
    currency: 'العملة', currencyNote: 'دفاتر المتجر والطلبات بالدينار العراقي. لا يوجد إعداد عملة عرض لكل حساب، ولن تُعاد تسعير طلبات مؤكدة.',
    pushTitle: 'إشعارات المتصفح (Web Push)',
    pushUnsupported: 'غير مدعوم في هذا المتصفح', pushBlocked: 'محظورة من إعدادات المتصفح',
    pushGranted: 'إذن المتصفح ممنوح', pushOff: 'إذن المتصفح غير ممنوح',
    pushAsk: 'طلب إذن المتصفح',
    pushHonesty: 'منح الإذن يجهّز المتصفح فقط. لا توجد خدمة إرسال Web Push على الخادم بعد، فلا نعرض «تم التفعيل».',
    emailNotifTitle: 'إشعارات البريد',
    emailNotifNote: 'رسائل أمان الحساب وفاتورة الطلب فقط، وتُرسل إلى بريد موثّق. إشعارات المحفظة مسار منفصل. لا رسائل تسويقية.',
    tgNotifNote: 'تيليغرام يُستخدم للتحقق ورموز الأمان بعد ربطه من قسم «الربط» أعلاه.',
    policies: 'السياسات والشروط', support: 'الدعم والمساعدة',
    closure: 'إغلاق الحساب', closureNote: 'لا يوجد زر حذف فوري: الأرصدة والطلبات والسجلات المطلوبة نظاميًا لا تُمحى بضغطة. اطلب الإغلاق عبر الدعم لتسوية الرصيد أولًا.',
    signOut: 'تسجيل الخروج', signingOut: 'جارٍ تسجيل الخروج…',
    save: 'حفظ', saving: 'جارٍ الحفظ…', saved: 'تم الحفظ',
    unsaved: 'لديك تعديلات غير محفوظة.',
    guestTitle: 'سجّل الدخول لإدارة إعداداتك',
    signIn: 'تسجيل الدخول',
    loading: 'جارٍ التحميل…', retry: 'إعادة المحاولة', loadFailed: 'تعذر تحميل هذا القسم.',
    notAvailable: 'غير متاح',
  },
  en: {
    title: 'Settings', back: 'Back',
    secAccount: 'Account', secSecurity: 'Security', secLinking: 'Linked accounts',
    secAddresses: 'Addresses', secPrefs: 'Preferences', secNotifications: 'Notifications',
    secPrivacy: 'Privacy & help',
    guest: 'Guest', editProfile: 'Edit profile',
    accountRow: 'Profile details, photo and username',
    usernameNote: `Your referral link uses your current username; share the new link after changing it. The server allows one change every ${USERNAME_COOLDOWN_DAYS} days.`,
    email: 'Email', emailVerified: 'Verified', emailUnverified: 'Not verified',
    sendVerify: 'Send verification link', sending: 'Sending…',
    verifySent: 'A verification message has been sent if your email still needs verification.',
    emailNotConfigured: 'No email service is configured on the server yet, so verification and email changes cannot be sent.',
    changeEmail: 'Change email', newEmail: 'New email',
    changeEmailNote: 'The address changes only after you confirm from the new inbox.',
    emailFormInvalid: 'That email address is not valid — write it like name@example.com',
    notifEmailReady: 'Ready to receive invoices and security messages.',
    notifEmailNeedsVerify: 'Verify your email first so invoices and security messages can reach you.',
    notifGoTelegram: 'Go to linking',
    notifWhatsapp: 'WhatsApp',
    notifWhatsappWhy: 'Not available yet: the administrator has not configured a WhatsApp provider. We do not show a button that cannot work.',
    waReady: 'On',
    waNeedsPhone: 'Needs a number',
    waReadyNote: 'Order updates reach you on WhatsApp at the verified number on your account, and you can sign in with a code sent there.',
    waNeedsPhoneNote: 'Your account has no verified number yet. Verify one through Telegram and WhatsApp starts working.',
    waGoVerify: 'Verify my number',
    changePassword: 'Change password', currentPassword: 'Current password',
    newPassword: 'New password', confirmPassword: 'Confirm password',
    pwMin: `Minimum ${PASSWORD_MIN} characters.`, pwMismatch: 'The passwords do not match.',
    pwChanged: 'Password changed. Other devices were signed out.',
    pwOtherSessions: 'Changing your password ends every other device session — that is the supported way to sign another device out.',
    forgotPassword: 'Forgot your password? Use recovery on the sign-in page.',
    sessionsRow: 'Sessions & devices list',
    sessionsIntro: 'Devices signed in to your account. If you see one you do not recognise, end its session and change your password.',
    sessionsThisDevice: 'This device',
    sessionsSince: 'Since',
    sessionsUntil: 'Until',
    sessionsEnd: 'End',
    sessionsEndOthers: 'End every other session',
    sessionsOnlyThis: 'No other sessions — this is the only device signed in.',
    sessionsEnded: 'Session ended.',
    sessionsEndedOthers: 'The other sessions were ended.',
    sessionsFailed: 'Could not load your sessions.',
    sessionsUnknownDevice: 'Unknown device',
    telegram: 'Telegram', google: 'Google',
    googleConnected: 'Connected',
    googleNotConnected: 'Not connected',
    googleConnectedNote: 'You can sign in with the Google button directly.',
    googleConnectHint: 'Sign out and use the Google button with the same verified email to link it to this account.',
    unlinkNote: 'Unlinking is not offered here — there is no endpoint for it, so you cannot accidentally remove your last sign-in method.',
    addressesRow: 'My addresses', addressesCount: 'Saved addresses: {n}',
    addressesDefault: 'Default address: {label}', addressesNone: 'No saved addresses yet.',
    approvedYes: 'A PRO approved address exists (frozen copy).',
    approvedNo: 'No PRO approved address.',
    approvedNote: 'The approved address is a frozen copy: editing the saved address does not change it. Changing the approved copy goes through a support request and admin approval; an alternative address gets ordinary pricing without cancelling your subscription.',
    language: 'Language', direction: 'Page direction', rtl: 'Right to left', ltr: 'Left to right',
    langSaved: 'Language saved to your account.', langSaveFailed: 'Could not save the language on the server — it applies to this browser only.',
    currency: 'Currency', currencyNote: 'Store and order ledgers are in Iraqi dinar. There is no per-account display currency, and no confirmed order is ever re-priced.',
    pushTitle: 'Browser notifications (Web Push)',
    pushUnsupported: 'Not supported in this browser', pushBlocked: 'Blocked in browser settings',
    pushGranted: 'Browser permission granted', pushOff: 'Browser permission not granted',
    pushAsk: 'Request browser permission',
    pushHonesty: 'Granting permission only prepares your browser. There is no Web Push delivery service on our side yet, so we never show "enabled".',
    emailNotifTitle: 'Email notifications',
    emailNotifNote: 'Account-security messages and the order invoice only, sent to a verified address. Wallet notices are a separate path. No marketing email.',
    tgNotifNote: 'Telegram is used for verification and security codes once linked in the section above.',
    policies: 'Policies & terms', support: 'Support & help',
    closure: 'Account closure', closureNote: 'There is no instant delete button: balances, orders and records we must keep are not erased by a tap. Request closure through support so the balance is settled first.',
    signOut: 'Sign out', signingOut: 'Signing out…',
    save: 'Save', saving: 'Saving…', saved: 'Saved',
    unsaved: 'You have unsaved changes.',
    guestTitle: 'Sign in to manage your settings',
    signIn: 'Sign in',
    loading: 'Loading…', retry: 'Retry', loadFailed: 'This section failed to load.',
    notAvailable: 'Not available',
  },
  ckb: {
    title: 'ڕێکخستنەکان', back: 'گەڕانەوە',
    secAccount: 'هەژمار', secSecurity: 'ئاسایش', secLinking: 'بەستنەوە',
    secAddresses: 'ناونیشانەکان', secPrefs: 'پەسەندەکان', secNotifications: 'ئاگادارکردنەوەکان',
    secPrivacy: 'تایبەتێتی و یارمەتی',
    guest: 'میوان', editProfile: 'دەستکاری پرۆفایل',
    accountRow: 'زانیاری هەژمار، وێنە و ناوی بەکارهێنەر',
    usernameNote: `بەستەری ناردنەکەت ناوی بەکارهێنەری ئێستا بەکاردەهێنێت؛ دوای گۆڕین بەستەری نوێ هاوبەش بکە. ڕاژەکار هەر ${USERNAME_COOLDOWN_DAYS} ڕۆژ جارێک ڕێگە دەدات.`,
    email: 'ئیمەیل', emailVerified: 'پشتڕاستکراوە', emailUnverified: 'پشتڕاست نەکراوە',
    sendVerify: 'ناردنی بەستەری پشتڕاستکردنەوە', sending: 'دەنێردرێت…',
    verifySent: 'ئەگەر ئیمەیلەکەت پێویستی بە پشتڕاستکردنەوە بێت، نامەکە نێردرا.',
    emailNotConfigured: 'خزمەتگوزاری ئیمەیل لەسەر ڕاژەکار ڕێکنەخراوە، بۆیە ناتوانرێت نامەی پشتڕاستکردنەوە یان گۆڕینی ئیمەیل بنێردرێت.',
    changeEmail: 'گۆڕینی ئیمەیل', newEmail: 'ئیمەیلی نوێ',
    changeEmailNote: 'ئیمەیل تەنها دوای پشتڕاستکردنەوە لە ناوسندوقی نوێ دەگۆڕێت.',
    emailFormInvalid: 'ناونیشانی ئیمەیڵ دروست نییە — وەک name@example.com بینووسە',
    notifEmailReady: 'ئامادەیە بۆ وەرگرتنی پسوولە و پەیامە ئەمنییەکان.',
    notifEmailNeedsVerify: 'سەرەتا ئیمەیڵەکەت پشتڕاست بکەرەوە.',
    notifGoTelegram: 'بڕۆ بەستنەوە',
    notifWhatsapp: 'واتسئاپ',
    notifWhatsappWhy: 'هێشتا بەردەست نییە: بەڕێوەبەر دابینکەری واتساپی ڕێکنەخستووە.',
    waReady: 'چالاکە',
    waNeedsPhone: 'ژمارەی پێویستە',
    waReadyNote: 'نوێکارییەکانی داواکارییەکەت بە واتساپ دەگەن بەو ژمارە پشتڕاستکراوەی هەژمارەکەت، و دەتوانیت بە کۆد بچیتە ژوورەوە.',
    waNeedsPhoneNote: 'هێشتا ژمارەیەکی پشتڕاستکراو لەسەر هەژمارەکەت نییە. بە تێلێگرام ژمارەکەت پشتڕاست بکەرەوە.',
    waGoVerify: 'پشتڕاستکردنەوەی ژمارەکەم',
    changePassword: 'گۆڕینی وشەی تێپەڕ', currentPassword: 'وشەی تێپەڕی ئێستا',
    newPassword: 'وشەی تێپەڕی نوێ', confirmPassword: 'دووبارەکردنەوەی وشەی تێپەڕ',
    pwMin: `لانیکەم ${PASSWORD_MIN} پیت.`, pwMismatch: 'وشە تێپەڕەکان وەک یەک نین.',
    pwChanged: 'وشەی تێپەڕ گۆڕدرا. ئامێرەکانی تر دەرچوون.',
    pwOtherSessions: 'گۆڕینی وشەی تێپەڕ هەموو دانیشتنەکانی ئامێرەکانی تر کۆتایی پێدەهێنێت — ئەمە ڕێگای پشتگیریکراوە بۆ دەرکردنی ئامێرێکی تر.',
    forgotPassword: 'وشەی تێپەڕت لەبیرچووە؟ لە پەڕەی چوونەژوورەوە گەڕاندنەوە بەکاربهێنە.',
    sessionsRow: 'لیستی دانیشتن و ئامێرەکان',
    /* The Sorani below is the store's own: «ئامێر» (device) and «دانیشتن»
       (session) are already in this file's Kurdish, and the sentences are
       built from words a Kurdish speaker wrote here. Nothing is generated. */
    sessionsIntro: 'ئەو ئامێرانەی چوونەتە ژوورەوە بۆ هەژمارەکەت.',
    sessionsThisDevice: 'ئەم ئامێرە',
    sessionsSince: 'لە',
    sessionsUntil: 'تا',
    sessionsEnd: 'کۆتایی',
    sessionsEndOthers: 'کۆتایی بە هەموو دانیشتنەکانی تر',
    sessionsOnlyThis: 'هیچ دانیشتنێکی تر نییە.',
    sessionsEnded: 'دانیشتنەکە کۆتایی هات.',
    sessionsEndedOthers: 'دانیشتنەکانی تر کۆتاییان هات.',
    sessionsFailed: 'نەتوانرا دانیشتنەکان باربکرێن.',
    sessionsUnknownDevice: 'ئامێری نەناسراو',
    telegram: 'تێلێگرام', google: 'Google',
    googleConnected: 'بەستراوە',
    googleNotConnected: 'نەبەستراوە',
    googleConnectedNote: 'دەتوانیت ڕاستەوخۆ بە دوگمەی Google بچیتەژوورەوە.',
    googleConnectHint: 'دەربچۆ و بە هەمان ئیمەیلی پشتڕاستکراو دوگمەی Google بەکاربهێنە بۆ بەستنەوەی.',
    unlinkNote: 'لابردنی بەستنەوە لێرە بەردەست نییە — ڕێگەیەکی نییە، بۆیە ناتوانیت بە هەڵە دوا ڕێگای چوونەژوورەوەت لەدەست بدەیت.',
    addressesRow: 'ناونیشانەکانم', addressesCount: 'ناونیشانە پاشەکەوتکراوەکان: {n}',
    addressesDefault: 'ناونیشانی بنەڕەت: {label}', addressesNone: 'هێشتا ناونیشانێک پاشەکەوت نەکراوە.',
    approvedYes: 'ناونیشانی پەسەندکراوی PRO هەیە (کۆپییەکی جێگیر).',
    approvedNo: 'ناونیشانی پەسەندکراوی PRO نییە.',
    approvedNote: 'ناونیشانی پەسەندکراو کۆپییەکی جێگیرە: دەستکاری ناونیشانی پاشەکەوتکراو ناگۆڕێت. گۆڕینی کۆپییە پەسەندکراوەکە بە داواکاری پشتگیری و ڕەزامەندی بەڕێوەبەرایەتی دەبێت؛ ناونیشانی جێگرەوە نرخی ئاسایی وەردەگرێت بەبێ هەڵوەشاندنەوەی بەشداریت.',
    language: 'زمان', direction: 'ئاراستەی پەڕە', rtl: 'ڕاست بۆ چەپ', ltr: 'چەپ بۆ ڕاست',
    langSaved: 'زمان لە هەژمارەکەت پاشەکەوتکرا.', langSaveFailed: 'نەتوانرا زمان لەسەر ڕاژەکار پاشەکەوت بکرێت — تەنها بۆ ئەم وێبگەڕە جێبەجێ دەبێت.',
    currency: 'دراو', currencyNote: 'دەفتەری فرۆشگا و داواکارییەکان بە دیناری عێراقییە. ڕێکخستنی دراوی پیشاندان بۆ هەر هەژمارێک نییە، و هیچ داواکارییەکی پەسەندکراو دووبارە نرخ نادرێت.',
    pushTitle: 'ئاگادارکردنەوەی وێبگەڕ (Web Push)',
    pushUnsupported: 'لەم وێبگەڕەدا پشتگیری نەکراوە', pushBlocked: 'لە ڕێکخستنی وێبگەڕ ڕێگری کراوە',
    pushGranted: 'مۆڵەتی وێبگەڕ دراوە', pushOff: 'مۆڵەتی وێبگەڕ نەدراوە',
    pushAsk: 'داواکردنی مۆڵەتی وێبگەڕ',
    pushHonesty: 'دانی مۆڵەت تەنها وێبگەڕەکەت ئامادە دەکات. هێشتا خزمەتگوزاری ناردنی Web Push لە لای ئێمە نییە، بۆیە هەرگیز «چالاککرا» پیشان نادەین.',
    emailNotifTitle: 'ئاگادارکردنەوەی ئیمەیل',
    emailNotifNote: 'تەنها نامەی ئاسایشی هەژمار و پسووڵەی داواکاری، بۆ ئیمەیلێکی پشتڕاستکراو دەنێردرێت. ئاگادارکردنەوەی جزدان ڕێگایەکی جیایە. هیچ نامەی بازرگانی نییە.',
    tgNotifNote: 'تێلێگرام بۆ پشتڕاستکردنەوە و کۆدی ئاسایش بەکاردێت دوای بەستنەوە لە بەشی سەرەوە.',
    policies: 'سیاسەت و مەرجەکان', support: 'پشتگیری و یارمەتی',
    closure: 'داخستنی هەژمار', closureNote: 'دوگمەی سڕینەوەی خێرا نییە: باڵانس، داواکارییەکان و تۆمارە پێویستەکان بە کلیکێک ناسڕدرێنەوە. داواکاری داخستن لە ڕێگەی پشتگیری بنێرە تا باڵانس یەکلایی بکرێتەوە.',
    signOut: 'چوونەدەرەوە', signingOut: 'دەچیتە دەرەوە…',
    save: 'پاشەکەوت', saving: 'پاشەکەوت دەکرێت…', saved: 'پاشەکەوتکرا',
    unsaved: 'گۆڕانکاری پاشەکەوتنەکراوت هەیە.',
    guestTitle: 'بچۆ ژوورەوە بۆ بەڕێوەبردنی ڕێکخستنەکانت',
    signIn: 'چوونەژوورەوە',
    loading: 'بار دەکرێت…', retry: 'دووبارە هەوڵ بدەوە', loadFailed: 'ئەم بەشە بار نەبوو.',
    notAvailable: 'بەردەست نییە',
  },
} as const;

type PushStatus = 'unsupported' | 'blocked' | 'granted' | 'off';

function getPushStatus(): PushStatus {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'blocked';
  return 'off';
}

interface EmailStatus {
  email: string;
  verified: boolean;
  emailConfigured: boolean;
}

interface AddressRow {
  id: string;
  label: string;
  is_default: number;
  backs_approved_snapshot?: boolean;
}

interface AddressesResponse {
  addresses: AddressRow[];
  approved_snapshot: { version: number; source_address_id: string | null } | null;
}

// --------------------------------------------------------------- primitives

function SectionCard({
  title,
  icon,
  children,
  id,
  bare = false,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  /** An anchor, for a link that scrolls to this section («توثيق رقمي»). */
  id?: string;
  /**
   * The section's children ALREADY carry their own surfaces — the linking
   * section is two independent provider cards, not a list of rows — so the
   * shared surface would draw a box around two boxes. They still get the same
   * heading and the same rhythm, which is the whole point of passing through
   * here rather than hand-rolling a seventh look.
   */
  bare?: boolean;
}) {
  return (
    // `break-inside-avoid` is what makes the two-column layout below a set of
    // whole cards rather than a magazine that splits «الأمان» down the middle.
    // `scrollMarginTop` clears the fixed header for an anchored jump.
    <section id={id} className="mb-7 break-inside-avoid" style={id ? { scrollMarginTop: '72px' } : undefined}>
      <h2 className="text-text-muted text-xs font-bold uppercase tracking-[0.08em] mb-2 ms-1 flex items-center gap-2">
        {icon}
        {title}
      </h2>
      {bare ? (
        <div className="space-y-3">{children}</div>
      ) : (
        <div className="lv-surface overflow-hidden divide-y divide-border-subtle/70">{children}</div>
      )}
    </section>
  );
}

function NavRow({
  label, description, icon, onClick, to, dirIsRtl,
}: {
  label: string; description?: string; icon: React.ReactNode;
  onClick?: () => void; to?: string; dirIsRtl: boolean;
}) {
  const Chevron = dirIsRtl ? ChevronLeft : ChevronRight;
  const content = (
    <>
      <span className="flex items-center gap-3 min-w-0">
        <span className="text-zinc-300 shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="block font-bold text-[15px] text-white truncate">{label}</span>
          {description ? <span className="block text-[12px] text-zinc-400">{description}</span> : null}
        </span>
      </span>
      <Chevron aria-hidden="true" className="w-5 h-5 text-zinc-500 shrink-0" />
    </>
  );
  const cls =
    'w-full min-h-14 flex items-center justify-between gap-3 px-4 py-3 text-start hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus transition-colors';
  if (to) {
    return (
      <Link to={to} className={cls}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {content}
    </button>
  );
}

function DisabledRow({ label, reason, icon, note }: { label: string; reason: string; icon: React.ReactNode; note: string }) {
  return (
    <div className="px-4 py-3 opacity-80">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-3 min-w-0">
          <span className="text-zinc-500 shrink-0">{icon}</span>
          <span className="font-bold text-[15px] text-zinc-300 truncate">{label}</span>
        </span>
        <span className="text-[12px] text-zinc-500 shrink-0">{note}</span>
      </div>
      <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{reason}</p>
    </div>
  );
}

/**
 * «بعض الإعدادات لا تعمل مثل تحقق من الجلسات» — IT WORKS NOW.
 *
 * The row here said «لا يوفّر الخادم واجهة لعرض الجلسات أو إنهائها فرديًا بعد»
 * and offered, as the real alternative, CHANGING YOUR PASSWORD. That sentence
 * was honest and it had been true since the first commit — while the
 * `sessions` table has held one row per sign-in the whole time, carrying
 * `created_at`, `expires_at` and a `user_agent` nothing had ever read. The
 * data to answer «مَن داخل على حسابي؟» was there; only the endpoint was not.
 * It is `GET /api/auth/sessions` now, with a per-row revoke.
 *
 * THE DEVICE NAME IS DERIVED HERE, NOT ON THE SERVER. A user-agent string is
 * an implementation detail of whatever browser shipped last month, and
 * matching on it is guesswork that goes stale; doing that guessing in the
 * client keeps the server a plain record of what was sent, and keeps a bad
 * guess from being written anywhere. When the guess fails the row says «جهاز
 * غير معروف» and still shows the dates — an honest unknown beats a confident
 * wrong name on a screen whose entire job is «do I recognise this?».
 */
function deviceName(ua: string): string {
  const s = ua || '';
  const os =
    /iPad/i.test(s) ? 'iPad'
    : /iPhone/i.test(s) ? 'iPhone'
    : /Android/i.test(s) ? 'Android'
    : /Macintosh|Mac OS X/i.test(s) ? 'Mac'
    : /Windows/i.test(s) ? 'Windows'
    : /Linux/i.test(s) ? 'Linux'
    : '';
  // Order matters: Edge and Chrome both say "Chrome", Chrome says "Safari".
  const browser =
    /Edg\//i.test(s) ? 'Edge'
    : /OPR\/|Opera/i.test(s) ? 'Opera'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Safari\//i.test(s) ? 'Safari'
    : '';
  return [os, browser].filter(Boolean).join(' · ');
}

function SessionsPanel({
  s,
  lang,
}: {
  s: { sessionsIntro: string; sessionsThisDevice: string; sessionsSince: string; sessionsUntil: string;
       sessionsEnd: string; sessionsEndOthers: string; sessionsOnlyThis: string; sessionsEnded: string;
       sessionsEndedOthers: string; sessionsFailed: string; sessionsUnknownDevice: string };
  lang: string;
}) {
  const [sessions, setSessions] = useState<ApiSession[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await listSessions();
      setSessions(res.sessions);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : s.sessionsFailed);
    }
  }, [s.sessionsFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString(lang === 'ar' ? 'ar-IQ' : lang === 'ckb' ? 'ar-IQ' : 'en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
  };

  const others = (sessions ?? []).filter((x) => !x.current).length;

  return (
    <div className="px-4 py-3" data-settings-sessions>
      <p className="text-[12px] text-zinc-500 leading-relaxed">{s.sessionsIntro}</p>

      {error ? (
        <p role="alert" className="lv-alert lv-alert-warning mt-2 text-xs">{error || s.sessionsFailed}</p>
      ) : null}
      {msg ? (
        <p className="mt-2 text-[12px] text-success">{msg}</p>
      ) : null}

      {sessions === null && !error ? (
        <div className="mt-3 space-y-2" aria-hidden="true">
          <div className="h-12 rounded-lg bg-surface-raised animate-pulse" />
          <div className="h-12 rounded-lg bg-surface-raised animate-pulse" />
        </div>
      ) : null}

      {sessions ? (
        <ul className="mt-3 space-y-2">
          {sessions.map((row) => {
            const name = deviceName(row.user_agent) || s.sessionsUnknownDevice;
            return (
              <li
                key={row.id}
                data-session-row
                data-session-current={row.current ? 'true' : 'false'}
                className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] font-bold text-text-primary truncate">{name}</span>
                    {row.current ? (
                      <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-bold text-success">
                        {s.sessionsThisDevice}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-text-muted tabular-nums">
                    {s.sessionsSince} {when(row.created_at)} · {s.sessionsUntil} {when(row.expires_at)}
                  </span>
                </span>
                {/* The CURRENT session has no End button, and that is not an
                    omission: ending it here would leave this page holding a
                    dead cookie with no sign-out having happened. «تسجيل
                    الخروج» at the foot of the page is that control. */}
                {row.current ? null : (
                  <button
                    type="button"
                    disabled={busy !== ''}
                    onClick={async () => {
                      setBusy(row.id);
                      setMsg('');
                      try {
                        await revokeSession(row.id);
                        setMsg(s.sessionsEnded);
                        await load();
                      } catch (err) {
                        setError(err instanceof ApiError ? err.message : s.sessionsFailed);
                      } finally {
                        setBusy('');
                      }
                    }}
                    className="lv-button lv-button-secondary lv-button-sm shrink-0 disabled:opacity-50"
                  >
                    {s.sessionsEnd}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {sessions && others === 0 ? (
        <p className="mt-2 text-[12px] text-zinc-500">{s.sessionsOnlyThis}</p>
      ) : null}

      {sessions && others > 0 ? (
        <button
          type="button"
          disabled={busy !== ''}
          data-sessions-revoke-others
          onClick={async () => {
            setBusy('all');
            setMsg('');
            try {
              await revokeOtherSessions();
              setMsg(s.sessionsEndedOthers);
              await load();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : s.sessionsFailed);
            } finally {
              setBusy('');
            }
          }}
          className="lv-button lv-button-secondary lv-button-sm mt-3 disabled:opacity-50"
        >
          {s.sessionsEndOthers}
        </button>
      ) : null}
    </div>
  );
}

function Field({
  label, type = 'text', value, onChange, autoComplete, placeholder,
}: {
  label: string; type?: string; value: string; onChange: (v: string) => void;
  autoComplete?: string; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-zinc-300 text-[13px] font-bold mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="lv-input text-sm"
      />
    </label>
  );
}

// ---------------------------------------------------------------- component

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout, refreshUser } = useAuth();
  const { lang, setLang, dir, t } = useLanguage();
  const s = STRINGS[lang];
  const rtl = dir === 'rtl';

  // The install row's copy lives in `src/translations.ts` rather than in this
  // file's own STRINGS table, because the same sentences are read by the
  // sheet and by the button — three places, one source. Everything else on
  // this page keeps using `s`.
  const { standalone: appInstalled } = useInstallApp();

  // Whether the DEPLOYMENT has a WhatsApp provider at all. Not whether the
  // shop's WhatsApp session is currently linked — only a live provider call
  // can answer that, and this cached public endpoint deliberately does not
  // make one. The row below says what it can honestly say.
  const whatsappConfigured = useCapabilities()?.whatsappOtp ?? false;

  const [signingOut, setSigningOut] = useState(false);

  // ---- email / verification (real reads)
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [emailStatusError, setEmailStatusError] = useState<string>('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState('');

  // ---- change email
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailFormError, setEmailFormError] = useState('');
  const [emailFormBusy, setEmailFormBusy] = useState(false);
  const emailLock = useRef(false);

  // ---- change password
  const [showPwForm, setShowPwForm] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const pwLock = useRef(false);

  // ---- addresses summary (real read)
  const [addresses, setAddresses] = useState<AddressesResponse | null>(null);
  const [addressesError, setAddressesError] = useState('');

  // ---- language save
  const [langBusy, setLangBusy] = useState(false);
  const [langMsg, setLangMsg] = useState('');
  const [langError, setLangError] = useState('');

  const [pushStatus, setPushStatus] = useState<PushStatus>(getPushStatus);

  const loadEmailStatus = useCallback(async () => {
    setEmailStatusError('');
    try {
      const res = await api.get<EmailStatus>('/api/auth/verify-email/status');
      setEmailStatus(res);
    } catch (err) {
      setEmailStatus(null);
      setEmailStatusError(err instanceof ApiError ? err.message : s.loadFailed);
    }
  }, [s.loadFailed]);

  const loadAddresses = useCallback(async () => {
    setAddressesError('');
    try {
      const res = await api.get<AddressesResponse>('/api/addresses');
      setAddresses({ addresses: res.addresses || [], approved_snapshot: res.approved_snapshot ?? null });
    } catch (err) {
      setAddresses(null);
      setAddressesError(err instanceof ApiError ? err.message : s.loadFailed);
    }
  }, [s.loadFailed]);

  useEffect(() => {
    if (!user) return;
    void loadEmailStatus();
    void loadAddresses();
  }, [user, loadEmailStatus, loadAddresses]);

  // Unsaved-changes guard for the two security forms.
  const dirty =
    (showPwForm && (pwCurrent || pwNext || pwConfirm)) || (showEmailForm && (newEmail || emailPassword));
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const sendVerification = async () => {
    if (emailBusy) return;
    setEmailBusy(true);
    setEmailMsg('');
    try {
      await api.post('/api/auth/verify-email/send');
      setEmailMsg(s.verifySent);
    } catch (err) {
      setEmailMsg(err instanceof ApiError ? err.message : s.loadFailed);
    } finally {
      setEmailBusy(false);
      void loadEmailStatus();
    }
  };

  const submitEmailChange = async () => {
    if (emailLock.current) return;
    setEmailFormError('');
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(newEmail.trim())) {
      setEmailFormError(s.emailFormInvalid);
      return;
    }
    emailLock.current = true;
    setEmailFormBusy(true);
    try {
      const res = await api.post<{ message?: string }>('/api/auth/change-email', {
        newEmail: newEmail.trim(),
        currentPassword: emailPassword,
        lang,
      });
      // The address is NOT changed yet — only a confirmation was requested.
      setEmailMsg(res.message || s.changeEmailNote);
      setNewEmail('');
      setEmailPassword('');
      setShowEmailForm(false);
    } catch (err) {
      // Failure recovery: the typed values stay so nothing is retyped.
      setEmailFormError(err instanceof ApiError ? err.message : s.loadFailed);
    } finally {
      emailLock.current = false;
      setEmailFormBusy(false);
    }
  };

  const submitPasswordChange = async () => {
    if (pwLock.current) return;
    setPwError('');
    setPwMsg('');
    if (pwNext.length < PASSWORD_MIN) {
      setPwError(s.pwMin);
      return;
    }
    if (pwNext !== pwConfirm) {
      setPwError(s.pwMismatch);
      return;
    }
    pwLock.current = true;
    setPwBusy(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword: pwCurrent, newPassword: pwNext });
      setPwMsg(s.pwChanged);
      setPwCurrent('');
      setPwNext('');
      setPwConfirm('');
      setShowPwForm(false);
      // The server rotated this device's session — resync the user object.
      await refreshUser();
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : s.loadFailed);
    } finally {
      pwLock.current = false;
      setPwBusy(false);
    }
  };

  const chooseLanguage = async (next: 'ar' | 'en' | 'ckb') => {
    setLang(next); // instant UI change (also stored per browser)
    setLangMsg('');
    setLangError('');
    if (!user || langBusy) return;
    setLangBusy(true);
    try {
      await api.patch('/api/profile', { locale: next });
      await refreshUser();
      setLangMsg(s.langSaved);
    } catch {
      setLangError(s.langSaveFailed);
    } finally {
      setLangBusy(false);
    }
  };

  const requestPush = async () => {
    if (pushStatus === 'unsupported' || pushStatus === 'blocked' || pushStatus === 'granted') return;
    await Notification.requestPermission();
    setPushStatus(getPushStatus());
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      navigate('/auth');
    } finally {
      setSigningOut(false);
    }
  };

  const pushLabel =
    pushStatus === 'unsupported'
      ? s.pushUnsupported
      : pushStatus === 'blocked'
        ? s.pushBlocked
        : pushStatus === 'granted'
          ? s.pushGranted
          : s.pushOff;

  const avatarUrl = user?.avatar_key
    ? `/files/${user.avatar_key}`
    : `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(user?.username || user?.name || 'guest')}`;

  const defaultAddress = addresses?.addresses.find((a) => a.is_default) ?? null;

  return (
    <div className="w-full flex-1 h-full overflow-y-auto bg-canvas text-text-primary font-sans" dir={dir}>
      <div className="sticky top-0 z-20 bg-canvas/96 backdrop-blur px-3 sm:px-4 py-2 flex items-center gap-3 border-b border-border-subtle/70">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={s.back}
          className="w-11 h-11 flex items-center justify-center rounded-md hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus transition-colors"
        >
          {rtl ? <ChevronRight aria-hidden="true" className="w-5 h-5" /> : <ChevronLeft aria-hidden="true" className="w-5 h-5" />}
        </button>
        <h1 className="text-[18px] font-bold">{s.title}</h1>
        {/* THE PAGE OWNS ITS BLOUB SLOT, SO THE SHELL STOPS RESERVING ONE.
            MotionCharacterFallbackHeader returns null the moment any page
            anchor is registered; without this the shell printed a second
            60-72px strip ABOVE this bar on every full-screen route, and the
            settings list started a whole header lower than it should. One bar,
            with the character living at its trailing edge. */}
        <div className="ms-auto shrink-0">
          <MotionCharacterHome kind="top-header" compact />
        </div>
      </div>

      <div className="px-3 sm:px-4 py-5 max-w-xl md:max-w-4xl mx-auto pb-[max(4rem,env(safe-area-inset-bottom))]">
        {!user ? (
          <div className="lv-surface p-6 text-center">
            <p className="text-text-primary font-bold mb-3">{s.guestTitle}</p>
            <Link
              to={`/auth?next=${encodeURIComponent('/settings')}`}
              className="lv-button lv-button-primary"
            >
              {s.signIn}
            </Link>
          </div>
        ) : (
          <>
            {/*
              §16 — SEVEN CARDS, IN THE ORDER THEY ARE USED, AND TWO ABREAST
              WHERE THERE IS ROOM.

              «الوضع في الإعدادات غير مناسب غير مرتب أعد الترتيب لتكون أنسب
               وأمتع بصريا — استخدم مهارات التصميم.»

              TWO THINGS WERE WRONG, and neither was any one control.

              THE SHAPE. Seven cards of wildly uneven height — security and
              notifications are over a hundred lines each, privacy is two rows
              — stacked in a 576px column. On the iPad this shop is run from
              that is a narrow ribbon with a quarter of the screen empty on
              each side and a very long scroll, and the two giants sat next to
              each other in it. They are laid out in two columns from `md` up,
              so the tablet reads as a page rather than a phone screen
              stretched, and each card refuses to break across the gap.

              THE ORDER. It ran account, security, linking, addresses,
              preferences, notifications — front-loading the things a person
              sets up ONCE and burying the things they come back to change.
              Language, currency and theme are the most-visited settings in a
              trilingual shop, so preferences sit second, with addresses under
              them; the one-time setup (security, linking) follows; the
              channels come after that, and help is last, where help belongs.

              The eight blocks keep their own comments and every control is
              untouched — this is a reorder and a layout, not a rewrite.
            */}
            <div className="md:columns-2 md:gap-x-5">
            {/* -------------------------------------------- 1. Account */}
            <SectionCard title={s.secAccount} icon={<User aria-hidden="true" className="w-4 h-4" />}>
              <Link
                to="/edit-profile"
                className="flex items-center gap-3 px-4 py-4 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus transition-colors"
              >
                <img
                  referrerPolicy="no-referrer"
                  src={avatarUrl}
                  alt=""
                  aria-hidden="true"
                  className="w-12 h-12 rounded-full object-cover bg-zinc-800 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-bold text-[15px] truncate">{user.username || user.name || s.guest}</span>
                  <span className="block text-[12px] text-zinc-400 truncate">{user.email}</span>
                </span>
                <span className="text-[12px] text-text-secondary font-bold shrink-0">{s.editProfile}</span>
              </Link>
              <div className="px-4 py-3">
                <p className="text-[12px] text-zinc-400 leading-relaxed">{s.accountRow}</p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.usernameNote}</p>
              </div>
            </SectionCard>

            {/* ---------------------------------------- 2. Preferences */}
            <SectionCard title={s.secPrefs} icon={<Globe aria-hidden="true" className="w-4 h-4" />}>
              <div className="px-4 py-3">
                <p className="font-bold text-[15px] mb-2">{s.language}</p>
                <div className="flex gap-2 flex-wrap">
                  {([
                    ['ar', 'العربية'],
                    ['en', 'English'],
                    ['ckb', 'کوردیی ناوەندی'],
                  ] as const).map(([code, label]) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => void chooseLanguage(code)}
                      disabled={langBusy}
                      aria-pressed={lang === code}
                      data-selected={lang === code}
                      className="lv-choice min-h-11 px-4 text-sm font-bold disabled:opacity-60"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[12px] text-zinc-500">
                  {s.direction}: {rtl ? s.rtl : s.ltr}
                </p>
                {langBusy ? <p className="mt-1 text-[12px] text-zinc-400">{s.saving}</p> : null}
                {langMsg ? <p className="mt-1 text-[12px] text-emerald-300">{langMsg}</p> : null}
                {langError ? <p className="mt-1 text-[12px] text-amber-300">{langError}</p> : null}
              </div>
              <div className="px-4 py-3">
                <p className="font-bold text-[15px] flex items-center gap-2">
                  <Coins aria-hidden="true" className="w-4 h-4 text-zinc-400" />
                  {s.currency}
                </p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.currencyNote}</p>
              </div>
              {/*
                «تحميل التطبيق» BELONGS IN PREFERENCES, and specifically here.

                It is a device-and-browser preference with no order and no
                security consequence — the same kind of thing as the language
                and the currency rows above it — and it sits immediately
                before the Web Push block, which is its nearest relative in
                both shape and honesty.

                IT STATES ITS REAL STATE, like every other row on this page.
                When the shop is already running as an installed app the
                control disappears and the row says so, because a button that
                installs something already installed is the "control with no
                effect" this file's header removed the Appearance row for. The
                button itself hides on the same condition; the check is
                repeated here so the row does not become a title and a
                paragraph with nothing under them.
              */}
              <div className="px-4 py-3">
                <p className="font-bold text-[15px] flex items-center gap-2">
                  <Download aria-hidden="true" className="w-4 h-4 text-zinc-400" />
                  {t('pwaInstallTitle')}
                </p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{t('pwaSettingsNote')}</p>
                {appInstalled ? (
                  <p className="mt-2 text-[12px] text-success">{t('pwaInstallDone')}</p>
                ) : (
                  <InstallAppButton />
                )}
              </div>
            </SectionCard>

            {/* ------------------------------------------ 3. Addresses */}
            <SectionCard title={s.secAddresses} icon={<MapPin aria-hidden="true" className="w-4 h-4" />}>
              <NavRow
                label={s.addressesRow}
                description={
                  addresses
                    ? addresses.addresses.length === 0
                      ? s.addressesNone
                      : `${s.addressesCount.replace('{n}', String(addresses.addresses.length))}${
                          defaultAddress ? ` · ${s.addressesDefault.replace('{label}', defaultAddress.label)}` : ''
                        }`
                    : addressesError || s.loading
                }
                icon={<MapPin aria-hidden="true" className="w-5 h-5" />}
                to="/addresses"
                dirIsRtl={rtl}
              />
              <div className="px-4 py-3">
                <p className="text-[12px] text-zinc-300">
                  {addresses ? (addresses.approved_snapshot ? s.approvedYes : s.approvedNo) : s.loading}
                </p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.approvedNote}</p>
                {addressesError ? (
                  <button type="button" onClick={() => void loadAddresses()} className="mt-2 text-[12px] text-gold font-bold min-h-[44px]">
                    {s.retry}
                  </button>
                ) : null}
              </div>
            </SectionCard>

            {/* ------------------------------------------- 4. Security */}
            <SectionCard title={s.secSecurity} icon={<ShieldCheck aria-hidden="true" className="w-4 h-4" />}>
              {/* Email verification — real status */}
              <div className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-3 min-w-0">
                    <Mail aria-hidden="true" className="w-5 h-5 text-zinc-300 shrink-0" />
                    <span className="min-w-0">
                      <span className="block font-bold text-[15px]">{s.email}</span>
                      <span className="block text-[12px] text-zinc-400 truncate">{emailStatus?.email ?? user.email}</span>
                    </span>
                  </span>
                  {emailStatus ? (
                    <span
                      className={`shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-full ${
                        emailStatus.verified
                          ? 'text-success bg-success/10'
                          : 'text-warning bg-warning/10'
                      }`}
                    >
                      {emailStatus.verified ? s.emailVerified : s.emailUnverified}
                    </span>
                  ) : emailStatusError ? (
                    <button type="button" onClick={() => void loadEmailStatus()} className="text-[12px] text-gold font-bold">
                      {s.retry}
                    </button>
                  ) : (
                    <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin text-zinc-500" />
                  )}
                </div>

                {emailStatus && !emailStatus.emailConfigured ? (
                  <p className="lv-alert lv-alert-warning mt-2 text-xs">
                    {s.emailNotConfigured}
                  </p>
                ) : null}

                {emailStatus && emailStatus.emailConfigured && !emailStatus.verified ? (
                  <button
                    type="button"
                    onClick={sendVerification}
                    disabled={emailBusy}
                    className="lv-button lv-button-secondary mt-2"
                  >
                    {emailBusy ? s.sending : s.sendVerify}
                  </button>
                ) : null}

                {emailStatus?.emailConfigured ? (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setShowEmailForm((v) => !v)}
                      aria-expanded={showEmailForm}
                      className="lv-button lv-button-ghost px-0 text-[13px]"
                    >
                      {s.changeEmail}
                    </button>
                    {showEmailForm ? (
                      <div className="mt-2 space-y-2">
                        <Field label={s.newEmail} type="email" value={newEmail} onChange={setNewEmail} autoComplete="email" />
                        <Field
                          label={s.currentPassword}
                          type="password"
                          value={emailPassword}
                          onChange={setEmailPassword}
                          autoComplete="current-password"
                        />
                        <p className="text-[12px] text-zinc-500">{s.changeEmailNote}</p>
                        {emailFormError ? (
                          <p role="alert" className="lv-alert lv-alert-danger text-xs">
                            {emailFormError}
                          </p>
                        ) : null}
                        <button
                          type="button"
                          onClick={submitEmailChange}
                          disabled={emailFormBusy}
                          className="lv-button lv-button-primary w-full"
                        >
                          {emailFormBusy ? s.saving : s.save}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {emailMsg ? (
                  <p className="lv-alert lv-alert-info mt-2 text-xs">{emailMsg}</p>
                ) : null}
              </div>

              {/* Password */}
              <div className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => setShowPwForm((v) => !v)}
                  aria-expanded={showPwForm}
                  className="w-full min-h-[44px] flex items-center justify-between gap-3 text-start"
                >
                  <span className="flex items-center gap-3">
                    <KeyRound aria-hidden="true" className="w-5 h-5 text-zinc-300" />
                    <span className="font-bold text-[15px]">{s.changePassword}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className={`w-5 h-5 text-zinc-500 transition-transform ${showPwForm ? 'rotate-90' : ''}`} />
                </button>
                {showPwForm ? (
                  <div className="mt-2 space-y-2">
                    <Field label={s.currentPassword} type="password" value={pwCurrent} onChange={setPwCurrent} autoComplete="current-password" />
                    <Field label={s.newPassword} type="password" value={pwNext} onChange={setPwNext} autoComplete="new-password" />
                    <Field label={s.confirmPassword} type="password" value={pwConfirm} onChange={setPwConfirm} autoComplete="new-password" />
                    <p className="text-[12px] text-zinc-500">{s.pwMin}</p>
                    <p className="text-[12px] text-zinc-500">{s.pwOtherSessions}</p>
                    {pwError ? (
                      <p role="alert" className="lv-alert lv-alert-danger text-xs">
                        {pwError}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      onClick={submitPasswordChange}
                      disabled={pwBusy}
                      className="lv-button lv-button-primary w-full"
                    >
                      {pwBusy ? s.saving : s.save}
                    </button>
                  </div>
                ) : null}
                {pwMsg ? (
                  <p className="lv-alert lv-alert-success mt-2 text-xs flex items-center gap-2">
                    <Check aria-hidden="true" className="w-4 h-4" />
                    {pwMsg}
                  </p>
                ) : null}
                <p className="mt-2 text-[12px] text-zinc-500">{s.forgotPassword}</p>
                {dirty ? <p className="mt-1 text-[12px] text-amber-300">{s.unsaved}</p> : null}
              </div>

              {/* Sessions — a real list, with a real revoke. */}
              <div className="px-4 pt-3">
                <p className="font-bold text-[15px]">{s.sessionsRow}</p>
              </div>
              <SessionsPanel s={s} lang={lang} />
            </SectionCard>

            {/* -------------------------------------------- 5. Linking */}
            {/* IT IS A SectionCard NOW, like the other six. This one section
                hand-rolled its own heading and spacing, so on a page of seven
                identical cards exactly one looked different — which is a large
                part of «غير مرتب» for a page whose entire job is to look
                orderly. `id` and the scroll offset stay: «توثيق رقمي» on the
                WhatsApp row scrolls here by anchor. */}
            <SectionCard
              title={s.secLinking}
              icon={<Link2 aria-hidden="true" className="w-4 h-4" />}
              id="settings-linking"
              bare
            >
              <TelegramLink />
              {/* This row used to say "the API does not expose Google link
                  status, so this page cannot honestly show linked or not
                  linked" — an honest message about a gap that has now been
                  closed. `has_google` is a boolean on the user object; the
                  Google subject itself still never leaves the server. */}
              <div className="lv-surface overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-4">
                  <span className="text-zinc-400" aria-hidden="true">
                    <Link2 className="w-5 h-5" />
                  </span>
                  <span className="flex-1 text-[14px] font-semibold text-white">{s.google}</span>
                  {user?.has_google ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-[12px] font-bold text-success">
                      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                      {s.googleConnected}
                    </span>
                  ) : (
                    <span className="rounded-full bg-surface-raised px-3 py-1 text-[12px] font-semibold text-text-muted">
                      {s.googleNotConnected}
                    </span>
                  )}
                </div>
                <p className="px-4 pb-3 text-[12px] text-zinc-500 leading-relaxed">
                  {user?.has_google ? s.googleConnectedNote : s.googleConnectHint}
                </p>
                <p className="px-4 py-3 text-[12px] text-text-muted leading-relaxed border-t border-border-subtle/70">{s.unlinkNote}</p>
              </div>

              {/*
                «في لوحة الإعدادات في الربط لا يوجد خيار لربط ال WhatsApp».
                True, and the reason it was missing is the reason this row is
                shaped the way it is.

                THERE IS NOTHING TO LINK. Telegram and Google are ACCOUNTS
                this one is joined to, with a handshake each. WhatsApp is not:
                the shop sends through WasenderAPI from its own number, to the
                VERIFIED NUMBER already on this account — `phone_e164`, which
                migration 0013 only ever writes after Telegram contact
                verification. There is no WhatsApp handshake to offer, and
                drawing a «ربط واتساب» button that opened nothing would be the
                worst answer: a control with no effect.

                So the row reports the state instead of inventing an action,
                in the section the owner went looking in, and points at the
                Telegram link above — which is the thing that actually turns
                WhatsApp on. The same two states were already drawn in the
                notifications section; the strings are shared rather than
                restated, so the two can never come to disagree.

                Drawn only when the DEPLOYMENT has a provider: without one,
                this is not a channel the customer can reach at all, and the
                notifications section already says so once.
              */}
              {whatsappConfigured ? (
                <div className="lv-surface overflow-hidden" data-linking-whatsapp>
                  <div className="flex items-center gap-3 px-4 py-4">
                    <span className="text-zinc-400" aria-hidden="true">
                      <Link2 className="w-5 h-5" />
                    </span>
                    <span className="flex-1 text-[14px] font-semibold text-white">{s.notifWhatsapp}</span>
                    <span
                      className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-bold ${
                        user?.has_phone ? 'text-success bg-success/10' : 'text-warning bg-warning/10'
                      }`}
                    >
                      {user?.has_phone ? s.waReady : s.waNeedsPhone}
                    </span>
                  </div>
                  <p className="px-4 pb-3 text-[12px] text-zinc-500 leading-relaxed">
                    {user?.has_phone ? s.waReadyNote : s.waNeedsPhoneNote}
                  </p>
                  {user?.has_phone ? (
                    <p className="px-4 pb-4 text-[12px] text-zinc-500" dir="ltr">{user.phone}</p>
                  ) : null}
                </div>
              ) : null}
            </SectionCard>

            {/* -------------------------------------- 6. Notifications */}
            <SectionCard title={s.secNotifications} icon={<Bell aria-hidden="true" className="w-4 h-4" />}>
              <div className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-[15px]">{s.pushTitle}</span>
                  <span className="text-[12px] text-zinc-400 shrink-0">{pushLabel}</span>
                </div>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.pushHonesty}</p>
                {pushStatus === 'off' ? (
                  <button
                    type="button"
                    onClick={requestPush}
                    className="lv-button lv-button-secondary mt-2"
                  >
                    {s.pushAsk}
                  </button>
                ) : null}
              </div>
              {/*
                EACH CHANNEL SAYS WHETHER IT CAN ACTUALLY REACH YOU, AND
                CARRIES THE CONTROL THAT FIXES IT.

                These three rows used to be prose: "email notifications are
                sent to a verified address", "Telegram is used after linking it
                from the Linking section above". Both sentences are TRUE and
                neither is usable — the reader is told a precondition and left
                to find the control themselves, which is the reported
                «غير مفعل». A channel row now shows its real state and takes
                you to the one thing that changes it.
              */}
              <div className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-[15px]">{s.emailNotifTitle}</span>
                  {emailStatus ? (
                    <span
                      className={`shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-full ${
                        emailStatus.verified ? 'text-success bg-success/10' : 'text-warning bg-warning/10'
                      }`}
                    >
                      {emailStatus.verified ? s.emailVerified : s.emailUnverified}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">
                  {emailStatus && !emailStatus.verified ? s.notifEmailNeedsVerify : s.notifEmailReady}
                </p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.emailNotifNote}</p>
                {/* The SAME action as the security section, offered where the
                    consequence is felt — an unverified address is exactly why
                    notifications do not arrive. */}
                {emailStatus && emailStatus.emailConfigured && !emailStatus.verified ? (
                  <button
                    type="button"
                    onClick={sendVerification}
                    disabled={emailBusy}
                    className="lv-button lv-button-secondary lv-button-sm mt-2"
                  >
                    {emailBusy ? s.sending : s.sendVerify}
                  </button>
                ) : null}
                {emailStatus && !emailStatus.emailConfigured ? (
                  <p className="lv-alert lv-alert-warning mt-2 text-xs">{s.emailNotConfigured}</p>
                ) : null}
              </div>

              {/* NO STATE PILL HERE, deliberately. A Telegram binding lives in
                  its own table (`telegram_links`) and is not on the user
                  object, so this row cannot know whether it is linked without
                  a second request — and <TelegramLink/> in the Linking section
                  already asks that question and shows the real answer. A pill
                  here would either duplicate that fetch or guess. The row says
                  what the channel is for and takes you to the control. */}
              <div className="px-4 py-3">
                <p className="font-bold text-[15px]">{s.telegram}</p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.tgNotifNote}</p>
                <a href="#settings-linking" className="lv-button lv-button-secondary lv-button-sm mt-2">
                  {s.notifGoTelegram}
                </a>
              </div>

              {/*
                WHATSAPP IS A REAL ROW NOW, and it has two honest states.

                It used to be a DisabledRow saying the channel needed a
                WhatsApp Business account and approved templates. That is no
                longer what it needs: the shop sends through WasenderAPI, from
                its own number. So the row reports the two things that
                actually decide whether a message arrives — whether the
                deployment has a provider at all, and whether THIS account has
                a verified number for it to reach.

                The number is the account's `phone_e164`, which migration 0013
                only ever writes after Telegram contact verification. So the
                fix for "needs a number" is the Telegram link in the section
                above, and the row points there rather than describing it.
              */}
              {!whatsappConfigured ? (
                <DisabledRow
                  label={s.notifWhatsapp}
                  reason={s.notifWhatsappWhy}
                  note={s.notAvailable}
                  icon={<Bell aria-hidden="true" className="w-5 h-5" />}
                />
              ) : (
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[15px]">{s.notifWhatsapp}</span>
                    <span
                      className={`shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-full ${
                        user?.has_phone ? 'text-success bg-success/10' : 'text-warning bg-warning/10'
                      }`}
                    >
                      {user?.has_phone ? s.waReady : s.waNeedsPhone}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">
                    {user?.has_phone ? s.waReadyNote : s.waNeedsPhoneNote}
                  </p>
                  {user?.has_phone ? (
                    <p className="mt-1 text-[12px] text-zinc-500" dir="ltr">
                      {user.phone}
                    </p>
                  ) : (
                    <a href="#settings-linking" className="lv-button lv-button-secondary lv-button-sm mt-2">
                      {s.waGoVerify}
                    </a>
                  )}
                </div>
              )}
            </SectionCard>

            {/* ----------------------------------- 7. Privacy and help */}
            <SectionCard title={s.secPrivacy} icon={<FileText aria-hidden="true" className="w-4 h-4" />}>
              <NavRow label={s.policies} icon={<FileText aria-hidden="true" className="w-5 h-5" />} to="/policies" dirIsRtl={rtl} />
              <NavRow label={s.support} icon={<LifeBuoy aria-hidden="true" className="w-5 h-5" />} to="/support" dirIsRtl={rtl} />
              <div className="px-4 py-3">
                <p className="font-bold text-[15px]">{s.closure}</p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.closureNote}</p>
              </div>
            </SectionCard>
            </div>



            {/* ------------------------------------------------- 8. Logout */}
            <div className="lv-surface overflow-hidden">
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="w-full min-h-14 flex items-center justify-between gap-3 px-4 py-3 hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-danger disabled:opacity-50 transition-colors"
              >
                <span className="flex items-center gap-3">
                  <LogOut aria-hidden="true" className="w-5 h-5 text-danger" />
                  <span className="font-bold text-[15px] text-danger">{signingOut ? s.signingOut : s.signOut}</span>
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
