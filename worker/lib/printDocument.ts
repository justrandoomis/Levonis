/**
 * THE RULES A PRINTED LEVONIS DOCUMENT OBEYS — in one place.
 *
 * The shop issues two documents a customer keeps: the purchase receipt
 * (وصل الشراء) and the warranty certificate (وصل الضمان). They were built by
 * different routes at different times and agreed on almost nothing — page
 * size, typeface, margins, how Arabic is set — and one of them was not a
 * document at all: the invoice was the EMAIL body served as a web page, a
 * 640px column in Arial with no print stylesheet of any kind.
 *
 * Everything below is the part that is the same for both, so the next document
 * inherits it instead of re-deciding it.
 *
 * THE FONT IS ACTUALLY FETCHED. Both documents already NAMED Cairo in their
 * `font-family` and neither ever loaded it, so every receipt this shop has
 * printed came out in Segoe UI or Tahoma — the CSP has permitted
 * fonts.googleapis.com and fonts.gstatic.com all along (see documentCsp in
 * securityPolicy.ts); the request was simply never made. An Arabic receipt set
 * in a fallback face is the difference between a document and a printout.
 *
 * `display=swap`, because a receipt that is blank while a font loads is worse
 * than a receipt in the wrong font — and on paper the swap has already
 * happened by the time anything is rendered.
 *
 * COLOUR SURVIVES THE PRINTER. Browsers drop backgrounds when printing unless
 * told otherwise, which would erase a table header that carries its meaning in
 * its fill. `print-color-adjust: exact` is what keeps the document the
 * document.
 *
 * ARABIC IS SET AS ARABIC. `letter-spacing` breaks the joins between Arabic
 * letters — docs/MOTION.md §9 records the same bug on screen — so it is forced
 * to zero, and the minimum line-height keeps Cairo's ascenders and the dots
 * under ب ج ي from being clipped.
 */

export const PRINT_FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap">';

export const PRINT_FONT_STACK = `'Cairo', 'Segoe UI', 'Tahoma', 'Arial', system-ui, sans-serif`;

/**
 * Shared page rules. A document adds its own layout on top; nothing here
 * decides what a receipt LOOKS like, only what it is printed on.
 *
 * `margin` is the caller's, because the two documents genuinely differ: the
 * warranty certificate is budgeted to one sheet at 12mm and the invoice may
 * legitimately run to two.
 */
export function printBaseCss(marginMm: number): string {
  return `
  @page { size: A4; margin: ${marginMm}mm; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: #ffffff; color: #14161a;
    font-family: ${PRINT_FONT_STACK};
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    -webkit-text-size-adjust: 100%;
  }
  /* Arabic is a joined script: positive tracking cuts the joins and turns a
     word into a row of shapes. The floor on line-height is what stops Cairo's
     ascenders and the dots beneath ب ج ي being clipped. */
  [dir='rtl'], [dir='rtl'] * { letter-spacing: 0 !important; }
  body { line-height: 1.5; }
  /* A figure inside an Arabic sentence is read left-to-right; without the
     isolation a currency symbol or a minus sign lands on the wrong end. */
  .ltr { direction: ltr; unicode-bidi: isolate; }
  .num { font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; }
  /* A row split across a page break is a row somebody has to reconcile by
     hand, and a heading stranded at the foot of a sheet belongs to nothing. */
  tr, .avoid-break { break-inside: avoid; }
  thead { display: table-header-group; }
  @media print {
    .no-print { display: none !important; }
  }
  @media screen {
    body { background: #eceef1; padding: 16px 12px 40px; }
    .sheet { box-shadow: 0 10px 40px -18px rgba(0,0,0,.55); }
  }
`;
}

/**
 * NO PRINT BUTTON, AND THAT IS NOT AN OVERSIGHT.
 *
 * The first draft of this module carried one, with an inline `onclick`. It
 * would never have run: documentCsp's script-src is a single SHA-256 hash, and
 * a hash does not permit an inline EVENT HANDLER — that needs `'unsafe-hashes'`
 * on top, which is a real weakening of the policy to buy a button.
 *
 * It is also redundant. `AUTO_PRINT_SCRIPT` in securityPolicy.ts is the one
 * script these documents are allowed to run, and opening the print dialog on
 * load is exactly what it does.
 */
