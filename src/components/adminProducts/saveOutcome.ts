/**
 * A PRODUCT WRITE THE CLIENT STOPPED WAITING FOR IS NOT A FAILED WRITE (the
 * owner's report of 2026-10-17: «Network error — check your connection and try
 * again» on «حفظ», «نشر» and «اعتمد ونشر» of a product, «sometimes»).
 *
 * WHAT HAPPENED. Every request had the API client's 20-second deadline, and a
 * deadline that fired read exactly like a dead connection. The product save is
 * one request that verifies every picture, plans the structure twice and
 * writes one batch; measured on a realistic product (three colours, cost-first
 * V2, a live offer, six pictures, open price requests) it waited on the D1
 * primary 99 times in sequence before this fix and 44 after
 * (tests/adminSaveRoundTrips.test.ts). From Iraq, a slow day put it past 20 s:
 * the browser gave up, said «network error», and the server went on to save.
 * The owner pressed again on a write that had already landed.
 *
 * NOW: a product write has its own deadline (`PRODUCT_WRITE_TIMEOUT_MS`, the
 * measured worst case with room), the form says «still saving» while it waits,
 * and when the deadline fires — or the answer is lost on the way back, or the
 * server fails with no refusal of its own (a code-less 5xx, possibly after its
 * batch committed) — it READS THE PRODUCT AGAIN before it says anything
 * (`confirmSaveOutcome`):
 *
 *   saved      the stored product moved past the version the form was editing
 *              (`updated_at`): «تم الحفظ», and the form reloads what is stored;
 *   not_saved  it did not move, read twice a few seconds apart: «لم يُحفظ — أعد
 *              المحاولة». A retry is SAFE: the save is fenced on the version it
 *              edits (`expected_updated_at` → 409 STALE_EDIT, the form's own
 *              «someone saved meanwhile» sheet, if the first one lands after
 *              all), a price confirm on its preview hash (`already`), and a new
 *              product's save on its own id (a second save is an update of the
 *              same row) — nothing is ever written twice;
 *   unknown    the product could not be read either: say so, and ask for a
 *              reload before saving again — never «try again» blind.
 */
import { api, ApiError } from '../../lib/api';
import type { Language } from '../../translations';

/**
 * A product write's deadline: the measured worst case of the save with its pictures (44 sequential waits on
 * the D1 primary, R2 and the Images binding) at a pessimistic second each, doubled. Past it the form reads
 * the product again instead of guessing.
 */
export const PRODUCT_WRITE_TIMEOUT_MS = 90_000;

/** After this long the form says «still saving — keep this page open». */
export const STILL_SAVING_AFTER_MS = 15_000;

/**
 * The write may have landed: the client stopped waiting, its answer never arrived, or the server failed
 * WITHOUT a refusal of its own (a 5xx with no code — it may have failed after its batch committed, in the
 * read-back). A coded refusal (STALE_EDIT, PRICING_*, a 503 «not installed») wrote nothing and says why.
 */
export function writeOutcomeUnknown(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 0) return e.code === 'TIMEOUT' || e.code === 'NETWORK';
  return e.status >= 500 && !e.code;
}

export type SaveOutcome = 'saved' | 'not_saved' | 'unknown';

type Read = (path: string) => Promise<{ product?: { updated_at?: unknown } | null }>;

const defaultRead: Read = (path) =>
  // Its own deadline, never shared with a coalesced read (a fresh signal opts out), and no mascot.
  api.get(path, { signal: new AbortController().signal, mascot: 'silent' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Did the product write land? `before`: the `updated_at` the form was editing ('' for a product this
 * save creates). Read once; when nothing moved, once more `recheckMs` later — the server may still be
 * finishing what the client stopped waiting for.
 */
export async function confirmSaveOutcome(
  productId: string,
  before: string,
  opts: { read?: Read; recheckMs?: number } = {}
): Promise<{ outcome: SaveOutcome; updatedAt: string | null }> {
  const read = opts.read ?? defaultRead;
  const recheckMs = opts.recheckMs ?? 4000;
  let unread = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(recheckMs);
    try {
      const res = await read(`/api/admin/products-v2/${encodeURIComponent(productId)}`);
      const now = res.product && typeof res.product.updated_at === 'string' ? res.product.updated_at : '';
      if (res.product && now !== '' && now !== before) return { outcome: 'saved', updatedAt: now };
      unread = false;
    } catch (e) {
      // A product this save would have created and that is not there: not saved (yet).
      if (e instanceof ApiError && e.status === 404 && before === '') {
        unread = false;
        continue;
      }
      unread = true;
    }
  }
  return { outcome: unread ? 'unknown' : 'not_saved', updatedAt: null };
}

type L3 = Record<'ar' | 'en' | 'ckb', string>;

/** Every sentence of the outcome, in the three languages (a `ckb` slot never carries the Arabic). */
export const SAVE_OUTCOME_TEXT: Record<SaveOutcome | 'stillSaving' | 'checking' | 'checkFields' | 'failed', L3> = {
  saved: {
    ar: 'تم الحفظ — لم يصل ردّ الخادم كاملاً، فتحقّقنا: تغييراتك محفوظة.',
    en: 'Saved — the server’s answer did not come through, so we checked: your changes are saved.',
    ckb: 'پاشەکەوت کرا — وەڵامی ڕاژەکار بە تەواوی نەگەیشت، بۆیە پشکنیمان: گۆڕانکارییەکانت پاشەکەوت کراون.',
  },
  not_saved: {
    ar: 'لم يُحفظ — أعد المحاولة. تغييراتك ليست على الخادم، وإعادة الحفظ آمنة ولا تكرّر شيئاً.',
    en: 'Not saved — try again. Your changes are not on the server; saving again is safe and repeats nothing.',
    ckb: 'پاشەکەوت نەکرا — دووبارە هەوڵ بدەرەوە. گۆڕانکارییەکانت لەسەر ڕاژەکار نین؛ دووبارە پاشەکەوتکردن بێ مەترسییە و هیچ شتێک دووبارە ناکاتەوە.',
  },
  unknown: {
    ar: 'تعذّر التأكد من الحفظ — تحقّق من اتصالك، ثم أعد تحميل المنتج قبل أن تحفظ من جديد.',
    en: 'Could not confirm the save — check your connection, then reload the product before saving again.',
    ckb: 'نەتوانرا پاشەکەوتکردنەکە پشتڕاست بکرێتەوە — هێڵی ئینتەرنێتەکەت بپشکنە، پاشان پێش دووبارە پاشەکەوتکردن بەرهەمەکە نوێ بکەرەوە.',
  },
  stillSaving: {
    ar: 'ما زال الحفظ جارياً — أبقِ هذه الصفحة مفتوحة.',
    en: 'Still saving — keep this page open.',
    ckb: 'پاشەکەوتکردن هێشتا بەردەوامە — ئەم پەڕەیە بە کراوەیی بهێڵەرەوە.',
  },
  checking: {
    ar: 'لم يصل ردّ الخادم كاملاً — نتحقّق الآن هل حُفظ المنتج…',
    en: 'The server’s answer did not come through — checking whether the product was saved…',
    ckb: 'وەڵامی ڕاژەکار بە تەواوی نەگەیشت — ئێستا دەپشکنین بزانین بەرهەمەکە پاشەکەوت کراوە یان نا…',
  },
  checkFields: {
    ar: 'راجع الحقول المعلّمة بالأحمر قبل الحفظ.',
    en: 'Check the fields marked in red before saving.',
    ckb: 'پێش پاشەکەوتکردن ئەو خانانە بپشکنە کە بە سوور نیشانە کراون.',
  },
  failed: {
    ar: 'تعذّر الحفظ.',
    en: 'The save failed.',
    ckb: 'پاشەکەوتکردن سەرکەوتوو نەبوو.',
  },
};

export function saveOutcomeText(key: keyof typeof SAVE_OUTCOME_TEXT, lang: Language | string): string {
  const l = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  return SAVE_OUTCOME_TEXT[key][l];
}
