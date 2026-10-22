/**
 * NO WORD A MODEL WROTE REACHES A REPLY (push B plan §16 #1; invariant I1).
 *
 * A fake provider plants the marker in every string slot it has: the search
 * terms, the HMS and label codes, an extra key, text around the JSON, a second
 * content block, wrong-case enums; and it also answers valid-shape readings
 * whose label codes are marker-shaped. The suite drives every customer path —
 * the text consult, a photo, a clip's frames, a voice note, and the chips
 * those replies offer — and the marker never appears in a response, except in
 * the voice route's own top-level `transcript`, which goes to the customer's
 * composer and nowhere else.
 *
 * Run: node --import tsx --test tests/aiNoModelTextInReplies.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { aiHarness, FULL, MARKER, photoReading, provide, providerCalls, resetProvider, seedShop, textReading, tinyJpeg } from './fixtures/aiRoutes';
import { answer, jsonResponse } from './fixtures/aiLayer';
import { freshDb } from './fixtures/app';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

afterEach(() => resetProvider());

/** The customer never typed the marker: whatever carries it came from the model. */
const TYPED = 'شي غريب يصير ما ادري شنو';

const TEXT_ANSWERS: Array<() => Response> = [
  () => answer(textReading({ action: 'products', part: 'nozzle_hotend', terms: [MARKER, `${MARKER} غريب`, 'غريب'] })),
  () => answer(textReading({ action: 'PRODUCTS', part: 'Nozzle_Hotend', printer: 'A1', terms: [MARKER] })),
  () => answer(textReading({ action: 'triage', symptom: 'clog', terms: [MARKER] })),
  () => answer(textReading({ action: 'Triage', printer: 'p1s', symptom: 'STRINGING' })),
  () => answer(textReading({ action: 'intent', intent: 'greeting', terms: [MARKER] })),
  () => answer(textReading({ action: 'intent', intent: 'shipping_cost' })),
  () => answer({ ...textReading({ action: 'triage', symptom: 'clog' }), note: MARKER }),
  () => answer(textReading({ action: 'triage', symptom: MARKER })),
  () => answer(textReading({ action: 'intent', intent: MARKER })),
  () => answer(null, { rawText: `${MARKER} ${JSON.stringify(textReading({ action: 'triage' }))}` }),
  () => answer(textReading({ action: 'triage', symptom: 'clog' }), { extraBlocks: [{ type: 'text', text: MARKER }] }),
  () => answer(textReading({ action: 'products', terms: [MARKER] })),
  () => jsonResponse(200, { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: MARKER }], usage: { input_tokens: 5, output_tokens: 5 } }),
];

const PHOTO_ANSWERS: Array<() => Response> = [
  () => answer(photoReading({ hms_codes: ['0300-0100-0001-0003', MARKER, `${MARKER}-0001`], label_codes: [MARKER] })),
  () => answer(photoReading({ hms_codes: ['0500-4038', '0300_0100_0001_000a'], label_codes: [`${MARKER}-1`] })),
  () => answer(photoReading({ subject: 'label', label_codes: [MARKER, `${MARKER}-PLA`] })),
  () => answer(photoReading({ subject: 'PRINT_RESULT', symptom: 'Stringing', printer: 'x1c', label_codes: [MARKER] })),
  () => answer(photoReading({ subject: 'part', part: 'plate', label_codes: [MARKER] })),
  () => answer(photoReading({ subject: 'printer', printer: 'a1_mini' })),
  () => answer(photoReading({ subject: 'printer', printer: 'a1_mini', confidence: 'low', symptom: 'clog' })),
  () => answer({ ...photoReading(), extra: MARKER }),
  () => answer(photoReading({ subject: MARKER })),
  () => answer(null, { rawText: `${MARKER}` }),
];

const VOICE_RESULTS: Array<() => unknown> = [
  () => ({ text: `${MARKER} النوزل مسدود`, transcription_info: { language: 'ar', duration: 3 } }),
  () => ({ text: `${MARKER}`, transcription_info: { language: MARKER } }),
  () => ({ text: 42, transcription_info: { language: 'en' }, note: MARKER }),
];

function assertNoMarker(where: string, body: unknown) {
  const text = JSON.stringify(body);
  assert.ok(!text.toLowerCase().includes(MARKER.toLowerCase()), `${where}: ${text.slice(0, 400)}`);
}

test('the text consult: no marker in any reply, nor in the chips it offers and their answers', async () => {
  const raw = freshDb();
  await seedShop(raw);
  const h = aiHarness({ ...FULL, raw });
  let calls = 0;
  for (const [i, make] of TEXT_ANSWERS.entries()) {
    provide(make);
    const body = await h.assistant(i % 2 ? 'owner' : '', { text: TYPED });
    calls += providerCalls();
    assertNoMarker(`text answer ${i}`, body);
    // Every chip the reply offers, tapped, answers without it too.
    for (const chip of (body.reply.choices ?? []) as Rec[]) {
      const next = await h.assistant('owner', { intent: chip.intent, params: chip.params, context: body.reply.context });
      assertNoMarker(`text answer ${i}, chip ${chip.label}`, next);
    }
    raw.exec('DELETE FROM rate_limits');
  }
  assert.equal(calls, TEXT_ANSWERS.length, 'every answer was asked for, at the consult point');
});

test('a photo and a clip: no marker in any reply, a chip, or its answer', async () => {
  const raw = freshDb();
  await seedShop(raw);
  const h = aiHarness({ ...FULL, raw });
  const photo = h.seedFile('owner', 'attachments', new Uint8Array([1, 2, 3]), 'image/webp');
  const clip = h.seedFile('owner', 'video', new Uint8Array([1, 2, 3]), 'video/mp4');
  const frame = tinyJpeg(640, 480);
  for (const [i, make] of PHOTO_ANSWERS.entries()) {
    provide(make);
    for (const res of [
      await h.read('owner', { kind: 'photo', key: photo, locale: (['ar', 'en', 'ckb'] as const)[i % 3] }),
      await h.readFrames('owner', { key: clip, consent: '1', locale: 'en', f0: frame, f1: frame, f2: frame }),
    ]) {
      assert.equal(res.status, 200);
      const body = (await res.json()) as Rec;
      assertNoMarker(`photo answer ${i}`, body);
      for (const chip of (body.reply.choices ?? []) as Rec[]) {
        const next = await h.assistant('owner', { intent: chip.intent, params: chip.params, context: body.reply.context ?? { v: 1 } });
        assertNoMarker(`photo answer ${i}, chip ${chip.label}`, next);
      }
    }
    raw.exec('DELETE FROM rate_limits');
  }
});

test('a voice note: the marker only ever in the top-level transcript, never in a reply', async () => {
  for (const [i, make] of VOICE_RESULTS.entries()) {
    const h = aiHarness({ ...FULL, speech: { run: async () => make() } });
    const note = h.seedFile('owner', 'audio', new Uint8Array([1, 2, 3]), 'audio/webm');
    const body = (await (await h.read('owner', { kind: 'voice', key: note })).json()) as Rec;
    if (body.transcript !== undefined) {
      assert.deepEqual(Object.keys(body).sort(), ['success', 'transcript'], 'a transcript travels alone');
      assert.equal(typeof body.transcript, 'string');
    } else {
      assertNoMarker(`voice result ${i}`, body);
    }
  }
});
