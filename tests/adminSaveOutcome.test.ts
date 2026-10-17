/**
 * NO FALSE «NETWORK ERROR» FOR A SLOW WRITE (the owner's report of 2026-10-17;
 * src/components/adminProducts/saveOutcome.ts, src/lib/requestErrorText.ts).
 *
 *   - the client's deadline is not the network: it travels as `TIMEOUT` with
 *     its own sentence, a dead connection as `NETWORK`, both in the reader's
 *     language (Arabic, English, real Sorani — never the Arabic pasted across);
 *     the server's other unworded failures (not JSON, a bare status) too;
 *   - the product write has its own deadline, says «still saving» while it
 *     waits, and when the deadline fires — or the answer is lost — it reads the
 *     product again and says what is true: saved, not saved (read twice), or
 *     that it could not tell; never a blind «try again»;
 *   - the retry it then invites is safe: a second save of the same edit is
 *     refused as stale (409 STALE_EDIT) and writes nothing.
 *
 * Run: node --import tsx --test tests/adminSaveOutcome.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { api, ApiError } from '../src/lib/api';
import { REQUEST_ERROR_TEXT, requestErrorText } from '../src/lib/requestErrorText';
import {
  PRODUCT_WRITE_TIMEOUT_MS,
  SAVE_OUTCOME_TEXT,
  STILL_SAVING_AFTER_MS,
  confirmSaveOutcome,
  writeOutcomeUnknown,
} from '../src/components/adminProducts/saveOutcome';
import { DEFAULT_TIMEOUT_MS } from '../src/lib/api';

const realFetch = globalThis.fetch;
const g = globalThis as unknown as { document?: unknown };
const realDocument = g.document;
afterEach(() => {
  globalThis.fetch = realFetch;
  g.document = realDocument;
});
const readingIn = (lang: string) => {
  g.document = { documentElement: { lang } };
};

/** A server that never answers (the request ends only on its signal). */
function silentServer() {
  globalThis.fetch = ((_input: unknown, init: RequestInit = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })) as typeof fetch;
}

const SORANI_ONLY = /[ڕڵێۆەڤگچژپ]/;

test('every sentence of the client, in three languages: Sorani of its own, never the Arabic', () => {
  for (const table of [REQUEST_ERROR_TEXT, SAVE_OUTCOME_TEXT] as Array<Record<string, Record<'ar' | 'en' | 'ckb', string>>>) {
    for (const [key, t] of Object.entries(table)) {
      for (const l of ['ar', 'en', 'ckb'] as const) assert.ok(t[l] && t[l].trim(), `${key}.${l} is written`);
      assert.notEqual(t.ckb, t.ar, `${key}: the Sorani is not the Arabic`);
      assert.match(t.ckb, SORANI_ONLY, `${key}: the Sorani carries a Sorani letter`);
      assert.doesNotMatch(t.ar.replace('{status}', ''), /[a-z]{3}/i, `${key}: no English inside the Arabic`);
    }
  }
});

test('the deadline is TIMEOUT, a dead connection NETWORK — each said in the reader’s language', async () => {
  silentServer();
  readingIn('ar');
  await assert.rejects(api.post('/api/fixture/slow', {}, { timeoutMs: 60 }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 0);
    assert.equal(e.code, 'TIMEOUT');
    assert.equal(e.message, REQUEST_ERROR_TEXT.timeout.ar);
    assert.doesNotMatch(e.message, /Network error/);
    return true;
  });
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  readingIn('ckb');
  await assert.rejects(api.post('/api/fixture/down', {}), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'NETWORK');
    assert.equal(e.message, REQUEST_ERROR_TEXT.network.ckb);
    return true;
  });
  // A bare status the server did not word, in Arabic, with its number.
  globalThis.fetch = (() => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('<html>')) } as unknown as Response)) as typeof fetch;
  readingIn('ar');
  await assert.rejects(api.get('/api/fixture/gateway'), (e: unknown) => e instanceof ApiError && e.message === requestErrorText('server', 502, 'ar') && /502/.test(e.message));
  // The Worker's code-less 500 («Something went wrong», English only) reads in the reader's language.
  globalThis.fetch = (() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'Something went wrong. Please try again.' }) } as unknown as Response)) as typeof fetch;
  readingIn('ckb');
  await assert.rejects(api.post('/api/fixture/boom', {}), (e: unknown) => e instanceof ApiError && e.message === requestErrorText('server', 500, 'ckb') && !e.code);
  // A coded refusal keeps the server's words.
  globalThis.fetch = (() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ success: false, error: 'not installed', code: 'PRICING_NOT_INSTALLED' }) } as unknown as Response)) as typeof fetch;
  await assert.rejects(api.post('/api/fixture/coded', {}), (e: unknown) => e instanceof ApiError && e.message === 'not installed');
  // No document (a unit test, a server render): English, as it always was.
  g.document = undefined;
  assert.equal(requestErrorText('network'), 'Network error — check your connection and try again');
});

test('the boot reads and the upload sessions use the same sentences (no English literal left)', () => {
  for (const file of ['src/lib/api.ts', 'src/lib/bootFetch.ts', 'src/lib/uploadSession.ts']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /new ApiError\([^)]*'(Network error|Invalid server response|Request cancelled)/, `${file}: a sentence built in place`);
    assert.doesNotMatch(text, /`Server error \(\$\{/, `${file}: a status sentence built in place`);
    assert.match(text, /requestErrorText\(/, `${file} words its failures through requestErrorText`);
  }
});

test('the save’s outcome is read, not guessed: saved, not saved (read twice), or could not tell', async () => {
  const at = (updated_at: string) => async () => ({ product: { updated_at } });
  assert.deepEqual(await confirmSaveOutcome('p1', '2026-10-17T10:00:00.000Z', { read: at('2026-10-17T10:00:05.000Z'), recheckMs: 0 }), {
    outcome: 'saved',
    updatedAt: '2026-10-17T10:00:05.000Z',
  });
  // Unchanged now, written a moment later (the server was still finishing): saved.
  let calls = 0;
  const late = async () => ({ product: { updated_at: ++calls === 1 ? 'v1' : 'v2' } });
  assert.equal((await confirmSaveOutcome('p1', 'v1', { read: late, recheckMs: 0 })).outcome, 'saved');
  assert.equal(calls, 2, 'read again before saying «not saved»');
  assert.equal((await confirmSaveOutcome('p1', 'v1', { read: at('v1'), recheckMs: 0 })).outcome, 'not_saved');
  // A product the save would have created: absent is not saved, present is saved.
  const missing = async () => {
    throw new ApiError(404, 'Product not found');
  };
  assert.equal((await confirmSaveOutcome('prd_new', '', { read: missing, recheckMs: 0 })).outcome, 'not_saved');
  assert.equal((await confirmSaveOutcome('prd_new', '', { read: at('v1'), recheckMs: 0 })).outcome, 'saved');
  // The read fails too: say so — never «not saved», never «try again».
  const down = async () => {
    throw new ApiError(0, 'down', 'NETWORK');
  };
  assert.equal((await confirmSaveOutcome('p1', 'v1', { read: down, recheckMs: 0 })).outcome, 'unknown');
  assert.equal(writeOutcomeUnknown(new ApiError(0, 'x', 'TIMEOUT')), true);
  assert.equal(writeOutcomeUnknown(new ApiError(0, 'x', 'NETWORK')), true);
  assert.equal(writeOutcomeUnknown(new ApiError(0, 'x', 'ABORTED')), false);
  assert.equal(writeOutcomeUnknown(new ApiError(409, 'x', 'STALE_EDIT')), false);
  // A 5xx without a refusal of its own may have failed after the batch: read again. A coded 503 wrote nothing.
  assert.equal(writeOutcomeUnknown(new ApiError(500, 'x')), true);
  assert.equal(writeOutcomeUnknown(new ApiError(503, 'x', 'PRICING_NOT_INSTALLED')), false);
});

test('the product form: its own deadline, «still saving» while it waits, and the read-back before any word', () => {
  assert.ok(PRODUCT_WRITE_TIMEOUT_MS >= 3 * DEFAULT_TIMEOUT_MS, 'the write outlasts a page read by far');
  assert.ok(STILL_SAVING_AFTER_MS < DEFAULT_TIMEOUT_MS, 'the wait is said before the old deadline would have fired');
  const form = readFileSync(join(ROOT, 'src/components/adminProducts/ProductForm.tsx'), 'utf8');
  const save = form.slice(form.indexOf('const save = async ('), form.indexOf('const confirmReview = '));
  assert.match(save, /api\.post<[\s\S]*?'\/api\/admin\/products-v2',\s*body,[\s\S]*?\{ timeoutMs: PRODUCT_WRITE_TIMEOUT_MS \}/, 'the save carries the write deadline');
  assert.match(save, /saveOutcomeText\('stillSaving', lang\)/, '«still saving» is said');
  const unknown = save.indexOf('if (writeOutcomeUnknown(e))');
  assert.ok(unknown > 0, 'a lost answer is recognised');
  assert.ok(unknown < save.indexOf('setSaveErr(lines.length'), '…before the ordinary error is shown');
  const branch = save.slice(unknown, save.indexOf('setSaveErr(lines.length'));
  assert.match(branch, /await confirmSaveOutcome\(/, 'the product is read again first');
  assert.match(branch, /outcome === 'saved'[\s\S]*loadProduct\(savedId\)[\s\S]*saveOutcomeText\('saved', lang\)/, 'saved: the stored product, and «تم الحفظ»');
  assert.match(branch, /saveOutcomeText\(outcome, lang\)/, 'otherwise the outcome’s own sentence');
  // The review sheet shows the progress too (the owner was in it when the deadline fired).
  assert.match(form, /progress=\{saveProgress\}/);
});
