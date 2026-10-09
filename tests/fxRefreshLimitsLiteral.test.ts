/**
 * THE FX REFRESH LIMITS ARE LITERALS AT THEIR CALL SITES, AND EQUAL TO THE
 * EXPORTED CONSTANTS (FX programme plan §8, critique F4; ADR-016 parity).
 *
 * services/gateway/test/rateLimitParity.test.ts reads every `rateLimit(` call
 * in worker/routes from the source and compares its limit and window with the
 * gateway class over the same prefix. An imported constant is a number it
 * cannot read, so worker/routes/adminPricing.ts writes the two refresh buckets
 * as literals. worker/lib/fx/limits.ts still exports the values, because the
 * owner panel's day budget (dto.ts) and its count (read.ts) read the global
 * bucket back by name, key and window: this file fails the moment a literal
 * and its constant drift apart, which would leave the panel counting a bucket
 * the route no longer charges.
 *
 * Run: node --import tsx --test tests/fxRefreshLimitsLiteral.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  FX_REFRESH_BUCKET,
  FX_REFRESH_GLOBAL_BUCKET,
  FX_REFRESH_GLOBAL_KEY,
  FX_REFRESH_GLOBAL_LIMIT,
  FX_REFRESH_GLOBAL_WINDOW_S,
  FX_REFRESH_LIMIT,
  FX_REFRESH_WINDOW_S,
} from '../worker/lib/fx/limits';

const SOURCE = readFileSync(join(ROOT, 'worker/routes/adminPricing.ts'), 'utf8');

/** The same reading the gateway parity harness does (services/gateway/test/_harness.ts). */
function calls() {
  const re = /rateLimit\s*\(\s*c\s*,\s*(?:'([^']*)'|`([^`]*)`|([A-Za-z_$][\w$.]*))\s*,\s*([^,]+?)\s*,\s*([^,)]+?)\s*(?:,\s*([^,)]+?)\s*)?\)/g;
  const num = (s: string): number | null => {
    const n = Number.parseInt(s.replace(/_/g, ''), 10);
    return Number.isFinite(n) && String(n) === s.replace(/_/g, '').trim() ? n : null;
  };
  return [...SOURCE.matchAll(re)].map((m) => ({
    bucket: m[1] ?? m[2] ?? null,
    identifier: m[3] ?? null,
    limit: num(m[4]!),
    windowSeconds: num(m[5]!),
    key: m[6] ?? null,
  }));
}

test('every rateLimit( call in adminPricing.ts names its bucket, limit and window as literals the parity test can read', () => {
  const found = calls();
  assert.equal(found.length, (SOURCE.match(/rateLimit\s*\(/g) ?? []).length, 'a call the reading cannot parse would pass unseen');
  assert.ok(found.length >= 2, 'both refresh buckets are charged here');
  for (const call of found) {
    assert.equal(call.identifier, null, `a bucket named by an identifier: ${JSON.stringify(call)}`);
    assert.notEqual(call.limit, null, `a limit that is not a literal: ${JSON.stringify(call)}`);
    assert.notEqual(call.windowSeconds, null, `a window that is not a literal: ${JSON.stringify(call)}`);
  }
});

test('the per-user refresh bucket at its call site is the exported one: 10 an hour', () => {
  const user = calls().filter((c) => c.bucket === FX_REFRESH_BUCKET);
  assert.equal(user.length, 1);
  assert.deepEqual(user[0], { bucket: FX_REFRESH_BUCKET, identifier: null, limit: FX_REFRESH_LIMIT, windowSeconds: FX_REFRESH_WINDOW_S, key: null });
  assert.deepEqual([FX_REFRESH_LIMIT, FX_REFRESH_WINDOW_S], [10, 3600]);
});

test('the shop-wide refresh bucket at its call site is the exported one: 40 a day, under the explicit key the panel counts', () => {
  const shop = calls().filter((c) => c.bucket === FX_REFRESH_GLOBAL_BUCKET);
  assert.equal(shop.length, 1);
  assert.deepEqual(shop[0], {
    bucket: FX_REFRESH_GLOBAL_BUCKET,
    identifier: null,
    limit: FX_REFRESH_GLOBAL_LIMIT,
    windowSeconds: FX_REFRESH_GLOBAL_WINDOW_S,
    key: 'FX_REFRESH_GLOBAL_KEY',
  });
  assert.deepEqual([FX_REFRESH_GLOBAL_LIMIT, FX_REFRESH_GLOBAL_WINDOW_S, FX_REFRESH_GLOBAL_KEY], [40, 86_400, 'global']);
});
