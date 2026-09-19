/**
 * THE MAINS ARITHMETIC, PROVED RATHER THAN EYEBALLED
 * (worker/lib/powerAdvice.ts).
 *
 * The module is pure, so every number it emits can be checked against one a
 * human worked out on paper — and it has to be, because this is the one
 * feature in the shop where being wrong costs the customer money. Someone who
 * buys a 1 kVA UPS on a sizing we got wrong loses a ten-hour print and does
 * not come back.
 *
 * The first block is the ZERO rule and it is first on purpose: a printer
 * nobody entered watts for must read as UNKNOWN. A 0 W reading sizes a UPS at
 * nothing and hands the customer a confident answer built out of an empty
 * form — the same defect compareSpecs.ts calls D1, in the one place where it
 * ends in a burnt print rather than a mislabelled table cell.
 *
 * The field ids are asserted against the REAL template definitions rather than
 * a fixture, so a field renamed in templateFamilies.ts fails here instead of
 * silently turning every printer's power advice into "unknown".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ampsFromWatts,
  advise,
  adviseFromSpecs,
  powerInputFromSpecs,
  roundUpToStandardKva,
  vaFromWatts,
  ASSUMED_INPUT_POWER_FACTOR,
  BATTERY_DEPTH_OF_DISCHARGE_MAX,
  BATTERY_DEPTH_OF_DISCHARGE_MIN,
  INVERTER_EFFICIENCY,
  IRAQ_MAINS_HZ,
  IRAQ_MAINS_VOLTS,
  POWER_FIELD_IDS,
  STANDARD_UPS_KVA,
  UPS_BATTERY_WH_PER_KVA_MAX,
  UPS_BATTERY_WH_PER_KVA_MIN,
  UPS_OUTPUT_POWER_FACTOR,
  UPS_LOAD_HEADROOM,
  PLAUSIBLE_WATTS_MAX,
  carries,
  recommendKva,
  type PowerAdvice,
  type Trilingual,
} from '../worker/lib/powerAdvice';
import { allTemplateGroups, groupsForType } from '../worker/lib/templateFamilies';

// ------------------------------------------------------------------ helpers

const close = (actual: number, expected: number, tolerance = 1e-6): void => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} (±${tolerance}), got ${actual}`
  );
};

const point = (advice: PowerAdvice, id: string): Trilingual => {
  const found = advice.points.find((p) => p.id === id);
  assert.ok(found, `point "${id}" missing — points present: ${advice.points.map((p) => p.id).join(', ')}`);
  return (found as { text: Trilingual }).text;
};

/** Every trilingual string in one advice object, with a path to name it. */
function everyLabel(advice: PowerAdvice): Array<[string, Trilingual]> {
  const out: Array<[string, Trilingual]> = [];
  for (const [key, reading] of Object.entries(advice.draw)) out.push([`draw.${key}`, reading.label]);
  for (const a of advice.assumptions) out.push([`assumption.${a.id}`, a.text]);
  for (const p of advice.topology.points) out.push([`topology.${p.id}`, p.text]);
  for (const p of advice.points) out.push([`point.${p.id}`, p.text]);
  return out;
}

// ---------------------------------------------------- A MISSING WATT IS NOT 0
//
// Written first, for the reason the header gives.

test('no wattage at all is UNKNOWN — never zero, and never a sizing', () => {
  const advice = advise({});
  assert.equal(advice.known, false);
  assert.equal(advice.draw.rated.known, false);
  assert.equal(advice.draw.rated.watts, null);
  assert.equal(advice.draw.rated.amps, null);
  assert.equal(advice.ups.known, false);
  assert.equal(advice.ups.va, null);
  assert.equal(advice.ups.kva, null);
  assert.equal(advice.ups.recommended_kva, null);
  assert.equal(advice.sizing_basis, null);
  assert.equal(advice.circuit.amps, null);
  assert.equal(advice.circuit.suggested_breaker_a, null);
  // NO POINTS AT ALL. A paragraph assembled out of «غير مذكور» reads as a
  // statement about the machine; it is a statement about our data entry.
  assert.deepEqual(advice.points, []);
  // And no size claims a runtime it cannot know.
  for (const r of advice.ups.runtimes) {
    assert.equal(r.fits, false);
    assert.equal(r.minutes_min, null);
    assert.equal(r.minutes_max, null);
  }
});

test('a 0 W or negative sheet value is a typo, not a measurement', () => {
  for (const bad of [0, -350, Number.NaN, Number.POSITIVE_INFINITY]) {
    const advice = advise({ rated_w: bad });
    assert.equal(advice.known, false, `${bad} must not become a sizing`);
    assert.equal(advice.ups.va, null);
  }
});

test('a sheet with only a bed wattage still refuses to size a UPS', () => {
  // The bed is a component figure, not the machine's draw. Sizing on it alone
  // would understate every printer that also has a hotend and motors.
  const advice = advise({ bed_w: 250 });
  assert.equal(advice.known, false);
  assert.equal(advice.draw.bed.known, true);
  assert.equal(advice.draw.bed.watts, 250);
  assert.deepEqual(advice.points, []);
});

// -------------------------------------------------------- AMPS, ON PAPER
//
// P = V × I × PF  ⟹  I = P / (V × PF). Checked against values computed by
// hand, not against the function's own output re-arranged.

test('amps are watts ÷ (volts × power factor) at the Iraqi 220 V', () => {
  assert.equal(IRAQ_MAINS_VOLTS, 220);
  assert.equal(IRAQ_MAINS_HZ, 50);
  // 350 / (220 × 0.9) = 1.7676… → 1.77
  close(ampsFromWatts(350, 0.9), 1.77);
  // 1000 / (220 × 1) = 4.5454… → 4.55
  close(ampsFromWatts(1000, 1), 4.55);
  // A poor supply pulls MORE current for the same watts: 350 / (220 × 0.6)
  // = 2.6515… → 2.65. Dropping the power factor would have said 1.59.
  close(ampsFromWatts(350, 0.6), 2.65);
});

test('the printer power factor is assumed when absent and SAID to be assumed', () => {
  const assumed = advise({ rated_w: 350 });
  close(assumed.draw.rated.amps as number, 1.77);
  const pf = assumed.assumptions.find((a) => a.id === 'input_power_factor');
  assert.ok(pf, 'the assumption is in the returned object, not only in a comment');
  assert.equal((pf as { value: string }).value, String(ASSUMED_INPUT_POWER_FACTOR));
  assert.match((pf as { text: Trilingual }).text.ar, /مفترض/);

  // Stated by the manufacturer: the machine's own figure, and the wording
  // stops calling it an assumption.
  const declared = advise({ rated_w: 350, power_factor: 0.95 });
  close(declared.draw.rated.amps as number, Number((350 / (220 * 0.95)).toFixed(2)));
  const stated = declared.assumptions.find((a) => a.id === 'input_power_factor');
  assert.equal((stated as { value: string }).value, '0.95');
  assert.doesNotMatch((stated as { text: Trilingual }).text.ar, /مفترض/);
});

test('a power factor of 90 means 90% and is refused rather than inferred', () => {
  // A ratio above 1 is not a power factor. Reading it literally would produce
  // 350 / (220 × 90) = 0.018 A — an answer wrong by two orders of magnitude.
  const advice = advise({ rated_w: 350, power_factor: 90 });
  close(advice.draw.rated.amps as number, 1.77);
  const pf = advice.assumptions.find((a) => a.id === 'input_power_factor');
  assert.equal((pf as { value: string }).value, String(ASSUMED_INPUT_POWER_FACTOR));
});

// ------------------------------------------------- VA, AND THE ROUNDING UP

test('VA is watts ÷ the UPS output power factor — a 1 kVA UPS is not 1000 W', () => {
  assert.equal(UPS_OUTPUT_POWER_FACTOR, 0.6);
  // 350 / 0.6 = 583.33 → 584 VA (ceil: a UPS is bought whole).
  assert.equal(vaFromWatts(350), 584);
  // 600 W is exactly what a 1 kVA unit delivers; one watt more is not.
  assert.equal(vaFromWatts(600), 1000);
  assert.equal(vaFromWatts(601), 1002);
});

test('kVA always rounds UP to a size the shop can actually sell', () => {
  assert.deepEqual([...STANDARD_UPS_KVA], [1, 2, 3]);
  assert.equal(roundUpToStandardKva(0.584), 1);
  assert.equal(roundUpToStandardKva(1), 1);
  // THE ONE THAT MATTERS: 1.01 kVA is a 2 kVA purchase, never a 1 kVA one.
  assert.equal(roundUpToStandardKva(1.01), 2);
  assert.equal(roundUpToStandardKva(2.5), 3);
  assert.equal(roundUpToStandardKva(3), 3);
  // Beyond the range is null, not a 3 — a 3 there would be a promise.
  assert.equal(roundUpToStandardKva(3.2), null);
});

test('a 350 W printer: 584 VA, 0.584 kVA, buy 1 kVA', () => {
  const advice = advise({ rated_w: 350, printing_w: 120 });
  assert.equal(advice.sizing_basis, 'rated');
  assert.equal(advice.ups.va, 584);
  close(advice.ups.kva as number, 0.584);
  assert.equal(advice.ups.recommended_kva, 1);
  assert.equal(advice.ups.above_range, false);
});

test('a machine bigger than 3 kVA says so instead of recommending a 3', () => {
  // 2000 W / 0.6 = 3334 VA — past the top of the range.
  const advice = advise({ rated_w: 2000 });
  assert.equal(advice.ups.va, 3334);
  assert.equal(advice.ups.recommended_kva, null);
  assert.equal(advice.ups.above_range, true);
  assert.match(point(advice, 'ups_size').ar, /3 kVA/);
});

// --------------------------------------------- SIZE ON PEAK, TIME ON AVERAGE

test('the UPS is sized on the rated watts and timed on the printing watts', () => {
  const advice = advise({ rated_w: 350, printing_w: 120 });
  assert.equal(advice.sizing_basis, 'rated');
  assert.equal(advice.runtime_basis, 'printing');

  // 1 kVA: usable Wh runs from 1×150×0.5×0.85 = 63.75 to 1×250×0.8×0.85 = 170.
  // At 120 W that is 63.75/120×60 = 31.87 → 31 minutes, and
  // 170/120×60 = 85 → 85 minutes.
  const one = advice.ups.runtimes.find((r) => r.kva === 1);
  assert.ok(one);
  assert.equal(one?.fits, true);
  assert.equal(one?.minutes_min, 31);
  assert.equal(one?.minutes_max, 85);

  // The maths scales with the size, so 3 kVA is three times the energy. WORKED
  // ON PAPER, not re-implemented from the same constants: 3 × 150 × 0.5 × 0.85
  // = 191.25 Wh and 3 × 250 × 0.8 × 0.85 = 510 Wh, which at 120 W is
  // 191.25/120 × 60 = 95.6 → 95 minutes and 510/120 × 60 = 255 minutes. An
  // assertion that rebuilds the formula out of the imported constants catches
  // a changed FORMULA and can never catch a changed CONSTANT, which is the
  // half of this that a customer would feel.
  const three = advice.ups.runtimes.find((r) => r.kva === 3);
  assert.equal(three?.minutes_min, 95);
  assert.equal(three?.minutes_max, 255);
});

test('with no rated figure both the sizing and the runtime fall back to the printing watts, and say so', () => {
  const advice = advise({ printing_w: 400 });
  assert.equal(advice.sizing_basis, 'printing');
  assert.equal(advice.runtime_basis, 'printing');
  const fallback = advice.assumptions.find((a) => a.id === 'sizing_fallback');
  assert.ok(fallback, 'the fallback is declared, not silent');

  const ratedOnly = advise({ rated_w: 400 });
  assert.equal(ratedOnly.sizing_basis, 'rated');
  assert.equal(ratedOnly.runtime_basis, 'rated');
  assert.equal(ratedOnly.assumptions.find((a) => a.id === 'sizing_fallback'), undefined);
});

test('runtime is a RANGE, never a single confident number', () => {
  const advice = advise({ rated_w: 350, printing_w: 120 });
  for (const r of advice.ups.runtimes) {
    assert.equal(r.fits, true);
    assert.ok((r.minutes_min as number) > 0);
    // A range with both ends equal is a single number wearing a dash.
    assert.ok(
      (r.minutes_max as number) > (r.minutes_min as number),
      `${r.kva} kVA reported ${r.minutes_min}–${r.minutes_max}`
    );
  }
  const text = point(advice, 'runtime');
  assert.match(text.ar, /–/);
  assert.match(text.en, /–/);
  assert.match(text.ckb, /–/);
  // And the caveat rides with it, in every language.
  const caveat = point(advice, 'runtime_caveat');
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(caveat[lang].trim().length > 20);
});

test('the runtime carries its assumptions in the OBJECT, not only in a comment', () => {
  const advice = advise({ rated_w: 350, printing_w: 120 });
  const ids = advice.assumptions.map((a) => a.id);
  for (const needed of ['mains_voltage', 'input_power_factor', 'ups_output_power_factor', 'battery_pack', 'battery_condition']) {
    assert.ok(ids.includes(needed), `assumption "${needed}" is not exposed to the UI`);
  }
  const pack = advice.assumptions.find((a) => a.id === 'battery_pack');
  assert.match((pack as { value: string }).value, new RegExp(`${UPS_BATTERY_WH_PER_KVA_MIN}.*${UPS_BATTERY_WH_PER_KVA_MAX}`));
});

test('the constants are what the runtime numbers above were worked out from', () => {
  /**
   * THE HALF A MIRRORED ASSERTION CANNOT CATCH.
   *
   * The runtime figures in this file (31/85 at 1 kVA, 95/255 at 3 kVA) are
   * worked out on paper from these six values, which is what makes them worth
   * anything: an assertion that rebuilds the module's own formula out of the
   * module's own imported constants catches a changed FORMULA and can never
   * catch a changed CONSTANT — and a changed constant is the half a customer
   * would feel, because it moves the minutes without moving the arithmetic.
   *
   * Pinning the constants HERE is what closes that. If the owner decides the
   * tower units he stocks are rated 0.8 rather than 0.6, this fails first and
   * by name, instead of the hand-computed runtimes failing three tests later
   * with no explanation of which number moved.
   */
  assert.equal(IRAQ_MAINS_VOLTS, 220, 'the conservative end of the Iraqi 220–230 V band');
  assert.equal(ASSUMED_INPUT_POWER_FACTOR, 0.9);
  assert.equal(UPS_OUTPUT_POWER_FACTOR, 0.6, 'a 1 kVA tower prints "600 W" — this IS the feature');
  assert.equal(UPS_LOAD_HEADROOM, 0.8, 'and it is never loaded past 80% of that');
  assert.equal(UPS_BATTERY_WH_PER_KVA_MIN, 150);
  assert.equal(UPS_BATTERY_WH_PER_KVA_MAX, 250);
  assert.equal(BATTERY_DEPTH_OF_DISCHARGE_MIN, 0.5);
  assert.equal(BATTERY_DEPTH_OF_DISCHARGE_MAX, 0.8);
  assert.equal(INVERTER_EFFICIENCY, 0.85);
});

test('a size that cannot carry the load reports no runtime at all', () => {
  // 900 W. A 1 kVA unit delivers 600 W, so it does not run this machine at
  // all — reporting "12 minutes" for it would be a promise it cannot keep.
  const advice = advise({ rated_w: 900, printing_w: 700 });
  const one = advice.ups.runtimes.find((r) => r.kva === 1);
  assert.equal(one?.fits, false);
  assert.equal(one?.minutes_min, null);
  assert.equal(one?.minutes_max, null);
  const two = advice.ups.runtimes.find((r) => r.kva === 2);
  assert.equal(two?.fits, true);
  assert.ok((two?.minutes_min as number) > 0);
  assert.equal(advice.ups.recommended_kva, 2);
});

// ---------------------------------------------------- ONLINE VS OFFLINE

test('online, offline and line-interactive are three things, and one is recommended', () => {
  const advice = advise({ rated_w: 350 });
  assert.equal(advice.topology.recommended, 'online');
  const ids = advice.topology.points.map((p) => p.id);
  assert.deepEqual(ids, ['ups_online', 'ups_offline', 'ups_line_interactive', 'ups_recommendation']);
  // The transfer gap is what online buys you, so it has to be stated.
  assert.match(point(advice, 'ups_line_interactive').en, /\d+–\d+\s?ms/);
  assert.match(point(advice, 'ups_line_interactive').ar, /مللي ثانية/);

  // AND LINE-INTERACTIVE IS NOT OFFLINE. Its AVR corrects the sag and the
  // surge WITHOUT going to battery, which is the whole reason it costs more
  // than a standby unit on a grid like ours. The two were once described with
  // one sentence that called both of them straight pass-through — which told
  // an Iraqi customer they are equivalent on the single axis where they differ
  // most, one point before a buying recommendation.
  assert.match(point(advice, 'ups_line_interactive').en, /AVR/);
  assert.match(point(advice, 'ups_line_interactive').ar, /AVR|منظّم جهد/);
  assert.match(point(advice, 'ups_line_interactive').ckb, /AVR/);
  assert.doesNotMatch(point(advice, 'ups_line_interactive').en, /passes the mains straight through/);

  // And every topology point is part of the ordered answer.
  for (const id of ids) assert.ok(advice.points.some((p) => p.id === id));
});

// ------------------------------------------------- SUPPLY, AND THE WARNINGS

test('the Iraqi 220–230 V band is an OVERLAP test, not an equality test', () => {
  assert.equal(advise({ rated_w: 350, voltage_text: '100-240' }).supply.accepts_iraq_mains, 'yes');
  assert.equal(advise({ rated_w: 350, voltage_text: '220' }).supply.accepts_iraq_mains, 'yes');
  // A 230 V-only unit is perfectly usable here; an equality test would reject it.
  assert.equal(advise({ rated_w: 350, voltage_text: '230' }).supply.accepts_iraq_mains, 'yes');
  assert.equal(advise({ rated_w: 350, voltage_text: '110' }).supply.accepts_iraq_mains, 'no');
  assert.equal(advise({ rated_w: 350, voltage_text: '' }).supply.accepts_iraq_mains, 'unknown');
});

test('50 Hz is checked because Iraq is 50 Hz, and a 60-only unit is flagged', () => {
  assert.equal(advise({ rated_w: 350, frequency_text: '50/60' }).supply.accepts_50hz, 'yes');
  assert.equal(advise({ rated_w: 350, frequency_text: '50' }).supply.accepts_50hz, 'yes');
  const sixty = advise({ rated_w: 350, frequency_text: '60' });
  assert.equal(sixty.supply.accepts_50hz, 'no');
  assert.ok(sixty.points.some((p) => p.id === 'frequency_warning'));
  assert.equal(advise({ rated_w: 350, frequency_text: '' }).supply.accepts_50hz, 'unknown');
  assert.ok(!advise({ rated_w: 350 }).points.some((p) => p.id === 'frequency_warning'));
});

test('a 110 V printer earns a warning point rather than a silent sizing', () => {
  const advice = advise({ rated_w: 350, voltage_text: '110' });
  const warning = point(advice, 'voltage_warning');
  assert.match(warning.ar, /110/);
  assert.match(warning.ar, /220/);
});

// --------------------------------------------------- THREE LANGUAGES, ALWAYS

test('every label, point and assumption carries ar, en AND ckb', () => {
  // A fully-populated sheet, so every optional point is present in the walk.
  const full = advise({
    rated_w: 350,
    printing_w: 120,
    bed_w: 250,
    standby_w: 12,
    voltage_text: '110',
    frequency_text: '60',
  });
  const labels = everyLabel(full);
  assert.ok(labels.length >= 15, `expected the whole answer, saw ${labels.length} strings`);
  for (const [path, label] of labels) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      assert.equal(typeof label[lang], 'string', `${path}.${lang} is not a string`);
      assert.ok(label[lang].trim() !== '', `${path} has no ${lang}`);
    }
    // Arabic that is really English is the failure this test exists to catch:
    // 'ckb' is RTL too, and a Kurdish reader served the English line is the
    // same defect as a Kurdish reader served the Arabic one.
    assert.notEqual(label.ar, label.en, `${path} serves English as Arabic`);
    assert.notEqual(label.ckb, label.en, `${path} serves English as Kurdish`);
    assert.notEqual(label.ckb, label.ar, `${path} serves Arabic as Kurdish`);
  }
});

// ------------------------------------------- THE BRIDGE FROM A STORED SHEET

test('every field id this module reads is still declared by the printer template', () => {
  const declared = new Set<string>();
  for (const g of allTemplateGroups()) for (const f of g.fields) declared.add(f.id);
  for (const [name, id] of Object.entries(POWER_FIELD_IDS)) {
    assert.ok(declared.has(id), `POWER_FIELD_IDS.${name} = "${id}" is not a template field`);
  }
  // And the printer type is the one that must ASK for them, or the owner has
  // no form to enter them on.
  const onPrinterForm = new Set<string>();
  for (const g of groupsForType('printer')) for (const f of g.fields) onPrinterForm.add(f.id);
  for (const id of Object.values(POWER_FIELD_IDS)) {
    assert.ok(onPrinterForm.has(id), `"${id}" is not on the printer template`);
  }
});

test('a stored spec sheet reads through to the same arithmetic', () => {
  const advice = adviseFromSpecs({
    rated_power: '350 W',
    typical_print_power: '120',
    heated_bed_power: '250 W',
    standby_power: '12',
    input_voltage: '100-240',
    input_frequency: '50/60',
    power_factor: '0.95',
  });
  assert.equal(advice.known, true);
  assert.equal(advice.draw.rated.watts, 350);
  assert.equal(advice.draw.printing.watts, 120);
  assert.equal(advice.draw.bed.watts, 250);
  assert.equal(advice.draw.standby.watts, 12);
  assert.equal(advice.supply.accepts_iraq_mains, 'yes');
  assert.equal(advice.supply.accepts_50hz, 'yes');
  assert.equal(advice.ups.recommended_kva, 1);
  assert.match(point(advice, 'bed').ar, /250/);
  assert.match(point(advice, 'standby').ar, /12/);
});

test('the legacy free-text «الطاقة» column stands in for a missing rated figure', () => {
  // Hundreds of products already carry a value there and nothing else.
  const input = powerInputFromSpecs({ power: '350 W' });
  assert.equal(input.rated_w, 350);
  // But the dedicated column wins when both are filled: it is the unambiguous
  // one, and `power` holds everything from "350" to "AC 100-240V 350W".
  assert.equal(powerInputFromSpecs({ power: '350 W', rated_power: '500' }).rated_w, 500);
  // An unreadable legacy value becomes unknown, not a guess.
  assert.equal(powerInputFromSpecs({ power: 'AC 100-240V 350W' }).rated_w, null);
  assert.equal(adviseFromSpecs({ power: 'AC 100-240V 350W' }).known, false);
});

test('an empty or malformed sheet is unknown, never zero', () => {
  for (const sheet of [null, undefined, {}, { rated_power: '' }, { rated_power: '   ' }, { rated_power: { nested: 1 } }]) {
    const advice = adviseFromSpecs(sheet as Record<string, unknown> | null | undefined);
    assert.equal(advice.known, false);
    assert.equal(advice.ups.recommended_kva, null);
    assert.deepEqual(advice.points, []);
  }
});

// ------------------------------------------------------------ the breaker

test('the suggested breaker derates the running current and rounds up', () => {
  // 350 W at PF 0.9 is 1.77 A; ×1.25 = 2.2 A → the smallest MCB, 6 A.
  assert.equal(advise({ rated_w: 350 }).circuit.suggested_breaker_a, 6);
  // 1500 W is 7.58 A; ×1.25 = 9.47 A → 10 A, not 6.
  const big = advise({ rated_w: 1500 });
  close(big.circuit.amps as number, 7.58);
  assert.equal(big.circuit.suggested_breaker_a, 10);
});


// ======================================================================
// THE FOUR THINGS A REVIEW CAUGHT, EACH PINNED SO IT CANNOT COME BACK
// ======================================================================

test('a UPS is never recommended at 100% of its rating — rounding up is not headroom', () => {
  // 600 W ÷ 0.6 = exactly 1000 VA, so the old rule «round the kVA up» landed
  // this machine on a 1 kVA box — at 100% of the 600 W that box delivers, with
  // nothing left for the surge when the bed and the hotend strike together.
  // A tower UPS held there alarms and drops the load within seconds, and the
  // customer loses the ten-hour print this file's header is written about.
  const advice = advise({ rated_w: 600, printing_w: 120 });
  assert.equal(advice.ups.va, 1000, 'the VA the LOAD needs is still honest arithmetic');
  assert.equal(advice.ups.recommended_kva, 2, 'and the box we tell him to buy has room above it');

  const one = advice.ups.runtimes.find((r) => r.kva === 1);
  assert.equal(one?.fits, false, '1 kVA delivers 600 W and this load IS 600 W');
  assert.equal(one?.minutes_min, null);

  // THE RECOMMENDATION AND THE RUNTIME TABLE ANSWER TO ONE PREDICATE. A size
  // marked `fits: false` that is also the recommended size is the shape of
  // this defect, so it is asserted directly rather than inferred.
  for (const advice2 of [advise({ rated_w: 480 }), advise({ rated_w: 481 }), advise({ rated_w: 960 }), advise({ rated_w: 961 })]) {
    const rec = advice2.ups.recommended_kva;
    if (rec === null) continue;
    assert.equal(advice2.ups.runtimes.find((r) => r.kva === rec)?.fits, true, `${rec} kVA was recommended and does not fit`);
  }

  // 80% of 600 W is 480 W: the last watt that still fits on a 1 kVA box.
  assert.equal(recommendKva(480), 1);
  assert.equal(recommendKva(481), 2);
  assert.equal(carries(1, 480), true);
  assert.equal(carries(1, 481), false);

  // And the rule is in the PAYLOAD, like every other constant in this module,
  // so the customer reads the rule and not only the result.
  const headroom = advice.assumptions.find((a) => a.id === 'ups_load_headroom');
  assert.ok(headroom, 'the headroom is not exposed to the UI');
  assert.match((headroom as { value: string }).value, new RegExp(String(UPS_LOAD_HEADROOM * 100)));
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok((headroom as { text: Trilingual }).text[lang].trim().length > 20);

  // Past 3 kVA is still «راجعنا», never a 3 — now at the derated boundary.
  assert.equal(recommendKva(1440), 3);
  assert.equal(recommendKva(1441), null);
  assert.equal(advise({ rated_w: 1441 }).ups.above_range, true);
});

test('a kilowatt figure is 1000 watts, not the bare number in front of the k', () => {
  // "0.35kW" is ordinary datasheet spelling, and compareSpecs' stripUnit knows
  // 'kw' as a unit token — so it used to strip the k and hand back 0.35. That
  // reached the customer as «تسحب 0.35 واط … حوالي 0 أمبير» and a runtime of
  // 10928–29143 MINUTES: seven to twenty days of backup quoted for a 350 W
  // printer. It arrives through the legacy free-text `power` column, which is
  // filled on hundreds of products, so it is reachable today.
  assert.equal(powerInputFromSpecs({ power: '0.35kW' }).rated_w, 350);
  assert.equal(powerInputFromSpecs({ power: '0.35 kW' }).rated_w, 350);
  assert.equal(powerInputFromSpecs({ rated_power: '1.2kw' }).rated_w, 1200);
  assert.equal(powerInputFromSpecs({ rated_power: '350W' }).rated_w, 350, 'plain watts still read as watts');

  const advice = adviseFromSpecs({ power: '0.35kW' });
  assert.equal(advice.draw.rated.watts, 350);
  assert.equal(advice.ups.va, 584);
  const one = advice.ups.runtimes.find((r) => r.kva === 1);
  assert.ok((one?.minutes_max as number) < 600, 'no printer is backed up for ten hours by a 1 kVA tower');
});

test('a wattage no printer can have is UNKNOWN, not a reading', () => {
  // The fence behind the kilowatt fix: whatever slipped — a unit, a decimal
  // point, a digit — a figure outside what a machine can draw is our data
  // entry talking, and this module says unknown out loud rather than sizing.
  assert.equal(powerInputFromSpecs({ rated_power: '0.35' }).rated_w, null);
  assert.equal(powerInputFromSpecs({ rated_power: '4' }).rated_w, null);
  assert.equal(powerInputFromSpecs({ rated_power: '5' }).rated_w, 5, 'the floor itself still reads');
  assert.equal(powerInputFromSpecs({ rated_power: String(PLAUSIBLE_WATTS_MAX + 1) }).rated_w, null);
  assert.equal(adviseFromSpecs({ rated_power: '0.35' }).known, false);

  // STANDBY IS HELD TO A LOWER FLOOR, because a machine asleep really can sit
  // at 2 W and holding it to the heaters' floor would throw a true reading away.
  assert.equal(powerInputFromSpecs({ standby_power: '2' }).standby_w, 2);
});

test('a power factor we REFUSED is never reported as one the manufacturer stated', () => {
  // The «someone typed 90 for 90%» case. The value is correctly refused — read
  // literally it would give 0.018 A, wrong by two orders of magnitude on the
  // figure a customer sizes a cable from — but the sentence beside the fallback
  // used to still say «كما ذكرته الشركة» / "as stated by the manufacturer".
  // The shop would be attributing to the manufacturer a number it invented.
  const refused = advise({ rated_w: 350, power_factor: 90 });
  const pfNote = refused.assumptions.find((a) => a.id === 'input_power_factor');
  assert.ok(pfNote);
  assert.match((pfNote as { text: Trilingual }).text.ar, /مفترض/);
  assert.match((pfNote as { text: Trilingual }).text.en, /ASSUMED/);
  assert.doesNotMatch((pfNote as { text: Trilingual }).text.en, /as stated by the manufacturer/);
  assert.equal((pfNote as { value: string }).value, String(ASSUMED_INPUT_POWER_FACTOR));

  // And the refused figure is NAMED, so it gets corrected rather than retyped.
  const rejected = refused.assumptions.find((a) => a.id === 'input_power_factor_refused');
  assert.ok(rejected, 'the rejected value is swallowed instead of reported');
  assert.equal((rejected as { value: string }).value, '90');
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.match((rejected as { text: Trilingual }).text[lang], /90/);

  // A REAL stated power factor is still credited to the manufacturer.
  const stated = advise({ rated_w: 350, power_factor: 0.95 });
  const statedNote = stated.assumptions.find((a) => a.id === 'input_power_factor');
  assert.match((statedNote as { text: Trilingual }).text.en, /as stated by the manufacturer/);
  assert.equal(stated.assumptions.find((a) => a.id === 'input_power_factor_refused'), undefined);
});

test('the breaker ships as a sentence, because an MCB size is a fire-safety claim', () => {
  // `circuit.suggested_breaker_a` goes out on GET /api/compare, and whoever
  // builds the storefront block will render «6 A» as shop advice. The framing
  // that makes that defensible — a starting point for an electrician, not an
  // installation design — used to exist only in a TypeScript comment the
  // customer cannot read.
  const advice = advise({ rated_w: 350 });
  assert.equal(advice.circuit.suggested_breaker_a, 6);
  const breaker = advice.points.find((p) => p.id === 'breaker');
  assert.ok(breaker, 'the breaker number ships with no sentence beside it');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.match(breaker.text[lang], /6/, `the ${lang} sentence does not carry the figure`);
    assert.ok(breaker.text[lang].trim().length > 40, `the ${lang} sentence carries no caveat`);
  }
  assert.match(breaker.text.ar, /كهربائي/);
  assert.match(breaker.text.en, /not an installation design/);

  // No wattage, no breaker and no sentence about one.
  assert.equal(advise({}).points.find((p) => p.id === 'breaker'), undefined);
});
