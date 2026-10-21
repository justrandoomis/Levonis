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
import {
  bareProclitics,
  hyphenNames,
  joinSplitNames,
  latinModels,
  printerNameWord,
  readFamily,
  scanSpokenModels,
  splitScripts,
  unreadPrinter,
} from './models';
import {
  ACCOUNT_WORDS,
  AMS_WEAK,
  CLEANING_TOOLS,
  CORRECTION_WORDS,
  FAULT_CUE,
  FILLERS,
  ORDINAL_WORDS,
  OTHER_PRINTER,
  OUTCOME_NOT_FIXED,
  OUTCOME_NOT_TRIED,
  OUTCOME_RESOLVED,
  MAINTENANCE_CUE,
  OWN_PRINTER,
  OWNS_PRINTER,
  PART_LEXICON,
  PAST_PURCHASE,
  PRICE_ASK,
  PRINTER_CUE,
  PROBLEM_CUE,
  PRODUCT_CUE,
  STRINGING_WEAK,
  SYMPTOM_LEXICON,
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
   * «عندي اي ون», «طابعتي A1», "I have an A1", «A1م هەیە»: the customer says
   * which printer is theirs, so the sentence never asks to buy it (review
   * round 4.3, ./lexicon.ts `OWNS_PRINTER`).
   */
  ownsPrinter: boolean;
  /** "how much?", «شكد؟»: a price asked, whatever the intent scorer made of it. */
  priceAsk: boolean;
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
const ARABIC_PROCLITICS = ['وبال', 'وال', 'بال', 'فال', 'لل', 'ال', 'وب', 'ول', 'و', 'ب', 'ل'];
function namesAccount(tokens: readonly string[]): boolean {
  return tokens.some(
    (t) => ACCOUNT_SET.has(t) || (ARABIC.test(t) && ARABIC_PROCLITICS.some((p) => t.startsWith(p) && t.length - p.length >= 3 && ACCOUNT_SET.has(t.slice(p.length))))
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
const NOT_TRIED = OUTCOME_NOT_TRIED.map(normalizeText).filter(Boolean);
const RESOLVED = OUTCOME_RESOLVED.map(normalizeText).filter(Boolean);
const OWNS_WORDS = new Set(OWNS_PRINTER.words.map(normalizeText).filter(Boolean));
const OWNS_PHRASES = OWNS_PRINTER.phrases.map(normalizeText).filter(Boolean);

/**
 * «جربتها وما انحلّت» → not fixed; «انحلت» → resolved. The negated list first.
 * «بعدني ما جربتها», "I still have not tried them" → none: the steps were not
 * tried, so nothing is known of their outcome. Pure.
 */
export function readOutcome(normalized: string): 'resolved' | 'not_fixed' | undefined {
  // «وما» is «و» + «ما»: the conjunction glued on must not hide the negation.
  const padded = ` ${normalized} `.replace(/ و(ما|لم) /g, ' $1 ');
  if (NOT_TRIED.some((p) => padded.includes(` ${p} `))) return undefined;
  if (NOT_FIXED.some((p) => padded.includes(` ${p} `))) return 'not_fixed';
  if (RESOLVED.some((p) => padded.includes(` ${p} `))) return 'resolved';
  return undefined;
}
/** «عندي اي ون», «وعندي طابعة», "I have an A1", «A1م هەیە»: a printer the customer says is theirs. Pure. */
function saysOwned(normalized: string, tokens: readonly string[]): boolean {
  if (tokens.some((t) => OWNS_WORDS.has(t) || (t.startsWith('و') && OWNS_WORDS.has(t.slice(1))))) return true;
  const padded = ` ${normalized} `;
  return OWNS_PHRASES.some((p) => padded.includes(` ${p} `));
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

export interface UnderstandOptions {
  /** The triage is asking which symptom: «خيوط» alone then means stringing. */
  expectSymptom?: boolean;
}

export function understand(typed: string, opts: UnderstandOptions = {}): Understood {
  // «P1-S» is the P1S, «x1 c» the X1C (./models.ts `joinSplitNames`).
  const raw = joinSplitNames(typed);
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

  // «اشتريت» and «من عندكم» tell what happened; they do not ask to buy.
  const cues = scoreIntents(withoutPastPurchase(rest), compiledCues);
  const faultCue = has(cues, 'fault');
  const problemCue = has(cues, 'problem') || faultCue;
  const productCue = has(cues, 'product');
  const maintenance = has(cues, 'maintenance');
  const otherPrinter = has(cues, 'other_printer');

  // «تنظيف النوزل», "nozzle cleaning": the cleaning tools FOR the nozzle. The more particular part wins.
  const partScores = scoreIntents(rest, compiledParts);
  const firstPart = best(partScores);
  const part = firstPart === 'nozzle_hotend' && has(partScores, 'cleaning') ? 'cleaning' : firstPart;
  const tool = part === 'cleaning' ? best(scoreIntents(rest, compiledTools)) : undefined;

  const symptomScores = new Map<SymptomKey, number>();
  for (const s of scoreIntents(rest, compiledSymptoms)) symptomScores.set(s.intent, s.score);
  if (opts.expectSymptom || problemCue) {
    for (const s of scoreIntents(rest, compiledStringingWeak)) symptomScores.set('stringing', (symptomScores.get('stringing') ?? 0) + s.score);
  }
  if (problemCue) {
    for (const s of scoreIntents(rest, compiledAmsWeak)) symptomScores.set('ams', (symptomScores.get('ams') ?? 0) + s.score);
  }
  const byWords = [...symptomScores.entries()].sort((a, b) => b[1] - a[1]);
  const wordSymptom = byWords.length > 0 && byWords[0][1] >= CONFIDENT_SCORE ? byWords[0][0] : undefined;
  const hmsCode = readHmsCode(raw);
  if (hmsCode) symptomScores.set('hms', Math.max(symptomScores.get('hms') ?? 0, 10));
  const ranked = [...symptomScores.entries()].sort((a, b) => b[1] - a[1]);
  const symptom = ranked.length > 0 && ranked[0][1] >= CONFIDENT_SCORE ? ranked[0][0] : undefined;

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
    ownsPrinter: saysOwned(normalized, typedWords),
    priceAsk: PRICE_ASKS.some((p) => ` ${normalized} `.includes(` ${p} `)),
    residual,
  };
}

export { rewriteSpokenModels, mentionsModel } from './models';
