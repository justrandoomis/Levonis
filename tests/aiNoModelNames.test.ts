/**
 * NO MODEL IS NAMED IN THIS PUBLIC REPOSITORY (push B plan §16 #13; repo
 * rule in the plan header; invariant I8).
 *
 *   (a) FAMILY WORDS, by digest. Every lowercased `[a-z0-9]+` token of every
 *       file push B adds or edits is hashed (SHA-256) and must not be in the
 *       list below: the provider model-line words, the speech-model family
 *       word and other vendors' family words. The list holds DIGESTS ONLY,
 *       computed outside the repository, so this file names nothing either.
 *   (b) ID SHAPES, repository-wide over `git ls-files`: a Workers AI model
 *       path (`@cf/…/…`, `@hf/…/…`), or a token whose first `-`-segment is a
 *       vendor prefix (by digest) and which holds a digit — but not a path
 *       segment (a token directly followed by `/`, such as a temp directory).
 *       A frozen, EXACT-count ratchet allows only the two matches that
 *       predate push B (the CI agent's own workflow, and the admin translate
 *       route push B leaves alone); it may only shrink.
 *   (c) Migration 0210 seeds no model row.
 *
 * Model ids live only in D1 rows the owner picks in admin from the
 * provider's live list.
 *
 * Run: node --import tsx --test tests/aiNoModelNames.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Model-line, speech-family and other vendors' family words, as SHA-256 of the lowercase word. */
const FAMILY_DIGESTS = new Set([
  'c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d',
  '09cf980b5ff304ac11b7f6d2c5c263da2a867425798ef5cc5d2ebcf55c4fcd23',
  '553133ea03bb73bd9d747281fdfc7d1164d8cb59f4d638d198c7443c681c6848',
  'e12ce8285efc67c6d93d3a122e2589ed95089bcbb775ba5634d94e2b8385db07',
  'c9ad8f2cc1294afa0ef22fc2c019ff7243cdd272b2147ddca3f34c5036b05768',
  '5a5110ebe1544b31e6d4207a419bc1deb148735f89ae984ff0a2ab809b51f1df',
  'ba7955598f2007bc8cee7329ece0f63ee59f2dbb40d59ad17aadfee76b1092ae',
  '053ea4804ef1bb33d4a3d6fb024a614b6d257cebc2bc7cd915da9c9522f37ffc',
  '5d72436256ada53828b51895a94bb8489e9f1ac4fe937a8024ef1594e7045ff6',
  '3fb22a5597fb91ee4f9abbf30ea69d318be150e0fcf3ca1db8ca334b520d2894',
  'fc5a1047f5919892fcdf8aa79ea5d6bb6531b5c176939ef0110906cb225941c1',
  '920510199770f4d65cb8aaa2cd12bdb2b8c37f5b3907c50a734a0e3409da2823',
  'c97504235ab15009f6c5f11ba890007a5f3fdd20c9e57b53ea74855033572ddf',
  '67f2d22514622d1be30c14ee9f3cb104503a159a33a656ca91a1953aa9616429',
  '6f7ac1823da81d2e52d1a1549ee69c85bbf8bb56d06682849e7c09da2785ce3b',
  'add92b9cde2bdbf3daaf65a0db79e9b1a7fa428b71b4d6ce38c742eb6dca0c1c',
]);

/** Vendor id prefixes (the first `-` segment of a model id), as SHA-256 of the lowercase word. */
const VENDOR_PREFIX_DIGESTS = new Set([
  'c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d',
  '053ea4804ef1bb33d4a3d6fb024a614b6d257cebc2bc7cd915da9c9522f37ffc',
  '5d72436256ada53828b51895a94bb8489e9f1ac4fe937a8024ef1594e7045ff6',
  '3fb22a5597fb91ee4f9abbf30ea69d318be150e0fcf3ca1db8ca334b520d2894',
  'fc5a1047f5919892fcdf8aa79ea5d6bb6531b5c176939ef0110906cb225941c1',
  '920510199770f4d65cb8aaa2cd12bdb2b8c37f5b3907c50a734a0e3409da2823',
  'c97504235ab15009f6c5f11ba890007a5f3fdd20c9e57b53ea74855033572ddf',
  '67f2d22514622d1be30c14ee9f3cb104503a159a33a656ca91a1953aa9616429',
  '6f7ac1823da81d2e52d1a1549ee69c85bbf8bb56d06682849e7c09da2785ce3b',
  'ba7955598f2007bc8cee7329ece0f63ee59f2dbb40d59ad17aadfee76b1092ae',
  'add92b9cde2bdbf3daaf65a0db79e9b1a7fa428b71b4d6ce38c742eb6dca0c1c',
]);

/**
 * The only id-shape matches allowed, exactly; each count may only go down.
 * Keyed by the SHA-256 of the file's repository path, because one of the two
 * paths itself spells a family word: the CI agent's workflow (2 matches) and
 * the admin translate route, worker/routes/misc.ts (1 match).
 */
const ID_SHAPE_RATCHET: Readonly<Record<string, number>> = {
  '53fec9c265fdba82268df5cd90315b8da57cce43d8e20efbf5c0bdcd1de1342e': 2,
  '2a6566d87b04d7de8f5825d1dd63aca9c3a3fd065d44702e0dd08ccc7de10829': 1,
};

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');

/** Every file push B adds or edits that the family-word scan covers (plan §16 #13 a). */
function scoped(): string[] {
  const dirs = ['worker/lib/ai', 'worker/lib/assist/ai'].flatMap((d) => filesUnder(join(ROOT, d)));
  const single = [
    'worker/routes/assistAi.ts',
    'worker/routes/adminAssistAi.ts',
    'src/lib/assistAi.ts',
    'src/lib/assistMedia.ts',
    'src/components/AdminAssistAi.tsx',
    'wrangler.jsonc',
    'docs/SUPPORT_ASSISTANT_AI.md',
    'packages/contracts/src/assistAiRefusals.ts',
    'tests/routeClass/adminAssistAi.ts',
    'tests/fixtures/aiLayer.ts',
  ].map((p) => join(ROOT, p));
  const migrations = readdirSync(join(ROOT, 'migrations'))
    .filter((f) => f.startsWith('0210'))
    .map((f) => join(ROOT, 'migrations', f));
  const tests = readdirSync(join(ROOT, 'tests'))
    .filter((f) => /^ai[A-Z].*\.test\.ts$/.test(f))
    .map((f) => join(ROOT, 'tests', f));
  return [...new Set([...dirs, ...single, ...migrations, ...tests])].filter((f) => existsSync(f));
}

export function familyHits(text: string, digests: ReadonlySet<string> = FAMILY_DIGESTS): string[] {
  const hits = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) if (digests.has(sha(m[0]))) hits.add(sha(m[0]).slice(0, 12));
  return [...hits];
}

/** Id-shaped tokens in `text` (rule b). */
export function idShapes(text: string, prefixes: ReadonlySet<string> = VENDOR_PREFIX_DIGESTS): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/@(?:cf|hf)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/g)) out.push(m[0]);
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]*/g)) {
    const t = m[0];
    if (text[m.index! + t.length] === '/') continue; // a path segment, not an id
    if (!t.includes('-') || !/\d/.test(t)) continue;
    if (prefixes.has(sha(t.split('-')[0]!.toLowerCase()))) out.push(t);
  }
  return out;
}

test('the digest lists are digests only, and the scanners do what they say', () => {
  for (const d of [...FAMILY_DIGESTS, ...VENDOR_PREFIX_DIGESTS]) assert.match(d, /^[0-9a-f]{64}$/);
  assert.ok(FAMILY_DIGESTS.size >= 10 && VENDOR_PREFIX_DIGESTS.size >= 8);
  // A made-up vendor word stands in for a real one.
  const fake = new Set([sha('zqvendor')]);
  assert.deepEqual(familyHits('A ZqVendor line, and zqvendors', fake).length, 1);
  // The path is assembled at run time, so this file never holds one itself (it is in the scan too).
  const path = ['@', 'cf/zq/zq-1'].join('');
  assert.deepEqual(idShapes(`zqvendor-7-turbo zqvendor-chat zqvendor-2/tmp ${path} x-zqvendor-3`, fake), [path, 'zqvendor-7-turbo']);
  assert.deepEqual(idShapes('ZQVENDOR-2.5:generate', fake), ['ZQVENDOR-2.5']);
});

test('(a) no file push B adds or edits holds a model-family word', () => {
  const files = scoped();
  assert.ok(files.length >= 25, `only ${files.length} files in scope`);
  assert.ok(files.some((f) => rel(f) === 'wrangler.jsonc'));
  assert.ok(files.some((f) => rel(f).startsWith('migrations/0210')));
  const bad: string[] = [];
  for (const f of files) {
    const hits = familyHits(readFileSync(f, 'utf8'));
    if (hits.length) bad.push(`${rel(f)}: ${hits.join(', ')}`);
  }
  assert.deepEqual(bad, [], 'a model-family word (shown by digest prefix) in a push B file');
});

test('(b) repository-wide, model-id shapes only where the frozen ratchet allows, exactly', () => {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 28, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(listed.length > 1000, `git ls-files listed ${listed.length} files`);
  const counts: Record<string, number> = {};
  for (const f of listed) {
    const path = join(ROOT, f);
    if (!existsSync(path) || statSync(path).isDirectory()) continue;
    const buf = readFileSync(path);
    if (buf.includes(0)) continue; // binary
    const n = idShapes(buf.toString()).length;
    if (n) counts[f] = n;
  }
  const byDigest = Object.fromEntries(Object.entries(counts).map(([f, n]) => [sha(f), n]));
  assert.deepEqual(byDigest, ID_SHAPE_RATCHET, `a model id or a Workers AI model path in a tracked file: ${JSON.stringify(counts)}`);
  assert.equal(sha('worker/routes/misc.ts'), Object.keys(ID_SHAPE_RATCHET)[1], 'the ratchet digests are repository paths');
});

test('(c) migration 0210 seeds no model and no rate', () => {
  const sql = readFileSync(join(ROOT, 'migrations/0210_assist_ai_layer.sql'), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(sql, /INSERT[^;]*ai_task_models/i);
  assert.match(sql, /INSERT OR IGNORE INTO ai_settings \(id\) VALUES \(1\);/);
  assert.equal((sql.match(/\bINSERT\b/gi) ?? []).length, 1, 'the settings row is the only seed');
});
