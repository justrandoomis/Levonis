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
