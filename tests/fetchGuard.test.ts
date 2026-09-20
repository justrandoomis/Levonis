/**
 * THE ADDRESS CHECK ON EVERY OUTBOUND FETCH.
 *
 * The admin surface fetches URLs an admin pastes — product images and, since
 * the owner asked for it, vendor product pages. That makes this the boundary
 * between "download a picture" and "make the server read something on the
 * private network on my behalf", and it had no test of any kind.
 *
 * The IPv4-mapped case below is not hypothetical: `::ffff:127.0.0.1` matches
 * none of `::1`, `fc`, `fd` or `fe80`, so it walked straight past the guard
 * and reached loopback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardedFetchBytes, validateOutboundUrl } from '../worker/lib/fetchGuard';

const refuses = (url: string, why: string) =>
  assert.throws(() => validateOutboundUrl(url), /not allowed|Invalid|Only http/i, `${url} — ${why}`);

test('an ordinary vendor address is allowed', () => {
  assert.equal(validateOutboundUrl('https://us.store.bambulab.com/products/a1').hostname, 'us.store.bambulab.com');
  assert.equal(validateOutboundUrl('http://example.com/a.jpg').protocol, 'http:');
});

test('loopback and private ranges are refused, in every spelling', () => {
  refuses('http://127.0.0.1/', 'loopback');
  refuses('http://127.1.2.3/', 'the whole 127/8 block');
  refuses('http://localhost/', 'by name');
  refuses('http://anything.localhost/', 'the localhost suffix');
  refuses('http://db.internal/', 'the internal suffix');
  refuses('http://printer.local/', 'mDNS');
  refuses('http://10.0.0.5/', 'RFC1918 10/8');
  refuses('http://172.16.0.1/', 'RFC1918 172.16/12');
  refuses('http://172.31.255.254/', 'the top of 172.16/12');
  refuses('http://192.168.1.1/', 'RFC1918 192.168/16');
  refuses('http://169.254.169.254/', 'the cloud metadata address');
  refuses('http://100.64.0.1/', 'carrier-grade NAT lower boundary');
  refuses('http://100.127.255.254/', 'carrier-grade NAT upper boundary');
  refuses('http://0.0.0.0/', 'the unspecified address');
  refuses('http://239.1.1.1/', 'multicast');
});

test('172.32 is public — the private range must not be over-blocked', () => {
  assert.equal(validateOutboundUrl('http://172.32.0.1/').hostname, '172.32.0.1');
  assert.equal(validateOutboundUrl('http://172.15.0.1/').hostname, '172.15.0.1');
});

test('IPv6 loopback and unique-local are refused', () => {
  refuses('http://[::1]/', 'v6 loopback');
  refuses('http://[fc00::1]/', 'unique local');
  refuses('http://[fd12:3456::1]/', 'unique local');
  refuses('http://[fe80::1]/', 'link local');
  refuses('http://[fe9f::1]/', 'the full fe80::/10 link-local range');
  refuses('http://[febf::1]/', 'the top of the fe80::/10 link-local range');
  refuses('http://[fec0::1]/', 'deprecated site-local internal range');
  refuses('http://[ff02::1]/', 'IPv6 multicast');
  refuses('http://[::]/', 'unspecified');
});

test('an IPv4-mapped IPv6 address is unwrapped and judged as the v4 address it is', () => {
  refuses('http://[::ffff:127.0.0.1]/', 'dotted mapped loopback');
  refuses('http://[::ffff:7f00:1]/', 'hex mapped loopback');
  refuses('http://[::ffff:169.254.169.254]/', 'mapped metadata address');
  refuses('http://[::ffff:a9fe:a9fe]/', 'hex mapped metadata address');
  refuses('http://[::ffff:10.0.0.1]/', 'mapped RFC1918');
  // A mapped PUBLIC address is still fine — the unwrap must judge, not blanket-ban.
  assert.equal(validateOutboundUrl('http://[::ffff:8.8.8.8]/').protocol, 'http:');
});

test('non-http schemes and embedded credentials are refused', () => {
  refuses('file:///etc/passwd', 'file');
  refuses('gopher://example.com/', 'gopher');
  refuses('ftp://example.com/a.jpg', 'ftp');
  refuses('https://user:pass@example.com/a.jpg', 'credentials');
  refuses('not a url', 'unparseable');
});

test('parallel readers reserve the shared byte budget before buffering', async () => {
  const budget = { fetches: 2, bytes: 4 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstPull!: () => void;
  const pulling = new Promise<void>((resolve) => { firstPull = resolve; });
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          firstPull();
          await gate;
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      }));
    }
    return new Response(new Uint8Array([5, 6, 7, 8]));
  }) as unknown as typeof fetch;

  const first = guardedFetchBytes('https://vendor.example/one.webp', {
    maxBytes: 4,
    budget,
    fetcher,
  });
  await pulling;
  await assert.rejects(
    () => guardedFetchBytes('https://vendor.example/two.webp', { maxBytes: 4, budget, fetcher }),
    /byte budget exhausted/i
  );
  release();
  assert.deepEqual((await first).bytes, new Uint8Array([1, 2, 3, 4]));
  assert.equal(budget.bytes, 0, 'only the one reserved body fits the aggregate cap');
});

// ============================================================ review round 2

test('a fully-qualified trailing dot does not slip past the name blocklist', () => {
  // `new URL('http://localhost./x').hostname` is `localhost.`, which matched
  // none of the four alternatives and reached loopback.
  refuses('http://localhost./probe', 'localhost with a root dot');
  refuses('http://db.internal./x', 'an internal name with a root dot');
  refuses('http://printer.local./x', 'mDNS with a root dot');
  refuses('http://LOCALHOST./x', 'and it is case-insensitive');
});

test('the deprecated IPv4-compatible IPv6 form is unwrapped too', () => {
  refuses('http://[::127.0.0.1]/', 'dotted v4-compatible loopback');
  refuses('http://[::7f00:1]/', 'hex v4-compatible loopback');
  refuses('http://[::169.254.169.254]/', 'v4-compatible metadata address');
  // A v4-compatible PUBLIC address is still allowed: unwrap and judge.
  assert.equal(validateOutboundUrl('http://[::8.8.8.8]/').protocol, 'http:');
});

// ------------------------------------------------ redirects in resolveModelLink

test('resolveModelLink follows redirects by hand and refuses a hop to a blocked address', async () => {
  const { resolveModelLink } = await import('../worker/lib/externalModels');
  const providers = [
    { id: 'makerworld', enabled: true, hosts: ['makerworld.com'], api_url: 'https://api.example.com/models/{id}', headers: {} },
  ] as never;
  const calls: string[] = [];
  const redirectTo = (loc: string) => new Response(null, { status: 302, headers: { Location: loc } });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  // A redirect at a private address is refused before it is dialled.
  let fake = (async (url: string) => { calls.push(url); return redirectTo('http://127.0.0.1/admin'); }) as unknown as typeof fetch;
  let info = await resolveModelLink('https://makerworld.com/models/123', providers, fake);
  assert.equal(info.resolved, false);
  assert.equal(info.reason, 'BAD_REDIRECT');
  assert.equal(calls.length, 1, 'the blocked hop was never fetched');

  // A redirect to a public address is followed, and the JSON read there.
  calls.length = 0;
  fake = (async (url: string) => {
    calls.push(url);
    return calls.length === 1 ? redirectTo('https://cdn.example.com/models/123.json') : json({ name: 'Benchy', images: [] });
  }) as unknown as typeof fetch;
  info = await resolveModelLink('https://makerworld.com/models/123', providers, fake);
  assert.equal(info.resolved, true);
  assert.deepEqual(calls, ['https://api.example.com/models/123', 'https://cdn.example.com/models/123.json']);
});
