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
import { validateOutboundUrl } from '../worker/lib/fetchGuard';

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
