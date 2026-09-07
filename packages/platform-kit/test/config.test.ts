import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryConfig, MemorySource, MemoConfig, isMoneyKey, KvSource, modeVar } from '../src/config';

test('reads are memoised 30 s per isolate except money keys, which are read per request (TTL 0)', async () => {
  let now = 0;
  const source = new MemorySource({ exchangeRate: 1470, adVideoUrl: 'a', communityFeePercent: 5, 'flag:ads.enabled': 'on' });
  let reads = 0;
  const counting = { read: async (k: string) => ((reads++), source.read(k)) };
  const cfg = new MemoConfig(counting, { now: () => now });
  assert.equal(await cfg.get('adVideoUrl'), 'a');
  assert.equal(await cfg.get('adVideoUrl'), 'a');
  assert.equal(reads, 1, 'memoised');
  now = 29_999;
  await cfg.get('adVideoUrl');
  assert.equal(reads, 1);
  now = 30_000;
  await cfg.get('adVideoUrl');
  assert.equal(reads, 2, 'expired after 30 s');
  // money keys: every read hits the source
  assert.ok(isMoneyKey('exchangeRate') && isMoneyKey('communityFeePercent') && isMoneyKey('paymentMethods') && !isMoneyKey('adVideoUrl'));
  await cfg.get('exchangeRate');
  await cfg.get('exchangeRate');
  assert.equal(reads, 4);
  source.set('exchangeRate', 1500);
  assert.equal(await cfg.get('exchangeRate'), 1500, 'an admin rate change is visible on the next request');
  assert.equal(await cfg.flag('ads.enabled'), true);
  assert.equal(await cfg.flag('missing', false), false);
  cfg.invalidate('adVideoUrl');
  await cfg.get('adVideoUrl');
  assert.equal(reads, 8);
});

test('KV source namespaces keys; memoryConfig helper; modeVar normalises on|off|log|shadow vars', async () => {
  const asked: string[] = [];
  const kv = { get: async (k: string) => ((asked.push(k)), 42) };
  const cfg = new MemoConfig(new KvSource(kv));
  assert.equal(await cfg.get('minMarginPercent'), 42);
  assert.deepEqual(asked, ['config:minMarginPercent']);
  assert.deepEqual(await memoryConfig({ a: 1, b: null }).getMany(['a', 'b', 'c']), { a: 1, b: null, c: null });
  assert.equal(modeVar(' ON ', ['off', 'log', 'on'], 'off'), 'on');
  assert.equal(modeVar('bogus', ['off', 'log', 'on'], 'off'), 'off');
  assert.equal(modeVar(undefined, ['off', 'shadow', 'on'], 'off'), 'off');
});
