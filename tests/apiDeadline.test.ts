/**
 * THE REQUEST DEADLINE HAS TO COVER THE WHOLE REQUEST.
 *
 * `await fetch(...)` settles when the response HEADERS arrive. Everything
 * after that — the body — is a second await, and for a long time it ran with
 * no deadline and no signal at all. A server or proxy that emitted headers and
 * then stopped sending produced a promise that never settled.
 *
 * That is worse than a slow request in a way that is easy to miss. Every
 * loading flag in this app is released in a `finally`, and a `finally` cannot
 * run for a promise that does not settle — so ONE stalled body froze
 * `AuthContext`'s isLoaded, Home's critical-ready flag and the pages' busy
 * flags for the life of the tab. Downstream, the mascot's whole bootstrap
 * branch keys off exactly those flags, which is how it came to sit at its
 * 320px introduction size in the middle of a page that had finished loading.
 *
 * These tests drive the real client against a fake `fetch`, so they pin the
 * behaviour rather than the shape of the code.
 *
 * Run: npm run test:unit
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/lib/api';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A response whose headers have arrived and whose body never will. The signal
 *  is honoured the way a real body read honours it: by rejecting on abort. */
function stalledBody(init: { status?: number } = {}) {
  globalThis.fetch = ((_input: unknown, opts: RequestInit = {}) => {
    const signal = opts.signal;
    const res = {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      json: () => new Promise((_resolve, reject) => {
        if (!signal) return; // no deadline reaches it at all — the old defect
        if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    };
    return Promise.resolve(res as unknown as Response);
  }) as typeof fetch;
}

test('a response whose body never arrives fails instead of hanging for ever', async () => {
  stalledBody();
  const started = Date.now();
  await assert.rejects(
    api.get('/api/fixture/stalled', { timeoutMs: 120 }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError, `got ${String(error)}`);
      // The deadline is a real failure the customer can see and retry, so it
      // travels as the ordinary network error rather than as a cancellation.
      assert.equal(error.status, 0);
      assert.notEqual(error.code, 'ABORTED');
      return true;
    },
  );
  // And it failed on the DEADLINE, not on some unrelated immediate throw.
  assert.ok(Date.now() - started >= 100, 'the deadline was actually waited out');
});

test('a stalled body on an error response also fails, rather than hiding the error', async () => {
  stalledBody({ status: 500 });
  await assert.rejects(api.get('/api/fixture/stalled-500', { timeoutMs: 120 }), ApiError);
});

test('the caller cancelling during the body read is a cancellation, not a failure', async () => {
  stalledBody();
  const caller = new AbortController();
  // Long deadline: the only thing that can end this request is the caller, so
  // a test that passes here cannot be passing because of the timer.
  const pending = api.get('/api/fixture/stalled-cancel', { signal: caller.signal, timeoutMs: 30_000 });
  setTimeout(() => caller.abort(), 40);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'ABORTED');
    return true;
  });
});

test('an ordinary response still succeeds, and a malformed body is still reported as one', async () => {
  globalThis.fetch = (() => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({ success: true, value: 7 }),
  } as unknown as Response)) as typeof fetch;
  assert.deepEqual(await api.get('/api/fixture/ok'), { success: true, value: 7 });

  globalThis.fetch = (() => Promise.resolve({
    ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  } as unknown as Response)) as typeof fetch;
  await assert.rejects(api.get('/api/fixture/html'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    // Not an abort and not a network error: the server answered, badly.
    assert.equal(error.status, 200);
    assert.match(error.message, /Invalid server response/);
    return true;
  });
});

test('a refusal keeps its status, code and details through the new control flow', async () => {
  globalThis.fetch = (() => Promise.resolve({
    ok: false, status: 409, json: () => Promise.resolve({
      success: false, error: 'Stock changed', code: 'STOCK_CONFLICT', details: { productId: 'p1' },
    }),
  } as unknown as Response)) as typeof fetch;
  await assert.rejects(api.post('/api/fixture/conflict', {}), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'STOCK_CONFLICT');
    assert.equal(error.message, 'Stock changed');
    return true;
  });
});

test('the deadline is cleared on the happy path — a settled request leaves no timer behind', async () => {
  const live = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = realSet(fn, ms);
    live.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => { live.delete(id); return realClear(id as never); }) as typeof clearTimeout;
  try {
    globalThis.fetch = (() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({ success: true }),
    } as unknown as Response)) as typeof fetch;
    await api.get('/api/fixture/timer');
    assert.equal(live.size, 0, 'a settled request must not leave its deadline armed');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});
