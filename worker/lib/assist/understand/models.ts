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

const PRINTER_TOKENS = new Set<string>(MODEL_TOKENS);

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
  let rewritten = ` ${normalized} `;
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
  return modelsInText(raw)
    .filter((e) => e.kind === 'printer' && PRINTER_TOKENS.has(e.token))
    .map((e) => e.token as ModelToken);
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
