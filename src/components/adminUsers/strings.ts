/**
 * Every word these screens say, in the three languages the store speaks.
 *
 * WHY `loc(ar, en, ckb)` AND NOT `dir === 'rtl' ? ar : en`. Kurdish (ckb) is
 * ALSO right-to-left. The direction test therefore serves ARABIC to a Kurdish
 * admin and calls it a translation — the site would look correct, read
 * correctly to the person who wrote it, and be wrong for every Kurdish user of
 * the panel. `loc` asks the language, which is the question that was always
 * being asked.
 *
 * Arabic is written first because Arabic is the source language: the owner
 * describes the feature in Arabic, and these sentences are their sentences.
 * The English is the working translation and the Kurdish follows it; where a
 * Kurdish string is omitted `loc` falls back to the Arabic rather than to
 * English, which is the closer language for this audience.
 */

import { useLanguage } from '../../LanguageContext';

export function useUsersStrings() {
  const { loc } = useLanguage();
  return {
    // ---------------------------------------------------------------- shell
    tabMembers: loc('الأعضاء', 'Members', 'ئەندامان'),
    tabAssistant: loc('صلاحية المساعد', 'Assistant access', 'دەسەڵاتی یاریدەدەر'),
    tabTelegram: loc('هويات تيليجرام', 'Telegram identities', 'ناسنامەی تێلێگرام'),
    sectionsLabel: loc('أقسام إدارة المستخدمين', 'User administration sections', 'بەشەکانی بەڕێوەبردنی بەکارهێنەران'),
    totalSuffix: loc('مستخدم', 'total', 'بەکارهێنەر'),
    searchPlaceholder: loc('البحث عن مستخدم...', 'Search users...', 'گەڕان بۆ بەکارهێنەر...'),
    noneFound: loc('لا يوجد مستخدمون مطابقون', 'No users found', 'هیچ بەکارهێنەرێک نەدۆزرایەوە'),
    loading: loc('جارٍ التحميل...', 'Loading...', 'بارکردن...'),
    close: loc('إغلاق', 'Close', 'داخستن'),
    cancel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
    save: loc('حفظ التغييرات', 'Save changes', 'پاشەکەوتکردن'),
    saving: loc('جارٍ الحفظ...', 'Saving...', 'پاشەکەوت دەکرێت...'),
    retry: loc('إعادة المحاولة', 'Retry', 'دووبارە هەوڵدان'),
    never: loc('لم يحدث', 'Never', 'هەرگیز'),
    none: loc('لا شيء', 'None', 'هیچ'),
    yes: loc('نعم', 'Yes', 'بەڵێ'),
    no: loc('لا', 'No', 'نەخێر'),

    // --------------------------------------------------------- member modal
    memberTitle: loc('ملف العضو', 'Member profile', 'پرۆفایلی ئەندام'),
    openMember: loc('فتح ملف العضو', 'Open member profile', 'کردنەوەی پرۆفایلی ئەندام'),
    editMember: loc('تعديل الصلاحيات والفئة', 'Edit role and plan', 'دەستکاری ڕۆڵ و پلان'),
    secIdentity: loc('الهوية والحساب', 'Identity and account', 'ناسنامە و هەژمار'),
    secMembership: loc('العضوية', 'Membership', 'ئەندامێتی'),
    secActivity: loc('النشاط والطلبات', 'Activity and orders', 'چالاکی و داواکاری'),
    secMoney: loc('الأرقام المالية', 'Financial figures', 'ژمارە داراییەکان'),
    secKyc: loc('حالة الهوية (KYC)', 'Identity verification (KYC)', 'پشتڕاستکردنەوەی ناسنامە (KYC)'),
    secAddress: loc('العنوان المعتمد', 'Approved address', 'ناونیشانی پەسەندکراو'),
    secChannels: loc('قنوات التنبيه', 'Notification channels', 'کەناڵەکانی ئاگادارکردنەوە'),
    secRestrictions: loc('القيود السارية', 'Standing restrictions', 'سنووردارکردنە بەردەوامەکان'),

    fRole: loc('الدور', 'Role', 'ڕۆڵ'),
    fState: loc('الحالة', 'State', 'دۆخ'),
    fReason: loc('السبب', 'Reason', 'هۆکار'),
    fSubmitted: loc('تاريخ التقديم', 'Submitted', 'ڕێکەوتی ناردن'),
    fVersion: loc('النسخة', 'Version', 'وەشان'),
    fCreated: loc('تاريخ الإنشاء', 'Created', 'ڕێکەوتی دروستکردن'),
    fApproved: loc('تاريخ الاعتماد', 'Approved', 'ڕێکەوتی پەسەندکردن'),
    fScope: loc('نطاق الأدمن', 'Admin scope', 'مەودای بەڕێوەبەر'),
    fEmail: loc('البريد', 'Email', 'ئیمەیل'),
    fUsername: loc('اسم المستخدم', 'Username', 'ناوی بەکارهێنەر'),
    fPhone: loc('الهاتف', 'Phone', 'تەلەفۆن'),
    fCountry: loc('الدولة', 'Country', 'وڵات'),
    fLocale: loc('اللغة', 'Language', 'زمان'),
    fEmailVerified: loc('تفعيل البريد', 'Email verified', 'ئیمەیل پشتڕاستکراوە'),
    fJoined: loc('تاريخ الانضمام', 'Joined', 'بەشداربوون'),
    fLastSeen: loc('آخر دخول مسجَّل', 'Last recorded sign-in', 'دوا چوونەژوورەوەی تۆمارکراو'),
    fLiveSessions: loc('جلسات فعّالة', 'Live sessions', 'دانیشتنی چالاک'),
    fTier: loc('الفئة', 'Tier', 'پلە'),
    fExpiry: loc('انتهاء الاشتراك', 'Subscription ends', 'کۆتایی بەشداریکردن'),
    fTermDays: loc('مدة الاشتراك', 'Term length', 'ماوەی بەشداری'),
    fInvestor: loc('مستثمر', 'Investor', 'وەبەرهێنەر'),
    fStreak: loc('أيام الحضور المتتالية', 'Check-in streak', 'زنجیرەی ئامادەبوون'),
    fOrders: loc('إجمالي الطلبات', 'Orders placed', 'کۆی داواکاری'),
    fDelivered: loc('مُسلَّمة', 'Delivered', 'گەیەنراو'),
    fOpen: loc('قيد التنفيذ', 'In progress', 'لە جێبەجێکردندا'),
    fCancelled: loc('ملغاة', 'Cancelled', 'هەڵوەشێندراوە'),
    fLastOrder: loc('آخر طلب', 'Last order', 'دوا داواکاری'),
    fLifetime: loc('القيمة الإجمالية للعميل', 'Lifetime value', 'بەهای تەواوی کڕیار'),
    fDeliveredValue: loc('قيمة الطلبات المُسلَّمة', 'Delivered value', 'بەهای گەیەنراو'),
    fWalletUsd: loc('رصيد المحفظة', 'Wallet balance', 'باڵانسی جزدان'),
    fWalletPoints: loc('النقاط', 'Points', 'خاڵ'),
    fBnplState: loc('حالة الدفع الآجل', 'BNPL state', 'دۆخی پارەدانی دواخراو'),
    fBnplLimit: loc('سقف الدفع الآجل', 'BNPL credit limit', 'سنووری قەرزی BNPL'),
    fBnplDue: loc('المستحق حاليًا', 'Currently outstanding', 'قەرزی ماوە'),

    lifetimeNote: loc(
      'القيمة الإجمالية = مجموع الطلبات غير الملغاة. القيمة المُسلَّمة هي الحد الأدنى المؤكَّد.',
      'Lifetime value is the sum of every order that was not cancelled; delivered value is the confirmed floor beneath it.',
      'بەهای تەواو کۆی ئەو داواکاریانەیە کە هەڵنەوەشێنراونەتەوە؛ بەهای گەیەنراو سنووری دڵنیایە.'
    ),
    lastSeenNote: loc(
      'يُحسب من الجلسات المحفوظة فقط — الجلسة المنتهية تُحذف، فالتاريخ حدٌّ أدنى وليس حقيقة مطلقة.',
      'Read from stored sessions only — an expired session is deleted, so this date is a floor, not an absolute fact.',
      'تەنها لە دانیشتنە پاشەکەوتکراوەکانەوە دێت — دانیشتنی بەسەرچوو دەسڕدرێتەوە.'
    ),
    moneyHidden: loc(
      'الأرقام المالية غير متاحة لحسابك. حسابك مقيَّد كمساعد أدمن، والخادم لا يُرسل هذه الأرقام أصلًا.',
      'Financial figures are not available to your account. You are a restricted assistant admin, and the server does not send these numbers at all.',
      'ژمارە داراییەکان بۆ هەژمارەکەت بەردەست نین — هەژمارەکەت وەک یاریدەدەر سنووردارکراوە.'
    ),
    noRestrictions: loc('لا قيود فعّالة على هذا الحساب', 'No standing restrictions on this account', 'هیچ سنووردارکردنێکی چالاک نییە'),
    noChannels: loc('لم يختر العضو أي قناة تنبيه', 'This member has chosen no notification channel', 'هیچ کەناڵێکی ئاگادارکردنەوە هەڵنەبژێردراوە'),
    noKyc: loc('لا توجد قضية هوية', 'No identity case', 'هیچ دۆسیەی ناسنامە نییە'),
    kycNote: loc(
      'تُعرض الحالة فقط — أدلة الهوية المشفّرة تُفتح حصريًا من واجهة مراجعة KYC.',
      'State only — the encrypted identity evidence opens exclusively from the KYC review surface.',
      'تەنها دۆخ — بەڵگە شیفرەکراوەکان تەنها لە ڕووکاری پێداچوونەوەی KYC دەکرێنەوە.'
    ),
    noAddress: loc('لا عنوان معتمد', 'No approved address', 'ناونیشانی پەسەندکراو نییە'),
    primaryChannel: loc('القناة الأساسية', 'Primary', 'سەرەکی'),
    channelOff: loc('موقوفة', 'Off', 'ناچالاک'),
    ownerBadge: loc('مالك الموقع', 'Site owner', 'خاوەنی ماڵپەڕ'),
    selfBadge: loc('حسابك', 'Your account', 'هەژماری تۆ'),
    assistantBadge: loc('مساعد أدمن', 'Assistant admin', 'یاریدەدەری بەڕێوەبەر'),
    fullBadge: loc('أدمن مالي كامل', 'Full financial admin', 'بەڕێوەبەری دارایی تەواو'),

    // ------------------------------------------------------ assistant grant
    grantTitle: loc('منح صلاحية مساعد أدمن بالبريد', 'Grant assistant admin access by email', 'دانی دەسەڵاتی یاریدەدەر بە ئیمەیل'),
    grantIntro: loc(
      'المساعد يدخل لوحة الإدارة ويدير المنتجات والطلبات والعملاء، ولا يرى أي رقم مالي.',
      'An assistant reaches the admin panel and runs products, orders and customers — and sees no financial number.',
      'یاریدەدەر دەچێتە پانێڵی بەڕێوەبردن و بەڕێوەبەری بەرهەم و داواکاریە، بەڵام هیچ ژمارەیەکی دارایی نابینێت.'
    ),
    canDo: loc('يستطيع المساعد', 'An assistant can', 'یاریدەدەر دەتوانێت'),
    cannotDo: loc('لا يستطيع المساعد', 'An assistant cannot', 'یاریدەدەر ناتوانێت'),
    canList: [
      loc('إدارة المنتجات والمخزون والأقسام', 'Manage products, stock and categories', 'بەڕێوەبردنی بەرهەم و کۆگا و بەشەکان'),
      loc('متابعة الطلبات والتوصيل والدعم', 'Run orders, delivery and support', 'بەدواداچوونی داواکاری و گەیاندن و پشتیوانی'),
      loc('مراجعة العملاء والعضويات والقيود', 'Review customers, memberships and restrictions', 'پێداچوونەوەی کڕیار و ئەندامێتی و سنوورەکان'),
    ],
    cannotList: [
      loc('رؤية التكلفة أو الربح أو سعر المورّد — في الواجهة أو في الـAPI أو في أي تصدير', 'See cost, profit or supplier price — in the UI, in the API or in any export', 'بینینی تێچوو یان قازانج یان نرخی دابینکەر'),
      loc('فتح لوحة المالية أو تقاريرها أو مصاريف التشغيل', 'Open the finance panel, its reports or operating expenses', 'کردنەوەی پانێڵی دارایی و ڕاپۆرتەکانی'),
      loc('رؤية القيمة الإجمالية للعميل أو رصيد المحفظة', 'See a member’s lifetime value or wallet balance', 'بینینی بەهای کڕیار یان باڵانسی جزدان'),
      loc('تعيين أو عزل أي أدمن، أو تغيير صلاحية مالية، أو تعديل حالة المستثمر', 'Appoint or remove any admin, change financial access, or set investor status', 'دانان یان لابردنی بەڕێوەبەر یان گۆڕینی دەسەڵاتی دارایی'),
    ],
    emailLabel: loc('البريد الإلكتروني للحساب', 'Account email address', 'ئیمەیلی هەژمار'),
    emailHint: loc(
      'مطابقة تامة للبريد المسجَّل — لا بحث جزئي، لأن منح اللوحة لحساب خاطئ يعني إدخال شخص غريب إليها.',
      'An exact match on the stored address — no partial search, because granting the panel to the wrong account puts a stranger inside it.',
      'یەکسانی تەواو لەگەڵ ئیمەیلی تۆمارکراو — گەڕانی بەشەکی نییە.'
    ),
    lookupBtn: loc('ابحث عن الحساب', 'Find the account', 'دۆزینەوەی هەژمار'),
    looking: loc('جارٍ البحث...', 'Searching...', 'گەڕان...'),
    confirmWho: loc('تأكَّد من الحساب قبل التغيير', 'Confirm the account before changing anything', 'دڵنیابە لە هەژمار پێش گۆڕان'),
    actGrant: loc('عيّن مساعدًا', 'Make assistant', 'کردن بە یاریدەدەر'),
    actLift: loc('ارفع القيد (صلاحية مالية كاملة)', 'Lift the restriction (full financial access)', 'لابردنی سنوور (دەسەڵاتی دارایی تەواو)'),
    actRemove: loc('اسحب صلاحية الأدمن', 'Remove admin access', 'لابردنی دەسەڵاتی بەڕێوەبەر'),
    grantDone: loc('تم تحديث الصلاحية', 'Access updated', 'دەسەڵات نوێکرایەوە'),
    confirmLift: loc(
      'رفع القيد يمنح هذا الحساب رؤية التكلفة والربح وكل الأرقام المالية. متأكد؟',
      'Lifting the restriction gives this account the cost, the profit and every financial number. Are you sure?',
      'لابردنی سنوور دەسەڵاتی دارایی تەواو دەدات. دڵنیایت؟'
    ),
    confirmRemove: loc(
      'سيفقد هذا الحساب الوصول إلى لوحة الإدارة بالكامل. متأكد؟',
      'This account will lose the admin panel entirely. Are you sure?',
      'ئەم هەژمارە بە تەواوی پانێڵی بەڕێوەبردن لەدەست دەدات. دڵنیایت؟'
    ),
    ownerLocked: loc(
      'حساب المالك لا يُقيَّد ولا يُعزل — هذه قاعدة في الخادم، لا خيار في الواجهة.',
      'The owner account can never be restricted or demoted — that is a server rule, not a UI choice.',
      'هەژماری خاوەن هەرگیز سنووردار ناکرێت — ئەمە یاسای ڕاژەیە.'
    ),
    selfLocked: loc('لا يمكنك سحب صلاحيتك من نفسك.', 'You cannot remove your own administrator role.', 'ناتوانیت دەسەڵاتی خۆت لابەریت.'),
    needFinancial: loc(
      'حسابك مقيَّد كمساعد، ولا يمكنه منح أو سحب صلاحيات الأدمن. هذا الإجراء للمالك أو للأدمن المالي فقط.',
      'Your account is a restricted assistant and cannot grant or revoke admin access. This is for the owner or a financial admin only.',
      'هەژمارەکەت سنووردارە و ناتوانێت دەسەڵات ببەخشێت.'
    ),

    // ------------------------------------------------------ telegram bridge
    tgTitle: loc('هويات تيليجرام الإدارية', 'Administrative Telegram identities', 'ناسنامە بەڕێوەبەرایەتیەکانی تێلێگرام'),
    tgIntro: loc(
      'هذه الهويات وحدها تسمح بالموافقة على إيصالات الدفع من البوت وبربط مواضيع المجموعة. العضوية في المجموعة لا تمنح شيئًا.',
      'These identities alone allow approving payment proofs from the bot and binding group topics. Being in the group grants nothing.',
      'تەنها ئەم ناسنامانە ڕێگە بە پەسەندکردنی پارەدان دەدەن.'
    ),
    tgIdLabel: loc('رقم تيليجرام العددي', 'Numeric Telegram id', 'ژمارەی تێلێگرام'),
    tgIdHint: loc(
      'الرقم العددي فقط. اسم المستخدم (@name) ليس هوية: يمكن تغييره وانتحاله، ولا يصلح لتفويض مالي.',
      'The numeric id only. A @username is not an identity: it is re-assignable and spoofable, and cannot carry financial authority.',
      'تەنها ژمارە. ناوی بەکارهێنەر (@) ناسنامە نییە.'
    ),
    tgIdNotUsername: loc(
      'أدخل الرقم العددي وليس @اسم_المستخدم.',
      'Enter the numeric id, not an @username.',
      'ژمارەکە بنووسە نەک @ناو.'
    ),
    tgLabelLabel: loc('وصف الهوية', 'Label', 'پێناسە'),
    tgLabelPlaceholder: loc('مثال: هاتف المالك', 'e.g. owner’s phone', 'نموونە: مۆبایلی خاوەن'),
    tgAdminLabel: loc('حساب الأدمن على الموقع (بالبريد)', 'The site admin account (by email)', 'هەژماری بەڕێوەبەر لە ماڵپەڕ'),
    tgAdminHint: loc(
      'يجب أن يكون الحساب أدمن على الموقع قبل الربط — الخادم يرفض غير ذلك.',
      'The account must already be a site admin — the server refuses anything else.',
      'دەبێت هەژمارەکە بەڕێوەبەری ماڵپەڕ بێت.'
    ),
    tgAdd: loc('اربط الهوية', 'Link identity', 'بەستنەوەی ناسنامە'),
    tgRevoke: loc('سحب', 'Revoke', 'لابردن'),
    tgRevokeReason: loc('سبب السحب (إلزامي)', 'Reason for revoking (required)', 'هۆکاری لابردن (پێویستە)'),
    tgActive: loc('فعّالة', 'Active', 'چالاک'),
    tgRevoked: loc('مسحوبة', 'Revoked', 'لابراو'),
    tgInactive: loc('غير فعّالة — الحساب لم يعد أدمن', 'Inactive — the account is no longer an admin', 'ناچالاک — هەژمار بەڕێوەبەر نییە'),
    tgEmpty: loc('لا توجد هويات مربوطة بعد', 'No identities linked yet', 'هیچ ناسنامەیەک نەبەستراوەتەوە'),
    tgAdded: loc('تم ربط الهوية', 'Identity linked', 'ناسنامە بەسترایەوە'),
    tgRevoked2: loc('تم سحب الهوية', 'Identity revoked', 'ناسنامە لابرا'),
    tgNeedFinancial: loc(
      'ربط هوية تيليجرام يمنح صلاحية الموافقة على إيصالات الدفع، وهي صلاحية مالية. حسابك مقيَّد كمساعد، فالربط والسحب للمالك أو للأدمن المالي فقط.',
      'Linking a Telegram identity grants the authority to approve payment proofs, which is financial authority. Your account is a restricted assistant, so linking and revoking are for the owner or a financial admin only.',
      'بەستنەوەی ناسنامەی تێلێگرام دەسەڵاتی دارایی دەبەخشێت — تەنها بۆ خاوەن یان بەڕێوەبەری دارایی.'
    ),
  };
}

export type UsersStrings = ReturnType<typeof useUsersStrings>;
