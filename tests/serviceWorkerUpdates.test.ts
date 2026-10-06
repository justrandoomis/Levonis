import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { stampedServiceWorker, stampServiceWorker } from '../scripts/stamp-service-worker.mjs';
import { SW_UPDATE_CHECK_INTERVAL_MS, watchServiceWorkerUpdates } from '../src/lib/serviceWorkerUpdates';
import { ROOT } from './fixtures/d1';

const source = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');
const html = '<script type="module" src="/assets/index-a.js"></script>';
const manifest = JSON.stringify({ 'index.html': { file: 'assets/index-a.js' }, 'src/pages/Product.tsx': { file: 'assets/Product-a.js' } });

test('identical frontend builds produce identical worker bytes; a lazy route or document change changes them', () => {
  const first = stampedServiceWorker(source, html, manifest);
  assert.equal(stampedServiceWorker(source, html, manifest), first);
  assert.notEqual(stampedServiceWorker(source, html, manifest.replace('Product-a.js', 'Product-b.js')), first,
    'even a route not in the opening document announces a new frontend');
  assert.notEqual(stampedServiceWorker(source, html + '<meta name="release" content="next">', manifest), first);
  const inspect = (script: string) => {
    const self = { addEventListener() {}, location: { origin: 'https://levonis-iq.com' } } as Record<string, unknown>;
    vm.runInNewContext(script, { self });
    return self;
  };
  const old = inspect(source);
  const next = inspect(first);
  assert.deepEqual(Array.from((next.__LEVONIS_SW__ as { CURRENT_CACHES: string[] }).CURRENT_CACHES),
    Array.from((old.__LEVONIS_SW__ as { CURRENT_CACHES: string[] }).CURRENT_CACHES), 'a frontend update preserves hashed asset caches');
  assert.match(String(next.__LEVONIS_BUILD__), /^[a-f0-9]{20}$/);
});

test('the build stamps the output worker idempotently without rewriting its source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-sw-build-'));
  try {
    const dist = join(dir, 'dist');
    const original = join(dir, 'sw.js');
    mkdirSync(join(dist, '.vite'), { recursive: true });
    writeFileSync(original, source);
    writeFileSync(join(dist, 'index.html'), html);
    writeFileSync(join(dist, '.vite/manifest.json'), manifest);
    stampServiceWorker(dist, original);
    const first = readFileSync(join(dist, 'sw.js'), 'utf8');
    stampServiceWorker(dist, original);
    assert.equal(readFileSync(join(dist, 'sw.js'), 'utf8'), first);
    assert.equal(readFileSync(original, 'utf8'), source);
    assert.equal((first.match(/self\.__LEVONIS_BUILD__ =/g) ?? []).length, 1);
    assert.match(readFileSync(join(ROOT, 'scripts/write-asset-headers.mjs'), 'utf8'), /stampServiceWorker\(\)/,
      'both the normal build and the build-budget harness run the stamp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

class Page extends EventTarget {
  reloads = 0;
  location = { pathname: '/', reload: () => { this.reloads++; } };
}
class DocumentState extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('focus checks are throttled, coalesced and silent in a background tab', async () => {
  const page = new Page();
  const documentState = new DocumentState();
  let time = 0;
  let calls = 0;
  let finish: () => void = () => {};
  const registration = {
    waiting: null, installing: null,
    update: () => {
      calls++;
      return new Promise<void>((resolve) => { finish = resolve; });
    },
  };
  const stop = watchServiceWorkerUpdates(registration, page, documentState, () => time);
  page.dispatchEvent(new Event('focus'));
  assert.equal(calls, 0, 'registration already checked on boot');
  time = SW_UPDATE_CHECK_INTERVAL_MS;
  documentState.visibilityState = 'hidden';
  page.dispatchEvent(new Event('focus'));
  assert.equal(calls, 0);
  documentState.visibilityState = 'visible';
  documentState.dispatchEvent(new Event('visibilitychange'));
  page.dispatchEvent(new Event('focus'));
  assert.equal(calls, 1, 'the return-event burst performs one request');
  time += SW_UPDATE_CHECK_INTERVAL_MS;
  page.dispatchEvent(new Event('focus'));
  assert.equal(calls, 1, 'an unfinished check is never duplicated');
  finish(); await flush();
  page.dispatchEvent(new Event('focus'));
  assert.equal(calls, 2);
  finish(); await flush();
  stop();
  time += SW_UPDATE_CHECK_INTERVAL_MS;
  page.dispatchEvent(new Event('focus'));
  documentState.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 2, 'cleanup removes both observers');
});

test('returning to cart or checkout can discover an update without activating it or reloading', async () => {
  for (const path of ['/cart', '/checkout']) {
    const page = new Page(); page.location.pathname = path;
    const documentState = new DocumentState();
    let time = 0;
    let checks = 0;
    let messages = 0;
    const waiting = { postMessage: () => { messages++; } } as unknown as ServiceWorker;
    const registration = {
      waiting: null as ServiceWorker | null, installing: null,
      update: async () => {
        checks++;
        registration.waiting = waiting;
      },
    };
    const stop = watchServiceWorkerUpdates(registration, page, documentState, () => time);
    time = SW_UPDATE_CHECK_INTERVAL_MS;
    page.dispatchEvent(new Event('focus'));
    await flush();
    assert.equal(checks, 1);
    assert.equal(registration.waiting, waiting);
    assert.equal(page.reloads, 0, path);
    assert.equal(messages, 0, 'only the existing explicit update button may ask to activate');
    time += SW_UPDATE_CHECK_INTERVAL_MS;
    page.dispatchEvent(new Event('focus'));
    assert.equal(checks, 1, 'a waiting update needs no more network checks');
    stop();
  }
});

test('an offline update check can retry later and never fails the active page', async () => {
  const page = new Page();
  const documentState = new DocumentState();
  let time = 0;
  let checks = 0;
  const registration = { waiting: null, installing: null, update: async () => { checks++; throw new Error('offline'); } };
  const stop = watchServiceWorkerUpdates(registration, page, documentState, () => time);
  time += SW_UPDATE_CHECK_INTERVAL_MS;
  page.dispatchEvent(new Event('focus'));
  await flush();
  time += SW_UPDATE_CHECK_INTERVAL_MS;
  page.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(checks, 2);
  assert.equal(page.reloads, 0);
  stop();
});
