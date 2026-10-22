/**
 * THE CLIENT HALF AGAINST THE SERVER HALF, END TO END (push B1 integration;
 * plan §5.2-§5.5, §11).
 *
 * The two halves were built side by side and each is tested on its own
 * (tests/assistAiClient.test.ts pins what the browser sends; the ai* route
 * tests pin what the Worker answers). This file joins them: the browser
 * helpers of src/lib/assistAi.ts send their REAL requests through `fetch`,
 * and `fetch` of this origin is the REAL support router (or the owner tab
 * router), with the provider and the speech binding faked. What comes back
 * is read by the same readers the page and the owner tab use. A field
 * renamed on either side fails here.
 *
 * Run: node --import tsx --test tests/aiClientContract.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { aiHarness, FULL, photoReading, provide, providerCalls, resetProvider, tinyJpeg, type Harness } from './fixtures/aiRoutes';
import { KEY, TEXT_MODEL, aiDb, answer, jsonResponse, textModel } from './fixtures/aiLayer';
import { OWNER, asD1, ctx, providerFetch, stubApp } from './fixtures/app';
import {
  BASIC_READINESS,
  canRead,
  fetchReadiness,
  providerFor,
  readAttachment,
  readFrames,
  type AiReadResult,
} from '../src/lib/assistAi';
import { ApiError, api } from '../src/lib/api';
import { refusedRead } from '../src/components/support/AssistAttach';
import { readOverview } from '../src/components/AdminAssistAi';
import { FRAME_MAX_BYTES } from '../src/lib/assistMedia';
import { ASSIST_AI_READ_REFUSALS } from '../packages/contracts/src/assistAiRefusals';
import { ASSIST_T } from '../worker/lib/assist/strings';
import { adminAssistAiRoutes } from '../worker/routes/adminAssistAi';
import { forgetAiConfig } from '../worker/lib/ai/config';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

afterEach(() => {
  resetProvider();
  forgetAiConfig();
});

const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);

/**
 * `fetch` of this origin (a path) is answered by `local`; any other address
 * goes on to the fetch the fixtures installed, whose tripwire answers the
 * provider host only through `provide()`.
 */
async function through<T>(local: (path: string, init?: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const outer = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    return url.startsWith('/') ? local(url, init) : outer(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = outer;
  }
}
const asViewer = (h: Harness, who: string) => (path: string, init?: RequestInit) => h.as(who, path, init);

/** The request a helper made, or the refusal it threw, as the page sees it. */
async function settle(run: () => Promise<AiReadResult>): Promise<{ result?: AiReadResult; error?: unknown }> {
  try {
    return { result: await run() };
  } catch (error) {
    return { error };
  }
}

// ------------------------------------------------------------- readiness

test('readiness: the answer of the server is what the page offers, per viewer; a dark layer is basic', async () => {
  const h = aiHarness(FULL);
  const customer = await through(asViewer(h, 'owner'), fetchReadiness);
  assert.deepEqual(
    { ...customer },
    { mode: 'ai', text: true, photo: true, clip: true, voice: true, voiceLocales: ['ar', 'en'], photoProvider: 'anthropic', voiceProvider: 'cloudflare' }
  );
  assert.equal(providerFor('photo', customer), 'Anthropic');
  assert.equal(providerFor('voice', customer), 'Cloudflare');
  assert.ok(canRead('photo', customer, 'ar') && canRead('clip', customer, 'en') && canRead('voice', customer, 'en'));
  assert.ok(!canRead('voice', customer, 'ckb'), 'a Sorani screen never offers speech');

  const guest = await through(asViewer(h, ''), fetchReadiness);
  assert.equal(guest.mode, 'ai');
  assert.ok(guest.text && !guest.photo && !guest.clip && !guest.voice, 'a guest is offered no read');

  const dark = aiHarness({ ...FULL, enabled: false });
  assert.deepEqual(await through(asViewer(dark, 'owner'), fetchReadiness), BASIC_READINESS);
  const unseeded = aiHarness({ unseeded: true });
  assert.deepEqual(await through(asViewer(unseeded, 'owner'), fetchReadiness), BASIC_READINESS, 'as migration 0210 leaves it: off');
});

// ------------------------------------------------------------- the reads

const PHOTO = tinyJpeg(1200, 900);
const CODE = '0300-0100-0001-0003';

test('a photo: the request of the page is the request the server reads, and its reply is drawn as an AI reply', async () => {
  const h = aiHarness(FULL);
  provide(() => answer(photoReading({ hms_codes: [CODE] })));
  const key = h.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  const { result } = await settle(() => through(asViewer(h, 'owner'), () => readAttachment({ kind: 'photo', key, locale: 'en', context: { v: 1 } })));
  assert.equal(result?.kind, 'reply');
  const reply = (result as { reply: Rec }).reply;
  assert.equal(reply.mode, 'ai', 'the page tags it «Understood with AI help»');
  assert.equal(reply.text, ASSIST_T.en.photo_code_one.replace('{code}', CODE));
  // The candidate chips are ordinary chips the page sends back as a turn when tapped.
  assert.deepEqual(reply.choices[0], { label: ASSIST_T.en.chip_code_yes, intent: 'printer_problem', params: { step: 'code', code: CODE, via: 'photo' } });
  assert.deepEqual(reply.choices.at(-1), { label: ASSIST_T.en.chip_not_this, intent: 'menu' });
  assert.equal(providerCalls(), 1);
});

test('a voice note: the transcript arrives where the page looks for it; a refusal is worded by its code', async () => {
  const heard = 'where is my order';
  const h = aiHarness({ ...FULL, speech: { run: async () => ({ text: heard, transcription_info: { language: 'en', language_probability: 0.95, duration: 2 } }) } });
  const note = h.seedFile('owner', 'audio', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]), 'audio/webm');
  const viewer = asViewer(h, 'owner');
  const { result } = await settle(() => through(viewer, () => readAttachment({ kind: 'voice', key: note, locale: 'en' })));
  assert.deepEqual(result, { kind: 'transcript', text: heard }, 'into the composer, never a bubble');

  // A note asked for as a photo: the server refuses by code, the page words it in its own language.
  const wrongKind = await settle(() => through(viewer, () => readAttachment({ kind: 'photo', key: note, locale: 'ckb' })));
  assert.ok(wrongKind.error instanceof ApiError && wrongKind.error.code === 'AI_READ_KIND');
  assert.deepEqual(refusedRead(wrongKind.error, 'photo', 'ckb'), { kind: 'note', text: ASSIST_AI_READ_REFUSALS.AI_READ_KIND.ckb });

  // Another customer's file, and a file the store no longer holds: the page says the file is gone.
  const theirs = h.seedFile('stranger', 'audio', new Uint8Array([1, 2, 3]), 'audio/webm');
  const notYours = await settle(() => through(viewer, () => readAttachment({ kind: 'voice', key: theirs, locale: 'ar' })));
  assert.ok(notYours.error instanceof ApiError && notYours.error.status === 403);
  assert.deepEqual(refusedRead(notYours.error, 'voice', 'ar'), { kind: 'gone' });
  h.privateBucket.objects.delete(note);
  const gone = await settle(() => through(viewer, () => readAttachment({ kind: 'voice', key: note, locale: 'ar' })));
  assert.ok(gone.error instanceof ApiError && gone.error.code === 'ATTACHMENT_NOT_FOUND');
  assert.deepEqual(refusedRead(gone.error, 'voice', 'ar'), { kind: 'gone' });

  // Signed out: a failed turn the page words itself, and may try again.
  const anon = await settle(() => through(asViewer(h, ''), () => readAttachment({ kind: 'voice', key: note, locale: 'ar' })));
  assert.ok(anon.error instanceof ApiError && anon.error.status === 401);
  assert.deepEqual(refusedRead(anon.error, 'voice', 'ar'), { kind: 'error' });
});

test('clip frames: the multipart the page builds is the one the server takes; a frame over its limit is «frames_failed»', async () => {
  const h = aiHarness(FULL);
  provide(() => answer(photoReading({ symptom: 'stringing' })));
  const clip = h.seedFile('owner', 'video', new Uint8Array([0, 0, 0, 0x18]), 'video/mp4');
  const viewer = asViewer(h, 'owner');
  const frame = () => new Blob([tinyJpeg(1024, 576) as unknown as BlobPart], { type: 'image/jpeg' });
  // The heaviest frame the page keeps (src/lib/assistMedia.ts FRAME_MAX_BYTES) is a frame the server takes.
  const heaviest = new Uint8Array(FRAME_MAX_BYTES);
  heaviest.set(tinyJpeg(1024, 576));
  const { result } = await settle(() =>
    through(viewer, () =>
      readFrames({
        key: clip,
        frames: [frame(), frame(), new Blob([heaviest as unknown as BlobPart], { type: 'image/jpeg' })],
        locale: 'en',
        context: { v: 1, printer: { model: 'A1' } },
      })
    )
  );
  assert.equal(result?.kind, 'reply');
  const reply = (result as { reply: Rec }).reply;
  assert.equal(reply.mode, 'ai');
  assert.ok(reply.text.startsWith(ASSIST_T.en.video_frames_note.replace('{count}', '3')));
  assert.equal(reply.choices[0].params.via, 'clip');

  // One byte over the limit the page aims under is a frame the server refuses: the two limits are one.
  const heavy = new Uint8Array(FRAME_MAX_BYTES + 1);
  heavy.set(tinyJpeg(1024, 576));
  const over = await settle(() =>
    through(viewer, () => readFrames({ key: clip, frames: [frame(), new Blob([heavy as unknown as BlobPart], { type: 'image/jpeg' })], locale: 'ar' }))
  );
  assert.ok(over.error instanceof ApiError && over.error.code === 'AI_FRAMES_INVALID');
  const said = refusedRead(over.error, 'clip', 'ar');
  assert.equal(said.kind, 'note');
  assert.match((said as { text: string }).text, /لم أستطع أخذ لقطات/);
  assert.equal(providerCalls(), 1, 'the refused frames reached no provider');
});

// ------------------------------------------------------------ the owner tab

const LIST = [
  { id: TEXT_MODEL, display_name: 'Test Text Model A', capabilities: { structured_outputs: { supported: true }, image_input: { supported: true } } },
];

test('the owner tab: the GET answer reads into the tab, and what the tab sends back is what the server accepts', async () => {
  providerFetch.handler = async (url) => {
    if (url.startsWith('https://api.anthropic.com/v1/models')) return jsonResponse(200, { data: LIST, has_more: false });
    throw new TypeError('fetch failed');
  };
  const { raw } = aiDb({ capMicro: 2_500_000, guests: true, guestSharePct: 40, models: [textModel('understand', 0)] });
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/assist-ai', adminAssistAiRoutes), {
    env: { ANTHROPIC_API_KEY: KEY },
    publishV2: false,
  });
  const local = async (path: string, init?: RequestInit) => app.request(path, { ...init, headers: { 'CF-Connecting-IP': '1.2.3.4', ...((init?.headers as Record<string, string>) ?? {}) } }, undefined, ctx);
  const BASE = '/api/admin/assist-ai';

  const overview = readOverview(await through(local, () => api.get<unknown>(BASE)));
  assert.equal(overview.migrated, true);
  assert.deepEqual(overview.settings, { enabled: true, daily_cap_usd: 2.5, guests: true, guest_share_pct: 40, understand_ckb: false });
  const row = overview.tasks.find((t) => t.task === 'understand' && t.rank === 0)!;
  assert.equal(row.model_id, TEXT_MODEL);
  assert.deepEqual(row.rates, { in: 1, out: 5, cache_write: 0, cache_read: 0, per_minute: 0 });
  assert.ok(row.worstCaseUsd > 0 && row.ready && !row.worstCaseWarn, 'the worst case of the server, read as the tab shows it');
  assert.equal(overview.health.anthropic_key, true);

  // MasterCard: the whole settings object as read, with one change.
  const saved = await through(local, () => api.put<Rec>(`${BASE}/settings`, { ...overview.settings, enabled: false, daily_cap_usd: 1.25 }));
  assert.equal(saved.success, true);
  const after = readOverview(await through(local, () => api.get<unknown>(BASE)));
  assert.deepEqual(after.settings, { ...overview.settings, enabled: false, daily_cap_usd: 1.25 });

  // ModelRow: the live list as the tab maps it, then the save body the tab builds (each price as the decimal typed).
  const listed = await through(local, () => api.get<{ models?: unknown }>(`${BASE}/models?task=vision`));
  assert.ok(Array.isArray(listed.models));
  assert.deepEqual((listed.models as Rec[]).map((m) => [typeof m.id, typeof m.label]), [['string', 'string']]);
  const body = { model_id: (listed.models as Rec[])[0]!.id, rates: { in: '3', out: '15', cache_write: '0', cache_read: '0.3', per_minute: '0' } };
  const put = await through(local, () => api.put<Rec>(`${BASE}/tasks/vision/1`, body));
  assert.equal(put.success, true);
  const withVision = readOverview(await through(local, () => api.get<unknown>(BASE)));
  assert.deepEqual(withVision.tasks.find((t) => t.task === 'vision')?.rates, { in: 3, out: 15, cache_write: 0, cache_read: 0.3, per_minute: 0 });

  // A refusal reaches the tab as a code it words itself.
  const bad = await through(local, () => api.put(`${BASE}/tasks/vision/1`, { ...body, model_id: 'not-in-the-list' })).catch((e: unknown) => e);
  assert.ok(bad instanceof ApiError && bad.code === 'AI_MODEL_NOT_LISTED');

  // The understanding Test as the tab sends it: the answer carries the fields the tab reads, and no model text.
  provide((url) => (url.endsWith('/v1/messages') ? answer({ action: 'none', intent: 'none', printer: 'none', part: 'none', symptom: 'none', outcome: 'none', maintenance: false, terms: [] }) : jsonResponse(404, {})));
  const tested = await through(local, () => api.post<Rec>(`${BASE}/test/understand`, { rank: 0 }));
  assert.deepEqual(Object.keys(tested).sort(), ['code', 'cost_micro_usd', 'expected', 'ms', 'ok', 'success', 'valid']);
  assert.equal(tested.ok, true);
  assert.equal(typeof tested.cost_micro_usd, 'number');
});
