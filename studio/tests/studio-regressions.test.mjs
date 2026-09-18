/**
 * The six failures that must never come back.
 *
 * WHY THIS FILE EXISTS. The performance work on LEVO Studio — releasing the
 * slice worker, skipping unchanged autosaves, seating duplicates in real free
 * space — shipped five regressions in its first round. An adversarial review
 * found them; the live acceptance run did not, because it never painted,
 * never undid a delete, never opened a .3mf and never backgrounded a tab. Each
 * one was a way for a user to silently lose work:
 *
 *   1. a painted project saving and uploading with every facet stripped,
 *      reporting success;
 *   2. an imported .3mf having its author's layout rearranged;
 *   3. an undo of a delete being read as a spawn and re-seated;
 *   4. the worker released mid-paint-session;
 *   5. a duplicate landing off the bed;
 *   6. workers accumulating across repeated slices.
 *
 * These tests are the permanent guard. They EXECUTE the shipped decision
 * logic — the callbacks are lifted out of app/slicer-client.tsx by the
 * TypeScript parser and called for real (tests/lib/extract-callback.mjs), and
 * the pure planners are imported (tests/lib/load-app-module.mjs). Nothing here
 * asserts on source text except where a test pins an ENGINE fact that makes a
 * guard necessary: those live in node_modules and can change under us, and if
 * one disappears the corresponding guard should be reconsidered rather than
 * silently kept.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { closureOf, liftCallback, ref } from "./lib/extract-callback.mjs";
import { loadAppModule } from "./lib/load-app-module.mjs";

const engineUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);
const workerSrcUrl = new URL("../node_modules/three-slicer/engine/src/slicer.worker.js", import.meta.url);

const { seatNewObjects } = await loadAppModule("engine-adapter");

// ---------------------------------------------------------------- stubs

/** A recording stand-in for the engine adapter's window-side API. */
function fakeAdapter({ snapshots = [], selectedId = null, plateCount = 1, released = () => true } = {}) {
  const placed = [];
  const calls = { release: 0 };
  return {
    placed,
    calls,
    api: () => ({
      sceneSnapshot: () => snapshots,
      platePos: () => ({ x: 0, y: 0, z: 0 }),
      placeObjectOnPlate: (id, plate, offsetX, offsetY) => { placed.push({ id, plate, offsetX, offsetY }); return true; },
      selectedObjectId: () => selectedId,
      hasPaintImport: () => false,
    }),
    plateOfSnapshot: () => 0,
    sceneFingerprint: () => "fingerprint",
    notifySceneEdited: () => {},
    releaseSlicerWorker: () => { calls.release += 1; return released(); },
  };
}

/**
 * An object as the engine reports it. `pos` is world mm with three's z as
 * depth; `localPos` is the raw vertex buffer the footprint is measured from,
 * so a cube is enough to give a known width and depth.
 */
const snap = (id, x, z, size = 20) => {
  const h = size / 2;
  return {
    id,
    pos: { x, y: 0, z },
    localPos: [-h, -h, -h, h, h, h],
    scale: { x: 1, y: 1, z: 1 },
    rot: { x: 0, y: 0, z: 0 },
  };
};

const BED = { bedWidth: 256, bedDepth: 256 };

// ================================================================== 1 + 4
// A painted session neither releases its worker nor trusts the autosave skip.

test("1/4: the engine facts that make the paint latch necessary are still true", async () => {
  const [viewer, worker] = await Promise.all([readFile(engineUrl, "utf8"), readFile(workerSrcUrl, "utf8")]);

  // The kernel answers "no painting" — successfully — when the worker it is
  // asked on never loaded the module. A released-and-recreated worker is
  // exactly that, so a save after a release returns an unpainted 3MF and
  // reports success. This is the loss the latch prevents.
  assert.match(worker, /if \(d\.cmd === 'exportPaint' && !modPromise\)/);
  assert.match(worker, /type: 'paintExport', supported: false, facets: \[\], hex: ''/);

  // …and the viewer would not re-prepare the mesh, because it caches the
  // prepared identity OUTSIDE the worker and only re-sends `prepare` when that
  // identity changes. Terminating a worker does not change it.
  assert.match(viewer, /l\.current = \{ identity: ee, topology: j\.topology \}/);
});

test("4: releasing the worker is refused for the whole of a painted session", async () => {
  const make = await liftCallback("releaseSlicerWorkerIfSafe");
  const adapter = fakeAdapter();

  const painted = ref(true);
  const release = make({ adapter, sessionHasPaintRef: painted });
  assert.equal(release(), false, "a painted session must not release its worker");
  assert.equal(adapter.calls.release, 0, "the engine must never even be asked");

  // The latch is one-way: leaving paint mode does not make a release safe,
  // because the strokes already in the kernel are what would be lost.
  const clean = fakeAdapter();
  const releaseClean = make({ adapter: clean, sessionHasPaintRef: ref(false) });
  assert.equal(releaseClean(), true, "an unpainted session still releases — the optimisation is intact");
  assert.equal(clean.calls.release, 1);
});

test("4: an idle release scheduled before painting still refuses when it fires", async () => {
  const makeRelease = await liftCallback("releaseSlicerWorkerIfSafe");
  const makeSchedule = await liftCallback("scheduleIdleWorkerRelease");
  const adapter = fakeAdapter();
  const painted = ref(false);
  const releaseSlicerWorkerIfSafe = makeRelease({ adapter, sessionHasPaintRef: painted });

  let fire = null;
  const schedule = makeSchedule({
    cancelIdleWorkerRelease: () => {},
    device: { idleWorkerReleaseMs: 45_000 },
    workerReleaseTimerRef: ref(null),
    window: { setTimeout: (fn) => { fire = fn; return 1; }, clearTimeout: () => {} },
    releaseSlicerWorkerIfSafe,
  });

  schedule();
  assert.equal(typeof fire, "function", "an idle release must have been scheduled");
  painted.current = true; // the user picks up the brush while the timer runs
  fire();
  assert.equal(adapter.calls.release, 0, "the timer must re-check the latch, not capture it");
});

test("1: the autosave skip reports 'I cannot tell' for a painted session", async () => {
  const make = await liftCallback("projectContentSignature");
  const closure = {
    adapter: fakeAdapter(),
    settings: { layerHeight: 0.2 },
    objects: [{ id: 1, name: "a" }],
    projectName: "p",
    profileId: "x",
    quality: "q",
    strength: "s",
    support: "none",
    plateCount: 1,
  };

  const painted = make({ ...closure, sessionHasPaintRef: ref(true) })();
  assert.equal(painted, null, "a painted session must never be skipped as unchanged");

  const clean = make({ ...closure, sessionHasPaintRef: ref(false) })();
  assert.equal(typeof clean, "string", "an unpainted session still gets a signature");
  assert.ok(clean.length > 0);

  // A project OPENED with painting in it is the same hazard arriving by a
  // different door, and is covered by the same answer.
  const importedPaint = {
    ...closure,
    adapter: { ...closure.adapter, api: () => ({ ...closure.adapter.api(), hasPaintImport: () => true }) },
  };
  assert.equal(make({ ...importedPaint, sessionHasPaintRef: ref(false) })(), null);
});

test("1/4: entering any paint mode latches the session, and 'off' does not", async () => {
  const make = await liftCallback("handleEvent");
  const painted = ref(false);
  const noop = () => {};
  const handle = make({
    slicing: { handleViewportEvent: noop },
    setObjects: noop,
    orchestrator: { notifyObjects: noop },
    seatNewObjectsIfNeeded: noop,
    setStatus: noop,
    plateCountRef: ref(1),
    setPlateCount: noop,
    selectedPlateRef: ref(0),
    setSelectedPlate: noop,
    sessionHasPaintRef: painted,
    setCanvasMode: noop,
    setToolTrayOpen: noop,
    suppressNextExportNoticeRef: ref(false),
    setNotice: noop,
    setError: noop,
  });

  handle({ type: "paintMode", value: "off" });
  assert.equal(painted.current, false, "'off' is not a paint session");

  handle({ type: "paintMode", value: "support" });
  assert.equal(painted.current, true, "entering a paint mode latches");

  handle({ type: "paintMode", value: "off" });
  assert.equal(painted.current, true, "the latch is one-way — leaving paint mode does not clear it");
});

// ====================================================================== 2
// An imported .3mf keeps the author's layout.

test("2: the restore latch absorbs the objects event however late it arrives", async () => {
  const make = await liftCallback("seatNewObjectsIfNeeded");
  const adapter = fakeAdapter({ snapshots: [snap(1, -40, -30), snap(2, 40, 30)] });
  const restoring = ref(true);
  let seated = 0;

  const seat = make({
    adapter,
    seenObjectIdsRef: ref(new Set()),
    everSeenObjectIdsRef: ref(new Set()),
    orchestrator: { busy: false, hasPendingArrangement: false },
    restoreInFlightRef: restoring,
    suppressSeatingRef: ref(false),
    seatNewObjects: () => { seated += 1; return { ok: true, seatedCount: 1, unseatedCount: 0 }; },
    profile: { bedWidth: 256, bedDepth: 256 },
    plateCountRef: ref(1),
    selectedPlateRef: ref(0),
    setNotice: () => {},
    templateText: () => "",
    t: { zipOverflow: "" },
  });

  seat([1, 2]);
  assert.equal(seated, 0, "a restore's own objects must never be re-seated");
  assert.equal(restoring.current, false, "the latch clears after absorbing exactly one event");
});

test("2: a .3mf opened through the engine's own controls is still not re-seated", () => {
  // The engine renders `open-file`, `ctx-open` and `empty-pick` straight into
  // its hidden input, so those routes never reach the shell and cannot arm the
  // shell's latch. The guard that covers them asks where the objects ARE.
  //
  // The engine's spawn cursor only ever steps along X and always leaves z at
  // the plate centre, so anything at a non-zero depth offset was positioned
  // deliberately. Here the restored objects sit at their author's offsets.
  const restored = [snap(1, -40, -30), snap(2, 40, 30)];
  const result = seatNewObjects(fakeAdapter({ snapshots: restored }), {
    newIds: [1, 2],
    ...BED,
    plateCount: 1,
    selectedPlate: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "restored-layout");
  assert.equal(result.seatedCount, 0, "not one object of the author's layout may move");
});

test("2: one object off the spawn row condemns the whole transition", () => {
  // A restore is all-or-nothing: seating half a project would be worse than
  // seating none, so a single deliberately-placed object vetoes the batch.
  const mixed = [snap(1, -40, 0), snap(2, 40, 30)];
  const result = seatNewObjects(fakeAdapter({ snapshots: mixed }), {
    newIds: [1, 2],
    ...BED,
    plateCount: 1,
    selectedPlate: 0,
  });
  assert.equal(result.reason, "restored-layout");
});

test("2: the guard still lets a genuine spawn through", () => {
  // Everything on the spawn row (z == plate centre) is the engine's cursor at
  // work, which is precisely what needs re-seating.
  const adapter = fakeAdapter({ snapshots: [snap(1, 0, 0), snap(2, 30, 0)], selectedId: 1 });
  const result = seatNewObjects(adapter, { newIds: [2], ...BED, plateCount: 1, selectedPlate: 0 });
  assert.equal(result.ok, true, "a real duplicate must still be seated");
  assert.equal(result.seatedCount, 1);
});

// ====================================================================== 3
// Undo of a delete puts objects back where they belonged.

test("3: an id that has been seen before is a restore, never a spawn", async () => {
  const make = await liftCallback("seatNewObjectsIfNeeded");
  let seated = 0;
  const everSeen = ref(new Set([7]));
  const seen = ref(new Set());

  const seat = make({
    adapter: fakeAdapter(),
    seenObjectIdsRef: seen,
    everSeenObjectIdsRef: everSeen,
    orchestrator: { busy: false, hasPendingArrangement: false },
    restoreInFlightRef: ref(false),
    suppressSeatingRef: ref(false),
    seatNewObjects: () => { seated += 1; return { ok: true, seatedCount: 1, unseatedCount: 0 }; },
    profile: { bedWidth: 256, bedDepth: 256 },
    plateCountRef: ref(1),
    selectedPlateRef: ref(0),
    setNotice: () => {},
    templateText: () => "",
    t: { zipOverflow: "" },
  });

  // The user deleted object 7 and pressed Ctrl+Z: it comes back with its id.
  seat([7]);
  assert.equal(seated, 0, "undo of a delete must not move the restored object");
});

test("3: a split is not a spawn either — its parts keep their positions", async () => {
  const make = await liftCallback("seatNewObjectsIfNeeded");
  let seated = 0;
  const seat = make({
    adapter: fakeAdapter(),
    seenObjectIdsRef: ref(new Set([1])),
    everSeenObjectIdsRef: ref(new Set([1])),
    orchestrator: { busy: false, hasPendingArrangement: false },
    restoreInFlightRef: ref(false),
    suppressSeatingRef: ref(false),
    seatNewObjects: () => { seated += 1; return { ok: true, seatedCount: 1, unseatedCount: 0 }; },
    profile: { bedWidth: 256, bedDepth: 256 },
    plateCountRef: ref(1),
    selectedPlateRef: ref(0),
    setNotice: () => {},
    templateText: () => "",
    t: { zipOverflow: "" },
  });

  // Splitting removes object 1 and adds parts 2 and 3 at its position.
  seat([2, 3]);
  assert.equal(seated, 0, "a transition that removed an id is a split, not a spawn");
});

test("3: a real new object IS still seated after all those exclusions", async () => {
  const make = await liftCallback("seatNewObjectsIfNeeded");
  let seated = 0;
  const seat = make({
    adapter: fakeAdapter(),
    seenObjectIdsRef: ref(new Set([1])),
    everSeenObjectIdsRef: ref(new Set([1])),
    orchestrator: { busy: false, hasPendingArrangement: false },
    restoreInFlightRef: ref(false),
    suppressSeatingRef: ref(false),
    seatNewObjects: () => { seated += 1; return { ok: true, seatedCount: 1, unseatedCount: 0 }; },
    profile: { bedWidth: 256, bedDepth: 256 },
    plateCountRef: ref(1),
    selectedPlateRef: ref(0),
    setNotice: () => {},
    templateText: () => "",
    t: { zipOverflow: "" },
  });

  seat([1, 2]);
  assert.equal(seated, 1, "the guards must not have disabled seating altogether");
});

// ====================================================================== 5
// A duplicate lands in free space on the bed.

/**
 * Duplicate `count` times on one plate, committing each seat before the next,
 * exactly as the shell does. Returns where every copy landed.
 */
function duplicateRepeatedly(count, { size = 20, bedWidth = 256, bedDepth = 256, plateCount = 1 } = {}) {
  const objects = [snap(1, 0, 0, size)];
  const seats = [];
  let unseated = 0;
  let nextId = 2;

  for (let i = 0; i < count; i += 1) {
    const id = nextId++;
    // The engine spawns the copy on the spawn row, far off to the side, from
    // its monotonic cursor. The shell then seats it. Reproduce that order.
    objects.push(snap(id, 400 + i * 80, 0, size));
    const adapter = fakeAdapter({ snapshots: objects, selectedId: 1 });
    const result = seatNewObjects(adapter, {
      newIds: [id],
      bedWidth,
      bedDepth,
      plateCount,
      selectedPlate: 0,
    });
    unseated += result.unseatedCount ?? 0;

    const seat = adapter.placed.at(-1);
    if (seat) {
      seats.push({ ...seat, size });
      objects[objects.length - 1] = snap(id, seat.offsetX, -seat.offsetY, size);
    } else {
      // Not seated: it stays where the engine put it, off the bed. Drop it
      // from the scene so the next duplicate is not blocked by a phantom.
      objects.pop();
    }
  }
  return { seats, unseated };
}

const insideBed = (seat, bed = 256) => {
  const half = (bed - 8 * 2) / 2;
  return Math.abs(seat.offsetX) + seat.size / 2 <= half + 1e-6
      && Math.abs(seat.offsetY) + seat.size / 2 <= half + 1e-6;
};

test("5: ten duplicates in a row all stay on the bed", () => {
  const { seats } = duplicateRepeatedly(10);
  assert.equal(seats.length, 10, "every duplicate should have found a seat on an empty 256mm bed");
  seats.forEach((seat, i) => {
    assert.ok(insideBed(seat), `duplicate ${i + 1} landed off the bed at (${seat.offsetX}, ${seat.offsetY})`);
  });
});

test("5: the bed is a real boundary — a full plate overflows, it never spills over the edge", () => {
  // THE DISCRIMINATING CASE. With 60mm objects a 256mm bed holds nine, so
  // asking for sixteen forces the planner to choose between placing copies
  // outside the printable area and reporting that they did not fit. The
  // engine's own behaviour — a cursor that only grows — is the former, which
  // is the bug. An earlier version of this test used small objects on an empty
  // bed and passed even with the bed bounds removed entirely.
  const { seats, unseated } = duplicateRepeatedly(16, { size: 60 });

  seats.forEach((seat, i) => {
    assert.ok(insideBed(seat), `copy ${i + 1} was placed outside the printable area at (${seat.offsetX}, ${seat.offsetY})`);
  });
  assert.ok(seats.length < 16, "sixteen 60mm objects cannot fit on one 256mm bed — something was placed that should not have been");
  assert.ok(unseated > 0, "what did not fit must be reported, not silently stacked or squeezed");
});

test("5: a narrow bed is respected too, not just the default one", () => {
  const { seats } = duplicateRepeatedly(6, { size: 40, bedWidth: 120, bedDepth: 120 });
  seats.forEach((seat, i) => {
    assert.ok(insideBed(seat, 120), `copy ${i + 1} escaped a 120mm bed at (${seat.offsetX}, ${seat.offsetY})`);
  });
});

test("5: copies never overlap each other", () => {
  const { seats } = duplicateRepeatedly(6);
  for (let i = 0; i < seats.length; i += 1) {
    for (let j = i + 1; j < seats.length; j += 1) {
      const apart = Math.abs(seats[i].offsetX - seats[j].offsetX) >= 20
                 || Math.abs(seats[i].offsetY - seats[j].offsetY) >= 20;
      assert.ok(apart, `copies ${i + 1} and ${j + 1} overlap`);
    }
  }
});

test("5: the engine bug being compensated for is still in the installed build", async () => {
  const engine = await readFile(engineUrl, "utf8");
  // The monotonic spawn cursor. If upstream ever fixes this, the seating can
  // be reconsidered — until then it is what makes it necessary.
  assert.match(engine, /_e\.position\.set\(Mt\.x \+ l\.current \+ Ke \/ 2, 0, Mt\.z\), l\.current \+= Ke \+ 8/);
});

// ====================================================================== 6
// Repeated slices do not accumulate workers.

/** Executes the release hook the patch adds, exactly as shipped. */
async function patchedReleaseHook({ slicePending, workerMoved }) {
  const engine = await readFile(engineUrl, "utf8");
  // The hook ends at its own `!0; }` — the patch line is quoted in full in
  // patches/three-slicer+0.2.2.patch, and the test below pins its shape.
  const match = engine.match(/window\.__vpReleaseWorker = (\(\) => \{[\s\S]*?!0; \})/);
  assert.ok(match, "the patched release hook is not present in the installed engine");

  const terminated = { count: 0 };
  const worker = { terminate: () => { terminated.count += 1; } };
  const other = { terminate: () => { throw new Error("the wrong worker was terminated"); } };
  const $ = { current: slicePending };            // slice-in-flight flag
  const r = { current: workerMoved ? other : worker }; // the live worker ref
  const N = { current: "prepared-mesh-identity" };     // the viewer's cache
  const win = { __vpWorker: worker };

  // eslint-disable-next-line no-new-func
  const hook = new Function("$", "r", "N", "k", "window", `return ${match[1]};`)($, r, N, worker, win);
  return { result: hook(), terminated, r, N, win };
}

test("6: the release hook refuses while a slice is in flight", async () => {
  const { result, terminated } = await patchedReleaseHook({ slicePending: true, workerMoved: false });
  assert.equal(result, false, "a release must never interrupt a slice");
  assert.equal(terminated.count, 0);
});

test("6: the release hook refuses once the engine has moved to another worker", async () => {
  const { result, terminated } = await patchedReleaseHook({ slicePending: false, workerMoved: true });
  assert.equal(result, false, "a stale hook must not terminate the current worker");
  assert.equal(terminated.count, 0);
});

test("6: a permitted release terminates exactly once and clears every reference", async () => {
  const { result, terminated, r, N, win } = await patchedReleaseHook({ slicePending: false, workerMoved: false });
  assert.equal(result, true);
  assert.equal(terminated.count, 1, "the worker is terminated once");
  assert.equal(r.current, null, "the engine's worker ref is cleared, so the next slice creates a fresh one");
  assert.equal(N.current, null, "the prepared-mesh cache is cleared with it — otherwise paint would break silently");
  assert.equal(win.__vpWorker, null);
});

test("6: the adapter only releases through the patched hook, and survives its absence", async () => {
  const { EngineAdapter, ENGINE_WINDOW_HOOKS } = await loadAppModule("engine-adapter");
  assert.ok(ENGINE_WINDOW_HOOKS.includes("__vpReleaseWorker"));

  const adapter = new EngineAdapter();
  const saved = globalThis.window;
  try {
    globalThis.window = {};
    assert.equal(adapter.releaseSlicerWorker(), false, "no hook means no release, not a crash");
    assert.equal(adapter.canReleaseSlicerWorker(), false);

    let calls = 0;
    globalThis.window = { __vpReleaseWorker: () => { calls += 1; return true; } };
    assert.equal(adapter.canReleaseSlicerWorker(), true);
    assert.equal(adapter.releaseSlicerWorker(), true);
    assert.equal(calls, 1);

    globalThis.window = { __vpReleaseWorker: () => { throw new Error("engine blew up"); } };
    assert.equal(adapter.releaseSlicerWorker(), false, "a throwing hook is a refusal, not a crash");
  } finally {
    if (saved === undefined) delete globalThis.window; else globalThis.window = saved;
  }
});

test("6: the patch is installed and pinned by patch-package", async () => {
  const [pkg, patch] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../patches/three-slicer+0.2.2.patch", import.meta.url), "utf8"),
  ]);
  const parsed = JSON.parse(pkg);
  assert.match(parsed.scripts.postinstall, /patch-package --error-on-fail/,
    "the patch must fail the install rather than vanish silently");
  assert.match(patch, /__vpReleaseWorker/);
  // This guard is about the release hook, and the hook rides on an existing
  // assignment rather than replacing it. The rest of the patch is reviewed by
  // tests/engine-patch.test.mjs, which owns the total count — so what is
  // checked here is that the worker-registration line is rewritten once and
  // that every OTHER rewrite is one somebody named.
  const removed = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const workerLines = removed.filter((line) => line.includes("window.__vpWorker = k"));
  assert.equal(workerLines.length, 1, "the worker-registration line is rewritten exactly once");
  const unaccounted = removed.filter((line) => !line.includes("window.__vpWorker = k") && !line.includes("keep_stages"));
  assert.deepEqual(unaccounted, [], "an engine line is being removed that no test here has reviewed");
});

// =================================================================== meta

test("meta: every lifted callback is still found, with the closure these tests stub", async () => {
  // If a callback is renamed or its closure grows, this fails here rather than
  // letting a test pass against a stale shape.
  const expected = {
    releaseSlicerWorkerIfSafe: ["sessionHasPaintRef", "adapter"],
    seatNewObjectsIfNeeded: ["seenObjectIdsRef", "everSeenObjectIdsRef", "orchestrator", "restoreInFlightRef",
      "suppressSeatingRef", "seatNewObjects", "adapter", "profile", "plateCountRef", "selectedPlateRef"],
    projectContentSignature: ["adapter", "sessionHasPaintRef", "settings", "objects", "plateCount"],
  };
  for (const [name, needed] of Object.entries(expected)) {
    const actual = await closureOf(name);
    for (const key of needed) {
      assert.ok(actual.includes(key), `${name} no longer reads ${key} — the guard may have changed shape`);
    }
  }
});
