/**
 * Edge parity (`02-MIGRATION-PLAN.md` §1.1): the platform kit carries COPIES of
 * the core's edge libraries until Phase 3.3 turns the core's files into
 * re-exports. `hosts.ts` and `securityPolicy.ts` are byte-identical files; the
 * three `http.ts` middlewares, the rate-limit key derivation, the SSRF guard
 * and the admin-scope strippers are byte-identical DECLARATIONS (only their
 * imports differ). Any drift fails here, so the gateway can never enforce a
 * rule the core does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const KIT = 'packages/platform-kit/src';

/** The source text of one declaration: `[export] [async] function NAME(...) {...}` or `[export] const NAME = ...;` (balanced). */
export function extractDeclaration(src: string, name: string): string {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\b)`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`declaration ${name} not found`);
  const start = m.index;
  const isFn = /function\s/.test(m[0]);
  let depth = 0;
  let inStr: string | null = null;
  let started = false; // functions: the body brace was seen; consts: the `=` was seen
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      continue;
    }
    if (!isFn && !started && ch === '=') started = true;
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (isFn && ch === '{') started = true;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0 && started && isFn && ch === '}') return src.slice(start, i + 1);
    } else if (!isFn && started && depth === 0 && ch === ';') return src.slice(start, i + 1);
  }
  throw new Error(`declaration ${name} did not close`);
}

const stripExport = (s: string) => s.replace(/^export\s+/, '');

test('hosts.ts and securityPolicy.ts are byte-identical copies', () => {
  assert.equal(read(`${KIT}/edge/hosts.ts`), read('worker/lib/hosts.ts'));
  assert.equal(read(`${KIT}/edge/securityPolicy.ts`), read('worker/lib/securityPolicy.ts'));
});

const PARITY: Array<[string, string, string[]]> = [
  ['worker/lib/http.ts', `${KIT}/edge/middleware.ts`, ['originCheck', 'securityHeaders', 'requireMainHost']],
  ['worker/lib/ratelimit.ts', `${KIT}/ratelimit.ts`, ['rateLimitKey', 'identifierKey']],
  ['worker/lib/fetchGuard.ts', `${KIT}/httpx.ts`, ['normalizeHost', 'ipIsPrivate', 'validateOutboundUrl', 'BLOCKED_HOST_RE']],
  ['worker/lib/adminScope.ts', `${KIT}/scope.ts`, ['normalizeAdminScope', 'FINANCIAL_FIELDS', 'stripFinancials']],
];

for (const [coreFile, kitFile, names] of PARITY) {
  test(`${kitFile} carries byte-identical declarations of ${names.join(', ')} from ${coreFile}`, () => {
    const core = read(coreFile);
    const kit = read(kitFile);
    for (const name of names) {
      assert.equal(stripExport(extractDeclaration(kit, name)), stripExport(extractDeclaration(core, name)), `${name} drifted between ${coreFile} and ${kitFile}`);
    }
  });
}

test('the extractor itself: balanced braces, strings with braces, trailing consts', () => {
  const src = "export function a() {\n  const s = '}';\n  if (x) { return 1; }\n}\nexport const B = ['}', '{'] as const;\nconst c = 1;";
  assert.equal(extractDeclaration(src, 'a'), "export function a() {\n  const s = '}';\n  if (x) { return 1; }\n}");
  assert.equal(extractDeclaration(src, 'B'), "export const B = ['}', '{'] as const;");
  assert.equal(extractDeclaration(src, 'c'), 'const c = 1;');
  assert.throws(() => extractDeclaration(src, 'nope'), /not found/);
});
