/**
 * THE READ ROUTES REFUSE BEFORE THEY READ, AND STORE NOTHING (push B plan
 * §16 #11, §5.2–§5.4).
 *
 *   - a guest gets 401 although the gateway lets guests through this prefix;
 *     no consent is 400; another customer's key, or a key in the wrong kind's
 *     folder, is refused before any provider call;
 *   - no Images binding is `photo_unavailable`;
 *   - the photo leaves as a 1568 px JPEG with no EXIF block, within the
 *     limits, or not at all;
 *   - frames: two to four, 400 KB each, JPEG only, the clip key required and
 *     owned, a body over 2 MB is 413, and nothing is ever put to R2;
 *   - voice: Sorani makes no call, a note over 1.5 MB is `voice_too_long`, no
 *     transcript is stored, and no `language` is sent;
 *   - chips are never applied by themselves, and the `code` chip reads its
 *     code again.
 *
 * Run: node --import tsx --test tests/aiReadRoutes.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { aiHarness, bodyOf, FULL, photoReading, provide, providerCalls, resetProvider, tinyJpeg } from './fixtures/aiRoutes';
import { answer } from './fixtures/aiLayer';
import { ASSIST_T } from '../worker/lib/assist/strings';
import { VISION_RENDITION_EDGE, VISION_RENDITION_QUALITY } from '../worker/lib/imageConvert';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

afterEach(() => resetProvider());

const json = async (r: Response): Promise<Rec> => (await r.json()) as Rec;
const ar = ASSIST_T.ar;
const en = ASSIST_T.en;
const PHOTO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
/** Every table a read may write: the ledger and the rate limiter, nothing else. */
const ledgerRows = (h: ReturnType<typeof aiHarness>) =>
  Number((h.raw.prepare('SELECT COUNT(*) AS n FROM ai_usage').get() as { n: number }).n);

test('a guest is asked to sign in, though the gateway lets guests through', async () => {
  const h = aiHarness(FULL);
  provide(() => answer(photoReading()));
  const key = h.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  assert.equal((await h.read('', { kind: 'photo', key })).status, 401);
  const frames = await h.readFrames('', { key: 'assist/u_owner/video/x.mp4', consent: '1', f0: tinyJpeg(), f1: tinyJpeg() });
  assert.equal(frames.status, 401);
  assert.equal(providerCalls(), 0);
});

test('no consent, no read; a bad body or kind is refused by name', async () => {
  const h = aiHarness(FULL);
  provide(() => answer(photoReading()));
  const key = h.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  for (const consent of [undefined, false, 'true', 1]) {
    const res = await h.postJson('owner', '/api/support/assistant/read', { kind: 'photo', key, consent });
    assert.equal(res.status, 400, String(consent));
    assert.equal((await json(res)).code, 'AI_CONSENT_REQUIRED');
  }
  assert.equal((await json(await h.read('owner', { kind: 'video', key }))).code, 'AI_READ_INVALID');
  assert.equal((await json(await h.read('owner', { kind: 'photo', key: '../etc/passwd' }))).code, 'AI_READ_INVALID');
  const noConsentFrames = await h.readFrames('owner', { key: 'assist/u_owner/video/x.mp4', f0: tinyJpeg(), f1: tinyJpeg() });
  assert.equal((await json(noConsentFrames)).code, 'AI_CONSENT_REQUIRED');
  assert.equal(providerCalls(), 0);
});

test('another customer’s key and a key of the wrong kind are refused before any provider call', async () => {
  const h = aiHarness(FULL);
  provide(() => answer(photoReading({ hms_codes: ['0300-0100-0001-0003'] })));
  const theirs = h.seedFile('stranger', 'attachments', PHOTO, 'image/webp');
  const res = await h.read('owner', { kind: 'photo', key: theirs });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'ATTACHMENT_NOT_YOURS');
  const voice = h.seedFile('owner', 'audio', new Uint8Array([1, 2]), 'audio/webm');
  assert.equal((await json(await h.read('owner', { kind: 'photo', key: voice }))).code, 'AI_READ_KIND');
  const photo = h.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  assert.equal((await json(await h.read('owner', { kind: 'voice', key: photo }))).code, 'AI_READ_KIND');
  const theirClip = h.seedFile('stranger', 'video', new Uint8Array([1]), 'video/mp4');
  assert.equal((await h.readFrames('owner', { key: theirClip, consent: '1', f0: tinyJpeg(), f1: tinyJpeg() })).status, 403);
  assert.equal((await json(await h.readFrames('owner', { key: photo, consent: '1', f0: tinyJpeg(), f1: tinyJpeg() }))).code, 'AI_READ_KIND');
  const gone = 'assist/u_owner/attachments/00000000.webp';
  assert.equal((await json(await h.read('owner', { kind: 'photo', key: gone }))).code, 'ATTACHMENT_NOT_FOUND');
  assert.equal(providerCalls(), 0);
  assert.equal(ledgerRows(h), 0);
  assert.equal(h.ai.runs.length, 0);
});

test('no Images binding, the layer off, or the limits spent: «photo_unavailable», and no call', async () => {
  const noImages = aiHarness({ ...FULL, noImages: true });
  provide(() => answer(photoReading()));
  const key = noImages.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  const r1 = await json(await noImages.read('owner', { kind: 'photo', key }));
  assert.equal(r1.reply.text, ar.photo_unavailable);
  assert.equal(r1.reply.mode, undefined, 'a basic reply carries no mode');

  const off = aiHarness({ ...FULL, enabled: false });
  const k2 = off.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  assert.equal((await json(await off.read('owner', { kind: 'photo', key: k2, locale: 'en' }))).reply.text, en.photo_unavailable);
  assert.equal(Number((off.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get() as { n: number }).n), 0, 'a dark layer writes nothing');

  const limited = aiHarness(FULL);
  const k3 = limited.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  for (let i = 0; i < 10; i++) assert.ok((await json(await limited.read('owner', { kind: 'photo', key: k3 }))).reply);
  const over = await json(await limited.read('owner', { kind: 'photo', key: k3 }));
  assert.equal(over.reply.text, ar.photo_unavailable, 'the eleventh read in an hour');
  assert.equal(providerCalls(), 10);
});

test('the photo leaves as a 1568 px JPEG without its EXIF block, read in memory, stored nowhere', async () => {
  const h = aiHarness(FULL);
  let sent: Rec = {};
  provide(async (_url, init) => {
    sent = await bodyOf(init);
    return answer(photoReading({ hms_codes: ['0300-0100-0001-0003'] }));
  });
  const key = h.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  const puts = h.privateBucket.puts + h.publicBucket.puts;
  const res = await h.read('owner', { kind: 'photo', key });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control') ?? '', /private, no-store/);
  const reply = (await json(res)).reply;
  assert.equal(reply.text, ar.photo_code_one.replace('{code}', '0300-0100-0001-0003'));
  assert.equal(reply.mode, 'ai');
  // The rendition: the Images binding asked for a scaled-down JPEG.
  assert.deepEqual(h.images.calls[0], {
    transform: { width: VISION_RENDITION_EDGE, height: VISION_RENDITION_EDGE, fit: 'scale-down' },
    output: { format: 'image/jpeg', quality: VISION_RENDITION_QUALITY },
  });
  // What reached the provider is the stripped JPEG: no APP1 (FF E1), no comment (FF FE).
  const image = (sent.messages[0].content as Rec[]).find((b) => b.type === 'image')!;
  assert.equal(image.source.media_type, 'image/jpeg');
  const bytes = Buffer.from(image.source.data, 'base64');
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  for (let i = 0; i + 1 < bytes.length; i++) {
    assert.ok(!(bytes[i] === 0xff && (bytes[i + 1] === 0xe1 || bytes[i + 1] === 0xfe)), `a metadata marker survived at ${i}`);
  }
  assert.equal(h.privateBucket.puts + h.publicBucket.puts, puts, 'nothing is put to R2');
  assert.equal(h.privateBucket.objects.size, 1, 'only the customer’s own upload is there');
});

test('a rendition over the photo limits is never sent: «photo_unclear»', async () => {
  const oversize = new Uint8Array(1_500_100);
  oversize.set(tinyJpeg(800, 600));
  for (const [name, rendition] of [
    ['a side over 1600', tinyJpeg(1700, 900)],
    ['not a JPEG', new Uint8Array([1, 2, 3, 4])],
    ['over 1.5 MB', oversize],
  ] as const) {
    const h = aiHarness({ ...FULL, rendition });
    provide(() => answer(photoReading()));
    const key = h.seedFile('owner', 'attachments', PHOTO, 'image/webp');
    const reply = (await json(await h.read('owner', { kind: 'photo', key }))).reply;
    assert.equal(reply.text, ar.photo_unclear, name);
    assert.equal(providerCalls(), 0, name);
  }
});

test('frames: two to four JPEGs within the limits, the body capped at 2 MB, nothing stored', async () => {
  const h = aiHarness(FULL);
  provide(() => answer(photoReading({ symptom: 'stringing' })));
  const clip = h.seedFile('owner', 'video', new Uint8Array([0, 0, 0, 0x18]), 'video/mp4');
  const frame = tinyJpeg(1024, 576);
  const ok = await h.readFrames('owner', { key: clip, consent: '1', locale: 'en', f0: frame, f1: frame, f2: frame });
  assert.equal(ok.status, 200);
  const reply = (await json(ok)).reply;
  assert.equal(reply.text, `${en.video_frames_note.replace('{count}', '3')} ${en.photo_symptom.replace('{symptom}', reply.text.match(/«(.+)»/)[1])}`);
  assert.equal(reply.choices[0].params.via, 'clip');
  assert.equal(providerCalls(), 1);

  const refused = async (fields: Record<string, string | Uint8Array>, status = 400, code = 'AI_FRAMES_INVALID') => {
    const res = await h.readFrames('owner', { key: clip, consent: '1', ...fields });
    assert.equal(res.status, status, JSON.stringify(Object.keys(fields)));
    assert.equal((await json(res)).code, code);
  };
  await refused({ f0: frame }, 400);
  await refused({ f0: frame, f1: frame, f2: frame, f3: frame, f4: frame });
  await refused({ f0: frame, extra: frame });
  await refused({ f0: frame, f1: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, 400);
  await refused({ f0: frame, f1: tinyJpeg(1281, 720) });
  await refused({ f0: frame, f1: tinyJpeg(640, 480, { app1: true }) });
  const big = new Uint8Array(400_001);
  big.set(frame);
  await refused({ f0: frame, f1: big });
  const huge = new Uint8Array(2 * 1024 * 1024 + 10);
  const tooBig = await h.readFrames('owner', { key: clip, consent: '1', f0: frame, f1: huge });
  assert.equal(tooBig.status, 413);
  assert.equal((await json(tooBig)).code, 'AI_FRAMES_TOO_LARGE');
  const noKey = await h.readFrames('owner', { consent: '1', f0: frame, f1: frame });
  assert.equal((await json(noKey)).code, 'AI_READ_INVALID', 'the clip key is required');
  assert.equal(providerCalls(), 1, 'no refused request reached the provider');
  assert.equal(h.privateBucket.puts + h.publicBucket.puts, 0, 'no frame is ever put to R2');
  assert.equal(h.privateBucket.objects.size, 1);
});

test('voice: Sorani is never sent, a long note is refused by size, and the transcript is never stored', async () => {
  const heard = 'النوزل مسدود';
  const h = aiHarness({ ...FULL, speech: { run: async () => ({ text: heard, transcription_info: { language: 'ar', language_probability: 0.9, duration: 3 } }) } });
  const note = h.seedFile('owner', 'audio', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]), 'audio/webm');
  const ckb = await json(await h.read('owner', { kind: 'voice', key: note, locale: 'ckb' }));
  assert.equal(ckb.reply.text, ASSIST_T.ckb.voice_ckb);
  assert.equal(h.ai.runs.length, 0, 'no Sorani note is sent');

  const long = h.seedFile('owner', 'audio', new Uint8Array(1_500_001), 'audio/webm');
  assert.equal((await json(await h.read('owner', { kind: 'voice', key: long }))).reply.text, ar.voice_too_long);
  assert.equal(h.ai.runs.length, 0);

  const res = await h.read('owner', { kind: 'voice', key: note, locale: 'ar' });
  assert.match(res.headers.get('Cache-Control') ?? '', /private, no-store/);
  const body = await json(res);
  assert.deepEqual(body, { success: true, transcript: heard }, 'the transcript alone, at the top level, never in a reply');
  assert.equal(h.ai.runs.length, 1);
  assert.deepEqual(Object.keys(h.ai.runs[0].inputs), ['audio'], 'no language is ever forced');
  // Stored nowhere: no table holds it, no object carries it.
  const dump = JSON.stringify(h.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap((t) => {
    const name = (t as { name: string }).name;
    try {
      return h.raw.prepare(`SELECT * FROM "${name}"`).all();
    } catch {
      return [];
    }
  }));
  assert.ok(!dump.includes(heard), 'the transcript is in a table');
  assert.equal(h.privateBucket.puts + h.publicBucket.puts, 0);
});

test('voice: an unclear or failed transcription is a template, never the provider’s words', async () => {
  const cases: Array<[() => unknown, string]> = [
    [() => ({ text: 'hola', transcription_info: { language: 'es' } }), ar.voice_unclear],
    [() => ({ text: 'نۆزڵەکە گیراوە' }), ar.voice_unclear],
    [
      () => {
        throw new Error('AiError: 3040: capacity');
      },
      ar.voice_unavailable,
    ],
  ];
  for (const [result, expected] of cases) {
    const h = aiHarness({ ...FULL, speech: { run: async () => result() } });
    const note = h.seedFile('owner', 'audio', new Uint8Array([1, 2, 3]), 'audio/webm');
    const body = await json(await h.read('owner', { kind: 'voice', key: note }));
    assert.equal(body.reply.text, expected, JSON.stringify(result));
    assert.equal(body.transcript, undefined);
  }
  const off = aiHarness({ ...FULL, noAi: true });
  const note = off.seedFile('owner', 'audio', new Uint8Array([1, 2, 3]), 'audio/webm');
  assert.equal((await json(await off.read('owner', { kind: 'voice', key: note }))).reply.text, ar.voice_unavailable);
});

test('chips are candidates only, and the code chip reads its code again', async () => {
  const h = aiHarness(FULL);
  provide(() => answer(photoReading({ hms_codes: ['0300-0100-0001-0003'] })));
  const key = h.seedFile('owner', 'attachments', PHOTO, 'image/webp');
  const reply = (await json(await h.read('owner', { kind: 'photo', key }))).reply;
  assert.equal(reply.context, undefined, 'nothing chosen: the conversation is unchanged until a tap');
  assert.equal(reply.steps, undefined);
  const chip = reply.choices[0];
  assert.deepEqual(chip.params, { step: 'code', code: '0300-0100-0001-0003', via: 'photo' });

  // Tapped: the HMS triage starts with that code, exactly as if typed.
  const tapped = (await h.assistant('owner', { intent: chip.intent, params: chip.params, context: { v: 1 } })).reply;
  assert.equal(tapped.context.triage.symptom, 'hms');
  assert.equal(tapped.context.triage.code, '0300-0100-0001-0003');
  assert.deepEqual(tapped.context.ai_read, ['code']);
  assert.equal(tapped.mode, undefined, 'a tap is an ordinary push A turn');

  // A forged code is read again and refused: the menu chip's start, no code anywhere.
  for (const code of ['0300-0100-0001', 'DROP TABLE', '2024-1000-5000-3000', 'ZZMO-DELZ']) {
    const forged = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'code', code, via: 'photo' }, context: { v: 1 } })).reply;
    assert.equal(forged.context.triage?.code, undefined, code);
    assert.ok(!JSON.stringify(forged).includes(code), code);
    assert.equal(forged.context.ai_read, undefined);
  }
  // The «not this» chip is the topic menu.
  const menu = (await h.assistant('owner', { intent: reply.choices[1].intent, context: { v: 1 } })).reply;
  assert.equal(menu.intent, 'clarify');
});
