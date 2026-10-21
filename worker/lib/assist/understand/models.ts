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
 *
 * SORANI SPELLS THE SAME NAMES WITH ITS OWN LETTERS: «ئەی وەن» is the A1,
 * «پی وەن ئێس» the P1S, «ئێچ تو دی» the H2D. The Kurdish column below is the
 * letters and the digits as a Kurdish keyboard writes them out loud, joined
 * piece by piece (`spelled`), and every name it builds is a printer of the
 * registry, exactly like the Arabic column.
 *
 * A SERIES IS NOT AN UNREADABLE NAME. «X1», «بي ون», «ئێکس وەن» name a
 * printer family of the registry (X1C and X1E), not a printer the shop does
 * not know: `readFamily` reads them, every one a sentence names («X1 او P1»
 * is four printers), and a family of one printer («A2» is the A2L) is that
 * printer.
 *
 * SORANI GLUES THE ARTICLE AND THE POSSESSIVE ON AT THE END: «ئەی وەنەکەم» is
 * "my A1", «پی وەن ئێسەکە» "the P1S". `bareEnclitics` takes them off the last
 * word of a Sorani name, as `bareProclitics` takes the Arabic ones off the
 * first.
 *
 * A NAME WRITTEN IN TWO PIECES IS ONE NAME: «P1-S», «x1 c» and «نوزل p1 s»
 * are the P1S and the X1C (`joinSplitNames`), never the series read alone.
 */
import { normalizeText } from '../../assistantNlu';
import { MODELS, modelsInText } from '@levonis/catalog/bambuImport/registry/models';
import { MODEL_TOKENS, type ModelToken } from '../types';

/** The four ways «H» is written out loud. */
const H = ['اچ', 'اتش', 'اج', 'ايتش', 'ايچ'];

/** The letters and digits of a model name, spoken, as a Sorani keyboard writes them. */
const KU = {
  a: ['ئەی'],
  p: ['پی'],
  x: ['ئێکس', 'ئیکس'],
  h: ['ئێچ', 'ئەیچ', 'ئێج'],
  one: ['وەن', 'وان'],
  two: ['تو', 'تۆ'],
  s: ['ئێس', 'ئیس'],
  c: ['سی'],
  d: ['دی'],
  e: ['ئی'],
  l: ['ئێڵ', 'ئێل'],
  mini: ['مینی'],
  carbon: ['کاربۆن', 'کاربون'],
  pro: ['پرۆ', 'پرو'],
} as const;

/** Every spelling of a name said piece by piece: one form from each list, in order. */
function spelled(...pieces: ReadonlyArray<readonly string[]>): string[] {
  return pieces.reduce<string[]>((acc, list) => acc.flatMap((head) => list.map((p) => (head ? `${head} ${p}` : p))), ['']);
}

/** The Sorani names, normalised: only these lose an enclitic at their end. */
const SORANI_NAMES = new Set<string>();

/** A Sorani name said piece by piece (`spelled`), remembered as Sorani. */
function kurdish(...pieces: ReadonlyArray<readonly string[]>): string[] {
  const forms = spelled(...pieces);
  for (const form of forms) SORANI_NAMES.add(normalizeText(form));
  return forms;
}

/**
 * What Sorani glues to the END of a name: the article «ەکە», the plural
 * «ەکان», the possessives «م», «ت», «ی», «مان», and both together («ەکەم»,
 * my …). After a vowel the article is «کە» or «یەکە» («دییەکە»). Longest
 * first, normalised as the text is.
 */
const ENCLITICS: readonly string[] = [
  'ەکەمان', 'ەکەتان', 'ەکەیان', 'یەکەمان', 'یەکەم', 'یەکەت', 'یەکەی', 'ەکانم', 'ەکانت', 'ەکەم', 'ەکەت', 'ەکەی', 'ەکان', 'یەکە',
  'ەکە', 'کەم', 'کەت', 'کە', 'مان', 'تان', 'م', 'ت', 'ی',
]
  .map(normalizeText)
  .sort((a, b) => b.length - a.length);

/**
 * «ئەی وەنەکەم» → «ئەی وەن»: an enclitic on the LAST word of one of `phrases`
 * comes off. Only a Sorani name is touched, so no Arabic word loses a letter.
 */
export function bareEnclitics(normalized: string, phrases: readonly string[]): string {
  let out = ` ${normalized} `;
  for (const phrase of phrases) {
    if (!SORANI_NAMES.has(phrase)) continue;
    for (const clitic of ENCLITICS) {
      const needle = ` ${phrase}${clitic} `;
      if (out.includes(needle)) out = out.split(needle).join(` ${phrase} `);
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

export const SPOKEN_MODELS: ReadonlyArray<readonly [ModelToken, readonly string[]]> = [
  ['A1 mini', ['اي ون ميني', 'ايه ون ميني', 'اي ون مني', 'ايه ون مني', 'a one mini', ...kurdish(KU.a, KU.one, KU.mini)]],
  ['A1', ['اي ون', 'ايه ون', 'a one', ...kurdish(KU.a, KU.one)]],
  ['A2L', ['اي تو ال', 'ايه تو ال', ...kurdish(KU.a, KU.two, KU.l)]],
  ['P1P', ['بي ون بي', ...kurdish(KU.p, KU.one, KU.p)]],
  ['P1S', ['بي ون اس', 'بي ون س', ...kurdish(KU.p, KU.one, KU.s)]],
  ['P2S', ['بي تو اس', ...kurdish(KU.p, KU.two, KU.s)]],
  ['X1C', ['اكس ون كاربون', 'اكس ون كربون', 'اكس ون سي', ...kurdish(KU.x, KU.one, [...KU.carbon, ...KU.c])]],
  ['X1E', ['اكس ون اي', ...kurdish(KU.x, KU.one, KU.e)]],
  ['X2D', ['اكس تو دي', ...kurdish(KU.x, KU.two, KU.d)]],
  ['H2D Pro', [...H.map((h) => `${h} تو دي برو`), ...kurdish(KU.h, KU.two, KU.d, KU.pro)]],
  ['H2D', [...H.map((h) => `${h} تو دي`), ...kurdish(KU.h, KU.two, KU.d)]],
  ['H2S', [...H.map((h) => `${h} تو اس`), ...kurdish(KU.h, KU.two, KU.s)]],
  ['H2C', [...H.map((h) => `${h} تو سي`), ...kurdish(KU.h, KU.two, KU.c)]],
];

/**
 * A SERIES, SAID OUT LOUD: «اكس ون» (X1), «بي ون» (P1), «ئێکس وەن». Read only
 * after every whole model name above is taken out, so «اكس ون كاربون» stays
 * the X1C. The key is the registry's family («X1 Series»).
 *
 * The A2 series is not said out loud: Iraqi «اي تو» is «إي تو», "yes, just
 * now", and the A2 series is the A2L alone, so reading it would turn that
 * phrase into a definite printer. The whole «اي تو ال» is the A2L (above).
 * The Sorani «ئەی تۆ» is left out for the same reason: it is "hey, you".
 */
export const SPOKEN_FAMILIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['P1 Series', ['بي ون', ...kurdish(KU.p, KU.one)]],
  ['P2 Series', ['بي تو', ...kurdish(KU.p, KU.two)]],
  ['X1 Series', ['اكس ون', ...kurdish(KU.x, KU.one)]],
  ['X2 Series', ['اكس تو', ...kurdish(KU.x, KU.two)]],
  ['H2 Series', [...H.map((h) => `${h} تو`), ...kurdish(KU.h, KU.two)]],
];

/** Every phrase, normalised once, longest first. */
const PHRASES: ReadonlyArray<readonly [string, ModelToken]> = SPOKEN_MODELS.flatMap(([token, forms]) =>
  forms.map((f) => [normalizeText(f), token] as const)
).sort((a, b) => b[0].length - a[0].length);

const SPOKEN_PHRASES = PHRASES.map(([phrase]) => phrase);

const PRINTER_TOKENS = new Set<string>(MODEL_TOKENS);

/** Registry family → the printers of it this assistant can name, in the registry's order. */
export const FAMILY_MEMBERS: ReadonlyMap<string, readonly ModelToken[]> = new Map(
  MODELS.filter((m) => m.kind === 'printer_family').map((f) => [
    f.token,
    MODELS.filter((m) => m.kind === 'printer' && m.series === f.token && PRINTER_TOKENS.has(m.token)).map((m) => m.token as ModelToken),
  ])
);

/** «x1» → «X1 Series»: the short Latin name of every family that is not itself a printer («A1» is the A1). */
const FAMILY_SHORT: ReadonlyMap<string, string> = new Map(
  [...FAMILY_MEMBERS.keys()]
    .map((family) => [family.replace(/\s*series$/i, '').toLowerCase(), family] as const)
    .filter(([short]) => !modelsInText(short).some((e) => e.kind === 'printer'))
);

const FAMILY_PHRASES: ReadonlyArray<readonly [string, string]> = SPOKEN_FAMILIES.flatMap(([family, forms]) =>
  forms.map((f) => [normalizeText(f), family] as const)
).sort((a, b) => b[0].length - a[0].length);
const FAMILY_SPOKEN = FAMILY_PHRASES.map(([phrase]) => phrase);

export interface FamilyRead {
  /** The registry's families, «X1 Series», in the order found. */
  families: string[];
  /** Their printers, in the registry's order, each once. One printer means the family IS that printer. */
  members: ModelToken[];
  /** `rest` with every spoken family taken out. */
  rest: string;
  /** The words that named them («x1», «series»): claimed, never searched, never an unread printer. */
  words: string[];
  /**
   * Read from a bare Latin short name alone («A2», «X1»): no «series», nothing
   * spoken. «A2» is also a paper size, so a family of one printer read this
   * way is that printer only beside a part, a printer word or a fault.
   */
  bare: boolean;
}

/**
 * The printer families a sentence names when it names no printer: spoken
 * («اكس ون», «ئێکس وەن»), Latin («X1», «p1»), or the registry's own «X1
 * Series». EVERY family it names: «نوزل X1 او P1» and «Nozzle Wiper - X1/P1
 * Series» are four printers, not one series and an unreadable name. `rest` is
 * the normalised text with the read printer names already taken out
 * (`scanSpokenModels`). A lowercase «x2» is a quantity as often as a series
 * («نوزل x2», two nozzles), so the X series is read from a capital X only.
 * Pure.
 */
export function readFamily(raw: string, rest: string): FamilyRead | undefined {
  const families: string[] = [];
  const words: string[] = [];
  let spoken = false;
  let named = false;
  let text = ` ${bareEnclitics(bareProclitics(rest, FAMILY_SPOKEN), FAMILY_SPOKEN)} `;
  for (const [phrase, family] of FAMILY_PHRASES) {
    const needle = ` ${phrase} `;
    if (!text.includes(needle)) continue;
    text = text.split(needle).join(' ');
    spoken = true;
    if (!families.includes(family)) families.push(family);
  }
  const left = text.replace(/\s+/g, ' ').trim();
  for (const entry of modelsInText(splitScripts(raw))) {
    if (entry.kind !== 'printer_family') continue;
    named = true;
    if (!families.includes(entry.token)) families.push(entry.token);
    words.push(entry.token.replace(/\s*series$/i, '').toLowerCase(), 'series');
  }
  for (const token of left.split(' ')) {
    const family = FAMILY_SHORT.get(token);
    if (!family) continue;
    if (token.startsWith('x') && !new RegExp(`(?<![A-Za-z0-9])${token.toUpperCase()}(?![A-Za-z0-9])`).test(raw)) continue;
    if (!families.includes(family)) families.push(family);
    words.push(token);
  }
  if (families.length === 0) return undefined;
  const found = new Set(families.flatMap((family) => FAMILY_MEMBERS.get(family) ?? []));
  const members = MODEL_TOKENS.filter((m) => found.has(m));
  return { families, members, rest: left, words: [...new Set(words)], bare: !spoken && !named };
}

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
  let rewritten = ` ${bareEnclitics(bareProclitics(normalized, SPOKEN_PHRASES), SPOKEN_PHRASES)} `;
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

/**
 * «P1-S», «x1 c», «X1-C» → «P1S», «x1c», «X1C»: a series followed by the one
 * letter that completes a printer of the registry is that printer. Only a
 * join the registry reads as exactly that printer is made, so «A1 mini» and
 * «X1 Carbon» (more than one letter) and «A1 a» (no such printer) stay as
 * typed. Pure.
 */
export function joinSplitNames(raw: string): string {
  return raw.replace(SPLIT_NAME, (whole, head: string, tail: string) => {
    const joined = `${head}${tail}`;
    const read = modelsInText(joined).filter((e) => e.kind === 'printer');
    return read.length === 1 && read[0].token.replace(/\s+/g, '').toLowerCase() === joined.toLowerCase() ? joined : whole;
  });
}
const SPLIT_NAME = /(?<![A-Za-z0-9])([A-Za-z]\d)[\s_\-\u2010-\u2014]+([A-Za-z])(?![A-Za-z0-9])/g;

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
 * A spoken digit («ون», «تو», «وەن») is part of a model name only right after
 * a spoken LETTER («زد ون», «كي ون سي») or a maker («نبتون فور», Neptune 4):
 * alone it is a word of its own. Iraqi «تو» is "just now" («اشتريته تو»),
 * «اي تو» is "yes, just now", and «ثري دي» is "3D", the kind of printer,
 * never a model. A Latin letter-and-digit token that is not a size, a
 * material («PA6», «TPU 95A»), a screw («M3», «BT2»), a nozzle standard
 * («V6», «MK8»), a connector or a belt («SH1.0», «PH2.0», «GT2»), a paper
 * size («A4»), a hotend maker («E3D»), a machine that is not a printer (the
 * R1 laser, the E1 purifier) or the AMS is a model name.
 */
/** Sorani «تۆ» (you) is not here: «ئەی تۆ» is "hey, you". */
const SPOKEN_DIGITS = new Set(['ون', 'وان', 'تو', 'ثري', 'فور', 'وەن'].map(normalizeText));
/** The Latin letters said out loud, Arabic and Sorani, that start a spoken model name. */
const SPOKEN_LETTERS = new Set(
  [
    'اي', 'ايه', 'بي', 'سي', 'دي', 'اف', 'جي', ...H, 'كي', 'كاي', 'ال', 'ام', 'ان', 'او', 'كيو', 'ار', 'اس', 'تي', 'يو', 'في',
    'دبليو', 'اكس', 'واي', 'زد', 'زي', 'ئەی', 'پی', 'ئێکس', 'ئیکس', 'ئێچ', 'ئەیچ', 'ئێس', 'ئی', 'کەی', 'زێد', 'ئێم', 'ئێن', 'ئێڵ',
  ].map(normalizeText)
);
/**
 * Spoken words that are not a printer, read before any spoken digit: «ثري
 * دي» ("3D", the kind of printer) and «اي تو» («إي تو», "yes, just now").
 */
const NOT_NAMES = ['ثري دي', 'تري دي', 'سري دي', 'ثرى دى', 'اي تو', 'ايه تو'].map(normalizeText);
const MODEL_SHAPE = /^[a-z]{1,3}\d{1,2}[a-z]{0,4}$/;
const NOT_A_MODEL =
  /^(?:pa|ppa|pps|pc|pet|petg|pla|abs|asa|tpu|tpe|pva|hips|pp|m|mk|v|ams)\d{1,2}(?:cf|gf|hf|a|d)?$|^(?:sh|ph|xh|zh|gh|jst|gt|bt|n|d|dc|idc|co)\d{1,2}[a-z]{0,2}$|^a[3-6]$|^(?:e3d|r1|e1)$/;
/** Printer makers the shop does not sell printers of, as written in Latin, Arabic and Sorani. */
export const OTHER_BRANDS: readonly string[] = [
  'creality', 'ender', 'prusa', 'anycubic', 'kobra', 'elegoo', 'neptune', 'sovol', 'voron', 'flashforge', 'qidi', 'artillery',
  'snapmaker', 'كريالتي', 'كرياليتي', 'كريلتي', 'اندر', 'بروسا', 'انيكيوبك', 'انيكيوبيك', 'اليجو', 'ايليجو', 'سنابميكر', 'فلاشفورج',
  // «نبتون فور» (Neptune 4), «كوبرا تو» (Kobra 2): the line is said, not the maker.
  'نبتون', 'نيبتون', 'نبتيون', 'كوبرا', 'فورون', 'سوفول', 'كيدي', 'ارتيلري', 'ارتلري',
  'کریالیتی', 'ئێندەر', 'پروسا', 'ئەنیکیوبیک', 'ئیلیگۆ', 'نێپتوون', 'نێپتون', 'کۆبرا', 'ڤۆرۆن', 'سۆڤۆڵ',
];
const OTHER_BRAND_SET = new Set(OTHER_BRANDS.map(normalizeText));

/** A maker's name, with an Arabic proclitic on it or not («للكريالتي»). */
function isBrand(token: string): boolean {
  if (OTHER_BRAND_SET.has(token)) return true;
  return PROCLITICS.some((c) => token.length > c.length + 1 && token.startsWith(c) && OTHER_BRAND_SET.has(token.slice(c.length)));
}

export interface UnreadPrinter {
  /** A word that names a printer the tables above could not read. */
  unread: boolean;
  /** One of those words is another maker's name. */
  otherBrand: boolean;
}

/** `words`: the words of the sentence with every READ printer name already taken out. */
export function unreadPrinter(words: readonly string[]): UnreadPrinter {
  let unread = false;
  let otherBrand = false;
  let joined = ` ${words.join(' ')} `;
  for (const phrase of NOT_NAMES) joined = joined.split(` ${phrase} `).join(' ');
  const tokens = joined.trim().split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    for (const clitic of PROCLITICS) {
      if (t.length > clitic.length + 1 && t.startsWith(clitic) && OTHER_BRAND_SET.has(t.slice(clitic.length))) {
        t = t.slice(clitic.length);
        break;
      }
    }
    if (OTHER_BRAND_SET.has(t)) {
      unread = true;
      otherBrand = true;
    } else if (SPOKEN_DIGITS.has(t) ? i > 0 && (SPOKEN_LETTERS.has(tokens[i - 1]) || isBrand(tokens[i - 1])) : MODEL_SHAPE.test(t) && !NOT_A_MODEL.test(t)) {
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
