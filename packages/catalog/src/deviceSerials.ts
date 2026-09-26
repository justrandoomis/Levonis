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
 * same label (`03919D580607841`) starts with a digit.
 */
export const BOX_SN_RE = /^B\d{4,}[A-Z][0-9A-Z]{3,}$/;

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

/** Strips a printed prefix a QR/Data Matrix payload may carry (`SN: …`, `S/N: …`, `Product SN: …`). */
function stripSnPrefix(text: string): string {
  return text.replace(/^\s*(?:product\s*)?s\s*\/?\s*n\s*[:：#]\s*/i, '').trim();
}

/** What one decoded value is, on its own. */
export function classifyCode(code: DecodedCode): { kind: CodeKind; value: string } {
  const text = String(code.text ?? '').trim();
  if (!text) return { kind: 'unknown', value: '' };
  if (looksLikeReceipt(text)) return { kind: 'receipt', value: text };
  const fmt = (code.format ?? '').toLowerCase();
  const digits = text.replace(/\s+/g, '');
  if (isValidGtin(digits) && (fmt === '' || /ean|upc|itf|code_128/.test(fmt))) return { kind: 'ean', value: digits };
  if (/^(ean|upc)/.test(fmt)) return { kind: 'unknown', value: text };
  const norm = normalizeSerial(stripSnPrefix(text));
  if (serialProblem(norm) !== null) return { kind: 'unknown', value: text };
  if (BOX_SN_RE.test(norm)) return { kind: 'box_sn', value: norm };
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

export type BulkRowProblem = SerialProblem | 'EAN_INVALID' | 'BOX_SN_INVALID';

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
 * and a pasted row are judged by the same rules.
 */
export function buildBulkRow(
  line: number,
  fields: BulkFields,
  defaults: { model_name?: string; model_code?: string } = {}
): BulkRow {
  const serialRaw = stripSnPrefix(String(fields.serial ?? '')).slice(0, 200);
  const ean = normalizeEan(fields.ean);
  const boxRaw = String(fields.box_sn ?? '').trim();
  const boxNorm = normalizeSerial(boxRaw);
  let problem: BulkRowProblem | null = serialProblem(serialRaw);
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
  maxLines = BULK_MAX_LINES
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
        defaults
      )
    );
  }
  return { rows: markDuplicates(rows), too_many: tooMany };
}
