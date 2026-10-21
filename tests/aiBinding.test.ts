/**
 * THE WORKERS AI BINDING REACHES THE LIVE WORKER (the support assistant AI layer, DECISIONS row 262).
 *
 * `ai` is a NON-INHERITABLE wrangler key, like `images`. It is declared on env.staging (the live Worker) only, and
 * the Workers Builds fold carries it. Not at the top level: `ai` has no local simulator, so a top-level binding
 * would make a plain `npm run dev` open a remote session on a Cloudflare account. Absence is safe (`AI` is
 * optional in `Env`, basic mode), which is why a missing binding is a test failure here and not an outage there.
 *
 * The repository is public and names no AI model: wrangler.jsonc carries the binding only, never a model.
 *
 * Run: node --import tsx --test tests/aiBinding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { parseJsonc } from './lib/wrangler';

const raw = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
const cfg = parseJsonc(raw) as { ai?: { binding?: string }; env: Record<string, { ai?: { binding?: string }; name?: string }> };

test('the AI binding is declared on the live environment only', () => {
  assert.equal(cfg.env.staging?.name, 'levonis-staging');
  assert.equal(cfg.env.staging?.ai?.binding, 'AI', 'env.staging must declare it: wrangler does not inherit `ai`');
  assert.equal(cfg.ai, undefined, 'a top-level `ai` would put local dev on a remote Cloudflare session');
});

test('the Workers Builds fold carries `ai`', () => {
  const src = readFileSync(join(ROOT, 'scripts/prepare-deploy-config.mjs'), 'utf8');
  assert.match(src, /'images',\n\s*'ai',/);
});

test('the binding names no model and no provider path', () => {
  assert.doesNotMatch(raw, /@cf\//, 'a Workers AI model path in wrangler.jsonc');
  assert.doesNotMatch(raw, /"model"\s*:/, 'a model key in wrangler.jsonc');
});

test('the Env type reads the binding and the key as optional', () => {
  const types = readFileSync(join(ROOT, 'worker/lib/types.ts'), 'utf8');
  assert.match(types, /^\s*AI\?: Ai;$/m);
  assert.match(types, /^\s*ANTHROPIC_API_KEY\?: string;$/m);
});
