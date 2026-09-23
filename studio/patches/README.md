# Engine patches (three-slicer)

`npm ci` re-downloads `node_modules/three-slicer` from the registry, so a hand
edit there disappears on the next install and on every CI run. Everything in
this folder is applied automatically by the `postinstall` script:

```json
"postinstall": "patch-package --error-on-fail"
```

`--error-on-fail` is deliberate. If a patch stops applying — because the
package was upgraded and the code it targets moved — the install FAILS. It
does not "apply with fuzz" and it does not warn and continue: a Studio build
that silently lost the worker-release hook would look fine and would start
killing workers on phones again, weeks later, with no signal.

## `three-slicer+0.2.2.patch` — release the idle slice worker

**One line changed**, purely additive: it exposes `window.__vpReleaseWorker`
alongside the `window.__vpWorker` handle the engine already publishes.

### Why the shell cannot do this without a patch

The viewer owns its slice worker in a closure ref (`r.current`) and only ever
terminates it on unmount:

```js
De(() => () => { r.current && (r.current.terminate(), r.current = null); }, [])
```

After a slice completes, the worker stays alive with its WASM heap resident —
and on the threaded kernel, with its whole `navigator.hardwareConcurrency`
pthread pool still spawned. WebAssembly memory never shrinks, so a phone that
sliced one large model is still holding that heap when the user slices the
next one, and the second slice is the one the OS kills.

The engine publishes `window.__vpWorker`, so the shell *can* reach the worker —
but terminating it from outside leaves `r.current` pointing at a dead worker.
The engine would then post the next slice into nothing and only find out 60
seconds later, through its watchdog. The one other route in, dispatching a
synthetic `error` event so the engine's own `onerror` cleans up, also shows the
user an out-of-memory banner for a release that was routine. Faking an error
to free memory is not a fix.

So the release has to be a real entry point, and that is what the patch adds.

### What the added function does

```js
window.__vpReleaseWorker = () => {
  if ($.current || r.current !== k) return false;   // never interrupt a running slice
  try { k.terminate(); } catch {}
  r.current = null;                                  // engine builds a fresh one on the next slice
  N.current = null;                                  // drop the SharedArrayBuffer views
  if (window.__vpWorker === k) window.__vpWorker = null;
  return true;
};
```

It refuses while a slice is pending and refuses if it is not the live worker,
so it can never truncate work. Terminating a worker also terminates the
sub-workers it owns, which is what actually returns the pthread pool.

The shell calls it only where releasing is right (`app/slicer-client.tsx`):
after an idle period on a memory-constrained device, and when the tab is
hidden. Desktop behaviour is unchanged — nothing calls it there, and the warm
kernel stays warm.

`tests/engine-patch.test.mjs` asserts the patch is present in the installed
build and that the shell only reaches it through the adapter.

## `three-slicer+0.2.2.patch` — cap the pthread pool

**Purely additive**: it adds `capPthreadPool()` to `engine/src/slicer.worker.js`
and calls it inside the branch that loads the threaded core, before the import.

### The crash

The owner photographed, on an Android phone in Chrome:

```
Worker terminated (likely out of memory): worker error
```

`slicer_core.mt.js` does, verbatim:

```js
initMainThread(){var pthreadPoolSize=typeof navigator!=="undefined"&&navigator.hardwareConcurrency||4;
  while(pthreadPoolSize--){PThread.allocateUnusedWorker()}
  addOnPreRun(async()=>{var r=PThread.loadWasmModuleToAllWorkers();addRunDependency("loading-workers");await r;removeRunDependency("loading-workers")})}
allocateUnusedWorker(){worker=new Worker(new URL("slicer_core.mt.js",import.meta.url),{type:"module",...})}
```

One module Worker per logical core, each fetching and parsing the same 5.28 MB
script, and all of it an `addRunDependency` — so it blocks *before* the kernel
reports ready. A Pixel 8 reports eight cores. The compiled module and the heap
are shared rather than re-instantiated, so the cost per pool worker is a V8
isolate plus that parse, which on a phone with a browser full of tabs is
enough.

### Why not simply stop telling Android it is isolated

That is the cheaper-looking fix and it is the wrong one. The engine picks its
core on one signal — `crossOriginIsolated` — so withholding COOP/COEP makes it
take the single-threaded build, which is what `worker/platform.ts` already does
for iOS and iPadOS.

But `slicer.worker.js` sends the support-progress and **cancel** pointers to
the main thread only when the buffer behind them is a `SharedArrayBuffer`:

```js
if (v && v.buffer instanceof SharedArrayBuffer)
  self.postMessage({ type: 'supsab', buf: v.buffer, ptr: v.byteOffset, cancelPtr: c ? c.byteOffset : 0 })
```

There is no equivalent on the single-threaded core. Dropping isolation on
Android would therefore take **slice cancellation and live support progress
away from every Android phone** — a feature loss rather than a slowdown — on
top of the threaded core's measured 2.2×.

iOS and iPadOS are a different case: WebKit's per-tab budget cannot carry the
threaded core at any pool size, so for them the core itself has to go. Android
can carry it; it just cannot carry eight of everything.

### Why the shell cannot do this without a patch

`initMainThread()` runs inside the slice worker's own global scope, reading
that worker's `navigator`. The shell is on the main thread and shares no scope
with it, and the worker is constructed by the viewer from a package URL, so
there is nowhere to pass an option in. Shadowing the property on the worker's
own `navigator` — from inside the worker, before the core is imported — is the
only seam. The pool workers the core then spawns do not re-run that branch, so
capping it once is enough.

### Why it is safe

`Object.defineProperty` on the instance shadows the prototype getter and
nothing else reads the value. The cap never raises a machine's count (`if (cap
>= cores) return`), so a two-core device is untouched, and a desktop keeps a
thread per core. `navigator.deviceMemory` is Chromium-only and is treated as a
signal only when present; the user-agent test covers the rest. Any failure —
a navigator that refuses to be shadowed — is caught and leaves the engine's own
default in place.

`tests/engine-patch.test.mjs` pins both halves: that the cap runs before the
threaded core is imported, and that `worker/platform.ts` still has **no**
Android branch. The second is the one that matters — without it, a later
"simplification" would remove cancellation from Android phones silently.

## `three-slicer+0.2.2.patch` — let a phone decline the stage cache

**One line changed**, and it restores the kernel's own default rather than
inventing a behaviour: `keep_stages` goes back to `false` when the shell asks
for it, and stays `true` for everyone else.

### The trade the viewer makes for you

The kernel's parameter table is explicit about what this flag costs:

| `keep_stages` | `boolean` | `false` | — | keep the stages cached after slicing (skips the early release — a memory trade-off) |

Default `false`. The viewer overrides it on every non-economy slice:

```js
function J(k, F) {
  k.economy || (k.keep_stages = !0, k.reuse_stages = F && F === w.current ? 2 : 0);
}
```

So the intermediate buffers of the slice that just finished are still resident
in the WASM heap when the next slice starts allocating on top of them, and
`reuse_stages: 2` on a re-slice of the same mesh is what buys the trade back:
the second run skips PASS1 and the surface stage.

### Why a phone must not make it

Releasing the idle worker (the first patch above) covers the user who walks
away. It does nothing for the loop this is actually about — slice, look at the
preview, change something, slice again — because there is no idle window in it
and nothing has been released. WebAssembly memory never shrinks, so on a phone
the second slice is handed a heap already holding a full set of stages, and it
is the one the OS kills.

The saving on the other side of the trade is a re-slice that is never reached.
A desktop keeps the cache and keeps the speedup; a constrained device takes the
kernel's default and finishes.

### Why the shell cannot do this without a patch

`keep_stages` is a *host runtime flag* — the engine README lists it beside
`economy` as a decision "the caller makes about a particular run" — but the
caller here is the viewer, not the app. The app's settings map reaches the
params through `sn(settings, …)` and `J()` runs **after** that and overwrites
whatever was there. The only value that suppresses the override is
`economy: true`, which would also drop the preview toolpaths and the time
estimate from every slice. There is no seam short of the patch.

### What the changed line does

```js
k.economy || (k.keep_stages = !(typeof window < "u" && window.__vpNoStageCache),
              k.reuse_stages = k.keep_stages && F && F === w.current ? 2 : 0);
```

With the flag unset — every desktop, and any build where the shell never sets
it — `!(false)` is `true` and `reuse_stages` is the engine's original
expression, so the behaviour is byte-for-byte what it was. With it set, both go
off together, which is not tidiness: `w.current` is still assigned the mesh
hash after a successful run, so leaving `reuse_stages` alone would ask the
kernel to reuse stages it had already released.

The shell sets it once per device from `app/device-profile.ts`, through
`adapter.setStageCacheAllowed()`, and the engine reads it while building the
next run's parameters.

## `three-slicer+0.2.2.patch` — let the retry ladder be seen

**Purely additive and purely a report.** It changes no parameter, no timeout
and no decision: the three attempts the engine already made, in the order it
already made them, now announce themselves.

### The silence

The owner's report was «الاستوديو يتوقف عند سبعة وثمانون وفي الأخير بعد فترة
كبيرة من الانتظار يظهر فشل» — the bar stops at 87, a long wait follows, and
then a failure. Every part of that is the engine working as designed, and none
of it was visible.

87% is not a hang. `Viewport.js` maps stage counts to a fraction, and the
stage before the last — `done === layers + 2`, labelled `support-done` —
is exactly 0.87. The bar reaching 87 means the slice *finished*: the layers are
computed and the supports are built. What follows is `emit`, the stage that
writes the G-code, and the only stage that allocates: measured on a 300 mm
cube the heap is flat at 16 MB through PASS1, surfaces and supports, then
~391 MB during emit.

The long wait is the ladder. On any failure `ie()` retries twice more —
classic walls, then economy — terminating the worker and re-booting the
5.28 MB kernel between rungs, and reporting nothing until all three are spent:

```js
try { return await L(k, …) }                                  // 1/3 full
catch { … try { return await L(k, {…, wall_generator: "classic"}) } catch {} // 2/3
        return { r: await L(k, {…, economy: true}), … } }                    // 3/3
```

Three silent minutes, then one sentence — `Slice failed (economy mode failed
too): …` — carrying only the THIRD error. The first two were caught and
dropped, and they are the ones that say what went wrong.

### What the patch adds

Each failed rung is timed and recorded, `window.__vpRungs` holds the log, a
`vp-retry` CustomEvent carries `{rung, seconds, message, index, total}`, and
the final throw appends the whole ladder to its message:

```
watchdog: no progress for 60000ms — attempts: 1/3 full failed after 63.2s: … |
2/3 classic-walls failed after 61.1s: … | 3/3 economy failed after 60.8s: …
```

**The durations are the diagnostic.** The watchdog interval collapses from
300 s to 60 s at the same tick that shows 87% — `We()` returns the long
interval only while `done` is in `[layers, layers+2)` — and every emitted
layer kicks it. So a rung that dies at ~60 s died with the worker already
unresponsive *during emit*; a rung that dies in a few seconds never reached
emit at all and failed while loading the kernel. Those are different faults
with different fixes, and before this patch nothing in the product could tell
them apart.

### Why the shell cannot do this without a patch

`ie()` is a closure inside the viewer component. The rungs never cross the
worker boundary — they are `try`/`catch` in the viewer's own code — so there
is no message for the shell to observe, and the engine's error callback fires
only once, after the third rung, with the third error. The only externally
visible symptom of a retry is that `progress` restarts, which is
indistinguishable from a slow first attempt.

### What the shell does with it

`app/engine-adapter.ts` exposes `onSliceRetry()` and `sliceRetryLog()`;
`app/hooks/use-slicing-state.ts` turns the events into `retryAttempt` /
`retryTotal`, resetting on the engine's single `slicing: true` (it fires once
per ladder, not per rung); the header shows `↻ 2/3` beside the percentage.
That suffix is a glyph and two numbers deliberately — the slicing status is
already a bare percentage, and `↻ 2/3` needs no Arabic, English or Sorani
wording for a translator to review.

An unpatched build never fires the event, `retryAttempt` stays 1, and the
header shows exactly what it shows today.

`tests/engine-patch.test.mjs` pins the rung reporting in the installed build
and the adapter's `__vpRungs` contract entry.

## `three-slicer+0.2.2.patch` — give the iPad a cancel that works

**Purely additive**, and it rides on the line that already publishes
`__vpReleaseWorker`, so it replaces no further engine line.

### The button that does nothing

The engine cancels a slice by writing a flag the kernel polls:

```js
_ = () => { const k = N.current;
  if (k != null && k.cancel) try { Atomics.store(k.cancel, 0, 1) } catch { k.cancel[0] = 1 } }
```

`N.current` is a view onto a **SharedArrayBuffer**, and the worker publishes
that buffer only when it has one:

```js
if (v && v.buffer instanceof SharedArrayBuffer)
  self.postMessage({ type: 'supsab', buf: v.buffer, ptr: v.byteOffset, cancelPtr: … })
```

A SharedArrayBuffer needs cross-origin isolation, and `worker/platform.ts`
withholds isolation from **every Apple user agent** on purpose, so the engine
takes its single-threaded core (WebKit's per-tab budget cannot carry the
threaded one). The consequence was never written down: on an iPad,
`N.current` is null, so «إلغاء» writes to nothing and the slice runs on. The
only way out of a stuck run was reloading the tab — on the owner's own test
device, on the screen they were stuck on at 87%.

That file's header comment states this trade for Android, where it argues
against dropping isolation *because* cancel would be lost. The same sentence
was true for iPad all along and went unsaid.

It is not only Apple. The `supsab` message is sent during the SUPPORT stage,
so a cancel pressed before that has no flag to write on **any** platform.

### What the patch adds

Two functions, beside the release hook:

```js
window.__vpCanCancel  = () => !!(N.current && N.current.cancel)
window.__vpAbortSlice = () => {
  const V = $.current; if (!V || r.current !== k) return false;   // nothing pending
  $.current = null; V.stop?.(); j(); N.current = null;            // watchdog + interpolators off
  k.terminate(); r.current = null;                                // engine rebuilds on next slice
  V.reject(new Error("slice canceled")); return true;
}
```

The cleanup is the watchdog path's own, in the same order — that path already
terminates the worker and nulls the refs, and `patches/README.md`'s warning
about leaving `r.current` pointing at a dead worker is exactly what nulling it
answers.

**"canceled" is load-bearing.** Both the retry ladder and the error handler
test the message with `.includes("canceled")`, so rejecting with that word is
what stops a *deliberate* cancel from being retried twice more and reported as
a failure. It surfaces as «تم إلغاء التقطيع», not as an error banner.

### Why the shell cannot do this without a patch

`$.current`, `r.current` and the interpolator handle are closure refs inside
the viewer component. The shell can reach the worker through `__vpWorker` and
terminate it, but the engine would keep a settled-looking pending run and post
the next slice into a dead worker — a 60-second wait for a watchdog. The
existing `__vpReleaseWorker` refuses precisely while a slice is pending,
because releasing and aborting are different acts and it is the safe one.

### What the shell does with it

`EngineAdapter.cancelSlice()` asks before it acts: with a live flag view it
clicks the engine's own control, so the kernel unwinds itself and the warm
5.28 MB core survives for the next slice; without one it aborts. The shell's
`triggerSlice` routes the cancel branch through it
(`app/slicer-client.tsx`), and an unpatched build falls back to the engine
button — the behaviour it has today.

`tests/engine-patch.test.mjs` pins both hooks, the contract entries, and that
the shell no longer clicks the engine's cancel directly.
