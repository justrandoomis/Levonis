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
