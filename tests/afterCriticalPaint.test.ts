import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { afterCriticalPaint, allowsSpeculativeLoads } from '../src/lib/afterCriticalPaint';

const names = ['window', 'document', 'navigator'] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
afterEach(() => {
  for (const name of names) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function environment({ offscreen = false } = {}) {
  const frames = new Map<number, FrameRequestCallback>(), idle = new Map<number, () => void>();
  let serial = 0;
  const fonts = deferred(), decoded = deferred();
  const image = Object.assign(new EventTarget(), {
    complete: false, naturalWidth: 640,
    getBoundingClientRect: () => ({ top: offscreen ? 1800 : 180, bottom: offscreen ? 2100 : 480, left: 0, right: 350, width: 350, height: 300 }),
    decode: () => decoded.promise,
  });
  const window = Object.assign(new EventTarget(), {
    innerHeight: 800, innerWidth: 400,
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++serial; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    requestIdleCallback: (callback: () => void) => { const id = ++serial; idle.set(id, callback); return id; },
    cancelIdleCallback: (id: number) => idle.delete(id),
    matchMedia: () => ({ matches: false }),
  });
  const document = { readyState: 'loading', fonts: { ready: fonts.promise }, images: [image] };
  const navigator = { connection: { saveData: false, effectiveType: '4g' } };
  for (const [name, value] of Object.entries({ window, document, navigator })) Object.defineProperty(globalThis, name, { value, configurable: true });
  const paint = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
  const rest = () => { const callbacks = [...idle.values()]; idle.clear(); callbacks.forEach(callback => callback()); };
  return { image, window, document, navigator, fonts, decoded, frames, idle, paint, rest };
}

test('idle preloads wait for visible image load and decoding after document/fonts, then a painted frame', async () => {
  const env = environment(); let started = 0;
  const cancel = afterCriticalPaint(() => { started++; });
  env.window.dispatchEvent(new Event('load')); env.fonts.resolve();
  await flush(); assert.equal(env.frames.size, 0, 'the LCP photograph is still downloading');
  env.image.complete = true; env.image.dispatchEvent(new Event('load'));
  await flush(); assert.equal(env.frames.size, 0, 'decode still owns the image');
  env.decoded.resolve(); await flush();
  assert.equal(started, 0); env.paint(); assert.equal(env.idle.size, 0);
  env.paint(); assert.equal(env.idle.size, 1); assert.equal(started, 0);
  env.rest(); assert.equal(started, 1); cancel();
});

test('an offscreen unfinished image cannot stall useful idle work, and leaving before idle cancels it', async () => {
  const env = environment({ offscreen: true }); let started = 0;
  const cancel = afterCriticalPaint(() => { started++; });
  env.window.dispatchEvent(new Event('load')); env.fonts.resolve(); await flush();
  env.paint(); env.paint(); assert.equal(env.idle.size, 1);
  cancel(); env.rest(); assert.equal(started, 0);
});

test('leaving during a pending image/font wait never queues work on the next screen', async () => {
  const env = environment(); let started = 0;
  const cancel = afterCriticalPaint(() => { started++; });
  cancel(); env.fonts.resolve(); env.decoded.resolve(); await flush();
  env.paint(); env.paint(); env.rest();
  assert.equal(started, 0); assert.equal(env.frames.size, 0); assert.equal(env.idle.size, 0);
});

test('save-data and very slow connections disable speculation; ordinary data still permits it', () => {
  const env = environment(); assert.equal(allowsSpeculativeLoads(), true);
  env.navigator.connection.saveData = true; assert.equal(allowsSpeculativeLoads(), false);
  env.navigator.connection.saveData = false; env.navigator.connection.effectiveType = '2g'; assert.equal(allowsSpeculativeLoads(), false);
  env.navigator.connection.effectiveType = 'slow-2g'; assert.equal(allowsSpeculativeLoads(), false);
  env.navigator.connection.effectiveType = '4g'; env.window.matchMedia = () => ({ matches: true }); assert.equal(allowsSpeculativeLoads(), false);
});
