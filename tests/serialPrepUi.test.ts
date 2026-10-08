/**
 * THE SERIAL SCAN'S SCREENS (owner brief 2026-10-07; spec §5 + critiques).
 *
 * There is no DOM runner in this repository (tests/adminUserModal.test.ts
 * header), so the screens are pinned two ways: the pure helpers they rest on
 * are run (the keyboard-wedge reader, the owner-exception map, the box-SN
 * guard), and the source carries the behaviour the brief asks for — the one
 * camera scanner, lazy; its sound deferred to the server's verdict; the one
 * control for camera, reader and typing; the Sorani that is really Sorani.
 *
 * Run: node --import tsx --test tests/serialPrepUi.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WedgeTracker,
  charFromCode,
  isScannerBurst,
  isTerminator,
  medianGap,
  textFromStrokes,
  type KeyStroke,
} from '../src/components/adminOrders/serials/wedge';
import { SERIAL_STRINGS } from '../src/components/adminOrders/serials/strings';
import { SCANNER_STRINGS } from '../src/components/scanner/strings';
import { looksLikeBoxSn, overrideFor, serialRefusal } from '../src/components/adminOrders/serials/serialsApi';
import { gateRefusalOf } from '../src/components/adminOrders/serials/SerialGateRefusal';
import { withSlot } from '../src/components/adminOrders/serials/UnitSerialSlots';
import { eventLabel } from '../src/components/adminWarranty/serial/SerialDetail';
import { ApiError } from '../src/lib/api';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ------------------------------------------------------------ the wedge (§4)

/** Keystrokes `gap` ms apart, typed through a layout that maps each key. */
function strokes(text: string, gap: number, layout: (ch: string) => string = (c) => c): KeyStroke[] {
  return [...text].map((ch, i) => ({
    code: /\d/.test(ch) ? `Digit${ch}` : /[A-Z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch === '-' ? 'Minus' : 'Space',
    key: layout(ch),
    shift: false,
    t: 1000 + i * gap,
  }));
}

test('a reader is a burst; a person typing is not', () => {
  assert.equal(isScannerBurst(strokes('03919D580607841', 8).map((s) => s.t)), true, 'a USB reader at ~8 ms a key');
  assert.equal(isScannerBurst(strokes('03919D580607841', 30).map((s) => s.t)), true, 'a Bluetooth reader at ~30 ms');
  assert.equal(isScannerBurst(strokes('03919D580607841', 140).map((s) => s.t)), false, 'a person at ~140 ms');
  assert.equal(isScannerBurst(strokes('0391', 5).map((s) => s.t)), false, 'too short to be a serial read');
  assert.equal(medianGap([5]), Infinity);
  assert.equal(medianGap([0, 10, 20, 100]), 10);
});

test('Enter always ends a read; Tab only inside a burst (a reader that sends Tab)', () => {
  assert.equal(isTerminator('Enter', false), true);
  assert.equal(isTerminator('NumpadEnter', false), true);
  assert.equal(isTerminator('Tab', true), true);
  assert.equal(isTerminator('Tab', false), false, 'a person tabbing on moves focus as usual');
});

test('physical keys, not the layout: a reader on an Arabic keyboard still sends the serial (critique-2 M12)', () => {
  assert.equal(charFromCode('KeyD'), 'D');
  assert.equal(charFromCode('Digit3'), '3');
  assert.equal(charFromCode('Numpad7'), '7');
  assert.equal(charFromCode('Minus'), '-');
  assert.equal(charFromCode('ShiftLeft'), null);
  // On the Arabic layout D types «ي»: the characters are wrong, the keys are not.
  const arabic: Record<string, string> = { D: 'ي', B: 'لا' };
  const keys = strokes('03919D580607841', 9, (ch) => arabic[ch] ?? ch);
  assert.equal(textFromStrokes(keys), '03919D580607841');

  const t = new WedgeTracker();
  for (const k of keys) t.push({ code: k.code, key: k.key, shiftKey: false, timeStamp: k.t });
  assert.equal(t.inBurst, true);
  assert.deepEqual(t.finish('03919ي580607841'), { text: '03919D580607841', source: 'scanner' });
});

test('a person keeps exactly what they typed, and editing makes it a person', () => {
  const t = new WedgeTracker();
  for (const k of strokes('ABC123456', 150)) t.push({ code: k.code, key: k.key, shiftKey: false, timeStamp: k.t });
  assert.deepEqual(t.finish(' abc123456 '), { text: 'abc123456', source: 'manual' });

  const fast = new WedgeTracker();
  for (const k of strokes('ABC123456', 5)) fast.push({ code: k.code, key: k.key, shiftKey: false, timeStamp: k.t });
  fast.push({ code: 'Backspace', key: 'Backspace', shiftKey: false, timeStamp: 2000 });
  assert.equal(fast.finish('ABC12345').source, 'manual', 'a correction by hand is not a reader');

  const pasted = new WedgeTracker();
  assert.deepEqual(pasted.finish('B07119G5811000AB'), { text: 'B07119G5811000AB', source: 'manual' });
});

// --------------------------------------------------------- H1: the box SN

test('no auto-advance after a BOX SN — the device serial of that box comes next (critique-2 H1)', () => {
  assert.equal(looksLikeBoxSn('B07119G5811000AB'), true);
  assert.equal(looksLikeBoxSn('SN B07119G5811000AB'), true, 'the whitespace prefix is stripped first');
  assert.equal(looksLikeBoxSn('03919D580607841'), false);
  assert.equal(looksLikeBoxSn('6975337035185'), false, 'an EAN is not a box SN (the server refuses it outright)');
  const slots = read('src/components/adminOrders/serials/UnitSerialSlots.tsx');
  assert.match(slots, /source !== 'relink' && !looksLikeBoxSn\(text\) \? nextEmpty\(key\) : null/, 'focus moves on only when the value is not a box SN');
});

// ------------------------------------------------- owner exceptions (§11)

test('each refusal maps to the one owner exception that answers it, or to none', () => {
  const e = (code: string, details: Record<string, unknown> = {}) => new ApiError(409, 'x', code, details);
  assert.equal(overrideFor(e('SERIAL_IN_USE')), 'take_from_order');
  assert.equal(overrideFor(e('SERIAL_DELIVERED')), 'delivered_device');
  assert.equal(overrideFor(e('SERIAL_NOT_AVAILABLE', { reason: 'unsellable' })), 'unavailable');
  assert.equal(overrideFor(e('SERIAL_NOT_AVAILABLE', { reason: 'void' })), null, 'a voided device is restored first');
  assert.equal(overrideFor(e('ORDER_NOT_PREPARABLE', { status: 'processing' })), 'outside_window');
  assert.equal(overrideFor(e('ORDER_NOT_PREPARABLE', { status: 'delivered' })), null);
  assert.equal(overrideFor(e('SERIAL_BATCH_MISMATCH')), 'batch');
  assert.equal(overrideFor(e('SERIAL_MODEL_MISMATCH')), 'model_family');
  assert.equal(overrideFor(e('SERIAL_PRODUCT_MISMATCH')), null, 'a product mismatch has no exception');
  assert.equal(overrideFor(new Error('offline')), null);
});

test('a refusal reads in the reader\'s language with the detail that helps (§10, §11, §18)', () => {
  const e = (code: string, details: Record<string, unknown> = {}) => new ApiError(409, 'server sentence', code, details);
  const twice = serialRefusal(e('SERIAL_IN_USE_THIS_ORDER', { order_item_id: 'oi1', unit_index: 2 }), 'ar');
  assert.equal(twice.text, REFUSAL_STRINGS.SERIAL_IN_USE_THIS_ORDER.ar);
  assert.equal(twice.detail, SERIAL_STRINGS.ar.inUseHere(2), 'which unit of this order already holds it');
  assert.equal(serialRefusal(e('SERIAL_DELIVERED', { active_warranty: true }), 'ar').text, 'هذا الجهاز تم تسليمه مسبقاً ومربوط بضمان فعال.', '§11 when the warranty is live');
  assert.equal(serialRefusal(e('SERIAL_DELIVERED', { active_warranty: false }), 'ar').text, 'هذا الجهاز تم تسليمه مسبقاً.', '§31 otherwise');
  assert.equal(serialRefusal(e('SERIAL_INVALID', { problem: 'BOX_ONLY' }), 'ckb').detail, SERIAL_STRINGS.ckb.problems.BOX_ONLY);
  assert.equal(serialRefusal(new Error('offline'), 'en').text, SERIAL_STRINGS.en.failed, 'never a stack trace or a raw error (§31)');
});

test('before delivery the serial page says the warranty starts AT delivery, not «none» (§7, §8)', () => {
  const page = read('src/components/adminWarranty/serial/SerialDetail.tsx');
  assert.match(page, /const pending = warrantyState === 'PENDING_DELIVERY'/);
  assert.match(page, /pending \? s\.atDelivery/);
});

test('a link patched in place keeps the counts honest', () => {
  const base = {
    installed: true,
    window: true,
    gate: { enabled: true, applies: true, since: null },
    required: 2,
    linked: 0,
    slots: [1, 2].map((n) => ({ order_item_id: 'oi1', unit_index: n, part: 'device', product_name: 'A1 Combo', variant_label: null, assignment: null, previous: null, flags: [] })),
    missing: [],
  };
  const a = { id: 'sa1', serial_display: '03919D580607841', linked_at: '', linked_by: '', source: 'camera', lot: null, lot_source: null, warranty: { state: 'PENDING_DELIVERY' as const, mode: 'new', carries_until: null }, override_kind: null };
  const next = withSlot(base, { order_item_id: 'oi1', unit_index: 1 }, a);
  assert.equal(next.linked, 1);
  assert.deepEqual(next.missing?.map((m) => m.unit_index), [2]);
  assert.equal(withSlot(next, { order_item_id: 'oi1', unit_index: 1 }, null).linked, 0);
});

// ------------------------------------------- the camera sheet (§3, §22)

test('the sheet reuses THE scanner, lazily, in single mode, and sounds the server\'s verdict', () => {
  const sheet = read('src/components/adminOrders/serials/SerialScanSheet.tsx');
  assert.match(sheet, /React\.lazy\(\(\) => import\('\.\.\/\.\.\/scanner\/BarcodeScanner'\)\)/);
  assert.doesNotMatch(sheet, /^import BarcodeScanner/m);
  assert.match(sheet, /mode="single"/);
  assert.match(sheet, /\bdeferFeedback\b/);
  assert.match(sheet, /\bwaitForCompanions\b/, 'waits for the label\'s EAN and BOX SN (critique-2 L2)');
  // A real bottom sheet, never a page: the grabber it shows is a gesture it
  // has (pulled down by its header), and the camera below scrolls and taps.
  assert.match(sheet, /<Sheet[\s\S]{0,120}detents=\{\['large'\]\}[\s\S]{0,40}header=\{header\}/);
  assert.doesNotMatch(sheet, /h-1 w-9 rounded-full/, 'no drawn grabber without the drag behind it');
  assert.match(read('src/components/adminWarranty/serial/SerialDetail.tsx'), /<Sheet[\s\S]{0,120}detents=\{\['large'\]\}/);
  assert.match(sheet, /scanFeedback\('added'\)/, 'the success chime and the light tap ride the answer');
  assert.match(sheet, /newOpId\(\)/, 'one operation id per read (§24)');
  assert.match(sheet, /existingLine1[\s\S]*existingLine2/, '§13: «موجود مسبقاً» and «تم ربطه الآن» as two lines');

  const scanner = read('src/components/scanner/BarcodeScanner.tsx');
  assert.match(scanner, /if \(!deferFeedback\) scanFeedback\('captured'\)/, 'no cheerful sound before a refusal');
  // The scanner is lazy, so its typed field mounts after the sheet: the wedge
  // reader is attached by a callback ref, never by an effect that ran too early.
  assert.match(sheet, /manualInputRef=\{setManualField\}/);
  assert.match(sheet, /el\.addEventListener\('keydown', onKey\)/);
  // A new opening never inherits the last success's close timer.
  assert.match(sheet, /if \(!openKey\) return;\s*if \(closeTimer\.current != null\)/);
});

test('one control for camera, reader and typing — a real form in every empty slot (§4, critique-1 #14)', () => {
  const slots = read('src/components/adminOrders/serials/UnitSerialSlots.tsx');
  assert.match(slots, /<form[\s\S]{0,200}data-serial-form/);
  assert.match(slots, /enterKeyHint="done"/);
  assert.match(slots, /autoCapitalize="characters"/);
  assert.match(slots, /data-serial-camera/);
  assert.match(slots, /primeScannerAudio\(\)/, 'the tap that opens the camera unlocks sound on iOS');
  assert.doesNotMatch(slots, /pointer: coarse/, 'no camera-only slot on touch screens');
  assert.match(slots, /rounded-full/, 'the capsule');
  assert.match(slots, /m\.reduced \? 1 : 0\.85/, 'the check scales in — and does not under reduced motion');
});

test('before delivery the per-device section IS the scan (critique-1 #26), and the 4-character floor is gone', () => {
  const section = read('src/components/adminWarranty/WarrantySection.tsx');
  assert.match(section, /<UnitSerialSlots/);
  assert.match(section, /orderStatus !== 'delivered'/);
  assert.doesNotMatch(section, /serial\.length < 4/);
  assert.match(section, /serialProblem\(serial\)/);
  const modal = read('src/components/adminOrders/OrderDetailModal.tsx');
  assert.match(modal, /<SerialsBlockerCard serials=\{serials\} onGoTo=\{goToSerial\} \/>/);
  assert.match(modal, /serials=\{serials\}[\s\S]{0,200}onSerialsChanged=\{setSerials\}/);
  assert.match(modal, /viewerOwner=\{viewerOwner\}/);
});

test('the stage panel turns SERIALS_REQUIRED into the missing units, and the owner\'s way past it', () => {
  const e = new ApiError(409, 'تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.', 'SERIALS_REQUIRED', {
    missing: [{ order_item_id: 'oi1', unit_index: 2, part: 'device', product_name: 'A1 Combo' }],
    lot_conflicts: [],
  });
  assert.deepEqual(gateRefusalOf(e), { missing: [{ order_item_id: 'oi1', unit_index: 2, part: 'device', product_name: 'A1 Combo' }], lotConflicts: 0 });
  assert.equal(gateRefusalOf(new ApiError(409, 'x', 'ORDER_NOT_PREPARABLE')), null);
  const refusal = read('src/components/adminOrders/serials/SerialGateRefusal.tsx');
  assert.match(refusal, /viewerOwner && \(/, 'the reason field is the owner\'s alone');
  assert.match(refusal, /refusalText\('SERIALS_REQUIRED'/, '§19 in the reader\'s language');
  // Both doors the gate guards in this screen draw the same refusal and pass the reason on.
  for (const door of ['src/components/adminOrders/OrderStagePanel.tsx', 'src/components/adminOrders/OrderStatusCorrection.tsx']) {
    const src = read(door);
    assert.match(src, /gateRefusalOf\(e\)/, door);
    assert.match(src, /<SerialGateRefusal/, door);
    assert.match(src, /serials_override_reason/, door);
  }
  assert.match(read('src/components/adminOrders/OrderStagePanel.tsx'), /label_ckb/, 'stage names in Sorani (spec §5.8)');
});

// ------------------------------------------------------ the words (§31)

test('every serial-scan line exists in all three languages, and the Sorani is Sorani', () => {
  const { ar, en, ckb } = SERIAL_STRINGS;
  const sample = (v: unknown): string[] => {
    if (typeof v === 'string') return [v];
    if (typeof v === 'function') return [String((v as (...a: unknown[]) => unknown)('X', 2))];
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap(sample);
    return [];
  };
  const keys = Object.keys(ar) as Array<keyof typeof ar>;
  assert.deepEqual(Object.keys(en).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(ckb).sort(), [...keys].sort());
  for (const k of keys) {
    const a = sample(ar[k]);
    const c = sample(ckb[k]);
    const e = sample(en[k]);
    assert.equal(c.length, a.length, `ckb.${String(k)} has every entry`);
    c.forEach((line, i) => {
      if (line === 'SKU' || line === '—') return;
      assert.notEqual(line, a[i], `ckb.${String(k)} copies the Arabic: «${line}»`);
      assert.notEqual(line, e[i], `ckb.${String(k)} copies the English: «${line}»`);
    });
  }
  // The brief's own Arabic, where the screen says it itself (§31, §11, §13).
  assert.equal(ar.linkedLine, 'تم ربط الرقم التسلسلي بالطلب.');
  assert.equal(ar.deliveredActive, 'هذا الجهاز تم تسليمه مسبقاً ومربوط بضمان فعال.');
  assert.equal(ar.existingLine1, 'الرقم التسلسلي موجود مسبقاً');
  assert.equal(ar.existingLine2, 'تم ربطه الآن بهذا الطلب');
  // …and the refusals the screen localises by code carry the brief's sentences.
  assert.equal(REFUSAL_STRINGS.SERIALS_REQUIRED.ar, 'تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.');
  assert.equal(REFUSAL_STRINGS.SERIAL_IN_USE.ar, 'هذا الرقم التسلسلي مرتبط بطلب آخر.');
  assert.equal(REFUSAL_STRINGS.SERIAL_PRODUCT_MISMATCH.ar, 'الرقم التسلسلي لا يطابق هذا المنتج.');
});

test('the scanner\'s Sorani is complete — no line spreads the Arabic any more (spec §5.8, DECISIONS row 183)', () => {
  const { ar, en, ckb } = SCANNER_STRINGS;
  assert.deepEqual(Object.keys(ckb).sort(), Object.keys(ar).sort());
  for (const k of Object.keys(ar) as Array<keyof typeof ar>) {
    assert.notEqual(ckb[k], ar[k], `scanner ckb.${k} is the Arabic`);
    assert.notEqual(ckb[k], en[k], `scanner ckb.${k} is the English`);
  }
  assert.doesNotMatch(read('src/components/scanner/strings.ts'), /\.\.\.ar\b/);
});

test('the serial page names every history event in words, never the action id', () => {
  const s = SERIAL_STRINGS.ar;
  const ev = (action: string, detail: Record<string, unknown> = {}) => ({ id: 1, action, created_at: '2026-10-07T10:00:00Z', actor: null, detail });
  assert.equal(eventLabel(ev('serial_inventory.add'), s), s.action.added);
  assert.equal(eventLabel(ev('serial_inventory.add', { source: 'prep_scan' }), s), s.action.firstScan);
  assert.equal(eventLabel(ev('serial.linked', { order_id: 'ORD-111' }), s), 'رُبط بالطلب ORD-111');
  assert.equal(eventLabel(ev('serial.linked', { order_id: null }), s), 'رُبط بطلب', 'an assistant sees no order number');
  assert.match(eventLabel(ev('serial.released', { reason: 'order_cancelled', order_id: 'ORD-111' }), s), /أُلغي الطلب ORD-111 · أُعيد إلى المخزون/);
  assert.equal(eventLabel(ev('serial.warranty_activated'), s), `${s.action.delivered} · ${s.action.activated}`);
  assert.equal(eventLabel(ev('serial.override', { reason: 'زبون بدّل' }), s), 'استثناء المالك: زبون بدّل');
  for (const action of ['serial.unlinked', 'serial.returned', 'device.unit_replace', 'warranty.voided']) {
    assert.doesNotMatch(eventLabel(ev(action), s), /^[a-z_.]+$/, `${action} reads as words`);
  }
});

test('owner-only controls draw locked for everyone else; the server re-checks', () => {
  const productForm = read('src/components/adminProducts/form/WarrantySection.tsx');
  assert.match(productForm, /disabled=\{!canEditSerial\}/);
  assert.match(productForm, /data-form="serial-tracking"/);
  const sections = read('src/components/adminTaxonomy/SectionsTab.tsx');
  assert.match(sections, /\/serial-policy`/);
  assert.match(sections, /disabled=\{!owner\}/);
  const gate = read('src/components/adminWarranty/serial/SerialGateCard.tsx');
  assert.match(gate, /\/api\/admin\/settings\/serialPrepGate/);
  assert.match(gate, /disabled=\{!owner\}/);
  const types = read('worker/lib/types.ts');
  assert.match(types, /is_owner:/, 'the session says whether THIS account is the owner — a hint, never the address');
});

test('a closed warranty (return, cancelled sale) has its own words on the units view', () => {
  const units = read('src/components/AdminSerials.tsx');
  assert.match(units, /'not_delivered' \| 'closed'/);
  assert.match(units, /st === 'closed'\s*\?\s*s\.stClosed/);
  for (const lang of ['ar', 'en', 'ckb']) assert.match(units, new RegExp(`${lang}: \\{[\\s\\S]*?stClosed: '`), lang);
});

test('no theme-specific colour and no dark: variant in the new screens', () => {
  for (const f of [
    'src/components/adminOrders/serials/UnitSerialSlots.tsx',
    'src/components/adminOrders/serials/SerialScanSheet.tsx',
    'src/components/adminOrders/serials/SerialsBlockerCard.tsx',
    'src/components/adminOrders/serials/SerialGateRefusal.tsx',
    'src/components/adminWarranty/serial/SerialDetail.tsx',
    'src/components/adminWarranty/serial/SerialGateCard.tsx',
  ]) {
    const src = read(f);
    assert.doesNotMatch(src, /\b(?:bg|text|border)-\[#/, `${f}: a hex colour`);
    assert.doesNotMatch(src, /\bdark:/, `${f}: a dark: variant`);
    assert.doesNotMatch(src, /\b(?:left|right)-\d|\b[mp][lr]-\d/, `${f}: a physical side instead of start/end`);
  }
});
