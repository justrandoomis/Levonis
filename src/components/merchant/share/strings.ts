/**
 * The share panel's words, in the three languages the shop speaks.
 *
 * SORANI IS NEVER MACHINE-WRITTEN (docs/DECISIONS.md row 11). Where the app
 * already carries a hand-written Sorani line for the same thing it is reused
 * VERBATIM (and says where from); everywhere else only Arabic and English are
 * passed — `loc` falls back to the Arabic — and the line is marked for the
 * owner.
 */
import type { AppIconState } from './shareStoreApi';

export type Loc = (ar: string, en: string, ckb?: string) => string;

export function shareStrings(loc: Loc) {
  return {
    // Sorani verbatim from the storefront's «…» menu (src/pages/Storefront.tsx StoreMenu).
    title: loc('مشاركة المتجر', 'Share your store', 'هاوبەشکردنی فرۆشگا'),
    intro: loc(
      'رابط متجرك جاهز للإرسال في واتساب وإنستغرام وتيليغرام، أو كرمز QR يُطبع ويُمسح.',
      'Your store link, ready for WhatsApp, Instagram and Telegram — or as a QR code to print and scan.'
    ), // OWNER: Sorani to be written by hand.
    linkLabel: loc('رابط المتجر', 'Store link'), // OWNER: Sorani to be written by hand.
    // Sorani verbatim from the storefront's «…» menu.
    copy: loc('نسخ الرابط', 'Copy link', 'کۆپی بەستەر'),
    // Sorani verbatim from the profile QR window (src/components/profile/QrCodeModal.tsx).
    copied: loc('تم النسخ', 'Copied', 'کۆپی کرا'),
    copyFailed: loc(
      'تعذّر النسخ تلقائيًا — الرابط محدَّد، انسخه يدويًا.',
      'Could not copy automatically — the link is selected, copy it by hand.'
    ), // OWNER: Sorani to be written by hand.
    // Sorani verbatim from the storefront's share pin (src/pages/Storefront.tsx SharePin).
    share: loc('مشاركة…', 'Share…', 'هاوبەشکردن'),
    qrShow: loc('رمز QR', 'QR code'), // OWNER: Sorani to be written by hand.
    qrHide: loc('إخفاء رمز QR', 'Hide QR code'), // OWNER: Sorani to be written by hand.
    qrAlt: loc('رمز QR لرابط المتجر', 'QR code of the store link'), // OWNER: Sorani to be written by hand.
    qrHint: loc(
      'يفتح متجرك بكاميرا أي هاتف. اطبعه على الفاتورة أو العلبة أو واجهة المحل.',
      'Any phone camera opens your store with it. Print it on receipts, boxes or your shop window.'
    ), // OWNER: Sorani to be written by hand.
    qrDownload: loc('تنزيل الرمز (PNG)', 'Download the code (PNG)'), // OWNER: Sorani to be written by hand.
    qrDownloadFailed: loc(
      'تعذّر تنزيل الرمز على هذا المتصفح — التقط صورة للشاشة بدلًا منه.',
      'This browser could not download the code — take a screenshot of it instead.'
    ), // OWNER: Sorani to be written by hand.
    qrUnavailable: loc('لا يمكن تحويل هذا الرابط إلى رمز QR.', 'This link cannot be made into a QR code.'), // OWNER: Sorani to be written by hand.
    previewCaption: loc('هكذا يظهر رابطك عند مشاركته', 'How your link looks when shared'), // OWNER: Sorani to be written by hand.
    previewNote: loc(
      'تطبيقات المحادثة تحتفظ بالمعاينة أيامًا، فقد يتأخر ظهور شعار أو وصف جديد فيها.',
      'Chat apps keep a preview for days, so a new logo or description can take a while to show there.'
    ), // OWNER: Sorani to be written by hand.
    appTitle: loc('تطبيق متجرك', 'Your store app'), // OWNER: Sorani to be written by hand.
    appLead: loc(
      'ما يثبّته زبونك على شاشته الرئيسية من متجرك: اسمك وأيقونتك.',
      'What a customer installs on their home screen from your store: your name and your icon.'
    ), // OWNER: Sorani to be written by hand.
    suspended: loc(
      'أوقفت Levonis هذا المتجر؛ رابطه يعرض الآن صفحة «المتجر غير متاح حاليًا». تواصل مع الدعم.',
      'Levonis has suspended this store; its link now shows the “store unavailable” page. Contact support.'
    ), // OWNER: Sorani to be written by hand.
    loadFailed: loc('تعذّر تحميل أدوات المشاركة.', 'The share tools could not be loaded.'), // OWNER: Sorani to be written by hand.
    // Sorani verbatim from the offline page (public/sw.js OFFLINE_TEXT.ckb.retry).
    retry: loc('إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە'),
    // Sorani verbatim from the profile QR window.
    close: loc('إغلاق', 'Close', 'داخستن'),
    menuItem: loc('رمز QR وبطاقة المتجر', 'QR code & store card'), // OWNER: Sorani to be written by hand.
    loading: loc('جارٍ تحميل أدوات المشاركة…', 'Loading the share tools…'), // OWNER: Sorani to be written by hand.
  };
}

export type ShareStrings = ReturnType<typeof shareStrings>;

/**
 * The one line under the app icon, from the server's STATE and stable REASON
 * code — never from server text. Each line says what is true and, where the
 * merchant can act, what to do.
 */
export function iconStateLine(loc: Loc, state: AppIconState, reason: string | null): string {
  switch (state) {
    case 'ready':
      return loc('أيقونتك جاهزة: شعارك على آيفون وأندرويد.', 'Your icon is ready: your logo, on iPhone and Android.'); // OWNER: Sorani to be written by hand.
    case 'pending':
      return loc('نجهّز أيقونة التطبيق من شعارك… تظهر خلال لحظات.', 'Preparing the app icon from your logo… it appears in a moment.'); // OWNER: Sorani to be written by hand.
    case 'none':
      return loc(
        'أضف شعارًا في «هوية المتجر» ليحمل تطبيقك أيقونتك بدل أيقونة Levonis.',
        'Add a logo under “Store identity” so your app carries your icon instead of Levonis’s.'
      ); // OWNER: Sorani to be written by hand.
    case 'unavailable':
      return loc(
        'لا تُصنع أيقونات التطبيق على هذا الخادم؛ يظهر تطبيقك بأيقونة Levonis مؤقتًا.',
        'App icons are not made on this server; your app shows the Levonis icon for now.'
      ); // OWNER: Sorani to be written by hand.
    case 'failed':
    default:
      switch (reason) {
        case 'SOURCE_TOO_SMALL':
          return loc(
            'شعارك أصغر من أن يصير أيقونة واضحة. ارفع شعارًا مربعًا بقياس 512×512 أو أكبر.',
            'Your logo is too small to make a sharp icon. Upload a square logo of 512×512 or larger.'
          ); // OWNER: Sorani to be written by hand.
        case 'SOURCE_TOO_LARGE':
          return loc('ملف الشعار أكبر من اللازم. ارفع نسخة أصغر (حتى 8 ميغابايت).', 'The logo file is too large. Upload a smaller copy (up to 8 MB).'); // OWNER: Sorani to be written by hand.
        case 'SOURCE_NOT_IMAGE':
        case 'SOURCE_UNREADABLE':
          return loc('تعذّرت قراءة ملف الشعار. ارفعه من جديد بصيغة PNG أو JPG.', 'Your logo file could not be read. Upload it again as PNG or JPG.'); // OWNER: Sorani to be written by hand.
        case 'SOURCE_MISSING':
          return loc('لم نجد ملف الشعار. ارفعه من جديد في «هوية المتجر».', 'The logo file was not found. Upload it again under “Store identity”.'); // OWNER: Sorani to be written by hand.
        default:
          return loc(
            'تعذّر تجهيز الأيقونة الآن وسنعيد المحاولة تلقائيًا؛ يظهر تطبيقك بأيقونة Levonis حتى ذلك الحين.',
            'The icon could not be prepared just now and will be retried automatically; until then your app shows the Levonis icon.'
          ); // OWNER: Sorani to be written by hand.
      }
  }
}
