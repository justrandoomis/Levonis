/**
 * WHAT THE PAGE MAY OFFER, AND NOTHING ELSE (push B plan §16 #17, §5.5).
 *
 * `GET /api/support/assistant/readiness` is public and answers flags and
 * company names only:
 *   - each flag follows its task's own configuration, and the viewer: a guest
 *     never gets photo, clip or voice, and gets text only with the guest
 *     toggle; photo also needs the Images binding;
 *   - `mode` is `ai` exactly when one flag is true;
 *   - never a model id, a cost, the cap or a rate;
 *   - `Cache-Control: private, no-store`;
 *   - a missing table, key or binding all read as basic.
 *
 * Run: node --import tsx --test tests/aiReadiness.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiHarness, FULL, type HarnessOpts } from './fixtures/aiRoutes';
import { SPEECH_MODEL, TEXT_MODEL, speechModel, textModel } from './fixtures/aiLayer';
import { dbThrough } from './fixtures/app';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASIC = { success: true, mode: 'basic', text: false, photo: false, clip: false, voice: false, voice_locales: ['ar', 'en'], photo_provider: null, voice_provider: null };

async function readinessOf(opts: HarnessOpts, who = 'owner'): Promise<{ body: Rec; res: Response }> {
  const h = aiHarness(opts);
  const res = await h.readiness(who);
  assert.equal(res.status, 200);
  return { body: (await res.json()) as Rec, res };
}

test('every task configured: all four flags for a customer, text alone for a guest the owner let in', async () => {
  const { body, res } = await readinessOf(FULL);
  assert.deepEqual(body, { success: true, mode: 'ai', text: true, photo: true, clip: true, voice: true, voice_locales: ['ar', 'en'], photo_provider: 'anthropic', voice_provider: 'cloudflare' });
  assert.match(res.headers.get('Cache-Control') ?? '', /private, no-store/);
  const guest = (await readinessOf(FULL, '')).body;
  assert.deepEqual(guest, { ...BASIC, mode: 'ai', text: true });
  const guestsOff = (await readinessOf({ ...FULL, guests: false }, '')).body;
  assert.deepEqual(guestsOff, BASIC, 'guests are off by default');
});

test('each flag follows its own task: a model, its rates, its provider, its binding', async () => {
  const only = async (models: HarnessOpts['models'], extra: HarnessOpts = {}) => (await readinessOf({ ...FULL, models, ...extra })).body;
  assert.deepEqual(await only([textModel('understand', 0)]), { ...BASIC, mode: 'ai', text: true });
  assert.deepEqual(await only([textModel('vision', 0)]), { ...BASIC, mode: 'ai', photo: true, clip: true, photo_provider: 'anthropic' });
  assert.deepEqual(await only([textModel('vision', 0)], { noImages: true }), { ...BASIC, mode: 'ai', clip: true, photo_provider: 'anthropic' }, 'photo needs IMAGES');
  assert.deepEqual(await only([speechModel(0)]), { ...BASIC, mode: 'ai', voice: true, voice_provider: 'cloudflare' });
  assert.deepEqual(await only([speechModel(0)], { noAi: true }), BASIC, 'no binding');
  assert.deepEqual(await only([textModel('understand', 0)], { noKey: true }), BASIC, 'no key');
  assert.deepEqual(await only([{ task: 'understand', rank: 0, model_id: TEXT_MODEL }]), BASIC, 'a model without rates never runs');
  assert.deepEqual(await only([{ ...speechModel(0), minR: 0 }]), BASIC);
  assert.deepEqual(await only([{ ...textModel('understand', 0), gone: 1 }]), BASIC, 'a model the provider retired');
});

test('the switch, the cap, today’s spend and an open circuit all read as basic', async () => {
  assert.deepEqual((await readinessOf({ ...FULL, enabled: false })).body, BASIC);
  assert.deepEqual((await readinessOf({ ...FULL, capMicro: 0 })).body, BASIC);
  const spent = aiHarness(FULL);
  spent.raw.prepare('INSERT INTO ai_spend_day (day, spent_micro_usd) VALUES (?, ?)').run(new Date().toISOString().slice(0, 10), 1_000_000);
  assert.deepEqual((await spent.readiness('owner').then((r) => r.json())) as Rec, BASIC);
  const open = aiHarness(FULL);
  const later = new Date(Date.now() + 10 * 60_000).toISOString();
  open.raw.prepare("INSERT INTO ai_provider_health (provider, open_until) VALUES ('anthropic', ?)").run(later);
  assert.deepEqual((await open.readiness('owner').then((r) => r.json())) as Rec, { ...BASIC, mode: 'ai', voice: true, voice_provider: 'cloudflare' }, 'the speech provider has its own circuit');
});

test('as B1 ships (migrations only), and before 0210: basic', async () => {
  assert.deepEqual((await readinessOf({ unseeded: true })).body, BASIC, 'enabled = 0 and no model rows, with the key and both bindings present');
  assert.deepEqual((await readinessOf({ raw: dbThrough('0209'), unseeded: true })).body, BASIC, 'no 0210 tables');
});

test('no model id, cost, cap or rate in any answer', async () => {
  for (const opts of [FULL, { ...FULL, enabled: false }, { unseeded: true }]) {
    for (const who of ['owner', '']) {
      const text = JSON.stringify((await readinessOf(opts as HarnessOpts, who)).body);
      for (const banned of [TEXT_MODEL, SPEECH_MODEL, 'cap', 'cost', 'micro', 'rate', 'usd', '1000000', 'model']) {
        assert.ok(!text.toLowerCase().includes(banned.toLowerCase()), `${banned} in ${text}`);
      }
    }
  }
});
