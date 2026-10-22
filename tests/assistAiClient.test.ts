/**
 * THE ASSISTANT AI LAYER IN THE BROWSER (push B1, plan §5.2-§5.5, §8, §11-§13).
 *
 * The server half is built and tested on its own (plan §16). This pins the
 * client half against the same contracts:
 *
 *   - readiness is trusted strictly, and anything else is basic mode (push A,
 *     unchanged): a 404 before the server half lands, a malformed body, a read
 *     whose company is not named;
 *   - the reads send exactly what the plan names, with `consent: true`, to
 *     this origin only;
 *   - a transcript is a draft in the composer of the customer: cleaned,
 *     at most 500 characters, never a bubble, a chip or a reply, never sent
 *     for them; a read chip is a question the customer asks, never an action
 *     the page takes; candidate chips wait for a tap;
 *   - Sorani speech is never sent: a Sorani screen shows the hint instead;
 *   - the consent sheet comes before the first read of each kind in a browser
 *     session, names the company, and a decline sends nothing;
 *   - the owner tab reads its numbers in USD and estimates the worst case of
 *     one call the way the server reserves it;
 *   - the desk names the facts a reading supplied.
 *
 * Run: node --import tsx --test tests/assistAiClient.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import {
  AI_CONSENT_KEY,
  AI_READ_INTENT,
  AI_READ_INVALID,
  BASIC_READINESS,
  READ_FRAMES_PATH,
  READ_PATH,
  READINESS_PATH,
  canRead,
  cleanTranscript,
  consentScope,
  fetchReadiness,
  providerFor,
  readAttachment,
  readChoiceTarget,
  readChoices,
  readConsent,
  readFrames,
  readReadiness,
  readResult,
  rememberConsent,
  voiceCkbHintDue,
  type AiReadiness,
} from '../src/lib/assistAi';
import { ApiError } from '../src/lib/api';
import { LanguageProvider } from '../src/LanguageContext';
import { ASSIST_VOICE_MAX_SECONDS, AssistAiRead } from '../src/components/support/AssistAttach';
import { MODEL_ID_SHAPE, normalizeUsd, parseUsd, readOverview } from '../src/components/AdminAssistAi';
import { readByAiFields } from '../src/components/adminSupport/TicketsDesk';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const AI: AiReadiness = readReadiness({
  success: true,
  mode: 'ai',
  text: true,
  photo: true,
  clip: true,
  voice: true,
  voice_locales: ['ar', 'en'],
  photo_provider: 'anthropic',
  voice_provider: 'cloudflare',
});

// ------------------------------------------------------------- readiness

test('readiness: a well-formed answer is read as it is', () => {
  assert.deepEqual(AI, {
    mode: 'ai',
    text: true,
    photo: true,
    clip: true,
    voice: true,
    voiceLocales: ['ar', 'en'],
    photoProvider: 'anthropic',
    voiceProvider: 'cloudflare',
  });
});

test('readiness: anything else is basic mode, never a guess', () => {
  for (const raw of [
    null,
    undefined,
    'ai',
    [],
    { success: false, mode: 'ai', text: true },
    { mode: 'AI', text: true },
    { mode: 'ai' },
    { mode: 'ai', text: 'true', photo: 1, clip: 'yes', voice: {} },
    { mode: 'basic', text: true, photo: true, photo_provider: 'anthropic' },
  ]) {
    assert.deepEqual(readReadiness(raw), BASIC_READINESS, JSON.stringify(raw));
  }
});

test('readiness: a read whose company is not named is off (the consent must name it)', () => {
  const r = readReadiness({ mode: 'ai', text: true, photo: true, clip: true, voice: true, voice_locales: ['ar'], photo_provider: 'someone', voice_provider: null });
  assert.equal(r.mode, 'ai');
  assert.equal(r.text, true);
  assert.equal(r.photo, false);
  assert.equal(r.clip, false);
  assert.equal(r.voice, false);
  assert.equal(r.photoProvider, null);
  assert.equal(r.voiceProvider, null);
});

test('readiness: Sorani is never a speech language, whatever the answer says', () => {
  const r = readReadiness({ mode: 'ai', voice: true, voice_locales: ['ckb', 'ar', 'ar', 'fr', 7], voice_provider: 'cloudflare' });
  assert.deepEqual(r.voiceLocales, ['ar']);
  assert.equal(canRead('voice', r, 'ckb'), false);
  assert.equal(canRead('voice', r, 'en'), false, 'not in the list');
  assert.equal(canRead('voice', r, 'ar'), true);
  assert.equal(readReadiness({ mode: 'ai', voice: true, voice_locales: ['ckb'], voice_provider: 'cloudflare' }).mode, 'basic');
});

test('readiness: fetched silently from this origin, and every failure is basic', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true, mode: 'ai', text: true, photo: false, clip: false, voice: false, voice_locales: [], photo_provider: null, voice_provider: null }), { status: 200 });
    }) as typeof fetch;
    const r = await fetchReadiness();
    assert.equal(r.mode, 'ai');
    assert.equal(r.text, true);
    assert.equal(calls[0].url, READINESS_PATH);
    assert.equal(calls[0].url, '/api/support/assistant/readiness');
    assert.equal(calls[0].init.method, 'GET');
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })) as typeof fetch;
    assert.deepEqual(await fetchReadiness(), BASIC_READINESS, 'a 404 (server half not deployed) is basic');
    globalThis.fetch = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    assert.deepEqual(await fetchReadiness(), BASIC_READINESS, 'a body that is not JSON is basic');
    globalThis.fetch = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    assert.deepEqual(await fetchReadiness(), BASIC_READINESS, 'no network is basic');
  } finally {
    globalThis.fetch = real;
  }
});

// ------------------------------------------------------------------ chips

const LABELS = { photo: 'اقرأ الصورة', clip: 'اقرأ المقطع', voice: 'حوّل التسجيل إلى نص' };

test('read chips: one per file this viewer may have read, numbered when a kind repeats, none in basic mode', () => {
  const files = [
    { key: 'assist/u1/images/a.webp', kind: 'image' as const },
    { key: 'assist/u1/videos/b.mp4', kind: 'video' as const },
    { key: 'assist/u1/images/c.webp', kind: 'image' as const },
    { key: 'assist/u1/audio/d.webm', kind: 'audio' as const },
  ];
  const chips = readChoices(files, AI, 'ar', LABELS);
  assert.deepEqual(
    chips.map((c) => [c.label, c.intent, c.params.kind, c.params.key]),
    [
      ['اقرأ الصورة ١', AI_READ_INTENT, 'photo', 'assist/u1/images/a.webp'],
      ['اقرأ المقطع', AI_READ_INTENT, 'clip', 'assist/u1/videos/b.mp4'],
      ['اقرأ الصورة ٢', AI_READ_INTENT, 'photo', 'assist/u1/images/c.webp'],
      ['حوّل التسجيل إلى نص', AI_READ_INTENT, 'voice', 'assist/u1/audio/d.webm'],
    ]
  );
  assert.deepEqual(readChoices(files, BASIC_READINESS, 'ar', LABELS), [], 'basic mode offers nothing new');
  // Sorani screen: photos and clips yes, the voice note never.
  assert.deepEqual(readChoices(files, AI, 'ckb', LABELS).map((c) => c.params.kind), ['photo', 'clip', 'photo']);
  assert.equal(voiceCkbHintDue(AI, 'ckb', files.map((f) => f.kind)), true);
  assert.equal(voiceCkbHintDue(AI, 'ar', files.map((f) => f.kind)), false);
  assert.equal(voiceCkbHintDue(BASIC_READINESS, 'ckb', ['audio']), false, 'basic mode says nothing new');
  assert.equal(voiceCkbHintDue(AI, 'ckb', ['image']), false);
  // A declined kind is not offered again in this session; the other kind still is.
  assert.deepEqual(readChoices(files, AI, 'en', LABELS, (scope) => scope === 'media').map((c) => c.params.kind), ['voice']);
  assert.equal(readChoices([{ key: 'assist/u1/images/a.webp', kind: 'image' }, { key: 'assist/u1/images/b.webp', kind: 'image' }], AI, 'en', LABELS)[1].label, 'اقرأ الصورة 2');
});

test('a read chip names an owned assistant key and a known kind, or nothing', () => {
  assert.deepEqual(readChoiceTarget({ key: 'assist/u1/images/a.webp', kind: 'photo' }), { key: 'assist/u1/images/a.webp', kind: 'photo' });
  for (const params of [
    undefined,
    null,
    'assist/u1/a.webp',
    { key: 'assist/u1/a.webp' },
    { key: 'assist/u1/a.webp', kind: 'video' },
    { key: 'chat/u1/a.webp', kind: 'photo' },
    { key: '/files/assist/u1/a.webp', kind: 'photo' },
    { key: 'assist/u1/../u2/a.webp', kind: 'photo' },
    { key: 'assist/u1/a b.webp', kind: 'photo' },
    { key: 7, kind: 'photo' },
  ]) {
    assert.equal(readChoiceTarget(params), null, JSON.stringify(params));
  }
});

test('the company a read goes to, for the consent sheet: a company name, never a model', () => {
  assert.equal(providerFor('photo', AI), 'Anthropic');
  assert.equal(providerFor('clip', AI), 'Anthropic');
  assert.equal(providerFor('voice', AI), 'Cloudflare');
  assert.equal(providerFor('photo', BASIC_READINESS), '');
});

// ------------------------------------------------------------------ consent

function memoryStore() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
}

test('consent: remembered per kind for the browser session, in its one key; a broken store asks again', () => {
  const store = memoryStore();
  assert.equal(readConsent('media', store), null);
  rememberConsent('media', true, store);
  assert.equal(readConsent('media', store), true);
  assert.equal(readConsent('voice', store), null, 'a yes for photos is not a yes for voice notes (another company)');
  rememberConsent('voice', false, store);
  assert.equal(readConsent('voice', store), false);
  assert.equal(readConsent('media', store), true);
  assert.deepEqual(JSON.parse(store.map.get(AI_CONSENT_KEY)!), { media: 1, voice: 0 });
  assert.equal(AI_CONSENT_KEY, 'levonis.assist.aiConsent.v1');
  assert.equal(consentScope('photo'), 'media');
  assert.equal(consentScope('clip'), 'media');
  assert.equal(consentScope('voice'), 'voice');
  // Garbage and a throwing store: no answer, no exception.
  store.map.set(AI_CONSENT_KEY, '{nope');
  assert.equal(readConsent('media', store), null);
  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.equal(readConsent('media', throwing), null);
  assert.doesNotThrow(() => rememberConsent('media', true, throwing));
  assert.equal(readConsent('media', null), null);
  assert.doesNotThrow(() => rememberConsent('voice', true));
});

// ------------------------------------------------------------- the reads

test('a transcript is cleaned and bounded; it wins over anything else in the body', () => {
  assert.equal(cleanTranscript('  وين   طلبي\n\tالأخير  '), 'وين طلبي الأخير');
  assert.equal(cleanTranscript('a\u0000b‮c⁦d'), 'a b c d');
  assert.equal(cleanTranscript('x'.repeat(500))?.length, 500);
  assert.equal(cleanTranscript('x'.repeat(501)), null);
  assert.equal(cleanTranscript('   '), null);
  assert.equal(cleanTranscript(42), null);
  assert.deepEqual(readResult({ success: true, transcript: ' hello ', reply: { intent: 'x', text: 'MARKER' } }), { kind: 'transcript', text: 'hello' });
  assert.deepEqual(readResult({ success: true, reply: { intent: 'printer_problem', text: 'قرأتُ…', choices: [] } }), {
    kind: 'reply',
    reply: { intent: 'printer_problem', text: 'قرأتُ…', choices: [] },
  });
  for (const raw of [null, {}, { success: false, transcript: 'x' }, { reply: { text: 'no intent' } }, { reply: { intent: 'x', text: '  ' } }, { transcript: '' }]) {
    assert.equal(readResult(raw), null, JSON.stringify(raw));
  }
});

async function capture(run: () => Promise<unknown>, answer: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), { status });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } catch (error) {
    return { error, calls };
  } finally {
    globalThis.fetch = real;
  }
}

test('photo and voice reads: this origin, a POST with exactly kind, key, consent true, locale and context', async () => {
  const context = { printer: 'A1' };
  const photo = await capture(() => readAttachment({ kind: 'photo', key: 'assist/u1/images/a.webp', locale: 'ar', context }), {
    success: true,
    reply: { intent: 'printer_problem', text: 'x' },
  });
  assert.equal(photo.calls.length, 1);
  assert.equal(photo.calls[0].url, READ_PATH);
  assert.equal(photo.calls[0].url, '/api/support/assistant/read');
  assert.equal(photo.calls[0].init.method, 'POST');
  assert.equal(photo.calls[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(photo.calls[0].init.body)), { kind: 'photo', key: 'assist/u1/images/a.webp', consent: true, locale: 'ar', context });
  assert.equal((photo.result as { kind: string }).kind, 'reply');

  const voice = await capture(() => readAttachment({ kind: 'voice', key: 'assist/u1/audio/d.webm', locale: 'en' }), { success: true, transcript: 'where is my order' });
  assert.deepEqual(JSON.parse(String(voice.calls[0].init.body)), { kind: 'voice', key: 'assist/u1/audio/d.webm', consent: true, locale: 'en' });
  assert.deepEqual(voice.result, { kind: 'transcript', text: 'where is my order' });

  const junk = await capture(() => readAttachment({ kind: 'photo', key: 'assist/u1/images/a.webp', locale: 'ar' }), { success: true, nothing: 1 });
  assert.ok(junk.error instanceof ApiError && junk.error.code === AI_READ_INVALID, 'an answer the page cannot use is a failed turn');
  const refused = await capture(() => readAttachment({ kind: 'photo', key: 'assist/u1/images/a.webp', locale: 'ar' }), { success: false, code: 'AI_CONSENT_REQUIRED', error: 'x' }, 400);
  assert.ok(refused.error instanceof ApiError && refused.error.status === 400);
});

test('clip frames: multipart with the clip key, consent, locale, context and f0..f3 only', async () => {
  const frames = [1, 2, 3, 4, 5].map((n) => new Blob([new Uint8Array([0xff, 0xd8, n])], { type: 'image/jpeg' }));
  const { calls, result } = await capture(() => readFrames({ key: 'assist/u1/videos/b.mp4', frames, locale: 'ar', context: { stage: 'steps' } }), {
    success: true,
    reply: { intent: 'printer_problem', text: 'x' },
  });
  assert.equal(calls[0].url, READ_FRAMES_PATH);
  assert.equal(calls[0].url, '/api/support/assistant/read-frames');
  const form = calls[0].init.body as FormData;
  assert.ok(form instanceof FormData);
  const names = [...(form as unknown as { keys(): IterableIterator<string> }).keys()];
  assert.deepEqual(names, ['key', 'consent', 'locale', 'context', 'f0', 'f1', 'f2', 'f3'], 'at most four frames');
  assert.equal(form.get('key'), 'assist/u1/videos/b.mp4');
  assert.equal(form.get('consent'), '1');
  assert.equal(form.get('locale'), 'ar');
  assert.deepEqual(JSON.parse(String(form.get('context'))), { stage: 'steps' });
  assert.equal((form.get('f0') as File).type, 'image/jpeg');
  assert.equal((result as { kind: string }).kind, 'reply');
});

// ------------------------------------------------------- the consent sheet

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const job = (kind: 'photo' | 'clip' | 'voice') => ({
  kind,
  attachment: { key: `assist/u1/${kind}/x.bin`, url: `/files/assist/u1/${kind}/x.bin`, kind: kind === 'photo' ? ('image' as const) : kind === 'clip' ? ('video' as const) : ('audio' as const) },
});
const noop = () => undefined;

test('the consent sheet names the company and offers «لا، أرفقه فقط» beside «موافق، اقرأه»; nothing is sent while it shows', async () => {
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response('{}');
  }) as typeof fetch;
  try {
    const photo = render(createElement(AssistAiRead, { lang: 'ar', job: job('photo'), provider: 'Anthropic', askConsent: true, context: undefined, onConsent: noop, onDone: noop, onCancel: noop }));
    assert.match(photo, /data-assist-consent="photo"/);
    assert.match(photo, /role="dialog"/);
    assert.match(photo, /قبل قراءة المرفق/);
    assert.match(photo, /\(Anthropic\)/);
    assert.match(photo, /موافق، اقرأه/);
    assert.match(photo, /لا، أرفقه فقط/);
    // The whole privacy clause (plan §12.5) is one tap away, in a new tab.
    assert.match(photo, /href="\/policies\/assistant_ai" target="_blank" rel="noopener noreferrer"/);
    const voice = render(createElement(AssistAiRead, { lang: 'en', job: job('voice'), provider: 'Cloudflare', askConsent: true, context: undefined, onConsent: noop, onDone: noop, onCancel: noop }));
    assert.match(voice, /speech service of Cloudflare/);
    assert.match(voice, /No, just attach it/);
    const ckb = render(createElement(AssistAiRead, { lang: 'ckb', job: job('clip'), provider: 'Anthropic', askConsent: true, context: undefined, onConsent: noop, onDone: noop, onCancel: noop }));
    assert.match(ckb, /پێش خوێندنەوەی هاوپێچەکە/);
    // Already accepted in this session: the sheet is skipped, and the busy line says what is happening.
    const busy = render(createElement(AssistAiRead, { lang: 'ar', job: job('clip'), provider: 'Anthropic', askConsent: false, context: undefined, onConsent: noop, onDone: noop, onCancel: noop }));
    assert.match(busy, /data-assist-reading="frames"/);
    assert.match(busy, /أستخرج لقطات من المقطع/);
    assert.doesNotMatch(busy, /data-assist-consent/);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fetched, 0, 'rendering never reads: only an accepted sheet or an earlier yes starts a read');
  } finally {
    globalThis.fetch = real;
  }
});

test('the sheet reads only after «موافق»: a decline remembers no and closes; a clip with too few frames sends nothing', () => {
  const sheet = read('src/components/support/AssistAttach.tsx');
  const read_ = sheet.slice(sheet.indexOf('export function AssistAiRead'));
  // Decline: remember the no, close, never run.
  assert.match(read_, /onConsent\(false\);\s*onCancel\(\);/);
  // Accept: remember the yes, then run.
  assert.match(read_, /onConsent\(true\);\s*void run\(\);/);
  // On mount: the run starts only when no consent is asked.
  assert.match(read_, /if \(askConsent\) acceptRef\.current\?\.focus\(\);\s*else void run\(\);/);
  // A clip: frames first, on this device, and fewer than MIN_FRAMES is a note with no request.
  const frames = read_.indexOf('media.extractFrames(');
  const guard = read_.indexOf('frames.length < media.MIN_FRAMES');
  const post = read_.indexOf('readFrames(');
  assert.ok(frames > 0 && guard > frames && post > guard, 'extract, check, then post');
  assert.match(read_, /await import\('\.\.\/\.\.\/lib\/assistMedia'\)/);
  // 413 on the frames is the same sentence as frames that could not be taken.
  assert.match(read_, /err\.status === 413\) finish\(\{ kind: 'note', text: t\.framesFailed \}\)/);
});

test('the + sheet: the one-minute cap, the recording kept, attaching it still the choice of the customer', () => {
  assert.equal(ASSIST_VOICE_MAX_SECONDS, 60);
  const sheet = read('src/components/support/AssistAttach.tsx');
  assert.match(sheet, /useVoiceRecorder\(\{ maxSeconds: ASSIST_VOICE_MAX_SECONDS, onLimit: \(file\) => setCapped\(file\) \}\)/);
  assert.match(sheet, /\{t\.voiceLimit\}/);
  assert.match(sheet, /onClick=\{\(\) => void attachCapped\(\)\}/);
  // The picked file reaches the page with its upload answer (a clip is read from memory in this visit).
  assert.match(sheet, /onAttached\(\{ key: up\.key, url: up\.url, kind: kindOf\(mime\), mime \}, file\)/);
  // The order chat keeps a recorder without a cap; the owner speech Test records ten seconds.
  assert.match(read('src/pages/Chat.tsx'), /useVoiceRecorder\(\)/);
  assert.match(read('src/components/adminOrders/OrderChatPanel.tsx'), /useVoiceRecorder\(\)/);
  assert.match(read('src/components/AdminAssistAi.tsx'), /useVoiceRecorder\(\{ maxSeconds: 10,/);
  const rec = read('src/lib/voiceRecorder.ts');
  assert.match(rec, /export function useVoiceRecorder\(options: VoiceRecorderOptions = \{\}\): VoiceRecorder/);
  assert.match(rec, /seconds >= maxSeconds && rec\.state !== 'inactive' && !settleRef\.current/);
});

// -------------------------------------------------------- the Support page

test('Support: the transcript goes into the composer only, never into a bubble, and is never sent for the customer', () => {
  const page = read('src/pages/Support.tsx');
  const finish = page.slice(page.indexOf('const finishRead'), page.indexOf('const sendText'));
  const branch = finish.slice(finish.indexOf("if (outcome.kind === 'transcript')"), finish.indexOf('return;', finish.indexOf("if (outcome.kind === 'transcript')")));
  assert.match(branch, /const heardText = outcome\.text;/);
  assert.match(branch, /setInput\(\(typed\) => \(typed\.trim\(\) \? `\$\{typed\.trim\(\)\} \$\{heardText\}` : heardText\)\.slice\(0, TRANSCRIPT_MAX\)\);/, 'after what was typed, never over it');
  assert.match(branch, /setHeard\(true\);/);
  assert.doesNotMatch(branch, /setMessages|send\(/, 'a transcript never becomes a message');
  assert.doesNotMatch(finish, /outcome\.text[^;]*setMessages|text: outcome\.text/, 'the transcript is never the text of a bubble');
  // «هذا ما سمعته» stands over the composer while the draft is there; sending is the ordinary text turn.
  assert.match(page, /\{heard && input\.trim\(\) !== '' && \(/);
  assert.match(page, /\{s\.voiceHeard\}/);
  const sendText = page.slice(page.indexOf('const sendText'), page.indexOf('const onTicketCreated'));
  assert.match(sendText, /send\(\{ text: q \}, q\);/);
});

test('Support: a read chip is answered by the page (never sent to the server), and its file must still be attached', () => {
  const page = read('src/pages/Support.tsx');
  const tap = page.slice(page.indexOf('const tapChoice'), page.indexOf('return (', page.indexOf('const tapChoice')));
  assert.match(tap, /if \(choice\.intent !== AI_READ_INTENT\) \{\s*send\(\{ intent: choice\.intent, params: choice\.params \}, choice\.label\);\s*return;\s*\}/);
  assert.match(tap, /if \(job\) setReadJob\(\{ job, label: choice\.label \}\);/);
  assert.match(page, /onClick=\{\(\) => tapChoice\(choice\)\}/);
  const target = page.slice(page.indexOf('const readTarget'), page.indexOf('const finishRead'));
  assert.match(target, /canRead\(target\.kind, readiness, lang\)/);
  assert.match(target, /attachments\.find\(\(a\) => a\.key === target\.key\)/);
  // Chips the page cannot act on are not drawn.
  assert.match(page, /filter\(\(ch\) => ch\.intent !== AI_READ_INTENT \|\| readTarget\(ch\) !== null\)/);
});

test('Support: candidate chips of a read reply are an ordinary reply; nothing is applied for the customer', () => {
  const page = read('src/pages/Support.tsx');
  const finish = page.slice(page.indexOf('const finishRead'), page.indexOf('const sendText'));
  const reply = finish.slice(finish.indexOf("if (outcome.kind === 'reply')"), finish.indexOf('const said'));
  assert.match(reply, /setMessages\(\(prev\) => \[\.\.\.prev, asked, \{ role: 'assistant', text: reply\.text, reply \}\]\);/);
  assert.doesNotMatch(reply, /send\(|tapChoice\(|setReadJob\(\{/, 'a read reply never triggers a turn by itself');
});

test('Support: readiness picks the greeting, ai_tag only under an AI reply, the Sorani hint, and every read waits for the one under way', () => {
  const page = read('src/pages/Support.tsx');
  assert.match(page, /const greetingText = readiness\.mode === 'ai' \? s\.greetingAi : s\.greeting;/);
  assert.match(page, /\}, \[lang, readiness\.mode\]\);/);
  // The greeting is replaced only on a screen that is still just the greeting.
  assert.match(page, /setMessages\(\(prev\) => \(prev\.some\(\(m\) => m\.role === 'user'\) \? prev : greetingRef\.current\(\)\)\);/);
  assert.match(page, /\{m\.role === 'assistant' && m\.reply\?\.mode === 'ai' && \(/);
  assert.match(page, /\{s\.aiTag\}/);
  assert.match(page, /voiceCkbHintDue\(readiness, lang, added\.map\(\(a\) => a\.kind\)\)/);
  assert.match(page, /readChoices\(added, readiness, lang, readLabels, \(scope\) => readConsent\(scope\) === false\)/);
  assert.match(page, /if \(v\.mode === 'ai'\) out\.mode = 'ai';/, 'the tag survives a reload, and only for an AI reply');
  assert.match(page, /disabled=\{busy \|\| reading\}/);
  assert.match(page, /if \(!q \|\| reading\) return;/);
  // The consent sheet and the read are the lazy + sheet chunk; Support imports only types from it.
  assert.match(page, /const AssistAiRead = lazy\(\(\) => import\('\.\.\/components\/support\/AssistAttach'\)\.then\(\(m\) => \(\{ default: m\.AssistAiRead \}\)\)\);/);
  assert.match(page, /^import type \{ AssistAttachment, AssistReadJob, AssistReadOutcome \} from '\.\.\/components\/support\/AssistAttach';$/m);
  // A clip as picked stays in memory for this visit only, and goes with every reset.
  assert.match(page, /pickedClips\.current\.clear\(\);/);
});

// ------------------------------------------------------------ the owner tab

test('the owner tab reads the numbers the owner types (Arabic-Indic digits too) and refuses the rest', () => {
  assert.equal(parseUsd('1', 2), 1);
  assert.equal(parseUsd('1.00', 2), 1);
  assert.equal(parseUsd(' 0.25 ', 2), 0.25);
  assert.equal(parseUsd('١٫٥', 2), 1.5);
  assert.equal(parseUsd('۲,۵', 2), 2.5);
  assert.equal(parseUsd('0.000001', 6), 0.000001);
  for (const bad of ['', '-1', '1e3', '1.234', 'abc', '1..2', '.5', 'Infinity']) assert.equal(parseUsd(bad, 2), null, bad);
  assert.equal(parseUsd('0.0000001', 6), null, 'seven decimals');
  assert.equal(parseUsd('50.5', 0), null);
});

test('the owner tab sends each price as the exact decimal typed, never a float', () => {
  assert.equal(normalizeUsd('٣٫٧٥', 6), '3.75');
  assert.equal(normalizeUsd(' 0.000001 ', 6), '0.000001');
  assert.equal(normalizeUsd('15', 6), '15');
  assert.equal(normalizeUsd('1,5', 2), '1.5');
  assert.equal(normalizeUsd('25', 0), '25');
  for (const bad of ['', '1.5', '-2', '2e1']) assert.equal(normalizeUsd(bad, 0), null, bad);
  assert.equal(normalizeUsd('0.0000001', 6), null);
});

test('the owner tab: the GET answer read safely, 0 and 1 as booleans, nothing missing read as on', () => {
  const empty = readOverview(null);
  assert.equal(empty.migrated, true);
  assert.equal(empty.settings.enabled, false);
  assert.equal(empty.settings.guests, false);
  assert.equal(empty.settings.daily_cap_usd, 1, 'the default cap is $1.00');
  assert.equal(empty.settings.guest_share_pct, 25);
  assert.deepEqual(empty.tasks, []);
  assert.equal(readOverview({ migrated: false }).migrated, false);
  const o = readOverview({
    migrated: true,
    settings: { enabled: 1, daily_cap_usd: 2.5, guests: 0, guest_share_pct: 40, understand_ckb: true },
    tasks: [
      { task: 'understand', rank: 0, provider: 'anthropic', model_id: 'm-1', rates: { in: 3, out: 15, cache_write: 0, cache_read: 0 }, effort_low: 1, gone: 0, ready: 1, worst_case_usd: 0.05, worst_case_warn: false },
      { task: 'speech', rank: 1, provider: 'workers_ai', model_id: 'm-2', rates: { per_minute: 0.01 }, gone: 1, ready: 0, worst_case_usd: 0.3, worst_case_warn: true },
      { task: 'translate', rank: 0, model_id: 'x' },
      { task: 'vision', rank: 2, model_id: 'x' },
    ],
    today: { spent: 0.12, reserved: 0.02, guest: 0, cap: 2.5, calls: 9 },
    week: [{ day: '2026-10-21', task: 'understand', calls: 5, ok: 4, cost: 0.01 }, { day: 7 }],
    health: { anthropic_key: true, ai_binding: 0, images_binding: 1, providers: { anthropic: { last_ok_at: '2026-10-22T08:00:00Z', last_fail_code: 'TIMEOUT', open_until: '2026-10-22T08:05:00Z' } } },
    outcomes_24h: { understand: { OK: 4, TIMEOUT: 1, BAD: 0 } },
  });
  assert.deepEqual(o.settings, { enabled: true, daily_cap_usd: 2.5, guests: false, guest_share_pct: 40, understand_ckb: true });
  assert.deepEqual(o.tasks.map((t) => [t.task, t.rank, t.ready, t.gone, t.worstCaseUsd, t.worstCaseWarn]), [['understand', 0, true, false, 0.05, false], ['speech', 1, false, true, 0.3, true]]);
  assert.equal(o.week.length, 1);
  assert.deepEqual(o.health.providers.anthropic.circuit_open_until, '2026-10-22T08:05:00Z');
  assert.equal(o.health.ai_binding, false);
  assert.deepEqual(o.outcomes.understand, { OK: 4, TIMEOUT: 1 });
  // A model id is checked before it is sent (the server checks again).
  assert.ok(MODEL_ID_SHAPE.test('vendor/model-name_1.0:latest@x'));
  for (const bad of ['', 'a b', 'x'.repeat(129), 'a;b', 'a?b']) assert.ok(!MODEL_ID_SHAPE.test(bad), bad);
});

test('the owner tab: lazy, the verified owner only, its own deep link; it names no provider host and no ledger column', () => {
  const admin = read('src/pages/Admin.tsx');
  assert.match(admin, /const AdminAssistAi = React\.lazy\(\(\) => import\('\.\.\/components\/AdminAssistAi'\)\);/);
  assert.match(admin, /const canSeeAssistAi = canSeeSecurity;/);
  assert.match(admin, /\{activeTab === 'assist_ai' && canSeeAssistAi && <AdminAssistAi \/>\}/);
  assert.match(admin, /\.\.\.\(canSeeAssistAi\s*\? \[\{ id: 'assist_ai'/);
  assert.match(admin, /'delivery_pricing', 'assist_ai'\];/);
  assert.doesNotMatch(admin, /^import [^;]*AdminAssistAi/m, 'a static import would put the tab in the admin shell');
  const tab = read('src/components/AdminAssistAi.tsx');
  for (const name of ['api.anthropic.com', 'ANTHROPIC_API_KEY', 'daily_cap_micro_usd', 'speech_micro_per_minute', 'in_micro_per_mtok', 'x-api-key']) {
    assert.ok(!tab.toLowerCase().includes(name.toLowerCase()), `the owner tab names ${name}`);
  }
  // Writes go to the owner routes of the plan, and the provider comes from the task, never from the body.
  assert.match(tab, /api\.put\(`\$\{BASE\}\/settings`/);
  assert.match(tab, /api\.put\(`\$\{BASE\}\/tasks\/\$\{task\}\/\$\{rank\}`, body\)/);
  assert.match(tab, /api\.delete\(`\$\{BASE\}\/tasks\/\$\{task\}\/\$\{rank\}`\)/);
  assert.match(tab, /api\.post<unknown>\(`\$\{BASE\}\/test\/\$\{task\}`/);
  // The Test fields the server reads: image + code (vision), audio (+ model_id and per_minute for a typed id), rank.
  const testPanel = tab.slice(tab.indexOf('function TestPanel'), tab.indexOf('// ------------------------------------------------------------- 3. health'));
  assert.match(testPanel, /form\.append\('image', jpeg, 'test\.jpg'\);\s*form\.append\('code', code\);\s*form\.append\('rank', String\(rank\)\);/);
  assert.match(testPanel, /form\.append\('audio', file, file\.name\);/);
  assert.match(testPanel, /form\.append\('model_id', m\.modelId\);\s*form\.append\('per_minute', normalizeUsd\(m\.perMinute, 6\) \?\? ''\);/);
  assert.match(testPanel, /post\(\{ rank \}\)/);
  // The worst case shown is the server figure, on the row (plan §10).
  assert.match(tab, /\{row && row\.worstCaseWarn && \(/);
  assert.match(tab, /`\$\{BASE\}\/models\?task=\$\{task\}`/);
  const body = tab.slice(tab.indexOf('const body = {'), tab.indexOf('};', tab.indexOf('const body = {')));
  assert.doesNotMatch(body, /provider/);
});

// ----------------------------------------------------------------- the desk

test('the desk names the facts a reading supplied, known names only, each once', () => {
  assert.deepEqual(readByAiFields(['part', 'code', 'code', 'printer', 'other', 7]), ['code', 'printer', 'part']);
  assert.deepEqual(readByAiFields(undefined), []);
  assert.deepEqual(readByAiFields('code'), []);
  assert.deepEqual(readByAiFields(['symptom']), ['symptom']);
  const desk = read('src/components/adminSupport/TicketsDesk.tsx');
  assert.match(desk, /const readFields = readByAiFields\(handoff\?\.read_by_ai\);/);
  assert.match(desk, /\{readFields\.length > 0 && \(/);
  assert.match(desk, /cs\.readByAi\.replace\('\{fields\}'/);
});
