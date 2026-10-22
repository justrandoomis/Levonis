/**
 * WHAT IS TAKEN OUT OF A CUSTOMER'S TEXT BEFORE A MODEL SEES IT (push B plan
 * §5.1, §6.8, §15). Pure.
 *
 * Replaced with «[…]»:
 *   - e-mail addresses;
 *   - phone numbers: an Iraqi mobile (07…), an international +964 / 00964
 *     number, and ANY run of seven or more digits (spaces and dashes inside
 *     the run allowed), counted after Arabic-Indic and Persian digits are
 *     folded to ASCII;
 *   - order ids (`ORD-…`, any case).
 *
 * The validators always run against the customer's UNREDACTED text, which the
 * server keeps (plan §5.1): an order id the customer typed is still read by
 * push A's own `extractOrderId`, never by a model.
 */
export const REDACTED = '«[…]»';

/** Arabic-Indic (U+0660–0669) and extended Arabic-Indic (U+06F0–06F9) digits → ASCII. */
export function foldDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const ORDER_ID = /\bORD-[A-Za-z0-9-]+/gi;
/** +964 / 00964 / 07…, then digits with optional single spaces or dashes. */
const IRAQI_PHONE = /(?:\+|00)?964[\s-]?\d(?:[\s-]?\d){6,}|\b07\d(?:[\s-]?\d){7,}/g;
/** Any other run that holds seven or more digits. */
const LONG_DIGITS = /\d(?:[\s-]?\d){6,}/g;

export function redactForModel(text: string): string {
  return foldDigits(text)
    .replace(EMAIL, REDACTED)
    .replace(ORDER_ID, REDACTED)
    .replace(IRAQI_PHONE, REDACTED)
    .replace(LONG_DIGITS, REDACTED);
}
