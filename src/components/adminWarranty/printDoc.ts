/**
 * Opening — and accounting for — a warranty document.
 *
 * Two rules that both screens have to follow the same way, which is why this
 * is one function and not two copies:
 *
 *  1. A COPY IS COUNTED ONLY IF A COPY EXISTS. The count and its audit line
 *     are written after the tab is actually open, never before. Counting
 *     first meant a blocked pop-up left "second copy printed" in the record
 *     of a document nobody ever saw.
 *  2. A PREVIEW IS NOT A COPY. Opening the document to look at it changes
 *     nothing; only the print path counts.
 *
 * `noopener` is deliberately not passed. It makes window.open return null on
 * success as well as on failure, and then there is no way to tell a blocked
 * pop-up from an opened one. The target is our own admin route on our own
 * origin, so the opener reference it would strip is not a risk here.
 */
import { api } from '../../lib/api';

export type OpenDocResult = 'opened' | 'blocked';

export async function openWarrantyDoc(
  receiptId: string,
  opts: { print: boolean; lang?: string }
): Promise<OpenDocResult> {
  const q = new URLSearchParams();
  if (opts.print) q.set('print', '1');
  // The document prints in the language the admin is working in. Both are
  // snapshotted per receipt, so this picks a stored wording, never today's.
  if (opts.lang === 'en') q.set('lang', 'en');
  const qs = q.toString();
  const win = window.open(`/api/admin/warranties/${receiptId}/document${qs ? `?${qs}` : ''}`, '_blank');
  if (!win) return 'blocked';
  if (opts.print) await api.post(`/api/admin/warranties/${receiptId}/printed`, {});
  return 'opened';
}

/** What to tell the admin when the browser refused the tab. */
export const popupBlockedMessage = (lang: string): string =>
  lang === 'en'
    ? 'The browser blocked the document tab. Allow pop-ups for this site, then print again.'
    : 'المتصفح منع فتح تبويب الوثيقة. اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد الطباعة.';
