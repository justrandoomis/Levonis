/**
 * MIXED ARABIC / SORANI / ENGLISH TEXT, LAID OUT IN READING ORDER
 * (docs/bambu-import/I18N-DESIGN.md §B; the owner's note of 2026-10-16:
 * «مع مراعاه rtl النص المزدوج فيه كلمات مثل انكليزي وعربي، كردي وإنجليزي»).
 *
 * 1. THE DIRECTION OF A LINE IS DECIDED BY ITS SCRIPT (`scriptDir`): a line
 *    with any Arabic-script letter is `rtl`, every other line `ltr`. Never
 *    `dir="auto"` / `unicode-bidi: plaintext` for this: both take the FIRST
 *    strong character, and a translation that begins with a Latin name
 *    («AMS Hub مطلوب …») would be laid out LTR. In this catalogue Arabic script
 *    present means an ar/ckb translation; absent means the English fallback,
 *    which then reads left to right, as English should.
 * 2. INSIDE AN RTL LINE every Latin / number run is its own LTR isolate
 *    (`ltrRuns`, wrapped in `<bdi dir="ltr">` by src/components/ui/BidiText.tsx),
 *    so «256 × 256 × 256 mm», «220-240 V», «M3*21.5», «(SA011)», «4-Pin» and
 *    «X1 Series» keep their order — European numbers separated by neutrals
 *    otherwise reorder inside an RTL paragraph («× 389 × 458 مم 389»). A run
 *      - starts at a Latin letter, a digit, or one of ≤ ≥ < > ± ~ # + - − (mirrored
 *        or weak marks that must stay inside it, or ≤ would read as ≥);
 *      - continues through Latin letters, digits, spaces and . , : / \ × * + - – _ ' ’ " % ° ³ ² µ Ω & ( );
 *      - ends at a Latin letter, a digit, % ° ³ ² µ Ω ) or ";
 *      - leaves the Arabic sentence's trailing punctuation (. ، ؛ :) outside;
 *      - drops an unbalanced bracket: a ")" closing Arabic text stays in the RTL context.
 * 3. Numbers stay Western digits and units Latin (the translations' validator,
 *    packages/catalog/src/bambuImport/i18n.ts, refuses anything else); data
 *    never carries a bidi control character — isolation is the renderer's job.
 */

/** Any Arabic-script character (Arabic, Supplement, Extended-A, presentation forms). */
export const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export type Dir = 'rtl' | 'ltr';

/** `rtl` when the text holds any Arabic-script character, else `ltr`. */
export function scriptDir(s: string | null | undefined): Dir {
  return ARABIC_SCRIPT.test(String(s ?? '')) ? 'rtl' : 'ltr';
}

const LATIN = 'A-Za-z\\u00C0-\\u024F';
const START = new RegExp(`[${LATIN}0-9\\u2264\\u2265<>\\u00B1~#+\\-\\u2212]`);
const CONTINUE = new RegExp(`[${LATIN}0-9 \\u00A0.,:/\\\\\\u00D7*+\\-\\u2013_'\\u2019"%\\u00B0\\u00B3\\u00B2\\u00B5\\u03A9&()\\u2264\\u2265<>\\u00B1~#\\u2212]`);
const END = new RegExp(`[${LATIN}0-9%\\u00B0\\u00B3\\u00B2\\u00B5\\u03A9)"]`);

/** The run `s.slice(0, k)` cut back to its last end character, its brackets balanced; 0 when nothing is left. */
function runLength(s: string): number {
  let k = s.length;
  for (;;) {
    while (k > 0 && !END.test(s[k - 1])) k -= 1;
    if (k === 0) return 0;
    // Balance the brackets: a ')' without its '(' leaves the run, and so does a '(' never closed (with what follows).
    let depth = 0;
    let lastOpen = -1;
    let cut = -1;
    for (let i = 0; i < k; i++) {
      if (s[i] === '(') {
        if (depth === 0) lastOpen = i;
        depth += 1;
      } else if (s[i] === ')') {
        if (depth === 0) {
          cut = i;
          break;
        }
        depth -= 1;
      }
    }
    if (cut >= 0) {
      k = cut;
      continue;
    }
    if (depth > 0) {
      k = lastOpen;
      continue;
    }
    return k;
  }
}

/** The text cut into RTL stretches and LTR runs, in order (see the header, rule 2). Concatenated, it is the text. */
export function ltrRuns(s: string): Array<{ text: string; ltr: boolean }> {
  const out: Array<{ text: string; ltr: boolean }> = [];
  const text = String(s ?? '');
  let rtl = '';
  let i = 0;
  while (i < text.length) {
    if (START.test(text[i])) {
      let j = i;
      while (j < text.length && CONTINUE.test(text[j])) j += 1;
      const k = runLength(text.slice(i, j));
      if (k > 0) {
        if (rtl) out.push({ text: rtl, ltr: false });
        rtl = '';
        out.push({ text: text.slice(i, i + k), ltr: true });
        i += k;
        continue;
      }
    }
    rtl += text[i];
    i += 1;
  }
  if (rtl) out.push({ text: rtl, ltr: false });
  return out;
}
