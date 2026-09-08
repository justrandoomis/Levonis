/**
 * RATE-LIMIT PARITY (`01-TARGET.md` §3.6, ADR-016).
 *
 * A gateway class that is TIGHTER than the bucket the core already enforces
 * for the same route is not a security improvement — it is an outage with a
 * 429 body. So every `rateLimit(c, bucket, limit, window)` call site in
 * `worker/routes/` is extracted, mapped to the prefix it is mounted under, and
 * compared with the class this gateway would apply there, in requests per
 * second (the only unit in which 10/10-min and 240/min are comparable).
 *
 * The extractor also counts the raw occurrences of `rateLimit(` so it cannot
 * quietly miss a call site and report parity over the ones it happened to
 * parse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASS_LIMITS, IP_CLASS_EXEMPT, effectiveSpec, isIpExempt, limitFor, ratePerSecond } from '../src/limiter';
import { matchRoute } from '../src/routes';
import { coreMounts, coreRateLimitCalls, countRateLimitCalls } from './_harness';

/**
 * Call sites whose limit is not a literal. Each needs a reason, because an
 * unparsable limit is the one case where this test cannot prove parity.
 */
const DYNAMIC_LIMITS: Record<string, string> = {
  'farm-mutate':
    'the limit is admin_settings.printerFarmConfig.limits.mutations_per_hour — a PER-HOUR budget, so any per-minute gateway class is looser by construction; /api/farm is the `user` class at 5/s',
};

/** Every prefix a route file is mounted under. */
function prefixesFor(file: string): string[] {
  return coreMounts()
    .filter((m) => m.file === `worker/${file}`)
    .map((m) => m.prefix);
}

test('the extractor sees every rateLimit( call site in worker/routes', () => {
  const calls = coreRateLimitCalls();
  assert.equal(calls.length, countRateLimitCalls(), 'a call site the extractor cannot parse would silently pass this suite');
  assert.ok(calls.length >= 120, `expected the core's 130-odd call sites, saw ${calls.length}`);
});

test('no gateway class is tighter than the core bucket over the same prefix', () => {
  const violations: string[] = [];
  const unmapped: string[] = [];
  for (const call of coreRateLimitCalls()) {
    if (call.limit === null || call.windowSeconds === null) {
      assert.ok(DYNAMIC_LIMITS[call.bucket], `${call.file}: ${call.bucket} has a non-literal limit and no recorded reason`);
      continue;
    }
    const prefixes = prefixesFor(call.file);
    if (prefixes.length === 0) {
      unmapped.push(`${call.file} (${call.bucket})`);
      continue;
    }
    const core = ratePerSecond({ limit: call.limit, windowSeconds: call.windowSeconds });
    for (const prefix of prefixes) {
      const rule = matchRoute(prefix, 'POST');
      assert.ok(rule, `${prefix} has no routing row`);
      const spec = limitFor(prefix, rule!.rateClass);
      const gw = ratePerSecond(spec);
      if (gw < core) violations.push(`${prefix} (${call.file} ${call.bucket} ${call.limit}/${call.windowSeconds} = ${core.toFixed(3)}/s) vs gateway ${spec.bucket} ${spec.limit}/${spec.windowSeconds} = ${gw.toFixed(3)}/s`);
    }
  }
  assert.deepEqual(unmapped, [], `these route files are not mounted anywhere the table knows: ${unmapped.join(', ')}`);
  assert.deepEqual(violations, [], `the gateway would throttle harder than the core does today:\n${violations.join('\n')}`);
});

test('the Telegram status poll keeps its 240/min — the regression this rule exists for', () => {
  const poll = coreRateLimitCalls().find((c) => c.bucket === 'tg-auth-status');
  assert.ok(poll, 'auth.ts still polls Telegram link status');
  assert.equal(poll!.limit, 240);
  assert.equal(poll!.windowSeconds, 60);
  const spec = limitFor('/api/auth/telegram/status', matchRoute('/api/auth', 'GET')!.rateClass);
  assert.ok(ratePerSecond(spec) >= ratePerSecond({ limit: 240, windowSeconds: 60 }), 'Iraqi carrier NAT puts many customers behind one IP and the SPA polls every 3 s');
});

test('Studio\'s server-to-server calls are not judged as one browser', () => {
  const redeem = coreRateLimitCalls().find((c) => c.bucket === 'studio-redeem');
  assert.ok(redeem);
  const spec = limitFor('/api/studio/handoff/redeem', matchRoute('/api/studio', 'POST')!.rateClass);
  assert.ok(ratePerSecond(spec) >= ratePerSecond({ limit: redeem!.limit!, windowSeconds: redeem!.windowSeconds! }));
});

test('an ip-exempt route keeps its own class rather than being left unlimited', () => {
  for (const path of IP_CLASS_EXEMPT) {
    const rule = matchRoute(path, 'POST');
    assert.ok(rule, path);
    const spec = limitFor(path, rule!.rateClass);
    assert.notEqual(spec.cls, 'ip', `${path} must not fall into the generic ip class`);
    assert.ok(spec.limit > 0, `${path} is still limited`);
  }
  assert.equal(isIpExempt('/api/studio/handoff/redeem'), true);
  assert.equal(isIpExempt('/api/products'), false);
});

test('the classes that have no counter today ship in shadow, and enforcement is a var', () => {
  assert.equal(CLASS_LIMITS.ip.mode, 'shadow');
  assert.equal(CLASS_LIMITS['public-read'].mode, 'shadow');
  for (const cls of ['auth', 'money', 'write', 'upload', 'admin-write', 'user', 'webhook'] as const) {
    assert.equal(CLASS_LIMITS[cls].mode, 'enforce', `${cls} exists in the core today and must keep enforcing`);
  }
  assert.equal(effectiveSpec(CLASS_LIMITS.ip, 'ip').mode, 'enforce');
  assert.equal(effectiveSpec(CLASS_LIMITS.ip, 'public-read').mode, 'shadow');
  assert.equal(effectiveSpec(CLASS_LIMITS.money, '').mode, 'enforce', 'configuration can only tighten, never switch a limit off');
});

test('a money or admin-write class keys by user, a public one by ip', () => {
  assert.equal(CLASS_LIMITS.money.keyBy, 'user');
  assert.equal(CLASS_LIMITS['admin-write'].keyBy, 'user');
  assert.equal(CLASS_LIMITS.write.keyBy, 'user');
  assert.equal(CLASS_LIMITS['public-read'].keyBy, 'ip');
  assert.equal(CLASS_LIMITS.ip.keyBy, 'ip');
});
