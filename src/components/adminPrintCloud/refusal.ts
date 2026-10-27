/**
 * A PRINT CLOUD REFUSAL, IN THE READER'S LANGUAGE — with what the server said
 * about why.
 *
 * Every Print Cloud refusal carries its sentence three times
 * (`details.messages` = { ar, en, ckb }, worker/lib/printCloud/errors.ts), so
 * the reader's own language is printed, never the «عربي / English» pair of
 * `message`. The platform's own refusals on these routes —
 * FINANCIAL_SCOPE_REQUIRED, COST_ACCESS_DENIED, OWNER_EMAIL_UNVERIFIED, a
 * rate limit — come from the shared contracts (`contractRefusal`,
 * `apiRefusal`). What the details name — the field, the machine reason, the
 * states of a refused move, a refundable remainder — is appended in words, so
 * «البيانات غير صالحة» becomes «… — السعر: أكبر من المسموح».
 */
import { ApiError } from '../../lib/api';
import { apiRefusal, contractRefusal } from '../../lib/refusalStrings';
import { JOB_STATUS, REASON, labelOf, pick, tri, type Lang, type Tri } from './i18n';
import { arrow } from './format';

const WORDS = {
  network: tri('تعذّر الاتصال بالخادم — تحقّق من الشبكة وحاول مجدداً.', 'Could not reach the server — check the connection and try again.', 'نەتوانرا پەیوەندی بە ڕاژەکارەوە بکرێت — هێڵەکە بپشکنە و دووبارە هەوڵ بدەرەوە.'),
  refundable: tri('المتاح للاسترداد الآن', 'refundable now', 'ئێستا دەگەڕێنرێتەوە'),
  available: tri('المتاح', 'available', 'بەردەست'),
  version: tri('الإصدار الحالي', 'current version', 'وەشانی ئێستا'),
  fromTo: tri('من', 'from', 'لە'),
} satisfies Record<string, Tri>;

/** The server's three sentences, when it sent them. */
function messagesOf(e: ApiError, lang: Lang): string {
  const m = e.details?.messages;
  if (!m || typeof m !== 'object') return '';
  const v = (m as Record<string, unknown>)[lang];
  return typeof v === 'string' ? v : '';
}

/**
 * The refusal as one line. `fieldLabel` turns a field name the server named
 * (`hourly_rate_iqd`, `materials[0].qty`) into the form's own label.
 */
export function pcRefusal(e: unknown, lang: Lang, fallback: string, fieldLabel?: (field: string) => string | null): string {
  if (!(e instanceof ApiError)) return e instanceof Error && e.message ? e.message : fallback;
  if (e.status === 0 && (e.code === 'NETWORK' || e.code === 'TIMEOUT')) return e.message || pick(WORDS.network, lang);
  const own = messagesOf(e, lang);
  const base = own || contractRefusal(e, lang, apiRefusal(e, lang, e.message || fallback)) || fallback;
  const d = (e.details ?? {}) as Record<string, unknown>;
  const extra: string[] = [];
  if (typeof d.field === 'string' && d.field) {
    const bare = d.field.replace(/\[\d+\]/g, '').split('.').pop() ?? d.field;
    extra.push(fieldLabel?.(d.field) ?? fieldLabel?.(bare) ?? d.field);
  }
  if (typeof d.reason === 'string' && d.reason) extra.push(labelOf(REASON, d.reason, lang));
  if (Array.isArray(d.reasons)) extra.push(d.reasons.map((r) => labelOf(REASON, String(r), lang)).join('، '));
  if (typeof d.from === 'string' && typeof d.to === 'string') extra.push(`${labelOf(JOB_STATUS, d.from, lang)} ${arrow(lang)} ${labelOf(JOB_STATUS, d.to, lang)}`);
  for (const key of ['refundable_seconds', 'refundable_qty'] as const) {
    if (typeof d[key] === 'number') extra.push(`${pick(WORDS.refundable, lang)}: ${d[key]}`);
  }
  if (typeof d.available === 'number') extra.push(`${pick(WORDS.available, lang)}: ${d.available}`);
  if (e.code === 'STATE_CHANGED' && typeof d.version === 'number') extra.push(`${pick(WORDS.version, lang)}: ${d.version}`);
  return extra.length ? `${base} — ${extra.join(' · ')}` : base;
}

/** The refusal's machine code, when there is one (for the few screens that branch on it). */
export const refusalCode = (e: unknown): string => (e instanceof ApiError && e.code ? e.code : '');
