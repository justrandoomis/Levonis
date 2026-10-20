/**
 * THE ASSISTANT'S TOOLS AND ITS CARRIED CONTEXT GRANT NOTHING
 * (worker/lib/assist/registry.ts, ./context.ts).
 *
 * The registry is the contract the next push's model router must keep: it may
 * only propose `{ tool, args }`, which come back through the same parser and
 * the same audience check. So the refusals are pinned here, and so is the
 * absence of any network call or generated text in `worker/lib/assist/**`.
 *
 * Run: node --import tsx --test tests/assistTools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asD1, freshDb } from './fixtures/app';
import { callTool, TOOLS } from '../worker/lib/assist/registry';
import { readContext, CONTEXT_MAX_BYTES } from '../worker/lib/assist/context';
import { viewerFor } from '../worker/lib/assist/viewer';
import { BASIC_ROUTER } from '../worker/lib/assist/ai/adapter';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('unknown tools and bad arguments are refused, never guessed at', async () => {
  const db = asD1(freshDb());
  const anon = viewerFor(db, null, 'ar');
  assert.deepEqual(await callTool('orders.cancel', db, anon, {}), { ok: false, code: 'UNKNOWN_TOOL' });
  assert.deepEqual(await callTool('__proto__', db, anon, {}), { ok: false, code: 'UNKNOWN_TOOL' });
  for (const args of [
    null,
    'nozzle',
    { text: 'x'.repeat(101) },
    { text: 'nozzle', fits: ['A1 Combo'] },
    { text: 'nozzle', fits: Array.from({ length: 9 }, (_, i) => `p${i}`) },
    { text: 'nozzle', category: 'cat_admin' },
    { text: 'nozzle', limit: 99 },
    { text: '   ' },
  ]) {
    assert.deepEqual(await callTool('catalog.search', db, anon, args), { ok: false, code: 'BAD_ARGS' }, JSON.stringify(args));
  }
  assert.deepEqual(await callTool('cases.draft', db, anon, { model: 'Z9', symptom: 'clog' }), { ok: false, code: 'BAD_ARGS' });
  assert.deepEqual(await callTool('cases.draft', db, anon, { model: 'A1', symptom: 'clog', code: 'DROP TABLE' }), { ok: false, code: 'BAD_ARGS' });
});

test('a session tool needs a session, and reads only the session’s own devices', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  assert.deepEqual(await callTool('devices.mine', db, viewerFor(db, null, 'ar'), {}), { ok: false, code: 'NEEDS_SESSION' });
  // An admin asking the support assistant is a customer here: no bypass, no one else's units.
  const admin = await callTool('devices.mine', db, viewerFor(db, 'u_admin', 'en'), {});
  assert.deepEqual(admin, { ok: true, data: [] });
  for (const tool of Object.values(TOOLS)) assert.equal(tool.effect, 'read', `${tool.name} must be read-only`);
});

test('the carried context keeps closed-set values and id shapes only', () => {
  assert.deepEqual(readContext(null), { v: 1 });
  assert.deepEqual(readContext('A1'), { v: 1 });
  assert.deepEqual(readContext([1, 2]), { v: 1 });
  assert.deepEqual(readContext({ v: 2, printer: { model: 'A1' } }), { v: 1 }, 'an unknown version is ignored whole');
  assert.deepEqual(readContext({ v: 1, printer: { model: 'Z9' } }), { v: 1 });
  assert.deepEqual(readContext({ v: 1, printer: { model: 'A1', unit_id: "x' OR 1=1" } }), { v: 1, printer: { model: 'A1' } });
  assert.deepEqual(readContext({ v: 1, printer: { model: 'other' }, part: 'laser' }), { v: 1, printer: { model: 'other' } });
  assert.deepEqual(
    readContext({ v: 1, triage: { stage: 'steps', symptom: 'clog', code: '0300-0100-0001-0003', extra: 1 } }),
    { v: 1, triage: { stage: 'steps', symptom: 'clog', code: '0300-0100-0001-0003' } }
  );
  assert.deepEqual(readContext({ v: 1, triage: { stage: 'steps', code: 'rm -rf' } }), { v: 1, triage: { stage: 'steps' } });
  assert.equal(readContext({ v: 1, shown: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '<x>'] }).shown?.length, 6);
  assert.deepEqual(readContext({ v: 1, printer: { model: 'A1' }, pad: 'x'.repeat(CONTEXT_MAX_BYTES) }), { v: 1 }, 'oversize is ignored whole');
  const loop: Record<string, unknown> = { v: 1 };
  loop.self = loop;
  assert.deepEqual(readContext(loop), { v: 1 });
});

test('basic mode: the model seam is empty', async () => {
  assert.equal(BASIC_ROUTER.ready(), false);
  assert.equal(await BASIC_ROUTER.route('نوزل'), null);
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('nothing in worker/lib/assist calls out of the process or reaches for a model', () => {
  const files = filesUnder(join(ROOT, 'worker/lib/assist'));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'env.AI', 'openai', 'gemini', 'anthropic', 'http://']) {
      assert.ok(!code.toLowerCase().includes(forbidden.toLowerCase()), `${file} reaches for ${forbidden}`);
    }
    // The only addresses are the reviewed official guide pages.
    for (const m of code.matchAll(/https:\/\/[^\s'"`]+/g)) assert.ok(m[0].startsWith('https://wiki.bambulab.com/'), `${file}: ${m[0]}`);
  }
});

test('support.ts reaches the card builders through the seam, and the reply text comes from the dictionaries', () => {
  const route = readFileSync(join(ROOT, 'worker/routes/support.ts'), 'utf8');
  assert.ok(!route.includes("from './products'"));
  assert.ok(route.includes("from '../lib/catalog/cardsRead'"));
  // Every reply the orchestrator builds says a dictionary sentence (./strings.ts) or a curated step.
  const orchestrator = readFileSync(join(ROOT, 'worker/lib/assist/orchestrator.ts'), 'utf8');
  // `text: words` is the catalogue query and `text: string` a parameter type; neither is said to anyone.
  const texts = [...orchestrator.matchAll(/\btext: ([^,\n}]+)/g)].map((m) => m[1].trim()).filter((e) => e !== 'words' && e !== 'string');
  assert.ok(texts.length >= 5);
  for (const expr of texts) {
    assert.ok(/^(tr\(loc|`\$\{tr\(loc|s\.text\[loc\]|sentences\.join\()/.test(expr), `a reply text that is not a dictionary lookup: ${expr}`);
  }
  for (const m of orchestrator.matchAll(/sentences\.push\(([^;]+)\);/g)) assert.match(m[1], /^((fault|model) \? )?tr\(loc/, m[1]);
});
