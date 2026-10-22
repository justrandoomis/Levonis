/**
 * THE SPEECH PROVIDER (push B plan §16 #4, §7 "Workers AI speech"), on a
 * fake binding: the audio goes as base64 and NOTHING else is sent (no
 * `language`), the binding's error codes map to codes, a throwing `models()`
 * gives a null list, and the reported duration becomes `speech_ms`.
 *
 * Run: node --import tsx --test tests/aiWorkersAi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPEECH_MODEL, fakeAi } from './fixtures/aiLayer';
import {
  codeOfAiError,
  speechMsOf,
  workersAiAvailable,
  workersAiListSpeechModels,
  workersAiTranscribe,
} from '../worker/lib/ai/providers/workersAi';
import type { Env } from '../worker/lib/types';

const envWith = (ai: unknown) => ({ AI: ai }) as unknown as Env;
const signal = () => new AbortController().signal;

test('available only with a binding that can run', () => {
  assert.equal(workersAiAvailable({} as Env), false);
  assert.equal(workersAiAvailable(envWith({})), false);
  assert.equal(workersAiAvailable(envWith(fakeAi({}))), true);
});

test('the call is run(modelId, { audio: base64 }, { signal }) and carries no language', async () => {
  const ai = fakeAi({});
  const s = signal();
  const r = await workersAiTranscribe(envWith(ai), SPEECH_MODEL, 'QUJD', s);
  assert.equal(r.ok, true);
  assert.equal(ai.runs.length, 1);
  assert.equal(ai.runs[0]!.model, SPEECH_MODEL);
  assert.deepEqual(ai.runs[0]!.inputs, { audio: 'QUJD' });
  assert.deepEqual(Object.keys(ai.runs[0]!.inputs), ['audio'], 'no language, no task, nothing but the audio');
  assert.equal(ai.runs[0]!.options?.signal, s);
});

test('the reported duration becomes speech_ms; its absence is 0', async () => {
  const r = await workersAiTranscribe(envWith(fakeAi({ run: async () => ({ text: 'x', transcription_info: { duration: 4.25 } }) })), SPEECH_MODEL, 'QQ==', signal());
  assert.equal(r.ok && r.usage.speechMs, 4250);
  assert.equal(speechMsOf({ text: 'x' }), 0);
  assert.equal(speechMsOf({ transcription_info: { duration: -3 } }), 0);
  assert.equal(speechMsOf({ transcription_info: { duration: 'NaN' } }), 0);
  assert.equal(speechMsOf(null), 0);
});

test('binding errors map to codes, read from their code only (§7 table)', async () => {
  const cases: Array<[unknown, string]> = [
    [{ message: '3007: request timed out after a secret detail' }, 'TIMEOUT'],
    [{ message: '3008: time limit' }, 'TIMEOUT'],
    [{ message: '3040: capacity' }, 'OVERLOADED'],
    [{ message: '3036: daily free allocation used' }, 'QUOTA'],
    [{ message: '5007: no such model' }, 'MODEL_GONE'],
    [{ message: '5004: invalid input' }, 'BAD_INPUT'],
    [{ code: 400 }, 'BAD_INPUT'],
    [{ message: '3006: request too large' }, 'TOO_LARGE'],
    [{ status: 413 }, 'TOO_LARGE'],
    [{ message: '5035: not authorized' }, 'KEY_REJECTED'],
    [{ message: 'something unexpected' }, 'NETWORK'],
    [{ code: 3999 }, 'HTTP_5XX'],
  ];
  for (const [raw, code] of cases) {
    const err = Object.assign(new Error(String((raw as { message?: string }).message ?? 'x')), raw);
    assert.equal(codeOfAiError(err, signal()), code, JSON.stringify(raw));
    const r = await workersAiTranscribe(
      envWith(
        fakeAi({
          run: async () => {
            throw err;
          },
        })
      ),
      SPEECH_MODEL,
      'QQ==',
      signal()
    );
    assert.deepEqual(r, { ok: false, code }, JSON.stringify(raw));
  }
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(codeOfAiError(new Error('3036: quota'), aborted.signal), 'TIMEOUT', 'past the deadline it is a timeout');
});

test('a binding that ignores the signal still cannot hold the call past the deadline', async () => {
  const c = new AbortController();
  const hang = fakeAi({ run: () => new Promise(() => undefined) });
  setTimeout(() => c.abort(), 20);
  assert.deepEqual(await workersAiTranscribe(envWith(hang), SPEECH_MODEL, 'QQ==', c.signal), { ok: false, code: 'TIMEOUT' });
});

test('a non-object answer is BAD_OUTPUT; no binding or a malformed id calls nothing', async () => {
  for (const v of ['text', null, [1, 2], 42]) {
    assert.deepEqual(await workersAiTranscribe(envWith(fakeAi({ run: async () => v })), SPEECH_MODEL, 'QQ==', signal()), {
      ok: false,
      code: 'BAD_OUTPUT',
    });
  }
  assert.deepEqual(await workersAiTranscribe({} as Env, SPEECH_MODEL, 'QQ==', signal()), { ok: false, code: 'NOT_CONFIGURED' });
  const ai = fakeAi({});
  assert.deepEqual(await workersAiTranscribe(envWith(ai), 'bad id', 'QQ==', signal()), { ok: false, code: 'NOT_CONFIGURED' });
  assert.equal(ai.runs.length, 0);
});

test('the speech list keeps speech-recognition models only; a throwing models() is a null list', async () => {
  const seen: unknown[] = [];
  const ai = fakeAi({
    models: async (params) => {
      seen.push(params);
      return [
        { id: 'uuid-1', name: SPEECH_MODEL, task: { name: 'Automatic Speech Recognition' } },
        { id: 'uuid-2', name: 'test/other-model', task: { name: 'Text Generation' } },
        { id: 'uuid-3', name: 'bad name with spaces', task: { name: 'Automatic Speech Recognition' } },
        { id: 'uuid-4', name: SPEECH_MODEL, task: { name: 'Automatic Speech Recognition' } },
      ];
    },
  });
  assert.deepEqual(await workersAiListSpeechModels(envWith(ai)), [{ id: SPEECH_MODEL, label: SPEECH_MODEL, effortLow: false }]);
  assert.deepEqual(seen, [{ per_page: 100, page: 1 }]);

  let pages = 0;
  const full = fakeAi({ models: async () => (pages++, Array.from({ length: 100 }, (_, i) => ({ name: `p${pages}/m${i}`, task: { name: 'Speech Recognition' } }))) });
  assert.equal((await workersAiListSpeechModels(envWith(full)))?.length, 300, 'at most three pages');
  assert.equal(pages, 3);

  const broken = fakeAi({
    models: async () => {
      throw new Error('not allowed');
    },
  });
  assert.equal(await workersAiListSpeechModels(envWith(broken)), null);
  assert.equal(await workersAiListSpeechModels({} as Env), null);
  assert.equal(await workersAiListSpeechModels(envWith({ run: async () => ({}) })), null, 'a binding without models() lists nothing');
});
