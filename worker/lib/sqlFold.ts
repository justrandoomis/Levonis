/**
 * ONE ARABIC FOLD, TWO LANGUAGES, GENERATED FROM ONE TABLE.
 *
 * The admin order board searches a customer's name inside SQLite, so the fold
 * that makes «فاطمه» match «فاطمة» has to exist TWICE: once as a SQL
 * expression over the column, and once in TypeScript over what the admin
 * typed. Both sides must agree exactly — a query folded differently from the
 * column simply does not match it.
 *
 * ############################################################################
 * #  THE DEFECT THIS FILE EXISTS TO PREVENT                                  #
 * ############################################################################
 * Two hand-maintained copies of a twenty-entry Arabic map WILL drift. Somebody
 * adds ٱ to one of them, or fixes the Kurdish ە in the SQL and not in the
 * TypeScript. And when they drift NOTHING THROWS: the search keeps returning
 * 200, keeps returning rows for every other name, and silently returns zero
 * for names containing the drifted letter. That is not a bug anyone finds in
 * review or in a log — it is found when a customer rings to ask why nobody can
 * see their order.
 *
 * So both forms are GENERATED, in this file, by walking ONE list. There is no
 * second copy of the mapping to keep in step, and `tests/orderSearch.test.ts`
 * runs the generated SQL through a real SQLite and asserts character-for-
 * character agreement with the TypeScript twin on a corpus of Arabic names.
 *
 * ---------------------------------------------------------------------------
 *  WHAT THIS FOLD DELIBERATELY DOES *NOT* DO, AND THE LOSS THAT BUYS
 * ---------------------------------------------------------------------------
 * `normalizeText` in ./search/normalize.ts does three more things: Unicode NFD
 * decomposition to strip Latin accents, Unicode-aware lower-casing, and
 * collapsing punctuation to single spaces. SQLite can do NONE of them —
 * `lower()` is ASCII-only, there is no NFD, and a punctuation class would be a
 * REPLACE chain with no end.
 *
 * A QUERY MAY NEVER BE FOLDED HARDER THAN THE COLUMN. If the typed term were
 * run through `normalizeText` and the column only through this, the term would
 * come out shorter than anything the column can produce and match nothing. So
 * this fold is the WEAKER of the two, and the term goes through THIS one.
 *
 * SAID OUT LOUD, BECAUSE IT IS AN ACCEPTED LOSS: «Créality» typed with the
 * accent will NOT find a row storing «Creality», and a name stored with a
 * hyphen will not be found by typing a space. Arabic orthography — hamza, ta
 * marbuta, alef maqsura, tashkeel, the Kurdish letters — is what this search is
 * for, and that is what it covers. Nobody should "fix" the accent case here by
 * folding the term harder; that breaks every Arabic match to rescue one Latin
 * one.
 */
import { FOLD } from './search/normalize';

/**
 * Marks removed before anything else, as literal characters rather than the
 * range `normalizeText` uses.
 *
 * WHY A LIST AND NOT THE RANGE. SQL `REPLACE` takes one string, not a class,
 * so every character removed costs one nested call. `ARABIC_DIACRITICS` covers
 * U+064B–U+0670 and U+06D6–U+06ED — around fifty codepoints, which would make
 * an expression far past the point of being readable or fast, to catch marks
 * (Quranic annotation signs, the small high seen) that do not appear in a name
 * typed into a delivery address.
 *
 * These ten are the ones an Arabic or Kurdish keyboard actually produces: the
 * eight tashkeel marks, the superscript alef, and the tatweel that word
 * processors insert for justification. A name carrying anything outside this
 * list is folded by `normalizeText` and not by this pair — which costs a match,
 * never a wrong one, because BOTH sides here skip it identically.
 */
const STRIP = [
  'ً', // ً  fathatan
  'ٌ', // ٌ  dammatan
  'ٍ', // ٍ  kasratan
  'َ', // َ  fatha
  'ُ', // ُ  damma
  'ِ', // ِ  kasra
  'ّ', // ّ  shadda
  'ْ', // ْ  sukun
  'ٰ', // ٰ  superscript alef
  'ـ', // ـ  tatweel
] as const;

/**
 * The whole fold, as an ordered list of (from, to) replacements. Both
 * generators walk exactly this, in exactly this order.
 *
 * STRIPS COME FIRST, matching `normalizeText`, which removes the marks before
 * it maps letters. One consequence is worth naming so it is not "fixed" later:
 * the table's `'يّ' → 'ي'` entry is INERT after the strip, because the shadda
 * it matches on has already gone. It is inert in BOTH generated forms, for the
 * same reason, which is the point — a dead rule that is dead identically on
 * both sides cannot cause a mismatch.
 *
 * ORDER IS SAFE TO APPLY SEQUENTIALLY, and that is what lets a per-character
 * map be expressed as nested REPLACEs at all: no target of a replacement is
 * the source of another (the targets are ا ه ي و ك; none of those is a key).
 * If anyone adds an entry whose TO is also a FROM, sequential application
 * stops equalling the per-character map and the two forms will still agree
 * with each other but no longer with `normalizeText`.
 */
const STEPS: readonly (readonly [string, string])[] = [
  ...STRIP.map((ch) => [ch, ''] as const),
  ...Object.entries(FOLD).map(([from, to]) => [from, to] as const),
];

/** A SQL string literal. Nothing in STEPS contains a quote; escaped anyway. */
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * A SQL expression that folds `expr` — a column, or any expression producing
 * text — for comparison against a term put through `foldForSql`.
 *
 * `lower()` IS ASCII-ONLY IN SQLITE, and that is deliberate here rather than
 * merely tolerated: `foldForSql` lower-cases ASCII and nothing else, so the
 * two agree. Using JavaScript's `toLowerCase()` on the term would fold «İ» and
 * accented Latin that SQLite leaves alone, and the term would stop matching.
 *
 * The caller decides what `expr` is; a JSON extraction MUST already be guarded
 * (see the note on `json_valid` at the board query) because `json_extract`
 * over non-JSON THROWS and takes the whole statement with it.
 */
export function arabicFoldSql(expr: string): string {
  let out = `lower(${expr})`;
  for (const [from, to] of STEPS) out = `REPLACE(${out},${lit(from)},${lit(to)})`;
  return out;
}

/**
 * The TypeScript twin: what the admin typed, folded the SAME way the column
 * is, so the two can be compared.
 *
 * NOT `normalizeText`. See this module's header — that one folds harder than
 * SQLite can, and a term folded harder than the column matches nothing.
 */
export function foldForSql(s: unknown): string {
  let out = String(s ?? '').replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  for (const [from, to] of STEPS) out = out.split(from).join(to);
  return out;
}

/**
 * Separators stripped from a stored phone string so a digits-only suffix
 * comparison is possible in SQL.
 *
 * WHY STORED PHONES ARE NOT ALREADY DIGITS. `orders.address_snapshot` is a
 * frozen JSON copy of the address row as it stood at checkout, and orders
 * placed before the address validator normalised phones carry shapes like
 * `+964-0770 123 4567`. The snapshot is history and is never rewritten, so the
 * search has to meet it where it is.
 *
 * ARABIC-INDIC DIGITS ARE NOT HANDLED HERE. `phone.ts` folds ٠-٩ to ASCII on
 * the way IN, so a stored value containing them would predate that fold on
 * every path that writes an address. Ten more REPLACEs to cover a shape that
 * has never been written is not a trade worth making; the E.164 equality on
 * `users.phone_e164` still finds those rows.
 */
const PHONE_SEPARATORS = [' ', '-', '(', ')', '+', '.', '‎', '‏', ' '] as const;

/**
 * A SQL expression reducing `expr` to its ASCII digits, for the suffix match
 * described in the phone clause of the board query.
 *
 * `+964-0770 123 4567` and `+9647701234567` both reduce to a string ENDING in
 * the same national number, which is the whole reason a suffix match is used
 * there rather than equality.
 */
export function phoneDigitsSql(expr: string): string {
  let out = expr;
  for (const sep of PHONE_SEPARATORS) out = `REPLACE(${out},${lit(sep)},'')`;
  return out;
}
