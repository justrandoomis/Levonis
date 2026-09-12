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
 * HONESTLY DISABLED (no backend exists today — stated, not simulated):
 *  - Session/device list and "sign out other devices" as a standalone action:
 *    no endpoint enumerates or revokes sessions on demand.
 *  - Google link status: the API's public user object exposes no google_sub,
 *    so this page cannot claim linked/unlinked. (Linking itself exists at
 *    POST /api/auth/google/link but needs a Google credential flow.)
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
import { ChevronLeft, ChevronRight, User, MapPin, Bell, Globe, LogOut, ShieldCheck, Mail, KeyRound, Link2, FileText, LifeBuoy, Loader2, Check, AlertTriangle, Coins, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import TelegramLink from '../components/security/TelegramLink';

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
    changePassword: 'تغيير كلمة المرور', currentPassword: 'كلمة المرور الحالية',
    newPassword: 'كلمة المرور الجديدة', confirmPassword: 'تأكيد كلمة المرور',
    pwMin: `الحد الأدنى ${PASSWORD_MIN} أحرف.`, pwMismatch: 'كلمتا المرور غير متطابقتين.',
    pwChanged: 'تم تغيير كلمة المرور. سُجّل الخروج من الأجهزة الأخرى.',
    pwOtherSessions: 'تغيير كلمة المرور يُنهي جلسات كل الأجهزة الأخرى — وهذا هو المسار المدعوم لإخراج جهاز آخر.',
    forgotPassword: 'نسيت كلمة المرور؟ استخدم الاستعادة من صفحة الدخول.',
    sessionsRow: 'قائمة الجلسات والأجهزة',
    sessionsDisabled: 'لا يوفّر الخادم واجهة لعرض الجلسات أو إنهائها فرديًا بعد. المتاح فعليًا هو إنهاء الجلسات الأخرى عبر تغيير كلمة المرور.',
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
    changePassword: 'Change password', currentPassword: 'Current password',
    newPassword: 'New password', confirmPassword: 'Confirm password',
    pwMin: `Minimum ${PASSWORD_MIN} characters.`, pwMismatch: 'The passwords do not match.',
    pwChanged: 'Password changed. Other devices were signed out.',
    pwOtherSessions: 'Changing your password ends every other device session — that is the supported way to sign another device out.',
    forgotPassword: 'Forgot your password? Use recovery on the sign-in page.',
    sessionsRow: 'Sessions & devices list',
    sessionsDisabled: 'The server offers no endpoint to list or revoke individual sessions yet. What really works is ending other sessions by changing your password.',
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
    changePassword: 'گۆڕینی وشەی تێپەڕ', currentPassword: 'وشەی تێپەڕی ئێستا',
    newPassword: 'وشەی تێپەڕی نوێ', confirmPassword: 'دووبارەکردنەوەی وشەی تێپەڕ',
    pwMin: `لانیکەم ${PASSWORD_MIN} پیت.`, pwMismatch: 'وشە تێپەڕەکان وەک یەک نین.',
    pwChanged: 'وشەی تێپەڕ گۆڕدرا. ئامێرەکانی تر دەرچوون.',
    pwOtherSessions: 'گۆڕینی وشەی تێپەڕ هەموو دانیشتنەکانی ئامێرەکانی تر کۆتایی پێدەهێنێت — ئەمە ڕێگای پشتگیریکراوە بۆ دەرکردنی ئامێرێکی تر.',
    forgotPassword: 'وشەی تێپەڕت لەبیرچووە؟ لە پەڕەی چوونەژوورەوە گەڕاندنەوە بەکاربهێنە.',
    sessionsRow: 'لیستی دانیشتن و ئامێرەکان',
    sessionsDisabled: 'ڕاژەکار هێشتا ڕێگەیەک بۆ پیشاندان یان بەتاڵکردنی دانیشتنی تاک دابین ناکات. ئەوەی کاردەکات کۆتاییهێنانە بە دانیشتنەکانی تر بە گۆڕینی وشەی تێپەڕ.',
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

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="text-text-muted text-xs font-bold uppercase tracking-[0.08em] mb-2 ms-1 flex items-center gap-2">
        {icon}
        {title}
      </h2>
      <div className="lv-surface overflow-hidden divide-y divide-border-subtle/70">{children}</div>
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
  const { lang, setLang, dir } = useLanguage();
  const s = STRINGS[lang];
  const rtl = dir === 'rtl';

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
      setEmailFormError(s.newEmail);
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
      </div>

      <div className="px-3 sm:px-4 py-5 max-w-xl mx-auto pb-[max(4rem,env(safe-area-inset-bottom))]">
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
            {/* ------------------------------------------------ 1. Account */}
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

            {/* ----------------------------------------------- 2. Security */}
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

              {/* Sessions — honestly unavailable */}
              <DisabledRow
                label={s.sessionsRow}
                reason={s.sessionsDisabled}
                note={s.notAvailable}
                icon={<AlertTriangle aria-hidden="true" className="w-5 h-5" />}
              />
            </SectionCard>

            {/* ------------------------------------------------ 3. Linking */}
            <section className="mb-6">
              <h2 className="text-text-muted text-xs font-bold uppercase tracking-[0.08em] mb-2 ms-1 flex items-center gap-2">
                <Link2 aria-hidden="true" className="w-4 h-4" />
                {s.secLinking}
              </h2>
              <TelegramLink />
              {/* This row used to say "the API does not expose Google link
                  status, so this page cannot honestly show linked or not
                  linked" — an honest message about a gap that has now been
                  closed. `has_google` is a boolean on the user object; the
                  Google subject itself still never leaves the server. */}
              <div className="mt-3 lv-surface overflow-hidden">
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
            </section>

            {/* ---------------------------------------------- 4. Addresses */}
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

            {/* -------------------------------------------- 5. Preferences */}
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
            </SectionCard>

            {/* ------------------------------------------ 6. Notifications */}
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
              <div className="px-4 py-3">
                <p className="font-bold text-[15px]">{s.emailNotifTitle}</p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.emailNotifNote}</p>
                {emailStatus && !emailStatus.verified ? (
                  <p className="mt-1 text-[12px] text-amber-300">{s.emailUnverified}</p>
                ) : null}
              </div>
              <div className="px-4 py-3">
                <p className="font-bold text-[15px]">{s.telegram}</p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.tgNotifNote}</p>
              </div>
            </SectionCard>

            {/* --------------------------------------- 7. Privacy and help */}
            <SectionCard title={s.secPrivacy} icon={<FileText aria-hidden="true" className="w-4 h-4" />}>
              <NavRow label={s.policies} icon={<FileText aria-hidden="true" className="w-5 h-5" />} to="/policies" dirIsRtl={rtl} />
              <NavRow label={s.support} icon={<LifeBuoy aria-hidden="true" className="w-5 h-5" />} to="/support" dirIsRtl={rtl} />
              <div className="px-4 py-3">
                <p className="font-bold text-[15px]">{s.closure}</p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.closureNote}</p>
              </div>
            </SectionCard>

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
