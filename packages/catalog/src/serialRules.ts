/**
 * SERIAL FORMAT RULES — BRAND- AND PRODUCT-AWARE (owner decision 2,
 * 2026-10-09; migration 0180 `serial_brand_rules`; docs/DECISIONS.md row 195).
 *
 * The owner: the shop sells Bambu Lab and Snapmaker (the focus — a Snapmaker
 * product is already live), and also Creality, Anycubic and ELEGOO. The Bambu
 * serial shape alone must never refuse a serial; there is no general rule
 * "looks like a Bambu serial → refuse". Each brand has its own rules, and a
 * validator for another brand is added later WITHOUT a rebuild — so a rule is
 * DATA the owner edits, in the restricted format below, never code.
 *
 * WHICH RULE JUDGES A SERIAL (worker/lib/serialRules.ts resolves it):
 *   1. the product's own rule (scope 'product', active);
 *   2. the rule of the product's brand (`products.brand_id`, scope 'brand');
 *   3. GENERIC_RULE below — letters and digits, 6–40, never a refusal for
 *      looking like a Bambu box number (a warning, LOOKS_LIKE_BAMBU_BOX).
 * With no product known (Bulk Add without a product, an unidentified label)
 * the generic rule applies. Before migration 0180 has applied, LEGACY_RULE is
 * every product's rule: today's behaviour exactly (the Bambu box refusal and
 * the five-prefix family check for every brand, no warnings).
 *
 * WHAT A RULE CANNOT TOUCH. Normalisation stays global (`normalizeSerial` in
 * ./deviceSerials.ts — it is the primary key that joins the inventory and the
 * warranty tables), and the hard checks stay for every brand: empty, 6–40
 * letters and digits, a product barcode, a receipt number, another device's
 * box number. A rule only VALIDATES the normalised value.
 *
 * NO REGEX FROM DATA. A character set is a NAME (ALNUM, DIGITS, HEX), a box
 * shape is a NAME ('bambu' — the one classifier in code), prefixes are
 * matched with `startsWith`, positions with fixed character classes. The
 * parser refuses every string that looks like a pattern, unknown keys, and a
 * rule over 4,000 bytes. Every list is bounded, every input is at most 40
 * characters, so a check costs time proportional to the input.
 *
 * Pure: no I/O, no bindings — shared by the Worker (authoritative) and the
 * SPA (the owner's test box runs the very same `evaluateSerial`).
 */

// ------------------------------------------------------------- vocabulary

export const SERIAL_RULE_MODES = ['off', 'warn', 'enforce'] as const;
export type SerialRuleMode = (typeof SERIAL_RULE_MODES)[number];

export const SERIAL_CHARSETS = ['ALNUM', 'DIGITS', 'HEX'] as const;
export type SerialCharset = (typeof SERIAL_CHARSETS)[number];

export const PREFIX_POLICIES = ['hint', 'known_only'] as const;
export type PrefixPolicy = (typeof PREFIX_POLICIES)[number];

export const BOX_SHAPES = ['none', 'bambu'] as const;
export type BoxShape = (typeof BOX_SHAPES)[number];

export const POSITION_CLASSES = ['DIGIT', 'LETTER', 'ALNUM'] as const;

/** Where a rule applies. 'catalog' is reserved in the table and unused in v1. */
export type SerialRuleScope = 'product' | 'brand' | 'generic' | 'legacy';

/** The global bounds of an inventory serial (./deviceSerials.ts SERIAL_MIN / SERIAL_MAX). */
export const RULE_LEN_MIN = 6;
export const RULE_LEN_MAX = 40;

export const RULE_LIMITS = {
  label: 60,
  sourceNote: 300,
  lengths: 6,
  prefixes: 64,
  prefixLen: 6,
  model: 40,
  aliases: 4,
  positions: 8,
  positionLen: 8,
  bytes: 4000,
} as const;

/** One known prefix: `p` the characters a serial starts with, `m` the model it names, `a` other names of that model. */
export interface SerialPrefix {
  p: string;
  m: string;
  a?: string[];
}

/** A fixed character class (or literal) at a 1-based position. */
export interface SerialPosition {
  at: number;
  len: number;
  /** 'DIGIT' | 'LETTER' | 'ALNUM', or literal letters and digits of exactly `len` characters. */
  cls: string;
}

/** What the owner edits — the row's format columns, and the body of the routes. */
export interface SerialRuleSpec {
  label: string;
  mode: SerialRuleMode;
  charset: SerialCharset;
  min_len: number;
  max_len: number;
  /** Exact lengths; empty = any length in min_len..max_len. */
  lengths: number[];
  prefixes: SerialPrefix[];
  prefix_policy: PrefixPolicy;
  positions: SerialPosition[];
  box_sn_shape: BoxShape;
  family_check: boolean;
  source_note: string;
}

/** A rule as it judges: the spec plus where it came from. */
export interface SerialRule extends SerialRuleSpec {
  /** The row id, or 'generic' / 'legacy' for the two rules defined in code. */
  id: string;
  version: number;
  scope: SerialRuleScope;
  brand_id: string | null;
  product_id: string | null;
}

// ------------------------------------------------------------- the code rules

/**
 * THE BAMBU LAB BOX-NUMBER SHAPE — a `B`, at least four digits, a letter, then
 * letters and digits (`B07119G5811000AB` on the owner's A1 Combo label). The
 * one box classifier a rule can name (`box_sn_shape = 'bambu'`). A literal,
 * never built from data. ./deviceSerials.ts re-exports it as BOX_SN_RE.
 */
export const BAMBU_BOX_SN_RE = /^B\d{4,}[A-Z][0-9A-Z]{3,}$/;

/**
 * Every product with no rule of its own or of its brand, and every serial
 * whose product is not known yet. Letters and digits, 6–40; a value shaped
 * like a Bambu box number is ACCEPTED with a warning (owner decision 2: the
 * Bambu shape never refuses a serial on its own).
 */
export const GENERIC_RULE: SerialRule = Object.freeze({
  id: 'generic',
  version: 1,
  scope: 'generic',
  brand_id: null,
  product_id: null,
  label: '',
  mode: 'warn',
  charset: 'ALNUM',
  min_len: RULE_LEN_MIN,
  max_len: RULE_LEN_MAX,
  lengths: [],
  prefixes: [],
  prefix_policy: 'hint',
  positions: [],
  box_sn_shape: 'none',
  family_check: false,
  source_note: '',
}) as SerialRule;

/**
 * TODAY'S RULE, for every product, until migration 0180 has applied — the
 * behaviour before owner decision 2, kept exactly: the Bambu box number is
 * refused on every door, and the five prefixes the code always knew name a
 * family on a 15-character serial for the model check. No warnings.
 */
export const LEGACY_RULE: SerialRule = Object.freeze({
  id: 'legacy',
  version: 1,
  scope: 'legacy',
  brand_id: null,
  product_id: null,
  label: 'Bambu Lab',
  mode: 'warn',
  charset: 'ALNUM',
  min_len: RULE_LEN_MIN,
  max_len: RULE_LEN_MAX,
  lengths: [15],
  prefixes: [
    { p: '039', m: 'A1' },
    { p: '030', m: 'A1 mini' },
    { p: '01P', m: 'P1S' },
    { p: '01S', m: 'P1P' },
    { p: '00M', m: 'X1 Carbon' },
  ],
  prefix_policy: 'hint',
  positions: [],
  box_sn_shape: 'bambu',
  family_check: true,
  source_note: '',
}) as SerialRule;

/** The box classifier this rule applies: none for an `off` rule (its checks are switched off). */
export function effectiveBoxShape(rule: Pick<SerialRule, 'mode' | 'box_sn_shape'>): BoxShape {
  return rule.mode !== 'off' && rule.box_sn_shape === 'bambu' ? 'bambu' : 'none';
}

/** Whether the model-family check runs under this rule. */
export function familyCheckOn(rule: Pick<SerialRule, 'mode' | 'family_check'>): boolean {
  return rule.mode !== 'off' && !!rule.family_check;
}

// ------------------------------------------------------------- the verdict

export type FormatProblemCode = 'LENGTH_UNEXPECTED' | 'CHARS_UNEXPECTED' | 'PREFIX_UNKNOWN' | 'POSITION_UNEXPECTED';
export type FormatNoteCode = FormatProblemCode | 'LOOKS_LIKE_BAMBU_BOX' | 'LOOKS_LIKE_BOX';

/** One finding: a warning, or (under `enforce`) a reason the serial is refused. */
export interface FormatNote {
  code: FormatNoteCode;
  /** LENGTH_UNEXPECTED: the serial's length and what the rule expects («15 / 18», «6–40»). */
  len?: number;
  expected?: string;
  /** POSITION_UNEXPECTED: the 1-based position that failed. */
  at?: number;
}

export interface SerialVerdict {
  /** Non-empty = refused: SERIAL_FORMAT_MISMATCH (or, LOOKS_LIKE_BOX, the box-number refusal). */
  refuse: FormatNote[];
  /** Accepted, said on the screen in amber and written into the audit. */
  warnings: FormatNote[];
  /** The known prefix the serial starts with, when the rule names its model. */
  family: SerialPrefix | null;
}

const ALNUM_RE = /^[A-Z0-9]+$/;
const DIGITS_RE = /^[0-9]+$/;
const HEX_RE = /^[0-9A-F]+$/;
const LETTERS_RE = /^[A-Z]+$/;

function charsetOk(value: string, charset: SerialCharset): boolean {
  if (charset === 'DIGITS') return DIGITS_RE.test(value);
  if (charset === 'HEX') return HEX_RE.test(value);
  return ALNUM_RE.test(value);
}

/** What lengths the rule expects, as the screens print it. */
export function expectedLengths(rule: Pick<SerialRule, 'lengths' | 'min_len' | 'max_len'>): string {
  return rule.lengths.length ? rule.lengths.join(' / ') : `${rule.min_len}–${rule.max_len}`;
}

function lengthOk(len: number, rule: Pick<SerialRule, 'lengths' | 'min_len' | 'max_len'>): boolean {
  return rule.lengths.length ? rule.lengths.includes(len) : len >= rule.min_len && len <= rule.max_len;
}

function positionOk(value: string, pos: SerialPosition): boolean {
  const part = value.slice(pos.at - 1, pos.at - 1 + pos.len);
  if (part.length !== pos.len) return false;
  if (pos.cls === 'DIGIT') return DIGITS_RE.test(part);
  if (pos.cls === 'LETTER') return LETTERS_RE.test(part);
  if (pos.cls === 'ALNUM') return ALNUM_RE.test(part);
  return part === pos.cls;
}

/** The longest known prefix the serial starts with, or null. */
export function matchPrefix(norm: string, rule: Pick<SerialRule, 'prefixes'>): SerialPrefix | null {
  let best: SerialPrefix | null = null;
  for (const p of rule.prefixes) {
    if (p.p && norm.startsWith(p.p) && (!best || p.p.length > best.p.length)) best = p;
  }
  return best;
}

/**
 * The model family a serial names under this rule: a known prefix, on a
 * serial of a length the rule expects (a prefix on a malformed serial is not
 * evidence). Null when the rule names none.
 */
export function ruleFamily(norm: string, rule: Pick<SerialRule, 'prefixes' | 'lengths' | 'min_len' | 'max_len'>): SerialPrefix | null {
  if (!rule.prefixes.length || !lengthOk(norm.length, rule)) return null;
  return matchPrefix(norm, rule);
}

/**
 * ONE SERIAL UNDER ONE RULE. `norm` is the normalised serial that already
 * passed the hard checks (`serialProblem` in ./deviceSerials.ts). Mode `off`
 * checks nothing beyond the hard checks (and only says a box-number shape);
 * `warn` accepts with warnings; `enforce` refuses what it finds.
 */
export function evaluateSerial(norm: string, rule: SerialRule): SerialVerdict {
  const value = String(norm ?? '');
  const out: SerialVerdict = { refuse: [], warnings: [], family: null };
  if (BAMBU_BOX_SN_RE.test(value)) {
    if (effectiveBoxShape(rule) === 'bambu') {
      out.refuse.push({ code: 'LOOKS_LIKE_BOX' });
      return out;
    }
    // The legacy rule never reaches here (its box shape is 'bambu').
    out.warnings.push({ code: 'LOOKS_LIKE_BAMBU_BOX' });
  }
  if (familyCheckOn(rule)) out.family = ruleFamily(value, rule);
  if (rule.scope === 'legacy' || rule.mode === 'off') return out;

  const problems: FormatNote[] = [];
  if (!lengthOk(value.length, rule)) problems.push({ code: 'LENGTH_UNEXPECTED', len: value.length, expected: expectedLengths(rule) });
  if (!charsetOk(value, rule.charset)) problems.push({ code: 'CHARS_UNEXPECTED' });
  const firstBadPosition = rule.positions.find((p) => !positionOk(value, p));
  if (firstBadPosition) problems.push({ code: 'POSITION_UNEXPECTED', at: firstBadPosition.at });
  let prefixHint: FormatNote | null = null;
  if (rule.prefixes.length && !matchPrefix(value, rule)) {
    if (rule.prefix_policy === 'known_only') problems.push({ code: 'PREFIX_UNKNOWN' });
    else prefixHint = { code: 'PREFIX_UNKNOWN' };
  }
  if (rule.mode === 'enforce') out.refuse.push(...problems);
  else out.warnings.push(...problems);
  if (prefixHint) out.warnings.push(prefixHint);
  return out;
}

/** The codes of a verdict's warnings, in order — what the audit and the counts carry. */
export const noteCodes = (notes: readonly FormatNote[]): FormatNoteCode[] => notes.map((n) => n.code);

// ------------------------------------------------------------- the parser

export interface RuleInvalid {
  ok: false;
  /** The field the owner has to fix: `label`, `prefixes[3].p`, `*` for the whole rule. */
  field: string;
  reason:
    | 'UNKNOWN_KEY'
    | 'TOO_LARGE'
    | 'NOT_AN_OBJECT'
    | 'NOT_A_STRING'
    | 'EMPTY'
    | 'TOO_LONG'
    | 'PATTERN_NOT_ALLOWED'
    | 'NOT_AN_INTEGER'
    | 'OUT_OF_RANGE'
    | 'NOT_A_LIST'
    | 'TOO_MANY'
    | 'DUPLICATE'
    | 'BAD_VALUE'
    | 'MIN_OVER_MAX';
}
export type RuleParse = { ok: true; spec: SerialRuleSpec } | RuleInvalid;

export const RULE_SPEC_KEYS: ReadonlyArray<keyof SerialRuleSpec> = [
  'label', 'mode', 'charset', 'min_len', 'max_len', 'lengths', 'prefixes', 'prefix_policy', 'positions', 'box_sn_shape', 'family_check', 'source_note',
];

/**
 * A string that reads as a pattern. No rule field is ever a pattern (the
 * character set and the box shape are names, prefixes are plain starts), so
 * a value carrying pattern syntax is a mistake or an attempt — refused.
 */
const PATTERN_CHARS = /[\^$\\[\](){}*+?|]/;
export const looksLikePattern = (s: string): boolean => PATTERN_CHARS.test(s);

class Invalid extends Error {
  constructor(public readonly field: string, public readonly reason: RuleInvalid['reason']) {
    super(`${field}: ${reason}`);
  }
}

function text(v: unknown, field: string, max: number, opts: { required?: boolean } = {}): string {
  if (v === undefined || v === null) {
    if (opts.required) throw new Invalid(field, 'EMPTY');
    return '';
  }
  if (typeof v !== 'string') throw new Invalid(field, 'NOT_A_STRING');
  const s = v.trim().replace(/\s+/g, ' ');
  if (opts.required && !s) throw new Invalid(field, 'EMPTY');
  if (s.length > max) throw new Invalid(field, 'TOO_LONG');
  if (looksLikePattern(s)) throw new Invalid(field, 'PATTERN_NOT_ALLOWED');
  return s;
}

function integer(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new Invalid(field, 'NOT_AN_INTEGER');
  if (n < min || n > max) throw new Invalid(field, 'OUT_OF_RANGE');
  return n;
}

function oneOfNames<T extends string>(v: unknown, field: string, allowed: readonly T[], def: T): T {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new Invalid(field, 'BAD_VALUE');
  return v as T;
}

function list(v: unknown, field: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Invalid(field, 'NOT_A_LIST');
  if (v.length > max) throw new Invalid(field, 'TOO_MANY');
  return v;
}

function strictObject(v: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Invalid(field, 'NOT_AN_OBJECT');
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new Invalid(`${field ? `${field}.` : ''}${k}`, 'UNKNOWN_KEY');
  return v as Record<string, unknown>;
}

/** A prefix as stored: trimmed, upper case, letters and digits only, 1–6 characters. */
function prefixCode(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Invalid(field, 'NOT_A_STRING');
  const s = v.trim().toUpperCase();
  if (!s) throw new Invalid(field, 'EMPTY');
  if (s.length > RULE_LIMITS.prefixLen) throw new Invalid(field, 'TOO_LONG');
  if (looksLikePattern(s)) throw new Invalid(field, 'PATTERN_NOT_ALLOWED');
  if (!ALNUM_RE.test(s)) throw new Invalid(field, 'BAD_VALUE');
  return s;
}

/**
 * The owner's rule, checked field by field. Strict: an unknown key, a value
 * out of its bounds or a pattern-looking string is refused with the field to
 * fix (400 SERIAL_RULE_INVALID {field, reason}). A key left out takes the
 * table's default.
 */
export function parseSerialRule(input: unknown): RuleParse {
  try {
    let size = 0;
    try {
      size = new TextEncoder().encode(JSON.stringify(input ?? null)).length;
    } catch {
      throw new Invalid('*', 'BAD_VALUE');
    }
    if (size > RULE_LIMITS.bytes) throw new Invalid('*', 'TOO_LARGE');
    const o = strictObject(input, '', RULE_SPEC_KEYS as readonly string[]);
    const min = o.min_len === undefined ? RULE_LEN_MIN : integer(o.min_len, 'min_len', RULE_LEN_MIN, RULE_LEN_MAX);
    const max = o.max_len === undefined ? RULE_LEN_MAX : integer(o.max_len, 'max_len', RULE_LEN_MIN, RULE_LEN_MAX);
    if (min > max) throw new Invalid('min_len', 'MIN_OVER_MAX');
    const lengths = list(o.lengths, 'lengths', RULE_LIMITS.lengths).map((v, i) => integer(v, `lengths[${i}]`, RULE_LEN_MIN, RULE_LEN_MAX));
    if (new Set(lengths).size !== lengths.length) throw new Invalid('lengths', 'DUPLICATE');
    const seen = new Set<string>();
    const prefixes = list(o.prefixes, 'prefixes', RULE_LIMITS.prefixes).map((raw, i) => {
      const f = `prefixes[${i}]`;
      const e = strictObject(raw, f, ['p', 'm', 'a']);
      const p = prefixCode(e.p, `${f}.p`);
      if (seen.has(p)) throw new Invalid(`${f}.p`, 'DUPLICATE');
      seen.add(p);
      const m = text(e.m, `${f}.m`, RULE_LIMITS.model, { required: true });
      const a = list(e.a, `${f}.a`, RULE_LIMITS.aliases).map((x, j) => text(x, `${f}.a[${j}]`, RULE_LIMITS.model, { required: true }));
      return a.length ? { p, m, a } : { p, m };
    });
    const positions = list(o.positions, 'positions', RULE_LIMITS.positions).map((raw, i) => {
      const f = `positions[${i}]`;
      const e = strictObject(raw, f, ['at', 'len', 'cls']);
      const at = integer(e.at, `${f}.at`, 1, RULE_LEN_MAX);
      const len = integer(e.len, `${f}.len`, 1, RULE_LIMITS.positionLen);
      if (at + len - 1 > RULE_LEN_MAX) throw new Invalid(`${f}.len`, 'OUT_OF_RANGE');
      if (typeof e.cls !== 'string') throw new Invalid(`${f}.cls`, 'NOT_A_STRING');
      const raw2 = e.cls.trim();
      if (looksLikePattern(raw2)) throw new Invalid(`${f}.cls`, 'PATTERN_NOT_ALLOWED');
      const cls = raw2.toUpperCase();
      const named = (POSITION_CLASSES as readonly string[]).includes(cls);
      if (!named && (!ALNUM_RE.test(cls) || cls.length !== len)) throw new Invalid(`${f}.cls`, 'BAD_VALUE');
      return { at, len, cls };
    });
    let family = false;
    if (o.family_check === true || o.family_check === 1) family = true;
    else if (o.family_check === undefined || o.family_check === null || o.family_check === false || o.family_check === 0) family = false;
    else throw new Invalid('family_check', 'BAD_VALUE');
    const spec: SerialRuleSpec = {
      label: text(o.label, 'label', RULE_LIMITS.label),
      mode: oneOfNames(o.mode, 'mode', SERIAL_RULE_MODES, 'warn'),
      charset: oneOfNames(o.charset, 'charset', SERIAL_CHARSETS, 'ALNUM'),
      min_len: min,
      max_len: max,
      lengths,
      prefixes,
      prefix_policy: oneOfNames(o.prefix_policy, 'prefix_policy', PREFIX_POLICIES, 'hint'),
      positions,
      box_sn_shape: oneOfNames(o.box_sn_shape, 'box_sn_shape', BOX_SHAPES, 'none'),
      family_check: family,
      source_note: text(o.source_note, 'source_note', RULE_LIMITS.sourceNote),
    };
    return { ok: true, spec };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, field: e.field, reason: e.reason };
    return { ok: false, field: '*', reason: 'BAD_VALUE' };
  }
}

/** A spec as a rule the evaluator takes (the owner's test box, the dry run). */
export function specAsRule(spec: SerialRuleSpec, id = 'draft', version = 0): SerialRule {
  return { ...spec, id, version, scope: 'brand', brand_id: null, product_id: null };
}
