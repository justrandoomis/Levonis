/**
 * THE NUMBER AS A COURIER TYPES IT (owner, 2026-09-27: «اجعله ينسخ الرقم بدون
 * 964+ فقط الرقم مثل 07872863792»).
 *
 * The order stores the customer's phone in international form (+9647…), and
 * the preparation sheet copied it that way — into courier forms and dialpads
 * that expect the local Iraqi number. An Iraqi number is written here as 0
 * followed by its national digits; every accepted spelling of one (+964,
 * 00964, 964 without a plus, the bare ten digits, Arabic-Indic digits) comes
 * out the same. A number from another country keeps its international form,
 * because without its code it would be someone else's number.
 */

/** Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits → ASCII. */
const asciiDigits = (s: string) =>
  s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return String((c >= 0x06f0 ? c - 0x06f0 : c - 0x0660) % 10);
  });

export function localIraqiPhone(raw: string | null | undefined): string {
  const original = String(raw ?? '').trim();
  if (!original) return '';
  // Spaces, dashes, brackets, dots and the invisible direction marks a
  // right-to-left paste leaves behind.
  const s = asciiDigits(original).replace(/[\s\-().\u200e\u200f\u202a-\u202e]/g, '');
  let national: string | null = null;
  if (/^\+964\d{9,10}$/.test(s)) national = s.slice(4);
  else if (/^00964\d{9,10}$/.test(s)) national = s.slice(5);
  else if (/^964\d{10}$/.test(s)) national = s.slice(3);
  else if (/^0\d{10}$/.test(s)) return s;
  else if (/^7\d{9}$/.test(s)) national = s;
  if (national === null) return original;
  return national.startsWith('0') ? national : `0${national}`;
}
