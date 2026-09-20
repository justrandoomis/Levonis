/**
 * «إكسسوارات ميكر وورد» — THE HARDWARE A PRINT NEEDS, PRICED WITH IT.
 *
 * The owner: «إذا كانت الطبعة تحتاج إلى عدد من المغناطيس أو مصباح أو محرك أو
 * أسلاك وغيرها … تضاف تكلفة لحساب الطبعة النهائية بشكل دقيق».
 *
 * What is worth pinning is not "does it add up" — it is the three decisions a
 * future edit could quietly undo, each of which costs somebody money:
 *
 *   1. HARDWARE CARRIES NO FAILURE PROVISION. The magnets are fitted after the
 *      part comes off the plate, so a failed print leaves them in the drawer.
 *      Moving the line inside `attemptIqd`, or adding 'HARDWARE' to
 *      VARIABLE_COMPONENTS, bills the customer for a loss nobody takes.
 *   2. IT IS STILL INSIDE THE MARGIN. The shop buys the magnet, stocks it and
 *      fits it; a part sold at exactly its hardware cost is sold at a loss.
 *   3. THE COUNT IS PER PART. Ten keychains need ten rings — and exactly ten,
 *      not a hundred, which is what a second multiplication of the same
 *      quantity would produce.
 *
 * Run: npx tsx --test tests/printAccessories.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseModel, type ModelAnalysis } from '../worker/lib/modelGeometry';
import {
  DEFAULT_ACCESSORIES,
  MAX_ACCESSORY_QTY,
  accessoryProblems,
  priceAccessories,
  type PrintAccessory,
} from '../worker/lib/printAccessories';
import { VARIABLE_COMPONENTS } from '../worker/lib/printQuote/model';
import {
  DEFAULT_MATERIALS,
  DEFAULT_PRICING,
  quotePrint,
  type QuoteInput,
} from '../worker/lib/printPricing';

// ------------------------------------------------------------- the catalogue

test('the seeded catalogue is one the admin screen would accept', () => {
  assert.deepEqual(accessoryProblems(DEFAULT_ACCESSORIES), []);
  assert.ok(DEFAULT_ACCESSORIES.length >= 20, 'a catalogue this short is a picker nobody finds anything in');
});

test('the owner\'s own examples are all in it', () => {
  // «المغناطيس ومحرك وميدالية … مصباح … أسلاك» — every word they used.
  const ids = new Set(DEFAULT_ACCESSORIES.map((a) => a.id));
  for (const kind of ['magnet-6x3', 'motor-n20', 'keyring', 'lamp-cob', 'wire-22awg']) {
    assert.ok(ids.has(kind), `${kind} — the owner named this one`);
  }
});

test('a magnet is priced per PIECE and wire per CENTIMETRE, and the difference is stored', () => {
  // Folding these into one unit is how the arithmetic goes back to guessing:
  // "20" means twenty magnets or twenty centimetres, and only the row knows.
  assert.equal(DEFAULT_ACCESSORIES.find((a) => a.id === 'magnet-6x3')!.unit, 'piece');
  assert.equal(DEFAULT_ACCESSORIES.find((a) => a.id === 'wire-22awg')!.unit, 'cm');
});

test('three magnet sizes, not one «مغناطيس»', () => {
  // A 6×3 disc and a 20×3 disc are not the same money. One row for all of them
  // would put the guess back into a feature whose purpose is «بشكل دقيق».
  const magnets = DEFAULT_ACCESSORIES.filter((a) => a.category === 'magnet');
  assert.ok(magnets.length >= 3, 'one magnet row is a guess wearing a catalogue');
  assert.equal(new Set(magnets.map((m) => m.cost_iqd)).size, magnets.length, 'they must not all cost the same');
});

// --------------------------------------------------------------- the pricing

const CAT: PrintAccessory[] = DEFAULT_ACCESSORIES;

test('six magnets and a ring cost six magnets and a ring', () => {
  const out = priceAccessories(CAT, [{ id: 'magnet-6x3', qty: 6 }, { id: 'keyring', qty: 1 }]);
  const magnet = CAT.find((a) => a.id === 'magnet-6x3')!;
  const ring = CAT.find((a) => a.id === 'keyring')!;
  assert.equal(out.total_iqd, magnet.cost_iqd * 6 + ring.cost_iqd);
  assert.equal(out.lines.length, 2);
  assert.deepEqual(out.unknown, []);
});

test('the copy count multiplies it — ten keychains need ten rings', () => {
  const one = priceAccessories(CAT, [{ id: 'keyring', qty: 1 }], 1);
  const ten = priceAccessories(CAT, [{ id: 'keyring', qty: 1 }], 10);
  assert.equal(ten.total_iqd, one.total_iqd * 10);
  assert.equal(ten.lines[0].qty, 10, 'the itemised line must say ten, not one');
});

test('two rows naming the same magnet are ONE line, not two the reader adds up', () => {
  const out = priceAccessories(CAT, [{ id: 'magnet-6x3', qty: 4 }, { id: 'magnet-6x3', qty: 2 }]);
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].qty, 6);
});

test('the breakdown reads in catalogue order, whatever order the boxes were filled', () => {
  const a = priceAccessories(CAT, [{ id: 'keyring', qty: 1 }, { id: 'magnet-6x3', qty: 2 }]);
  const b = priceAccessories(CAT, [{ id: 'magnet-6x3', qty: 2 }, { id: 'keyring', qty: 1 }]);
  assert.deepEqual(a.lines.map((l) => l.id), b.lines.map((l) => l.id));
  assert.equal(a.total_iqd, b.total_iqd);
});

test('an id the catalogue no longer has is REPORTED, not priced at zero', () => {
  // A client one version behind must be told its magnet was not counted.
  // Pricing it at 0 under-quotes in secret; throwing would let one retired row
  // stop the shop quoting at all.
  const out = priceAccessories(CAT, [{ id: 'magnet-6x3', qty: 2 }, { id: 'retired-widget', qty: 5 }]);
  assert.deepEqual(out.unknown, ['retired-widget']);
  assert.equal(out.lines.length, 1);
  assert.equal(out.total_iqd, CAT.find((a) => a.id === 'magnet-6x3')!.cost_iqd * 2);
});

test('a de-activated row is unknown to the quote', () => {
  const off = CAT.map((a) => (a.id === 'keyring' ? { ...a, active: false } : a));
  const out = priceAccessories(off, [{ id: 'keyring', qty: 1 }]);
  assert.equal(out.total_iqd, 0);
  assert.deepEqual(out.unknown, ['keyring']);
});

test('nonsense counts are dropped rather than turned into money', () => {
  const out = priceAccessories(CAT, [
    { id: 'magnet-6x3', qty: 0 },
    { id: 'magnet-6x3', qty: -4 },
    { id: 'keyring', qty: Number.NaN },
    { id: '', qty: 3 },
  ] as Array<{ id: string; qty: number }>);
  assert.equal(out.total_iqd, 0);
  assert.deepEqual(out.lines, []);
});

test('a runaway count is capped, not quoted', () => {
  const out = priceAccessories(CAT, [{ id: 'magnet-6x3', qty: 10_000_000 }]);
  assert.equal(out.lines[0].qty, MAX_ACCESSORY_QTY);
});

// ------------------------------------------------- the two engines agree

/** A real STL through the real analyser: a hand-written shape proves nothing. */
function cube(mm: number): ModelAnalysis {
  const v = (i: number, j: number, k: number) => [i * mm, j * mm, k * mm];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  const tris = [
    [p000, p110, p100].flat(), [p000, p010, p110].flat(),
    [p001, p101, p111].flat(), [p001, p111, p011].flat(),
    [p000, p100, p101].flat(), [p000, p101, p001].flat(),
    [p010, p011, p111].flat(), [p010, p111, p110].flat(),
    [p000, p001, p011].flat(), [p000, p011, p010].flat(),
    [p100, p110, p111].flat(), [p100, p111, p101].flat(),
  ];
  const out = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, tris.length, true);
  let at = 84;
  for (const t of tris) {
    at += 12;
    for (let i = 0; i < 9; i++) { dv.setFloat32(at, t[i], true); at += 4; }
    at += 2;
  }
  return analyseModel(out, 'c.stl');
}

const base = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  analysis: cube(40),
  materialId: 'pla',
  quality: 'standard',
  infill: 0.2,
  quantity: 1,
  colors: 1,
  supports: false,
  post_processing_minutes: 0,
  accessory_catalogue: CAT,
  ...over,
});

test('the hardware reaches the quote as its own line, itemised', () => {
  const q = quotePrint(base({ accessories: [{ id: 'magnet-6x3', qty: 6 }] }), DEFAULT_MATERIALS, DEFAULT_PRICING);
  const line = q.cost_lines.find((l) => l.key === 'accessories');
  assert.ok(line, 'no accessories line');
  assert.equal(line!.iqd, CAT.find((a) => a.id === 'magnet-6x3')!.cost_iqd * 6);
  assert.equal(q.accessory_lines.length, 1);
  assert.equal(q.accessory_lines[0].qty, 6);
  assert.deepEqual(q.accessories_unknown, []);
});

test('a job with no hardware carries no line at all', () => {
  const q = quotePrint(base(), DEFAULT_MATERIALS, DEFAULT_PRICING);
  assert.equal(q.cost_lines.find((l) => l.key === 'accessories'), undefined);
  assert.deepEqual(q.accessory_lines, []);
});

test('DECISION 1 — the failure provision does not grow when hardware is added', () => {
  /**
   * The one that costs the customer money if it is ever undone. A failed print
   * spends its plastic again; it does not spend its magnets, because they are
   * fitted afterwards. If a future edit folds the hardware into `attemptIqd`,
   * `failure_risk` moves and this fails.
   */
  const without = quotePrint(base(), DEFAULT_MATERIALS, DEFAULT_PRICING);
  const with_ = quotePrint(
    base({ accessories: [{ id: 'motor-n20', qty: 1 }, { id: 'magnet-10x3', qty: 8 }] }),
    DEFAULT_MATERIALS,
    DEFAULT_PRICING
  );
  const risk = (q: typeof without) => q.cost_lines.find((l) => l.key === 'failure_risk')?.iqd ?? 0;
  assert.ok(risk(without) > 0, 'the fixture must actually carry a failure provision');
  assert.equal(risk(with_), risk(without), 'the hardware was charged a failure provision');
});

test('DECISION 1, the other engine — HARDWARE is not a variable component', () => {
  assert.equal(VARIABLE_COMPONENTS.has('HARDWARE'), false);
  // And the neighbours it could be confused with still are, so this is not
  // passing because the set emptied.
  assert.equal(VARIABLE_COMPONENTS.has('MODEL_MATERIAL'), true);
  assert.equal(VARIABLE_COMPONENTS.has('ELECTRICITY'), true);
});

test('DECISION 2 — the hardware is still inside the margin', () => {
  const magnets = 8;
  const unit = CAT.find((a) => a.id === 'magnet-10x3')!.cost_iqd;
  const without = quotePrint(base(), DEFAULT_MATERIALS, DEFAULT_PRICING);
  const with_ = quotePrint(
    base({ accessories: [{ id: 'magnet-10x3', qty: magnets }] }),
    DEFAULT_MATERIALS,
    DEFAULT_PRICING
  );
  const added = with_.price_iqd - without.price_iqd;
  assert.ok(
    added > unit * magnets,
    `the price rose by ${added} for ${unit * magnets} of hardware — the shop is fitting them for free`
  );
});

test('DECISION 3 — the count is per part, and multiplied exactly once', () => {
  const one = quotePrint(
    base({ quantity: 1, accessories: [{ id: 'keyring', qty: 1 }] }),
    DEFAULT_MATERIALS,
    DEFAULT_PRICING
  );
  const ten = quotePrint(
    base({ quantity: 10, accessories: [{ id: 'keyring', qty: 1 }] }),
    DEFAULT_MATERIALS,
    DEFAULT_PRICING
  );
  const hw = (q: typeof one) => q.cost_lines.find((l) => l.key === 'accessories')!.iqd;
  assert.equal(hw(ten), hw(one) * 10, 'ten parts need ten rings — not one, and not a hundred');
});

test('a quote that could not be made still has the accessory shape', () => {
  // `unpriced()` is a separate return path; a reader must not have to
  // special-case it.
  const q = quotePrint(base({ analysis: null }), DEFAULT_MATERIALS, DEFAULT_PRICING);
  assert.equal(q.priced, false);
  assert.deepEqual(q.accessory_lines, []);
  assert.deepEqual(q.accessories_unknown, []);
});
