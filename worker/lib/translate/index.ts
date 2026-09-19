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
 *
 * 3 — WORD ORDER. Version 2 could print a value before its label and still
 *     report `status: 'machine'`, `coverage: 1`: "gross weight 13 kg" came out
 *     «13 كغم الوزن الإجمالي» and "Product dimensions 389 x 389 x 458 mm" came
 *     out «× 389 × 458 مم 389 أبعاد المنتج», with the dimension itself torn
 *     apart. The cause and the repair are written up in
 *     `tests/translateWordOrder.test.ts` and at rule 3 of `./grammar.ts`.
 *
 *     This bump matters more than version 2's did, because the corrupted rows
 *     are INDISTINGUISHABLE from good ones by their status — they were stored
 *     as finished machine translations. The version is the only thing that
 *     tells a version-2 row apart from what the same English produces today,
 *     and `hashSource` folds it in, so an admin re-save now genuinely
 *     re-generates instead of seeing an unchanged hash and skipping.
 *
 *     Three things in this version also REFUSE what version 2 accepted — a
 *     colour glued to a noun without gender agreement, two units with no
 *     number between them, a list written with two different separators. Those
 *     rows become `review_needed` on their next save. That is the intended
 *     direction: §3 says an absent translation is a flag a human clears, while
 *     a wrong one is shipped to a customer with nobody knowing to look.
 */
export const TRANSLATION_VERSION = 3;

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

/**
 * A number OR a numeric range written as one token: "220-240", "15-30", "3-4".
 *
 * R3's doc comment above has claimed "220-240 V" since it was written, and the
 * 0079 note in `dictionary.ts` records `week`/`weeks` specifically so that a
 * lead time of "3-4 weeks" would translate. NEITHER EVER DID. A range token
 * matched no pattern here, R3 declined, and both lines came back English and
 * flagged — a silent hole in exactly the two places the comments promised
 * coverage. This closes it, and nothing is invented: the digits are kept and
 * only the unit is localized, same as any other measurement.
 *
 * Kept SEPARATE from NUMBER_RE on purpose. NUMBER_RE is also what `isIdentity`
 * and `translateAtom` read to decide what a bare, unit-less token is, and a
 * bare "3-4" standing alone is not a value this engine should wave through as
 * language-neutral — inside a measurement it is a range, outside one it could
 * be anything.
 */
const NUMBER_OR_RANGE_RE = /^[±~]?\d+(?:[.,]\d+)?(?:[-–—~]\d+(?:[.,]\d+)?)*$/;

/**
 * THE UNITS THAT ARE REALLY COUNTING NOUNS, AND SO INFLECT WITH THE NUMBER.
 *
 * Arabic number-noun agreement depends on the numeral: «3 أسابيع», not «3
 * أسبوع». The `UNITS` table stores ONE form per key, so the engine has no
 * plural to reach for. With a single figure that is an old, pre-existing
 * infelicity and out of scope — «12 شهر» has always been written that way
 * here. With a RANGE it is different, and it is different because of this
 * round: before ranges parsed at all, "3-4 weeks" was kept in English and
 * FLAGGED, which is what §3 asks for. Letting the range through turned a
 * correctly-flagged line into a wrong one marked `machine` — a regression
 * created by this engine, not inherited by it.
 *
 * A range also makes the noun plural in a way no singular entry can render.
 * So a range is refused in front of these, and accepted in front of an
 * ordinary metric unit («220-240 فولت», «0.2-0.3 مم»), which does not inflect
 * in an Arabic spec sheet. When the plural forms are recorded in `UNITS`, this
 * set is what should shrink.
 */
const COUNTING_UNITS = new Set([
  'pcs', 'pc', 'pack', 'roll', 'rolls', 'spool', 'spools', 'set', 'sets',
  'hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'business day', 'business days', 'working day', 'working days',
]);

/** True for a token that is a RANGE rather than a single figure: "3-4". */
const IS_RANGE_RE = /\d[-–—~]\d/;

const DIM_SEP_RE = /^[x×*]$/i;
const RANGE_SEP_RE = /^[-–—~]$/;

/**
 * NUMBERS ARE NEVER CONVERTED TO ARABIC-INDIC, anywhere in this engine.
 *
 * Stated once, here, because an inconsistent mix inside one sentence is its
 * own defect and there was nothing written down to stop one appearing. The
 * reasons, in order of weight:
 *
 *   - the value must stay comparable with the English row it was produced
 *     from. «٠٫٤ مم» and "0.4 mm" are the same nozzle, but no code path in
 *     this project — search, filtering, spec comparison, the admin's diff of
 *     the English source against the stored Arabic — knows that;
 *   - the product NAME and every model code stay Latin by §3, so a spec sheet
 *     already contains Latin characters. Latin digits beside them read
 *     normally; ٠١٢ beside "X1C" does not;
 *   - Iraqi storefronts and vendor spec sheets are written with Western
 *     digits. This is what the owner's own hand-written Arabic uses.
 *
 * THE ONE CONSEQUENCE, spelled out so it is not mistaken for a bug: a comma
 * BETWEEN DIGITS is a thousands separator belonging to a Latin number, so it
 * stays a Latin comma — «10,000 مم/ث²». A comma between WORDS is Arabic
 * punctuation and becomes «،». Same for the semicolon. That is what
 * `arabicPunctuation` below does, and it only ever sees the between-words kind
 * because a thousands separator is never at the end of a token.
 */
const ARABIC_PUNCTUATION: Record<string, string> = { ',': '،', ';': '؛', '?': '؟' };

/** Arabic and Sorani share the script, so both take Arabic punctuation. */
const arabicPunctuation = (s: string): string =>
  s.replace(/[,;?]/g, (ch) => ARABIC_PUNCTUATION[ch] ?? ch);

/**
 * The multiplication sign inside a GLUED dimension, "256x256x256mm".
 *
 * The spaced form already became «256 × 256 × 256 مم» — the glued one kept the
 * Latin x, which in RTL text renders as a stray Latin letter in the middle of
 * Arabic. Two spellings of the same source producing two different Arabic
 * strings is the inconsistency; this makes them one.
 */
const dimensionSigns = (n: string): string => n.replace(/\s*[x×*]\s*/gi, ' × ');

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
 *
 * THE ONE THING THIS RULE IS ALLOWED TO ASSUME is that "<figure> <unit>" means
 * the same thing in the same order in Arabic as in English — «0.4 مم» is not a
 * reordering of "0.4 mm", it is the same phrase. That holds for a figure and
 * its unit and for nothing else, which is why the guard below exists: TWO
 * UNITS WITH NO NUMBER BETWEEN THEM are not a measurement, they are a measured
 * NOUN, and Arabic puts the noun first.
 *
 * "1 kg spool" is the shape. `spool` is a UNITS entry — a spool is a countable
 * quantity on a materials line — so this rule read the segment as "1, kg,
 * spool", joined the three in English order and returned «1 كغم بكرة» with
 * `status: 'machine'`. That is word salad; Arabic says «بكرة 1 كغم». Nothing
 * in the token stream says which of the two units is the head noun, so this
 * rule cannot know, and §3 says it must not guess. It refuses, the segment
 * keeps its English, and the review page tells a human.
 */
function translateMeasurement(seg: string, lang: TargetLang): string | null {
  const tokens = seg.trim().split(/\s+/);
  if (tokens.length === 0) return null;
  let sawNumber = false;
  let sawUnit = false;
  /** See the note above: a unit may not directly follow another unit. */
  let prevWasUnit = false;
  /** Was the figure immediately before this token a RANGE? See COUNTING_UNITS. */
  let prevWasRange = false;
  const out: string[] = [];
  for (const raw of tokens) {
    const tok = raw.replace(/[,;]$/, '');
    // A comma or semicolon ENDING a token separates words, never digits — a
    // thousands separator is never last. So it is punctuation, and in Arabic
    // and Sorani output it is Arabic punctuation. See the NUMBERS note above.
    const trailing = raw.length > tok.length ? arabicPunctuation(raw.slice(tok.length)) : '';
    if (NUMBER_OR_RANGE_RE.test(tok)) {
      sawNumber = true;
      prevWasUnit = false;
      prevWasRange = IS_RANGE_RE.test(tok);
      out.push(tok + trailing);
      continue;
    }
    if (DIM_SEP_RE.test(tok)) {
      // Arabic and Kurdish spec sheets write a dimension with the multiplication
      // sign, not a Latin "x" — which in RTL text reads as a stray letter.
      out.push('×' + trailing);
      prevWasUnit = false;
      continue;
    }
    if (RANGE_SEP_RE.test(tok) || tok === '/' || tok === '±') {
      out.push(tok + trailing);
      prevWasUnit = false;
      continue;
    }
    // "0.4mm" / "220V" / "100-240V" / "256x256x256mm" written without a space.
    const glued = tok.match(/^([±~]?[\d.,\-–~x×*]+)\s*([A-Za-zµ°/²³]+)$/);
    if (glued) {
      // The numeric half is a character CLASS, so "xmm" satisfies it with no
      // digit in it at all and used to set sawNumber on nothing.
      if (!/\d/.test(glued[1])) return null;
      const unit = lookupUnit(glued[2], lang);
      if (unit === null) return null;
      if (prevWasUnit) return null;
      sawNumber = true;
      sawUnit = true;
      prevWasUnit = true;
      out.push(`${dimensionSigns(glued[1])} ${unit}${trailing}`);
      continue;
    }
    const unit = lookupUnit(tok, lang);
    if (unit !== null) {
      if (prevWasUnit) return null;
      /**
       * A UNIT BEFORE ANY NUMBER IS THE HEAD NOUN, NOT A UNIT.
       *
       * The same reasoning as the two-adjacent-units guard above, from the
       * other side. "spool 1 kg" is «بكرة 1 كغم» — a noun and then its weight —
       * but read as a measurement it is "spool, 1, kg" and joins in English
       * order, so "PLA spool 1 kg" came out «PLA بكرة 1 كغم» with the code
       * stranded in front. Refusing here hands the segment to the grammar
       * layer, which knows `spool` as a head noun and composes it correctly.
       */
      if (!sawNumber) return null;
      // A RANGE cannot be put in front of a counting noun this table has only
      // one form of — see COUNTING_UNITS. Refuse, keep the English, flag it.
      if (prevWasRange && COUNTING_UNITS.has(norm(tok))) return null;
      sawUnit = true;
      prevWasUnit = true;
      prevWasRange = false;
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
  const hasComma = /[,،]/.test(seg);
  const hasSlash = seg.includes('/');
  if (!hasComma && !hasSlash) return null;
  /**
   * ONE SEPARATOR PER LIST. The split used to be on `[,/،]` — both kinds at
   * once — and that did two wrong things, both marked `machine`:
   *
   *   "Black, White / Red"  →  «أسود، أبيض، أحمر»
   *       Three equal items where the source had two, and the "or" the slash
   *       carried inside the second member silently deleted. Nothing here can
   *       tell whether a slash means "or" or is part of a member, so mixing
   *       the two separators is refused outright and a human decides.
   *
   *   "500 mm/s, 10000 mm/s2"  →  refused
   *       The slash inside the UNIT was read as a list separator, tearing
   *       "500 mm/s" into "500 mm" and "s". One broken member abandoned the
   *       whole line, so a perfectly ordinary speed list came back English.
   *
   * Choosing the comma when both are present is not a preference: a comma
   * between top-level members is unambiguous, a slash is not.
   */
  const sep = hasComma ? '، ' : ' / ';
  const parts = seg.split(hasComma ? /[,،]/ : /\//).map((p) => p.trim()).filter(Boolean);
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
 *
 * `atom` AND `measure` ARE NOT THE SAME QUESTION, and conflating them is the
 * whole word-order defect. `atom` answers "can this stand alone as a value?"
 * and says yes to a dictionary phrase, because "Black" IS a complete value on
 * a colour line. `measure` answers "is this a FIGURE that Arabic moves behind
 * its head noun?" and must say no to "gross weight" and no to a bare "389".
 * `grammar.ts` rule 3 asked the first question while meaning the second, so
 * every label it met was treated as a figure and shipped to the end of the
 * line. See `tests/translateWordOrder.test.ts`.
 */
function grammarContext(lang: TargetLang): GrammarContext {
  return {
    lang,
    atom: (value, l) => translateAtom(value, l),
    /**
     * R3 AND R3 ALONE: a figure WITH a unit. Never a dictionary phrase, and
     * never a bare number — a bare number is what let "389 x 389 x 458 mm" be
     * peeled apart one figure at a time.
     *
     * An opaque CODE used to be accepted here too, on the reasoning that
     * «فلامنت PLA» puts the code behind the head exactly as a figure goes
     * behind it. That reasoning holds only while nothing else is behind the
     * head. Once rule 3b could resolve "<head> <figure>", the figure took that
     * place and the code was pushed past it — «فلامنت 1 كغم PLA». A code is now
     * `code` below, and `grammar.ts` rule 3c places it beside its noun.
     */
    measure: (value, l) => translateMeasurement(value, l),
    /** R2: an opaque model or material code. See GrammarContext.code. */
    code: (value) => (isIdentity(value.trim()) ? value.trim() : null),
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
    if (out !== null) {
      // The terminator was stripped from ENGLISH and is being re-attached to
      // ARABIC, so it is Arabic punctuation now. «؟» and «؛» are the Arabic
      // question mark and semicolon; the full stop and the exclamation mark
      // are shared and are left exactly as the author typed them. An
      // UNTRANSLATED segment falls through below and is returned byte for
      // byte, English punctuation included.
      return { out: `${bullet}${out}${arabicPunctuation(trailing)}`, translated: true, rule };
    }
  }
  return { out: seg, translated: false, rule: 'untranslated' };
}

/**
 * Splits on line breaks and sentence terminators, CAPTURING the separators so
 * that `segment(s).join('') === s` exactly. Dropping the inter-sentence space
 * would silently reflow the author's text on every save.
 *
 * THE SEMICOLON IS A TERMINATOR HERE, and leaving it out of this list was a
 * live corruption on the storefront. The A1's own dimensions line reads
 *
 *   "596 × 536 × 325 mm; gross weight 13 kg"
 *
 * — two independent clauses. As ONE segment nothing matched until the noun
 * rule, which read the dimension as a MODIFIER of "gross weight 13 kg" and
 * moved it behind, returning «13 كغم الوزن الإجمالي 596 × 536 × 325 مم;» —
 * the weight before the dimensions, a Latin semicolon inside Arabic, and
 * `status: 'machine'`. Split at the semicolon, each clause is an ordinary spec
 * line the engine already handles correctly and the order is the author's.
 *
 * A semicolon is a clause boundary in Arabic too («؛»), so this is not an
 * English-only convenience — and `translateSegment` re-attaches it in its
 * Arabic form.
 */
export function segment(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split(/(\n)/)) {
    if (line === '\n') {
      out.push(line);
      continue;
    }
    if (!line) continue;
    for (const p of line.split(/((?<=[.!?؟;؛])\s+)/)) {
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
