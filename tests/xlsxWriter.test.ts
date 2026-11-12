/**
 * THE SMALL EXCEL WRITER (worker/lib/xlsx.ts; the owner's brief, 2026-11-12, parts 1 and 2: Excel reports and statements
 * with totals under every number column).
 *
 * Read back with a few lines of zip reading: the zip's own structure (signatures, sizes, CRC-32 of every part), the parts a
 * spreadsheet program looks for, a right-to-left sheet with a frozen header, text that stays text (a value starting with =
 * is never a formula), XML-escaped and with control characters dropped, numbers with the dinar format, an unknown amount as
 * an empty cell, and the totals row — a SUM over exactly the data rows, carrying its computed value.
 *
 * Every figure is invented. Run: node --import tsx --test tests/xlsxWriter.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnName, crc32, excelDay, xlsxParts, xlsxWorkbook, xmlText, zipStored, type XlsxSheet } from '../worker/lib/xlsx';

/** The stored zip's files, checked as a reader checks them: the central directory, each local header, each CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder();
  const end = bytes.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50, 'end of central directory');
  const count = v.getUint16(end + 10, true), size = v.getUint32(end + 12, true), start = v.getUint32(end + 16, true);
  assert.equal(start + size, end, 'the central directory ends where the end record starts');
  const out = new Map<string, string>();
  let at = start;
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(at, true), 0x02014b50, 'central header');
    assert.equal(v.getUint16(at + 10, true), 0, 'stored');
    const crc = v.getUint32(at + 16, true), len = v.getUint32(at + 20, true), nameLen = v.getUint16(at + 28, true), local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    assert.equal(v.getUint32(local, true), 0x04034b50, `${name}: local header`);
    assert.equal(v.getUint32(local + 14, true), crc, `${name}: the same CRC in both headers`);
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(dataStart, dataStart + len);
    assert.equal(crc32(data), crc, `${name}: CRC-32 of its bytes`);
    out.set(name, dec.decode(data));
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

const SHEET: XlsxSheet = {
  name: 'الطلبات',
  rtl: true,
  heading: ['تقرير الطلبات', 'من 2026-11-01 إلى 2026-11-12'],
  totalLabel: 'المجموع',
  columns: [
    { key: 'order_id', header: 'رقم الطلب', kind: 'text' },
    { key: 'customer', header: 'الزبون', kind: 'text' },
    { key: 'qty', header: 'القطع', kind: 'int' },
    { key: 'sales_iqd', header: 'المبيعات', kind: 'money' },
    { key: 'cost_iqd', header: 'التكلفة', kind: 'money' },
  ],
  rows: [
    { order_id: 'ORD-0E00000001', customer: 'زبون <أ> & "ب"', qty: 2, sales_iqd: 85000, cost_iqd: 61000 },
    { order_id: 'ORD-0E00000002', customer: '=HYPERLINK("http://x","y")', qty: 1, sales_iqd: 30000, cost_iqd: null },
    { order_id: 'ORD-0E00000003', customer: 'سطر\u0007خفي', qty: 3, sales_iqd: 45500, cost_iqd: 30000 },
  ],
};

test('the zip a spreadsheet program reads: every part stored with its CRC, and the parts it looks for', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'the CRC-32 check value');
  const files = unzip(xlsxWorkbook([SHEET]));
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(files.get('xl/workbook.xml')!, /<sheet name="الطلبات" sheetId="1" r:id="rId1"\/>/);
  assert.match(files.get('xl/workbook.xml')!, /<workbookView rightToLeft="1"\/>/);
  assert.match(files.get('[Content_Types].xml')!, /PartName="\/xl\/worksheets\/sheet1.xml"/);
  assert.match(files.get('xl/styles.xml')!, /<xf numFmtId="3" fontId="0"/, 'the #,##0 dinar format');
  // One input, one file: the same bytes twice.
  assert.deepEqual(xlsxWorkbook([SHEET]), xlsxWorkbook([SHEET]));
});

test('the sheet: right to left, the heading, a frozen bold header, text that stays text, numbers formatted, unknowns empty', () => {
  const sheet = unzip(xlsxWorkbook([SHEET])).get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /<sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"\/>/, 'two heading lines, a blank, the header on row 4');
  assert.match(sheet, /<c r="A1" t="inlineStr" s="7"><is><t xml:space="preserve">تقرير الطلبات<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="D4" t="inlineStr" s="1"><is><t xml:space="preserve">المبيعات<\/t>/, 'the header, bold');
  assert.ok(sheet.includes('<t xml:space="preserve">زبون &lt;أ&gt; &amp; &quot;ب&quot;</t>'), 'escaped');
  assert.ok(sheet.includes('<c r="B6" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;,&quot;y&quot;)</t></is></c>'), 'a value that starts with = is text');
  assert.ok(!/<f>HYPERLINK/.test(sheet), 'never a formula');
  assert.ok(sheet.includes('سطرخفي'), 'a control character is dropped, the text kept');
  assert.match(sheet, /<c r="D5" s="2"><v>85000<\/v><\/c>/, 'money with its format');
  assert.match(sheet, /<c r="C5" s="3"><v>2<\/v><\/c>/);
  assert.ok(!sheet.includes('r="E6"'), 'an unknown cost is an empty cell, never 0');
});

test('the totals row: a SUM over exactly the data rows of each number column, with its value', () => {
  const sheet = unzip(xlsxWorkbook([SHEET])).get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /<row r="8"><c r="A8" t="inlineStr" s="4"><is><t xml:space="preserve">المجموع<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="C8" s="6"><f>SUM\(C5:C7\)<\/f><v>6<\/v><\/c>/);
  assert.match(sheet, /<c r="D8" s="5"><f>SUM\(D5:D7\)<\/f><v>160500<\/v><\/c>/);
  assert.match(sheet, /<c r="E8" s="5"><f>SUM\(E5:E7\)<\/f><v>91000<\/v><\/c>/, 'the known costs');
  assert.ok(!sheet.includes('r="B8"'), 'no total under a text column');
  // No rows: the totals are 0, and no formula over an empty range.
  const empty = unzip(xlsxWorkbook([{ ...SHEET, heading: [], rows: [] }])).get('xl/worksheets/sheet1.xml')!;
  assert.match(empty, /<row r="2"><c r="A2" t="inlineStr" s="4">/);
  assert.match(empty, /<c r="D2" s="5"><v>0<\/v><\/c>/);
});

test('names and letters: sheet names cleaned and kept apart, columns past Z', () => {
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  const parts = new Map(xlsxParts([{ ...SHEET, name: 'a/b:c*?[d]' }, { ...SHEET, name: 'a/b:c*?[d]' }, { ...SHEET, name: 'x'.repeat(40) }]));
  const wb = parts.get('xl/workbook.xml')!;
  assert.match(wb, /<sheet name="a b c {3}d" sheetId="1"/, 'each of / : * ? [ ] a space');
  assert.match(wb, /<sheet name="a b c {3}d 2" sheetId="2"/, 'two sheets never share a name');
  assert.match(wb, new RegExp(`<sheet name="${'x'.repeat(31)}" sheetId="3"`));
  assert.equal(xmlText('a\u0000b￾c'), 'abc');
  assert.throws(() => xlsxParts([]), /needs a sheet/);
  assert.equal(zipStored([]).length, 22, 'an empty zip is its end record');
});

test('a day is a real date: Excel’s day number with the yyyy-mm-dd format; anything that is not a calendar day stays text', () => {
  assert.equal(excelDay('1970-01-01'), 25569);
  assert.equal(excelDay('1900-03-01'), 61, 'past Excel’s 1900 leap day, as every program counts');
  for (const bad of ['2026-02-30', '2026-13-01', 'غدًا', '', null, 20261112]) assert.equal(excelDay(bad), null, String(bad));
  const sheet = unzip(xlsxWorkbook([{ name: 'd', columns: [{ key: 'day', header: 'day', kind: 'date' }], rows: [{ day: '2026-11-12' }, { day: '2026-02-30' }], totalLabel: 'total' }])).get('xl/worksheets/sheet1.xml')!;
  assert.ok(sheet.includes(`<c r="A2" s="8"><v>${excelDay('2026-11-12')}</v></c>`), 'a date cell');
  assert.ok(sheet.includes('<c r="A3" t="inlineStr"><is><t xml:space="preserve">2026-02-30</t></is></c>'), 'not a day: text');
  assert.match(unzip(xlsxWorkbook([SHEET])).get('xl/styles.xml')!, /<numFmt numFmtId="164" formatCode="yyyy-mm-dd"\/>/);
});
