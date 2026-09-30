/**
 * The builder's words for every refusal it can meet — by stable code, never
 * the server's sentence (wave-2 COMMON rules). The P5 media codes speak all
 * three languages from the media table; the older builder codes remain
 * Arabic and English (OWNER: Sorani to be written by hand).
 */
import type { Loc } from './catalog';
import { fillSpeed, mediaStrings, type MediaStrings, type SpeedLang } from './strings';

export function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : '';
}

/** The machine-readable context a refusal carried (`HttpError.details`), or nothing. */
export function detailsOf(e: unknown): Record<string, unknown> {
  const d = (e as { details?: unknown } | null)?.details;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

/** Bytes as a merchant reads them: «1.8 MB», «400 KB». */
export function formatBytes(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
}

/**
 * THE LANGUAGE A `loc` SPEAKS — asked of the function itself, so every caller
 * of `builderRefusal` keeps its signature and a Sorani reader is still told in
 * Sorani where the media table has the sentence.
 */
function langOf(loc: Loc): SpeedLang {
  const l = loc('ar', 'en', 'ckb');
  return l === 'en' || l === 'ckb' ? l : 'ar';
}

/** «فيديو الواجهة، فيديو الخلفية» — the videos a LAYOUT_POSTER_REQUIRED `paths` names, in the merchant's words. */
function posterPlaces(e: unknown, t: MediaStrings, lang: SpeedLang): string {
  const raw = detailsOf(e).paths;
  const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  const words = [...new Set(paths.map((p) => (p.startsWith('background') ? t.page.video : t.hero.video)))];
  return words.join(lang === 'en' ? ', ' : '، ');
}

/** «صفحة المتجر، منتج» — every place in the merchant's language; an unknown kind reads «somewhere else». */
export function whereText(t: MediaStrings, kinds: readonly unknown[], lang: string): string {
  const table = t.library.where as Record<string, string>;
  const words = [...new Set(kinds.map((k) => (typeof k === 'string' && Object.hasOwn(table, k) && k !== 'other' ? table[k] : table.other)))];
  return (words.length ? words : [table.other]).join(lang === 'en' ? ', ' : '، ');
}

export function builderRefusal(e: unknown, loc: Loc): string {
  switch (codeOf(e)) {
    case 'DRAFT_CHANGED':
      return loc('تغيّرت المسودة من مكان آخر.', 'The draft changed somewhere else.');
    case 'DRAFT_SAVE_FAILED':
      return loc('تعذّر حفظ آخر تعديلاتك قبل النشر — تحقّق من الاتصال وحاول مجددًا.', 'Your latest edits could not be saved before publishing — check the connection and try again.');
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
    case 'STORE_REQUIRED':
      return loc('افتح متجرك أولًا — صور المتجر وفيديوهاته تخصّ متجرًا.', 'Open your store first — store pictures and videos belong to a store.');
    case 'VIDEO_QUOTA_EXCEEDED':
      return loc('بلغ متجرك حدّ مساحة الفيديو (1 غيغابايت). احذف فيديو لم تعد تستخدمه ثم أعد المحاولة.', 'Your store has reached its video storage limit (1 GB). Remove a video you no longer use and try again.');
    case 'IMAGE_HEIC_UNSUPPORTED':
      return loc('صور HEIC غير مدعومة — صدّرها بصيغة JPEG ثم ارفعها.', 'HEIC photos are not supported — export as JPEG and upload.');
    case 'IMAGE_TOO_LARGE_TO_CONVERT':
      return loc('الصورة أكبر من أن تُعالج — اختر صورة أصغر.', 'The picture is too large to process — choose a smaller one.');
    case 'IMAGE_CONVERT_FAILED':
      return loc('تعذّرت معالجة هذه الصورة — جرّب صورة أخرى.', 'This picture could not be processed — try another.');
    // Media everywhere (P5; docs/MERCHANT_PLATFORM_V2.md storefront §4.7): the
    // slot's weight cap, the poster a video needs, a library file still in use.
    // THEIR WORDS ARE THE MEDIA TABLE'S, in all three languages (review
    // 2026-09-30: a two-language `loc` printed Arabic to a Sorani reader) —
    // the sentences src/lib/refusalStrings.ts holds, the same the picker uses.
    case 'LAYOUT_MEDIA_TOO_HEAVY': {
      const lang = langOf(loc);
      const t = mediaStrings(lang);
      const d = detailsOf(e);
      // Without the figures (an older caller) the short form, never «1 KB over 1 KB».
      if (!(Number(d.size) > 0 && Number(d.max) > 0)) return t.library.tooHeavyShort;
      return fillSpeed(t.library.tooHeavy, { size: formatBytes(d.size), max: formatBytes(d.max) });
    }
    case 'LAYOUT_POSTER_REQUIRED': {
      const lang = langOf(loc);
      const t = mediaStrings(lang);
      const places = posterPlaces(e, t, lang);
      return places ? `${t.library.posterRequired} (${places})` : t.library.posterRequired;
    }
    case 'MEDIA_IN_USE': {
      const lang = langOf(loc);
      const t = mediaStrings(lang);
      const where = detailsOf(e).where;
      return fillSpeed(t.library.inUse, { where: whereText(t, Array.isArray(where) ? where : [], lang) });
    }
    case 'MEDIA_NOT_FOUND':
      return mediaStrings(langOf(loc)).library.notFound;
    default:
      return loc('تعذّر ذلك — تحقّق من الاتصال وحاول مجددًا.', 'That did not work — check the connection and try again.');
  }
}
