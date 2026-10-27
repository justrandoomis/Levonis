/**
 * The product's names. Brand names, so the same Latin letters in Arabic,
 * English and Sorani alike (the owner: «أريد اسم Levonis بالإنجليزي فقط»,
 * docs/DECISIONS.md row 99, tests/brandName.test.ts) — which is why they live
 * here and not in a `strings/` module, whose Sorani slot may never equal the
 * Arabic one.
 */

/** The wordmark of the header. */
export const BRAND = 'Levonis';
/** The small label beside it. */
export const PRODUCT = 'Print Cloud';
/** The document's title on cloud.<root>, in every language. */
export const CLOUD_TITLE = `${BRAND} ${PRODUCT}`;
