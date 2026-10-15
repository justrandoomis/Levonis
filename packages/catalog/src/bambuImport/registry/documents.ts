/**
 * Document kinds (spec §C.7) and their titles (§G.4). Documents are verified
 * LINKS to the official URLs, never re-hosted bytes (L-3).
 */
import { tri, type Tri } from './labels';

export type DocumentKind =
  | 'manual' | 'quick_start' | 'installation' | 'tds' | 'sds' | 'certificate' | 'hex_codes' | 'spec_sheet' | 'wiki' | 'faq'
  | 'guide' | 'video' | 'model_file' | 'other';

export const DOCUMENT_TITLES: Readonly<Record<DocumentKind, Tri>> = {
  manual: tri('دليل الاستخدام', 'User manual', 'ڕێبەری بەکارهێنان'),
  quick_start: tri('دليل البدء السريع', 'Quick start guide', 'ڕێبەری دەستپێکی خێرا'),
  installation: tri('دليل التركيب', 'Installation guide', 'ڕێبەری دامەزراندن'),
  tds: tri('ورقة البيانات الفنية (TDS)', 'Technical data sheet (TDS)', 'پەڕەی زانیاری تەکنیکی (TDS)'),
  sds: tri('ورقة بيانات السلامة (SDS)', 'Safety data sheet (SDS)', 'پەڕەی زانیاری سەلامەتی (SDS)'),
  certificate: tri('شهادة مطابقة', 'Compliance certificate', 'بڕوانامەی گونجان'),
  hex_codes: tri('رموز الألوان', 'Colour codes', 'کۆدەکانی ڕەنگ'),
  spec_sheet: tri('ورقة المواصفات', 'Specification sheet', 'پەڕەی تایبەتمەندییەکان'),
  wiki: tri('ويكي Bambu Lab', 'Bambu Lab Wiki', 'ویکی Bambu Lab'),
  faq: tri('الأسئلة الشائعة', 'FAQ', 'پرسیارە باوەکان'),
  guide: tri('دليل', 'Guide', 'ڕێبەر'),
  video: tri('فيديو', 'Video', 'ڤیدیۆ'),
  model_file: tri('ملف نموذج', 'Model file', 'فایلی مۆدێل'),
  other: tri('رابط', 'Link', 'بەستەر'),
};

/** Hosts a document may live on (0194 product_documents.host). */
export const DOCUMENT_HOSTS: ReadonlySet<string> = new Set([
  'store.bblcdn.com', 'cdn.shopify.com', 'wiki.bambulab.com', 'www.youtube.com', 'youtube.com', 'makerworld.com',
]);

/** Tracker targets kept after resolution (§C.5). */
export const TRACKER_TARGET_HOSTS: ReadonlySet<string> = new Set([
  'wiki.bambulab.com', 'store.bblcdn.com', 'www.youtube.com', 'youtube.com', 'makerworld.com',
]);

/** The kind of a document from its link text and file name (first rule wins). */
export function documentKindOf(text: string, url: string): DocumentKind {
  const t = `${text} ${decodeURIComponentSafe(url.split('/').pop() ?? '')}`.toLowerCase();
  const host = (/^https?:\/\/([^/]+)/i.exec(url)?.[1] ?? '').toLowerCase();
  if (host === 'wiki.bambulab.com') {
    if (/install/.test(t)) return 'installation';
    return 'wiki';
  }
  if (host.endsWith('youtube.com') || /\.mp4(\?|$)/i.test(url)) return 'video';
  if (/\.(zip|3mf|stl|step|stp)(\?|$)/i.test(url)) return 'model_file';
  if (host === 'makerworld.com') return 'other';
  // Letters, not \b, bound the acronyms: '_' is a word character, so `\bmsds` never matched Glue_Stick_MSDS.pdf,
  // and the plural "Safety Data Sheets" failed the trailing \b (review 4, finding 9).
  if (/(?:^|[^a-z])m?sds(?:[^a-z]|$)|safety[\s_-]data[\s_-]sheets?/.test(t)) return 'sds';
  if (/(?:^|[^a-z])tds(?:[^a-z]|$)|technical[\s_-]data[\s_-]sheets?/.test(t)) return 'tds';
  if (/hex[\s_-]?code/.test(t)) return 'hex_codes';
  if (/\b(rohs|en ?71|en71|tsca|cp ?65|cp65|pahs?|pops?|svhc|reach|fcc|ce\b|ul\b|certificat|declaration|compliance|doc\b)/.test(t)) return 'certificate';
  if (/quick[\s_-]?start/.test(t)) return 'quick_start';
  if (/install/.test(t)) return 'installation';
  if (/manual|user guide|user_guide/.test(t)) return 'manual';
  if (/\bspec|specification/.test(t)) return 'spec_sheet';
  if (/\bfaq\b/.test(t)) return 'faq';
  if (/guide/.test(t)) return 'guide';
  return 'other';
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
