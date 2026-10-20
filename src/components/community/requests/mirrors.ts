/**
 * THE JOB'S MATERIAL AND COLOUR IN THE READER'S LANGUAGE (Community V3 R8).
 *
 * A request keeps two plain mirrors on its row, `material` and `color`, for
 * every list that cannot join the print facts: the board, the hub card, the
 * details, «طلباتي», the chat deal card. They are written in ENGLISH — the
 * catalogue name (`name_en`) and the wizard colour word — because the
 * colour name is one of the facts merchants price (`color_name` in
 * REVISION_FIELDS): writing it in the customer language would make the same
 * job read as a different job to the revision hash. So the stored word stays
 * the canonical key, and every screen renders it through this table:
 *
 *   a colour from the wizard palette, by its English word or its hex;
 *   a material from the seed catalogue (worker/lib/printPricing.ts) or from
 *   the live catalogue a screen already holds (`name_ar` for Arabic);
 *   anything else — free text from a chat request, a material the owner
 *   added later — is shown as written, never guessed at.
 *
 * Sorani is written here, never the Arabic standing in for it (row 183); a
 * technical name with no Sorani form (PLA, PETG) is the same in every
 * language.
 */

import { REQUEST_PALETTE } from '../../../../packages/contracts/src/requestModel';

type Lang = 'ar' | 'en' | 'ckb';

export interface RequestColour {
  hex: string;
  ar: string;
  en: string;
  ckb: string;
}

/** The palette's names, by its contract key. */
const PALETTE_NAMES: Readonly<Record<string, { ar: string; en: string; ckb: string }>> = {
  black: { ar: 'أسود', en: 'Black', ckb: 'ڕەش' },
  white: { ar: 'أبيض', en: 'White', ckb: 'سپی' },
  grey: { ar: 'رمادي', en: 'Grey', ckb: 'خۆڵەمێشی' },
  red: { ar: 'أحمر', en: 'Red', ckb: 'سوور' },
  blue: { ar: 'أزرق', en: 'Blue', ckb: 'شین' },
  green: { ar: 'أخضر', en: 'Green', ckb: 'سەوز' },
  yellow: { ar: 'أصفر', en: 'Yellow', ckb: 'زەرد' },
};

/**
 * The wizard colours, in the order it offers them — the merchant reads the
 * word, not only the swatch. The keys and hexes are the contract's palette
 * (packages/contracts/src/requestModel.ts), the one the server matches a
 * stored colour against; the names live here.
 */
export const REQUEST_COLOURS: readonly RequestColour[] = REQUEST_PALETTE.map((c) => ({ hex: c.hex, ...PALETTE_NAMES[c.key] }));

/** The seed catalogue (worker/lib/printPricing.ts `DEFAULT_MATERIALS`): id, the English name the mirror carries, Arabic, Sorani. */
const SEED_MATERIALS: ReadonlyArray<{ id: string; en: string; ar: string; ckb: string }> = [
  { id: 'pla', en: 'PLA', ar: 'PLA', ckb: 'PLA' },
  { id: 'petg', en: 'PETG', ar: 'PETG', ckb: 'PETG' },
  { id: 'abs', en: 'ABS', ar: 'ABS', ckb: 'ABS' },
  { id: 'asa', en: 'ASA', ar: 'ASA', ckb: 'ASA' },
  { id: 'tpu', en: 'TPU', ar: 'TPU مرن', ckb: 'TPU نەرم' },
  { id: 'pa', en: 'PA (Nylon)', ar: 'نايلون PA', ckb: 'نایلۆن PA' },
  { id: 'pc', en: 'PC', ar: 'بولي كربونيت PC', ckb: 'پۆلی کاربۆنەیت PC' },
  { id: 'pla-cf', en: 'PLA-CF', ar: 'PLA كربون', ckb: 'PLA کاربۆن' },
  { id: 'petg-cf', en: 'PETG-CF', ar: 'PETG كربون', ckb: 'PETG کاربۆن' },
  { id: 'pa-cf', en: 'PA-CF', ar: 'نايلون كربون', ckb: 'نایلۆن کاربۆن' },
  { id: 'resin-standard', en: 'Standard Resin', ar: 'ريزن قياسي', ckb: 'ڕێزنی ستاندارد' },
  { id: 'resin-abs-like', en: 'ABS-Like Resin', ar: 'ريزن شبيه ABS', ckb: 'ڕێزنی وەک ABS' },
  { id: 'resin-tough', en: 'Tough Resin', ar: 'ريزن متين', ckb: 'ڕێزنی بەهێز' },
  { id: 'resin-flexible', en: 'Flexible Resin', ar: 'ريزن مرن', ckb: 'ڕێزنی نەرم' },
  { id: 'resin-washable', en: 'Water Washable Resin', ar: 'ريزن يغسل بالماء', ckb: 'ڕێزنی بە ئاو شۆراو' },
  { id: 'resin-castable', en: 'Castable Resin', ar: 'ريزن للصب', ckb: 'ڕێزنی قاڵبڕێژی' },
  { id: 'resin-high-temp', en: 'High Temp Resin', ar: 'ريزن حراري', ckb: 'ڕێزنی بەرگەگری گەرما' },
  { id: 'resin-clear', en: 'Clear Resin', ar: 'ريزن شفاف', ckb: 'ڕێزنی ڕوون' },
];

/** A catalogue row as the screens already hold it. */
export interface MaterialLike {
  id?: string;
  name_en: string;
  name_ar?: string;
}

const key = (s: string) => s.trim().toLowerCase();

/**
 * A material in the reader's language — from its id (a print fact) or from
 * the English mirror. The live catalogue gives the Arabic the owner wrote; the
 * seed table gives the Sorani; a name neither knows is shown as written.
 */
export function localMaterial(value: string | null | undefined, lang: Lang, catalogue: readonly MaterialLike[] = []): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const k = key(raw);
  const row = catalogue.find((m) => (m.id && key(m.id) === k) || key(m.name_en) === k);
  const seed = SEED_MATERIALS.find((m) => m.id === k || key(m.en) === k || (row && key(m.en) === key(row.name_en)));
  const en = row?.name_en || seed?.en || raw;
  if (lang === 'en') return en;
  if (lang === 'ckb') return seed?.ckb ?? en;
  return row?.name_ar || seed?.ar || en;
}

/** The palette entry for a stored colour word or hex, if it is one of the wizard colours. */
export function requestColour(value: string | null | undefined): RequestColour | null {
  const raw = key(String(value ?? ''));
  if (!raw) return null;
  return REQUEST_COLOURS.find((c) => key(c.en) === raw || c.hex === raw || key(c.ar) === raw) ?? null;
}

/** A colour in the reader's language; free text is shown as written. */
export function localColour(value: string | null | undefined, lang: Lang): string {
  const raw = String(value ?? '').trim();
  const c = requestColour(raw);
  return c ? c[lang] : raw;
}
