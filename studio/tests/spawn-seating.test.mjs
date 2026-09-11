/**
 * Where a duplicated object lands.
 *
 * WHY THIS EXISTS. The owner reported that duplicating a model eventually
 * throws the copy far away while there is free room right next to it. The
 * cause is in the engine and is quoted verbatim in app/spawn-seating.ts: the
 * viewer seats anything it spawns from a cursor that only ever grows and only
 * resets when the scene becomes empty. It does not know the bed width, so the
 * fourth copy is simply past the edge.
 *
 * These tests pin the replacement: the free spot nearest the source, inside
 * the printable area, overlapping nothing — and, when a plate genuinely has no
 * room, an honest overflow instead of a silent stack.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const seatingUrl = new URL("../app/spawn-seating.ts", import.meta.url);
const engineUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);

const source = await readFile(seatingUrl, "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { planSeats } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

const BED = 256;
const MARGIN = 8;
const GAP = 6;
const USABLE = BED - MARGIN * 2;

const rect = (seat, width, depth) => ({
  minX: seat.offsetX - width / 2,
  maxX: seat.offsetX + width / 2,
  minY: seat.offsetY - depth / 2,
  maxY: seat.offsetY + depth / 2,
});

const overlaps = (a, b) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

const insideBed = (r) =>
  r.minX >= -USABLE / 2 - 1e-6 && r.maxX <= USABLE / 2 + 1e-6
  && r.minY >= -USABLE / 2 - 1e-6 && r.maxY <= USABLE / 2 + 1e-6;

test("the engine bug this replaces is still present in the installed build", async () => {
  const engine = await readFile(engineUrl, "utf8");
  // The monotonic spawn cursor, verbatim. If this ever disappears upstream the
  // seating can be reconsidered — until then it is what makes it necessary.
  assert.match(engine, /_e\.position\.set\(Mt\.x \+ l\.current \+ Ke \/ 2, 0, Mt\.z\), l\.current \+= Ke \+ 8/);
  assert.match(engine, /a\.current\.length === 0 && \(l\.current = 0\)/);
});

test("a copy lands beside its source, on the bed, touching nothing", () => {
  const source = { id: 1, plate: 0, offsetX: -40, offsetY: -20, width: 50, depth: 40 };
  const plan = planSeats(
    [{ id: 2, width: 50, depth: 40 }],
    [source],
    { bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0], nearOffsetX: source.offsetX, nearOffsetY: source.offsetY }
  );
  assert.equal(plan.seats.length, 1);
  assert.deepEqual(plan.unseated, []);
  const seat = plan.seats[0];
  assert.equal(seat.plate, 0);
  const copy = rect(seat, 50, 40);
  assert.ok(insideBed(copy), "the copy must be inside the printable area");
  assert.ok(!overlaps(copy, rect(source, 50, 40)), "the copy must not overlap its source");
  // "Beside it", not somewhere across the bed: adjacency means one gap away.
  const centreDistance = Math.hypot(seat.offsetX - source.offsetX, seat.offsetY - source.offsetY);
  assert.ok(centreDistance <= 50 + GAP + 1e-6, `copy landed ${centreDistance.toFixed(1)}mm away`);
});

test("duplicating ten times never walks off the bed — the reported failure", () => {
  // The engine's cursor would put copy #4 past the bed edge and #10 far past
  // it. Every one of these must be on the bed and clear of the others.
  const width = 45;
  const depth = 35;
  const placed = [{ id: 1, plate: 0, offsetX: -60, offsetY: -60, width, depth }];
  for (let copy = 0; copy < 10; copy += 1) {
    const id = copy + 2;
    const plan = planSeats(
      [{ id, width, depth }],
      placed,
      { bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0], nearOffsetX: -60, nearOffsetY: -60 }
    );
    assert.equal(plan.seats.length, 1, `copy ${id} found no home`);
    const seat = plan.seats[0];
    const box = rect(seat, width, depth);
    assert.ok(insideBed(box), `copy ${id} landed outside the bed at ${seat.offsetX},${seat.offsetY}`);
    for (const other of placed) {
      assert.ok(!overlaps(box, rect(other, other.width, other.depth)), `copy ${id} overlaps object ${other.id}`);
    }
    placed.push({ id, plate: 0, offsetX: seat.offsetX, offsetY: seat.offsetY, width, depth });
  }
  assert.equal(placed.length, 11);
});

test("two copies made at once do not land on top of each other", () => {
  const plan = planSeats(
    [{ id: 2, width: 60, depth: 60 }, { id: 3, width: 60, depth: 60 }],
    [{ id: 1, plate: 0, offsetX: 0, offsetY: 0, width: 60, depth: 60 }],
    { bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0] }
  );
  assert.equal(plan.seats.length, 2);
  const [a, b] = plan.seats;
  assert.ok(!overlaps(rect(a, 60, 60), rect(b, 60, 60)));
});

test("a full plate overflows to the next one rather than stacking", () => {
  // One object filling nearly the whole bed leaves no room for a second.
  const big = { id: 1, plate: 0, offsetX: 0, offsetY: 0, width: 220, depth: 220 };
  const plan = planSeats(
    [{ id: 2, width: 220, depth: 220 }],
    [big],
    { bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0, 1] }
  );
  assert.equal(plan.seats.length, 1);
  assert.equal(plan.seats[0].plate, 1, "the copy must move to the next plate, not overlap");
  assert.deepEqual(plan.unseated, []);
});

test("nothing that does not fit is squeezed, scaled or stacked — it is reported", () => {
  const big = { id: 1, plate: 0, offsetX: 0, offsetY: 0, width: 220, depth: 220 };
  const plan = planSeats(
    [{ id: 2, width: 220, depth: 220 }],
    [big],
    { bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0] }
  );
  assert.deepEqual(plan.seats, []);
  assert.deepEqual(plan.unseated, [2]);

  // An object larger than the bed itself can never be seated, on any plate.
  const oversized = planSeats(
    [{ id: 9, width: 500, depth: 500 }],
    [],
    { bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0, 1, 2] }
  );
  assert.deepEqual(oversized.seats, []);
  assert.deepEqual(oversized.unseated, [9]);
});

test("only the new objects move — an existing layout is never rearranged", () => {
  // planSeats returns seats for the requested ids and nothing else; the caller
  // therefore cannot move anything the user already positioned.
  const occupied = [
    { id: 1, plate: 0, offsetX: -70, offsetY: 70, width: 40, depth: 40 },
    { id: 2, plate: 0, offsetX: 70, offsetY: -70, width: 40, depth: 40 },
  ];
  const plan = planSeats([{ id: 3, width: 40, depth: 40 }], occupied, {
    bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0],
  });
  assert.deepEqual(plan.seats.map((seat) => seat.id), [3]);
});

test("the plan is deterministic — the same scene always seats the same way", () => {
  const occupied = [{ id: 1, plate: 0, offsetX: 0, offsetY: 0, width: 50, depth: 50 }];
  const options = { bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0] };
  const first = planSeats([{ id: 2, width: 50, depth: 50 }], occupied, options);
  const second = planSeats([{ id: 2, width: 50, depth: 50 }], occupied, options);
  assert.deepEqual(first, second);
});

test("degenerate footprints are handled without producing NaN positions", () => {
  const plan = planSeats(
    [{ id: 2, width: Number.NaN, depth: 0 }],
    [{ id: 1, plate: 0, offsetX: 0, offsetY: 0, width: 30, depth: 30 }],
    { bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0] }
  );
  assert.equal(plan.seats.length, 1);
  assert.ok(Number.isFinite(plan.seats[0].offsetX));
  assert.ok(Number.isFinite(plan.seats[0].offsetY));
});

test("an empty request is a no-op, not an error", () => {
  const plan = planSeats([], [], { bedWidth: BED, bedDepth: BED });
  assert.deepEqual(plan, { seats: [], unseated: [] });
});

test("a single object on an empty plate goes to the middle, not into a corner", () => {
  // The corner-point set on its own offers nothing but the bed's front-left
  // corner when there is nothing to sit beside — which would take the first
  // model someone imports and shove it into the corner of the plate.
  const plan = planSeats([{ id: 1, width: 40, depth: 30 }], [], {
    bedWidth: BED, bedDepth: BED, preferredPlate: 0, availablePlates: [0],
  });
  assert.equal(plan.seats.length, 1);
  assert.equal(plan.seats[0].offsetX, 0);
  assert.equal(plan.seats[0].offsetY, 0);
});
