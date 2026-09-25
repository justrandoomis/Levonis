/**
 * REVIEW W2-5 p2 — THE STOREFRONT BEACON'S «NETWORK» IS AN IPv6 /64.
 *
 * The per-network anonymous cap (50 visitors / store / day) and the
 * 240/minute rate limit were keyed on the FULL client address, so one phone
 * rotating privacy addresses inside its own /64 counted as that many
 * networks. Both are now keyed on `networkOf(ip)`: IPv4 unchanged, IPv6 its
 * /64 (IPv4-mapped IPv6 is the IPv4 address).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, row } from './fixtures/app';
import { seedW2E } from './fixtures/merchantW2E';
import { storefrontEventRoutes, networkOf } from '../worker/routes/storefrontEvents';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const vid = (i: number) => `probevisitor${String(i).padStart(8, '0')}`;

test('networkOf: IPv4 as is, IPv6 as its /64, IPv4-mapped as IPv4', () => {
  assert.equal(networkOf('203.0.113.9'), '203.0.113.9');
  assert.equal(networkOf('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(networkOf('2001:0DB8:0001:0002:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(networkOf('[2001:db8:1:2::ab]'), '2001:db8:1:2::/64');
  assert.equal(networkOf('2001:db8:1:3::1'), '2001:db8:1:3::/64');
  assert.equal(networkOf('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(networkOf('not-an-ip'), 'not-an-ip');
});

test('120 addresses of ONE /64 with 120 fresh visitor ids count as one network — capped like one address', async () => {
  const raw = seedW2E(freshDb());
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/storefront/events', storefrontEventRoutes));
  for (let i = 0; i < 120; i++) {
    const res = await post(app, '/api/storefront/events', { event: 'store_view', store: 's1', visitor: vid(i) }, { 'CF-Connecting-IP': `2001:db8:1:2::${i.toString(16)}`, 'User-Agent': UA });
    assert.equal(res.status, 204);
  }
  const rotated = row<{ visitors: number }>(raw, 'SELECT visitors FROM merchant_store_analytics_daily WHERE store_id = ?', 's1')!;
  // The control: the same ids from ONE address.
  const raw2 = seedW2E(freshDb());
  const app2 = stubApp(asD1(raw2), null, (a) => a.route('/api/storefront/events', storefrontEventRoutes));
  for (let i = 0; i < 120; i++) {
    await post(app2, '/api/storefront/events', { event: 'store_view', store: 's1', visitor: vid(i) }, { 'CF-Connecting-IP': '2001:db8:1:2::1', 'User-Agent': UA });
  }
  const single = row<{ visitors: number }>(raw2, 'SELECT visitors FROM merchant_store_analytics_daily WHERE store_id = ?', 's1')!;
  assert.ok(single.visitors <= 50, `one address is capped (got ${single.visitors})`);
  assert.equal(rotated.visitors, single.visitors, 'rotating inside the /64 buys nothing');
});

test('different /64s — and different IPv4 addresses — remain different networks', async () => {
  const raw = seedW2E(freshDb());
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/storefront/events', storefrontEventRoutes));
  let i = 0;
  for (let n = 0; n < 2; n++) {
    for (let k = 0; k < 40; k++, i++) {
      await post(app, '/api/storefront/events', { event: 'store_view', store: 's1', visitor: vid(i) }, { 'CF-Connecting-IP': `2001:db8:1:${n + 10}::${k.toString(16)}`, 'User-Agent': UA });
    }
  }
  for (let k = 0; k < 40; k++, i++) {
    await post(app, '/api/storefront/events', { event: 'store_view', store: 's1', visitor: vid(i) }, { 'CF-Connecting-IP': `198.51.100.${k + 1}`, 'User-Agent': UA });
  }
  const d = row<{ visitors: number }>(raw, 'SELECT visitors FROM merchant_store_analytics_daily WHERE store_id = ?', 's1')!;
  assert.equal(d.visitors, 120, 'two /64s (40 each, under the cap) and 40 IPv4 networks all count');
});
