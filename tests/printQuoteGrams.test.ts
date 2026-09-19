/**
 * «مئة غرام من فيلمنت معين بلون واحد أو أكثر» — pricing a print by WEIGHT.
 *
 * The owner's request is small to describe and easy to get wrong: a customer
 * who already knows they need 100 g of a particular filament should be able to
 * ask what it costs without producing a model file. What makes it dangerous is
 * that a weight is a tempting thing to price on its own — grams × a rate is one
 * line of code — and the moment that line exists the shop has TWO prices for
 * the same job: the one the calculator showed and the one the engine charges.
 *
 * So these tests are mostly about sameness rather than about arithmetic:
 *
 *   1. the same material and the same mass produce the SAME price down to the
 *      dinar, whether it arrived as a sliced file or as a number in a box;
 *   2. several colour rows are summed rather than counted, dropped or averaged;
 *   3. a zero or negative gram count is refused with a message and a code, not
 *      quietly priced as the minimum job;
 *   4. the owner's configured floor applies, and it comes from the settings row
 *      the admin edits rather than from a constant in the route;
 *   5. the response states what the price covers — because a grams quote with
 *      no stated print time genuinely cannot include machine hours, and one
 *      that hid that would be understating the job by half.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, post, row, stubApp, type App } from './fixtures/app';
import { printQuoteRoutes, analysisFromGrams, type GramsRow } from '../worker/routes/printQuote';
import type { PrinterModel } from '../worker/lib/printQuote/printers';
import type { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';

const mount = (a: Hono<AppContext>) => a.route('/api/print-quote', printQuoteRoutes);
type Raw = ReturnType<typeof freshDb>;

/** A real binary STL of a 20 mm cube — enough for the classifier to accept an
 *  upload, which is the only thing the file half of these tests needs it for.
 *  The measurement itself comes from the slicer-stats route, not from the mesh. */
function stlBytes(): Uint8Array {
  const S = 20;
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0],
    [0, 0, S], [S, 0, S], [S, S, S], [0, S, S],
  ];
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    o += 12;
    for (const i of [a, b, c]) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };

/**
 * A SHOP THAT HAS ACTUALLY FILLED IN ITS NUMBERS.
 *
 * 0078 seeds densities and build volumes but deliberately no filament price, no
 * purchase price, no maintenance rate and no wattage (§53: nothing invented).
 * A fresh database therefore answers `insufficient` to every quote, and — the
 * subtler trap — prices machine time at exactly zero, because a NULL wattage is
 * read as 0 W and a NULL purchase price as 0 depreciation. A test that skipped
 * this would "prove" that an hour of machine time costs nothing, which is the
 * opposite of what these tests are for. So the shop is costed first, with
 * ordinary Iraqi-market figures, and every assertion below is about a machine
 * whose hours have a price.
 */
function shopWithPricedPla(): { raw: Raw; app: App } {
  const raw = freshDb();
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  raw
    .prepare(
      `UPDATE printer_models
          SET purchase_iqd = 900000, residual_iqd = 100000, useful_print_hours = 4000,
              maintenance_iqd_per_hour = 150, printing_watts = 110,
              bed_heating_watts = 350, nozzle_heating_watts = 60
        WHERE id = 'bbl-a1m'`
    )
    .run();
  const app = stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
  return { raw, app };
}

const gramsQuote = (app: App, body: Record<string, unknown>) =>
  post(app, '/api/print-quote/grams-quote', body);

// ------------------------------------------------- one engine, two front doors

test('a weight and a sliced file produce the same price for the same material and mass', async () => {
  const { raw, app } = shopWithPricedPla();

  // The warm-up is a MACHINE fact, and the grams path takes it from the printer
  // profile. Feeding the file path the same figure is what makes the two
  // analyses describe the same job rather than two jobs that merely weigh the
  // same — otherwise this test would be comparing electricity bills.
  const warmup = Number(
    row<{ warmup_minutes: number }>(raw, `SELECT warmup_minutes FROM printer_models WHERE id = 'bbl-a1m'`)!.warmup_minutes
  );

  const form = new FormData();
  form.append('file', new File([stlBytes()], 'bracket.stl', { type: 'application/octet-stream' }));
  form.append('guest_token', 'tok-grams');
  const uploaded = await json(await app.request('/api/print-quote/uploads', { method: 'POST', body: form }));
  const id = uploaded.analysis_id as string;
  const h = { 'X-Guest-Token': 'tok-grams' };

  const analysed = await json(
    await post(
      app,
      `/api/print-quote/analyses/${id}`,
      {
        printer_model_id: 'bbl-a1m',
        stats: { filament_mm: 60_000, time_estimate: 14_400, layers: 200, model_layers: 200, raft_layers: 0 },
        tools: [{ slot: 0, material_id: 'pla', color_hex: '#000000' }],
        bounding_box_mm: { x: 100, y: 80, z: 40 },
        model_volume_mm3: 96_000,
        layer_height_mm: 0.2,
        preparation_minutes: warmup,
        slicer_version: 'three-slicer@0.2.2',
        profile_revision: 'bbl-a1m-04-r1',
      },
      h
    )
  );
  assert.equal(analysed.success, true, JSON.stringify(analysed));

  // Read the grams the engine STORED, not the ones the payload rounded for
  // display: a hundredth of a gram is a dinar once a margin is applied, and a
  // comparison built on a rounded figure would need a tolerance to pass, which
  // is exactly the kind of "close enough" this whole route exists to avoid.
  const stored = row<{ model_grams: number }>(
    raw,
    'SELECT model_grams FROM print_analysis_materials WHERE analysis_id = ?',
    id
  )!;
  const minutes = Number(
    row<{ print_minutes_per_plate: number }>(
      raw,
      'SELECT print_minutes_per_plate FROM print_analyses WHERE id = ?',
      id
    )!.print_minutes_per_plate
  );

  const fromFile = await json(await post(app, `/api/print-quote/analyses/${id}/quote`, {}, h));
  assert.equal(fromFile.success, true, JSON.stringify(fromFile));

  const fromGrams = await json(
    await gramsQuote(app, {
      printer_model_id: 'bbl-a1m',
      rows: [{ material_id: 'pla', grams: stored.model_grams, color_hex: '#000000' }],
      print_minutes: minutes,
    })
  );
  assert.equal(fromGrams.success, true, JSON.stringify(fromGrams));

  // THE assertion this file exists for. Not "close", not "within a range".
  assert.equal(
    fromGrams.quote.price_iqd,
    fromFile.quote.price_iqd,
    'the grams path and the file path must be the same pricing function'
  );
  assert.deepEqual(fromGrams.quote.range_iqd, fromFile.quote.range_iqd);
  assert.equal(fromGrams.quote.machine_hours, fromFile.quote.machine_hours);

  // §22: the customer shape carries no cost, margin or component line — the
  // grams door must not be a way around the wall the file door already has.
  const text = JSON.stringify(fromGrams.quote);
  for (const leak of ['cost', 'margin', 'profit', 'lines', 'break_even', 'depreciation']) {
    assert.ok(!text.toLowerCase().includes(leak), `the customer payload carries '${leak}'`);
  }
});

// --------------------------------------------------------- «بلون واحد أو أكثر»

test('several colour rows are summed, not counted or averaged', async () => {
  const { app } = shopWithPricedPla();
  const ask = async (rows: Array<Record<string, unknown>>) =>
    (await json(await gramsQuote(app, { printer_model_id: 'bbl-a1m', rows, print_minutes: 180 }))).quote;

  const oneColour = await ask([{ material_id: 'pla', grams: 100, color_hex: '#000000' }]);
  const twoColours = await ask([
    { material_id: 'pla', grams: 60, color_hex: '#000000' },
    { material_id: 'pla', grams: 40, color_hex: '#B03142' },
  ]);
  const half = await ask([{ material_id: 'pla', grams: 60, color_hex: '#000000' }]);

  // 60 g black plus 40 g red is 100 g of PLA. The engine prices the MASS, so
  // splitting it across colours must not change the bill — and must not quietly
  // price only the first row either, which is what this second assertion pins.
  assert.equal(twoColours.price_iqd, oneColour.price_iqd, 'two colour rows must sum to the same mass');
  assert.ok(twoColours.price_iqd > half.price_iqd, 'the second row must actually be paid for');

  // And the grams the screen shows are the grams that were priced.
  const body = await json(
    await gramsQuote(app, {
      printer_model_id: 'bbl-a1m',
      rows: [
        { material_id: 'pla', grams: 60, color_hex: '#000000' },
        { material_id: 'pla', grams: 40, color_hex: '#B03142' },
      ],
      print_minutes: 180,
    })
  );
  assert.equal(body.grams_total, 100);
  assert.equal(body.rows.length, 2);
  assert.deepEqual(body.rows.map((r: { color_hex: string }) => r.color_hex), ['#000000', '#B03142']);
});

// ------------------------------------------------------------- what is refused

test('a zero, negative or missing gram count is refused with a real message', async () => {
  const { app } = shopWithPricedPla();

  for (const grams of [0, -5, '', 'abc', null]) {
    const res = await gramsQuote(app, {
      printer_model_id: 'bbl-a1m',
      rows: [{ material_id: 'pla', grams }],
    });
    const body = await json(res);
    assert.equal(res.status, 400, `grams=${JSON.stringify(grams)} was accepted`);
    assert.equal(body.code, 'BAD_GRAMS');
    // A code is for the screen; a sentence is for whoever reads the log or hits
    // the API directly. An empty `error` is how a refusal becomes a mystery.
    assert.ok(String(body.error).length > 12, 'a refusal must say what is wrong');
    assert.match(String(body.error), /grams/i);
  }

  const empty = await gramsQuote(app, { printer_model_id: 'bbl-a1m', rows: [] });
  assert.equal(empty.status, 400);
  assert.equal((await json(empty)).code, 'NO_GRAM_ROWS');

  const absurd = await gramsQuote(app, {
    printer_model_id: 'bbl-a1m',
    rows: [{ material_id: 'pla', grams: 999_999 }],
  });
  assert.equal(absurd.status, 400);
  assert.equal((await json(absurd)).code, 'GRAMS_TOO_LARGE');

  // A material with no density cannot become a weight at all, and a default
  // density would be a fabricated physical constant (§53).
  const unknown = await gramsQuote(app, {
    printer_model_id: 'bbl-a1m',
    rows: [{ material_id: 'no-such-filament', grams: 100 }],
  });
  assert.equal(unknown.status, 400);
  assert.equal((await json(unknown)).code, 'UNKNOWN_MATERIAL');
});

// ----------------------------------------------------------- the floor applies

test('the minimum charge applies, and it is the number the owner configured', async () => {
  const { raw, app } = shopWithPricedPla();

  // One gram of PLA is about 22 dinars of plastic. Nobody sets up a machine for
  // 22 dinars, so the answer must be the configured floor rather than the
  // arithmetic — a quote below it is a quote no merchant can honour.
  const tiny = await json(
    await gramsQuote(app, { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 1 }] })
  );
  assert.equal(tiny.success, true, JSON.stringify(tiny));
  assert.equal(tiny.quote.price_iqd, 5_000, 'the seeded platform minimum job');

  // AND THE RANGE IS FLOORED TOO. A grams quote is `inferred`, so its
  // confidence is always 'estimated' and the range is always price ± 12%. That
  // put «5,000 د.ع» on the screen over an expected range starting at 4,400 —
  // a figure the floor exists to make impossible, rendered to the customer by
  // both screens, which show the range whenever high > low. The high end is
  // deliberately NOT capped: a job can cost more than the minimum.
  assert.ok(
    tiny.quote.range_iqd.low >= 5_000,
    `the quoted range dips under the shop's own floor: ${JSON.stringify(tiny.quote.range_iqd)}`
  );
  assert.ok(tiny.quote.range_iqd.high >= tiny.quote.price_iqd);

  // And it is a SETTING, not a constant in the route: moving it in the admin
  // moves the quote. If this ever stops holding, somebody has hardcoded a floor.
  raw
    .prepare(`INSERT INTO admin_settings (key, value) VALUES ('printPricingConfig', ?)`)
    .run(JSON.stringify({ min_job_iqd: 9_000 }));
  const lifted = await json(
    await gramsQuote(app, { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 1 }] })
  );
  assert.equal(lifted.quote.price_iqd, 9_000);
  assert.ok(lifted.quote.range_iqd.low >= 9_000, 'the floor moved and the range did not follow it');

  // The floor is a floor, not a price: a real job still costs what it costs.
  const real = await json(
    await gramsQuote(app, {
      printer_model_id: 'bbl-a1m',
      rows: [{ material_id: 'pla', grams: 500 }],
      print_minutes: 600,
    })
  );
  assert.ok(real.quote.price_iqd > 9_000, 'a half-kilo job must price above the minimum');
});

// ------------------------------------------- what the quote covers, out loud

test('the response says what the price includes and what it cannot', async () => {
  const { app } = shopWithPricedPla();

  // WITHOUT a stated print time there are no machine hours to price. The
  // failure this guards against is a screen that shows a confident number and
  // never mentions that half the job is missing from it.
  const materialOnly = await json(
    await gramsQuote(app, { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }] })
  );
  assert.equal(materialOnly.covers.material_only, true);
  assert.ok(materialOnly.covers.included.includes('MATERIAL'));
  assert.ok(materialOnly.covers.excluded.includes('MACHINE_TIME'));
  assert.ok(materialOnly.covers.excluded.includes('ELECTRICITY'));
  assert.ok(!materialOnly.covers.included.includes('MACHINE_TIME'));
  assert.equal(materialOnly.print_minutes, 0);
  // Support is a property of a shape, and there is no shape here. Saying
  // "excluded" rather than reporting zero is §8 applied to a form.
  assert.ok(materialOnly.covers.excluded.includes('SUPPORT_MATERIAL'));

  // WITH one, the hours are priced exactly as the file path prices them.
  const timed = await json(
    await gramsQuote(app, {
      printer_model_id: 'bbl-a1m',
      rows: [{ material_id: 'pla', grams: 100 }],
      print_minutes: 300,
    })
  );
  assert.equal(timed.covers.material_only, false);
  assert.ok(timed.covers.included.includes('MACHINE_TIME'));
  assert.ok(!timed.covers.excluded.includes('MACHINE_TIME'));
  assert.ok(timed.quote.machine_hours > 0);
  assert.ok(
    timed.quote.price_iqd > materialOnly.quote.price_iqd,
    'machine hours are a real cost — the two answers must not be the same number'
  );

  // A multi-colour job flushes filament on every change, and this path cannot
  // know how much. Named rather than omitted, so a merchant's real offer being
  // higher is something the customer was told about in advance.
  const twoColours = await json(
    await gramsQuote(app, {
      printer_model_id: 'bbl-a1m',
      rows: [
        { material_id: 'pla', grams: 60 },
        { material_id: 'pla', grams: 40 },
      ],
      print_minutes: 300,
    })
  );
  assert.ok(twoColours.covers.excluded.includes('PURGE_ON_COLOR_CHANGE'));

  // Never `exact`: a mass somebody typed is not a measurement, so the answer is
  // always a range and always labelled an estimate.
  assert.notEqual(timed.quote.confidence, 'exact');
  assert.ok(timed.quote.range_iqd.high > timed.quote.range_iqd.low);
});


// ======================================================================
// analysisFromGrams, DIRECTLY — the export had no consumer and no test
// ======================================================================

/**
 * The function is `export`ed and, until this block, its only reference in the
 * whole tree was one line in its own file: it was exercised ONLY through HTTP,
 * so the export bought nothing and widened the module's surface for free. It
 * is pure, and every interesting property of it is assertable without a
 * database — so the export is earned here rather than removed, because the
 * properties below are the ones a reviewer has to take on trust otherwise.
 */
const PRINTER = {
  id: 'test-printer',
  warmupMinutes: 7,
} as unknown as PrinterModel;

const rows = (...specs: Array<[string, number, number]>): GramsRow[] =>
  specs.map(([materialId, grams, densityGPerCm3]) => ({
    materialId,
    materialType: 'PLA',
    colorHex: '#000000',
    densityGPerCm3,
    grams,
  }));

test('every stated gram lands in modelGrams, and no waste bucket is invented', () => {
  const a = analysisFromGrams({ printer: PRINTER, rows: rows(['pla', 60, 1.24], ['petg', 40, 1.27]), printMinutes: 0 });

  // THE CUSTOMER SAID HOW MUCH PLASTIC THE PART IS, not how much the machine
  // will flush. Folding an invented waste fraction into their own figure would
  // be a coefficient nobody can defend, and it would be INVISIBLE — the price
  // would simply be higher than the weight they typed.
  assert.deepEqual(a.materials.map((m) => m.modelGrams), [60, 40]);
  for (const m of a.materials) {
    assert.equal(m.supportGrams, 0);
    assert.equal(m.supportInterfaceGrams, 0);
    assert.equal(m.purgeGrams, 0);
    assert.equal(m.primeTowerGrams, 0);
    assert.equal(m.brimRaftGrams, 0);
    assert.equal(m.otherWasteGrams, 0);
  }
  // Those buckets being ZERO in the payload is not a claim that they are zero
  // in reality — `covers.excluded` is what says they are unknown, and the
  // route test above pins that it does.

  // Mass ÷ density IS the volume: the one derived figure here is physics.
  //   60 / 1.24 × 1000 = 48387.09…   40 / 1.27 × 1000 = 31496.06…
  assert.ok(Math.abs(a.modelVolumeMm3 - (60 / 1.24 + 40 / 1.27) * 1000) < 1e-6);

  // A weight has no shape. Zeros, not a fabricated bounding box that the
  // eligibility check might one day believe.
  assert.deepEqual(a.boundingBoxMm, { x: 0, y: 0, z: 0 });

  // A stated weight and a measured mesh must never be indistinguishable in a
  // payload, a log or a screen.
  assert.equal(a.provenance, 'inferred');
  assert.equal(a.slicerVersion, 'levonis-grams@1');
  assert.equal(a.fileSha256, '', 'there is no file, so there is no hash to pretend to');

  // Each extra filament is a change the machine has to make.
  assert.equal(a.toolChanges, 1);
  assert.equal(analysisFromGrams({ printer: PRINTER, rows: rows(['pla', 100, 1.24]), printMinutes: 0 }).toolChanges, 0);
});

test('with no stated time there is no warm-up to charge for', () => {
  // Charging a bed heat-up inside an answer that promises «مادة ومناولة فقط»
  // would contradict what `covers` tells the customer on the same screen.
  const silent = analysisFromGrams({ printer: PRINTER, rows: rows(['pla', 100, 1.24]), printMinutes: 0 });
  assert.equal(silent.printMinutesPerPlate, 0);
  assert.equal(silent.preparationMinutes, 0);

  const timed = analysisFromGrams({ printer: PRINTER, rows: rows(['pla', 100, 1.24]), printMinutes: 180 });
  assert.equal(timed.printMinutesPerPlate, 180);
  assert.equal(timed.preparationMinutes, 7, 'warm-up is a fact about the MACHINE, taken from its profile');

  // A negative is a typo, not a measurement.
  assert.equal(analysisFromGrams({ printer: PRINTER, rows: rows(['pla', 100, 1.24]), printMinutes: -5 }).printMinutesPerPlate, 0);
});

test('the stated grams are the WHOLE job — there is no per-piece figure to multiply', () => {
  const a = analysisFromGrams({ printer: PRINTER, rows: rows(['pla', 100, 1.24]), printMinutes: 60 });
  assert.equal(a.plateCount, 1);
  assert.equal(a.piecesPerPlate, 1);
  assert.equal(a.partCount, 1);
  // A density of zero cannot divide: it yields no volume rather than Infinity.
  assert.equal(analysisFromGrams({ printer: PRINTER, rows: rows(['pla', 100, 0]), printMinutes: 0 }).modelVolumeMm3, 0);
});
