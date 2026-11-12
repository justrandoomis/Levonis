/**
 * A SMALL EXCEL WRITER for the money reports and statements (the owner's brief, 2026-11-12, part 1: «downloadable,
 * printable Excel … reports … totals at the bottom of every numerical column»; part 2: the statements).
 *
 * WHY NOT A LIBRARY. A workbook is a zip of a few XML files, and the reports need very little of the format: one table per
 * sheet, a bold header row frozen at the top, dinar amounts with thousands separators, a totals row of real SUM formulas,
 * a right-to-left sheet for Arabic. A spreadsheet library would add hundreds of kilobytes to the Worker for that. This file
 * writes the parts itself and stores them in the zip uncompressed (method 0), which every spreadsheet program reads.
 *
 * WHAT A CELL IS.
 *   text    an inline string (`t="inlineStr"`): never read as a formula, so a value starting with = + - @ is just text —
 *           the CSV files need a leading ' for that, a workbook does not;
 *   money   a number with the `#,##0` format; dinars are whole numbers;
 *   int     a plain number;
 *   date    a calendar day 'YYYY-MM-DD' written as a real date (a serial number with the yyyy-mm-dd format): it sorts as a
 *           date, and a right-to-left sheet cannot turn it round as it can a text «2026-11-12»; anything else is text;
 *   null    an empty cell — an unknown amount is never 0, so a column's SUM is the sum of what is known, as on the screens.
 * The totals row sums each money and int column with SUM over the data rows and carries the computed value too (`<v>`), so a
 * viewer that does not recalculate still shows it.
 *
 * THE ARRANGEMENT (the owner, 2026-11-13: «need more improvement of arrangement on pdf and excel»). Column groups may sit
 * over the header (merged, centred); the header wraps and is bordered; a negative amount is red; the figure a table is
 * about can be bold; the header row carries a filter; and every sheet prints A4 landscape, one page wide, its header rows
 * repeated on each page and «page n / N» at the foot.
 */

export type XlsxKind = 'text' | 'money' | 'int' | 'date' | 'pct';

export interface XlsxColumn {
  key: string;
  header: string;
  kind: XlsxKind;
  /** Width in characters; estimated from the header and the values when absent. */
  width?: number;
  /** Whether the totals row sums this column (money and int columns by default). */
  total?: boolean;
  /** A row's own kind for this column (a summary sheet's values are money, counts and percentages). */
  kindOf?: (row: Record<string, unknown>) => XlsxKind;
}

export interface XlsxSheet {
  /** At most 31 characters, none of []:*?/\ (Excel's rule); cleaned if not. */
  name: string;
  columns: XlsxColumn[];
  rows: ReadonlyArray<Record<string, unknown>>;
  /** Right to left (an Arabic or Sorani sheet). */
  rtl?: boolean;
  /** Lines written above the table (a title, the period); the header row follows them. */
  heading?: string[];
  /** The totals row's first cell (e.g. «المجموع»); no totals row when absent. */
  totalLabel?: string;
  /** Column groups over the header row, in column order: a label and how many columns it spans. */
  groups?: ReadonlyArray<{ label: string; span: number }>;
  /** Columns written bold: the figure the table is about. */
  strong?: readonly string[];
}

// ─────────────────────────────────────────────────────────────── XML

/** Characters XML 1.0 cannot carry are dropped (a control character in a product name would make the file unreadable). */
// eslint-disable-next-line no-control-regex -- the XML 1.0 character ranges, tab, line feed and carriage return among them
const INVALID_XML = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;
export const xmlText = (s: string) =>
  s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A1-style column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const sheetNameOf = (name: string, i: number) => (name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`);

// Style ids in styles.xml's cellXfs, in order.
const S = { plain: 0, header: 1, money: 2, int: 3, totalLabel: 4, totalMoney: 5, totalInt: 6, heading: 7, date: 8, group: 9, pct: 10, strongMoney: 11 } as const;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="#,##0;[Red]-#,##0"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF2"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD3DCE5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF8899A6"/></top><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFB8C2CC"/></left><right style="thin"><color rgb="FFB8C2CC"/></right><top style="thin"><color rgb="FFB8C2CC"/></top><bottom style="thin"><color rgb="FFB8C2CC"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="1" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const numberOf = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  return null;
};
const textOf = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : String(v));

/** Excel's day number (1900 system, as every program reads it) of a calendar day, or null for anything that is not one. */
export function excelDay(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== value) return null;
  return Math.round(t / 86400000) + 25569;
}

function cell(ref: string, kind: XlsxKind, value: unknown, style?: number): string {
  if (kind === 'date') {
    const day = excelDay(value);
    return day === null ? cell(ref, 'text', value, style) : `<c r="${ref}" s="${S.date}"><v>${day}</v></c>`;
  }
  if (kind === 'text') {
    const t = textOf(value);
    if (t === null || t === '') return '';
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlText(t)}</t></is></c>`;
  }
  const n = numberOf(value);
  if (n === null) return '';
  return `<c r="${ref}" s="${style ?? (kind === 'money' ? S.money : kind === 'pct' ? S.pct : S.int)}"><v>${n}</v></c>`;
}

/** Where a sheet's parts sit: the heading lines, a blank row, the column groups when there are any, the header, the rows. */
function layoutOf(sheet: XlsxSheet) {
  const heading = sheet.heading ?? [];
  const groupRow = sheet.groups?.length ? heading.length + (heading.length ? 2 : 1) : 0;
  const headerRow = groupRow ? groupRow + 1 : heading.length + (heading.length ? 2 : 1); // a blank line between the heading and the table
  return { heading, groupRow, headerRow, firstData: headerRow + 1, lastData: headerRow + sheet.rows.length };
}
const lastColumn = (sheet: XlsxSheet) => columnName(Math.max(0, sheet.columns.length - 1));
/** A sheet name inside a formula or a defined name: quoted, its quotes doubled. */
const quotedSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

function sheetXml(sheet: XlsxSheet): string {
  const { heading, groupRow, headerRow, firstData, lastData } = layoutOf(sheet);
  const rows: string[] = [];
  const merges: string[] = [];
  heading.forEach((line, i) => rows.push(`<row r="${i + 1}">${cell(`A${i + 1}`, 'text', line, S.heading)}</row>`));
  if (groupRow) {
    // Each group labels its first cell; the cells it spans carry the same fill and border, and are merged.
    const cells: string[] = [];
    let at = 0;
    for (const g of sheet.groups ?? []) {
      const span = Math.max(1, Math.min(g.span, sheet.columns.length - at));
      if (span <= 0) break;
      cells.push(cell(`${columnName(at)}${groupRow}`, 'text', g.label, S.group) || `<c r="${columnName(at)}${groupRow}" s="${S.group}"/>`);
      for (let k = 1; k < span; k++) cells.push(`<c r="${columnName(at + k)}${groupRow}" s="${S.group}"/>`);
      if (span > 1) merges.push(`${columnName(at)}${groupRow}:${columnName(at + span - 1)}${groupRow}`);
      at += span;
    }
    rows.push(`<row r="${groupRow}" ht="20" customHeight="1">${cells.join('')}</row>`);
  }
  rows.push(`<row r="${headerRow}" ht="32" customHeight="1">${sheet.columns.map((c, j) => cell(`${columnName(j)}${headerRow}`, 'text', c.header, S.header)).join('')}</row>`);
  const strong = new Set(sheet.strong ?? []);
  sheet.rows.forEach((r, i) => {
    const n = firstData + i;
    rows.push(`<row r="${n}">${sheet.columns.map((c, j) => {
      const kind = c.kindOf?.(r) ?? c.kind;
      return cell(`${columnName(j)}${n}`, kind, r[c.key], kind === 'money' && strong.has(c.key) ? S.strongMoney : undefined);
    }).join('')}</row>`);
  });
  if (sheet.totalLabel !== undefined) {
    const n = lastData + 1;
    const cells = sheet.columns.map((c, j) => {
      const ref = `${columnName(j)}${n}`;
      if (j === 0) return cell(ref, 'text', sheet.totalLabel, S.totalLabel);
      if (c.kind === 'text' || c.kind === 'date' || c.total === false) return '';
      let sum = 0;
      for (const r of sheet.rows) sum += numberOf(r[c.key]) ?? 0;
      const range = sheet.rows.length ? `${columnName(j)}${firstData}:${columnName(j)}${lastData}` : null;
      const style = c.kind === 'money' ? S.totalMoney : S.totalInt;
      return range ? `<c r="${ref}" s="${style}"><f>SUM(${range})</f><v>${sum}</v></c>` : `<c r="${ref}" s="${style}"><v>0</v></c>`;
    });
    rows.push(`<row r="${n}">${cells.join('')}</row>`);
  }
  const widths = sheet.columns.map((c) => {
    if (c.width) return c.width;
    let w = c.header.length;
    for (const r of sheet.rows.slice(0, 200)) {
      const v = r[c.key];
      const len = c.kind === 'text' || c.kind === 'date' ? (textOf(v) ?? '').length : (numberOf(v) ?? 0).toLocaleString('en-US').length;
      if (len > w) w = len;
    }
    return Math.min(60, Math.max(8, w + 2));
  });
  const cols = `<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const view = `<sheetViews><sheetView workbookViewId="0"${sheet.rtl ? ' rightToLeft="1"' : ''}><pane ySplit="${headerRow}" topLeftCell="A${firstData}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  // The header row filters the rows (not the totals); then the merged groups; then printing: one page wide, A4 landscape.
  const filter = sheet.rows.length && sheet.columns.length > 1 ? `<autoFilter ref="A${headerRow}:${lastColumn(sheet)}${lastData}"/>` : '';
  const merged = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const print = '<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>'
    + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${view}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows.join('')}</sheetData>${filter}${merged}${print}</worksheet>`;
}

/** Each sheet's printed header rows (repeated on every page) and its filter range, as the workbook names them. */
function definedNames(sheets: XlsxSheet[], names: string[]): string {
  const out: string[] = [];
  sheets.forEach((s, i) => {
    const { groupRow, headerRow, lastData } = layoutOf(s);
    const q = quotedSheet(names[i]);
    if (s.rows.length && s.columns.length > 1)
      out.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(`${q}!$A$${headerRow}:$${lastColumn(s)}$${lastData}`)}</definedName>`);
    out.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${xmlText(`${q}!$${groupRow || headerRow}:$${headerRow}`)}</definedName>`);
  });
  return out.length ? `<definedNames>${out.join('')}</definedNames>` : '';
}

/** The workbook's files, by path, as text. */
export function xlsxParts(sheets: XlsxSheet[]): Array<[string, string]> {
  if (!sheets.length) throw new Error('xlsx: a workbook needs a sheet');
  const names: string[] = [];
  for (const [i, s] of sheets.entries()) {
    let name = sheetNameOf(s.name, i);
    while (names.includes(name)) name = `${name.slice(0, 28)} ${i + 1}`;
    names.push(name);
  }
  return [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView${sheets[0].rtl ? ' rightToLeft="1"' : ''}/></bookViews><sheets>${names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${definedNames(sheets, names)}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
}

// ─────────────────────────────────────────────────────────────── the zip (stored, no compression)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of the given files, stored (method 0), UTF-8 names; the timestamp is fixed so one input gives one file. */
export function zipStored(files: Array<[string, Uint8Array]>): Uint8Array {
  const enc = new TextEncoder();
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01 00:00
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = enc.encode(name), crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, DOS_TIME, true); lv.setUint16(12, DOS_DATE, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true); cv.setUint16(14, DOS_DATE, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true); central.set(nameBytes, 46);
    locals.push(local, data); centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

/** The workbook as bytes. */
export function xlsxWorkbook(sheets: XlsxSheet[]): Uint8Array {
  const enc = new TextEncoder();
  return zipStored(xlsxParts(sheets).map(([path, text]) => [path, enc.encode(text)]));
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A download response; `name` without its extension, kept to safe characters. */
export function xlsxResponse(bytes: Uint8Array, name: string): Response {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120) || 'report';
  return new Response(bytes, { headers: { 'Content-Type': XLSX_CONTENT_TYPE, 'Content-Disposition': `attachment; filename="${safe}.xlsx"`, 'Cache-Control': 'private, no-store' } });
}
