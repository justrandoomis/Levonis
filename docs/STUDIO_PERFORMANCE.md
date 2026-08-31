# LEVO Studio — Worker OOM, duplicate placement, mobile lag

Three reported failures, their root causes, and what was measured before and
after each fix.

- **"Worker terminated (likely out of memory): worker error"**, photographed on
  a project with *nothing loaded*.
- **Duplicating a model eventually throws the copy far away**, while there is
  free room right next to the original.
- **Severe lag on mobile.**

Everything below is evidence from this repository and from a real browser
running a real build. Nothing here is an estimate.

---

## 1. What is fixable in the shell, and what needed the engine

The mandate asked for this split explicitly, so it comes first.

| # | Cause | Where it lives | Fixed |
|---|---|---|---|
| 1 | The 5 MB WASM kernel is loaded at page **mount** — on an isolated page that means a 4 GiB shared reservation plus one Worker per logical core, each compiling the module, before anything is on the bed | Engine, but gated by a **prop the shell passes** (`features.warmup`) | **Shell** — `app/device-profile.ts` + `app/slicer-client.tsx` |
| 2 | The slice worker is never released; its WASM heap and pthread pool stay resident for the tab's life | Engine only — the worker lives in a closure ref the shell cannot reach safely | **Engine patch** — `patches/three-slicer+0.2.2.patch` |
| 3 | The shell kept each plate's G-code as a JS string on the main thread | Shell | **Shell** — `app/hooks/use-slicing-state.ts` |
| 4 | Autosave ran a full 3MF export + canvas read-back + SHA-256 over the whole file on every edit *signal*, not every edit | Shell | **Shell** — `app/project-sync.ts` + `app/slicer-client.tsx` |
| 5 | New objects are placed from a cursor that only grows and never resets | Engine, but every position is correctable through the engine's own `placeObjectOnPlate` | **Shell** — `app/spawn-seating.ts` + `app/engine-adapter.ts` |
| 6 | Inline `features` / `defaultExtruderColors` / `onSliced` literals handed the engine new prop identities on every shell render | Shell | **Shell** — `app/slicer-client.tsx` |
| 7 | The engine's render loop kept drawing during long non-visual main-thread work (the autosave export) | Engine, but it **exposes** `suspendRendering` for exactly this | **Shell** — `app/engine-adapter.ts` |

Only #2 could not be done from the shell. It is one added line, applied by
`patch-package --error-on-fail` at `postinstall`, so it survives `npm ci` and a
version bump fails the install loudly instead of silently reverting. See
`studio/patches/README.md`.

---

## 2. Root causes, with the source

### 2.1 The OOM on an empty project

`three-slicer`'s viewer warms the kernel on mount, gated on one prop
(`viewer/dist/Viewport.js`):

```js
De(() => { if (q !== !1) try { D().postMessage({ cmd: "warmup", quiet: W }) } catch {} }, [])
```

`q` is `features.warmup`. The worker's own comment says what that costs:
*"Warmup: only load the kernel (+ spawn the mt pthread pool) ahead of time"*.

On a cross-origin-isolated page the kernel is `slicer_core.mt.js`, and the
glue that ships in the package says the rest
(`engine/src/slicer_core.mt.js`, verbatim):

```js
var INITIAL_MEMORY = 16777216
wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true })

var pthreadPoolSize = typeof navigator !== "undefined" && navigator.hardwareConcurrency || 4
while (pthreadPoolSize--) PThread.allocateUnusedWorker()
addOnPreRun(async () => { … await PThread.loadWasmModuleToAllWorkers() … })
```

`maximum: 65536` pages is a **4 GiB shared reservation**, and the pool spawns
**one extra Worker per logical core**, instantiating the 5 MB module in every
one of them before the kernel reports ready.

So the crash on "a project with nothing loaded" was never about loading a
model. Opening the page was the expensive part.

### 2.2 The worker that is never released

The viewer terminates its slice worker only on unmount:

```js
De(() => () => { r.current && (r.current.terminate(), r.current = null); }, [])
```

WebAssembly memory never shrinks, so after one large slice the heap stays
resident — which is why the *second* slice is the one that dies on a phone.
The shell can see the worker (`window.__vpWorker`) but terminating it from
outside would leave the engine's own `r.current` pointing at a dead worker,
and the engine would only find out sixty seconds later through its watchdog.
The other route in — dispatching a synthetic `error` event so the engine's
`onerror` cleans up — shows the user an out-of-memory banner for a routine
release. Faking an error to free memory is not a fix, so this one is a patch.

### 2.3 The duplicate that walks off the bed

Every object the engine spawns without an explicit position is placed from one
monotonic cursor (`viewer/dist/Viewport.js`, the `ut` helper that
`spawnSnapshot` — Duplicate, Paste, Split — calls):

```js
const Ke = (Ae.boundingBox.max.x - Ae.boundingBox.min.x) * (R ? Math.abs(R.x) : 1)
a.current.length === 0 && (l.current = 0)
const Mt = $(o.current)
_e.position.set(Mt.x + l.current + Ke / 2, 0, Mt.z), l.current += Ke + 8
```

`l.current` only grows, and only resets when the scene becomes completely
empty. It does not know the bed's width, does not know the user moved the last
copy elsewhere, and does not know the space beside the original is free.

The shell now computes the position itself — the free spot nearest the source,
inside the printable area, overlapping nothing — and puts the copy there via
the engine's own `placeObjectOnPlate`. That fixes every route at once (the
toolbar button, the engine's context menu, Ctrl+K, paste, and a file dropped
on the canvas), it is pure geometry Node can test exactly, and it does not
depend on the shape of a minified expression a version bump would change.

A split is deliberately excluded: it removes an object and adds its parts *at
their original positions*, which is the point of splitting. The shell tells the
two apart by whether an id also disappeared.

### 2.4 What autosave really cost

`runSave` captured first and checked second:

1. click `save-project` → the engine merges every object's geometry, writes the
   3MF XML and deflates it, on the main thread;
2. read the WebGL canvas back for a thumbnail;
3. SHA-256 the whole file — which needs the entire multi-megabyte snapshot in
   one `ArrayBuffer`;
4. write it all to IndexedDB.

The content hash that decides whether to *upload* is computed from the file
step 1 already produced, so it could only ever skip the network. Meanwhile the
shell marks the session dirty from an effect watching the objects array and the
settings object — a signal on every engine `objects` event and every settings
identity change, far more often than the project changes.

`contentSignature` now runs first, from the scene fingerprint, the plate count,
the preset choice, the settings map and the project name. When it matches the
last completed full save, nothing is captured, hashed, written or uploaded.
It can only ever skip work that would have produced identical bytes: a degraded
(source-only) save, a failed local write and a failed upload all clear the mark
so the next run does the whole thing again.

---

## 3. Measured

### 3.1 In a real browser, against a real build

`studio/tests/perf-browser-editor.mjs` — Chromium against `npm run build` +
`wrangler dev`. Report: `studio/tests/perf-browser-editor.latest.json`.

The desktop row is the behaviour Studio has always had, on every device.

| Page load | desktop (= before) | phone (= after) |
|---|---|---|
| Workers constructed | **1** (`slicer.worker-*.js`) | **0** |
| Slice worker alive with an empty bed | **yes** | **no** |
| Cross-origin isolated | true | false (pre-existing Apple mitigation) |
| Time to an interactive editor | 481 ms | 477 ms |
| Renderer RSS after load | **+127.9 MB** | **+117.1 MB** |
| Worker-release hook present | yes | (no worker to release yet) |

Android phones still receive `Cross-Origin-Embedder-Policy: require-corp`
(verified by request) — they keep threads, they keep Cancel, and their *before*
was the threaded kernel with its full pthread pool at page load. They now
construct zero workers until they slice.

**Deferred, not disabled** — same run, phone path:

| | workers constructed |
|---|---|
| at page load | 0 |
| after importing `tests/fixtures/cube-10mm.stl` | 0 |
| after pressing Slice | **1**, and the engine logs `[slicer.worker] core: st` |

**Duplicate placement**, ten presses of the editor's own Duplicate. The
engine's duplicate is synchronous and the shell re-seats on the objects event a
task later, so one run yields both numbers with no rebuild and no straw man.
A 10 mm cube imported into an empty project, plate centre `(0, 0)`, 256 × 256
bed:

| | copies off the bed | furthest from the original |
|---|---|---|
| BEFORE (engine cursor) | **4 / 10** | **185 mm** |
| AFTER (shell seating) | **0 / 10** | **32 mm** |

```
BEFORE  [23,0] [41,0] [59,0] [77,0] [95,0] [113,0] [131,0] [149,0] [167,0] [185,0]
AFTER   [0,16] [-16,0] [16,0] [0,-16] [-16,16] [16,16] [-16,-16] [16,-16] [0,32] [-32,0]
```

The BEFORE row is the reported bug exactly: the copies march away along +X at
`z = 0`, ignoring both the bed edge and the original's position. The AFTER row
is a 16 mm grid — the cube plus the packer's 6 mm gap — closing in around it.

(An earlier run of the same script, with the source sitting in the bed's
front-left corner instead of the middle, measured 4/10 off the bed at up to
321.3 mm before and 0/10 at up to 48 mm after. Where the original sits changes
the numbers; it does not change the shape of either row.)

### 3.2 Main-thread memory held by stored slice results

`studio/tests/perf-browser-memory.mjs` — nine plates (the engine's cap) of
20 MB of G-code, per-process RSS from `/proc` after a forced GC. Report:
`studio/tests/perf-browser-memory.latest.json`.

| Nine plates of G-code held as… | renderer RSS |
|---|---|
| JS strings (before) | **+188.7 MB** |
| Blobs (after) | **+2.3 MB** |

The same 180 MB is still available — it moved to the browser process
(+182.6 MB there), which is blob storage and can spill to disk. The renderer is
where the tab's JS heap and the slice worker compete for one budget, and that
budget is the one the OOM message comes from.

A note for anyone re-running this: real G-code is millions of *distinct* lines.
`line.repeat(n)` is not a model of it — V8 can represent a repeat as a cons
tree over one shared leaf, the 20 MB never exists, and the measurement reads
zero. The script builds genuinely different coordinates per line.

### 3.3 What a minute of editing costs

`studio/tests/perf-shell.mjs` drives the real `ProjectSyncController` through a
scripted minute: four drag bursts of five signals 800 ms apart, twelve isolated
signals 4 s apart, and four real content changes. Report:
`studio/tests/perf-shell.latest.json`.

| One minute of editing, 12 MB project | 3MF exports | thumbnails | draft writes | bytes exported | bytes hashed |
|---|---|---|---|---|---|
| BEFORE | 16 | 16 | 16 | 192.0 MB | 192.0 MB |
| AFTER, desktop | **4** | **4** | **4** | **48.0 MB** | **48.0 MB** |
| AFTER, constrained device | **4** | **4** | **4** | **48.0 MB** | **48.0 MB** |

Four is the number of times the project actually changed. Everything above it
was work that produced bytes identical to the previous save.

### 3.4 Page-load cost, from the installed engine

Also in `perf-shell.mjs`, read out of the shipped WASM glue:

| | 8-core phone, before | 8-core phone, after | 16-core desktop, after |
|---|---|---|---|
| Workers at page load | 9 | **0** | 17 (unchanged) |
| Module instantiations | 9 | **0** | 17 (unchanged) |
| Kernel bytes fetched at load | 5.0 MB | **0** | 5.0 MB (unchanged) |

### 3.5 On the deployed worker

Same script, run against `https://levonis-studio-staging.just-randoomis.workers.dev/`
after `4 - Deploy Studio Staging`:

| Page load | desktop (= before) | phone (= after) |
|---|---|---|
| Workers constructed | **1** | **0** |
| Slice worker alive with an empty bed | **yes** | **no** |
| Time to an interactive editor | 1105 ms | **570 ms** |
| Renderer RSS after load | **+145.7 MB** | **+112.6 MB** |
| Worker-release hook present | yes | (no worker to release yet) |

Deferred, not disabled: **0 workers at load, 0 after importing the fixture, 1
the moment Slice was pressed**, with the engine logging
`[slicer.worker] core: st`.

Duplicate placement, ten presses: **4/10 off the bed at up to 185 mm before,
0/10 at up to 32 mm after** — the same numbers as the local build, on the
deployed worker.

### 3.6 …and on every staging deploy from here on

`4 - Deploy Studio Staging` now runs `tests/perf-browser-editor.mjs` against
the URL it just deployed and **fails the deploy** on any of:

- a phone constructing a slicer worker at page load (the kernel is being warmed
  again),
- pressing Slice not starting one (the deferral has become a removal),
- a duplicate landing off the bed,
- the worker-release patch missing from the built bundle.

The measurement is uploaded as a run artifact and printed into the run summary,
so the numbers for the live worker are on the record for every deploy rather
than only in this document. The check runs as a guest — it imports a fixture
and slices client-side and never signs in — so nothing is written to the
staging database or bucket.

---

## 4. What did NOT change, deliberately

- **Desktops keep the warm kernel.** Nothing about their load path changed.
- **No feature was disabled.** A constrained device loads the identical kernel
  the moment it slices — measured in §3.1.
- **No geometry accuracy was traded.** Nothing in the export or slice path was
  touched; the seating only moves objects the engine had just spawned.
- **No renderer, scene system or architecture was replaced.**
- **No OOM retry was added.** The engine has its own downgrade ladder; the
  worker release refuses while a slice is pending and is never used as a cancel.
- **Android phones keep cross-origin isolation**, and with it the threaded
  kernel and a working Cancel (the cancel flag lives in a SharedArrayBuffer, so
  withholding isolation would have removed it).
- **Existing layouts are never rearranged.** Seating touches only the objects
  that just appeared; a restore, an undo and an archive import are all excluded.
- **Nothing that does not fit is squeezed.** An object with no room is left
  where the engine put it and reported, never scaled, rotated or stacked.
- **A lone object still lands in the middle of the plate.** The free-corner
  search offers the centred position as well as the flush ones, so importing a
  single model does not push it into a corner — a regression the live
  measurement caught before this shipped.

---

## 5. Remaining hard limits

- **iOS could not be measured here.** The container has Chromium only. The
  Apple path is exercised by user agent (`tests/device-profile.test.mjs`) and
  by the response headers, but the numbers in §3 are Chromium's.
- **The owner's own device is still the last word.** Every number here is from
  a browser under automation. Whether the crash is gone on the iPad it was
  photographed on is not something this repository can prove, and is not
  claimed.
- **Cancel does not work without cross-origin isolation.** The engine's cancel
  flag lives in a SharedArrayBuffer, which only exists on the threaded kernel.
  That is why isolation was *not* withheld from Android — but it means iOS and
  Safari, which have never had isolation, still cannot cancel a running slice.
  Fixing that needs an engine change (a terminate-based cancel path).
- **WebAssembly memory never shrinks.** Releasing the worker is the only way to
  give a grown heap back, and that costs a kernel recompile on the next slice.
  It is therefore done only on constrained devices after an idle period, and
  when the tab is hidden.
- **The engine's placement cursor is still wrong upstream.** The shell corrects
  every position it produces, but a host embedding `three-slicer` without this
  shell would still see copies walk off the bed.
- **The threaded kernel's 4 GiB shared reservation is not configurable.** It is
  compiled into the glue. Only the choice between the `mt` and `st` cores is
  available, and that is made by the isolation headers.
- **Nine plates is the engine's real cap.** `PLATE_CAP = 9`, pinned against the
  installed build in `tests/arrange.test.mjs`.

---

## 6. Files

| File | What it does |
|---|---|
| `studio/app/device-profile.ts` | Decides whether this device pays for the kernel up front. Pure; `tests/device-profile.test.mjs`. |
| `studio/app/spawn-seating.ts` | Free-corner placement for newly spawned objects. Pure; `tests/spawn-seating.test.mjs`. |
| `studio/app/engine-adapter.ts` | `seatNewObjects`, `releaseSlicerWorker`, `suspendRendering`, and the engine contract lists the tests verify. |
| `studio/app/hooks/use-slicing-state.ts` | Stored G-code is a Blob, not a string. |
| `studio/app/project-sync.ts` | `contentSignature` gate before the expensive capture. |
| `studio/app/hooks/use-project-persistence.ts` | Passes the signature and the per-device debounce through. |
| `studio/app/slicer-client.tsx` | Warmup gating, stable engine props, seating, worker lifecycle, render suspension. |
| `studio/patches/three-slicer+0.2.2.patch` | One added line: `window.__vpReleaseWorker`. |
| `studio/patches/README.md` | Why the patch exists and why `--error-on-fail`. |
| `studio/tests/perf-shell.mjs` | Autosave, page-load and placement cost, in Node. |
| `studio/tests/perf-browser-editor.mjs` | The three failures, measured in Chromium against a real build. |
| `studio/tests/perf-browser-memory.mjs` | Renderer RSS held by stored slice results. |
