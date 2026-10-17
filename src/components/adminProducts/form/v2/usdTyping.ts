/**
 * WHAT A DOLLAR INPUT LETS THROUGH WHILE TYPING — a leaf module.
 *
 * `UsdInput` (v2Ui.tsx) needs only this, and the special-offers tab (AdminOffers.tsx) uses `UsdInput`
 * for a dollar sale (docs/ux/PRODUCT-DISCOUNT.md §7). Kept apart from v2Model.ts, whose wire builders
 * name the owner's cost fields, so a screen that types a dollar price never shares a chunk with them
 * (tests/bundlePrivateNames.test.ts). v2Model re-exports both for its own callers.
 */

/** Arabic-Indic and Persian digits are digits; the Arabic decimal and thousands marks are `.` and `,`. */
export function toAscii(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

/** What a dollar input lets through while typing: digits, one dot, two decimals, and (signed) one leading sign. */
export function typingUsd(raw: string, signed = false): string {
  let t = toAscii(raw).replace(signed ? /[^\d.+-]/g : /[^\d.]/g, '');
  if (signed) {
    const sign = /^[+-]/.exec(t)?.[0] ?? '';
    t = sign + t.replace(/[+-]/g, '');
  }
  const [head, ...rest] = t.split('.');
  return rest.length ? `${head}.${rest.join('').slice(0, 2)}` : head;
}
