/**
 * A REFUSAL, IN THE MERCHANT'S WORDS — never the server's sentence.
 *
 * `apiRefusal` (src/lib/refusalStrings.ts) falls back to the server's own
 * message for a code the table does not own, which is right for the doors
 * that already had one and wrong for the workspace: an English sentence from
 * `HttpError` inside an Arabic screen is exactly what the old `alert(e.message)`
 * calls showed. Here a code the table knows gets its sentence, a counted stock
 * refusal gets its number, and anything else gets the caller's own
 * hand-written fallback («تعذّر الحفظ»).
 */
import { refusalText, stockRefusal, type Lang } from '../../../lib/refusalStrings';

export function merchantRefusal(err: unknown, lang: Lang, fallback: string): string {
  const counted = stockRefusal(err, lang);
  if (counted) return counted;
  const e = err as { code?: unknown } | null;
  const code = e && typeof e.code === 'string' ? e.code : '';
  return refusalText(code, lang, fallback);
}
