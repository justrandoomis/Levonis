/**
 * PRINTER NAMES AS PEOPLE SAY THEM.
 *
 * «نوزل مال اي ون» names the A1 out loud: "a", "one", each written as an
 * Arabic word. The search engine's spelled-letter table reads «بي» as B, so
 * «بي ون اس» would spell b1s and never reach the P1S; and a lone «اي» is the
 * Arabic word "which" («اي طابعة تنصحني»), not a letter. Only a table of WHOLE
 * PHRASES knows which runs of words are a printer, so this is one.
 *
 * Every phrase is matched whole, between gaps, after `normalizeText` (so
 * «أي ون» and «اي ون» are one phrase), longest first, and consumed once. Each
 * target token must be a printer in Bambu's own registry
 * (packages/catalog/src/bambuImport/registry/models.ts); a test fails on any
 * token the registry does not know.
 *
 * Latin spellings (A1, a1mini, X1 Carbon, P1S) are read by the registry's own
 * `modelsInText`, not by a second copy of it here.
 *
 * THE ARTICLE AND THE PREPOSITION ARE GLUED ON. Arabic writes «ال» (the),
 * «لل» (for the), «بال» (in the), «و» (and) as part of the next word, so
 * «للبي ون اس», «الاي ون» and «للA1» name a printer exactly as «بي ون اس» and
 * «A1» do. A phrase that only matched between spaces read none of them, and
 * the printer remembered from earlier in the chat silently answered in its
 * place. `bareProclitics` takes the clitic off the first word of a known
 * phrase, and `splitScripts` cuts «للA1» into «لل A1» before anything reads it.
 */
import { normalizeText } from '../../assistantNlu';
import { modelsInText } from '@levonis/catalog/bambuImport/registry/models';
import { MODEL_TOKENS, type ModelToken } from '../types';

/** The four ways «H» is written out loud. */
const H = ['اچ', 'اتش', 'اج', 'ايتش', 'ايچ'];

export const SPOKEN_MODELS: ReadonlyArray<readonly [ModelToken, readonly string[]]> = [
  ['A1 mini', ['اي ون ميني', 'ايه ون ميني', 'اي ون مني', 'ايه ون مني', 'a one mini']],
  ['A1', ['اي ون', 'ايه ون', 'a one']],
  ['A2L', ['اي تو ال', 'ايه تو ال']],
  ['P1P', ['بي ون بي']],
  ['P1S', ['بي ون اس', 'بي ون س']],
  ['P2S', ['بي تو اس']],
  ['X1C', ['اكس ون كاربون', 'اكس ون كربون', 'اكس ون سي']],
  ['X1E', ['اكس ون اي']],
  ['X2D', ['اكس تو دي']],
  ['H2D Pro', H.map((h) => `${h} تو دي برو`)],
  ['H2D', H.map((h) => `${h} تو دي`)],
  ['H2S', H.map((h) => `${h} تو اس`)],
  ['H2C', H.map((h) => `${h} تو سي`)],
];

/** Every phrase, normalised once, longest first. */
const PHRASES: ReadonlyArray<readonly [string, ModelToken]> = SPOKEN_MODELS.flatMap(([token, forms]) =>
  forms.map((f) => [normalizeText(f), token] as const)
).sort((a, b) => b[0].length - a[0].length);

const SPOKEN_PHRASES = PHRASES.map(([phrase]) => phrase);

const PRINTER_TOKENS = new Set<string>(MODEL_TOKENS);

/**
 * What Arabic glues to the front of a word: the article, «لل», «بال», «وال»,
 * «فال», «كال», and the single-letter «و», «ب», «ل», «ف». Longest first.
 */
export const PROCLITICS: readonly string[] = ['وبال', 'فال', 'وال', 'بال', 'كال', 'ولل', 'لل', 'ال', 'و', 'ب', 'ل', 'ف'];
const ARABIC_START = /^[\u0600-\u06FF]/;

/**
 * «للبي ون اس» → «بي ون اس»: a proclitic on the FIRST word of one of `phrases`
 * comes off. Only a known phrase is touched, so no other word loses a letter.
 * `normalized` is `normalizeText` output; the phrases are normalised too.
 */
export function bareProclitics(normalized: string, phrases: readonly string[]): string {
  let out = ` ${normalized} `;
  for (const phrase of phrases) {
    if (!ARABIC_START.test(phrase)) continue;
    for (const clitic of PROCLITICS) {
      const needle = ` ${clitic}${phrase} `;
      if (out.includes(needle)) out = out.split(needle).join(` ${phrase} `);
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * «للA1» → «لل A1», «بالP1S» → «بال P1S», «الـAMS» → «الـ AMS»: a Latin name
 * glued to an Arabic word is its own word. Digits stay with whichever letters
 * they follow, so «A1» and «٠.٢» are untouched.
 */
export function splitScripts(raw: string): string {
  return raw.replace(ARABIC_THEN_LATIN, '$1 ').replace(LATIN_THEN_ARABIC, '$1 ');
}
/** Arabic LETTERS only: the Arabic-Indic digits (U+0660–U+0669, U+06F0–U+06F9) stay with their neighbours. */
const ARABIC_THEN_LATIN = /([\u0600-\u065F\u066A-\u06EF\u06FA-\u06FF])(?=[A-Za-z])/g;
const LATIN_THEN_ARABIC = /([A-Za-z0-9])(?=[\u0600-\u065F\u066A-\u06EF\u06FA-\u06FF])/g;

export interface SpokenScan {
  /** The printers named out loud, in the order found. */
  models: ModelToken[];
  /** The normalised text with each matched phrase replaced by its Latin token. */
  rewritten: string;
  /** The normalised text with each matched phrase removed. */
  rest: string;
}

/** Scan NORMALISED text for spoken model names. Pure. */
export function scanSpokenModels(normalized: string): SpokenScan {
  let rewritten = ` ${bareProclitics(normalized, SPOKEN_PHRASES)} `;
  let rest = rewritten;
  const models: ModelToken[] = [];
  for (const [phrase, token] of PHRASES) {
    const needle = ` ${phrase} `;
    if (!rest.includes(needle)) continue;
    if (!models.includes(token)) models.push(token);
    rest = rest.split(needle).join(' ');
    rewritten = rewritten.split(needle).join(` ${token.toLowerCase()} `);
  }
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
  return { models, rewritten: tidy(rewritten), rest: tidy(rest) };
}

/** The printers a text names in Latin letters, through the registry. Families are left out. */
export function latinModels(raw: string): ModelToken[] {
  return modelsInText(splitScripts(raw))
    .filter((e) => e.kind === 'printer' && PRINTER_TOKENS.has(e.token))
    .map((e) => e.token as ModelToken);
}

/**
 * A PRINTER NAMED THAT COULD NOT BE READ. «زد ون», «k1c», «كريالتي»: the
 * customer named a printer, just not one this table knows. The orchestrator
 * then neither answers for the printer remembered from earlier in the chat
 * nor guesses: it asks which printer, or treats it as «another printer».
 *
 * Spoken digits («ون», «تو») are only ever part of a spoken model name in a
 * sentence to a printer shop; a Latin letter-and-digit token that is not a
 * size, a material («PA6»), a screw («M3») or a nozzle standard («V6», «MK8»)
 * is a model name.
 */
const SPOKEN_DIGITS = new Set(['ون', 'وان', 'تو', 'ثري', 'فور']);
const MODEL_SHAPE = /^[a-z]{1,3}\d{1,2}[a-z]{0,4}$/;
const NOT_A_MODEL = /^(?:pa|ppa|pps|pc|pet|pla|abs|asa|tpu|pva|hips|pp|m|mk|v)\d{1,2}(?:cf|gf|hf)?$/;
/** Printer makers the shop does not sell printers of, as written in Latin and in Arabic. */
export const OTHER_BRANDS: readonly string[] = [
  'creality', 'ender', 'prusa', 'anycubic', 'kobra', 'elegoo', 'neptune', 'sovol', 'voron', 'flashforge', 'qidi', 'artillery',
  'snapmaker', 'كريالتي', 'كرياليتي', 'كريلتي', 'اندر', 'بروسا', 'انيكيوبك', 'انيكيوبيك', 'اليجو', 'ايليجو', 'سنابميكر', 'فلاشفورج',
];
const OTHER_BRAND_SET = new Set(OTHER_BRANDS.map(normalizeText));

export interface UnreadPrinter {
  /** A word that names a printer the tables above could not read. */
  unread: boolean;
  /** One of those words is another maker's name. */
  otherBrand: boolean;
}

/** `tokens`: the words of the sentence with every READ printer name already taken out. */
export function unreadPrinter(tokens: readonly string[]): UnreadPrinter {
  let unread = false;
  let otherBrand = false;
  for (const raw of tokens) {
    let t = raw;
    for (const clitic of PROCLITICS) {
      if (t.length > clitic.length + 1 && t.startsWith(clitic) && OTHER_BRAND_SET.has(t.slice(clitic.length))) {
        t = t.slice(clitic.length);
        break;
      }
    }
    if (OTHER_BRAND_SET.has(t)) {
      unread = true;
      otherBrand = true;
    } else if (SPOKEN_DIGITS.has(t) || (MODEL_SHAPE.test(t) && !NOT_A_MODEL.test(t))) {
      unread = true;
    }
  }
  return { unread, otherBrand };
}

/**
 * The text a legacy handler should read: every spoken printer name written
 * as its token («كم تستهلك بي ون اس» → «كم تستهلك p1s»). The raw text comes
 * back unchanged when nothing was spoken, so punctuation the legacy readers
 * use (an order id's hyphen) is never lost for nothing.
 */
export function rewriteSpokenModels(raw: string): string {
  const scan = scanSpokenModels(normalizeText(raw));
  return scan.models.length ? scan.rewritten : raw;
}

/**
 * The words a product's own name or options must carry for it to MENTION a
 * printer (the by-name fallback, when no catalogue link exists). Alternatives:
 * any one group, all of its words. «Bambu Hotend - X1/P1» names the X1C and
 * the P1S by their series, so the series word counts.
 */
export const MODEL_NAME_WORDS: Readonly<Record<ModelToken, ReadonlyArray<readonly string[]>>> = {
  'A1 mini': [['a1', 'mini'], ['a1mini']],
  A1: [['a1']],
  A2L: [['a2l'], ['a2']],
  P1P: [['p1p'], ['p1']],
  P1S: [['p1s'], ['p1']],
  P2S: [['p2s'], ['p2']],
  X1C: [['x1c'], ['x1']],
  X1E: [['x1e'], ['x1']],
  X2D: [['x2d'], ['x2']],
  'H2D Pro': [['h2d', 'pro']],
  H2D: [['h2d']],
  H2S: [['h2s']],
  H2C: [['h2c']],
};

/** True when `text` carries every word of one of the model's groups, as whole words. */
export function mentionsModel(text: string, model: ModelToken): boolean {
  const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  return MODEL_NAME_WORDS[model].some((group) => group.every((w) => words.has(w)));
}
