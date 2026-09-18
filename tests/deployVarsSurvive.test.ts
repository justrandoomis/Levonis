/**
 * A DEPLOY MAY NOT BLANK A VARIABLE BY OMISSION.
 *
 * On 2026-09-18 the live shop lost Google sign-in, password reset, email
 * verification and email sign-in codes — FOUR times — without anyone touching a
 * setting. `wrangler deploy` replaces a Worker's plain-text vars WHOLESALE, and
 * `wrangler.jsonc` USED TO declare them as empty strings, so a deploy that could
 * not supply the real values wrote `""` over a working site.
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
 * `keep_vars: true` is half the answer: wrangler leaves alone any variable it
 * was not explicitly GIVEN.
 *
 * IT IS ONLY HALF, and finding that out cost a fourth outage. The deploy at
 * 13:12 on the same day carried `keep_vars: true` and blanked them anyway,
 * because `wrangler.jsonc` still DECLARED those names as "" — and a declared ""
 * is a value wrangler is given, so it is deployed, and it clears the live one.
 * Wrangler's own schema says as much: keep_vars keeps what you do not set.
 *
 * The other half is that this file may not name a variable it cannot fill. Both
 * halves are pinned below, because either one alone has now been observed to
 * fail on a running shop.
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
 * THE ASSERTION THIS FILE USED TO MAKE WAS THE BUG.
 *
 * It required GOOGLE_CLIENT_ID, EMAIL_FROM, APP_ORIGIN and STORE_ROOT_DOMAIN to
 * "stay declared so a deploy can set it" — and declared they were, as "". That
 * is not how wrangler reads this file. A declared "" is a value it is GIVEN, so
 * it deploys it, and the live value is replaced by nothing. The names were
 * declared precisely so they could be wiped.
 *
 * A deploy sets a var by passing it (`--var NAME:value`, or a build variable
 * the preservation pass picks up). Declaring the name here is not needed for
 * that and never was: `mergeVars` considers every name LIVE ON THE WORKER, not
 * only the ones this file lists — that was fixed when STORE_ROOT_DOMAIN was
 * lost, and it is why the declarations had no job left to do.
 */
test('NO vars block may declare an empty string — in any environment', () => {
  const cfg = config();
  const blocks: Array<[string, Record<string, unknown>]> = [
    ['(top level)', (cfg.vars ?? {}) as Record<string, unknown>],
    ...Object.entries((cfg.env ?? {}) as Record<string, { vars?: Record<string, unknown> }>).map(
      ([name, block]) => [`env.${name}`, block.vars ?? {}] as [string, Record<string, unknown>]
    ),
  ];
  for (const [where, vars] of blocks) {
    for (const [name, value] of Object.entries(vars)) {
      assert.notEqual(
        value,
        '',
        `${where} declares ${name} as "" — that is not "unset", it is an instruction to CLEAR the live ` +
          'value on the next deploy, and keep_vars does not stop it. Supply the value at deploy time instead.'
      );
    }
  }
});

/**
 * The names that were declared empty, listed once so the diff that removed them
 * is readable years from now. Every one is supplied at deploy time and kept
 * between deploys by `keep_vars`; none of them may come back into this file
 * without a real value.
 */
test('the names that used to be declared empty are gone from every block', () => {
  const cfg = config();
  const envs = (cfg.env ?? {}) as Record<string, { vars?: Record<string, unknown> }>;
  const wiped = [
    'GOOGLE_CLIENT_ID',
    'INITIAL_ADMIN_EMAIL',
    'EXTRA_ALLOWED_ORIGINS',
    'APP_ORIGIN',
    'EMAIL_ALLOWED_RECIPIENTS',
    'EMAIL_FROM',
    'STORE_ROOT_DOMAIN',
    'STUDIO_ALLOWED_DESTINATIONS',
  ];
  for (const [where, vars] of [
    ['(top level)', (cfg.vars ?? {}) as Record<string, unknown>],
    ...Object.entries(envs).map(([n, b]) => [`env.${n}`, b.vars ?? {}] as [string, Record<string, unknown>]),
  ] as Array<[string, Record<string, unknown>]>) {
    for (const name of wiped) {
      assert.ok(!(name in vars), `${where} must not name ${name} — it is set at deploy time, not here`);
    }
  }
});

/**
 * The one rule that survives without a declaration, stated so nobody
 * reintroduces `EMAIL_ALLOWED_RECIPIENTS: ""` to "make the dark stack safe".
 *
 * `EMAIL_ALLOWLIST_REQUIRED: "on"` is what makes an EMPTY allowlist mean "mail
 * NOBODY" in the dark environment, and `worker/lib/outbox.ts` reads the
 * allowlist as `(env.EMAIL_ALLOWED_RECIPIENTS || '')` — so an ABSENT name and
 * an empty one are the same thing to that rule. The safety needs the flag, not
 * the empty declaration.
 */
test('the dark stack still cannot mail a real address without declaring an empty allowlist', () => {
  const cfg = config();
  const dark = ((cfg.env ?? {}) as Record<string, { vars?: Record<string, string> }>).dark?.vars ?? {};
  assert.equal(dark.EMAIL_ALLOWLIST_REQUIRED, 'on', 'this flag is the safety; the empty allowlist was never it');
  // `emailAllowsRecipient` is the one reader of both names (outbox.ts and
  // routes/auth.ts call through to it).
  const emailSend = readFileSync(join(ROOT, 'worker/lib/emailSend.ts'), 'utf8');
  assert.match(
    emailSend,
    /EMAIL_ALLOWED_RECIPIENTS\s*\|\|\s*''/,
    'an absent allowlist must read as empty, or removing the declaration would change the rule'
  );
  assert.match(
    emailSend,
    /EMAIL_ALLOWLIST_REQUIRED\s*\|\|\s*''/,
    'and the flag must survive being absent too'
  );
});

test('the preserve-on-build script still swallows a failed read — which is why keep_vars exists', () => {
  const src = readFileSync(join(ROOT, 'scripts/prepare-deploy-config.mjs'), 'utf8');
  // Not a demand that it be changed: reading the live Worker is best-effort by
  // design, and a build must not fail because one API call did. In the Workers
  // Builds container it has no CLOUDFLARE_API_TOKEN at all, so it returns null
  // on EVERY build — this path is the normal one, not the exception. The point
  // is that this file therefore CANNOT be the only protection, and this
  // assertion ties the two together so removing keep_vars looks as wrong as it
  // is.
  assert.match(
    src,
    /liveVars\([^)]*\)\.catch\(\(\)\s*=>\s*null\)/,
    'if this ever stops swallowing, revisit the note in tests/deployVarsSurvive.test.ts'
  );
});

/**
 * The second half, in the code rather than the config: whatever this file says,
 * the merge itself refuses to hand wrangler an empty value.
 */
test('the merge drops an empty var instead of deploying it', () => {
  const src = readFileSync(join(ROOT, 'scripts/lib/preserve-vars.mjs'), 'utf8');
  assert.match(src, /for \(const key of dropped\) delete vars\[key\]/, 'an empty name must not reach wrangler');
});
