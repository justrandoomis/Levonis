/**
 * THE TWO PROVIDERS, HARDENED (FX programme plan §3, §5, §6; critiques F4,
 * F5, F6, F7; security review S4, S5).
 *
 * IQWealth (USD/IQD) is keyed: the key has ONE reader, travels only in the
 * X-API-Key header to one fixed host, follows no redirect, and never appears
 * in an error, a log, a row or an answer. The ECB file (EUR/USD, CNY/USD) is
 * read by strict regexes, never an XML parser. Every hostile body ends INVALID
 * or STALE and is never applied; an older publication never replaces a newer
 * one. Nothing here touches the network: every call goes to an injected fake.
 *
 * Run: node --import tsx --test tests/fxProviders.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { freshDb } from './fixtures/app';
import { GOOD_KEY, ecbBody, fakeProviders, fxEnv, iqwealthBody, json200, logsOf, pairOf, xml200, applyRate } from './fixtures/fx';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { parseEcbBody } from '../worker/lib/fx/providers/ecb';
import { parseIqwealthBody, iqwealthRequest, IQWEALTH_URL } from '../worker/lib/fx/providers/iqwealth';

const NOW = new Date('2026-10-08T13:00:00.000Z');
const TICK = new Date('2026-10-08T12:00:00.000Z');

async function refreshUsd(raw = freshDb(), f = fakeProviders(), env = fxEnv(raw), deadlineMs?: number) {
  const report = await runFxScheduler(env, { now: NOW }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: f.fetch, deadlineMs });
  return { raw, f, report, row: pairOf(raw, 'USD_IQD') };
}

function dumpAllRows(raw: ReturnType<typeof freshDb>): string {
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => JSON.stringify(raw.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

test('IQWealth: the key travels only in X-API-Key, never the URL — to the one fixed host, redirects not followed', async () => {
  const { f, row } = await refreshUsd();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, IQWEALTH_URL);
  assert.equal(f.calls[0]!.headers['x-api-key'], GOOD_KEY);
  assert.doesNotMatch(f.calls[0]!.url, new RegExp(GOOD_KEY));
  assert.equal(f.calls[0]!.redirect, 'manual', 'fetchWithBudget follows redirects itself, and maxRedirects 0 follows none');
  assert.equal(row.status, 'REVIEW_REQUIRED', 'the first value waits for the owner');
});

test('no key → NOT_CONFIGURED and no request', async () => {
  const raw = freshDb();
  const { f, row } = await refreshUsd(raw, fakeProviders(), fxEnv(raw, { IRAQ_PARALLEL_FX_API_KEY: undefined }));
  assert.equal(f.calls.length, 0);
  assert.equal(row.fetch_status, 'NOT_CONFIGURED');
  assert.equal(row.last_error_code, 'KEY_MISSING');
  assert.equal(row.effective_rate, null);
});

test('secret with CR/LF → KEY_MALFORMED, no fetch, no key bytes in logs, DB rows or the answer', async () => {
  const secret = 'iqw_live_SECRETBYTES_9f8e7d\r\nX-Evil: 1';
  const raw = freshDb();
  const logged: string[] = [];
  const keep = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a: unknown[]) => logged.push(a.map(String).join(' '));
  console.warn = console.error;
  console.log = console.error;
  let report;
  try {
    ({ report } = await refreshUsd(raw, fakeProviders(), fxEnv(raw, { IRAQ_PARALLEL_FX_API_KEY: secret })));
  } finally {
    Object.assign(console, keep);
  }
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_error_code, 'KEY_MALFORMED');
  assert.equal(row.fetch_status, 'NOT_CONFIGURED');
  for (const text of [logged.join('\n'), dumpAllRows(raw), JSON.stringify(report)]) assert.doesNotMatch(text, /SECRETBYTES/);
});

test('401 → KEY_REJECTED; 403 → KEY_REJECTED; 429 → QUOTA; 500 after its one retry → HTTP_500', async () => {
  for (const [status, code, calls] of [[401, 'KEY_REJECTED', 1], [403, 'KEY_REJECTED', 1], [429, 'QUOTA', 1], [500, 'HTTP_500', 1], [503, 'HTTP_503', 2]] as const) {
    const f = fakeProviders({ usd: () => new Response('{"error":"no"}', { status }) });
    const { row } = await refreshUsd(freshDb(), f);
    assert.equal(row.last_error_code, code, String(status));
    assert.equal(row.fetch_status, 'FAILED');
    assert.equal(f.calls.length, calls, `${status}: ${calls} request(s)`);
  }
});

test('a 302 is not followed (BAD_UPSTREAM → REDIRECT_REFUSED; one request, and no request to the redirect target)', async () => {
  const f = fakeProviders({ usd: () => new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } }) });
  const { row } = await refreshUsd(freshDb(), f);
  assert.equal(row.last_error_code, 'REDIRECT_REFUSED');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls.every((c) => new URL(c.url).hostname === 'iraqsm.com'));
});

test('unit change → INVALID (FX_UNIT_CHANGED); stale flag → STALE', async () => {
  let r = await refreshUsd(freshDb(), fakeProviders({ usd: () => json200(iqwealthBody({ unit: 'USD per 1 IQD' })) }));
  assert.equal(r.row.last_check_result, 'INVALID');
  assert.equal(r.row.last_error_code, 'FX_UNIT_CHANGED');
  r = await refreshUsd(freshDb(), fakeProviders({ usd: () => json200(iqwealthBody({ stale: true })) }));
  assert.equal(r.row.last_check_result, 'STALE');
  assert.equal(r.row.fetch_status, 'STALE');
});

test('publishedAt in the future → INVALID (FX_FUTURE); older than 72 hours → STALE', async () => {
  let r = await refreshUsd(freshDb(), fakeProviders({ usd: () => json200(iqwealthBody({ publishedAt: '2026-10-08T13:06:00Z' })) }));
  assert.equal(r.row.last_check_result, 'INVALID');
  assert.equal(r.row.last_error_code, 'FX_FUTURE');
  r = await refreshUsd(freshDb(), fakeProviders({ usd: () => json200(iqwealthBody({ publishedAt: '2026-10-08T13:04:00Z' })) }));
  assert.equal(r.row.last_check_result, 'REVIEW_HELD', 'within the 5-minute tolerance');
  r = await refreshUsd(freshDb(), fakeProviders({ usd: () => json200(iqwealthBody({ publishedAt: '2026-10-05T12:00:00Z' })) }));
  assert.equal(r.row.last_check_result, 'STALE');
  assert.equal(r.row.last_error_code, 'FX_TOO_OLD');
});

test('publishedAt with a parenthesised payload is stored normalised (24 chars) or refused — the provider text is never stored', async () => {
  const short = 'Thu, 08 Oct 2026 12:41:58 GMT (hi)';
  let r = await refreshUsd(freshDb(), fakeProviders({ usd: () => json200(iqwealthBody({ publishedAt: short })) }));
  assert.equal(r.row.published_at, '2026-10-08T12:41:58.000Z');
  assert.equal(String(r.row.published_at).length, 24);
  const long = `Thu, 08 Oct 2026 12:41:58 GMT (${'x'.repeat(200)})`;
  r = await refreshUsd(freshDb(), fakeProviders({ usd: () => json200(iqwealthBody({ publishedAt: long })) }));
  assert.equal(r.row.last_check_result, 'INVALID');
  assert.equal(r.row.last_error_code, 'FX_INVALID_TIME');
  assert.doesNotMatch(dumpAllRows(r.raw), /xxxxxxxx/);
});

test('an older publishedAt than stored → STALE (FX_NOT_MONOTONIC), not applied; the same time with another figure → INVALID', async () => {
  const raw = freshDb();
  applyRate(raw, 'USD_IQD', '1660', '2026-10-08T06:00:00.000Z', '2026-10-08T12:41:58.000Z');
  let r = await refreshUsd(raw, fakeProviders({ usd: () => json200(iqwealthBody({ sell: 1670, publishedAt: '2026-10-08T11:00:00Z' })) }));
  assert.equal(r.row.last_check_result, 'STALE');
  assert.equal(r.row.last_error_code, 'FX_NOT_MONOTONIC');
  assert.equal(r.row.effective_rate, '1660');
  r = await refreshUsd(raw, fakeProviders({ usd: () => json200(iqwealthBody({ sell: 1670, publishedAt: '2026-10-08T12:41:58Z' })) }));
  assert.equal(r.row.last_check_result, 'INVALID');
  assert.equal(r.row.last_error_code, 'FX_PUBLICATION_CONFLICT');
  assert.equal(r.row.effective_rate, '1660');
  r = await refreshUsd(raw, fakeProviders({ usd: () => json200(iqwealthBody({ sell: 1660, publishedAt: '2026-10-08T12:41:58Z' })) }));
  assert.equal(r.row.last_check_result, 'UNCHANGED', 'the same publication and figure is only a check');
});

test('body over 32 KiB → TOO_LARGE (declared or streamed)', async () => {
  const big = JSON.stringify({ unit: 'IQD per 1 USD', pad: 'x'.repeat(40_000) });
  let r = await refreshUsd(freshDb(), fakeProviders({ usd: () => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } }) }));
  assert.equal(r.row.last_error_code, 'TOO_LARGE');
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (let i = 0; i < 10; i++) ctl.enqueue(new TextEncoder().encode('x'.repeat(5000)));
      ctl.close();
    },
  });
  r = await refreshUsd(freshDb(), fakeProviders({ usd: () => new Response(stream, { status: 200 }) }));
  assert.equal(r.row.last_error_code, 'TOO_LARGE');
});

test('a trickling body is cut at the deadline (TIMEOUT); no second request within the lease', async () => {
  let cancelled = false;
  const f = fakeProviders({
    usd: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(ctl) {
            ctl.enqueue(new TextEncoder().encode('{"unit":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 }
      ),
  });
  const raw = freshDb();
  const started = Date.now();
  const { row } = await refreshUsd(raw, f, fxEnv(raw), 150);
  assert.ok(Date.now() - started < 5000, 'the run ends at its deadline, not the 8-second header timeout');
  assert.equal(row.last_error_code, 'TIMEOUT');
  assert.equal(f.calls.length, 1);
  assert.ok(cancelled, 'the reader is cancelled');
  assert.equal(row.lease_token, null, 'the lease is released by the commit');
});

test('the 151st provider call of a UTC day makes no request and records PROVIDER_BUDGET (and a refresh stops at 140)', async () => {
  const raw = freshDb();
  raw.exec("UPDATE fx_rate_pairs SET provider_calls_day = '2026-10-08', provider_calls_count = 149 WHERE pair = 'USD_IQD'");
  const f = fakeProviders();
  const report = await runFxScheduler(fxEnv(raw), { now: NOW, scheduledTime: TICK }, { trigger: 'cron', fetchImpl: f.fetch });
  assert.deepEqual(report.budgetDeferred, ['USD_IQD']);
  assert.ok(f.calls.every((c) => new URL(c.url).hostname !== 'iraqsm.com'), 'no IQWealth request');
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_check_result, 'DEFERRED');
  assert.equal(row.last_error_code, 'PROVIDER_BUDGET');
  assert.equal(row.provider_calls_count, 149, 'nothing reserved for a refused claim');
  assert.equal(logsOf(raw, 'USD_IQD').at(-1)!.error_code, 'PROVIDER_BUDGET');
  // A refresh may use 140: at 139 it is refused (139 + 2 > 140); a new UTC day starts again.
  const raw2 = freshDb();
  raw2.exec("UPDATE fx_rate_pairs SET provider_calls_day = '2026-10-08', provider_calls_count = 139 WHERE pair = 'USD_IQD'");
  const g = fakeProviders();
  const r2 = await runFxScheduler(fxEnv(raw2), { now: NOW }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: g.fetch });
  assert.deepEqual(r2.budgetDeferred, ['USD_IQD']);
  assert.equal(g.calls.length, 0);
  raw2.exec("UPDATE fx_rate_pairs SET provider_calls_day = '2026-10-07' WHERE pair = 'USD_IQD'");
  await runFxScheduler(fxEnv(raw2), { now: NOW }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: g.fetch });
  assert.equal(g.calls.length, 1);
  assert.equal(pairOf(raw2, 'USD_IQD').provider_calls_count, 2, 'the new day counts from the attempt and its retry');
});

test('static: iqwealth.ts is the only reader of IRAQ_PARALLEL_FX_API_KEY and always passes maxRedirects: 0', () => {
  const readers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && /(\.|\[['"])IRAQ_PARALLEL_FX_API_KEY\b/.test(readFileSync(p, 'utf8'))) readers.push(relative(ROOT, p));
    }
  };
  for (const d of ['worker', 'src', 'packages', 'services']) walk(join(ROOT, d));
  assert.deepEqual(readers, ['worker/lib/fx/providers/iqwealth.ts']);
  const src = readFileSync(join(ROOT, 'worker/lib/fx/providers/iqwealth.ts'), 'utf8');
  assert.match(src, /maxRedirects: 0/);
  assert.match(src, /'X-API-Key': key/);
  assert.doesNotMatch(src, /console\./, 'the adapter logs nothing');
  const transport = readFileSync(join(ROOT, 'worker/lib/fx/providers/transport.ts'), 'utf8');
  assert.match(transport, /maxRedirects: 0;/, 'the transport type admits no other value');
  assert.doesNotMatch(transport.replace(/^\s*(\*|\/\/).*$/gm, ''), /\.message\b/, 'no error message is ever read');
});

// ------------------------------------------------------------- the ECB file

test('ECB regex parse of the real 2026-10-08 file: E = 1.1186, C = ceil10(1.1186 / 7.4972)', () => {
  const r = parseEcbBody(ecbBody());
  assert.equal(r.kind, 'quote');
  if (r.kind !== 'quote') return;
  assert.equal(r.quote.usdPerEur, '1.1186');
  assert.equal(r.quote.cnyPerEur, '7.4972');
  assert.equal(r.quote.cnyUsd, '0.1492023689');
  assert.equal(new Date(r.quote.publishedAtMs).toISOString(), '2026-10-08T00:00:00.000Z');
});

test('DOCTYPE/entity payload is not expanded; two USD rows, a missing CNY row and out-of-range figures are INVALID', () => {
  const entity = `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>${ecbBody({ usd: '&lol2;' })}`;
  assert.deepEqual(parseEcbBody(entity), { kind: 'invalid', code: 'FX_INVALID_SHAPE' });
  assert.deepEqual(parseEcbBody(ecbBody({ extra: "<Cube currency='USD' rate='1.2000'/>" })), { kind: 'invalid', code: 'FX_INVALID_SHAPE' });
  assert.deepEqual(parseEcbBody(ecbBody({ cny: '' })), { kind: 'invalid', code: 'FX_INVALID_SHAPE' });
  assert.deepEqual(parseEcbBody(ecbBody({ usd: '2.5' })), { kind: 'invalid', code: 'FX_RATE_OUT_OF_BOUNDS' });
  assert.deepEqual(parseEcbBody(ecbBody({ cny: '13.1' })), { kind: 'invalid', code: 'FX_RATE_OUT_OF_BOUNDS' });
  assert.deepEqual(parseEcbBody(ecbBody({ day: '2026-02-31' })), { kind: 'invalid', code: 'FX_INVALID_TIME' });
});

test('a missing CNY row → INVALID, and an 8-day-old Cube date → STALE, through the scheduler', async () => {
  let raw = freshDb();
  let f = fakeProviders({ ecb: () => xml200(ecbBody({ cny: '' })) });
  await runFxScheduler(fxEnv(raw), { now: NOW }, { trigger: 'refresh', pairs: ['EUR_USD', 'CNY_USD'], fetchImpl: f.fetch });
  assert.equal(pairOf(raw, 'CNY_USD').last_check_result, 'INVALID');
  assert.equal(pairOf(raw, 'EUR_USD').last_check_result, 'INVALID', 'one file: both pairs refuse it');
  raw = freshDb();
  f = fakeProviders({ ecb: () => xml200(ecbBody({ day: '2026-09-30' })) });
  await runFxScheduler(fxEnv(raw), { now: NOW }, { trigger: 'refresh', pairs: ['EUR_USD', 'CNY_USD'], fetchImpl: f.fetch });
  assert.equal(pairOf(raw, 'EUR_USD').last_check_result, 'STALE');
  assert.equal(pairOf(raw, 'EUR_USD').last_error_code, 'FX_TOO_OLD');
  raw = freshDb();
  f = fakeProviders({ ecb: () => xml200(ecbBody({ day: '2026-10-09' })) });
  await runFxScheduler(fxEnv(raw), { now: NOW }, { trigger: 'refresh', pairs: ['EUR_USD'], fetchImpl: f.fetch });
  assert.equal(pairOf(raw, 'EUR_USD').last_error_code, 'FX_FUTURE', 'a Cube dated after today (UTC)');
});

// ------------------------------------------------------------- S5: hostile bodies

test('S5: fuzzed provider bodies all end INVALID, STALE or FAILED — and none is ever applied', async () => {
  const bodies: Array<[string, string]> = [
    ['"1660" as a string', iqwealthBody({ sell: '1660' })],
    ['negative', iqwealthBody({ sell: -1660 })],
    ['zero', iqwealthBody({ sell: 0 })],
    ['1e309', '{"unit":"IQD per 1 USD","parallel":{"sell":1e309,"publishedAt":"2026-10-08T12:41:58Z"}}'],
    ['nested arrays', iqwealthBody({ sell: [[1660]] })],
    ['object', iqwealthBody({ sell: { value: 1660 } })],
    ['missing unit', JSON.stringify({ parallel: { sell: 1660, publishedAt: '2026-10-08T12:41:58Z' } })],
    ['no parallel', JSON.stringify({ unit: 'IQD per 1 USD' })],
    ['not JSON', '<html>maintenance</html>'],
    ['a JSON array', '[1660]'],
    ['future', iqwealthBody({ publishedAt: '2027-01-01T00:00:00Z' })],
    ['no time', iqwealthBody({ publishedAt: undefined })],
    ['out of bounds', iqwealthBody({ sell: 99_999 })],
    ['tiny', iqwealthBody({ sell: 0.00001 })],
  ];
  for (const [what, body] of bodies) {
    const raw = freshDb();
    applyRate(raw, 'USD_IQD', '1660');
    const { row } = await refreshUsd(raw, fakeProviders({ usd: () => json200(body) }));
    assert.ok(['INVALID', 'STALE', 'FAILED'].includes(String(row.last_check_result)), `${what}: ${row.last_check_result}`);
    assert.equal(row.effective_rate, '1660', `${what}: never applied`);
    assert.equal(row.pending_effective_rate, null, `${what}: never held`);
  }
  // The pure parser agrees on the shape codes.
  assert.deepEqual(parseIqwealthBody('{"data":{"unit":"IQD per 1 USD","parallel":{"sell":1660.25,"publishedAt":"2026-10-08T12:41:58Z"}}}').kind, 'quote', 'the same document under a data envelope');
});

test('iqwealthRequest never runs a request for a missing or malformed key', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return json200(iqwealthBody());
  }) as typeof fetch;
  const signal = new AbortController().signal;
  assert.deepEqual(await iqwealthRequest({}, signal, fetchImpl), { kind: 'error', code: 'KEY_MISSING' });
  assert.deepEqual(await iqwealthRequest({ IRAQ_PARALLEL_FX_API_KEY: '   ' }, signal, fetchImpl), { kind: 'error', code: 'KEY_MISSING' });
  assert.deepEqual(await iqwealthRequest({ IRAQ_PARALLEL_FX_API_KEY: 'short' }, signal, fetchImpl), { kind: 'error', code: 'KEY_MALFORMED' });
  assert.deepEqual(await iqwealthRequest({ IRAQ_PARALLEL_FX_API_KEY: 'a key with spaces in it!' }, signal, fetchImpl), { kind: 'error', code: 'KEY_MALFORMED' });
  assert.equal(calls, 0);
  assert.equal((await iqwealthRequest({ IRAQ_PARALLEL_FX_API_KEY: `  ${GOOD_KEY}  ` }, signal, fetchImpl)).kind, 'quote', 'the secret is trimmed');
  assert.equal(calls, 1);
});
