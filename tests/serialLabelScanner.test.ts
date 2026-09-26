/**
 * THE BOX LABEL, READ — normalisation, classification and the barcode reader,
 * with the owner's own label (scratchpad owner6/11.jpg, a Bambu Lab A1 Combo):
 *
 *     MODEL: PF002-A+SA005 … A1-Combo
 *     Product SN: 03919D580607841       ← Code 128 under it: THE DEVICE
 *     BOX SN: B07119G5811000AB          ← Code 128
 *     EAN: 6977252425445                ← EAN-13
 *
 * The decode tests draw real Code 128 / EAN-13 symbols from first principles
 * (tests/fixtures/barcodeImages.ts) and run them through the SAME reader the
 * scanner lazy-loads on iOS Safari (src/components/scanner/zxingReader.ts),
 * region by region as the scanner does, then through `classifyLabel`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import {
  BULK_MAX_LINES,
  classifyCode,
  classifyLabel,
  isValidGtin,
  looksLikeReceipt,
  normalizeEan,
  normalizeModelCode,
  normalizeSerial,
  parseSerialList,
  serialProblem,
} from '../packages/catalog/src/deviceSerials';
import { normalizeSerial as deviceOpsNormalize } from '../worker/lib/deviceOps';
import { decodeLuminance, rgbaToLuminance } from '../src/components/scanner/zxingReader';
import { CodeWindow, LABEL_REGIONS, cropLuminance } from '../src/components/scanner/decodeEngine';
import { blank, code128Modules, drawModules, ean13Modules, type Luma } from './fixtures/barcodeImages';
import { ROOT } from './fixtures/d1';

const SN = '03919D580607841';
const BOX = 'B07119G5811000AB';
const EAN = '6977252425445';

// ------------------------------------------------------------ normalisation

test('one normalisation for both tables: upper case, no spaces, dashes or invisible marks, ASCII digits', () => {
  assert.equal(normalizeSerial(' 03919d58-0607841 '), SN);
  assert.equal(normalizeSerial('03919D58\u200F0607841'), SN, 'an RTL mark pasted from an Arabic page');
  assert.equal(normalizeSerial('٠٣٩١٩D580607841'), SN, 'Arabic-Indic digits typed on an Arabic keyboard');
  assert.equal(normalizeSerial('03919D58\u20130607841'), SN, 'an en dash');
  assert.equal(deviceOpsNormalize, normalizeSerial, 'device_serials and serial_inventory share the one function');
  assert.equal(deviceOpsNormalize('SN-1234-ABCD'), 'SN1234ABCD', 'the existing device_serials form is unchanged');
});

test('what may be stored as a serial, and why not', () => {
  assert.equal(serialProblem(SN), null);
  assert.equal(serialProblem(BOX), null, 'a box SN is serial-shaped; the label classifier is what tells them apart');
  assert.equal(serialProblem(EAN), 'SERIAL_LOOKS_LIKE_EAN');
  assert.equal(serialProblem('WR-2026-0905-001'), 'SERIAL_LOOKS_LIKE_RECEIPT');
  assert.equal(serialProblem('abc'), 'SERIAL_TOO_SHORT');
  assert.equal(serialProblem('X'.repeat(41)), 'SERIAL_TOO_LONG');
  assert.equal(serialProblem('03919D58/607841'), 'SERIAL_CHARS');
  assert.equal(serialProblem('   '), 'SERIAL_EMPTY');
  assert.equal(serialProblem('1234567890128'.slice(0, 12)), null, 'a 12-digit numeric serial is allowed');
});

test('GTIN check digits, EAN and model-code normalisation', () => {
  assert.equal(isValidGtin(EAN), true);
  assert.equal(isValidGtin('6977252425446'), false);
  assert.equal(isValidGtin('96385074'), true, 'EAN-8');
  assert.equal(normalizeEan(' 6977 2524 25445 '), EAN);
  assert.equal(normalizeEan(''), '');
  assert.equal(normalizeEan('123'), null);
  assert.equal(normalizeModelCode('MODEL: pf002-a+sa005'), 'PF002-A+SA005');
  assert.equal(looksLikeReceipt('https://levonis-iq.com/warranty/WR-2026-0905-001'), true);
});

// -------------------------------------------------------- classification

test('each of the owner\'s three values is recognised on its own', () => {
  assert.deepEqual(classifyCode({ text: SN, format: 'code_128' }), { kind: 'serial', value: SN });
  assert.deepEqual(classifyCode({ text: BOX, format: 'code_128' }), { kind: 'box_sn', value: BOX });
  assert.deepEqual(classifyCode({ text: EAN, format: 'ean_13' }), { kind: 'ean', value: EAN });
  assert.deepEqual(classifyCode({ text: EAN }), { kind: 'ean', value: EAN }, 'no format reported: the check digit decides');
  assert.deepEqual(classifyCode({ text: 'SN: 03919D580607841', format: 'qr_code' }), { kind: 'serial', value: SN });
  assert.equal(classifyCode({ text: 'WR-2026-0905-001', format: 'qr_code' }).kind, 'receipt');
  assert.equal(classifyCode({ text: '12', format: 'code_128' }).kind, 'unknown');
});

test('the label: whichever order the barcodes are read in, the product SN is the device', () => {
  const orders = [
    [EAN, BOX, SN],
    [BOX, SN, EAN],
    [SN, EAN, BOX],
  ];
  for (const o of orders) {
    assert.deepEqual(
      classifyLabel(o.map((text) => ({ text }))),
      { productSn: SN, boxSn: BOX, ean: EAN, receipt: null },
      o.join(' ')
    );
  }
  // Only the box and the EAN in view: no device serial is invented.
  assert.deepEqual(classifyLabel([{ text: BOX }, { text: EAN }]), { productSn: null, boxSn: BOX, ean: EAN, receipt: null });
  // Two serial-shaped codes and positions known: the TOP one is the device
  // (the owner's layout), the lower one is taken as the box.
  assert.deepEqual(classifyLabel([{ text: 'Z9ABCDEF1234', y: 400 }, { text: SN, y: 120 }]), {
    productSn: SN,
    boxSn: 'Z9ABCDEF1234',
    ean: null,
    receipt: null,
  });
  // Duplicates across ticks collapse.
  assert.equal(classifyLabel([{ text: SN }, { text: SN.toLowerCase() }]).productSn, SN);
});

// ------------------------------------------------------------ bulk parsing

test('bulk paste: one per line, CSV serial,model, a header that reorders, quotes, Arabic commas, defaults', () => {
  const { rows } = parseSerialList(
    ['ean;serial', `${EAN};${SN}`].join('\n'),
    { model_code: 'PF002-A+SA005', model_name: 'A1 Combo' }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].serial_norm, SN);
  assert.equal(rows[0].ean, EAN);
  assert.equal(rows[0].model_name, 'A1 Combo', 'the default fills a row with no model');
  const csv = parseSerialList(`${SN},"A1 Combo, UK"\n03919D580607842،A1 Mini\n\n  \n03919D580607843\t\tPF001`).rows;
  assert.deepEqual(
    csv.map((r) => [r.line, r.serial_norm, r.model_name, r.model_code]),
    [
      [1, SN, 'A1 Combo, UK', ''],
      [2, '03919D580607842', 'A1 Mini', ''],
      [5, '03919D580607843', '', 'PF001'],
    ],
    'blank lines skipped, line numbers kept'
  );
  const dup = parseSerialList(`${SN}\nnot valid!\n${SN.toLowerCase()}`).rows;
  assert.equal(dup[1].problem, 'SERIAL_CHARS');
  assert.equal(dup[2].duplicate_of, 1);
  const many = parseSerialList(Array.from({ length: BULK_MAX_LINES + 5 }, (_, i) => `SN${String(i).padStart(8, '0')}`).join('\n'));
  assert.equal(many.rows.length, BULK_MAX_LINES);
  assert.equal(many.too_many, true);
});

// ---------------------------------------------------------------- decode

function label(): Luma {
  // The owner's label, laid out as printed: the SN barcode wide across the
  // top, the box SN and the EAN side by side below.
  const img = blank(1100, 700);
  drawModules(img, code128Modules(SN), 60, 120, 4, 130);
  drawModules(img, code128Modules(BOX), 40, 400, 2, 120);
  drawModules(img, ean13Modules(EAN), 650, 400, 3, 120);
  return img;
}

test('a generated Code 128 of the owner\'s serial decodes through the scanner\'s reader in Node', () => {
  const img = blank(800, 200);
  drawModules(img, code128Modules(SN), 40, 40, 3, 120);
  const hit = decodeLuminance(img.data, img.width, img.height);
  assert.ok(hit, 'decoded');
  assert.equal(hit.text, SN);
  assert.equal(hit.format, 'code_128');
  const ean = blank(400, 160);
  drawModules(ean, ean13Modules(EAN), 40, 20, 3, 120);
  assert.deepEqual({ ...decodeLuminance(ean.data, ean.width, ean.height), y: 0 }, { text: EAN, format: 'ean_13', y: 0 });
  assert.equal(decodeLuminance(blank(300, 100).data, 300, 100), null, 'a blank frame reads nothing');
});

test('the whole label, read region by region as the scanner does, classifies to the owner\'s three values', () => {
  const img = label();
  const window = new CodeWindow(1400);
  LABEL_REGIONS.forEach((r, tick) => {
    const part = cropLuminance(img.data, img.width, img.height, r);
    const hit = decodeLuminance(part.data, part.width, part.height);
    if (hit) window.add([{ text: hit.text, format: hit.format, y: part.top + hit.y }], tick * 110);
  });
  const read = classifyLabel(window.recent(4 * 110));
  assert.deepEqual(read, { productSn: SN, boxSn: BOX, ean: EAN, receipt: null });
  // The full frame alone yields ONE code, and it is not the device: the reason
  // the scanner reads regions and classifies instead of taking the first hit.
  const whole = decodeLuminance(img.data, img.width, img.height);
  assert.ok(whole && whole.text !== SN, `the full-frame read was ${whole?.text}`);
});

test('the owner\'s own photo of the A1 Combo label (top of 11.jpg, 367 px wide) reads as its Product SN', () => {
  // A grayscale PGM of the label's top third — the MODEL and Product SN lines
  // and the SN barcode — gzip-compressed (tests/fixtures).
  const pgm = gunzipSync(readFileSync(join(ROOT, 'tests/fixtures/owner-label-a1-combo.pgm.gz')));
  const [, w, h] = Buffer.from(pgm).subarray(0, 20).toString('latin1').split(/\s+/).map(Number);
  const luma = new Uint8ClampedArray(pgm.subarray(pgm.length - w * h));
  const hits = LABEL_REGIONS.map((r) => {
    const part = cropLuminance(luma, w, h, r);
    const hit = decodeLuminance(part.data, part.width, part.height);
    return hit ? { text: hit.text, format: hit.format, y: part.top + hit.y } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x);
  assert.ok(hits.length > 0, 'the phone photo decodes');
  assert.equal(classifyLabel(hits).productSn, SN);
});

test('RGBA frames become luminance, and the code window forgets what left the frame', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  assert.deepEqual([...rgbaToLuminance(rgba, 3, 1)], [255, 0, 76]);
  const w = new CodeWindow(1000);
  w.add([{ text: SN }], 0);
  w.add([{ text: EAN }], 900);
  assert.deepEqual(w.recent(1500).map((c) => c.text), [EAN]);
  w.clear();
  assert.deepEqual(w.recent(1500), []);
});

// ------------------------------------------------------------- the chunks

test('the reader library is reachable only through the scanner\'s dynamic import', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const engine = read('src/components/scanner/decodeEngine.ts');
  assert.match(engine, /import\('\.\/zxingReader'\)/);
  assert.doesNotMatch(engine, /^import [^;]*from '\.\/zxingReader'/m, 'decodeEngine never imports the reader statically');
  for (const f of ['src/components/warranty/AddDevicePanel.tsx', 'src/components/adminWarranty/serialInventory/AddSerialsPanel.tsx']) {
    const src = read(f);
    assert.match(src, /React\.lazy\(\(\) => import\('\.\.\/(\.\.\/)?scanner\/BarcodeScanner'\)\)/, `${f} lazy-loads the scanner`);
    assert.doesNotMatch(src, /^import BarcodeScanner/m, `${f} has no static scanner import`);
  }
  // The camera is allowed for this origin only (it was `camera=()`, which
  // silently blocked every scanner in production).
  const policy = read('worker/lib/securityPolicy.ts');
  assert.match(policy, /camera=\(self\)/);
});
