/**
 * DEVICE SERIALS — normalisation, validation, box-label classification and
 * bulk-list parsing, shared by the Worker (authoritative) and the SPA (the
 * scanner and the bulk preview). Pure: no I/O, no bindings.
 *
 * THE LABEL (the owner's photo of a Bambu Lab A1 Combo box, 2026-09-26):
 *
 *     MODEL: PF002-A+SA005                              UK2
 *     Product SN: 03919D580607841                  A1-Combo
 *     ||||||||||||||||||||||||||||||||||||||||||||||||||||  ← Code 128 = the SN
 *     BOX SN:                        EAN:
 *     |||||||||||||||||||||||        |||||||||||||||||||    ← Code 128 / EAN-13
 *     B07119G5811000AB               6977252425445
 *
 * Three barcodes on one label, and only the top one is the device. A camera
 * pointed at the label may read any of them first, so every decoded value is
 * CLASSIFIED before it is used: the EAN by its GTIN check digit, the box SN
 * by its shape (a `B` followed by digits, then letters and digits) and, when
 * the decoder reports positions, by being BELOW the product SN — the owner's
 * words: the model is on the first line, the serial on the second, and its
 * barcode directly under it.
 */

import { BAMBU_BOX_SN_RE, LEGACY_RULE, effectiveBoxShape, evaluateSerial, ruleFamily, type BoxShape, type FormatNote, type SerialRule } from './serialRules';

// ------------------------------------------------------------ normalisation

/** Arabic-Indic and Extended (Persian) digits → ASCII, so a serial typed on an
 *  Arabic keyboard matches the one printed on the label. */
function asciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/**
 * THE lookup form of a serial: upper case, no whitespace, no dashes, no
 * invisible direction marks. `device_serials.serial_norm` (0003) and
 * `serial_inventory.serial_norm` (0139) are both written with this function,
 * which is what lets the two tables join on equality. The exact entered value
 * is always kept beside it (`serial_raw`).
 */
export function normalizeSerial(input: string): string {
  return asciiDigits(String(input ?? ''))
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-\u2010-\u2015]+/g, '');
}

/** Inventory serials: 6–40 letters and digits once normalised. */
export const SERIAL_MIN = 6;
export const SERIAL_MAX = 40;

/** A warranty receipt number (worker/lib/warranty.ts RECEIPT_NO_RE) or its QR link. */
export function looksLikeReceipt(text: string): boolean {
  const s = String(text ?? '').trim();
  return /^WR-\d{4}-\d{4}-\d{3,}$/i.test(s) || /^https?:\/\/\S+\/warranty\/WR-/i.test(s);
}

/** GTIN-8/12/13/14 (EAN-8, UPC-A, EAN-13, ITF-14) with a correct check digit. */
export function isValidGtin(text: string): boolean {
  const s = String(text ?? '').trim();
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s)) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop() as number;
  let sum = 0;
  // Weights 3,1,3,1… counted from the digit next to the check digit.
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * A box / carton serial. Bambu Lab prints `B07119G5811000AB`: a `B`, at least
 * four digits, a letter, then more letters and digits. A device serial on the
 * same label (`03919D580607841`) starts with a digit. It is a BAMBU shape
 * (owner decision 2, 2026-10-09): only a rule that names the `bambu` box
 * shape refuses it (./serialRules.ts); every other brand's serial of that
 * shape is accepted with a warning.
 */
export const BOX_SN_RE = BAMBU_BOX_SN_RE;

export type SerialProblem =
  | 'SERIAL_EMPTY'
  | 'SERIAL_TOO_SHORT'
  | 'SERIAL_TOO_LONG'
  | 'SERIAL_CHARS'
  | 'SERIAL_LOOKS_LIKE_EAN'
  | 'SERIAL_LOOKS_LIKE_RECEIPT';

/** Why a value cannot be stored as an inventory serial, or null when it can. */
export function serialProblem(raw: string): SerialProblem | null {
  if (looksLikeReceipt(raw)) return 'SERIAL_LOOKS_LIKE_RECEIPT';
  const norm = normalizeSerial(raw);
  if (!norm) return 'SERIAL_EMPTY';
  if (norm.length < SERIAL_MIN) return 'SERIAL_TOO_SHORT';
  if (norm.length > SERIAL_MAX) return 'SERIAL_TOO_LONG';
  if (!/^[A-Z0-9]+$/.test(norm)) return 'SERIAL_CHARS';
  // Only the 13-digit shape: that is the EAN printed beside the serial on a
  // box label, and the usual wrong barcode. Other all-digit serials pass.
  if (/^\d{13}$/.test(norm) && isValidGtin(norm)) return 'SERIAL_LOOKS_LIKE_EAN';
  return null;
}

/** The EAN as stored: digits only, or '' when absent. Null = present but invalid. */
export function normalizeEan(raw: string | null | undefined): string | null {
  const s = asciiDigits(String(raw ?? '')).replace(/\s+/g, '');
  if (!s) return '';
  return isValidGtin(s) ? s : null;
}

/** Model code as printed (`PF002-A+SA005`): trimmed, upper case, inner spaces collapsed. */
export function normalizeModelCode(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/^\s*model\s*[:：]?\s*/i, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

/** Model name (`A1 Combo`): trimmed, inner spaces collapsed. */
export function normalizeModelName(raw: string | null | undefined): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

// ------------------------------------------------------- label classification

export type CodeKind = 'serial' | 'box_sn' | 'ean' | 'receipt' | 'unknown';

export interface DecodedCode {
  /** The decoded text, exactly as the decoder returned it. */
  text: string;
  /** BarcodeDetector format name (`code_128`, `ean_13`, `qr_code`, …) when known. */
  format?: string;
  /** Vertical position of the code's top edge in the frame (any unit), when known. */
  y?: number;
}

/**
 * Strips a printed prefix a QR/Data Matrix payload, a wedge read or a typed
 * value may carry: `SN: …`, `S/N: …`, `Product SN: …` — and `SN 0391…` with
 * only a space (serial-scan critique H1: without the colon it normalised to
 * `SN0391…`, a second asset for one device). A separator is required, so a
 * serial that merely starts with S and N is kept. worker/lib/serialAssignments.ts
 * `stripSerialPrefix` is the server's copy of this rule.
 */
function stripSnPrefix(text: string): string {
  return text.replace(/^\s*(?:product\s*)?s\s*\/?\s*n(?:\s*[:：#]\s*|\s+)(?=\S)/i, '').trim();
}

/**
 * What one decoded value is, on its own. `boxShape` is the box classifier of
 * the rule that judges this serial (./serialRules.ts `effectiveBoxShape`):
 * 'bambu' — the default, today's reading — calls a Bambu-box-shaped value a
 * box SN; 'none' (another brand, an `off` rule, the generic rule) calls it a
 * serial.
 */
export function classifyCode(code: DecodedCode, opts: { boxShape?: BoxShape } = {}): { kind: CodeKind; value: string } {
  const text = String(code.text ?? '').trim();
  if (!text) return { kind: 'unknown', value: '' };
  if (looksLikeReceipt(text)) return { kind: 'receipt', value: text };
  const fmt = (code.format ?? '').toLowerCase();
  const digits = text.replace(/\s+/g, '');
  if (isValidGtin(digits) && (fmt === '' || /ean|upc|itf|code_128/.test(fmt))) return { kind: 'ean', value: digits };
  if (/^(ean|upc)/.test(fmt)) return { kind: 'unknown', value: text };
  const norm = normalizeSerial(stripSnPrefix(text));
  if (serialProblem(norm) !== null) return { kind: 'unknown', value: text };
  if ((opts.boxShape ?? 'bambu') === 'bambu' && BOX_SN_RE.test(norm)) return { kind: 'box_sn', value: norm };
  return { kind: 'serial', value: norm };
}

export interface LabelRead {
  /** The device serial (normalised), when one was read. */
  productSn: string | null;
  boxSn: string | null;
  ean: string | null;
  /** A warranty receipt number or its QR link, verbatim. */
  receipt: string | null;
}

/**
 * Every code read off ONE label (one frame, or a short window of frames) →
 * which one is the device. Rules, in order:
 *  1. the EAN is the value with a valid GTIN check digit;
 *  2. a value shaped like a box SN is the box SN;
 *  3. of the remaining serial-shaped values the TOP-MOST is the product SN
 *     (the owner's layout: model, SN line, its barcode, then the others) — or,
 *     with no positions, the first one read;
 *  4. with positions known and two serial-shaped values but no box-shaped
 *     one, the lower one is taken as the box SN.
 */
export function classifyLabel(codes: readonly DecodedCode[]): LabelRead {
  const out: LabelRead = { productSn: null, boxSn: null, ean: null, receipt: null };
  const seen = new Set<string>();
  const serials: Array<{ value: string; y: number | undefined; order: number }> = [];
  codes.forEach((code, order) => {
    const c = classifyCode(code);
    if (!c.value || seen.has(`${c.kind}:${c.value}`)) return;
    seen.add(`${c.kind}:${c.value}`);
    if (c.kind === 'ean') out.ean ??= c.value;
    else if (c.kind === 'receipt') out.receipt ??= c.value;
    else if (c.kind === 'box_sn') out.boxSn ??= c.value;
    else if (c.kind === 'serial') serials.push({ value: c.value, y: code.y, order });
  });
  const positioned = serials.every((s) => typeof s.y === 'number' && Number.isFinite(s.y));
  serials.sort((a, b) => (positioned ? (a.y as number) - (b.y as number) : 0) || a.order - b.order);
  if (serials.length > 0) out.productSn = serials[0].value;
  if (serials.length > 1 && positioned && !out.boxSn) out.boxSn = serials[1].value;
  return out;
}

// -------------------------------------------------------------- bulk parsing

/** The most lines one bulk paste may carry (the server re-checks). */
export const BULK_MAX_LINES = 1000;

export type BulkRowProblem = SerialProblem | 'EAN_INVALID' | 'BOX_SN_INVALID' | 'SERIAL_LOOKS_LIKE_BOX' | 'SERIAL_FORMAT_MISMATCH';

export interface BulkRow {
  /** 1-based line number in the pasted text. */
  line: number;
  serial_raw: string;
  serial_norm: string;
  model_name: string;
  model_code: string;
  box_sn: string;
  ean: string;
  problem: BulkRowProblem | null;
  /**
   * What the serial's format rule says (owner decision 2): warnings on an
   * accepted row, shown in amber and counted in the audit — or, with
   * `problem: 'SERIAL_FORMAT_MISMATCH'` under an `enforce` rule, the reasons.
   */
  warnings: FormatNote[];
  /** The earlier line carrying the same serial in this paste, or null. */
  duplicate_of: number | null;
}

type Column = 'serial' | 'model_name' | 'model_code' | 'box_sn' | 'ean';
const DEFAULT_COLUMNS: Column[] = ['serial', 'model_name', 'model_code', 'box_sn', 'ean'];
const HEADER_WORDS: Record<string, Column> = {
  serial: 'serial', sn: 'serial', serial_number: 'serial', 'serial number': 'serial', 'product sn': 'serial', product_sn: 'serial',
  'الرقم التسلسلي': 'serial', السيريال: 'serial',
  model: 'model_name', model_name: 'model_name', 'model name': 'model_name', name: 'model_name', الموديل: 'model_name', الطراز: 'model_name',
  model_code: 'model_code', 'model code': 'model_code', code: 'model_code',
  box_sn: 'box_sn', 'box sn': 'box_sn', box: 'box_sn',
  ean: 'ean', barcode: 'ean', gtin: 'ean',
};

/** Splits one CSV-ish line on comma, semicolon or tab, honouring "quoted, cells". */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (ch === ',' || ch === ';' || ch === '\t' || ch === '،') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export interface BulkFields {
  serial: string;
  model_name?: string;
  model_code?: string;
  box_sn?: string;
  ean?: string;
}

/**
 * One candidate row, validated. Shared by the paste parser below and by the
 * scanner's list (which already has its fields separated), so a scanned row
 * and a pasted row are judged by the same rules. `rule` is the serial format
 * rule of the product the row is filed under (./serialRules.ts; the Worker
 * resolves it): LEGACY_RULE — today's reading — when the caller names none.
 */
export function buildBulkRow(
  line: number,
  fields: BulkFields,
  defaults: { model_name?: string; model_code?: string } = {},
  rule: SerialRule = LEGACY_RULE
): BulkRow {
  const serialRaw = stripSnPrefix(String(fields.serial ?? '')).slice(0, 200);
  const ean = normalizeEan(fields.ean);
  const boxRaw = String(fields.box_sn ?? '').trim();
  const boxNorm = normalizeSerial(boxRaw);
  let problem: BulkRowProblem | null = serialProblem(serialRaw);
  let warnings: FormatNote[] = [];
  // The same reading as every other door (serial-scan critique H1): a product
  // barcode of ANY length (EAN-8, UPC-A, EAN-13, ITF-14) is never a device
  // serial, and neither is a box SN under a rule that names the Bambu box
  // shape — filed as one, the device would get a second asset the moment its
  // real Product SN is scanned. Under any other rule a value of that shape is
  // the brand's own serial, accepted with a warning (owner decision 2).
  if (!problem) {
    const kind = classifyCode({ text: serialRaw }, { boxShape: effectiveBoxShape(rule) }).kind;
    if (kind === 'ean') problem = 'SERIAL_LOOKS_LIKE_EAN';
    else if (kind === 'box_sn') problem = 'SERIAL_LOOKS_LIKE_BOX';
  }
  if (!problem) {
    const verdict = evaluateSerial(normalizeSerial(serialRaw), rule);
    if (verdict.refuse.length) {
      problem = 'SERIAL_FORMAT_MISMATCH';
      warnings = verdict.refuse;
    } else warnings = verdict.warnings;
  }
  if (!problem && ean === null) problem = 'EAN_INVALID';
  if (!problem && boxRaw && (boxNorm.length < 4 || boxNorm.length > 60 || !/^[A-Z0-9]+$/.test(boxNorm))) problem = 'BOX_SN_INVALID';
  return {
    line,
    serial_raw: serialRaw.trim(),
    serial_norm: normalizeSerial(serialRaw),
    model_name: normalizeModelName(fields.model_name || defaults.model_name),
    model_code: normalizeModelCode(fields.model_code || defaults.model_code),
    box_sn: boxRaw ? boxNorm : '',
    ean: ean ?? '',
    problem,
    warnings,
    duplicate_of: null,
  };
}

/** Marks every valid row whose serial an EARLIER valid row already carries. */
export function markDuplicates(rows: BulkRow[]): BulkRow[] {
  const firstLineOf = new Map<string, number>();
  return rows.map((r) => {
    if (r.problem || !r.serial_norm) return r;
    const prior = firstLineOf.get(r.serial_norm);
    if (prior === undefined) {
      firstLineOf.set(r.serial_norm, r.line);
      return r;
    }
    return { ...r, duplicate_of: prior };
  });
}

/**
 * A pasted list → one row per non-empty line. Accepted shapes:
 *   one serial per line;
 *   `serial,model` (CSV, `;` or tab also work) — then `model_code`, `box_sn`,
 *   `ean` in that order when present;
 *   any of the above under a header line naming the columns
 *   (`serial,model_code,ean` …), in which case the header decides the order.
 * `defaults` fill model/code on rows that do not carry their own.
 * Nothing is dropped silently: an invalid line is returned with its problem,
 * and a repeated serial names the line it repeats.
 */
export function parseSerialList(
  text: string,
  defaults: { model_name?: string; model_code?: string } = {},
  maxLines = BULK_MAX_LINES,
  rule: SerialRule = LEGACY_RULE
): { rows: BulkRow[]; too_many: boolean } {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let columns = DEFAULT_COLUMNS;
  const rows: BulkRow[] = [];
  let started = false;
  let tooMany = false;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;
    const cells = splitCells(rawLine);
    if (!started) {
      started = true;
      const mapped = cells.map((c) => HEADER_WORDS[c.trim().toLowerCase()]);
      if (mapped.length > 0 && mapped.every((m) => !!m) && mapped.includes('serial')) {
        columns = mapped as Column[];
        continue;
      }
    }
    if (rows.length >= maxLines) {
      tooMany = true;
      break;
    }
    const cell = (name: Column) => {
      const idx = columns.indexOf(name);
      return idx >= 0 ? (cells[idx] ?? '') : '';
    };
    rows.push(
      buildBulkRow(
        i + 1,
        { serial: cell('serial'), model_name: cell('model_name'), model_code: cell('model_code'), box_sn: cell('box_sn'), ean: cell('ean') },
        defaults,
        rule
      )
    );
  }
  return { rows: markDuplicates(rows), too_many: tooMany };
}

// ---------------------------------------------------------- label knowledge

/**
 * WHAT A SERIAL ALONE SAYS ABOUT THE MACHINE.
 *
 * A Bambu Lab device serial opens with a three-character model prefix that
 * every unit of one printer family shares. The owner's own label proves the
 * prefix that matters most here — `03919D580607841` on an «A1-Combo» box —
 * and the others are the ones Bambu Lab's "find your serial number" pages
 * show for each family.
 *
 * A PREFIX NAMES THE FAMILY, NEVER THE PRODUCT. The same A1 ships alone and as
 * a Combo with an AMS lite, in several regional boxes, each with its own EAN;
 * guessing between them would file a buyer's serial under the wrong product,
 * and the warranty link would then refuse the very customer it was for. So the
 * family only ever fills the «الموديل» column when nothing better is known —
 * the product comes from the EAN (learned, or the known table below) or from
 * the owner's one tap on «ربط بمنتج».
 *
 * THE RULE DECIDES (owner decision 2, 2026-10-09). A serial's family is read
 * from the prefixes of the rule that judges it (./serialRules.ts — Bambu
 * Lab's 13 official prefixes, an alias on `00M` for «X1C»); this constant is
 * only the DISPLAY FALLBACK for a serial whose product, and so whose rule, is
 * not known — the five prefixes the shop has always shown.
 */
const SERIAL_PREFIX_FAMILIES: ReadonlyArray<readonly [prefix: string, family: string]> = [
  ['039', 'A1'],
  ['030', 'A1 mini'],
  ['01P', 'P1S'],
  ['01S', 'P1P'],
  ['00M', 'X1 Carbon'],
];

export interface ModelHint {
  brand: string;
  /** The family or model as the box names it: «A1», «A1 Combo». */
  model: string;
  /** Brand and model together, for a column: «Bambu Lab A1». */
  label: string;
  /** The printed model code when the label is a known one. */
  model_code: string;
  /** Where the hint came from: the EAN (a whole product) or the serial's prefix (a family). */
  source: 'ean' | 'serial_prefix';
}

/**
 * The printer family a device serial belongs to, from its prefix; null when
 * unknown. With `rule`, that rule's prefixes and brand name decide (a rule
 * with no prefixes names no family); without one, the display fallback above.
 */
export function serialModelHint(serial: string, rule?: SerialRule | null): ModelHint | null {
  const norm = normalizeSerial(serial);
  if (rule) {
    if (!/^[0-9A-Z]+$/.test(norm)) return null;
    const hit = ruleFamily(norm, rule);
    if (!hit) return null;
    const brand = rule.label || '';
    return { brand, model: hit.m, label: brand ? `${brand} ${hit.m}` : hit.m, model_code: '', source: 'serial_prefix' };
  }
  if (!/^[0-9A-Z]{15}$/.test(norm)) return null;
  const hit = SERIAL_PREFIX_FAMILIES.find(([prefix]) => norm.startsWith(prefix));
  if (!hit) return null;
  return { brand: 'Bambu Lab', model: hit[1], label: `Bambu Lab ${hit[1]}`, model_code: '', source: 'serial_prefix' };
}

/**
 * Box EANs whose product the label itself states. An EAN is a whole product
 * in one region (printer, bundle and plug), so it is the one code on the box
 * that CAN name the product. Only labels the shop has actually seen belong
 * here; every other EAN is learned the first time the owner files it
 * (`resolveLabelProduct`).
 */
export const KNOWN_LABEL_EANS: Readonly<Record<string, { brand: string; model: string; model_code: string }>> = {
  // The owner's photographed A1 Combo box (UK2), tests/fixtures/owner-label-a1-combo.pgm.gz.
  '6977252425445': { brand: 'Bambu Lab', model: 'A1 Combo', model_code: 'PF002-A+SA005' },
};

/** The best hint a label offers: its EAN when the box is a known one, else the serial's family. */
export function labelModelHint(input: { serial?: string | null; ean?: string | null }): ModelHint | null {
  const ean = normalizeEan(input.ean ?? '') || '';
  const known = ean ? KNOWN_LABEL_EANS[ean] : undefined;
  if (known) return { brand: known.brand, model: known.model, label: `${known.brand} ${known.model}`, model_code: known.model_code, source: 'ean' };
  return input.serial ? serialModelHint(input.serial) : null;
}

/** Words that sell a machine rather than name it. */
const NOISE_WORDS = new Set(['bambu', 'lab', 'bambulab', '3d', 'printer', 'printers', 'طابعة', 'طابعه', 'ثلاثية', 'ثلاثيه', 'الأبعاد', 'الابعاد']);

/**
 * Words that make ANOTHER machine of the same family: «A1» is not «A1 mini»
 * and not «A1 Combo». A product name carrying one the model does not is a
 * different product.
 */
const SIBLING_WORDS = new Set(['mini', 'combo', 'pro', 'max', 'plus', 'lite', 'carbon', 'se', 'ultra', 'hybrid', 'kit', 'ams']);

function nameTokens(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    // «A1mini», «P1S-Combo»: a glued sibling word still counts as its own word.
    .replace(/([a-z0-9])(mini|combo)\b/g, '$1 $2')
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter(Boolean);
}

/**
 * Whether a catalogue product's name is exactly this model — every word of
 * the model present, and no sibling word the model lacks. `A1 Combo` matches
 * «Bambu Lab A1 Combo 3D Printer»; `A1` matches «Bambu Lab A1» and neither
 * «A1 mini» nor «A1 Combo».
 */
export function modelMatchesProductName(model: string, productName: string): boolean {
  const want = nameTokens(model).filter((t) => !NOISE_WORDS.has(t));
  if (want.length === 0) return false;
  const have = nameTokens(productName);
  if (!want.every((t) => have.includes(t))) return false;
  return !have.some((t) => SIBLING_WORDS.has(t) && !want.includes(t));
}
