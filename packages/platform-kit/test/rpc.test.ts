import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, BreakerRegistry, createRpcClient, createBudget, RpcTimeoutError, type Timers } from '../src/rpc';
import { TransientError, KitError } from '../src/errors';
import type { RpcCtx } from '@levonis/contracts/rpc/common';
import { testIdentity } from './_keys';

/** A controllable clock + timers so nothing in these tests waits on real time. */
function fakeTime(start = 1_000_000) {
  let now = start;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const t: Timers = {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    clock: { now: () => now },
    timers: t,
    pending: () => timers.length,
    /** waits until the async call under test has registered its timeout timer (signing is async) */
    async settle() {
      for (let i = 0; i < 1000 && timers.length === 0; i++) await new Promise((r) => setImmediate(r));
    },
    advance(ms: number) {
      now += ms;
      for (const x of [...timers].sort((a, b) => a.at - b.at)) {
        if (x.at <= now) {
          timers.splice(timers.indexOf(x), 1);
          x.fn();
        }
      }
    },
    sleep: async (_ms: number) => {},
  };
}

test('circuit breaker: opens after 5 consecutive failures, half-open after 30 s with one trial, closes on success', () => {
  const ft = fakeTime();
  const b = new CircuitBreaker({}, ft.clock);
  for (let i = 0; i < 4; i++) {
    assert.ok(b.tryAcquire());
    b.onFailure();
  }
  assert.equal(b.state, 'closed');
  assert.ok(b.tryAcquire());
  b.onFailure();
  assert.equal(b.state, 'open');
  assert.equal(b.tryAcquire(), false, 'open refuses');
  ft.advance(29_999);
  assert.equal(b.state, 'open');
  ft.advance(1);
  assert.equal(b.state, 'half_open');
  assert.ok(b.tryAcquire(), 'one trial passes');
  assert.equal(b.tryAcquire(), false, 'a second concurrent trial does not');
  b.onFailure();
  assert.equal(b.state, 'open', 'a failed trial re-opens');
  ft.advance(30_000);
  assert.ok(b.tryAcquire());
  b.onSuccess();
  assert.equal(b.state, 'closed');
  assert.equal(b.consecutiveFailures, 0);
});

interface LedgerLike {
  credit(cmd: unknown, ctx: RpcCtx): Promise<unknown>;
  forward(req: unknown, ctx: RpcCtx): Promise<unknown>;
  getBalances(userId: string, ctx: RpcCtx): Promise<unknown>;
}

async function client(target: object, extra: Partial<Parameters<typeof createRpcClient>[1]> = {}) {
  const id = await testIdentity('commerce');
  const ft = fakeTime();
  const registry = new BreakerRegistry({}, ft.clock);
  const calls: Array<{ method: string; ok: boolean; attempt: number }> = [];
  const c = createRpcClient<LedgerLike>(target, {
    service: 'ledger', entrypoint: 'LedgerEntrypoint', signer: { iss: 'commerce', key: id.key }, cid: 'cid-1', principalHeader: 'p.q.r',
    breakers: registry, clock: ft.clock, timers: ft.timers, sleep: ft.sleep, onCall: (i) => calls.push({ method: i.method, ok: i.ok, attempt: i.attempt }), ...extra,
  });
  return { c, ft, registry, calls };
}

test('the client attaches a signed ctx as the last argument and returns the result', async () => {
  const seen: RpcCtx[] = [];
  const { c } = await client({ credit: async (cmd: unknown, ctx: RpcCtx) => (seen.push(ctx), { ok: true, cmd }) });
  const r = (await c.credit({ eventKey: 'k' })) as { ok: boolean };
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cid, 'cid-1');
  assert.equal(seen[0].principal, 'p.q.r');
  assert.equal(seen[0].hop.method, 'LedgerEntrypoint.credit');
  assert.equal(seen[0].hop.iss, 'commerce');
});

test('retries only idempotent methods on transient failures, never a mutating forward; each attempt gets a fresh nonce', async () => {
  let n = 0;
  const nonces = new Set<string>();
  const { c, calls } = await client({
    credit: async (_cmd: unknown, ctx: RpcCtx) => {
      nonces.add(ctx.hop.nonce);
      if (++n < 3) throw new TransientError('flaky');
      return 'ok';
    },
    forward: async () => {
      throw new TransientError('down');
    },
  });
  assert.equal(await c.credit({}), 'ok');
  assert.equal(n, 3);
  assert.equal(nonces.size, 3, 'a retry re-signs with a fresh nonce');
  await assert.rejects(() => c.forward({}), TransientError);
  assert.equal(calls.filter((x) => x.method === 'LedgerEntrypoint.forward').length, 1, 'a non-idempotent call is attempted once');
  // a non-transient error is not retried either
  let m = 0;
  const { c: c2 } = await client({ credit: async () => { m++; throw new KitError(409, 'reused', 'EVENT_KEY_REUSED'); } });
  await assert.rejects(() => c2.credit({}), (e: unknown) => e instanceof KitError && e.code === 'EVENT_KEY_REUSED');
  assert.equal(m, 1);
});

test('an open breaker fails fast with 503 DEPENDENCY_UNAVAILABLE and heals after 30 s', async () => {
  let down = true;
  const { c, ft, registry } = await client({ credit: async () => { if (down) throw new TransientError('down'); return 'ok'; } }, { retries: 0 });
  for (let i = 0; i < 5; i++) await assert.rejects(() => c.credit({}), TransientError);
  assert.equal(registry.for('ledger', 'credit').state, 'open');
  await assert.rejects(() => c.credit({}), (e: unknown) => e instanceof KitError && e.code === 'DEPENDENCY_UNAVAILABLE' && e.status === 503);
  down = false;
  ft.advance(30_000);
  assert.equal(await c.credit({}), 'ok');
  assert.equal(registry.for('ledger', 'credit').state, 'closed');
});

test('the budget times a slow callee out (and the timeout counts as a failure)', async () => {
  const { c, ft, registry } = await client({ getBalances: () => new Promise(() => {}) }, { budgetMs: 3_000, retries: 0 });
  const p = c.getBalances('usr_01');
  const rejected = assert.rejects(p, RpcTimeoutError);
  await ft.settle();
  assert.equal(ft.pending(), 1, 'the timeout timer is armed');
  ft.advance(3_000);
  await rejected;
  assert.equal(registry.for('ledger', 'getBalances').consecutiveFailures, 1);
  // a request-scoped budget that is already spent refuses immediately
  const spent = createBudget(0, ft.clock);
  const { c: c2 } = await client({ getBalances: async () => 'never' }, { budget: spent });
  await assert.rejects(() => c2.getBalances('x'), RpcTimeoutError);
});
