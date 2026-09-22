/**
 * WHAT A CUSTOMER TYPED → WHAT THEY ASKED FOR.
 *
 * «التحدث عبر الدعم الالي ليس chat bot، هو غبي جدا. طور من الدعم الالي لجعله
 *  chatbot قوي ومتطور ويفهم كل شي.»
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE OLD MATCHER FELT STUPID, PRECISELY.
 *
 * It was `text.toLowerCase().includes(keyword)`, first hit wins, and the two
 * failures the owner photographed both fall straight out of that:
 *
 *   · «A1 combo» — typed immediately after the assistant itself had asked
 *     «أي منتج تريد تقارنه؟ اكتب اسم الطابعة» — matched no keyword, so the
 *     reply was «لم أفهم طلبك تمامًا». The assistant had asked a question and
 *     then forgotten that it asked. It was STATELESS.
 *
 *   · «ساعدني باختيار طابعه» — "help me choose a printer", the single most
 *     ordinary sentence in a printer shop — matched nothing either, because
 *     no intent existed for it and «طابعه» is not «طابعة».
 *
 * That second one is the whole problem in one word. Arabic is typed with
 * whatever the keyboard and the hurry produce: «طابعه» / «طابعة», «الضمان» /
 * «ضماني», «أجهزتي» / «اجهزتي», ٥ / 5, a Kurdish ک where an Arabic ك was
 * meant. A raw substring test treats every one of those as a different word.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS, AND WHAT IT IS DELIBERATELY NOT.
 *
 * It is a normaliser, a scorer and an extractor. It is NOT a model: there is
 * no network call, no generated text, no probability anybody has to trust. The
 * same sentence produces the same answer on every run, which is the property
 * that lets the route keep its own rule — an ambiguous match is answered with
 * CHOICES, never with a guess. A support assistant that invents an answer
 * about a warranty or a delivery date is worse than one that asks.
 *
 * Everything here is pure. No database, no context, no I/O — so every claim
 * below is a unit test rather than a paragraph.
 */

// ══════════════════════════════════════════════════════════ normalisation

/** Harakat, Quranic marks and the superscript alef. */
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
/** ـــــ, typed for emphasis and meaning nothing. */
const TATWEEL = /ـ/g;

/**
 * One letter per sound, so the same word typed three ways is one word.
 *
 * The Kurdish/Persian forms are folded onto the Arabic ones ON PURPOSE: this
 * shop's customers type «کارمەند» from a Kurdish layout and «كارمند» from an
 * Arabic one, and both mean "a member of staff". The LEXICON is normalised
 * through this same function at module load, so what matters is that the
 * mapping is consistent, not that it is etymologically right.
 */
const LETTERS: Record<string, string> = {
  'آ': 'ا', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا', // آ أ إ ٱ → ا
  'ى': 'ي', 'ئ': 'ي', 'ی': 'ي', // ى ئ ی → ي
  'ة': 'ه', 'ە': 'ه', // ة ە → ه
  'ؤ': 'و', // ؤ → و
  'ک': 'ك', // ک → ك
};

/** ٠١٢… and ۰۱۲… are the same digits as 012. */
function asciiDigit(ch: string): string | null {
  const code = ch.codePointAt(0)!;
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return null;
}

/**
 * Letters and digits survive; everything else becomes a gap.
 *
 * A UNICODE PROPERTY, NOT A RANGE TABLE, and the difference is not cosmetic.
 * The hand-written version admitted the whole Arabic block, and «؟» — the
 * Arabic question mark, U+061F — lives in that block. So «شنو حالة الطلب؟»
 * normalised to «شنو حاله الطلب؟», the question mark stayed glued to the last
 * word, and the phrase «حالة الطلب» could not match the sentence it was
 * written for. The same trap holds «،» and «؛».
 *
 * `\p{L}` and `\p{N}` know which Arabic code points are letters and which are
 * punctuation, and they will go on knowing it for scripts nobody here
 * anticipated.
 */
const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(ch: string): boolean {
  return WORD_CHAR.test(ch);
}

/**
 * The one shape every comparison in this module is made against.
 *
 * Lowercased, stripped of diacritics and tatweel, letter-folded, digits in
 * ASCII, and every punctuation mark turned into a single space — which is what
 * makes ` ups ` a safe thing to look for. The old dictionary carried a comment
 * apologising that a bare 'vs' would fire inside ordinary words; here it
 * cannot, because every match is between gaps.
 */
export function normalizeText(raw: string): string {
  const lowered = raw.toLowerCase().normalize('NFKC').replace(DIACRITICS, '').replace(TATWEEL, '');
  let out = '';
  for (const ch of lowered) {
    const digit = asciiDigit(ch);
    if (digit !== null) {
      out += digit;
      continue;
    }
    const letter = LETTERS[ch];
    if (letter !== undefined) {
      out += letter;
      continue;
    }
    out += isWordChar(ch) ? ch : ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function tokenize(normalized: string): string[] {
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

const ARABIC_CHAR = /[؀-ۿ]/;

/** True when `a` and `b` differ by at most one edit. Bounded and allocation
 *  free — this runs once per (stem, token) pair on a 500-character message. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (short.length === long.length) i += 1; // substitution
    j += 1; // insertion in `long`
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

// ══════════════════════════════════════════════════════════════ lexicon

export interface LexEntry {
  /**
   * Multi-word evidence, matched whole and between gaps. Worth much more than
   * a single word: «كم سعر» is a question about a price and almost nothing
   * else, while «سعر» alone appears in half the sentences in a shop.
   */
  phrases?: string[];
  /**
   * Single-word evidence.
   *
   * An ARABIC stem matches anywhere inside a token, because the definite
   * article and the possessive suffixes are glued on — «ضمان» has to reach
   * «الضمان» and «ضماني» without a list of inflections. A LATIN stem matches
   * the token or its prefix only, so `ups` cannot fire on `groups`.
   */
  stems?: string[];
}

interface CompiledStem {
  text: string;
  arabic: boolean;
}
interface CompiledIntent<I extends string> {
  intent: I;
  phrases: string[];
  stems: CompiledStem[];
}

/** A phrase hit is worth this much PER WORD in it. */
const PHRASE_WORD_POINTS = 3;
const STEM_EXACT_POINTS = 2;
/**
 * A PARTIAL HIT IS WORTH AS MUCH AS AN EXACT ONE, and that is the single most
 * important number in this file.
 *
 * «الضمان» is not a near-miss for «ضمان» — it is the same word carrying the
 * definite article, which is the commonest prefix in Arabic. Scored below the
 * confidence floor, «شنو حالة الضمان» came back as «لم أفهم طلبك تمامًا»,
 * which is exactly the complaint. What keeps this safe is not a lower score,
 * it is `MAX_CLITIC_GROWTH` below: a token may only be a few characters longer
 * than the stem it contains, so a short stem cannot ride inside a long
 * unrelated word.
 */
const STEM_PARTIAL_POINTS = 2;
const STEM_FUZZY_POINTS = 1.5;

/** Below this, nothing is confident enough to act on. */
export const CONFIDENT_SCORE = 2;
/**
 * How far ahead the winner has to be. At 1.5, «مقارنة سعر الطابعة» — which
 * genuinely names two intents — asks rather than picking the one that happened
 * to be listed first, and that is the behaviour this route has always had.
 */
export const DECISIVE_RATIO = 1.5;
/** A stem shorter than this cannot be matched loosely; it is noise. */
const MIN_ARABIC_PARTIAL = 3;
const MIN_LATIN_PREFIX = 4;
const MIN_FUZZY = 5;
/**
 * How much longer than its stem an inflected token may be: ال + ـي / ـنا /
 * ـكم / ـها is four characters at the outside. This is what stops «جهاز»
 * matching a word that merely happens to contain those letters.
 */
const MAX_CLITIC_GROWTH = 4;

/**
 * A ONE-WORD PHRASE BECOMES A STEM, rather than being quietly discarded.
 *
 * The old dictionary carried `' vs '` — spaces and all — with a comment
 * explaining that a bare `vs` would fire inside ordinary words. Normalisation
 * strips those spaces, so a filter for "phrases contain a space" would have
 * thrown that entry away and «A1 vs P1S» would have matched nothing at all: a
 * lexicon entry that silently does nothing is worse than one that is wrong,
 * because nothing ever fails. As a stem it is matched as a whole token, which
 * is what the spaces were for.
 */
export function compileLexicon<I extends string>(lexicon: Record<I, LexEntry>): CompiledIntent<I>[] {
  return (Object.keys(lexicon) as I[]).map((intent) => {
    const entry = lexicon[intent];
    const phrases: string[] = [];
    const stemSource = [...(entry.stems ?? [])];
    for (const phrase of entry.phrases ?? []) {
      const normalized = normalizeText(phrase);
      if (!normalized) continue;
      if (normalized.includes(' ')) phrases.push(normalized);
      else stemSource.push(normalized);
    }
    return {
      intent,
      phrases,
      stems: stemSource
        .map(normalizeText)
        .filter(Boolean)
        .map((text) => ({ text, arabic: ARABIC_CHAR.test(text) })),
    };
  });
}

export interface IntentScore<I extends string> {
  intent: I;
  score: number;
}

/** How much one stem is worth against this message — its best single hit. */
function stemPoints(stem: CompiledStem, tokens: string[]): number {
  let best = 0;
  for (const token of tokens) {
    if (token === stem.text) return STEM_EXACT_POINTS;
    if (stem.arabic) {
      if (
        stem.text.length >= MIN_ARABIC_PARTIAL &&
        token.length - stem.text.length <= MAX_CLITIC_GROWTH &&
        token.includes(stem.text)
      ) {
        best = Math.max(best, STEM_PARTIAL_POINTS);
      }
    } else if (
      stem.text.length >= MIN_LATIN_PREFIX &&
      token.length - stem.text.length <= MAX_CLITIC_GROWTH &&
      token.startsWith(stem.text)
    ) {
      best = Math.max(best, STEM_PARTIAL_POINTS);
    }
    if (
      best < STEM_FUZZY_POINTS &&
      stem.text.length >= MIN_FUZZY &&
      token.length >= MIN_FUZZY &&
      withinOneEdit(stem.text, token)
    ) {
      best = Math.max(best, STEM_FUZZY_POINTS);
    }
  }
  return best;
}

/** Every intent with any evidence, best first. Ties keep lexicon order, so the
 *  result is stable for the same input on every run. */
export function scoreIntents<I extends string>(raw: string, compiled: CompiledIntent<I>[]): IntentScore<I>[] {
  const normalized = normalizeText(raw);
  if (!normalized) return [];
  const padded = ` ${normalized} `;
  const tokens = tokenize(normalized);
  const out: IntentScore<I>[] = [];
  for (const item of compiled) {
    let score = 0;
    for (const phrase of item.phrases) {
      if (padded.includes(` ${phrase} `)) score += PHRASE_WORD_POINTS * (phrase.split(' ').length);
    }
    for (const stem of item.stems) score += stemPoints(stem, tokens);
    if (score > 0) out.push({ intent: item.intent, score });
  }
  // Stable: a plain comparator over an array built in lexicon order.
  return out.sort((a, b) => b.score - a.score);
}

export interface IntentDecision<I extends string> {
  /** The one intent to act on, or null when nothing was clear enough. */
  intent: I | null;
  /** When `intent` is null and this is non-empty: the shortlist to ASK about. */
  shortlist: I[];
}

/** At most this many choices in a "did you mean" — a phone screen, not a menu. */
const SHORTLIST_MAX = 4;

/**
 * Confident, ambiguous, or unknown — and never anything else.
 *
 * The middle case is the one that matters: a sentence naming two intents is
 * answered with both as choices. Picking the higher score there would be a
 * guess dressed as an answer, which is the single thing this route has always
 * refused to do.
 */
export function decideIntent<I extends string>(scores: IntentScore<I>[]): IntentDecision<I> {
  const strong = scores.filter((s) => s.score >= CONFIDENT_SCORE);
  if (strong.length === 1) return { intent: strong[0].intent, shortlist: [] };
  if (strong.length > 1) {
    if (strong[0].score >= strong[1].score * DECISIVE_RATIO) return { intent: strong[0].intent, shortlist: [] };
    const floor = strong[0].score / DECISIVE_RATIO;
    return { intent: null, shortlist: strong.filter((s) => s.score >= floor).slice(0, SHORTLIST_MAX).map((s) => s.intent) };
  }
  /**
   * NOTHING WAS CONFIDENT, BUT SOMETHING CAME CLOSE — «waranty check».
   *
   * The near miss is offered as the shortlist. Acting on it would be a guess
   * about somebody's warranty; showing the full fourteen-item menu instead,
   * which is what used to happen, throws away the one useful thing the
   * scorer just worked out. One chip reading «حالة الضمان» is a question, and
   * it is one tap.
   */
  if (scores.length > 0) return { intent: null, shortlist: scores.slice(0, SHORTLIST_MAX).map((s) => s.intent) };
  return { intent: null, shortlist: [] };
}

// ══════════════════════════════════════════════════════════════ entities

/**
 * «وين طلبي ORD-8F21» — the id, whatever it is wrapped in.
 *
 * Read from the RAW text, not the normalised one, because normalisation turns
 * the hyphen into a gap; and upper-cased, because that is how the column
 * stores it. A bare «8F21» is deliberately NOT an order id: it is far more
 * likely to be a printer model.
 */
export function extractOrderId(raw: string): string | null {
  const match = /\bORD[-_\s]?([A-Za-z0-9]{3,24})\b/i.exec(raw);
  return match ? `ORD-${match[1].toUpperCase()}` : null;
}

/**
 * The residue after the question words are taken out — «شكد سعر A1 combo»
 * leaves «a1 combo», which is the thing to look up.
 *
 * Words are removed as WHOLE TOKENS. Removing them as substrings would eat
 * the middle of a model name, and the model name is the entire point of the
 * exercise.
 */
export function stripWords(raw: string, words: readonly string[]): string {
  const drop = new Set(words.map(normalizeText).filter(Boolean));
  const phrases = [...drop].filter((w) => w.includes(' '));
  let text = ` ${normalizeText(raw)} `;
  for (const phrase of phrases) text = text.split(` ${phrase} `).join(' ');
  return tokenize(text.trim())
    .filter((token) => !drop.has(token))
    .join(' ')
    .trim();
}

/**
 * Could this be the name of something we sell?
 *
 * The bar is low and deliberately so: the route's fallback is to LOOK, and the
 * catalogue is the authority on whether «A1 combo» is a product. This only
 * keeps obvious non-lookups — an empty message, or a paragraph — out of a
 * query that would match nothing anyway.
 */
export function isLikelyCatalogueLookup(raw: string): boolean {
  const tokens = tokenize(normalizeText(raw));
  if (tokens.length === 0 || tokens.length > 6) return false;
  return tokens.some((t) => t.length >= 2);
}
