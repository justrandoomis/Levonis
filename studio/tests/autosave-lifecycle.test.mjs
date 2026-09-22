/**
 * TWO WAYS TO LOSE AN AFTERNOON'S WORK, both in the shell rather than in the
 * sync layer — which is why neither showed up in project-sync's own tests.
 *
 * 1. MOVING A MODEL WAS NOT AN EDIT. The only thing marking the session dirty
 *    watched `objects`, the settings, the preset and the project name. A
 *    transform is in none of them: the engine does not re-emit its objects
 *    event when a model is dragged, rotated or scaled. An hour spent
 *    arranging forty parts on the plate scheduled exactly zero saves, and
 *    nothing was written until a part happened to be added or deleted.
 *
 *    `onSceneEdit` is the adapter's own signal for precisely this and already
 *    existed — `use-slicing-state` subscribes to it to know a slice result
 *    has gone stale. The gesture that invalidates a slice is the gesture that
 *    changes what a save would write, so autosave listens to the same one
 *    rather than to a second notion of "edited".
 *
 * 2. NOTHING FLUSHED ON THE WAY OUT. `whenIdle()` in project-sync.ts is
 *    documented as the flush "before navigation/unload", and the shell never
 *    called anything of the sort. Safari discards a backgrounded tab whenever
 *    it likes; with a nine-second debounce on a constrained device,
 *    everything edited in the last nine seconds went with it.
 *
 * These are source contracts rather than a rendered React tree: there is no
 * DOM runner in this repository, and the properties that matter here are
 * structural — which signal is subscribed, which events are listened for,
 * what gates the work, and the ORDER two effects register their listeners in.
 *
 * Run: node --test studio/tests/autosave-lifecycle.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
const adapter = await readFile(new URL("../app/engine-adapter.ts", import.meta.url), "utf8");
const sync = await readFile(new URL("../app/project-sync.ts", import.meta.url), "utf8");

test("a transform gesture marks the session dirty", () => {
  const at = client.indexOf("adapter.onSceneEdit(");
  assert.ok(at > 0, "autosave subscribes to the adapter's scene-edit signal");
  const block = client.slice(at, at + 500);
  assert.match(block, /markDirty\(\)/, "and what it does with it is mark dirty");
});

test("it is the SAME signal a drag already fires, not a second one invented for saving", () => {
  // If these ever diverge, a gesture can invalidate a slice without
  // scheduling a save — which is the bug, back again under a new name.
  assert.match(adapter, /onSceneEdit\(listener: \(\) => void\): \(\) => void/);
  assert.match(adapter, /notifySceneEdited\(\): void/);
  assert.match(
    adapter,
    /sceneFingerprint\(\): string/,
    "and the fingerprint that lets an unchanged drag skip the capture still exists"
  );
});

test("a continuous drag cannot cost a save per frame", () => {
  // Three independent brakes, and the test names all three because removing
  // any one of them turns a drag into a 3MF export per frame on an iPad.
  assert.match(adapter, /if \(this\.sceneEditScheduled\) return;/, "the adapter coalesces per microtask");
  assert.match(client, /debounceMs: device\.autosaveDebounceMs/, "the debounce is cost-governed per device");
  assert.match(client, /contentSignature: \(\) => projectContentSignature\(\)/, "an unchanged scene skips the capture");
});

test("an empty scene, a running slice and a running import still schedule nothing", () => {
  const at = client.indexOf("const autosaveAllowed =");
  assert.ok(at > 0, "the guard is computed from render state");
  const guard = client.slice(at, at + 200);
  assert.match(guard, /objects\.length > 0/);
  assert.match(guard, /!orchestrator\.busy/);
  assert.match(guard, /status !== "slicing"/);

  const listener = client.slice(client.indexOf("adapter.onSceneEdit("), client.indexOf("adapter.onSceneEdit(") + 500);
  assert.match(listener, /!canAutosaveRef\.current/);
  assert.match(listener, /!projectFilesRef\.current\.length/, "and a scene with no imported files is not a project");
});

// ------------------------------------------------------------ the way out

test("the tab going away flushes a dirty session", () => {
  const at = client.indexOf("const flush = () => {");
  assert.ok(at > 0, "there is a flush");
  const block = client.slice(at, at + 900);
  assert.match(block, /if \(!syncDirtyRef\.current\) return;/, "a clean session pays nothing for a tab switch");
  assert.match(block, /void saveNow\(\)/, "and a dirty one saves");
  assert.match(block, /document\.addEventListener\("visibilitychange", onHide\)/);
  assert.match(block, /window\.addEventListener\("pagehide", flush\)/);
  assert.match(block, /document\.visibilityState !== "hidden"/, "only on the way out, not on the way back");
});

test("beforeunload is deliberately not used", () => {
  // The word appears in the comment explaining WHY it is not used; what must
  // not appear is a listener on it.
  assert.doesNotMatch(
    client,
    /addEventListener\(\s*"beforeunload"/,
    "iOS does not reliably deliver it, and relying on it is how this looked fixed without being fixed"
  );
  assert.match(client, /`beforeunload` is not reliable there/, "and the reason is written down, not folklore");
});

test("the flush is registered BEFORE the worker release, so it runs first", () => {
  // Both listen to `hidden`. Effects register in declaration order and the DOM
  // calls listeners in registration order, so the save must be declared first
  // or it would run after the WASM heap it may need has been handed back.
  const flush = client.indexOf('document.addEventListener("visibilitychange", onHide)');
  const release = client.indexOf('document.addEventListener("visibilitychange", onVisibilityChange)');
  assert.ok(flush > 0 && release > 0, "both handlers are still present");
  assert.ok(flush < release, "the save effect must stay above the worker-release effect");
});

test("the flush never blocks and never throws into the page", () => {
  const at = client.indexOf("const flush = () => {");
  const block = client.slice(at, at + 900);
  assert.doesNotMatch(block, /await saveNow/, "the OS may not give us the milliseconds; nothing pretends otherwise");
  assert.match(block, /\.catch\(\(\) => \{/, "and a failed flush is already in the sync status");
});

test("the sync layer's own flush contract is still the one being used", () => {
  assert.match(sync, /async saveNow\(\): Promise<void>/);
  assert.match(sync, /Lets the shell flush before navigation\/unload/);
  assert.match(sync, /dirty: boolean;/, "and `dirty` is what the flush gates on");
});
