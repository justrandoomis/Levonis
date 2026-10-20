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
  },
  en: {
    notAllowed: (ext: string) => (ext ? `.${ext} files are not accepted on a request.` : 'This file is not accepted on a request.'),
    accepted: (g: ReturnType<typeof modelFormatGroups>) =>
      `A request takes pictures (${images()}), PDF drawings, and 3D models — measured and previewed: ${g.printable}; measured, converted before printing: ${g.convert}; sent to workshops as a reference only, not measured: ${g.reference}.`,
    tooLarge: { image: (mb: number) => `This picture is larger than ${mb} MB, the limit for a picture on a request.`, model: (mb: number) => `This model is larger than ${mb} MB, the limit for a model on a request.`, document: (mb: number) => `This document is larger than ${mb} MB, the limit for a document on a request.` },
    tooLargeAny: (mb: number) => `This file is larger than ${mb} MB.`,
    full: (n: number) => `A request carries at most ${n} files. Remove one to add another.`,
  },
  ckb: {
    notAllowed: (ext: string) => (ext ? `فایلی ‎.${ext} لە داواکاریدا وەرناگیرێت.` : 'ئەم فایلە لە داواکاریدا وەرناگیرێت.'),
    accepted: (g: ReturnType<typeof modelFormatGroups>) =>
      `داواکاری ئەمانە وەردەگرێت: وێنە (${images()})، نەخشەی PDF، و مۆدێلی سێ ڕەهەندی — دەپێورێن و پێشبینینیان هەیە: ${g.printable}؛ دەپێورێن بەڵام پێش چاپکردن دەگۆڕدرێن: ${g.convert}؛ تەنها وەک سەرچاوە دەگەنە وۆرکشۆپەکان، بەبێ پێوانە: ${g.reference}.`,
    tooLarge: { image: (mb: number) => `ئەم وێنەیە لە ${mb} مێگابایت گەورەترە، کە سنووری وێنەیە لە داواکاریدا.`, model: (mb: number) => `ئەم مۆدێلە لە ${mb} مێگابایت گەورەترە، کە سنووری مۆدێلە لە داواکاریدا.`, document: (mb: number) => `ئەم بەڵگەنامەیە لە ${mb} مێگابایت گەورەترە، کە سنووری بەڵگەنامەیە لە داواکاریدا.` },
    tooLargeAny: (mb: number) => `ئەم فایلە لە ${mb} مێگابایت گەورەترە.`,
    full: (n: number) => `داواکارییەک زۆرترین ${n} فایل هەڵدەگرێت. فایلێک بسڕەوە بۆ ئەوەی یەکێکی تر زیاد بکەیت.`,
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

/** The browser half: what is wrong with this file before it is uploaded, or an empty string. */
export function requestFileCheck(file: { name: string; size: number }, lang: Lang, filesAlready = 0): string {
  const problem = requestFileProblem(file, filesAlready);
  return problem ? requestFileProblemText(problem, lang) : '';
}

/** A server refusal of a request upload, in words — the coded ones from the tables, the rest from the shared table. */
export function requestUploadRefusal(err: unknown, lang: Lang, fallback = ''): string {
  if (err instanceof ApiError) {
    const d = (err.details ?? {}) as Record<string, unknown>;
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
