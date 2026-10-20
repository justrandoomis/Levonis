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
import { latinModels, scanSpokenModels } from './models';
import {
  AMS_WEAK,
  FILLERS,
  MAINTENANCE_CUE,
  PART_LEXICON,
  PRINTER_CUE,
  PROBLEM_CUE,
  PRODUCT_CUE,
  STRINGING_WEAK,
  SYMPTOM_LEXICON,
} from './lexicon';

export interface Understood {
  /** The first printer named (spoken or Latin). */
  model?: ModelToken;
  models: ModelToken[];
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
  printerCue: boolean;
  /** The words no reader claimed, at most four: what is left to search for. */
  residual: string[];
}

const compiledParts = compileLexicon(PART_LEXICON);
const compiledSymptoms = compileLexicon(SYMPTOM_LEXICON);
const compiledCues = compileLexicon({
  product: PRODUCT_CUE,
  problem: PROBLEM_CUE,
  printer: PRINTER_CUE,
  maintenance: MAINTENANCE_CUE,
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

export function readHmsCode(raw: string): string | undefined {
  const named = /HMS/i.test(raw);
  const m = HMS_LONG.exec(raw) ?? HMS_PACKED.exec(raw) ?? HMS_SHORT.exec(raw);
  if (!m) return undefined;
  const groups = m.slice(1).filter(Boolean);
  // Without «HMS», a 4-group code must hold a letter or a leading zero
  // somewhere: four plain numbers («2024 1000 5000 3000») are not a printer code.
  if (!named && !groups.some((g) => /[A-F]/i.test(g) || g.startsWith('0'))) return undefined;
  return groups.map((g) => g.toUpperCase()).join('-');
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
const FILLER_SET = new Set(FILLERS.map(normalizeText).filter(Boolean));
/** Sizes and units: carried by `measures`, never searched as words. */
const MEASURE_PIECE = /^(?:\d+(?:mm|cm|m|g|kg|ml)?|mm|cm|ملم|مم|مل|ملي)$/;

function claimedWord(token: string, modelWords: ReadonlySet<string>): boolean {
  if (token.length < 2 || FILLER_SET.has(token) || MEASURE_PIECE.test(token) || modelWords.has(token)) return true;
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

export function understand(raw: string, opts: UnderstandOptions = {}): Understood {
  const normalized = normalizeText(raw);
  const spoken = scanSpokenModels(normalized);
  const latin = latinModels(raw);
  const models = [...new Set([...spoken.models, ...latin])];
  // Every reader below sees the text WITHOUT the spoken printer names, so the
  // «اي» of «اي ون» is never read as anything else.
  const rest = spoken.rest;

  const cues = scoreIntents(rest, compiledCues);
  const problemCue = has(cues, 'problem');
  const productCue = has(cues, 'product');
  const printerCue = has(cues, 'printer') || models.length > 0;
  const maintenance = has(cues, 'maintenance');

  const part = best(scoreIntents(rest, compiledParts));

  const symptomScores = new Map<SymptomKey, number>();
  for (const s of scoreIntents(rest, compiledSymptoms)) symptomScores.set(s.intent, s.score);
  if (opts.expectSymptom || problemCue) {
    for (const s of scoreIntents(rest, compiledStringingWeak)) symptomScores.set('stringing', (symptomScores.get('stringing') ?? 0) + s.score);
  }
  if (problemCue) {
    for (const s of scoreIntents(rest, compiledAmsWeak)) symptomScores.set('ams', (symptomScores.get('ams') ?? 0) + s.score);
  }
  const hmsCode = readHmsCode(raw);
  if (hmsCode) symptomScores.set('hms', Math.max(symptomScores.get('hms') ?? 0, 10));
  const ranked = [...symptomScores.entries()].sort((a, b) => b[1] - a[1]);
  const symptom = ranked.length > 0 && ranked[0][1] >= CONFIDENT_SCORE ? ranked[0][0] : undefined;

  const ids = extractIdentifiers(raw);
  const hmsPieces = new Set(hmsCode ? hmsCode.split('-') : []);
  const codes = ids.codes.filter((c) => !hmsCode || !(hmsPieces.has(c.key.slice(0, 4)) || /^HMS/i.test(c.text)));

  // What nobody claimed: the words a search may still need («فولاذ»).
  const modelWords = new Set(
    latin.flatMap((m) => m.toLowerCase().split(' ')).concat(['combo', 'carbon', 'series', 'bambu', 'lab', 'بامبو'])
  );
  let leftover = ` ${rest} `;
  for (const phrase of CLAIM_PHRASES) leftover = leftover.split(` ${phrase} `).join(' ');
  const residual = tokenize(leftover.trim())
    .filter((t) => !claimedWord(t, modelWords))
    .filter((t) => !hmsCode || !/^[0-9a-f]{4,16}$/i.test(t) || !hmsPieces.has(t.toUpperCase().slice(0, 4)))
    .slice(0, RESIDUAL_MAX);

  return {
    ...(models[0] ? { model: models[0] } : {}),
    models,
    ...(part ? { part } : {}),
    maintenance,
    ...(symptom ? { symptom } : {}),
    ...(hmsCode ? { hmsCode } : {}),
    measures: ids.measures,
    codes,
    productCue,
    problemCue,
    printerCue,
    residual,
  };
}

export { rewriteSpokenModels, mentionsModel } from './models';
