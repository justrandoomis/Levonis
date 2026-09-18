/**
 * A DEPLOY MAY NOT BLANK A VARIABLE BY OMISSION.
 *
 * On 2026-09-18 the live shop lost Google sign-in, password reset, email
 * verification and email sign-in codes — twice — without anyone touching a
 * setting. `wrangler deploy` replaces a Worker's plain-text vars WHOLESALE, and
 * `wrangler.jsonc` declares them as empty strings, so a deploy that could not
 * supply the real values wrote `""` over a working site.
 *
 * `scripts/prepare-deploy-config.mjs` was already written to prevent exactly
 * this on the Workers Builds path, and it still happened, because its
 * protection depends on a network read that is allowed to fail quietly:
 *
 *     const live = await liveVars(cfg.name).catch(() => null);
 *
 * When that read fails there is nothing to preserve FROM, the merge falls back
 * to the committed empty strings, and the site goes dark about a minute after a
 * push. A guard that depends on a call succeeding is not a guard.
 *
 * `keep_vars` is the one that cannot fail: wrangler leaves alone any variable it
 * was not explicitly given. This suite is what stops it being removed as
 * "unused config" by somebody who was not here for the outage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

/**
 * wrangler.jsonc with comments stripped — the same thing wrangler parses.
 *
 * A regex cannot do this: `//` inside a string value is not a comment, and a
 * naive strip corrupts any URL in the file. This is the character-by-character
 * reader `scripts/prepare-deploy-config.mjs` already uses, kept identical on
 * purpose — a test that parses this file differently from the deploy is a test
 * that can pass on a config the deploy would reject.
 */
function stripJsonComments(src: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function config(): Record<string, unknown> {
  const raw = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
}

test('keep_vars is on, so no deploy can erase a variable it did not mention', () => {
  const cfg = config();
  assert.equal(
    cfg.keep_vars,
    true,
    'without this, any deploy carrying an incomplete config blanks the rest of the live vars'
  );
});

test('keep_vars is TOP-LEVEL ONLY — wrangler refuses it inside an environment', () => {
  const cfg = config();
  const envs = (cfg.env ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, block] of Object.entries(envs)) {
    assert.equal(
      block.keep_vars,
      undefined,
      `env.${name} must not declare keep_vars — wrangler rejects the config and the whole deploy fails`
    );
  }
});

/**
 * The committed values are placeholders on purpose: the real ones are the
 * owner's and are supplied at deploy time. This test states that out loud, so
 * the empty strings are never mistaken for "this feature is off by design".
 */
test('the vars this file declares empty are the ones that go dark when a deploy blanks them', () => {
  const cfg = config();
  const envs = (cfg.env ?? {}) as Record<string, { vars?: Record<string, unknown> }>;
  const staging = envs.staging?.vars ?? {};
  for (const name of ['GOOGLE_CLIENT_ID', 'EMAIL_FROM', 'APP_ORIGIN', 'STORE_ROOT_DOMAIN']) {
    assert.ok(name in staging, `${name} must stay declared so a deploy can set it`);
  }
});

test('the preserve-on-build script still swallows a failed read — which is why keep_vars exists', () => {
  const src = readFileSync(join(ROOT, 'scripts/prepare-deploy-config.mjs'), 'utf8');
  // Not a demand that it be changed: reading the live Worker is best-effort by
  // design, and a build must not fail because one API call did. The point is
  // that this file therefore CANNOT be the only protection, and this assertion
  // ties the two together so removing keep_vars looks as wrong as it is.
  assert.match(
    src,
    /liveVars\([^)]*\)\.catch\(\(\)\s*=>\s*null\)/,
    'if this ever stops swallowing, revisit the note in tests/deployVarsSurvive.test.ts'
  );
});
