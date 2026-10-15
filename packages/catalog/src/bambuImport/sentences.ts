/**
 * THE SENTENCE CLASSIFIER (spec §C.10 layer 1, §C.3 variant notes).
 *
 * Every sentence of every prose field is labelled; money, promotion and US
 * shipping-policy sentences are removed, manufacturer warranty / return /
 * refund sentences are withheld from customer content (kept owner-only,
 * L-19), and voltage purchase advice is region evidence (not shown). Hits are
 * reported as COUNTS only — a sentence never reaches a log as text.
 *
 * The money branch is limited to currency forms and price claims on purpose
 * (review finding 11): "Prints come off easily … 35℃ or lower" is technical
 * and kept.
 *
 * Review 4 (finding 2) widened three lists from a scan of all 1,115 crawled
 * pages, each sentence below being a real one that reached a public string:
 * price claims ("unbeatable price", "34% less cost"), bundle savings, free
 * gifts and the 🎁 marker, and the store's own order, stock and packing terms
 * ("Limited Stock: Available only while supplies last", "maximum purchase
 * quantity … five (5) units per user", "will not be restocked once sold out",
 * "Your order may be shipped in separate packages"). Stock and purchase-limit
 * sentences are store policy, so they share the shipping_policy class: removed.
 *
 * A second scan of every customer-facing payload string, walked through the
 * closed schema, found the rest of that family and closed it: a price or value
 * claim without the word "price" ("Affordable dual-nozzle 3D printer", "Buying
 * the bundle is cheaper than purchasing items individually", "a highly
 * cost-effective option", "saving both time and money", "has better value",
 * "Is The A1 Worth It?"), a gift with purchase ("get screwdriver tools for
 * free"), the store's own buttons and cart ("Buy Now >", "add it to your
 * shopping cart below", "buy at official store"), packing and order terms
 * ("new and old designs may be shipped randomly", "Orders can be placed at
 * Maker's Supply") and "Enjoy 14 days returns". Claims about what a product
 * saves in USE stay: "reducing printing costs", "lower power bills", "save
 * time and materials" are the product's performance, not its price.
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
  // Price claims: the source's price is not ours to praise.
  /\b(?:great|unbeatable|incredible|competitive|reasonable|affordable|amazing|unmatched|attractive|excellent|best|low|lower|fair)\s+pric(?:e|es|ing)\b/i,
  /\b(?:less|lower|reduced|higher)\s+(?:costs?|prices?)\b/i,
  /\bvalue for (?:the )?money\b/i,
  /\bbang for (?:the|your) buck\b/i,
  // ... and without the word "price": what the product costs to buy, said any other way.
  /\baffordab(?:le|ility)\b/i,
  /\b(?:in)?expensive\b/i,
  /\bcheap(?:er|est|ly)?\b/i,
  /\bcost[\s-]?effective(?:ness|ly)?\b/i,
  /\bbudget[\s-]friendly\b/i,
  /\bexpenses?\b/i,
  /\bsav(?:e|es|ed|ing)\b[^.!?]{0,30}\bmoney\b/i,
  /\b(?:extra|additional|upgrade)\s+costs?\b/i,
  /\b(?:reduc|lower|cut)\w*\s+(?:the\s+)?costs?\s+of\b/i,
  /\b(?:great|better|best|excellent|exceptional|outstanding|incredible|unbeatable|superb)\s+(?:high[\s-])?value\b/i,
  /\bworth (?:it|the (?:money|price|investment))\b/i,
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
  // Bundle savings and gifts.
  /\bsave more\b/i,
  /\d+\s*%\s*savings?\b/i,
  /\bsavings?\b[^.!?]*\b(?:bundle|individual(?:ly)?|separately|compared to buying)\b/i,
  /\b(?:bundle|kit|combo)\b[^.!?]*\bsavings\b/i,
  /\badd-?ons?\b[^.!?]{0,20}\bsave\b/i,
  /\u{1F381}/u, // 🎁
  /(?:^|[:;]\s*)[\s"'“(*•-]*(?:(?:an?|one|plus)\s+)?free\s+(?!-)(?:\w+\s+){0,3}(?:gift|sock|socks|panel|accessor(?:y|ies)|item|items|tool|tools|kit|sample|samples|upgrade|replacement|spool|bonus|blade|blades)\b/i,
  /\bfree gifts?\b/i,
  /\bgifts? with (?:purchase|every|each)\b/i,
  /\bfor free\b|\bfree of charge\b|\bat no (?:extra |additional )?(?:cost|charge)\b/i,
  // The store's own calls to buy.
  /\b(?:buy|shop|order) now\b/i,
  /\blooking to buy\b/i,
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
  // The store's own order and packing terms.
  /\b(?:your|my) orders?\b/i,
  /\bplac(?:e|ed|ing) (?:an|your|the) orders?\b/i,
  /\bshipped\b[^.!?]{0,40}\b(?:separate|packag(?:e|es|ing))\b/i,
  /\bstandard shipping\b/i,
  /\bdivided into (?:\w+\s+)?packages\b/i,
  /\b(?:may|might|could|can) be shipped\b/i,
  /\bshipped (?:at )?random(?:ly)?\b/i,
  /\bpackaging\b[^.!?]{0,20}\b(?:updat|chang)\w*/i,
  /\borders?\s+(?:can|may|will|must|could)\s+be\s+placed\b/i,
  /\bshopping cart\b|\b(?:your|the) cart\b/i,
  /\b(?:buy|purchase|order)\w*\b[^.!?]{0,30}\b(?:at|from)\s+(?:the\s+|our\s+)?(?:bambu lab\s+)?official (?:store|website|shop)\b/i,
  // Stock and purchase limits.
  /\blimited stock\b/i,
  /\bwhile (?:supplies|stocks?) last\b/i,
  /\brestock(?:ed|ing|s)?\b/i,
  /\bsold[\s-]out\b/i,
  /\bin stock\b/i,
  /\bout of stock\b/i,
  /\bpurchase (?:quantity|limit)\b/i,
  /\bper (?:user|customer|account|household)\b/i,
  /\bunits? per (?:user|order|customer|account|household)\b/i,
];

const WARRANTY: readonly RegExp[] = [
  /\bwarrant(?:y|ies)\b/i,
  /\b(?:money[\s-]back|satisfaction)\s+guarantee\b/i,
  /\bguarantee\s+(?:period|policy|card|terms|coverage)\b/i,
  /\b\d+[\s-](?:year|month|day)s?\s+guarantee\b/i,
  /\b\d+[\s-]days?\s+(?:free\s+)?returns?\b/i,
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

/**
 * Two sentences the source glued together, with no space after the stop: "…or other components.Orders can be
 * placed at Maker's Supply." (m2-socket-head-shoulder-machine-screws-shss). They are classified apart, so the
 * store's line goes and the facts stay; when every part is kept, the text stays exactly as written
 * ("Chingoo.Jeesoo", a creator's name, is not split).
 */
const GLUED = /(?<=[a-z]{2}[.!?])(?=[A-Z][a-z])/;

/** Classifies every sentence of a prose text and keeps only what may reach a customer. */
export function scrubProse(text: string): ScrubResult {
  const counts = { money: 0, promotion: 0, shipping_policy: 0, warranty: 0, region: 0 };
  const withheld: string[] = [];
  const region: string[] = [];
  const lines: string[] = [];
  for (const line of text.split(/\n/)) {
    const kept: string[] = [];
    const take = (s: string, c: SentenceClass) => {
      if (c === 'keep') kept.push(s);
      else {
        counts[c]++;
        if (c === 'warranty') withheld.push(s);
        if (c === 'region') region.push(s);
      }
    };
    for (const s of splitSentences(line)) {
      const whole = classifySentence(s);
      const parts = s.split(GLUED);
      const classes = parts.map(classifySentence);
      if (parts.length > 1 && classes.some((c) => c !== 'keep')) parts.forEach((p, i) => take(p, classes[i]));
      else take(s, whole);
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
