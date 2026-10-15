/**
 * THE SENTENCE CLASSIFIER (spec §C.10 layer 1, §C.3 variant notes).
 *
 * Every sentence of every prose field is labelled; money, promotion and US
 * shipping-policy sentences are removed, manufacturer warranty / return /
 * refund sentences are withheld from customer content (kept owner-only,
 * L-19), and voltage purchase advice is region evidence (not shown). Hits are
 * reported as COUNTS only — a sentence never reaches a log as text.
 *
 * The money branch is limited to currency forms on purpose (review finding
 * 11): "Prints come off easily … 35℃ or lower" is technical and kept.
 */

export type SentenceClass = 'money' | 'promotion' | 'shipping_policy' | 'warranty' | 'region' | 'keep';

const MONEY: readonly RegExp[] = [
  /(?:US)?\$\s?\d/i,
  /\$\s?\[redacted\]/i, // the fixtures' scrubbed amounts
  /\d[\d,.]*\s*(?:USD|US dollars?|dollars?)\b/i,
  /\bUSD\s?\d/i,
  /\bprice\b[^.!?]{0,40}\d/i,
  /\bprice[\s-](?:protection|match(?:ing)?|adjustment|drop|guarantee)\b/i,
  /\b(?:typical|original|regular|list|compare[- ]at)\s+price\b/i,
];

const PROMOTION: readonly RegExp[] = [
  /\bdiscount(?:s|ed)?\b/i,
  /\bcoupons?\b/i,
  /\bdeals?\b/i,
  /\bfree shipping\b/i,
  /\bon sale\b/i,
  /\bsale price\b/i,
  /\blimited[\s-]time\b/i,
  /\bsave\s+(?:on|up\s+to|\$|\d)/i,
  /\d+\s*%\s*off\b/i,
  /\boff\s+(?:US)?\$\s?\d/i,
  /\bbuy\s+(?:one|\d+)\s+get\b/i,
  /\bflash sale\b/i,
  /\bpromo(?:tion|tional)?\s+code\b/i,
  /\bexclusive (?:offer|price)\b/i,
];

const SHIPPING_POLICY: readonly RegExp[] = [
  /\bshipping costs?\b/i,
  /\bships? within\b/i,
  /\bdelivery times?\b/i,
  /\bpackaging may vary\b/i,
  /\borders? placed\b/i,
  /\breturn shipping\b/i,
  /\bshipping (?:fee|policy|rates?)\b/i,
  /\bdispatched within\b/i,
];

const WARRANTY: readonly RegExp[] = [
  /\bwarrant(?:y|ies)\b/i,
  /\b(?:money[\s-]back|satisfaction)\s+guarantee\b/i,
  /\bguarantee\s+(?:period|policy|card|terms|coverage)\b/i,
  /\b\d+[\s-](?:year|month|day)s?\s+guarantee\b/i,
  /\b\d+[\s-]day\s+returns?\b/i,
  /\breturns?\b[^.!?]{0,40}\b(?:policy|period|window|within|accepted|eligible|label|request)\b/i,
  /\brefunds?\b/i,
  /\bRMA\b/,
  /\bdefective\b[^.!?]*\bcovered\b/i,
  /\bafter[\s-]sales?\b/i,
];

const REGION: readonly RegExp[] = [
  /purchase the version corresponding to your region/i,
  /\bregion'?s voltage\b/i,
  /\bpurchase a transformer\b/i,
];

/** The class of one sentence. Removal beats withholding: money > promotion > shipping policy > warranty > region. */
export function classifySentence(s: string): SentenceClass {
  if (MONEY.some((re) => re.test(s))) return 'money';
  if (PROMOTION.some((re) => re.test(s))) return 'promotion';
  if (SHIPPING_POLICY.some((re) => re.test(s))) return 'shipping_policy';
  if (WARRANTY.some((re) => re.test(s))) return 'warranty';
  if (REGION.some((re) => re.test(s))) return 'region';
  return 'keep';
}

/**
 * Splits prose into sentences: at `.`, `!`, `?` (or `。`) followed by space and
 * a capital, a digit or an opening mark, and at line breaks. Decimals (1.75),
 * abbreviations followed by a lower-case word (e.g. approx.) and ellipses
 * inside a sentence are not boundaries.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/(?<=[.!?。])\s+(?=["“(‘'A-Z0-9*•-])/);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export interface ScrubResult {
  /** The text with removed, withheld and region sentences taken out (lines kept). */
  kept: string;
  /** Sentence counts per class (never the text). */
  counts: Record<Exclude<SentenceClass, 'keep'>, number>;
  /** Withheld warranty sentences: owner-only manufacturer_terms evidence (L-19). */
  withheld: string[];
  /** Region evidence (voltage purchase advice): recorded, not shown. */
  region: string[];
}

/** Classifies every sentence of a prose text and keeps only what may reach a customer. */
export function scrubProse(text: string): ScrubResult {
  const counts = { money: 0, promotion: 0, shipping_policy: 0, warranty: 0, region: 0 };
  const withheld: string[] = [];
  const region: string[] = [];
  const lines: string[] = [];
  for (const line of text.split(/\n/)) {
    const kept: string[] = [];
    for (const s of splitSentences(line)) {
      const c = classifySentence(s);
      if (c === 'keep') kept.push(s);
      else {
        counts[c]++;
        if (c === 'warranty') withheld.push(s);
        if (c === 'region') region.push(s);
      }
    }
    if (kept.length) lines.push(kept.join(' '));
  }
  return { kept: lines.join('\n'), counts, withheld, region };
}

/** True when a customer-facing string carries any refused class (the payload validator's check). */
export function refusedClassOf(text: string): SentenceClass | null {
  for (const s of splitSentences(text)) {
    const c = classifySentence(s);
    if (c === 'money' || c === 'promotion' || c === 'shipping_policy' || c === 'warranty') return c;
  }
  return null;
}
