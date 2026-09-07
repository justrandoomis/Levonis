import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact } from '../src/log';
import { uuidv7, isUuidV7, uuidv7Time, correlationFor, newRequestId, CORRELATION_HEADER } from '../src/correlation';
import { KeyRing, constantTimeEqual, generateKeyPair } from '../src/keys';

test('structured JSON lines carry the design fields, redact secrets and never print a token or a cookie', () => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ svc: 'commerce', ver: 'abc123', env: 'production', sink: (l) => lines.push(JSON.parse(l)), now: () => '2026-09-07T10:00:00.000Z' });
  const child = log.child({ cid: '018f', rid: 'req_1', hop: 'gateway>commerce' });
  child.info('checkout.saga.step', { step: 'ledger.hold', outcome: 'applied', headers: { cookie: 'levonis_session=abc', authorization: 'Bearer x' }, user: { email: 'a@b.c', id: 'usr_1' } });
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.equal(l.ts, '2026-09-07T10:00:00.000Z');
  assert.equal(l.level, 'info');
  assert.equal(l.svc, 'commerce');
  assert.equal(l.ver, 'abc123');
  assert.equal(l.cid, '018f');
  assert.equal(l.msg, 'checkout.saga.step');
  assert.deepEqual(l.headers, { cookie: '[redacted]', authorization: '[redacted]' });
  assert.deepEqual(l.user, { email: '[redacted]', id: 'usr_1' });
  assert.ok(!JSON.stringify(l).includes('levonis_session=abc'));
  assert.deepEqual(redact({ password_hash: 'x', nested: [{ token: 't', ok: 1 }] }), { password_hash: '[redacted]', nested: [{ token: '[redacted]', ok: 1 }] });
  assert.deepEqual(redact(new Error('boom')), { name: 'Error', message: 'boom' });
});

test('info is head-sampled; warn, error and money lines are never sampled', () => {
  const lines: string[] = [];
  let r = 0.99;
  const log = createLogger({ svc: 'ledger', sampleRate: 0.1, sink: (l) => lines.push(l), random: () => r });
  log.info('dropped');
  assert.equal(lines.length, 0);
  log.warn('kept');
  log.error('kept');
  log.money('ledger.credit', { applied: true });
  assert.equal(lines.length, 3);
  assert.ok(JSON.parse(lines[2]).money === true);
  r = 0.05;
  log.info('sampled in');
  assert.equal(lines.length, 4);
});

test('UUIDv7 ids are time-ordered, well-formed and carry their timestamp; correlation ids from browsers are ignored', () => {
  let t = 1_757_239_200_000;
  const clock = { now: () => t };
  const a = uuidv7(clock);
  t += 1;
  const b = uuidv7(clock);
  assert.ok(isUuidV7(a) && isUuidV7(b));
  assert.ok(a < b, 'lexicographic order follows time');
  assert.equal(uuidv7Time(a), 1_757_239_200_000);
  assert.ok(!isUuidV7('123e4567-e89b-12d3-a456-426614174000'), 'v1 is not v7');
  const headers = new Headers({ [CORRELATION_HEADER]: a });
  assert.equal(correlationFor(headers, { trusted: true }), a);
  assert.notEqual(correlationFor(headers, { trusted: false }), a, 'a browser value is replaced');
  assert.ok(isUuidV7(correlationFor(new Headers(), { trusted: true })));
  assert.match(newRequestId(), /^req_[0-9a-f-]{36}$/);
});

test('the bootstrap ALLOWED_CALLER_KIDS list parses and checks kids; constant-time compare', async () => {
  const gw = await generateKeyPair();
  const ring = await KeyRing.fromAllowlist(`gateway:${gw.kid}:${gw.publicKeyB64}`);
  assert.deepEqual(ring.kids(), [gw.kid]);
  assert.equal(ring.get(gw.kid)?.service, 'gateway');
  await assert.rejects(() => KeyRing.fromAllowlist(`gateway:deadbeefdeadbeef:${gw.publicKeyB64}`), /does not match/);
  await assert.rejects(() => KeyRing.fromAllowlist('gateway:only-two'), /expected/);
  assert.equal((await KeyRing.fromAllowlist(undefined)).kids().length, 0);
  assert.ok(constantTimeEqual('abc', 'abc'));
  assert.ok(!constantTimeEqual('abc', 'abd'));
  assert.ok(!constantTimeEqual('abc', 'abcd'));
  assert.ok(!constantTimeEqual('', 'a'));
});
