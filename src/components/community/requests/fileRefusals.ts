/**
 * WHY A FILE CANNOT GO ON A REQUEST — in the reader's language, built from the
 * tables the server decides by (Community V3 R5 and row `14.format-honesty`).
 *
 * The limits are packages/contracts/src/requestFiles.ts, the same table the
 * whole-body route and the resumable session read; the formats are
 * packages/contracts/src/modelFormats.ts `FORMAT_CAPABILITIES`, the same table
 * the server measures by. So a refused format is answered with what a request
 * DOES take, grouped by what Levonis can actually do with each format —
 * measured and previewed, measured but converted before printing, or kept as
 * a reference only — and never with a promise the server does not keep.
 *
 * The server answers coded refusals (`UPLOAD_KIND_NOT_ALLOWED`,
 * `UPLOAD_TOO_LARGE` with `kind` and `limit_bytes`, `REQUEST_FILES_FULL`);
 * the browser asks the same table before a byte leaves the device
 * (`requestFileProblem`). Both are rendered here. Anything else falls back to
 * the shared refusal table.
 */
import { FORMAT_CAPABILITIES, type ModelFormat } from '../../../../packages/contracts/src/modelFormats';
import {
  REQUEST_FILE_EXTENSIONS,
  REQUEST_FILE_LIMITS,
  requestFileExtension,
  requestFileProblem,
  type RequestFileKind,
  type RequestFileProblem,
} from '../../../../packages/contracts/src/requestFiles';
import { ApiError } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';

type Lang = 'ar' | 'en' | 'ckb';

const MiB = 1024 * 1024;
const SHOWN: Partial<Record<string, string>> = { gltf: 'glTF', jpg: 'JPG' };
const shown = (ext: string) => SHOWN[ext] ?? ext.toUpperCase();
const list = (exts: readonly string[]) => exts.map(shown).join(' · ');

/** The model formats a request takes, grouped by what FORMAT_CAPABILITIES says Levonis can do with each. */
export function modelFormatGroups(): { printable: string; convert: string; reference: string } {
  const models = (Object.keys(FORMAT_CAPABILITIES) as ModelFormat[]).filter((f) => f !== 'unknown');
  const pick = (test: (f: ModelFormat) => boolean) => list(models.filter(test));
  return {
    printable: pick((f) => FORMAT_CAPABILITIES[f].measurable && FORMAT_CAPABILITIES[f].sliceable),
    convert: pick((f) => FORMAT_CAPABILITIES[f].measurable && !FORMAT_CAPABILITIES[f].sliceable),
    reference: pick((f) => FORMAT_CAPABILITIES[f].reference_only),
  };
}

const images = () => list(REQUEST_FILE_EXTENSIONS.image.filter((e) => e !== 'jpeg'));

const WORDS = {
  ar: {
    notAllowed: (ext: string) => (ext ? `الملفات بامتداد ‎.${ext} لا تُقبل في الطلب.` : 'هذا الملف لا يُقبل في الطلب.'),
    accepted: (g: ReturnType<typeof modelFormatGroups>) =>
      `يقبل الطلب: صورًا (${images()})، ومخططات PDF، ومجسمات ثلاثية الأبعاد — تُقاس وتُعاين: ${g.printable}؛ تُقاس وتحتاج تحويلًا قبل الطباعة: ${g.convert}؛ تصل إلى الورش مرجعًا فقط دون قياس: ${g.reference}.`,
    tooLarge: { image: (mb: number) => `هذه الصورة أكبر من ${mb} ميغابايت، وهو حد الصور في الطلب.`, model: (mb: number) => `هذا المجسم أكبر من ${mb} ميغابايت، وهو حد المجسمات في الطلب.`, document: (mb: number) => `هذا المستند أكبر من ${mb} ميغابايت، وهو حد المستندات في الطلب.` },
    tooLargeAny: (mb: number) => `هذا الملف أكبر من ${mb} ميغابايت.`,
    full: (n: number) => `يحمل الطلب ${n} ملفات على الأكثر. احذف ملفًا لتضيف غيره.`,
    mismatch: (ext: string) =>
      ext
        ? `محتوى هذا الملف لا يطابق اسمه (‎.${ext}) — ربما هو صيغة أخرى غُيّر امتدادها. احفظه بصيغته الحقيقية ثم أعد رفعه.`
        : 'محتوى هذا الملف لا يطابق اسمه. احفظه بصيغته الحقيقية ثم أعد رفعه.',
    heic: 'هذه الصورة بصيغة HEIC (صيغة كاميرا الآيفون) ولا تعرضها المتصفحات — صدّرها بصيغة JPEG ثم أعد رفعها.',
    and: '، ',
  },
  en: {
    notAllowed: (ext: string) => (ext ? `.${ext} files are not accepted on a request.` : 'This file is not accepted on a request.'),
    accepted: (g: ReturnType<typeof modelFormatGroups>) =>
      `A request takes pictures (${images()}), PDF drawings, and 3D models — measured and previewed: ${g.printable}; measured, converted before printing: ${g.convert}; sent to workshops as a reference only, not measured: ${g.reference}.`,
    tooLarge: { image: (mb: number) => `This picture is larger than ${mb} MB, the limit for a picture on a request.`, model: (mb: number) => `This model is larger than ${mb} MB, the limit for a model on a request.`, document: (mb: number) => `This document is larger than ${mb} MB, the limit for a document on a request.` },
    tooLargeAny: (mb: number) => `This file is larger than ${mb} MB.`,
    full: (n: number) => `A request carries at most ${n} files. Remove one to add another.`,
    mismatch: (ext: string) =>
      ext
        ? `The contents of this file do not match its name (.${ext}) — it may be another format renamed. Save it in its real format and upload it again.`
        : 'The contents of this file do not match its name. Save it in its real format and upload it again.',
    heic: 'This is a HEIC photo (the iPhone camera format), which browsers cannot show — export it as JPEG and upload it again.',
    and: ', ',
  },
  ckb: {
    notAllowed: (ext: string) => (ext ? `فایلی ‎.${ext} لە داواکاریدا وەرناگیرێت.` : 'ئەم فایلە لە داواکاریدا وەرناگیرێت.'),
    accepted: (g: ReturnType<typeof modelFormatGroups>) =>
      `داواکاری ئەمانە وەردەگرێت: وێنە (${images()})، نەخشەی PDF، و مۆدێلی سێ ڕەهەندی — دەپێورێن و پێشبینینیان هەیە: ${g.printable}؛ دەپێورێن بەڵام پێش چاپکردن دەگۆڕدرێن: ${g.convert}؛ تەنها وەک سەرچاوە دەگەنە وۆرکشۆپەکان، بەبێ پێوانە: ${g.reference}.`,
    tooLarge: { image: (mb: number) => `ئەم وێنەیە لە ${mb} مێگابایت گەورەترە، کە سنووری وێنەیە لە داواکاریدا.`, model: (mb: number) => `ئەم مۆدێلە لە ${mb} مێگابایت گەورەترە، کە سنووری مۆدێلە لە داواکاریدا.`, document: (mb: number) => `ئەم بەڵگەنامەیە لە ${mb} مێگابایت گەورەترە، کە سنووری بەڵگەنامەیە لە داواکاریدا.` },
    tooLargeAny: (mb: number) => `ئەم فایلە لە ${mb} مێگابایت گەورەترە.`,
    full: (n: number) => `داواکارییەک زۆرترین ${n} فایل هەڵدەگرێت. فایلێک بسڕەوە بۆ ئەوەی یەکێکی تر زیاد بکەیت.`,
    mismatch: (ext: string) =>
      ext
        ? `ناوەڕۆکی ئەم فایلە لەگەڵ ناوەکەیدا (‎.${ext}) ناگونجێت — لەوانەیە شێوازێکی تر بێت و پاشگرەکەی گۆڕدرابێت. بە شێوازە ڕاستەقینەکەی پاشەکەوتی بکە و دووبارە باری بکە.`
        : 'ناوەڕۆکی ئەم فایلە لەگەڵ ناوەکەیدا ناگونجێت. بە شێوازە ڕاستەقینەکەی پاشەکەوتی بکە و دووبارە باری بکە.',
    heic: 'ئەم وێنەیە بە شێوازی HEIC ـە (شێوازی کامێرای ئایفۆن) و وێبگەڕەکان پیشانی نادەن — بە JPEG دەریبکە و دووبارە باری بکە.',
    and: '، ',
  },
} as const;

const isKind = (k: unknown): k is RequestFileKind => k === 'image' || k === 'model' || k === 'document';

/** One refusal, in words: the browser check and the server answer read the same way. */
export function requestFileProblemText(problem: RequestFileProblem, lang: Lang): string {
  const w = WORDS[lang] ?? WORDS.ar;
  if (problem.code === 'REQUEST_FILES_FULL') return w.full(problem.max_files);
  if (problem.code === 'UPLOAD_TOO_LARGE') return w.tooLarge[problem.kind](Math.round(problem.limit_bytes / MiB));
  return `${w.notAllowed(problem.extension)} ${w.accepted(modelFormatGroups())}`;
}

/** The extension a picture type is named with when its file has none. */
const IMAGE_TYPE_EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
};

/**
 * A FILE AS IT WILL BE SENT. Some phones hand a camera shot or a gallery
 * picture over with no extension at all (an in-app browser names it by
 * digits). Every door asks the extension, and the server then proves the
 * bytes are what it says, so such a picture is named from its type here, once,
 * before it is checked, previewed or sent. Anything else is returned as it is.
 */
export function namedForUpload<F extends { name: string; type?: string }>(file: F): F {
  if (requestFileExtension(file.name)) return file;
  const ext = IMAGE_TYPE_EXTENSION[String(file.type ?? '').toLowerCase()];
  if (!ext || typeof File === 'undefined' || !(file instanceof File)) return file;
  const base = file.name.replace(/\.+$/, '') || 'photo';
  return new File([file], `${base}.${ext}`, { type: file.type, lastModified: file.lastModified }) as unknown as F;
}

/** The browser half: what is wrong with this file before it is uploaded, or an empty string. */
export function requestFileCheck(file: { name: string; size: number; type?: string }, lang: Lang, filesAlready = 0): string {
  const problem = requestFileProblem(namedForUpload(file), filesAlready);
  return problem ? requestFileProblemText(problem, lang) : '';
}

/** One refusal in a few words: the reason only, the accepted list is said once by `requestFilesCheck`. */
function shortProblemText(problem: RequestFileProblem, lang: Lang): string {
  const w = WORDS[lang] ?? WORDS.ar;
  if (problem.code === 'UPLOAD_KIND_NOT_ALLOWED') return w.notAllowed(problem.extension);
  return requestFileProblemText(problem, lang);
}

/**
 * EVERY FILE OF ONE PICK, ASKED THE TABLE IN TURN (count, kind, size): the
 * files that may go, named for upload (`namedForUpload`), and ONE refusal for
 * the rest. Each refused file is named with its short reason; the files past
 * the count share one sentence; and when any was refused for its format, what
 * a request DOES take is said once at the end, not once per file. Every door
 * that picks files (the wizard, the request page, the chat sheet) uses it, so
 * none of them silently drops a file.
 */
export function requestFilesCheck<F extends { name: string; size: number; type?: string }>(
  picked: readonly F[],
  lang: Lang,
  filesAlready = 0
): { accepted: F[]; refusal: string } {
  const w = WORDS[lang] ?? WORDS.ar;
  const accepted: F[] = [];
  const lines: string[] = [];
  const overflow: string[] = [];
  let format = false;
  for (const raw of picked) {
    const file = namedForUpload(raw);
    const problem = requestFileProblem(file, filesAlready + accepted.length);
    if (!problem) {
      accepted.push(file);
    } else if (problem.code === 'REQUEST_FILES_FULL') {
      overflow.push(`«${raw.name}»`);
    } else {
      if (problem.code === 'UPLOAD_KIND_NOT_ALLOWED') format = true;
      lines.push(`«${raw.name}» — ${shortProblemText(problem, lang)}`);
    }
  }
  if (overflow.length) lines.push(`${overflow.join(w.and)} — ${w.full(REQUEST_FILE_LIMITS.maxFiles)}`);
  if (format) lines.push(w.accepted(modelFormatGroups()));
  return { accepted, refusal: lines.join(' ') };
}

/** A server refusal of a request upload, in words — the coded ones from the tables, the rest from the shared table. */
export function requestUploadRefusal(err: unknown, lang: Lang, fallback = ''): string {
  if (err instanceof ApiError) {
    const d = (err.details ?? {}) as Record<string, unknown>;
    // A listed extension whose bytes are something else (both doors answer
    // `{declared, detected}`): the name is not the problem, the contents are.
    if (err.code === 'UPLOAD_KIND_NOT_ALLOWED' && 'declared' in d) {
      return (WORDS[lang] ?? WORDS.ar).mismatch(String(d.declared ?? ''));
    }
    if (err.code === 'IMAGE_HEIC_UNSUPPORTED') return (WORDS[lang] ?? WORDS.ar).heic;
    if (err.code === 'UPLOAD_KIND_NOT_ALLOWED' && (d.purpose === 'request' || 'extension' in d)) {
      return requestFileProblemText({ code: 'UPLOAD_KIND_NOT_ALLOWED', extension: String(d.extension ?? '') }, lang);
    }
    if (err.code === 'UPLOAD_TOO_LARGE' && typeof d.limit_bytes === 'number') {
      if (isKind(d.kind)) return requestFileProblemText({ code: 'UPLOAD_TOO_LARGE', kind: d.kind, limit_bytes: d.limit_bytes }, lang);
      return (WORDS[lang] ?? WORDS.ar).tooLargeAny(Math.round(d.limit_bytes / MiB));
    }
    if (err.code === 'REQUEST_FILES_FULL') {
      return requestFileProblemText({ code: 'REQUEST_FILES_FULL', max_files: Number(d.max_files) || REQUEST_FILE_LIMITS.maxFiles }, lang);
    }
  }
  return apiRefusal(err, lang, fallback);
}
