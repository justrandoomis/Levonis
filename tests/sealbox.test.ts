import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, sealboxConfigured } from '../worker/lib/sealbox';

// 32 zero bytes in standard base64 (with padding), as an owner might paste it.
const RAW_B64 = Buffer.alloc(32, 7).toString('base64');

test('versioned key format round-trips', async () => {
  const secret = `v1:${RAW_B64}`;
  const sealed = await seal(secret, 'أحمد محمد علي|1990-01-01');
  assert.ok(sealed.startsWith('sealed:v1:'));
  assert.equal(await unseal(secret, sealed), 'أحمد محمد علي|1990-01-01');
});

test('bare base64 key (no version prefix) is accepted as v1', async () => {
  const sealed = await seal(RAW_B64, 'secret-name');
  assert.ok(sealed.startsWith('sealed:v1:'));
  assert.equal(await unseal(RAW_B64, sealed), 'secret-name');
  // and data sealed under the bare key stays readable when the owner later
  // adds the explicit prefix
  assert.equal(await unseal(`v1:${RAW_B64}`, sealed), 'secret-name');
});

test('rotation: v2 encrypts new data, v1 stays readable', async () => {
  const k2 = Buffer.alloc(32, 9).toString('base64');
  const old = await seal(`v1:${RAW_B64}`, 'old');
  const both = `v1:${RAW_B64},v2:${k2}`;
  const fresh = await seal(both, 'new');
  assert.ok(fresh.startsWith('sealed:v2:'));
  assert.equal(await unseal(both, old), 'old');
  assert.equal(await unseal(both, fresh), 'new');
});

test('unconfigured and garbage inputs are honest', async () => {
  assert.equal(sealboxConfigured(undefined), false);
  assert.equal(sealboxConfigured('  '), false);
  assert.equal(sealboxConfigured(RAW_B64), true);
  await assert.rejects(() => seal(undefined, 'x'));
  assert.equal(await unseal(RAW_B64, 'not-sealed'), null);
  assert.equal(await unseal(undefined, 'sealed:v1:a:b'), null);
});
