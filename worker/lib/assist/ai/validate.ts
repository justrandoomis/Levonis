/**
 * EVERY MODEL ANSWER PASSES THROUGH HERE, OR IT IS NOTHING (push B plan §6.2,
 * §7 "Local validation", invariants I2, I3, I4). PURE: no I/O, no clock.
 *
 * A model fills one closed-set JSON object; the provider's own schema check
 * only shapes it. These hand-written readers are the real gate:
 *
 *   - the value is a plain object with EXACTLY the expected keys;
 *   - every enum is compared case-insensitively and canonicalised, and the
 *     `"none"` sentinel becomes an absent field;
 *   - a field that disagrees with the action it rides on is a refusal, never
 *     a guess (an `intent` action without an intent, an outcome outside the
 *     steps stage);
 *   - search terms survive only as WHOLE TOKENS of the customer's own text
 *     (I4): a model can narrow a search with words the customer typed, never
 *     add one;
 *   - HMS codes survive only in the canonical form push A's own reader gives
 *     (`readHmsCode`), and label codes are kept for the identifier lane only,
 *     never shown.
 *
 * Anything else is `null`, which every caller reads as basic mode. No field
 * here can carry a price, a stock level, a compatibility verdict, an HMS
 * meaning, an order or user id, a URL or a sentence (I2).
 */
import { normalizeText, tokenize } from '../../assistantNlu';
import type { AssistContext } from '../context';
import { HMS_CODE_SHAPE } from '../context';
import { PART_KEYS, SYMPTOM_KEYS, type ModelToken, type PartKey, type SymptomKey } from '../types';
import { readHmsCode } from '../understand';
import { PHOTO_SUBJECTS, READING_ACTIONS, READING_OUTCOMES, ROUTABLE_INTENTS, type PhotoReading, type Reading, type RoutableIntent } from './adapter';
import { tokenOfAlias } from './aliases';

const READING_KEYS = ['action', 'intent', 'printer', 'part', 'symptom', 'outcome', 'maintenance', 'terms'] as const;
const PHOTO_KEYS = ['subject', 'printer', 'symptom', 'part', 'hms_codes', 'label_codes', 'confidence'] as const;

export const TERMS_MAX = 4;
export const TERM_MIN_CHARS = 2;
export const TERM_MAX_CHARS = 32;
export const HMS_CODES_MAX = 3;
export const LABEL_CODES_MAX = 4;
/** The label shape the vision schema asks for, checked again here. */
export const LABEL_CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/;
/** An array longer than this is not an answer at all, whatever its entries say. */
const ARRAY_MAX = 16;

/** A plain object whose own keys are exactly `keys`, or null. */
function exactObject(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Object.keys(raw);
  if (own.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(raw, k))) return null;
  return raw as Record<string, unknown>;
}

const NONE = Symbol('none');

/**
 * One enum value, case-insensitively, as its canonical member; `NONE` for the
 * `"none"` sentinel when it is allowed; `undefined` for anything else.
 */
function member<T extends string>(set: readonly T[], v: unknown, allowNone = true): T | typeof NONE | undefined {
  if (typeof v !== 'string') return undefined;
  const k = v.trim().toLowerCase();
  if (allowNone && k === 'none') return NONE;
  return set.find((m) => m.toLowerCase() === k);
}

/** A list of strings and nothing else, or null. */
function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > ARRAY_MAX) return null;
  return v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** The customer's text as push A's readers see it: normalised tokens. */
function textTokens(text: string): string[] {
  return tokenize(normalizeText(text));
}

/**
 * The terms a model may search with: each, normalised, a contiguous run of
 * WHOLE tokens of the customer's own text (I4). Every other term is dropped,
 * never repaired. The survivors are returned normalised, each once.
 */
export function verifiedTerms(terms: readonly string[], customerText: string): string[] {
  const said = textTokens(customerText);
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (t.length < TERM_MIN_CHARS || t.length > TERM_MAX_CHARS) continue;
    const words = textTokens(t);
    if (words.length === 0) continue;
    let found = false;
    for (let i = 0; i + words.length <= said.length && !found; i++) {
      found = words.every((w, j) => said[i + j] === w);
    }
    const term = words.join(' ');
    if (found && !out.includes(term)) out.push(term);
    if (out.length === TERMS_MAX) break;
  }
  return out;
}

/**
 * An HMS code as push A's reader writes it, or undefined. The four-group form
 * goes through `readHmsCode` as typed (which refuses four plain numbers); the
 * two-group form is the printer's short code and is read as one («HMS …»).
 * The result must be the SAME groups the input named, in the canonical
 * `XXXX-XXXX[-XXXX-XXXX]` form that passes `HMS_CODE_SHAPE`: a three-group
 * code, a truncated read or anything longer is refused.
 */
export function canonicalHmsCode(code: unknown): string | undefined {
  if (typeof code !== 'string' || code.length > 40) return undefined;
  const typed = code.trim().toUpperCase().replace(/[_ ]/g, '-');
  if (!HMS_CODE_SHAPE.test(typed)) return undefined;
  const groups = typed.split('-').length;
  const read = groups === 4 ? readHmsCode(typed) : groups === 2 ? readHmsCode(`HMS ${typed}`) : undefined;
  return read && read === typed && HMS_CODE_SHAPE.test(read) ? read : undefined;
}

/**
 * The understanding reading (plan §7 READING_SCHEMA), or null.
 *
 * `customerText` is the customer's UNREDACTED text, which the server keeps:
 * terms are checked against what the customer actually typed. `ctx` decides
 * whether an outcome may stand (only while the steps are on screen).
 */
export function readReading(raw: unknown, customerText: string, ctx: AssistContext): Reading | null {
  const o = exactObject(raw, READING_KEYS);
  if (!o) return null;
  const action = member(READING_ACTIONS, o.action, false);
  const intent = member(ROUTABLE_INTENTS, o.intent);
  const printerRaw = typeof o.printer === 'string' ? o.printer.trim().toLowerCase() : null;
  const part = member(PART_KEYS, o.part);
  const symptom = member(SYMPTOM_KEYS, o.symptom);
  const outcome = member(READING_OUTCOMES, o.outcome);
  const terms = stringList(o.terms);
  if (!action || action === NONE || !intent || !part || !symptom || !outcome || printerRaw === null || terms === null) return null;
  if (typeof o.maintenance !== 'boolean') return null;
  const printer: ModelToken | 'other' | undefined =
    printerRaw === 'none' ? undefined : printerRaw === 'other' ? 'other' : (tokenOfAlias(printerRaw) ?? undefined);
  if (printerRaw !== 'none' && printer === undefined) return null;

  // `intent` names a question only with the `intent` action, and that action needs one.
  if ((action === 'intent') !== (intent !== NONE)) return null;
  const partKey = part === NONE ? undefined : (part as PartKey);
  const symptomKey = symptom === NONE ? undefined : (symptom as SymptomKey);

  switch (action) {
    case 'intent':
      return { action: 'intent', intent: intent as RoutableIntent };
    case 'outcome':
      // Only while the curated steps are on screen, and only with an outcome.
      if (ctx.triage?.stage !== 'steps' || outcome === NONE) return null;
      return { action: 'outcome', outcome: outcome as 'resolved' | 'not_fixed' };
    case 'triage':
      return { action: 'triage', ...(printer ? { model: printer } : {}), ...(symptomKey ? { symptom: symptomKey } : {}) };
    case 'products': {
      const kept = verifiedTerms(terms, customerText);
      // Nothing to search for: no part, no printer of the shop's and no word the customer typed.
      if (!partKey && (!printer || printer === 'other') && kept.length === 0) return null;
      return {
        action: 'products',
        ...(printer ? { model: printer } : {}),
        ...(partKey ? { part: partKey } : {}),
        maintenance: o.maintenance,
        terms: kept,
      };
    }
    default:
      return { action: 'none' };
  }
}

/**
 * The photo or clip reading (plan §7 PHOTO_SCHEMA), or null.
 *
 * Low confidence keeps only the HMS codes (a code is checked again by push
 * A's reader and confirmed by the customer); the printer is kept only with
 * high confidence; an `unclear` subject is an empty reading. Label codes are
 * shape-checked and capped, and only ever reach the identifier lane.
 */
export function readPhotoReading(raw: unknown): PhotoReading | null {
  const o = exactObject(raw, PHOTO_KEYS);
  if (!o) return null;
  const subject = member(PHOTO_SUBJECTS, o.subject, false);
  const printerRaw = typeof o.printer === 'string' ? o.printer.trim().toLowerCase() : null;
  const symptom = member(SYMPTOM_KEYS, o.symptom);
  const part = member(PART_KEYS, o.part);
  const confidence = member(['high', 'low'] as const, o.confidence, false);
  const hms = stringList(o.hms_codes);
  const labels = stringList(o.label_codes);
  if (!subject || subject === NONE || !symptom || !part || !confidence || confidence === NONE || printerRaw === null || !hms || !labels) return null;
  const printer = printerRaw === 'none' ? undefined : (tokenOfAlias(printerRaw) ?? undefined);
  if (printerRaw !== 'none' && printer === undefined) return null;

  const hmsCodes: string[] = [];
  for (const c of hms) {
    const code = canonicalHmsCode(c);
    if (code && !hmsCodes.includes(code)) hmsCodes.push(code);
    if (hmsCodes.length === HMS_CODES_MAX) break;
  }
  const labelCodes: string[] = [];
  for (const c of labels) {
    const code = c.trim();
    if (LABEL_CODE_SHAPE.test(code) && !labelCodes.some((x) => x.toLowerCase() === code.toLowerCase())) labelCodes.push(code);
    if (labelCodes.length === LABEL_CODES_MAX) break;
  }

  if (subject === 'unclear') return { subject, hmsCodes: [], labelCodes: [], confidence };
  if (confidence === 'low') return { subject, hmsCodes, labelCodes: [], confidence };
  return {
    subject,
    ...(printer ? { model: printer } : {}),
    ...(symptom !== NONE ? { symptom: symptom as SymptomKey } : {}),
    ...(part !== NONE ? { part: part as PartKey } : {}),
    hmsCodes,
    labelCodes,
    confidence,
  };
}

/** The speech answer's shape, as far as the reader looks (plan §6.2). */
export interface RawTranscript {
  text?: unknown;
  transcription_info?: { language?: unknown; language_probability?: unknown; duration?: unknown };
  segments?: unknown;
}

export const TRANSCRIPT_MAX_CHARS = 500;
export const TRANSCRIPT_MIN_LANGUAGE_PROBABILITY = 0.6;
export const TRANSCRIPT_MAX_NO_SPEECH = 0.5;
export const TRANSCRIPT_MAX_SECONDS = 75;
const TRANSCRIPT_LANGUAGES = ['ar', 'en'];
/** Letters only Sorani writes: a Sorani note heard as Arabic is not passed off as Arabic. */
const SORANI_LETTERS = /[ڕڵۆێەڤڎ]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const present = (v: unknown) => v !== undefined && v !== null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A voice note's transcript, or null (plan §5.4 step 6). Accepted only when
 * the text is 1–500 characters once control characters are gone and the
 * whitespace collapsed; the language (when given) is Arabic or English with a
 * probability (when given) of at least 0.6; the segments (when given) are
 * mostly speech; the duration (when given) is at most 75 s; and no Sorani-only
 * letter is in it. The text is returned to the customer's own composer only:
 * never a reply, never stored, never logged.
 */
export function readTranscript(raw: unknown): { text: string; seconds: number | null } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as RawTranscript;
  if (typeof r.text !== 'string') return null;
  const text = r.text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 1 || text.length > TRANSCRIPT_MAX_CHARS) return null;
  if (SORANI_LETTERS.test(text)) return null;

  let seconds: number | null = null;
  const info = r.transcription_info;
  if (present(info)) {
    if (typeof info !== 'object' || Array.isArray(info)) return null;
    if (present(info.language)) {
      if (typeof info.language !== 'string' || !TRANSCRIPT_LANGUAGES.includes(info.language.trim().toLowerCase())) return null;
    }
    if (present(info.language_probability)) {
      if (!finite(info.language_probability) || info.language_probability < TRANSCRIPT_MIN_LANGUAGE_PROBABILITY) return null;
    }
    if (present(info.duration)) {
      if (!finite(info.duration) || info.duration < 0 || info.duration > TRANSCRIPT_MAX_SECONDS) return null;
      seconds = info.duration;
    }
  }
  if (present(r.segments)) {
    if (!Array.isArray(r.segments)) return null;
    const probs = r.segments
      .map((s) => (typeof s === 'object' && s !== null ? (s as { no_speech_prob?: unknown }).no_speech_prob : undefined))
      .filter(finite);
    if (probs.length && probs.reduce((a, b) => a + b, 0) / probs.length > TRANSCRIPT_MAX_NO_SPEECH) return null;
  }
  return { text, seconds };
}
