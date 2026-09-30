/**
 * THE STUDIO'S WORDS — ARABIC, ENGLISH AND WRITTEN SORANI (Programme C, phase
 * C1; docs/LEVO_PROJECT_PROGRAMME.md §B.1 P12, survey §5.4 «Strings»).
 *
 * What the customer reads while they personalize a product: the five row
 * controls, the panels, the one-line verdict and its fixes, the price. The
 * engine's own words (colours, looks, styles, themes, kinds, tiers, targets,
 * part kinds) are NOT here — they come from packages/catalog/src/personalize
 * (`word(X_WORDS, …)`, `colorWord`, `partKindWord`) and are never
 * re-translated. The sentences for the engine's closed codes live here:
 * one per check code (and a «would you like to» form for a fix that costs
 * money), one per rule explanation, one per «Make it better» suggestion.
 *
 * CUSTOMER VOCABULARY (P12, tests/personalizeUi.test.ts and, from L10,
 * tests/customerVocabulary.test.ts): shopper words only — never the
 * workshop's file, machine or geometry words, in any of the three languages.
 * The five row labels reuse the app's existing human Sorani: ناو ·
 * ڕەنگەکان · قەبارە · زیاتر · زیادکردن بۆ سەبەتە · داوای چاپکردنی بکە.
 *
 * `{placeholders}` are filled at render time and appear in all three languages.
 *
 * ONE LANGUAGE AT A TIME: this file is the shape (`StudioWords`), `fill` and
 * the loader; the words themselves are ./strings.ar.ts, ./strings.en.ts and
 * ./strings.ckb.ts, each its own chunk, and the studio reads the one on the
 * screen through `use(studioWords(lang))` (the Personalize chunk carries none
 * of them: survey §5.1 «Personalize (studio core + strings) ≤ 20 KB»).
 */
import type { CheckCode, SayCode } from '../../../packages/catalog/src/personalize/types';
import type { BetterCode } from '../../../packages/catalog/src/personalize/suggest';

export type StudioLang = 'ar' | 'en' | 'ckb';

/** Fill `{name}` placeholders. */
export const fill = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] === undefined ? m : String(values[k])));

type Sentences<K extends string> = Record<K, string>;

export interface StudioWords {
  // The top bar and the stage.
  close: string;
  options: string;
  startOver: string;
  undo: string;
  resetView: string;
  preview: string;
  previewChip: string;
  stageLabel: string;
  partColour: string;
  textOn: string;
  loading: string;
  noLive: string;
  showLive: string;
  saveData: string;
  unavailable: string;
  unavailableHint: string;
  // The row: tiles and the door.
  tiles: Record<'name' | 'text' | 'photo' | 'logo' | 'qr' | 'icon' | 'look' | 'size' | 'addons' | 'more', string>;
  controls: string;
  add: string;
  added: string;
  pages: string;
  door: Record<'add_to_cart' | 'request' | 'ask', string>;
  doorBlocked: string;
  doorPreview: string;
  price: string;
  // The verdict line.
  ready: string;
  apply: string;
  useSize: string;
  useOption: string;
  better: string;
  fixIt: string;
  // Name.
  entry: string;
  left: string;
  lettersOnly: string;
  style: string;
  icon: string;
  none: string;
  // Look.
  themes: string;
  chooseForMe: string;
  tryAnother: string;
  surprise: string;
  parts: string;
  colourOf: string;
  plate: Record<'name' | 'text', string>;
  addPiece: string;
  matched: string;
  approx: string;
  look: string;
  tier: string;
  // Size.
  sizes: readonly string[];
  recommended: string;
  dims: string;
  soldOut: string;
  samePrice: string;
  // More, and its pages.
  more: string;
  back: string;
  nfc: string;
  notes: string;
  notesHint: string;
  ask: string;
  askHint: string;
  required: string;
  addPhoto: string;
  addLogo: string;
  change: string;
  remove: string;
  localOnly: string;
  qrField: Record<'handle' | 'phone' | 'link' | 'text', string>;
  qrCheck: string;
  scansWell: string;
  reorderLater: string;
  shopSees: string;
  // The engine's closed codes.
  check: Sentences<CheckCode>;
  checkAsk: Sentences<'COLOR_MATCHED' | 'COLORS_MERGED' | 'CONTRAST_FIXED' | 'TEXT_STYLE_BOLDER' | 'TEXT_FITTED' | 'LOGO_SIMPLIFIED' | 'QR_ENLARGED'>;
  missing: Sentences<'texts' | 'logo' | 'photo' | 'qr' | 'icon' | 'slots'>;
  say: Sentences<SayCode>;
  betterSay: Sentences<BetterCode>;
}

/** The language the studio speaks for an app language (anything else reads Arabic). */
export const studioLang = (lang: string): StudioLang => (lang === 'en' || lang === 'ckb' ? lang : 'ar');

const loading: Partial<Record<StudioLang, Promise<StudioWords>>> = {};

/**
 * One language's words, loaded once and kept (the same promise every time, so
 * React's `use` reads it synchronously once it has resolved). Each language
 * is a chunk of its own: the studio never carries the two it is not showing.
 */
export function studioWords(lang: string): Promise<StudioWords> {
  const l = studioLang(lang);
  let p = loading[l];
  if (!p) {
    const next = (l === 'en' ? import('./strings.en') : l === 'ckb' ? import('./strings.ckb') : import('./strings.ar')).then((m) => m.default);
    loading[l] = p = next;
    // A failed load (a dropped connection) is tried again the next time.
    next.catch(() => {
      if (loading[l] === next) delete loading[l];
    });
  }
  return p;
}
