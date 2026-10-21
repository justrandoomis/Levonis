/**
 * THE TECHNICAL REVIEW AND THE ADMIN OFFER LINE, IN WORDS (plan P1-05,
 * docs/DECISIONS.md row 267; review 3). Pure, so the admin board and the
 * lazy review panel share them without the board pulling the panel in.
 *
 * Every word in Arabic, English and Sorani.
 */

import { localColour, localMaterial } from '../community/requests/mirrors';

type Loc = (ar: string, en: string, ckb?: string) => string;
export type ReviewLang = 'ar' | 'en' | 'ckb';

/** The admin language as the key of this file — Arabic unless English or Sorani. */
export const reviewLang = (lang: string | null | undefined): ReviewLang => (lang === 'en' || lang === 'ckb' ? lang : 'ar');

/**
 * A colour of a part as the reviewer reads it: «any colour», «as in the
 * reference», else the palette word in the language of the reviewer (the wizard
 * stores palette colours with their English word, review 4), a free-text
 * colour as written, or its hex.
 */
export function colourWord(c: { mode: string; hex: string; label: string }, loc: Loc, lang: ReviewLang = 'en'): string {
  if (c.mode === 'any') return loc('أي لون', 'any colour', 'هەر ڕەنگێک');
  if (c.mode === 'as_reference') return loc('كما في المرجع', 'as in the reference', 'وەک لە سەرچاوەکەدا');
  return localColour(c.label || c.hex, lang) || loc('لون بلا اسم', 'unnamed colour', 'ڕەنگی بێ ناو');
}

/** A catalogue material as the reviewer reads it: its name in the language of the reviewer, never the raw upper-case id. */
export const materialWord = (id: string, lang: ReviewLang): string => localMaterial(id, lang) || id;

/**
 * How long a request has waited, LABEL FIRST («أيام الانتظار: 3»), so the
 * Arabic never needs the number agreement «منذ 3 يوم» got wrong.
 */
export function reviewAge(iso: string, loc: Loc, now: number = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));
  if (!Number.isFinite(days) || days < 1) return loc('اليوم', 'today', 'ئەمڕۆ');
  return loc(`أيام الانتظار: ${days}`, `Days waiting: ${days}`, `ڕۆژانی چاوەڕوانی: ${days}`);
}

type Side = { material_id: string; colors?: Array<{ hex: string; label: string }> };

/** «{to} بدل {from}»: a word, never an arrow — an arrow points the other way once an RTL line reorders its runs. */
const INSTEAD: Record<ReviewLang, string> = { ar: 'بدل', en: 'instead of', ckb: 'لە جیاتی' };

/**
 * The two sides of a substitution on the admin offer line, in the language of
 * the reviewer: the catalogue name, and the colours by name when they change, so
 * a colour-only substitution never reads «PLA بدل PLA».
 */
export function adminSubstitutionSides(x: { from: Side; to: Side }, lang: ReviewLang): { to: string; from: string; word: string } {
  const sep = lang === 'en' ? ', ' : '، ';
  const colours = (cs: Side['colors']) => (cs ?? []).map((c) => localColour(c.label || c.hex, lang)).filter(Boolean).join(sep);
  const changed = JSON.stringify(x.to.colors ?? []) !== JSON.stringify(x.from.colors ?? []);
  const side = (v: Side) => [materialWord(v.material_id, lang), changed ? colours(v.colors) : ''].filter(Boolean).join(' ');
  return { to: side(x.to), from: side(x.from), word: INSTEAD[lang] };
}

/** «PETG بدل PLA» — the line the admin board shows (each side isolated there). */
export function adminSubstitutionText(x: { from: Side; to: Side }, lang: ReviewLang): string {
  const v = adminSubstitutionSides(x, lang);
  return `${v.to} ${v.word} ${v.from}`;
}
