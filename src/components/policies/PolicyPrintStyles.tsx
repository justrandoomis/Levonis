/**
 * THE PRINT VIEW — a clean document, produced by the browser.
 *
 * NO PDF GENERATOR. The owner prints a policy to hand to a bank, a courier or
 * a customer, and the browser already knows how to paginate text, break pages
 * between articles and print to PDF. A generator would be a second renderer to
 * keep in step with the first, and the printed document would be the one that
 * silently drifted.
 *
 * WHAT ACTUALLY BREAKS WITHOUT THIS. The app shell is `h-[100dvh]` with
 * `overflow-hidden`, and the routes render inside `#main-scroll-container`,
 * which is `overflow-y-auto`. A scroll container prints exactly what is
 * visible: the whole corpus would come out as ONE page ending mid-sentence.
 * So the first job here is not typography, it is unclipping the ancestors —
 * the heights, the overflow and the flex sizing — so the document becomes
 * ordinary flowing text that the printer can paginate.
 *
 * The second job is removing everything that is not the document: the app
 * header, the bottom navigation, the search field, the table of contents and
 * every copy-link button. A printed legal document carries the text, the
 * version, the date it took effect and where it came from, and nothing else.
 *
 * BOTH SHELLS. /policies renders inside `#main-scroll-container`; the
 * storefront's /policy renders as a direct child of the shell root. The
 * hiding rules name the printed root positively rather than assuming either
 * layout, so neither shell hides the document it is supposed to print.
 */

const CSS = `
@media print {
  /* --- 1. unclip: the shell is a viewport-height scroll container --------- */
  html, body, #root {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    background: #ffffff !important;
    color: #000000 !important;
  }
  #root > div,
  #main-scroll-container {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    display: block !important;
    background: #ffffff !important;
  }

  /* --- 2. nothing on the page but the document --------------------------- */
  #root > div > *:not(#main-scroll-container):not([data-policy-print-root]),
  #main-scroll-container > *:not([data-policy-print-root]) {
    display: none !important;
  }

  [data-policy-print-root] {
    display: block !important;
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    background: #ffffff !important;
    color: #000000 !important;
  }
  [data-policy-print-root] * {
    background: transparent !important;
    box-shadow: none !important;
    text-shadow: none !important;
  }

  /* --- 3. the page itself ------------------------------------------------- */
  @page { margin: 18mm 16mm; }

  [data-policy-print-root] [data-policy-prose] {
    max-width: none !important;
    font-size: 10.5pt;
    line-height: 1.75;
    color: #000000 !important;
  }
  [data-policy-print-root] p,
  [data-policy-print-root] li {
    color: #111111 !important;
    /* Never leave one line of a paragraph stranded on its own page. */
    orphans: 3;
    widows: 3;
  }
  [data-policy-print-root] h1,
  [data-policy-print-root] h2,
  [data-policy-print-root] h3 {
    color: #000000 !important;
    /* A heading at the foot of a page with its article overleaf is exactly
       how a printed clause gets misread as belonging to the previous one. */
    break-after: avoid-page;
    break-inside: avoid-page;
    padding: 0 !important;
    margin-inline: 0 !important;
    border-color: #999999 !important;
  }
  [data-policy-print-root] h2 { font-size: 13pt; margin-top: 16pt; }
  [data-policy-print-root] h3 { font-size: 11pt; margin-top: 12pt; }
  [data-policy-print-root] ul { break-inside: auto; }
  [data-policy-print-root] li { break-inside: avoid; }
  [data-policy-print-root] strong { color: #000000 !important; }

  /* Gold on white is unreadable at print contrast; the article number keeps
     its distinct treatment through weight and spacing instead of colour. */
  [data-policy-print-root] .font-mono { color: #333333 !important; }

  /* --- 4. the print-only masthead and the screen-only chrome -------------- */
  [data-policy-print-only] { display: block !important; }
  [data-policy-screen-only],
  [data-policy-copy-link],
  [data-policy-search],
  [data-policy-outline-disclosure] {
    display: none !important;
  }
  [data-policy-print-root] a { text-decoration: none !important; color: #000000 !important; }
}

/* The masthead exists only on paper: on screen the same facts are in the
   document header, and printing them twice is how a page ends up with two
   titles. */
[data-policy-print-only] { display: none; }
`;

export default function PolicyPrintStyles() {
  return <style>{CSS}</style>;
}
