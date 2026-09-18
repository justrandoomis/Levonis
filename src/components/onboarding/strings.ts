/**
 * Words for account setup and the profile-completion prompt, in the three
 * languages LEVONIS actually ships. Written out by hand — nothing here is
 * machine-translated, and an English string is never shown on the Arabic or
 * Kurdish page as a fallback.
 */
export const ONBOARDING_STRINGS = {
  ar: {
    welcome: 'أهلًا بك في LEVONIS',
    welcomeHint: 'خطوتان قصيرتان، ويمكنك تخطّيهما الآن وإكمالهما لاحقًا.',
    step: 'الخطوة {n} من {total}',
    stepProfile: 'ملفك الشخصي',
    stepProfileHint: 'كيف يظهر اسمك للآخرين في LEVONIS.',
    stepDetails: 'تفاصيل اختيارية',
    stepDetailsHint: 'تساعدنا على عرض الأسعار واللغة والتوصيل بشكل صحيح.',
    stepDone: 'حسابك جاهز',
    stepDoneHint: 'يمكنك تعديل كل شيء لاحقًا من صفحة الحساب.',
    displayName: 'الاسم الظاهر',
    username: 'اسم المستخدم',
    usernameHint: 'أحرف إنجليزية صغيرة وأرقام و . _ - (٣ إلى ٣٠ حرفًا)',
    usernameChecking: 'جارٍ التحقق…',
    usernameFree: 'متاح',
    usernameTaken: 'هذا الاسم محجوز بالفعل',
    usernameReserved: 'هذا الاسم محجوز للمنصّة',
    usernameShort: 'قصير جدًا (٣ أحرف على الأقل)',
    usernameLong: 'طويل جدًا (٣٠ حرفًا كحد أقصى)',
    usernameChars: 'يُسمح بالأحرف الإنجليزية والأرقام و . _ - فقط',
    usernameEdges: 'يجب أن يبدأ وينتهي بحرف أو رقم',
    usernameDoubles: 'لا تضع نقطتين أو شرطتين متتاليتين',
    usernameDigits: 'يجب أن يحتوي على حرف واحد على الأقل',
    photo: 'صورة الحساب',
    photoAdd: 'إضافة صورة',
    photoChange: 'تغيير الصورة',
    photoUploading: 'جارٍ الرفع…',
    photoTooBig: 'الصورة أكبر من ٥ ميغابايت.',
    photoBadType: 'اختر صورة (JPG أو PNG أو WebP).',
    country: 'الدولة',
    countryPlaceholder: 'اختر دولتك',
    commonCountries: 'الأكثر استخدامًا',
    allCountries: 'كل الدول',
    countrySearch: 'ابحث عن دولة أو رمز',
    countryEmpty: 'لا توجد دولة بهذا الاسم أو الرمز',
    language: 'اللغة',
    phone: 'رقم الهاتف',
    phoneNote: 'يُضاف رقمك عبر تيليغرام من صفحة الحساب — لا يُقبل رقم مكتوب فقط.',
    continue: 'متابعة',
    skip: 'تخطّي الآن',
    skipAll: 'تخطّي الإعداد',
    finish: 'ابدأ التسوّق',
    saving: 'جارٍ الحفظ…',
    saveFailed: 'تعذّر الحفظ. حاول مرة أخرى.',
    // completion prompt
    completeTitle: 'أكمل ملفك الشخصي',
    completePercent: 'ملفك مكتمل بنسبة {p}%',
    completeNow: 'إكمال الآن',
    later: 'ربما لاحقًا',
    missName: 'أضف اسمك الظاهر',
    missUsername: 'اختر اسم مستخدم',
    missAvatar: 'أضف صورة للحساب',
    missCountry: 'حدّد دولتك',
    missLocale: 'اختر لغتك',
    missPhone: 'وثّق رقم هاتفك',
    missEmail: 'أضف بريدًا إلكترونيًا',
    close: 'إغلاق',
  },
  en: {
    welcome: 'Welcome to LEVONIS',
    welcomeHint: 'Two short steps — you can skip them now and finish later.',
    step: 'Step {n} of {total}',
    stepProfile: 'Your profile',
    stepProfileHint: 'How your name appears to other people on LEVONIS.',
    stepDetails: 'Optional details',
    stepDetailsHint: 'They help us get pricing, language and delivery right.',
    stepDone: 'Your account is ready',
    stepDoneHint: 'You can change any of this later from your account page.',
    displayName: 'Display name',
    username: 'Username',
    usernameHint: 'Lowercase letters, numbers and . _ - (3–30 characters)',
    usernameChecking: 'Checking…',
    usernameFree: 'Available',
    usernameTaken: 'That username is already taken',
    usernameReserved: 'That username is reserved for the platform',
    usernameShort: 'Too short (at least 3 characters)',
    usernameLong: 'Too long (30 characters maximum)',
    usernameChars: 'Only letters, numbers and . _ - are allowed',
    usernameEdges: 'Must start and end with a letter or a number',
    usernameDoubles: 'No two dots, dashes or underscores in a row',
    usernameDigits: 'Must contain at least one letter',
    photo: 'Profile photo',
    photoAdd: 'Add a photo',
    photoChange: 'Change photo',
    photoUploading: 'Uploading…',
    photoTooBig: 'That image is larger than 5 MB.',
    photoBadType: 'Choose an image (JPG, PNG or WebP).',
    country: 'Country',
    countryPlaceholder: 'Select your country',
    commonCountries: 'Frequently used',
    allCountries: 'All countries',
    countrySearch: 'Search a country or code',
    countryEmpty: 'No country matches that',
    language: 'Language',
    phone: 'Phone number',
    phoneNote: 'Your number is added through Telegram from your account page — a typed number alone is never accepted.',
    continue: 'Continue',
    skip: 'Skip for now',
    skipAll: 'Skip setup',
    finish: 'Start shopping',
    saving: 'Saving…',
    saveFailed: 'That could not be saved. Please try again.',
    completeTitle: 'Complete your profile',
    completePercent: 'Profile {p}% complete',
    completeNow: 'Complete profile',
    later: 'Maybe later',
    missName: 'Add your display name',
    missUsername: 'Pick a username',
    missAvatar: 'Add a profile photo',
    missCountry: 'Set your country',
    missLocale: 'Choose your language',
    missPhone: 'Verify your phone number',
    missEmail: 'Add an email address',
    close: 'Close',
  },
  ckb: {
    welcome: 'بەخێربێیت بۆ LEVONIS',
    welcomeHint: 'دوو هەنگاوی کورت — دەتوانیت ئێستا تێپەڕیان بکەیت و دواتر تەواویان بکەیت.',
    step: 'هەنگاوی {n} لە {total}',
    stepProfile: 'پرۆفایلەکەت',
    stepProfileHint: 'ناوەکەت چۆن بۆ کەسانی تر لە LEVONIS دەردەکەوێت.',
    stepDetails: 'وردەکاری ئارەزوومەندانە',
    stepDetailsHint: 'یارمەتیمان دەدەن نرخ و زمان و گەیاندن بە دروستی پیشان بدەین.',
    stepDone: 'هەژمارەکەت ئامادەیە',
    stepDoneHint: 'دواتر لە پەڕەی هەژمارەکەتەوە هەموویان دەگۆڕیت.',
    displayName: 'ناوی دەرکەوتوو',
    username: 'ناوی بەکارهێنەر',
    usernameHint: 'پیتی ئینگلیزی بچووک و ژمارە و . _ - (٣ بۆ ٣٠ پیت)',
    usernameChecking: 'پشکنین…',
    usernameFree: 'بەردەستە',
    usernameTaken: 'ئەم ناوە پێشتر وەرگیراوە',
    usernameReserved: 'ئەم ناوە بۆ پلاتفۆرمەکە پاراستراوە',
    usernameShort: 'زۆر کورتە (لانیکەم ٣ پیت)',
    usernameLong: 'زۆر درێژە (زۆرترین ٣٠ پیت)',
    usernameChars: 'تەنها پیت و ژمارە و . _ - ڕێگەپێدراون',
    usernameEdges: 'دەبێت بە پیت یان ژمارە دەستپێبکات و کۆتایی بێت',
    usernameDoubles: 'دوو خاڵ یان دوو هێڵ بە یەکەوە نەبێت',
    usernameDigits: 'دەبێت لانیکەم یەک پیتی تێدابێت',
    photo: 'وێنەی هەژمار',
    photoAdd: 'زیادکردنی وێنە',
    photoChange: 'گۆڕینی وێنە',
    photoUploading: 'بارکردن…',
    photoTooBig: 'وێنەکە لە ٥ مێگابایت گەورەترە.',
    photoBadType: 'وێنەیەک هەڵبژێرە (JPG یان PNG یان WebP).',
    country: 'وڵات',
    countryPlaceholder: 'وڵاتەکەت هەڵبژێرە',
    commonCountries: 'زۆرترین بەکارهاتوو',
    allCountries: 'هەموو وڵاتان',
    countrySearch: 'گەڕان بە ناوی وڵات یان کۆد',
    countryEmpty: 'هیچ وڵاتێک نەدۆزرایەوە',
    language: 'زمان',
    phone: 'ژمارەی تەلەفۆن',
    phoneNote: 'ژمارەکەت لە ڕێگەی تەلەگرامەوە لە پەڕەی هەژمارەکەت زیاد دەکرێت — ژمارەی نووسراو بە تەنها قبوڵ ناکرێت.',
    continue: 'بەردەوامبوون',
    skip: 'ئێستا تێپەڕاندن',
    skipAll: 'تێپەڕاندنی ڕێکخستن',
    finish: 'دەستپێکردنی بازاڕکردن',
    saving: 'پاشەکەوتکردن…',
    saveFailed: 'نەتوانرا پاشەکەوت بکرێت. دووبارە هەوڵبدە.',
    completeTitle: 'پرۆفایلەکەت تەواو بکە',
    completePercent: 'پرۆفایل {p}% تەواوە',
    completeNow: 'تەواوکردنی پرۆفایل',
    later: 'لەوانەیە دواتر',
    missName: 'ناوی دەرکەوتووت زیاد بکە',
    missUsername: 'ناوێکی بەکارهێنەر هەڵبژێرە',
    missAvatar: 'وێنەیەکی هەژمار زیاد بکە',
    missCountry: 'وڵاتەکەت دیاری بکە',
    missLocale: 'زمانەکەت هەڵبژێرە',
    missPhone: 'ژمارەی تەلەفۆنەکەت پشتڕاست بکەرەوە',
    missEmail: 'ئیمەیلێک زیاد بکە',
    close: 'داخستن',
  },
} as const;

export type OnboardingLang = keyof typeof ONBOARDING_STRINGS;
export type OnboardingStrings = (typeof ONBOARDING_STRINGS)['en'];

export function onboardingStrings(lang: string): OnboardingStrings {
  return (ONBOARDING_STRINGS[lang as OnboardingLang] ?? ONBOARDING_STRINGS.en) as OnboardingStrings;
}

/** Which line to show for a missing profile field. */
export function missingLabel(s: OnboardingStrings, field: string): string {
  switch (field) {
    case 'name':
      return s.missName;
    case 'username':
      return s.missUsername;
    case 'avatar':
      return s.missAvatar;
    case 'country':
      return s.missCountry;
    case 'locale':
      return s.missLocale;
    case 'phone':
      return s.missPhone;
    case 'email':
      return s.missEmail;
    default:
      return field;
  }
}

/** Why a username was refused, in the reader's language. */
export function usernameReasonLabel(s: OnboardingStrings, reason: string | null): string {
  switch (reason) {
    case 'taken':
      return s.usernameTaken;
    case 'reserved':
      return s.usernameReserved;
    case 'too_short':
      return s.usernameShort;
    case 'too_long':
      return s.usernameLong;
    case 'bad_characters':
      return s.usernameChars;
    case 'bad_edges':
      return s.usernameEdges;
    case 'repeated_punctuation':
      return s.usernameDoubles;
    case 'all_digits':
      return s.usernameDigits;
    default:
      return '';
  }
}
