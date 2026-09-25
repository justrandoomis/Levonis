/**
 * The builder's words for every refusal it can meet — by stable code, never
 * the server's sentence (wave-2 COMMON rules). OWNER: Sorani to be written by
 * hand — Arabic and English only.
 */
import type { Loc } from './catalog';

export function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : '';
}

export function builderRefusal(e: unknown, loc: Loc): string {
  switch (codeOf(e)) {
    case 'DRAFT_CHANGED':
      return loc('تغيّرت المسودة من مكان آخر.', 'The draft changed somewhere else.');
    case 'DRAFT_UNSAVED':
      return loc('لم تُحفظ آخر تعديلاتك بعد — صحّح الحقول المعلّمة ثم أعد المحاولة.', 'Your latest edits are not saved yet — fix the marked fields and try again.');
    case 'DRAFT_MISSING':
      return loc('احفظ المسودة قبل نشرها.', 'Save the draft before publishing it.');
    case 'LAYOUT_REJECTED':
      return loc('في التصميم ما لا يمكن أن تحمله صفحة متجر.', 'This design holds something a store page cannot.');
    case 'LAYOUT_EMPTY':
      return loc('صفحة المتجر تحتاج قسمًا ظاهرًا واحدًا على الأقل.', 'A store page needs at least one visible section.');
    case 'LAYOUT_TOO_LARGE':
      return loc('التصميم أكبر مما تسمح به صفحة المتجر.', 'This design is larger than a store page may be.');
    case 'REVISION_NOT_FOUND':
      return loc('هذه النسخة لم تعد موجودة.', 'That version no longer exists.');
    case 'MERCHANT_SUSPENDED':
      return loc('حساب التاجر موقوف — لا يمكن تعديل التصميم الآن. تواصل مع الدعم.', 'This merchant account is suspended — the design cannot be changed now. Contact support.');
    case 'STORE_SUSPENDED':
      return loc('المتجر موقوف من Levonis — لا يمكن تعديل التصميم الآن. تواصل مع الدعم.', 'This store is suspended by Levonis — the design cannot be changed now. Contact support.');
    case 'RATE_LIMITED':
      return loc('تعديلات كثيرة في وقت قصير — انتظر قليلًا ثم تابع.', 'Many edits in a short time — wait a moment and continue.');
    case 'VIDEO_UNSUPPORTED':
      return loc('لا يعمل هذا الفيديو في المتصفح — ارفع MP4 أو WebM.', 'This video cannot play in a browser — upload an MP4 or WebM.');
    case 'IMAGE_HEIC_UNSUPPORTED':
      return loc('صور HEIC غير مدعومة — صدّرها بصيغة JPEG ثم ارفعها.', 'HEIC photos are not supported — export as JPEG and upload.');
    case 'IMAGE_TOO_LARGE_TO_CONVERT':
      return loc('الصورة أكبر من أن تُعالج — اختر صورة أصغر.', 'The picture is too large to process — choose a smaller one.');
    case 'IMAGE_CONVERT_FAILED':
      return loc('تعذّرت معالجة هذه الصورة — جرّب صورة أخرى.', 'This picture could not be processed — try another.');
    default:
      return loc('تعذّر ذلك — تحقّق من الاتصال وحاول مجددًا.', 'That did not work — check the connection and try again.');
  }
}
