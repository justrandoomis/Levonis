/**
 * WHAT A CUSTOMER MAY CALL THEMSELVES — the part that is about decency.
 *
 * `usernames.ts` next door answers a different question: whether a handle
 * impersonates the platform. This answers whether a name is something other
 * customers should have to read. The two lists stay apart because they protect
 * against different things and would be maintained by different reasoning —
 * `support` is not a rude word, and a rude word is not an impersonation.
 *
 * THE SCUNTHORPE PROBLEM IS THE WHOLE DIFFICULTY. A filter that looks for
 * «كس» anywhere inside a string rejects «كسرى» and «مكسور»; one that looks for
 * `ass` anywhere rejects `Cassandra` and `classic`. A false positive here is
 * not a cosmetic bug — it is a real customer, with their real name, told they
 * may not open an account, with no way to argue. So every term declares HOW it
 * may match:
 *
 *   WORD   — only as a whole word, between non-letters. Everything short or
 *            ambiguous lives here: «كس», «نيج» (inside «نيجيريا»), `ass`, `fk`.
 *   ANY    — anywhere inside the text. Only terms long and specific enough
 *            that no ordinary word contains them: `fuck`, «شرموط», «قحبه».
 *
 * EVASION IS SPELLING, NOT MEANING, so it is answered by normalising the text
 * rather than by listing every spelling:
 *
 *   * `normalizeText` (shared with search) lowercases, strips Arabic
 *     diacritics and tatweel, and folds أ إ آ → ا and ة → ه, so «قندرة» and
 *     «قندره» are one string and nobody has to list both.
 *   * A term matches with any letter REPEATED — `fuuuck`, `fuckkk` — built
 *     into the pattern rather than collapsed in the input, because collapsing
 *     repeats would turn `ass` into `as` and make it match everywhere.
 *   * ONE separator is allowed between letters — `f.u.c.k`, `f_u_c_k`,
 *     `f-u-c-k`. One, not any number: unlimited separators would let
 *     "Frank Underwood Clark Kent" match `fuck`.
 *   * Latin leetspeak is folded (`4`→a, `0`→o, `$`→s, `@`→a …) and the text is
 *     checked BOTH ways, so `sh1t` and `a$$` are caught while `ali2000` is
 *     still checked as itself.
 *
 * WHAT IS DELIBERATELY NOT FOLDED: the Arabizi digits `3`, `5`, `7`. They
 * stand for ع خ ح in the way Iraqis type Arabic in Latin letters, not for
 * Latin letters — folding `5`→s would turn «5ara» into `sara`, and rejecting
 * everyone named Sara to catch one insult is exactly the trade this module
 * exists to refuse. Those spellings are listed as terms of their own instead.
 *
 * THE LIST WILL ALWAYS BE INCOMPLETE. It is a seed, not an authority: the
 * owner adds to it at /api/admin/taxonomy/blocked-terms without a deploy,
 * because the words that actually get typed at an Iraqi shop are known in
 * Baghdad, not here.
 */

import { normalizeText } from './search/normalize';

/** How a term is allowed to match. See the module note. */
export type TermScope = 'word' | 'any';

export interface BlockedTerm {
  /** Normalised already — `normalizedBlockedSeed()` guarantees it. */
  term: string;
  scope: TermScope;
}

/**
 * Latin leetspeak only. Every entry here is a symbol standing for a LATIN
 * letter; the Arabizi digits are excluded on purpose (module note).
 */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
};

/** The characters a person puts between letters to break a filter. */
const SEPARATOR = '[\\s._\\-*·]?';

/**
 * ARABIC ATTACHES ITS ARTICLE TO THE WORD, so a whole-word rule that does not
 * know that misses «الحمار» while catching «حمار» — and whoever is being rude
 * types the article. Only the unambiguous particles are allowed, and only in
 * FRONT: single-letter «ب» would make «بكس» (box, in Iraqi speech) match «كس»,
 * and a SUFFIX group would make «خولة» and «زبيدة» — ordinary women's names —
 * match «خول» and «زب». Real names live in the suffixes; grammar lives in the
 * prefixes. So the prefixes are allowed and the suffixes are not, and the
 * suffixed insults the owner actually wants («كسمك») are listed in full.
 */
const ARABIC_PREFIX = '(?:وال|بال|ال|لل|و)?';

/**
 * The Latin equivalent, and the opposite shape: English inflects at the END,
 * and `asses`, `cunts`, `fucking` are the same word. Checked against the
 * Scunthorpe family before being allowed — `assess`, `asset`, `Dickens` and
 * `Sussex` all survive it, because what follows the group still has to be a
 * non-letter.
 */
const LATIN_SUFFIX = '(?:s|es|z|ed|er|ers|ing)?';

/** Does this term's first letter belong to the Arabic script? */
const isArabicTerm = (term: string): boolean => /[\u0600-\u06FF]/.test(term);

/**
 * The seed list. `scope` is the whole safety story — read the module note
 * before moving a term from `word` to `any`.
 */
export const BLOCKED_SEED: ReadonlyArray<BlockedTerm> = [
  // ---- English, unambiguous enough to match anywhere ---------------------
  { term: 'fuck', scope: 'any' },
  { term: 'fuk', scope: 'word' },
  { term: 'fuq', scope: 'any' },
  { term: 'phuck', scope: 'any' },
  { term: 'shit', scope: 'any' },
  { term: 'bitch', scope: 'any' },
  { term: 'cunt', scope: 'word' },
  { term: 'whore', scope: 'any' },
  { term: 'slut', scope: 'any' },
  { term: 'asshole', scope: 'any' },
  { term: 'bastard', scope: 'any' },
  { term: 'nigger', scope: 'any' },
  { term: 'nigga', scope: 'any' },
  { term: 'faggot', scope: 'any' },
  { term: 'wanker', scope: 'any' },
  { term: 'pussy', scope: 'any' },
  { term: 'dickhead', scope: 'any' },
  { term: 'motherfucker', scope: 'any' },
  { term: 'rapist', scope: 'word' },
  { term: 'porno', scope: 'any' },

  // ---- English, only as whole words -------------------------------------
  // `fk`, `fck`, `fak` are initials to somebody; `ass` is inside `class`;
  // `cock` is inside `cockpit`; `Dick` is a name.
  { term: 'fk', scope: 'word' },
  { term: 'fck', scope: 'word' },
  { term: 'fak', scope: 'word' },
  { term: 'ass', scope: 'word' },
  { term: 'arse', scope: 'word' },
  { term: 'cock', scope: 'word' },
  { term: 'dick', scope: 'word' },
  { term: 'tits', scope: 'word' },
  { term: 'hoe', scope: 'word' },
  { term: 'rape', scope: 'word' },
  { term: 'penis', scope: 'word' },
  { term: 'vagina', scope: 'word' },
  { term: 'porn', scope: 'word' },
  { term: 'sex', scope: 'word' },
  { term: 'stfu', scope: 'word' },
  { term: 'wtf', scope: 'word' },

  // ---- Arabic script, unambiguous enough to match anywhere --------------
  // Folding has already turned ة into ه, so one spelling covers both.
  { term: 'شرموط', scope: 'any' },
  { term: 'شرموطه', scope: 'any' },
  { term: 'قحبه', scope: 'any' },
  { term: 'كحبه', scope: 'any' },
  { term: 'منيوك', scope: 'any' },
  { term: 'منيوج', scope: 'any' },
  { term: 'منيوچ', scope: 'any' },
  { term: 'كسمك', scope: 'any' },
  { term: 'كسمج', scope: 'any' },
  { term: 'كسختك', scope: 'any' },
  { term: 'ديوث', scope: 'any' },
  { term: 'صرمايه', scope: 'any' },
  { term: 'عرصات', scope: 'word' },
  { term: 'طيزك', scope: 'any' },
  { term: 'زبي', scope: 'word' },
  { term: 'متناك', scope: 'any' },
  { term: 'خرائي', scope: 'any' },

  // ---- Arabic script, only as whole words -------------------------------
  // «كس» is inside «كسر» and «مكسور»; «نيج» is inside «نيجيريا»; «خرا» is
  // inside «خراب»; «بلاع» is a drain; «حمار» is an animal. Each is an insult
  // ONLY when it stands alone, which is exactly what `word` means.
  { term: 'كس', scope: 'word' },
  { term: 'كسم', scope: 'word' },
  { term: 'عير', scope: 'word' },
  { term: 'عيري', scope: 'word' },
  { term: 'ايري', scope: 'word' },
  { term: 'ايره', scope: 'word' },
  { term: 'نيج', scope: 'word' },
  { term: 'نيك', scope: 'word' },
  { term: 'نيچ', scope: 'word' },
  { term: 'خرا', scope: 'word' },
  { term: 'خره', scope: 'word' },
  { term: 'بلاع', scope: 'word' },
  { term: 'مطي', scope: 'word' },
  { term: 'حمار', scope: 'word' },
  { term: 'حمير', scope: 'word' },
  { term: 'قندره', scope: 'word' },
  { term: 'زربه', scope: 'word' },
  { term: 'طيز', scope: 'word' },
  { term: 'زب', scope: 'word' },
  { term: 'عرص', scope: 'word' },
  { term: 'خول', scope: 'word' },
  { term: 'لوطي', scope: 'word' },
  { term: 'زقه', scope: 'word' },

  // ---- Arabizi: Arabic typed in Latin letters and digits ----------------
  // This is how the words above are actually typed on a phone, and none of
  // them can be reached by folding — `5` is خ here, not `s`.
  { term: 'kos', scope: 'word' },
  { term: 'kus', scope: 'word' },
  { term: 'koss', scope: 'word' },
  { term: 'kosom', scope: 'any' },
  { term: 'kusom', scope: 'any' },
  { term: 'ayre', scope: 'word' },
  { term: 'ayri', scope: 'word' },
  { term: 'neek', scope: 'word' },
  { term: 'neik', scope: 'word' },
  { term: 'manyak', scope: 'any' },
  { term: 'manyuk', scope: 'any' },
  { term: 'sharmoot', scope: 'any' },
  { term: 'sharmota', scope: 'any' },
  { term: 'gahba', scope: 'any' },
  { term: 'qahba', scope: 'any' },
  { term: 'khara', scope: 'word' },
  { term: '5ara', scope: 'word' },
  { term: '7mar', scope: 'word' },
  { term: '3ars', scope: 'word' },
  { term: 'zobi', scope: 'word' },
  { term: 'zubi', scope: 'word' },
  { term: 'teez', scope: 'word' },

  // ---- Sorani Kurdish ---------------------------------------------------
  // Deliberately short. A wrong entry here rejects a real Kurdish name, and
  // the owner is far better placed than this file to extend it.
  { term: 'کیر', scope: 'word' },
  { term: 'قون', scope: 'word' },
  { term: 'کوس', scope: 'word' },
];

/** Fold Latin leetspeak. Runs BEFORE normalizeText, which would otherwise
 *  have already turned `@` and `$` into spaces. */
function foldLeet(s: string): string {
  let out = '';
  for (const ch of s) out += LEET[ch] ?? ch;
  return out;
}

/** The two forms a candidate is judged in: as written, and de-leeted. */
function comparableForms(raw: string): string[] {
  const plain = normalizeText(raw);
  const leet = normalizeText(foldLeet(String(raw ?? '').toLowerCase()));
  return leet && leet !== plain ? [plain, leet] : [plain];
}

const escapeRe = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `fuck` → `f+[\s._\-*·]?u+[\s._\-*·]?c+[\s._\-*·]?k+`
 *
 * Repetition is in the PATTERN rather than collapsed in the input, because
 * collapsing would turn `ass` into `as`. One optional separator between
 * letters, never more — see the module note.
 */
function patternFor(term: string, scope: TermScope): RegExp {
  const body = [...term].map(escapeRe).map((c) => `${c}+`).join(SEPARATOR);
  // `\b` is useless here: JavaScript defines it through [A-Za-z0-9_], so every
  // Arabic letter is a non-word character and every Arabic position is a
  // boundary. Lookarounds on the Unicode letter/number classes are the same
  // idea, correctly.
  if (scope !== 'word') return new RegExp(body, 'u');
  const prefix = isArabicTerm(term) ? ARABIC_PREFIX : '';
  const suffix = isArabicTerm(term) ? '' : LATIN_SUFFIX;
  return new RegExp(`(?<![\\p{L}\\p{N}])${prefix}(?:${body})${suffix}(?![\\p{L}\\p{N}])`, 'u');
}

/**
 * Compiled once per term list. The seed is constant, so the seed's patterns
 * are built at module load and reused for every request in the isolate.
 */
export function compileTerms(terms: ReadonlyArray<BlockedTerm>): RegExp[] {
  return terms.filter((t) => t.term).map((t) => patternFor(t.term, t.scope));
}

const SEED_PATTERNS = compileTerms(BLOCKED_SEED);

/**
 * Is this text something other customers should not have to read?
 *
 * `extra` carries the owner's own additions; omitting it checks the seed
 * alone, which is what happens when the table is not installed.
 */
export function isIndecent(raw: unknown, extra: RegExp[] = []): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const forms = comparableForms(raw);
  for (const form of forms) {
    if (!form) continue;
    for (const re of SEED_PATTERNS) if (re.test(form)) return true;
    for (const re of extra) if (re.test(form)) return true;
  }
  return false;
}

/**
 * The seed, normalised and de-duplicated, for the migration that installs it.
 *
 * THROWS on a term that claims two different scopes, rather than picking one:
 * two rows disagreeing about whether «كس» may match inside a word is the
 * difference between a filter that works and one that rejects «مكسور», and a
 * silent winner would hide that from whoever wrote the second line.
 */
export function normalizedBlockedSeed(): BlockedTerm[] {
  const out = new Map<string, TermScope>();
  for (const { term, scope } of BLOCKED_SEED) {
    const key = normalizeText(term);
    if (!key) continue;
    const existing = out.get(key);
    if (existing && existing !== scope) {
      throw new Error(`blocked term "${term}" is listed as both '${existing}' and '${scope}'`);
    }
    out.set(key, scope);
  }
  return [...out].map(([term, scope]) => ({ term, scope }));
}
