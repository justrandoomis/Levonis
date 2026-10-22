/**
 * ONE SENTENCE IN, WHAT IT SAYS OUT. Pure: no database, no network, no model.
 *
 * «نوزل مال اي ون اريده 0.2» → part nozzle_hotend, printer A1, measure 0.2,
 * nothing left over. «بحث عن منتج صيانه خلل بالنوزل» → a shopping question
 * (بحث, منتج) about a fault (خلل) in the nozzle family, in maintenance.
 * «كلوب» → the clog symptom. The orchestrator decides what to DO with this;
 * this module only reads.
 *
 * Sizes and codes come from the search engine's own reader
 * (`extractIdentifiers`, read from the RAW text so «0.2» keeps its dot and
 * «٠.٢» means the same), so a size means here exactly what it means in the
 * search box.
 */
import { CONFIDENT_SCORE, compileLexicon, normalizeText, scoreIntents, tokenize, type LexEntry } from '../../assistantNlu';
import { extractIdentifiers, type CodeCandidate } from '../../search/identifiers';
import type { ModelToken, PartKey, SymptomKey } from '../types';
import { MODEL_TOKENS } from '../types';
import {
  MODEL_NAME_WORDS,
  bareProclitics,
  hyphenNames,
  joinSplitNames,
  latinModels,
  possessedSoraniName,
  printerNameWord,
  readFamily,
  scanSpokenModels,
  splitScripts,
  unreadPrinter,
} from './models';
import {
  ACCOUNT_BUYING,
  ACCOUNT_PHRASES,
  ACCOUNT_WORDS,
  AMS_WEAK,
  CLEANING_TOOLS,
  CORRECTION_WORDS,
  DENIAL,
  FAULT_CUE,
  FILLERS,
  ORDINAL_WORDS,
  OTHER_PRINTER,
  OUTCOME_NOT_FIXED,
  OUTCOME_NOT_FIXED_ALONE,
  OUTCOME_NOT_TRIED,
  OUTCOME_RESOLVED,
  MAINTENANCE_CUE,
  NOT_YET_WORDS,
  OWN_PRINTER,
  OWNS_SAID,
  PART_LEXICON,
  PAST_PURCHASE,
  PRICE_ASK,
  PRINTER_CUE,
  PROBLEM_CUE,
  PRODUCT_CUE,
  PURCHASE_TOLD,
  STILL_AT_FAULT,
  STRINGING_WEAK,
  SYMPTOM_LEXICON,
  TRIED_SAID,
  type CleaningTool,
} from './lexicon';

export interface Understood {
  /** The first printer named (spoken or Latin). A family of one printer («A2») is that printer. */
  model?: ModelToken;
  models: ModelToken[];
  /**
   * A printer FAMILY named and no printer: «X1», «بي ون», «ئێکس وەن». The
   * family's printers, as the registry lists them; never a single guess.
   */
  family?: { name: string; members: ModelToken[] };
  part?: PartKey;
  /** «صيانة»: the question is about maintenance products. */
  maintenance: boolean;
  symptom?: SymptomKey;
  /** An HMS code, canonical `XXXX-XXXX[-XXXX-XXXX]`. Never sent to product search. */
  hmsCode?: string;
  measures: string[];
  codes: CodeCandidate[];
  productCue: boolean;
  problemCue: boolean;
  /**
   * An order, a delivery, a return, a warranty, a payment or a purchase named
   * («بطلبية», "delivery", «ضمان»): beside a fault word it is the account
   * question, never the printer triage (./lexicon.ts `ACCOUNT_WORDS`).
   */
  accountCue: boolean;
  /**
   * An order, a delivery, a return, an exchange, a cancel, a warranty or a
   * payment named, or an item that came wrong or broken («ابي استرجع البليت»,
   * "cancel my nozzle order", «پلێتەکە شکاو گەیشت»); never «شراء», "buying".
   * Beside a part it is an after-sale question: the part is never shown for
   * sale and the legacy answer stands, as live (orchestrator, review round 5.6).
   */
  afterSale: boolean;
  /**
   * The printers the customer says they do NOT have, or that are fine («ماعندي
   * اي ون», "not the A1", «A1م نییە», «الاي ون زينه»). Never the printer of a
   * fault: the triage's «which printer?» is not answered by one (review round 5.6).
   */
  deniedModels: ModelToken[];
  /**
   * A symptom was named and denied, and none is left («النوزل مو مسدود», "the
   * nozzle isn't clogged", «کلۆگم نییە»): the sentence says what is NOT wrong.
   * It is neither the triage nor a shopping question for the part beside it;
   * the legacy answer stands, as live (orchestrator, review round 5.6).
   */
  symptomDenied?: boolean;
  /** «كومبو», "combo": the bundle of the printer named, not the printer alone. */
  bundle?: boolean;
  /** A fault the curated steps do not cover (a leak, no heat): a problem, never the clog its part suggests. */
  faultCue: boolean;
  printerCue: boolean;
  /**
   * A printer was named and could not be read («زد ون», «k1c», «كريالتي»).
   * Never true when a printer WAS read. The orchestrator does not answer for
   * the printer remembered from earlier when this is set.
   */
  printerUnread: boolean;
  /** One of the unread names is another maker's («كريالتي», «prusa»). */
  otherBrand: boolean;
  /** Those makers in Latin, as the catalogue writes them: «سنابميكر» is «snapmaker». */
  makers?: string[];
  /** Which cleaning tool was named, when the part is `cleaning`: «ابرة» the needle, «اسفنجة» the sponge. */
  tool?: CleaningTool;
  /** «طابعة أخرى», "another printer": the answer «another printer» to «which printer?». */
  otherPrinter: boolean;
  /** «لا قصدي …», "no, I mean …": a correction of the last answer. */
  correction: boolean;
  /** «الاول», "second": which of the products just shown (0 is the first). */
  ordinal?: number;
  /** The outcome of the steps, typed: «ما انحلت» / «انحلت». Read on every sentence; acted on only after the steps. */
  outcome?: 'resolved' | 'not_fixed';
  /**
   * The symptom the WORDS name, before an HMS code in the sentence makes it
   * `hms`: «وطلعلي رمز 0300-…» names none, «وطلعلي رمز و صار انسداد» the clog.
   */
  wordSymptom?: SymptomKey;
  /** «طابعتي», "my own printer", «پرینتەرەکەی خۆم» and nothing else: the printer of the account. */
  ownPrinter: boolean;
  /**
   * «عندي اي ون», "I have an A1", «A1م هەیە»: the customer says they have,
   * own or bought a printer, with no want, need, have-not, question to the
   * shop, price or stock ask (./lexicon.ts `OWNS_SAID`). Read ONLY by the
   * orchestrator's `printerOnly`, so such a sentence falls through to the
   * legacy answer as live; never a triage or a flow (review round 5.4).
   */
  ownsSaid: boolean;
  /**
   * «جربتها», "tried them", «تاقیم کردەوە»: the customer says they tried the
   * steps. A typed not-fixed reply puts them on the ticket as tried only
   * with this (review round 5, ./lexicon.ts `TRIED_SAID`).
   */
  triedSaid: boolean;
  /** "how much?", «شكد؟»: a price asked, whatever the intent scorer made of it. */
  priceAsk: boolean;
  /**
   * «اشتريت نوزل وما يركب», "the nozzle I bought doesn't fit», «نۆزڵێکم کڕی»:
   * a purchase told, with no want or need beside it. The part named is the
   * customer's own: never shown for sale (orchestrator, review round 5.5).
   */
  purchaseStory?: boolean;
  /** The words no reader claimed, at most four: what is left to search for. */
  residual: string[];
}

const compiledParts = compileLexicon(PART_LEXICON);
const compiledTools = compileLexicon(CLEANING_TOOLS);
const compiledSymptoms = compileLexicon(SYMPTOM_LEXICON);
const compiledCues = compileLexicon({
  product: PRODUCT_CUE,
  problem: PROBLEM_CUE,
  fault: FAULT_CUE,
  printer: PRINTER_CUE,
  maintenance: MAINTENANCE_CUE,
  other_printer: OTHER_PRINTER,
});
const compiledStringingWeak = compileLexicon({ stringing: STRINGING_WEAK });
const compiledAmsWeak = compileLexicon({ ams: AMS_WEAK });

const RESIDUAL_MAX = 4;
const ARABIC = /[؀-ۿ]/;

/**
 * HMS CODES, as the printer screen and the app write them:
 * `0300-0100-0001-0003`, `HMS_0300_0100_0001_0003`, or the short
 * `HMS 0700-2000`. A bare eight-digit number is NOT one (it is far more often
 * a phone number or a quantity), so the short form needs its «HMS».
 */
const HMS_LONG = /(?<![0-9A-Z])([0-9A-F]{4})[-_ ]([0-9A-F]{4})[-_ ]([0-9A-F]{4})[-_ ]([0-9A-F]{4})(?![0-9A-Z])/i;
const HMS_PACKED = /HMS[_ -]?([0-9A-F]{4})([0-9A-F]{4})([0-9A-F]{4})([0-9A-F]{4})(?![0-9A-Z])/i;
const HMS_SHORT = /HMS[_ -]?([0-9A-F]{4})[-_ ]?([0-9A-F]{4})(?![0-9A-Z])/i;

export function readHmsCode(input: string): string | undefined {
  // An Iraqi phone keyboard types «٠٣٠٠-٠١٠٠-…»: the same code.
  const raw = asciiDigits(input);
  const named = /HMS/i.test(raw);
  const m = HMS_LONG.exec(raw) ?? HMS_PACKED.exec(raw) ?? HMS_SHORT.exec(raw);
  if (!m) return undefined;
  const groups = m.slice(1).filter(Boolean);
  // Without «HMS», a 4-group code must hold a letter or a leading zero
  // somewhere: four plain numbers («2024 1000 5000 3000») are not a printer code.
  if (!named && !groups.some((g) => /[A-F]/i.test(g) || g.startsWith('0'))) return undefined;
  return groups.map((g) => g.toUpperCase()).join('-');
}

/** Arabic-Indic and Persian digits as ASCII digits; nothing else changes. */
function asciiDigits(raw: string): string {
  return raw.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.codePointAt(0)! - 0x0660) % 0x90));
}

/**
 * «اشتريت طابعة من عندكم وصار بيها انسداد»: a purchase in the PAST is the
 * story of a fault, never a shopping question, so these words never count as
 * the product cue. Whole words and phrases, normalised.
 */
const PAST_PURCHASE_WORDS = new Set(PAST_PURCHASE.map(normalizeText).filter((w) => w && !w.includes(' ')));
const PAST_PURCHASE_PHRASES = PAST_PURCHASE.map(normalizeText).filter((w) => w.includes(' '));
function withoutPastPurchase(normalized: string): string {
  let text = ` ${normalized} `;
  for (const phrase of PAST_PURCHASE_PHRASES) text = text.split(` ${phrase} `).join(' ');
  return tokenize(text.trim())
    .filter((t) => !PAST_PURCHASE_WORDS.has(t) && !(t.startsWith('و') && PAST_PURCHASE_WORDS.has(t.slice(1))))
    .join(' ');
}

/** «كومبو»: the bundle word after a printer name, in every script; a model word, never searched. */
const COMBO_WORDS = ['combo', 'كومبو', 'كمبو', 'کۆمبۆ', 'کۆمبو'].map(normalizeText);

/**
 * THE ACCOUNT WORDS, whole («طلبية», "order"), or behind the article and the
 * prepositions Arabic glues on («بطلبية», «بالضمان», «للتوصيل», «والدفع»).
 * Never a prefix match: «طلبت» ("I ordered") is the story of a fault.
 */
const ACCOUNT_SET = new Set(ACCOUNT_WORDS.map(normalizeText).filter(Boolean));
const ACCOUNT_BUYING_SET = new Set([...ACCOUNT_WORDS, ...ACCOUNT_BUYING].map(normalizeText).filter(Boolean));
const ACCOUNT_PHRASE_LIST = ACCOUNT_PHRASES.map(normalizeText).filter(Boolean);
const ARABIC_PROCLITICS = ['وبال', 'وال', 'بال', 'فال', 'لل', 'ال', 'وب', 'ول', 'و', 'ب', 'ل'];
function namesAccount(tokens: readonly string[], set: ReadonlySet<string> = ACCOUNT_BUYING_SET): boolean {
  return (
    tokens.some(
      (t) => set.has(t) || (ARABIC.test(t) && ARABIC_PROCLITICS.some((p) => t.startsWith(p) && t.length - p.length >= 3 && set.has(t.slice(p.length))))
    ) || saysAny(` ${tokens.join(' ')} `, ACCOUNT_PHRASE_LIST)
  );
}

/** The single-token rule of the intent scorer, used to say which words a reader claimed. */
function claims(token: string, stem: string): boolean {
  if (token === stem) return true;
  if (ARABIC.test(stem)) return stem.length >= 3 && token.length - stem.length <= 4 && token.includes(stem);
  return stem.length >= 4 && token.length - stem.length <= 4 && token.startsWith(stem);
}

const ALL_ENTRIES: LexEntry[] = [
  PRODUCT_CUE,
  PROBLEM_CUE,
  FAULT_CUE,
  OTHER_PRINTER,
  PRINTER_CUE,
  MAINTENANCE_CUE,
  STRINGING_WEAK,
  AMS_WEAK,
  ...Object.values(PART_LEXICON),
  ...Object.values(SYMPTOM_LEXICON),
];
const CLAIM_STEMS = [...new Set(ALL_ENTRIES.flatMap((e) => (e.stems ?? []).map(normalizeText)).filter(Boolean))];
const CLAIM_PHRASES = [...new Set(ALL_ENTRIES.flatMap((e) => (e.phrases ?? []).map(normalizeText)).filter((p) => p.includes(' ')))].sort(
  (a, b) => b.length - a.length
);
const FILLER_SET = new Set([...FILLERS, ...CORRECTION_WORDS, ...Object.keys(ORDINAL_WORDS)].map(normalizeText).filter(Boolean));
const CORRECTION_SET = new Set(CORRECTION_WORDS.map(normalizeText).filter(Boolean));
const ORDINALS = new Map(Object.entries(ORDINAL_WORDS).map(([w, n]) => [normalizeText(w), n] as const));
const PRICE_ASKS = PRICE_ASK.map(normalizeText).filter(Boolean);
const OWN_MINE = new Set(OWN_PRINTER.mine.map(normalizeText).filter(Boolean));
const OWN_WITH = new Set(OWN_PRINTER.with.map(normalizeText).filter(Boolean));
const NOT_FIXED = OUTCOME_NOT_FIXED.map(normalizeText).filter(Boolean);
const NOT_FIXED_ALONE = new Set(OUTCOME_NOT_FIXED_ALONE.map(normalizeText).filter(Boolean));
const NOT_TRIED = OUTCOME_NOT_TRIED.map(normalizeText).filter(Boolean);
const RESOLVED = OUTCOME_RESOLVED.map(normalizeText).filter(Boolean);
const TRIED_SORANI = new Set(TRIED_SAID.soraniVerbs.map(normalizeText).filter(Boolean));
const TRIED_SORANI_BEFORE = new Set(TRIED_SAID.soraniBefore.map(normalizeText).filter(Boolean));
const TRIED_VERBS = [...TRIED_SAID.verbs, ...TRIED_SAID.soraniVerbs].map((v) => tokenize(normalizeText(v))).filter((v) => v.length > 0);
const TRIED_NEGATIONS = new Set(TRIED_SAID.negations.map(normalizeText).filter(Boolean));
const TRIED_AUXILIARIES = new Set(TRIED_SAID.auxiliaries.map(normalizeText).filter(Boolean));
const TRIED_NEGATED_AFTER = new Set(TRIED_SAID.negatedAfter.map(normalizeText).filter(Boolean));
const TRIED_ADVERBS = new Set(TRIED_SAID.adverbs.map(normalizeText).filter(Boolean));
const TRIED_NOT_EVEN = new Set(TRIED_SAID.notEven.map(normalizeText).filter(Boolean));
const TRIED_NONE = new Set(TRIED_SAID.none.map(normalizeText).filter(Boolean));
const TRIED_BARE = new Set(TRIED_SAID.bare.map(normalizeText).filter(Boolean));
const TRIED_CLAUSE = new Set(TRIED_SAID.clause.map(normalizeText).filter(Boolean));
const TRIED_PARTIAL = [...TRIED_SAID.partial, ...Object.keys(ORDINAL_WORDS)].map(normalizeText).filter(Boolean);
const normalSet = (words: readonly string[]): ReadonlySet<string> => new Set(words.map(normalizeText).filter(Boolean));
const TRIED_OBJECTS = normalSet(TRIED_SAID.objects);
const TRIED_DETERMINERS = normalSet(TRIED_SAID.determiners);
const TRIED_DEMONSTRATIVES = normalSet(TRIED_SAID.demonstratives);
const TRIED_STEPS_WORDS = normalSet(TRIED_SAID.stepsWords);
const TRIED_CLAUSE_START = normalSet(TRIED_SAID.clauseStart);
const TRIED_AFTER_OBJECT = normalSet(TRIED_SAID.afterObject);
/** The third person, and every printer name as the text writes it («a1», «p1s», «x1»): "my A1 did it again". */
const TRIED_THIRD_PERSON = normalSet([
  ...TRIED_SAID.thirdPerson,
  ...MODEL_TOKENS.flatMap((m) => [m.toLowerCase().replace(/\s+/g, ''), ...MODEL_NAME_WORDS[m].flat()]),
]);
const TRIED_CONTRACTIONS = normalSet(TRIED_SAID.contractions);
const TRIED_PASSIVE = normalSet(TRIED_SAID.passive);
const TRIED_RELATIVES = normalSet(TRIED_SAID.relatives);
const TRIED_SUBJECTS = normalSet(TRIED_SAID.subjects);
const TRIED_SUBJECT_SKIP = normalSet(TRIED_SAID.subjectSkip);
const TRIED_BEFORE_SUBJECT = normalSet(TRIED_SAID.beforeSubject);
const TRIED_SUBJECT_ADVERBS = normalSet(TRIED_SAID.subjectAdverbs);
const TRIED_SINGULAR = normalSet(TRIED_SAID.singular);
const TRIED_SINGULAR_OBJECTS = normalSet(TRIED_SAID.singularObjects);
const TRIED_THINGS = normalSet(TRIED_SAID.things);
const TRIED_STEP_NUMBERS = normalSet(TRIED_SAID.stepNumbers);
const TRIED_STEP_WORDS = normalSet(TRIED_SAID.stepWords);
const TRIED_SORANI_WITH = normalSet(TRIED_SAID.soraniWith);
const TRIED_SORANI_AFTER_CLAUSE = TRIED_SAID.soraniAfterClause.map((p) => tokenize(normalizeText(p)));
const NOT_YET = normalSet(NOT_YET_WORDS);
const PURCHASE_VERBS = normalSet(PURCHASE_TOLD);
/** The Arabic verbs of trying, one word each: «بعد ما» before one of them is "after" (`afterNotNegation`). */
const TRIED_ARABIC_VERBS = new Set(TRIED_VERBS.filter((v) => v.length === 1 && ARABIC.test(v[0])).map((v) => v[0]));
const STILL_WORDS = normalSet(STILL_AT_FAULT.still);
const STILL_STEMS = [...normalSet(STILL_AT_FAULT.stems)];
const STILL_WHOLE = normalSet(STILL_AT_FAULT.whole);
const STILL_PHRASES = [...normalSet(STILL_AT_FAULT.phrases)];
const STILL_WAITS = [...normalSet(STILL_AT_FAULT.waits)];
const OWNS_HAVE = normalSet(OWNS_SAID.have);
const OWNS_PHRASES = [...normalSet(OWNS_SAID.phrases)];
const OWNS_SORANI_HAVE = normalSet(OWNS_SAID.soraniHave);
const OWNS_SORANI_PRINTER = [...normalSet(OWNS_SAID.soraniPrinter)];
const OWNS_WANT = normalSet(OWNS_SAID.want);
const OWNS_WANT_PHRASES = [...normalSet(OWNS_SAID.wantPhrases)];
const OWNS_NEGATIONS = normalSet(OWNS_SAID.negations);
const OWNS_THERE_IS = normalSet(OWNS_SAID.thereIs);
const OWNS_THERE_IS_MINE = normalSet(OWNS_SAID.thereIsMine);
/** Within how many words before its verb a negation still negates it, over `TRIED_SAID.adverbs`. */
const NEGATION_REACH = 3;

/**
 * «ماعندي», «معندي», «وماعندي»: the negation typed glued to «عندي» is «ما
 * عندي» (review round 5.4). Read as one word, «ماعندي طابعة» was a word left
 * to search, and it reached a Matte filament. Pure.
 */
export function splitGluedNegation(text: string): string {
  return text.replace(/(?<![\p{L}\p{N}])(و?)ما?عندي(?![\p{L}\p{N}])/gu, '$1ما عندي');
}

/**
 * «بعد ما جربتها», «بعدما طبقتها», «من بعد ما سويتهم»: "after I tried them".
 * Before a verb of trying, «ما» is not a negation, so it comes off (review
 * round 5.4). Only before such a verb: «بعد ما انحلت», «بعدني ما زبطت» are
 * "still not fixed" and keep it; and never beside "until now" («لهسه بعد ما
 * جربتها», `NOT_YET_WORDS`), where it is "not yet". Pure, on normalised text.
 */
export function afterNotNegation(normalized: string): string {
  const tokens = tokenize(normalized);
  // «لهسه بعد ما جربتها»: with "until now" beside it, «بعد ما» is "not yet" (review round 5.5).
  if (tokens.some((t) => NOT_YET.has(t))) return normalized;
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if ((t === 'بعدما' || t === 'وبعدما') && next !== undefined && TRIED_ARABIC_VERBS.has(unglued([next])[0])) {
      out.push(t.slice(0, -2));
      continue;
    }
    out.push(t);
    if ((t === 'بعد' || t === 'وبعد') && next === 'ما' && tokens[i + 2] !== undefined && TRIED_ARABIC_VERBS.has(unglued([tokens[i + 2]])[0])) i += 1;
  }
  return out.join(' ');
}

/**
 * "still jamming", «هێشتا خراپە»: «still» and, within `STILL_AT_FAULT.reach`
 * words after it, a fault, a problem or sameness. Never beside a wait. Pure.
 */
function stillAtFault(tokens: readonly string[]): boolean {
  if (!tokens.some((t) => STILL_WORDS.has(t))) return false;
  if (tokens.some((t) => STILL_WAITS.some((w) => t === w || (t.startsWith(w) && t.length - w.length <= 4)))) return false;
  return tokens.some((t, i) => {
    if (!STILL_WORDS.has(t)) return false;
    const window = tokens.slice(i + 1, i + 1 + STILL_AT_FAULT.reach);
    if (STILL_PHRASES.some((p) => ` ${window.join(' ')} `.includes(` ${p} `))) return true;
    return window.some((w) => STILL_WHOLE.has(w) || STILL_STEMS.some((s) => w.startsWith(s)));
  });
}

/** «وجربتها», «وسويتها»: the conjunction glued on, taken off. «ولا» (nor, not even) stays whole. */
function unglued(tokens: readonly string[]): string[] {
  return tokens.map((t) => (t.length > 2 && t.startsWith('و') && !t.startsWith('وو') && t !== 'ولا' ? t.slice(1) : t));
}
/** Any of `phrases` between gaps in `padded` (a text with a space at each end). */
const saysAny = (padded: string, phrases: readonly string[]): boolean => phrases.some((p) => padded.includes(` ${p} `));

/**
 * «جربتها وما انحلّت» → not fixed; «انحلت» → resolved. The negated list first.
 * «بعدني ما جربتها», "I still have not tried them" → none: the steps were not
 * tried, so nothing is known of their outcome. «بعد ما جربتها» is "after I
 * tried them" (`afterNotNegation`), and "still" with a fault after it is not
 * fixed (`stillAtFault`, review round 5.4). Pure.
 */
export function readOutcome(normalized: string): 'resolved' | 'not_fixed' | undefined {
  const text = afterNotNegation(normalized);
  // «وما» is «و» + «ما», «وبعدها مسدودة» «و» + «بعدها»: the conjunction glued on must not hide the phrase.
  const padded = ` ${text} `.replace(/ و(ما|لم|بعدها|بعده)(?= )/g, ' $1');
  if (NOT_TRIED.some((p) => padded.includes(` ${p} `))) return undefined;
  if (NOT_FIXED_ALONE.has(text) || NOT_FIXED.some((p) => padded.includes(` ${p} `))) return 'not_fixed';
  if (stillAtFault(tokenize(padded.trim()))) return 'not_fixed';
  if (RESOLVED.some((p) => padded.includes(` ${p} `))) return 'resolved';
  return undefined;
}
/**
 * «جربتها وما انحلت», "tried them, still clogged", «تاقیم کردەوە»: a verb of
 * trying, not negated («ما سويتها», "have not done them", "I have not really
 * tried them", «ولا خطوة جربتها», "I did nothing", "nothing done"), and not
 * only some of the steps ("the first one only", «جربت الاولى بس»). Its object
 * must be the steps, or its clause must end there; never a third-person
 * subject, never a question ("did that help?", review round 5.4). Pure.
 */
export function saysTried(normalized: string): boolean {
  const typed = tokenize(afterNotNegation(normalized));
  const tokens = unglued(typed);
  if (saysAny(` ${tokens.join(' ')} `, TRIED_PARTIAL)) return false;
  // "steps 1 and 2", "step one", «الخطوه 2»: some of the steps, by number (review round 5.6).
  if (tokens.some((t, i) => TRIED_STEP_WORDS.has(t) && TRIED_STEP_NUMBERS.has(tokens[i + 1] ?? ''))) return false;
  return TRIED_VERBS.some((verb) =>
    tokens.some((_, i) => {
      if (verb.some((w, k) => tokens[i + k] !== w)) return false;
      if (negatedBefore(tokens, i)) return false;
      // «جربته», «سويته»: the object «ـه» is one thing (the nozzle just named), never the steps (review round 5.6).
      if (verb.length === 1 && TRIED_SINGULAR.has(verb[0])) return false;
      // Sorani: the object comes first. «هەموویم تاقی کردەوە», never «فیلامێنتێکی ترم تاقی کردەوە».
      if (TRIED_SORANI.has(verb.join(' '))) return soraniStepsTried(tokens, i, verb.length);
      if (thirdPersonBefore(tokens, i)) return false;
      // "did it", "done": only the customer's own (I, we, none, "yes"), never "the toolhead", "my Bambu" (review round 5.6).
      if ((verb[0] === 'did' || verb.join(' ') === 'done') && !firstPersonBefore(tokens, i)) return false;
      // "I changed the nozzle and tried it": «it» after a part or a filament named before is that thing (review round 5.6).
      if (singularThing(tokens, i, verb)) return false;
      // «النوزل الجديد اللي جربته»: the verb of a relative clause tries its noun (review round 5.5).
      if (i > 0 && TRIED_RELATIVES.has(tokens[i - 1])) return false;
      // "the print was done": a passive says nothing of the customer (review round 5.5).
      if (verb.join(' ') === 'done' && i > 0 && TRIED_PASSIVE.has(tokens[i - 1])) return false;
      const end = i + verb.length;
      const after = tokens[end];
      const bare = TRIED_BARE.has(verb.join(' '));
      if (after !== undefined && bare && TRIED_NONE.has(after)) {
        // "I did nothing", «سويت ولا شي»; never "tried, nothing changed", «جربت ولا شي تغير».
        let next = end;
        while (next < tokens.length && TRIED_NONE.has(tokens[next])) next += 1;
        return next < tokens.length && TRIED_CLAUSE.has(tokens[next]);
      }
      if (TRIED_AUXILIARIES.has(verb[verb.length - 1]) && after !== undefined && TRIED_NEGATED_AFTER.has(after)) return false;
      if (bare) return (clauseEnds(tokens, end) && !relativeClause(tokens, i, verb)) || stepsObject(tokens, end);
      // "did that", "did it": the object is carried; "did that help?" asks.
      if (verb[0] === 'did') return clauseEnds(tokens, end) || TRIED_AFTER_OBJECT.has(after);
      return true;
    })
  );
}

/**
 * The verb at `end` ended its clause: nothing after it, or a clause's first
 * word. The tokens are unglued, so «وما زبطت», «وبعدها» and «ونفس» end it;
 * «ويه بكره ثانيه» ("with another spool") and «وحده منهن» ("one of them") are
 * words, not «و» and a new clause (review round 5.5).
 */
function clauseEnds(tokens: readonly string[], end: number): boolean {
  const next = tokens[end];
  return next === undefined || TRIED_CLAUSE_START.has(next);
}

/**
 * "the other roll I tried still jams": an English bare verb whose subject «I»
 * or «we» stands right after a noun is a relative clause; what was tried is
 * that noun, never the steps. "I tried", "yes I tried", "ok, we tried" are
 * not (review round 5.5).
 */
function relativeClause(tokens: readonly string[], i: number, verb: readonly string[]): boolean {
  let k = i - 1;
  if (!TRIED_SUBJECTS.has(verb[0])) {
    while (k >= 0 && TRIED_SUBJECT_SKIP.has(tokens[k])) k -= 1;
    if (k < 0 || !TRIED_SUBJECTS.has(tokens[k])) return false;
    k -= 1;
  }
  return k >= 0 && !ARABIC.test(tokens[k]) && !TRIED_BEFORE_SUBJECT.has(tokens[k]);
}

/** The object at `end` means the steps: "them", "the steps", «الخطوات», «كلشي»; a demonstrative only with a steps word or a clause end after it. */
function stepsObject(tokens: readonly string[], end: number): boolean {
  let at = end;
  while (at < tokens.length && TRIED_DETERMINERS.has(tokens[at])) at += 1;
  const head = tokens[at];
  if (head === undefined) return false;
  if (TRIED_STEPS_WORDS.has(head)) return true;
  if (!TRIED_OBJECTS.has(head)) return false;
  if (!TRIED_DEMONSTRATIVES.has(head)) return true;
  return clauseEnds(tokens, at + 1) || TRIED_STEPS_WORDS.has(tokens[at + 1]) || TRIED_AFTER_OBJECT.has(tokens[at + 1]);
}

/** "it did that again", "the printer also did that again", "it's done it": an English verb whose subject is not the customer. */
function thirdPersonBefore(tokens: readonly string[], i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (TRIED_CONTRACTIONS.has(tokens[k]) || TRIED_SUBJECT_ADVERBS.has(tokens[k]))) k -= 1;
  return k >= 0 && TRIED_THIRD_PERSON.has(tokens[k]);
}

/**
 * The subject of a "did …" or "done" at `i` is the customer: «I» or «we»,
 * nothing at all ("did them all"), or a word that opens a reply ("yes, did
 * them"), read past the adverbs and auxiliaries ("I have also done them").
 * Any other word is someone or something else: "the toolhead did it again",
 * "my Bambu did it again" (review round 5.6).
 */
function firstPersonBefore(tokens: readonly string[], i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (TRIED_SUBJECT_ADVERBS.has(tokens[k]) || TRIED_CONTRACTIONS.has(tokens[k]))) k -= 1;
  return k < 0 || TRIED_SUBJECTS.has(tokens[k]) || TRIED_BEFORE_SUBJECT.has(tokens[k]);
}

/**
 * "I changed the nozzle and tried it", "the new nozzle, I tried it", "new
 * filament, did that": the object «it» / «that» / «this» of the verb at `i`
 * when a part or a filament stands before the verb is that thing (review
 * round 5.6).
 */
function singularThing(tokens: readonly string[], i: number, verb: readonly string[]): boolean {
  const end = i + verb.length;
  const carried = verb.length > 1 && TRIED_SINGULAR_OBJECTS.has(verb[verb.length - 1]);
  let at = end;
  while (at < tokens.length && TRIED_DETERMINERS.has(tokens[at])) at += 1;
  const object = carried || (tokens[at] !== undefined && TRIED_SINGULAR_OBJECTS.has(tokens[at]));
  if (!object) return false;
  return tokens.slice(0, i).some((t) => TRIED_THINGS.has(t) || namedBy(t)?.kind === 'part');
}

/**
 * A Sorani verb of trying at `i` tries the steps: nothing before it, or the
 * steps or a clause word (`soraniBefore`), or «دوای ئەوەی» ("after"); never
 * «ئەوەی» alone ("what I tried was a new nozzle"), and never «لەگەڵ» or «بە»
 * right after it ("I tried WITH a new nozzle", review round 5.6).
 */
function soraniStepsTried(tokens: readonly string[], i: number, length: number): boolean {
  // «تاقیم کردەوە بە هەموو هەنگاوەکان» ("with all the steps") still tries them.
  if (TRIED_SORANI_WITH.has(tokens[i + length] ?? '') && !TRIED_SORANI_BEFORE.has(tokens[i + length + 1] ?? '')) return false;
  if (i === 0) return true;
  if (TRIED_SORANI_AFTER_CLAUSE.some((p) => p.length <= i && p.every((w, k) => tokens[i - p.length + k] === w))) return true;
  return TRIED_SORANI_BEFORE.has(tokens[i - 1]);
}
/** A negation before the verb at `i`: over adverbs ("not really tried"), or «ولا» and one word («ولا خطوة جربتها»). */
function negatedBefore(tokens: readonly string[], i: number): boolean {
  if (i > 1 && TRIED_NOT_EVEN.has(tokens[i - 2])) return true;
  for (let k = i - 1; k >= 0 && k >= i - NEGATION_REACH; k -= 1) {
    if (TRIED_NEGATIONS.has(tokens[k])) return true;
    if (!TRIED_ADVERBS.has(tokens[k])) return false;
  }
  return false;
}
/**
 * THE IRAQI PROGRESSIVE «دا» («is …-ing») between the negation and its verb:
 * «الطابعة ما دا تشتغل» is «ما تشتغل», «ما دا يطلع فلامنت» is «ما يطلع
 * فلامنت». Taken out before any phrase is read, so every phrase list reads it
 * without a second copy of each phrase. Pure.
 */
export function dropProgressive(normalized: string): string {
  return ` ${normalized} `
    .replace(/ (ما|لا) دا (?=\S)/g, ' $1 ')
    .replace(/ دا (ما|لا) /g, ' $1 ')
    .trim();
}

/** Sizes and units: carried by `measures`, never searched as words. */
const MEASURE_PIECE = /^(?:\d+(?:mm|cm|m|g|kg|ml)?|mm|cm|ملم|مم|مل|ملي)$/;

function claimedWord(token: string, modelWords: ReadonlySet<string>): boolean {
  if (token.length < 2 || FILLER_SET.has(token) || MEASURE_PIECE.test(token) || modelWords.has(token) || printerNameWord(token)) return true;
  if (CLAIM_STEMS.some((s) => claims(token, s))) return true;
  // «واكو», «وبليت»: the conjunction glued on.
  if (token.startsWith('و') && token.length > 2) {
    const bare = token.slice(1);
    return FILLER_SET.has(bare) || CLAIM_STEMS.some((s) => claims(bare, s));
  }
  return false;
}

const best = <I extends string>(scores: Array<{ intent: I; score: number }>): I | undefined =>
  scores.length > 0 && scores[0].score >= CONFIDENT_SCORE ? scores[0].intent : undefined;
const has = (scores: Array<{ intent: string; score: number }>, intent: string): boolean =>
  scores.some((s) => s.intent === intent && s.score >= CONFIDENT_SCORE);

const DENY_BEFORE = normalSet(DENIAL.before);
const DENY_BEFORE_HAVE = normalSet(DENIAL.beforeHave);
const DENY_HAVE = normalSet(DENIAL.have);
const DENY_SKIP = normalSet(DENIAL.skip);
const DENY_FINE = normalSet(DENIAL.fine);
const DENY_FINE_SKIP = normalSet(DENIAL.fineSkip);
const DENY_AFTER = normalSet(DENIAL.after);
const DENY_AFTER_SKIP = normalSet(DENIAL.afterSkip);
const DENY_ANSWER_NO = normalSet(DENIAL.answerNo);
const DENY_ANSWER_NEXT = normalSet(DENIAL.answerNext);
const DENY_LACK = normalSet(DENIAL.lack);
const DENY_LACK_HAVE = normalSet(DENIAL.lackHave);
const PROBLEM_WORDS = [...normalSet(DENIAL.problemWords)];
const PROBLEM_BEFORE = normalSet(DENIAL.problemBefore);
const PROBLEM_BEFORE_HAVE = normalSet(DENIAL.problemBeforeHave);
const PROBLEM_HAVE = normalSet(DENIAL.problemHave);
const PROBLEM_SKIP = normalSet(DENIAL.problemSkip);
/** The Sorani negation on the word itself: «نەگیراوە» is "not clogged". */
const SORANI_NOT = normalizeText('نە');
/**
 * The part and symptom names of more than one word («hot end», «راس الطباعه»,
 * «هوت اند», «لوح الطباعه», «هۆت ئێند»), as token runs: a denial reads the
 * whole name (review round 5.6).
 */
const NAME_PHRASES: Array<{ kind: 'part' | 'symptom'; key: string; words: string[] }> = [
  ...Object.entries(PART_LEXICON).flatMap(([key, e]) => (e.phrases ?? []).map((p) => ({ kind: 'part' as const, key, words: tokenize(normalizeText(p)) }))),
  ...Object.entries(SYMPTOM_LEXICON).flatMap(([key, e]) => (e.phrases ?? []).map((p) => ({ kind: 'symptom' as const, key, words: tokenize(normalizeText(p)) }))),
].filter((p) => p.words.length > 1);

/** The symptom or the part one word names alone, if any. */
function namedBy(token: string): { kind: 'part' | 'symptom'; key: string } | undefined {
  const part = best(scoreIntents(token, compiledParts));
  if (part) return { kind: 'part', key: part };
  const symptom = best(scoreIntents(token, compiledSymptoms)) ?? best(scoreIntents(token, compiledStringingWeak)) ?? best(scoreIntents(token, compiledAmsWeak));
  return symptom ? { kind: 'symptom', key: symptom } : undefined;
}

/**
 * A negation before the word at `at`, over `DENIAL.skip`: «ما عندي كلوب», «مو النوزل», "not clogged", "no stringing".
 * A «no» that answers ("No, the nozzle is clogged") is not one. `lack` is a having denied with no problem word
 * between («ماعندي بليت», "I have no plate", «ماكو نوزل»): of a part, the customer lacks it and may be shopping for
 * it; `deny` is anything else («مو النوزل», "no problem with the nozzle", "not the nozzle") (review round 5.6).
 */
function negationAt(tokens: readonly string[], at: number, answers = false): 'lack' | 'deny' | undefined {
  let problem = false;
  let having = false;
  for (let k = at - 1; k >= 0 && k >= at - DENIAL.reach; k -= 1) {
    const t = tokens[k];
    // Before a printer name, a «no» is always an answer: "no, A1" picks the A1.
    if (DENY_ANSWER_NO.has(t) && (answers || DENY_ANSWER_NEXT.has(tokens[k + 1] ?? ''))) return undefined;
    if (DENY_BEFORE.has(t)) return !problem && (DENY_LACK.has(t) || (DENY_LACK_HAVE.has(t) && having)) ? 'lack' : 'deny';
    // «ما» negates a having («ما عندي كلوب»), never the verb of a symptom («ما يطلع فلامنت»).
    if (DENY_BEFORE_HAVE.has(t)) return DENY_HAVE.has(tokens[k + 1] ?? '') ? (problem ? 'deny' : 'lack') : undefined;
    if (!DENY_SKIP.has(t)) return undefined;
    if (PROBLEM_HAVE.has(t)) having = true;
    if (PROBLEM_WORDS.some((w) => claims(t, w))) problem = true;
  }
  return undefined;
}

/** "is fine" right after the word at `at`: «النوزل زين», "the nozzle is fine", «نۆزڵەکە باشە». */
function fineAfter(tokens: readonly string[], at: number): boolean {
  for (let k = at + 1; k < tokens.length && k <= at + 2; k += 1) {
    if (DENY_FINE.has(tokens[k])) return true;
    if (!DENY_FINE_SKIP.has(tokens[k])) return false;
  }
  return false;
}

/** The Sorani negation right after the word ending at `end`: «کلۆگم نییە», «گیراوە نییە», «A1م نییە». */
function deniedAfter(tokens: readonly string[], end: number): boolean {
  let k = end + 1;
  while (k < tokens.length && k <= end + 2 && DENY_AFTER_SKIP.has(tokens[k])) k += 1;
  return k < tokens.length && DENY_AFTER.has(tokens[k]);
}
/**
 * «پلێتم نییە», «نۆزڵ نییە»: "I have no plate", "there is no nozzle", a lack;
 * «کێشەکە نۆزڵ نییە» ("the problem is not the nozzle"), with a problem word
 * just before, denies it.
 */
function negationAfter(tokens: readonly string[], at: number, end: number): 'lack' | 'deny' | undefined {
  if (!deniedAfter(tokens, end)) return undefined;
  return tokens.slice(Math.max(0, at - 2), at).some((t) => PROBLEM_WORDS.some((w) => claims(t, w))) ? 'deny' : 'lack';
}

/**
 * THE TEXT WITHOUT A SYMPTOM OR A PART THE CUSTOMER DENIES (./lexicon.ts
 * `DENIAL`, review rounds 5.5 and 5.6). Said to be fine or negated, the word
 * goes, whether or not another one is named: «ماعندي كلوب» alone names no
 * symptom, and the ticket never says «انسداد النوزل»; «ماعندي كلوب، عندي خيوط»
 * is stringing. A name of several words («hot end», «راس الطباعه») goes whole.
 * The Sorani negation after the word («کلۆگ نییە») denies it too. Read only
 * for the part and the symptom. Pure, on normalised text.
 */
export function withoutDenied(rest: string): string {
  const tokens = tokenize(rest);
  type Named = { kind: 'part' | 'symptom'; key: string; at: number; end: number; how?: 'lack' | 'deny' | 'fine' };
  const named: Named[] = [];
  const how = (at: number, end: number): Named['how'] => (fineAfter(tokens, end) ? 'fine' : (negationAt(tokens, at) ?? negationAfter(tokens, at, end)));
  for (const phrase of NAME_PHRASES) {
    for (let at = 0; at + phrase.words.length <= tokens.length; at += 1) {
      if (phrase.words.some((w, k) => tokens[at + k] !== w)) continue;
      const end = at + phrase.words.length - 1;
      named.push({ kind: phrase.kind, key: phrase.key, at, end, how: how(at, end) });
    }
  }
  tokens.forEach((t, at) => {
    const n = namedBy(t);
    if (!n) return;
    const sorani = t.startsWith(SORANI_NOT) && namedBy(t.slice(SORANI_NOT.length))?.key === n.key;
    named.push({ ...n, at, end: at, how: sorani ? 'deny' : how(at, at) });
  });
  const drop = new Set<number>();
  for (const w of named) {
    if (!w.how) continue;
    // A part the customer only LACKS («ماعندي بليت») is still the part asked about, unless another one is named.
    const other = named.some((o) => o.kind === w.kind && o.key !== w.key && !o.how);
    if (w.kind === 'part' && w.how === 'lack' && !other) continue;
    for (let k = w.at; k <= w.end; k += 1) drop.add(k);
  }
  return drop.size ? tokens.filter((_, at) => !drop.has(at)).join(' ') : rest;
}

/**
 * THE TEXT WITHOUT A PROBLEM SAID NOT TO BE (./lexicon.ts `DENIAL.problemWords`,
 * review round 5.6): «ما عندي مشكلة بالنوزل بس اريد انظفه», "no problem with
 * the nozzle", «کێشەم نییە». Read only for the cues. Pure, on normalised text.
 */
function withoutDeniedProblem(rest: string): string {
  const tokens = tokenize(rest);
  const drop = new Set<number>();
  tokens.forEach((t, at) => {
    if (!PROBLEM_WORDS.some((w) => claims(t, w))) return;
    if (deniedAfter(tokens, at)) drop.add(at);
    for (let k = at - 1; k >= 0 && k >= at - DENIAL.reach; k -= 1) {
      if (PROBLEM_BEFORE.has(tokens[k])) {
        drop.add(at);
        return;
      }
      if (PROBLEM_BEFORE_HAVE.has(tokens[k])) {
        if (PROBLEM_HAVE.has(tokens[k + 1] ?? '')) drop.add(at);
        return;
      }
      if (!PROBLEM_SKIP.has(tokens[k])) return;
    }
  });
  return drop.size ? tokens.filter((_, at) => !drop.has(at)).join(' ') : rest;
}

/**
 * The printers named with a denial («ما عندي اي ون», "not the A1", "I don't
 * have an A1", «A1م نییە») or, beside another, said to be fine («الاي ون
 * زينه»), as the text names them: `rewritten` holds every spoken name as its
 * Latin token (review round 5.6). Pure, on normalised text.
 */
function deniedModelsIn(rewritten: string, models: readonly ModelToken[]): ModelToken[] {
  const tokens = tokenize(rewritten);
  return models.filter((m) =>
    MODEL_NAME_WORDS[m].some((group) =>
      tokens.some((_, at) => {
        if (group.some((w, k) => tokens[at + k] !== w)) return false;
        const end = at + group.length - 1;
        // "Fine" only beside another printer («الاي ون زينه، البي ون اس بيها كلوب»): "A1 ok" alone answers «which printer?».
        return negationAt(tokens, at, true) !== undefined || deniedAfter(tokens, end) || (models.length > 1 && fineAfter(tokens, end));
      })
    )
  );
}

export interface UnderstandOptions {
  /** The triage is asking which symptom: «خيوط» alone then means stringing. */
  expectSymptom?: boolean;
}

export function understand(typed: string, opts: UnderstandOptions = {}): Understood {
  // «P1-S» is the P1S, «x1 c» the X1C (./models.ts `joinSplitNames`); «ماعندي» is «ما عندي».
  const raw = joinSplitNames(splitGluedNegation(typed));
  // «للA1» is «لل A1»; «الاي ون» is «اي ون» (./models.ts); «ما دا تشتغل» is «ما تشتغل».
  const normalized = dropProgressive(normalizeText(splitScripts(raw)));
  const spoken = scanSpokenModels(normalized);
  const latin = latinModels(raw);
  const models = [...new Set([...spoken.models, ...latin])];
  const ids = extractIdentifiers(raw);
  // A series is read only when no printer was: «X1» is the X1C or the X1E,
  // and «X1 او P1» any of four. Never a word a size already holds: «0.4 X2»
  // is the search engine's 0.4X2.
  const read = models.length === 0 ? readFamily(raw, spoken.rest) : undefined;
  const fam = read && !ids.measures.some((m) => read.words.some((w) => m.toLowerCase().endsWith(w))) ? read : undefined;
  // Every reader below sees the text WITHOUT the spoken printer names, so the
  // «اي» of «اي ون» is never read as anything else; and with the article off
  // the first word of every known phrase, so «الهوت اند» is «هوت اند».
  const rest = bareProclitics(fam ? fam.rest : spoken.rest, CLAIM_PHRASES);

  // «اشتريت» and «من عندكم» tell what happened; they do not ask to buy. «ما عندي مشكلة» is no problem.
  const cues = scoreIntents(withoutPastPurchase(withoutDeniedProblem(rest)), compiledCues);
  const faultCue = has(cues, 'fault');
  const problemCue = has(cues, 'problem') || faultCue;
  const productCue = has(cues, 'product');
  const maintenance = has(cues, 'maintenance');
  const otherPrinter = has(cues, 'other_printer');

  // «ماعندي كلوب، عندي خيوط», "the nozzle is fine, the problem is the plate": a symptom or a part denied is not read.
  const affirmed = withoutDenied(rest);

  // «تنظيف النوزل», "nozzle cleaning": the cleaning tools FOR the nozzle. The more particular part wins.
  const partScores = scoreIntents(affirmed, compiledParts);
  const firstPart = best(partScores);
  const part = firstPart === 'nozzle_hotend' && has(partScores, 'cleaning') ? 'cleaning' : firstPart;
  const tool = part === 'cleaning' ? best(scoreIntents(affirmed, compiledTools)) : undefined;

  const symptomScores = new Map<SymptomKey, number>();
  for (const s of scoreIntents(affirmed, compiledSymptoms)) symptomScores.set(s.intent, s.score);
  if (opts.expectSymptom || problemCue) {
    for (const s of scoreIntents(affirmed, compiledStringingWeak)) symptomScores.set('stringing', (symptomScores.get('stringing') ?? 0) + s.score);
  }
  if (problemCue) {
    for (const s of scoreIntents(affirmed, compiledAmsWeak)) symptomScores.set('ams', (symptomScores.get('ams') ?? 0) + s.score);
  }
  const byWords = [...symptomScores.entries()].sort((a, b) => b[1] - a[1]);
  const wordSymptom = byWords.length > 0 && byWords[0][1] >= CONFIDENT_SCORE ? byWords[0][0] : undefined;
  const hmsCode = readHmsCode(raw);
  if (hmsCode) symptomScores.set('hms', Math.max(symptomScores.get('hms') ?? 0, 10));
  const ranked = [...symptomScores.entries()].sort((a, b) => b[1] - a[1]);
  const symptom = ranked.length > 0 && ranked[0][1] >= CONFIDENT_SCORE ? ranked[0][0] : undefined;
  // A symptom the words named before the denials came off, and none after.
  const symptomDenied = !symptom && affirmed !== rest && (best(scoreIntents(rest, compiledSymptoms)) ?? best(scoreIntents(rest, compiledStringingWeak))) !== undefined;

  // A series of one printer is that printer: the A2 series is the A2L alone.
  // A bare «A2» is also a paper size («ورق A2», "A2 paper"), so read that way
  // it is the A2L only beside a part, a printer word, a fault or a symptom.
  const single = fam && fam.members.length === 1 ? fam.members[0] : undefined;
  // Beside a part, a printer word, a fault or a symptom, or typed alone (the answer to «which printer?»).
  const beside = !!part || has(cues, 'printer') || problemCue || !!symptom || maintenance || tokenize(normalized).length === 1;
  const singleTaken = !!single && (!fam!.bare || beside);
  if (singleTaken) models.push(single!);
  // A lowercase «x1» is a quantity as often as a series («نوزل x1» is one nozzle, or the X1):
  // the series only where a bare «A2» would be the A2L.
  const named = fam && (!fam.weak || beside) && (fam.members.length > 1 || singleTaken) ? fam : undefined;
  const family =
    named && named.members.length > 1
      ? { name: named.families.map((f) => f.replace(/\s*series$/i, '')).join(' / '), members: named.members }
      : undefined;
  const familyWords = new Set(named?.words ?? []);
  const printerCue = has(cues, 'printer') || models.length > 0 || !!family;

  const hmsPieces = new Set(hmsCode ? hmsCode.split('-') : []);
  // A printer read as a printer is not also a product code: «P1S» typed alone
  // answers «which printer?», it does not ask for the code P1S.
  const modelKeys = new Set([...latin.flatMap((m) => [m.toLowerCase().replace(/\s+/g, ''), ...m.toLowerCase().split(' ')]), ...familyWords]);
  const codes = ids.codes
    .filter((c) => !hmsCode || !(hmsPieces.has(c.key.slice(0, 4)) || /^HMS/i.test(c.text)))
    .filter((c) => !modelKeys.has(c.key.toLowerCase()));

  // What nobody claimed: the words a search may still need («فولاذ»).
  const modelWords = new Set(
    latin.flatMap((m) => m.toLowerCase().split(' ')).concat(COMBO_WORDS, ['carbon', 'series', 'bambu', 'lab', 'بامبو'], [...familyWords])
  );
  let leftover = ` ${rest} `;
  for (const phrase of CLAIM_PHRASES) leftover = leftover.split(` ${phrase} `).join(' ');
  const words = tokenize(leftover.trim());
  // A series named is never an unreadable printer, read as a printer or not («ورق A2»).
  const seriesWords = new Set(fam?.words ?? []);
  const joinedNames = hyphenNames(raw);
  const scan = unreadPrinter([...tokenize(rest).filter((t) => !seriesWords.has(t)), ...joinedNames]);
  const unread = { unread: models.length === 0 && scan.unread, otherBrand: scan.otherBrand, makers: scan.makers };
  const correction = words.some((t) => CORRECTION_SET.has(t));
  const ordinal = words.map((t) => ORDINALS.get(t)).find((n) => n !== undefined);
  const outcome = readOutcome(normalized);
  const typedWords = tokenize(normalized);
  const ownPrinter =
    typedWords.length > 0 && typedWords.some((t) => OWN_MINE.has(t)) && typedWords.every((t) => OWN_MINE.has(t) || OWN_WITH.has(t));
  const priceAsk = PRICE_ASKS.some((p) => ` ${normalized} `.includes(` ${p} `));
  const residual = words
    .filter((t) => !claimedWord(t, modelWords))
    // The «cr» of «CR-10»: a piece of a printer name, not a word to search.
    .filter((t) => !(/^[a-z]+$/.test(t) && joinedNames.some((n) => n.startsWith(t) && /^\d+$/.test(n.slice(t.length)))))
    .filter((t) => !hmsCode || !/^[0-9a-f]{4,16}$/i.test(t) || !hmsPieces.has(t.toUpperCase().slice(0, 4)))
    .slice(0, RESIDUAL_MAX);

  return {
    ...(models[0] ? { model: models[0] } : {}),
    models,
    ...(family ? { family } : {}),
    ...(part ? { part } : {}),
    maintenance,
    ...(symptom ? { symptom } : {}),
    ...(hmsCode ? { hmsCode } : {}),
    measures: ids.measures,
    codes,
    productCue,
    problemCue,
    accountCue: namesAccount(typedWords),
    afterSale: namesAccount(typedWords, ACCOUNT_SET),
    deniedModels: models.length ? deniedModelsIn(spoken.rewritten, models) : [],
    ...(symptomDenied ? { symptomDenied: true } : {}),
    ...(typedWords.some((t) => COMBO_WORDS.includes(t)) ? { bundle: true } : {}),
    faultCue,
    printerCue,
    printerUnread: unread.unread,
    otherBrand: unread.otherBrand,
    ...(unread.makers.length ? { makers: unread.makers } : {}),
    ...(tool ? { tool } : {}),
    otherPrinter: otherPrinter || unread.otherBrand,
    correction,
    ...(ordinal !== undefined ? { ordinal } : {}),
    ...(outcome ? { outcome } : {}),
    ...(wordSymptom ? { wordSymptom } : {}),
    ownPrinter,
    ownsSaid: !priceAsk && !productCue && saysOwns(typedWords),
    ...(tellsPurchase(typedWords) ? { purchaseStory: true } : {}),
    triedSaid: saysTried(normalized),
    priceAsk,
    residual,
  };
}

/** «اشتريت نوزل وما يركب», "I bought a nozzle": a verb of a past purchase, and no want or need («اشتريت اي ون واريد نوزل»). Pure. */
function tellsPurchase(typedWords: readonly string[]): boolean {
  const words = unglued(typedWords);
  if (!words.some((t) => PURCHASE_VERBS.has(t))) return false;
  return ![...typedWords, ...words].some((t) => OWNS_WANT.has(t)) && !saysAny(` ${words.join(' ')} `, OWNS_WANT_PHRASES);
}

/**
 * «عندي اي ون», "I have an A1", «A1م هەیە», «پرینتەرەکەم A1ە»: a word of
 * having, owning or buying in the first person, and no want, need, have-not or
 * «اكو …؟» ("is there …?") beside it. The price and stock asks are left out by
 * the caller (./lexicon.ts `OWNS_SAID`, review round 5.4). Pure.
 */
function saysOwns(typedWords: readonly string[]): boolean {
  const words = unglued(typedWords);
  const padded = ` ${words.join(' ')} `;
  // On the typed words too: «ودي» ("I'd like") is not «و» + «دي».
  const said = [...typedWords, ...words];
  if (said.some((t) => OWNS_WANT.has(t) || OWNS_NEGATIONS.has(t)) || saysAny(padded, OWNS_WANT_PHRASES)) return false;
  // «اكو اي ون؟», «اكو طابعتي؟» ask the shop; «اكو عندي اي ون» says it.
  if (words.some((t, i) => OWNS_THERE_IS.has(t) && !OWNS_THERE_IS_MINE.has(words[i + 1] ?? ''))) return false;
  if (words.some((t) => OWNS_HAVE.has(t)) || saysAny(padded, OWNS_PHRASES)) return true;
  // Sorani «ئەی وەنەکەم», «پی وەن ئێسەکەم»: "my A1", the possessive on the spoken name (review round 5.5).
  if (possessedSoraniName(typedWords.join(' '))) return true;
  // Sorani: «A1م هەیە», «پرینتەرێکم هەیە» (the clitic «م» before «هەیە»), «پرینتەرەکەم» (my printer).
  if (words.some((t, i) => OWNS_SORANI_HAVE.has(t) && i > 0 && words[i - 1].endsWith('م'))) return true;
  return words.some((t) => t.endsWith('م') && OWNS_SORANI_PRINTER.some((p) => t.startsWith(p)));
}

export { rewriteSpokenModels, mentionsModel } from './models';
