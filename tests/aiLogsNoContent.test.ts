/**
 * THE LOGS CARRY CODES AND COUNTS, NEVER CONTENT (push B plan §16 #12, I7;
 * the pattern of tests/fxLogsNoValues.test.ts), for the paths push B's
 * provider layer and admin tab own: every outcome of the three tasks, the
 * live lists, the admin save and the admin Tests.
 *
 * A console spy catches every `console.*` call. A marker is planted in the
 * customer text, the model's answers, the transcript, the provider's error
 * bodies and the thrown error messages: none of it — nor the key, the base64
 * of a picture or the audio, or a model id — may reach a log. Every log line
 * the layer writes is exactly the `assist_ai` shape, and every `ai_usage`
 * outcome is OK or a known code.
 *
 * Run: node --import tsx --test tests/aiLogsNoContent.test.ts
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, SPEECH_MODEL, TEXT_MODEL, TEXT_MODEL_B, aiDb, answer, errorResponse, fakeAi, jsonResponse, recordingTransport, speechModel, textModel, tinyJpeg } from './fixtures/aiLayer';
import { OWNER, all, asD1 as asD1Of, ctx, providerFetch, post, put, stubApp } from './fixtures/app';
import { runSpeech, runUnderstand, runVision } from '../worker/lib/ai/run';
import { anthropicListModels } from '../worker/lib/ai/providers/anthropic';
import { workersAiListSpeechModels } from '../worker/lib/ai/providers/workersAi';
import { bytesToBase64 } from '../worker/lib/ai/jpeg';
import { adminAssistAiRoutes } from '../worker/routes/adminAssistAi';
import { forgetAiConfig } from '../worker/lib/ai/config';
import { FAIL_CODES } from '../worker/lib/ai/types';
import type { Env } from '../worker/lib/types';

const MARK = 'ZZMODELZZ';
const lines: string[] = [];
const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const saved = new Map<string, (...a: unknown[]) => void>();

beforeEach(() => {
  lines.length = 0;
  for (const m of methods) {
    saved.set(m, console[m] as (...a: unknown[]) => void);
    (console as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(' '));
    };
  }
});
afterEach(() => {
  for (const m of methods) (console as unknown as Record<string, unknown>)[m] = saved.get(m);
  providerFetch.handler = null;
  providerFetch.attempts.length = 0;
  forgetAiConfig();
});

const FORBIDDEN = (extra: string[] = []) => [MARK, KEY, KEY.slice(0, 10), TEXT_MODEL, TEXT_MODEL_B, SPEECH_MODEL, 'provider text that must never be read', ...extra];

function assertClean(extra: string[] = []) {
  const joined = lines.join('\n');
  for (const f of FORBIDDEN(extra)) assert.ok(!joined.includes(f), `a log line carries ${f.slice(0, 24)}…:\n${joined.slice(0, 600)}`);
  for (const l of lines) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(l) as Record<string, unknown>;
    } catch {
      /* not one of ours */
    }
    if (!parsed || parsed.ev !== 'assist_ai') continue;
    assert.deepEqual(Object.keys(parsed).sort(), ['cost', 'ev', 'ms', 'outcome', 'provider', 'sec', 'task', 'tin', 'tout']);
    assert.ok(parsed.outcome === 'OK' || (FAIL_CODES as readonly string[]).includes(String(parsed.outcome)), String(parsed.outcome));
    for (const k of ['cost', 'ms', 'sec', 'tin', 'tout']) assert.equal(typeof parsed[k], 'number', k);
  }
}

const assistLines = () => lines.filter((l) => l.includes('"ev":"assist_ai"'));
const markedText = { text: `${MARK} الطابعة تطلع خيوط ${MARK}`, locale: 'ar' as const };
const markedReading = { action: 'products', intent: 'none', printer: 'none', part: 'none', symptom: 'none', outcome: 'none', maintenance: false, terms: [MARK] };

test('understanding: every outcome logs one coded line and nothing of the text, the answer or the error', async () => {
  const replies: Array<() => Response> = [
    () => answer(markedReading),
    () => answer(null, { rawText: `${MARK} not json` }),
    () => answer(markedReading, { stop: 'refusal' }),
    () => answer(markedReading, { stop: 'max_tokens' }),
    () => errorResponse(401, 'authentication_error'),
    () => errorResponse(529, 'overloaded_error'),
    () => jsonResponse(500, { error: { type: 'api_error', message: MARK } }),
    () => {
      throw new TypeError(`fetch failed ${MARK} ${KEY}`);
    },
    () => {
      throw Object.assign(new Error(`aborted ${MARK}`), { name: 'AbortError' });
    },
  ];
  for (const reply of replies) {
    const { raw, db } = aiDb({ models: [textModel('understand', 0), textModel('understand', 1)] });
    const env = { DB: db, ANTHROPIC_API_KEY: KEY } as unknown as Env;
    const before = assistLines().length;
    await runUnderstand(env, markedText, { guest: false }, { transport: recordingTransport(reply) });
    assert.ok(assistLines().length - before >= 1, 'one line per provider call');
    for (const u of all<{ outcome: string; model_id: string }>(raw, 'SELECT outcome, model_id FROM ai_usage')) {
      assert.ok(u.outcome === 'OK' || (FAIL_CODES as readonly string[]).includes(u.outcome), u.outcome);
    }
  }
  assertClean();
});

test('vision and speech: no picture, no audio, no transcript in a log', async () => {
  const jpeg = tinyJpeg(320, 240);
  const { db } = aiDb({ models: [textModel('vision', 0), speechModel(0)] });
  const audio = new Uint8Array(3000).fill(65);
  const env = {
    DB: db,
    ANTHROPIC_API_KEY: KEY,
    AI: fakeAi({ run: async () => ({ text: `${MARK} heard`, transcription_info: { language: 'en', duration: 2 } }) }),
  } as unknown as Env;
  const t = recordingTransport(() =>
    answer({ subject: 'label', printer: 'none', symptom: 'none', part: 'none', hms_codes: [], label_codes: [`${MARK}1`], confidence: 'low' })
  );
  assert.ok(await runVision(env, [jpeg], 'photo', { transport: t }));
  assert.ok(await runVision(env, [jpeg, jpeg, jpeg], 'clip', { transport: t }));
  assert.ok(await runSpeech(env, bytesToBase64(audio), audio.byteLength));
  const failing = { ...env, AI: fakeAi({ run: async () => Promise.reject(new Error(`3040: ${MARK}`)) }) } as unknown as Env;
  assert.equal(await runSpeech(failing, bytesToBase64(audio), audio.byteLength), null);
  assert.equal(assistLines().length, 4);
  assertClean([bytesToBase64(jpeg).slice(0, 40), bytesToBase64(audio).slice(0, 40), 'heard']);
});

test('the live lists log nothing, whatever the provider answers', async () => {
  const env = { ANTHROPIC_API_KEY: KEY, AI: fakeAi({ models: async () => Promise.reject(new Error(MARK)) }) } as unknown as Env;
  await anthropicListModels(env, 'understand', new AbortController().signal, recordingTransport(() => jsonResponse(500, { error: { message: MARK } })));
  await anthropicListModels(env, 'vision', new AbortController().signal, recordingTransport(() => jsonResponse(200, { data: [{ id: MARK, capabilities: null }] })));
  await workersAiListSpeechModels(env);
  assert.deepEqual(lines, []);
});

test('the admin save and the admin Tests: coded lines only', async () => {
  const { raw } = aiDb({ enabled: false, models: [textModel('understand', 0), textModel('vision', 0)] });
  const a = stubApp(asD1Of(raw), OWNER, (app) => app.route('/api/admin/assist-ai', adminAssistAiRoutes), {
    env: { ANTHROPIC_API_KEY: KEY, AI: fakeAi({ run: async () => ({ text: `${MARK} spoken`, transcription_info: { language: 'ar', duration: 3 } }) }) },
    publishV2: false,
  });
  providerFetch.handler = async (url) =>
    url.includes('/v1/models')
      ? jsonResponse(200, { data: [{ id: TEXT_MODEL, display_name: MARK, capabilities: { structured_outputs: { supported: true }, image_input: { supported: true } } }], has_more: false })
      : answer(markedReading);
  assert.equal((await put(a, '/api/admin/assist-ai/tasks/understand/0', { model_id: TEXT_MODEL, rates: { in: '1', out: '5' } })).status, 200);
  assert.equal((await post(a, '/api/admin/assist-ai/test/understand', {})).status, 200);
  const form = new FormData();
  form.set('audio', new File([new Uint8Array(2000).fill(1)], 'a.webm', { type: 'audio/webm' }));
  form.set('model_id', SPEECH_MODEL);
  form.set('per_minute', '0.006');
  assert.equal((await a.request('/api/admin/assist-ai/test/speech', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx)).status, 200);
  assert.equal(assistLines().length, 2);
  assertClean(['spoken']);
});


// ------------------------------------------------------------------ the customer routes (part 2)

test('the customer routes: the consult point, a photo, a clip and a voice note log codes only', async () => {
  const { aiHarness, FULL, photoReading, provide, textReading } = await import('./fixtures/aiRoutes');
  const heard = `${MARK} النوزل مسدود`;
  const h = aiHarness({ ...FULL, speech: { run: async () => ({ text: heard, transcription_info: { language: 'ar', duration: 2 } }) } });
  const customerText = `شي غريب يصير ${MARK} ما ادري شنو`;
  const answers = [
    () => answer(textReading({ action: 'products', part: 'nozzle_hotend', terms: [MARK, 'غريب'] })),
    () => answer(textReading({ action: 'intent', intent: 'greeting', terms: [MARK] })),
    () => answer(null, { rawText: `${MARK} {` }),
    () => errorResponse(529, 'overloaded_error'),
    () => {
      throw new Error(`${MARK} socket hang up`);
    },
    () => answer(photoReading({ hms_codes: ['0300-0100-0001-0003'], label_codes: [MARK] })),
    () => answer(photoReading({ subject: 'label', label_codes: [MARK] })),
  ];
  let i = 0;
  provide(() => answers[Math.min(i++, answers.length - 1)]!());
  for (let k = 0; k < 5; k++) await h.assistant('owner', { text: customerText });
  const photo = h.seedFile('owner', 'attachments', new Uint8Array([1, 2, 3]), 'image/webp');
  await h.read('owner', { kind: 'photo', key: photo });
  const clip = h.seedFile('owner', 'video', new Uint8Array([1, 2, 3]), 'video/mp4');
  const frame = tinyJpeg(640, 480);
  await h.readFrames('owner', { key: clip, consent: '1', f0: frame, f1: frame });
  const voice = h.seedFile('owner', 'audio', new Uint8Array([7, 7, 7]), 'audio/webm');
  const res = await h.read('owner', { kind: 'voice', key: voice });
  assert.equal(((await res.json()) as { transcript?: string }).transcript, heard, 'the transcript went to its owner…');
  assert.ok(assistLines().length >= 8, `only ${assistLines().length} assist_ai lines`);
  // …and nowhere else: not the customer's text, the transcript, a frame's base64, nor the audio's.
  assertClean([customerText, heard, 'النوزل مسدود', bytesToBase64(frame).slice(0, 40), bytesToBase64(new Uint8Array([7, 7, 7])), 'socket hang up']);
  const outcomes = all<{ outcome: string }>(h.raw, 'SELECT outcome FROM ai_usage');
  assert.ok(outcomes.length >= 8);
  for (const { outcome } of outcomes) assert.ok(outcome === 'OK' || (FAIL_CODES as readonly string[]).includes(outcome), outcome);
});
