/**
 * LOCAL DETERMINISTIC TRANSLATOR — mandate §3.
 *
 * Contract, in the mandate's own words:
 *   - "الإدخال المرئي يكون بالإنجليزية فقط" — English is the only input.
 *   - "عنوان/اسم المنتج يبقى باللغة الإنجليزية في جميع الواجهات ولا تتم
 *     ترجمته" — the product NAME is never translated. `translateField` is
 *     never called for it; `TRANSLATABLE_FIELDS` below is the whole list.
 *   - "ممنوع استخدام AI أو Gemini أو OpenAI أو أي API توليدي للترجمة" — this
 *     module performs NO fetch of any kind. There is not a single network call
 *     in the file, and tests/translate.test.ts fails the build if `fetch` is
 *     invoked during a translation.
 *   - "إذا لم يستطع النظام المحلي ترجمة مقطع بأمان، احتفظ بالنص الإنجليزي
 *     لذلك المقطع وعلّمه داخليًا review_needed؛ لا تخترع ترجمة ولا تمنع حفظ
 *     المنتج" — an untranslatable segment keeps its English text, the field is
 *     flagged review_needed, and saving still succeeds.
 *
 * HOW IT DECIDES. The engine translates a segment only when it can prove the
 * whole segment is covered, never by guessing at prose:
 *
 *   R1 blank         whitespace passes through unchanged
 *   R2 identity      material codes, interfaces, formats and model numbers
 *                    ("PLA", "X1C", "USB-C", "3MF") are correct as-is in every
 *                    language, so identity IS a translation here
 *   R3 measurement   "0.4 mm", "256 x 256 x 256 mm", "220-240 V", "500 mm/s" —
 *                    numbers are kept and only the unit is localized
 *   R4 phrase        an exact whole-segment dictionary hit
 *   R5 label: value  "Nozzle diameter: 0.4 mm" — the label must be a
 *                    dictionary hit AND the value must itself satisfy R2-R5
 *   R6 enumeration   "PLA, PETG, TPU" or "Black / White" — every member must
 *                    satisfy R2-R4
 *   R7 sentence      a SPEC SENTENCE whose whole shape is a recorded frame and
 *                    whose every noun phrase resolves — see ./grammar.ts
 *   otherwise        kept in English and flagged review_needed
 *
 * R7 IS WHAT MAKES THIS MORE THAN A GLOSSARY, and it is still not a guess.
 * `grammar.ts` holds hand-written Arabic sentence skeletons with typed holes;
 * a sentence is translated only when its shape matches a skeleton AND every
 * hole resolves through the tables. One unknown noun abandons the whole
 * sentence. So "Bambu Lab A1 is an open-frame FDM 3D printer with a
 * 256 x 256 x 256 mm build volume, full-auto calibration and a quick-swap
 * nozzle system" becomes real Arabic with the modifiers behind the head noun
 * where Arabic puts them — while "This printer is perfect for hobbyists who
 * want reliable results every day" matches no skeleton and stays English.
 *
 * MARKETING PROSE IS THEREFORE STILL NEVER MACHINE-TRANSLATED, which is the
 * §3 rule this engine exists to keep. What changed is that SPEC prose — the
 * overwhelming majority of what a product description actually contains — is
 * no longer thrown away just because it came as a sentence rather than a
 * "Label: value" line.
 */

import { IDENTITY_TERMS, PHRASES, UNITS } from './dictionary';
import { translateSentence, type GrammarContext } from './grammar';

export type TargetLang = 'ar' | 'ckb';

/**
 * Bumped whenever the rules or the catalog change meaning, so stored rows can
 * be re-generated deliberately instead of silently drifting.
 *
 * 2 — the R7 sentence layer (`./grammar.ts`), the × dimension separator, the
 *     ASCII unit spellings, and the enumeration guard that stopped a thousands
 *     separator being read as a list. Every one of those changes what an
 *     existing stored translation WOULD be, and one of them (the guard)
 *     corrected output that was fabricated and stored as `machine`. A row
 *     written under version 1 is therefore not equivalent to the same source
 *     translated today, and leaving the number alone would have let the two
 *     coexist with nothing to tell them apart.
 */
export const TRANSLATION_VERSION = 2;

/** The ONLY fields that are ever machine-translated. `name` is absent on
 *  purpose (§3). */
export const TRANSLATABLE_FIELDS = ['description', 'how_to_use'] as const;

export type SegmentRule =
  | 'blank'
  | 'identity'
  | 'measurement'
  | 'phrase'
  | 'label'
  | 'enumeration'
  | 'sentence'
  | 'untranslated';

export interface Segment {
  source: string;
  out: string;
  translated: boolean;
  rule: SegmentRule;
}

export interface TranslationResult {
  text: string;
  status: 'machine' | 'review_needed';
  segments: Segment[];
  /** How much of the non-blank text was genuinely translated, 0..1. Reported
   *  for the review page; never used to fabricate confidence. */
  coverage: number;
}

const IDENTITY_SET = new Set(IDENTITY_TERMS);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Model codes and part numbers: "A1", "X1C", "P1S", "K1-Max", "0.4N". */
const MODEL_CODE_RE = /^[A-Za-z]{0,3}\d+[A-Za-z0-9-]*$|^[A-Z]{1,6}\d[A-Za-z0-9-]*$/;

/** A number, optionally signed or decimal: "0.4", "220", "0,5". */
const NUMBER_RE = /^[±~]?\d+(?:[.,]\d+)?$/;
const DIM_SEP_RE = /^[x×*]$/i;
const RANGE_SEP_RE = /^[-–—~]$/;

function lookup(term: string, lang: TargetLang): string | null {
  const e = PHRASES[norm(term)];
  if (!e) return null;
  return e[lang] ?? null;
}

function lookupUnit(term: string, lang: TargetLang): string | null {
  const e = UNITS[norm(term)];
  if (!e) return null;
  return e[lang] ?? null;
}

function isIdentity(token: string): boolean {
  const t = norm(token);
  if (IDENTITY_SET.has(t)) return true;
  // A bare model code, but not a plain number (a plain number is R3's job).
  return !NUMBER_RE.test(token) && MODEL_CODE_RE.test(token);
}

/**
 * R3 — a measurement: only numbers, separators, and units. Returns null unless
 * EVERY unit token has a rendering in the requested language, so a missing
 * Sorani unit downgrades the segment to review_needed rather than emitting a
 * half-translated string.
 */
function translateMeasurement(seg: string, lang: TargetLang): string | null {
  const tokens = seg.trim().split(/\s+/);
  if (tokens.length === 0) return null;
  let sawNumber = false;
  let sawUnit = false;
  const out: string[] = [];
  for (const raw of tokens) {
    const tok = raw.replace(/[,;]$/, '');
    const trailing = raw.length > tok.length ? raw.slice(tok.length) : '';
    if (NUMBER_RE.test(tok)) {
      sawNumber = true;
      out.push(tok + trailing);
      continue;
    }
    if (DIM_SEP_RE.test(tok)) {
      // Arabic and Kurdish spec sheets write a dimension with the multiplication
      // sign, not a Latin "x" — which in RTL text reads as a stray letter.
      out.push('\u00d7' + trailing);
      continue;
    }
    if (RANGE_SEP_RE.test(tok) || tok === '/' || tok === '±') {
      out.push(tok + trailing);
      continue;
    }
    // "0.4mm" / "220V" / "100-240V" written without a space.
    const glued = tok.match(/^([±~]?[\d.,\-–~x×*]+)\s*([A-Za-zµ°/²³]+)$/);
    if (glued) {
      const unit = lookupUnit(glued[2], lang);
      if (unit === null) return null;
      sawNumber = true;
      sawUnit = true;
      out.push(`${glued[1]} ${unit}${trailing}`);
      continue;
    }
    const unit = lookupUnit(tok, lang);
    if (unit !== null) {
      sawUnit = true;
      out.push(unit + trailing);
      continue;
    }
    return null;
  }
  if (!sawNumber || !sawUnit) return null;
  return out.join(' ');
}

/** R6 — "PLA, PETG, TPU" / "Black / White". Every member must translate.
 *
 * A THOUSANDS SEPARATOR IS NOT A LIST SEPARATOR, and treating it as one was
 * not a cosmetic bug — it FABRICATED TEXT AND MARKED IT COMPLETE.
 * "Acceleration: 10,000 mm/s2" came back as «التسارع: 10، 000 مم، s2» with
 * `status: 'machine'` and `coverage: 1`, so it shipped to the storefront with
 * no review flag at all. The chain: `mm/s2` was not a `UNITS` key (only the
 * superscript `mm/s²` was), so R3 declined, and R6 then "succeeded" by
 * splitting the NUMBER into `10` and `000 mm` and translating the debris.
 * §3's one absolute rule is that this engine never invents; this is the shape
 * that broke it, so the guard lives here and the missing unit spellings are
 * recorded in `dictionary.ts`.
 */
function translateEnumeration(seg: string, lang: TargetLang): string | null {
  if (/\d,\d/.test(seg)) return null;
  if (!/[,/،]/.test(seg)) return null;
  const sep = /[,،]/.test(seg) ? '، ' : ' / ';
  const parts = seg.split(/[,/،]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const out: string[] = [];
  for (const part of parts) {
    const t = translateAtom(part, lang);
    if (t === null) return null;
    out.push(t);
  }
  return out.join(sep);
}

/** R2/R3/R4 on a single value with no internal structure. */
function translateAtom(value: string, lang: TargetLang): string | null {
  const v = value.trim();
  if (!v) return null;
  const phrase = lookup(v, lang);
  if (phrase !== null) return phrase;
  const measured = translateMeasurement(v, lang);
  if (measured !== null) return measured;
  if (isIdentity(v)) return v;
  // A pure number with no unit is language-neutral.
  if (NUMBER_RE.test(v)) return v;
  return null;
}

/** R5 — "Label: value". */
function translateLabelled(seg: string, lang: TargetLang): string | null {
  const idx = seg.indexOf(':');
  if (idx <= 0 || idx === seg.length - 1) return null;
  const label = seg.slice(0, idx).trim();
  const value = seg.slice(idx + 1).trim();
  const labelOut = lookup(label, lang);
  if (labelOut === null) return null;
  const valueOut = translateAtom(value, lang) ?? translateEnumeration(value, lang);
  if (valueOut === null) return null;
  return `${labelOut}: ${valueOut}`;
}

/**
 * The grammar layer never re-implements R2-R4 — it borrows them, so a
 * measurement or an identity term means exactly the same thing inside a
 * sentence as it does on a spec line, for ever.
 */
function grammarContext(lang: TargetLang): GrammarContext {
  return {
    lang,
    atom: (value, l) => translateAtom(value, l),
    phrase: (term, l) => lookup(term, l),
  };
}

function translateSegment(
  seg: string,
  lang: TargetLang
): { out: string; translated: boolean; rule: SegmentRule } {
  if (!seg.trim()) return { out: seg, translated: true, rule: 'blank' };

  // Strip a trailing sentence terminator so "Layer height: 0.2 mm." still hits.
  const trailing = seg.match(/[.!?؟;؛]\s*$/)?.[0] ?? '';
  const core = trailing ? seg.slice(0, seg.length - trailing.length) : seg;
  const bullet = core.match(/^\s*[-•*]\s+/)?.[0] ?? '';
  const body = bullet ? core.slice(bullet.length) : core;

  // Order matters. "220V" satisfies BOTH the measurement shape and the
  // model-code shape, and only the measurement reading is right — so
  // measurement is tried before identity. Conversely "PC" is a unit
  // abbreviation AND a material code, which is why translateMeasurement
  // refuses a unit with no number beside it and lets identity win.
  const attempts: Array<[SegmentRule, string | null]> = [
    ['label', translateLabelled(body, lang)],
    ['phrase', lookup(body, lang)],
    ['measurement', translateMeasurement(body, lang)],
    ['identity', isIdentity(body) ? body : null],
    ['enumeration', translateEnumeration(body, lang)],
    // LAST on purpose: a whole-segment dictionary hit is a human's finished
    // text and must always beat a composed one.
    ['sentence', translateSentence(body, grammarContext(lang))],
  ];
  for (const [rule, out] of attempts) {
    if (out !== null) return { out: `${bullet}${out}${trailing}`, translated: true, rule };
  }
  return { out: seg, translated: false, rule: 'untranslated' };
}

/**
 * Splits on line breaks and sentence terminators, CAPTURING the separators so
 * that `segment(s).join('') === s` exactly. Dropping the inter-sentence space
 * would silently reflow the author's text on every save.
 */
export function segment(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split(/(\n)/)) {
    if (line === '\n') {
      out.push(line);
      continue;
    }
    if (!line) continue;
    for (const p of line.split(/((?<=[.!?؟])\s+)/)) {
      if (p !== '') out.push(p);
    }
  }
  return out;
}

export function translateText(source: string, lang: TargetLang): TranslationResult {
  const segs = segment(source);
  const segments: Segment[] = [];
  let translatable = 0;
  let translated = 0;
  for (const s of segs) {
    if (!s.trim()) {
      segments.push({ source: s, out: s, translated: true, rule: 'blank' });
      continue;
    }
    const r = translateSegment(s, lang);
    segments.push({ source: s, out: r.out, translated: r.translated, rule: r.rule });
    if (r.rule !== 'blank') {
      translatable += 1;
      if (r.translated) translated += 1;
    }
  }
  const text = segments.map((s) => s.out).join('');
  const allDone = segments.every((s) => s.translated);
  return {
    text,
    status: allDone ? 'machine' : 'review_needed',
    segments,
    coverage: translatable === 0 ? 1 : translated / translatable,
  };
}

/**
 * WHY A SEGMENT WAS NOT TRANSLATED — because "review needed" on its own sent
 * the owner looking for a bug that is not there.
 *
 * The banner used to say the fields «بقيت بالإنجليزية» (stayed in English).
 * For a form filled in ARABIC that sentence is simply false, and it hid the
 * one fact that mattered: this engine runs English → ar/ckb, so text typed
 * into the English box in Arabic has nothing to translate FROM. Saying which
 * of the two situations happened is the difference between "the translator is
 * broken" and "this field is in the wrong box".
 *
 *   not_english  the source is written in Arabic script — the form's English
 *                field is holding Arabic, so no engine in this direction can
 *                produce English or Kurdish from it;
 *   prose        ordinary English sentences. §3 forbids inventing a
 *                translation and a rule engine cannot write correct Arabic or
 *                Sorani prose, so this ALWAYS needs a human. Expected, not a
 *                failure;
 *   terms        spec-shaped English whose vocabulary the dictionary does not
 *                carry yet. This one is fixable by adding the term.
 */
export type ReviewReason = 'not_english' | 'prose' | 'terms';

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_RE = /[A-Za-z]/;

/**
 * True when the text is written in Arabic/Kurdish script rather than Latin.
 *
 * Not "contains an Arabic letter" and not "mostly Arabic letters". Both fail on
 * the sentences this actually sees. An Arabic line about a printer carries the
 * model name in Latin — «طابعة Bambu Lab A1» is 6 Arabic letters against 9
 * Latin ones and is unmistakably Arabic — while an English line can quote one
 * Arabic place name and is still English.
 *
 * A SHARE, therefore, and a low one: past a third of the letters, the Arabic is
 * the sentence rather than a quotation inside it. The cost of each mistake is
 * only the wording of an advisory line, never a refused save.
 */
const ARABIC_SHARE_FLOOR = 0.3;

export function isArabicScript(source: string): boolean {
  if (!ARABIC_RE.test(source)) return false;
  let arabic = 0;
  let latin = 0;
  for (const ch of source) {
    if (ARABIC_RE.test(ch)) arabic += 1;
    else if (LATIN_RE.test(ch)) latin += 1;
  }
  const letters = arabic + latin;
  return letters > 0 && arabic / letters >= ARABIC_SHARE_FLOOR;
}

/**
 * Classifies ONE field's English source. Only ever called for a field the
 * engine could not fully translate, so it explains a known failure rather than
 * predicting one.
 */
export function reviewReason(sourceEn: string): ReviewReason {
  if (isArabicScript(sourceEn)) return 'not_english';
  // Prose, not a spec line: a segment with several words and no colon, unit or
  // separator is a sentence, and a sentence is a human's job by §3.
  const words = sourceEn.trim().split(/\s+/).filter(Boolean);
  if (words.length > 8 && !/[:：]/.test(sourceEn)) return 'prose';
  return 'terms';
}

export interface FieldTranslation {
  field: string;
  source_en: string;
  source_hash: string;
  text_ar: string;
  text_ckb: string;
  status: 'machine' | 'review_needed';
  translation_version: number;
}

/**
 * Translates one field into both target languages. The stored status is the
 * WEAKER of the two: if Sorani could not be produced safely, the row is
 * review_needed even though Arabic succeeded, so the review page shows it.
 */
export function translateField(field: string, sourceEn: string): FieldTranslation {
  const ar = translateText(sourceEn, 'ar');
  const ckb = translateText(sourceEn, 'ckb');
  return {
    field,
    source_en: sourceEn,
    source_hash: hashSource(sourceEn),
    text_ar: ar.text,
    text_ckb: ckb.text,
    status: ar.status === 'machine' && ckb.status === 'machine' ? 'machine' : 'review_needed',
    translation_version: TRANSLATION_VERSION,
  };
}

/**
 * FNV-1a 64-bit over the source plus the engine version. Synchronous on
 * purpose — a save path must not await a digest to decide whether anything
 * changed — and used ONLY for change detection, never for security.
 */
export function hashSource(s: string): string {
  const input = `v${TRANSLATION_VERSION} ${s}`;
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}
