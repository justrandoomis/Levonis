/**
 * ONE READER EACH, AND NO REPLY TEXT FROM THE PROVIDER LAYER (push B plan
 * §16 #14, §3, invariants I1 and I7).
 *
 *   - `ANTHROPIC_API_KEY` is read in worker/lib/ai/providers/anthropic.ts
 *     only, and the `AI` binding in worker/lib/ai/providers/workersAi.ts only
 *     (worker/lib/types.ts declares both);
 *   - among push B's server files, `fetch(` appears under worker/lib/ai only,
 *     in its one transport;
 *   - worker/lib/ai never imports the assistant's dictionaries or `tr`, and
 *     writes no `text:` field but the three reviewed ones: the readiness flag
 *     (declared and set) and the provider's own request content block;
 *   - push A's pure folder still never reaches out (its own guard in
 *     tests/assistTools.test.ts runs unchanged; this repeats it for the files
 *     push B adds there);
 *   - the page CSP's connect-src names no provider host: providers are called
 *     Worker to provider only.
 *
 * Run: node --import tsx --test tests/aiSingleReaders.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { spaCsp } from '../worker/lib/securityPolicy';

function filesUnder(dir: string, ext = /\.(ts|tsx|mjs|js)$/): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path, ext) : ext.test(name) ? [path] : [];
  });
}
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const SERVER = ['worker', 'services', 'packages'].flatMap((d) => filesUnder(join(ROOT, d)));

test('the provider key is read in one file', () => {
  const readers = SERVER.filter((f) => /\bANTHROPIC_API_KEY\b/.test(code(f))).map(rel).sort();
  assert.deepEqual(readers, ['worker/lib/ai/providers/anthropic.ts', 'worker/lib/types.ts']);
  const types = code(join(ROOT, 'worker/lib/types.ts'));
  assert.equal((types.match(/\bANTHROPIC_API_KEY\b/g) ?? []).length, 1, 'types.ts only declares it');
  assert.match(code(join(ROOT, 'worker/lib/ai/providers/anthropic.ts')), /env\.ANTHROPIC_API_KEY/);
});

test('the speech binding is read in one file', () => {
  const readers = SERVER.filter((f) => /(?:\benv|\bc\.env|\bthis\.env)\s*(?:\.|\?\.)\s*AI\b|\benv\[\s*['"]AI['"]\s*\]/.test(code(f))).map(rel).sort();
  assert.deepEqual(readers, ['worker/lib/ai/providers/workersAi.ts']);
});

/** The server files push B adds (worker/lib/assist/ai holds push A's adapter too, rewritten here). */
const PUSH_B_SERVER = [
  ...filesUnder(join(ROOT, 'worker/lib/ai')),
  ...filesUnder(join(ROOT, 'worker/lib/assist/ai')),
  join(ROOT, 'worker/routes/adminAssistAi.ts'),
  join(ROOT, 'worker/routes/assistAi.ts'),
  join(ROOT, 'packages/contracts/src/assistAiRefusals.ts'),
].filter((f) => existsSync(f));

test('among push B server files, fetch( appears only in the one transport', () => {
  const callers = PUSH_B_SERVER.filter((f) => /\bfetch\s*\(/.test(code(f))).map(rel);
  assert.deepEqual(callers, ['worker/lib/ai/transport.ts']);
  // …and the provider is never reached around the transport.
  for (const f of PUSH_B_SERVER) {
    if (rel(f) === 'worker/lib/ai/transport.ts') continue;
    assert.doesNotMatch(code(f), /https:\/\/api\.anthropic\.com\/v1\/(?!messages|models)/, rel(f));
  }
});

test('worker/lib/ai never imports the dictionaries or tr, and writes no reply text', () => {
  const ALLOWED_TEXT: Record<string, string[]> = {
    // The readiness flag: "may the customer type to the AI layer", a boolean (plan §5.5).
    'worker/lib/ai/readiness.ts': ['text: false,', 'const flags = { text: understand, photo, clip: vision, voice: speech };'],
    // The provider's request content block: the customer's redacted message going OUT, never a reply.
    'worker/lib/ai/providers/anthropic.ts': ["content.push({ type: 'text', text: req.userText });"],
  };
  const files = filesUnder(join(ROOT, 'worker/lib/ai'));
  assert.ok(files.length >= 14, `only ${files.length} files under worker/lib/ai`);
  for (const f of files) {
    const src = code(f);
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(m[1]!, /(^|\/)strings$|assist\/strings|\/i18n|\/tr$/, `${rel(f)} imports ${m[1]}`);
    }
    assert.doesNotMatch(src, /\btr\s*\(/, `${rel(f)} calls tr(`);
    // A type annotation (`text: string`) declares a shape; only a written value counts.
    const lines = src
      .split('\n')
      .filter((l) => /\btext\s*:(?!\s*(string|boolean|unknown)\b)/.test(l))
      .map((l) => l.trim());
    assert.deepEqual(lines, ALLOWED_TEXT[rel(f)] ?? [], `${rel(f)} writes a text: field`);
  }
});

test('push A pure folder still never reaches out, and never names a provider', () => {
  const files = filesUnder(join(ROOT, 'worker/lib/assist'));
  assert.ok(files.some((f) => rel(f) === 'worker/lib/assist/ai/aliases.ts'));
  for (const f of files) {
    const c = code(f).toLowerCase();
    for (const forbidden of ['fetch(', 'xmlhttprequest', 'env.ai', 'anthropic', 'workers_ai', 'http://']) {
      assert.ok(!c.includes(forbidden), `${rel(f)} reaches for ${forbidden}`);
    }
    assert.ok(!/from ['"][^'"]*\/lib\/ai\//.test(c) && !/from ['"]\.\.\/\.\.\/ai\//.test(c), `${rel(f)} imports the provider layer`);
  }
});

test('the page CSP connect-src names no provider host', () => {
  const csp = spaCsp();
  const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) ?? '';
  assert.ok(connect.length > 0);
  assert.doesNotMatch(connect, /anthropic|workers\.dev\/ai|api\.cloudflare\.com/i);
  for (const f of ['worker/lib/securityPolicy.ts', 'packages/platform-kit/src/edge/securityPolicy.ts']) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /anthropic\.com/i, f);
  }
});
