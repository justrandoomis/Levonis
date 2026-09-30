import type { Language } from '../../translations';

/**
 * The upload tile's words (docs/COMMUNITY_ECOSYSTEM.md §9.4). Sorani written
 * by hand for every line — never the Arabic standing in for it.
 */
export interface UploadStrings {
  /** The checksum step, named: the tile is not stuck, it is reading the file. */
  hashing: string;
  uploading: string;
  finishing: string;
  done: string;
  failed: string;
  cancelled: string;
  cancel: string;
  retry: string;
  /** «3.2 MB من 41 MB» */
  of: string;
  part: (n: number, total: number) => string;
  cellular: (size: string) => string;
}

export const UPLOAD_STRINGS: Record<Language, UploadStrings> = {
  ar: {
    hashing: 'التحقق من الملف…',
    uploading: 'جارٍ الرفع',
    finishing: 'إنهاء الرفع…',
    done: 'اكتمل الرفع',
    failed: 'تعذّر الرفع',
    cancelled: 'أُلغي الرفع',
    cancel: 'إلغاء',
    retry: 'إعادة المحاولة',
    of: 'من',
    part: (n, total) => `الجزء ${n} من ${total}`,
    cellular: (size) => `أنت على بيانات الهاتف — حجم هذا الملف ${size}`,
  },
  en: {
    hashing: 'Checking the file…',
    uploading: 'Uploading',
    finishing: 'Finishing…',
    done: 'Uploaded',
    failed: 'Upload failed',
    cancelled: 'Upload cancelled',
    cancel: 'Cancel',
    retry: 'Retry',
    of: 'of',
    part: (n, total) => `Part ${n} of ${total}`,
    cellular: (size) => `You are on mobile data — this file is ${size}`,
  },
  ckb: {
    hashing: 'پشکنینی فایلەکە…',
    uploading: 'بارکردن',
    finishing: 'تەواوکردنی بارکردن…',
    done: 'بارکردن تەواو بوو',
    failed: 'بارکردن سەرنەکەوت',
    cancelled: 'بارکردن هەڵوەشێنرایەوە',
    cancel: 'هەڵوەشاندنەوە',
    retry: 'دووبارە هەوڵبدەوە',
    of: 'لە',
    part: (n, total) => `بەشی ${n} لە ${total}`,
    cellular: (size) => `لەسەر داتای مۆبایلیت — قەبارەی ئەم فایلە ${size}ـە`,
  },
};

/** Above this a file on mobile data gets the warning, with its size. */
export const CELLULAR_WARN_BYTES = 25 * 1024 * 1024;

/** Latin units in every language: the server's own refusals already say «MB». */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** `navigator.connection.type === 'cellular'` where the browser exposes it (Chromium on Android); false elsewhere. */
export function onCellular(nav: Navigator | undefined): boolean {
  const connection = (nav as (Navigator & { connection?: { type?: string } }) | undefined)?.connection;
  return connection?.type === 'cellular';
}
