/**
 * THE TEXT AND VISION PROVIDER'S REQUEST IS PINNED (push B plan §16 #3, §7).
 *
 * Through an injected transport only — no network: the fixed host, the
 * refused redirect, the key in `x-api-key` and nowhere else, the exact body
 * keys, `effort` only for a model listed with low effort, every status, error
 * type and stop reason mapped to a code, the 64 KB body cap, and the live
 * model list paged and filtered on its capability flags. An env without the
 * key is unavailable and calls nothing, and no file of the layer reads
 * `process.env`.
 *
 * Run: node --import tsx --test tests/aiAnthropicRequest.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { KEY, TEXT_MODEL, answer, errorResponse, jsonResponse, recordingTransport, tinyJpeg } from './fixtures/aiLayer';
import {
  anthropicAvailable,
  anthropicListModels,
  anthropicStructured,
  codeOfStatus,
  readAnswer,
} from '../worker/lib/ai/providers/anthropic';
import { allowedProviderUrl, providerRequest, RESPONSE_CAP_BYTES } from '../worker/lib/ai/transport';
import type { StructuredRequest } from '../worker/lib/ai/types';
import type { Env } from '../worker/lib/types';

const env = { ANTHROPIC_API_KEY: KEY } as unknown as Env;
const req = (over: Partial<StructuredRequest> = {}): StructuredRequest => ({
  system: 'SYSTEM PROMPT',
  userText: '<customer_message>"x"</customer_message>',
  schema: { type: 'object' },
  maxTokens: 1536,
  effortLow: false,
  signal: new AbortController().signal,
  ...over,
});

test('the request goes to the fixed host, POST, with redirects refused at the transport', async () => {
  const t = recordingTransport(() => answer({ ok: 1 }));
  const r = await anthropicStructured(env, TEXT_MODEL, req(), t);
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(t.calls[0]!.method, 'POST');
  assert.equal(t.calls[0]!.redirect, 'manual');
});

test('any 3xx is REDIRECT_REFUSED and is never followed', async () => {
  for (const status of [301, 302, 307, 308]) {
    const t = recordingTransport(() => new Response(null, { status, headers: { location: 'https://elsewhere.example/v1/messages' } }));
    const r = await anthropicStructured(env, TEXT_MODEL, req(), t);
    assert.deepEqual(r, { ok: false, code: 'REDIRECT_REFUSED' });
    assert.equal(t.calls.length, 1, 'one request, the redirect is not followed');
  }
});

test('only the allowlisted https host is ever called', async () => {
  assert.equal(allowedProviderUrl('https://api.anthropic.com/v1/messages'), true);
  for (const bad of [
    'http://api.anthropic.com/v1/messages',
    'https://api.anthropic.com.evil.example/v1/messages',
    'https://evil.example/v1/messages',
    'https://user:pw@api.anthropic.com/v1/messages',
    'https://api.anthropic.com:8443/v1/messages',
    'not a url',
  ]) {
    assert.equal(allowedProviderUrl(bad), false, bad);
    const t = recordingTransport(() => answer({}));
    const r = await providerRequest(bad, { method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal }, t);
    assert.deepEqual(r, { ok: false, code: 'NETWORK' });
    assert.equal(t.calls.length, 0, `${bad} reached the transport`);
  }
});

test('the key travels in x-api-key only: not in the URL, the body or any other header', async () => {
  const t = recordingTransport(() => answer({ ok: 1 }));
  await anthropicStructured(env, TEXT_MODEL, req(), t);
  const call = t.calls[0]!;
  assert.equal(call.headers['x-api-key'], KEY);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(call.headers).sort(), ['anthropic-version', 'content-type', 'x-api-key']);
  assert.ok(!call.url.includes(KEY));
  assert.ok(!call.body.includes(KEY));
});

test('the body has exactly model, max_tokens, system, messages and output_config; effort only for a low-effort model', async () => {
  const t = recordingTransport(() => answer({ ok: 1 }));
  await anthropicStructured(env, TEXT_MODEL, req(), t);
  const body = JSON.parse(t.calls[0]!.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(body.model, TEXT_MODEL);
  assert.equal(body.max_tokens, 1536);
  assert.equal(body.system, 'SYSTEM PROMPT');
  assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: { type: 'object' } } });
  const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, 'user');
  assert.deepEqual(messages[0]!.content, [{ type: 'text', text: '<customer_message>"x"</customer_message>' }]);
  for (const never of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools', 'metadata', 'cache_control', 'stream']) {
    assert.ok(!t.calls[0]!.body.includes(`"${never}"`), `${never} was sent`);
  }

  const low = recordingTransport(() => answer({ ok: 1 }));
  await anthropicStructured(env, TEXT_MODEL, req({ effortLow: true }), low);
  assert.deepEqual((JSON.parse(low.calls[0]!.body) as { output_config: unknown }).output_config, {
    format: { type: 'json_schema', schema: { type: 'object' } },
    effort: 'low',
  });
});

test('pictures go first, as base64 JPEG blocks, then the one text block', async () => {
  const t = recordingTransport(() => answer({ ok: 1 }));
  const jpeg = tinyJpeg();
  await anthropicStructured(env, TEXT_MODEL, req({ jpegs: [jpeg, jpeg] }), t);
  const content = (JSON.parse(t.calls[0]!.body) as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[0]!.content;
  assert.equal(content.length, 3);
  for (const block of content.slice(0, 2)) {
    assert.equal(block.type, 'image');
    const src = block.source as Record<string, unknown>;
    assert.equal(src.type, 'base64');
    assert.equal(src.media_type, 'image/jpeg');
    assert.deepEqual(new Uint8Array(Buffer.from(String(src.data), 'base64')), jpeg);
  }
  assert.equal(content[2]!.type, 'text');
});

test('statuses and error types map to codes (§7 table); the error text is never read', async () => {
  const cases: Array<[number, string, string]> = [
    [401, 'authentication_error', 'KEY_REJECTED'],
    [403, 'permission_error', 'KEY_REJECTED'],
    [402, 'billing_error', 'QUOTA'],
    [400, 'billing_error', 'QUOTA'],
    [404, 'not_found_error', 'MODEL_GONE'],
    [413, 'request_too_large', 'TOO_LARGE'],
    [429, 'rate_limit_error', 'RATE_LIMITED'],
    [529, 'overloaded_error', 'OVERLOADED'],
    [503, 'overloaded_error', 'OVERLOADED'],
    [400, 'invalid_request_error', 'HTTP_4XX'],
    [422, '', 'HTTP_4XX'],
    [500, 'api_error', 'HTTP_5XX'],
    [502, '', 'HTTP_5XX'],
  ];
  for (const [status, type, code] of cases) {
    const t = recordingTransport(() => errorResponse(status, type));
    assert.deepEqual(await anthropicStructured(env, TEXT_MODEL, req(), t), { ok: false, code }, `${status} ${type}`);
    assert.equal(codeOfStatus(status, type), code);
  }
});

test('stop reasons and content blocks: only end_turn with exactly one small JSON text block is an answer', () => {
  const ok = readAnswer(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 9, output_tokens: 3 } }));
  assert.deepEqual(ok, { ok: true, value: { a: 1 }, usage: { inputTokens: 9, outputTokens: 3, cacheWriteTokens: 0, cacheReadTokens: 0, speechMs: 0 } });
  const usage = { input_tokens: 9, output_tokens: 3 };
  const code = (msg: unknown) => {
    const r = readAnswer(JSON.stringify(msg));
    return r.ok ? 'OK' : r.code;
  };
  assert.equal(code({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }], usage }), 'TRUNCATED');
  assert.equal(code({ stop_reason: 'refusal', content: [], usage }), 'REFUSAL');
  assert.equal(code({ stop_reason: 'tool_use', content: [], usage }), 'REFUSAL');
  assert.equal(code({ stop_reason: 'pause_turn', content: [], usage }), 'REFUSAL');
  assert.equal(code({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }, { type: 'text', text: '{}' }], usage }), 'BAD_OUTPUT');
  assert.equal(code({ stop_reason: 'end_turn', content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }], usage }), 'BAD_OUTPUT');
  assert.equal(code({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage }), 'BAD_OUTPUT');
  assert.equal(code({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ x: 'y'.repeat(3000) }) }], usage }), 'BAD_OUTPUT');
  assert.equal(code({ stop_reason: 'end_turn', content: [], usage }), 'BAD_OUTPUT');
  assert.equal(code({ stop_reason: 'end_turn', content: 'text', usage }), 'BAD_OUTPUT');
  // A reasoning block before the answer is skipped, never read.
  assert.equal(
    code({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '{"a":1}' }], usage }),
    'OK'
  );
  assert.equal(readAnswer('{').ok, false);
  // A failed answer still reports its usage, so the ledger charges what was billed.
  const truncated = readAnswer(JSON.stringify({ stop_reason: 'max_tokens', content: [], usage }));
  assert.equal(truncated.ok, false);
  assert.equal(!truncated.ok && truncated.usage?.inputTokens, 9);
});

test('a body over 64 KB is TOO_LARGE, declared or streamed; a dead network is NETWORK; the deadline is TIMEOUT', async () => {
  const big = 'x'.repeat(RESPONSE_CAP_BYTES + 10);
  assert.deepEqual(await anthropicStructured(env, TEXT_MODEL, req(), recordingTransport(() => new Response(big, { status: 200 }))), {
    ok: false,
    code: 'TOO_LARGE',
  });
  assert.deepEqual(
    await anthropicStructured(
      env,
      TEXT_MODEL,
      req(),
      recordingTransport(() => new Response('{}', { status: 200, headers: { 'content-length': String(RESPONSE_CAP_BYTES + 1) } }))
    ),
    { ok: false, code: 'TOO_LARGE' }
  );
  const dead = recordingTransport(() => {
    throw new TypeError('fetch failed: secret detail');
  });
  assert.deepEqual(await anthropicStructured(env, TEXT_MODEL, req(), dead), { ok: false, code: 'NETWORK' });
  const slow = recordingTransport(() => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  assert.deepEqual(await anthropicStructured(env, TEXT_MODEL, req(), slow), { ok: false, code: 'TIMEOUT' });
  const gone = new AbortController();
  gone.abort();
  const never = recordingTransport(() => answer({}));
  assert.deepEqual(await anthropicStructured(env, TEXT_MODEL, req({ signal: gone.signal }), never), { ok: false, code: 'TIMEOUT' });
  assert.equal(never.calls.length, 0);
});

test('without the key: unavailable, and nothing is called', async () => {
  for (const e of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
    const ee = e as unknown as Env;
    assert.equal(anthropicAvailable(ee), false);
    const t = recordingTransport(() => answer({}));
    assert.deepEqual(await anthropicStructured(ee, TEXT_MODEL, req(), t), { ok: false, code: 'NOT_CONFIGURED' });
    assert.equal(await anthropicListModels(ee, 'understand', new AbortController().signal, t), null);
    assert.equal(t.calls.length, 0);
  }
  assert.equal(anthropicAvailable(env), true);
});

test('a malformed stored model id is never sent', async () => {
  const t = recordingTransport(() => answer({}));
  for (const id of ['', 'has space', 'x'.repeat(129), 'a"b', 'a\nb']) {
    assert.deepEqual(await anthropicStructured(env, id, req(), t), { ok: false, code: 'NOT_CONFIGURED' });
  }
  assert.equal(t.calls.length, 0);
});

const caps = (o: { structured?: boolean; image?: boolean; effortLow?: boolean } = {}) => ({
  structured_outputs: { supported: o.structured ?? true },
  image_input: { supported: o.image ?? true },
  effort: { supported: o.effortLow !== undefined, low: { supported: !!o.effortLow } },
});

test('the live list pages with after_id while has_more, at most five pages, and keeps only usable models', async () => {
  const pages = [
    {
      data: [
        { id: 'list-model-1', display_name: 'List Model One', capabilities: caps({ effortLow: true }) },
        { id: 'list-model-2', display_name: 'List Model Two', capabilities: caps({ image: false }) },
        { id: 'list-model-3', display_name: 'Old', lifecycle: 'deprecated', capabilities: caps() },
      ],
      has_more: true,
      last_id: 'list-model-3',
    },
    {
      data: [
        { id: 'list-model-4', display_name: 'No caps', capabilities: null },
        { id: 'list-model-5', display_name: 'No structured', capabilities: caps({ structured: false }) },
        { id: 'list-model-6', capabilities: caps(), lifecycle: 'active' },
        { id: 'bad id with spaces', capabilities: caps() },
      ],
      has_more: false,
      last_id: 'list-model-6',
    },
  ];
  const t = recordingTransport((n) => jsonResponse(200, pages[n - 1]));
  const understand = await anthropicListModels(env, 'understand', new AbortController().signal, t);
  assert.deepEqual(understand, [
    { id: 'list-model-1', label: 'List Model One', effortLow: true },
    { id: 'list-model-2', label: 'List Model Two', effortLow: false },
    { id: 'list-model-6', label: 'list-model-6', effortLow: false },
  ]);
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[0]!.url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(t.calls[1]!.url, 'https://api.anthropic.com/v1/models?limit=100&after_id=list-model-3');
  assert.equal(t.calls[0]!.method, 'GET');
  assert.equal(t.calls[0]!.headers['x-api-key'], KEY);

  const v = recordingTransport((n) => jsonResponse(200, pages[n - 1]));
  const vision = await anthropicListModels(env, 'vision', new AbortController().signal, v);
  assert.deepEqual(vision?.map((m) => m.id), ['list-model-1', 'list-model-6'], 'vision needs image input');

  const endless = recordingTransport((n) => jsonResponse(200, { data: [], has_more: true, last_id: `p${n}` }));
  assert.deepEqual(await anthropicListModels(env, 'understand', new AbortController().signal, endless), []);
  assert.equal(endless.calls.length, 5, 'at most five pages');

  for (const broken of [() => errorResponse(500, 'api_error'), () => new Response('nope', { status: 200 }), () => jsonResponse(200, { data: 'x' })]) {
    assert.equal(await anthropicListModels(env, 'understand', new AbortController().signal, recordingTransport(broken)), null);
  }
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('no file of the layer reads process.env (no SDK, no ambient configuration)', () => {
  for (const f of filesUnder(join(ROOT, 'worker/lib/ai'))) {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\bprocess\s*\./.test(code), `${f} reads process`);
    assert.doesNotMatch(code, /from ['"]@anthropic-ai\//, f);
  }
  const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
  assert.doesNotMatch(pkg, /"@anthropic-ai\/sdk"/, 'no provider SDK dependency');
});
