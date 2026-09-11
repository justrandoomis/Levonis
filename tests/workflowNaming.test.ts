/**
 * A deploy workflow must say which Worker it deploys, and whether that Worker
 * serves anyone.
 *
 * WHY THIS EXISTS. The Worker names are inverted: `levonis-staging` serves
 * levonis-iq.com and `levonis-studio-staging` serves studio.levonis-iq.com,
 * while `levonis-studio` serves no domain and `levonis` does not exist. For
 * three rounds that inversion cost real work — a deploy that reported success
 * while changing nothing a user could see, a workflow called "Deploy Studio
 * Production" that ships to a Worker no domain points at, and a report that
 * called the live database unmigrated when the empty one was the one nothing
 * points at.
 *
 * Renaming the workflows fixed the symptom. This test is what stops it coming
 * back: every deploy workflow's display name must name the Worker it actually
 * deploys, and the two that ship to nothing must say so in the name and must
 * not ask anyone to type the word "production" to do it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../.github/workflows/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, dir), 'utf8');
const displayName = (text: string) => {
  const line = text.split('\n').find((l) => l.startsWith('name: '));
  assert.ok(line, 'workflow has no top-level name:');
  return line.slice('name: '.length).trim();
};

/**
 * The truth, read from Cloudflare's configuration by workflow 12 (runs
 * 33380828524 and 33382596554) and recorded in docs/WORKERS.md.
 */
const DEPLOYS: Array<{ file: string; worker: string; live: boolean }> = [
  { file: 'deploy-staging.yml', worker: 'levonis-staging', live: true },
  { file: 'deploy-staging-code.yml', worker: 'levonis-staging', live: true },
  { file: 'deploy-studio-staging.yml', worker: 'levonis-studio-staging', live: true },
  { file: 'deploy-studio-code.yml', worker: 'levonis-studio-staging', live: true },
  { file: 'deploy-production.yml', worker: 'levonis', live: false },
  { file: 'deploy-studio-production.yml', worker: 'levonis-studio', live: false },
];

test('every deploy workflow names the Worker it deploys', () => {
  for (const { file, worker } of DEPLOYS) {
    const name = displayName(read(file));
    assert.ok(
      name.includes(worker),
      `${file}: display name "${name}" does not name its Worker "${worker}"`
    );
  }
});

test('a workflow that ships to a Worker serving no domain says ALTERNATE, and never "Production"', () => {
  for (const { file, live } of DEPLOYS) {
    const name = displayName(read(file));
    if (live) continue;
    assert.match(name, /ALTERNATE/,
      `${file}: "${name}" ships to a Worker no domain points at and must say so`);
    assert.ok(!/production/i.test(name),
      `${file}: "${name}" must not call a domainless Worker production`);
    assert.match(name, /serves no domain/,
      `${file}: "${name}" must state plainly that it serves no domain`);
  }
});

test('the live deploys are marked LIVE, so the normal path is obvious', () => {
  for (const file of ['deploy-staging-code.yml', 'deploy-studio-code.yml']) {
    assert.match(displayName(read(file)), /LIVE/, `${file} is the normal path and must say LIVE`);
  }
});

test('no two workflows share a number prefix', () => {
  const seen = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const name = displayName(read(file));
    const prefix = name.split(' ')[0];
    if (!/^\d+$/.test(prefix)) continue;
    const previous = seen.get(prefix);
    assert.equal(previous, undefined,
      `workflows ${previous} and ${file} both start with "${prefix} -"`);
    seen.set(prefix, file);
  }
});

test('the confirmation phrases match what the workflow actually deploys', () => {
  // Typing "PRODUCTION" to deploy a Worker that serves nothing is the exact
  // confusion this round was asked to end.
  const alt = [
    ['deploy-production.yml', 'DEPLOY-ALTERNATE-MAIN-WORKER'],
    ['deploy-studio-production.yml', 'DEPLOY-ALTERNATE-STUDIO-WORKER'],
  ] as const;
  for (const [file, phrase] of alt) {
    const text = read(file);
    assert.ok(text.includes(phrase), `${file} must confirm with ${phrase}`);
    assert.ok(!/DEPLOY-PRODUCTION|DEPLOY-STUDIO-PRODUCTION/.test(text),
      `${file} still uses a confirmation phrase that says production`);
  }
});

test('every deploy workflow carries the worker-truth banner', () => {
  for (const { file } of DEPLOYS) {
    const text = read(file);
    assert.match(text, /WHICH WORKER SERVES WHOM/, `${file} lost the banner`);
    assert.match(text, /studio\.levonis-iq\.com {2}-> Worker {2}levonis-studio-staging {3}\[LIVE\]/,
      `${file}: the banner no longer states the Studio mapping`);
  }
});

test('docs/WORKERS.md agrees with this test, so the two cannot drift apart', () => {
  const doc = readFileSync(new URL('../docs/WORKERS.md', import.meta.url), 'utf8');
  assert.match(doc, /`levonis-staging`\*\*? ?\|? ?\*?\*?LIVE/i);
  for (const { worker } of DEPLOYS) assert.ok(doc.includes(worker), `WORKERS.md does not mention ${worker}`);
  assert.match(doc, /does not exist on the account/);
});

test('routing is still not declared in either wrangler config', () => {
  // The mapping above lives in the Cloudflare dashboard. If a config ever
  // starts declaring routes, this table stops being the whole truth.
  for (const config of ['../wrangler.jsonc', '../studio/wrangler.jsonc']) {
    const text = readFileSync(new URL(config, import.meta.url), 'utf8');
    const withoutComments = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/"routes"\s*:/.test(withoutComments), `${config} now declares routes`);
    assert.ok(!/"custom_domains"\s*:/.test(withoutComments), `${config} now declares custom_domains`);
  }
});

/**
 * The display name is a claim. This is the check that it is TRUE.
 *
 * Everything above compares display strings against the table at the top of
 * this file — which is a table I wrote. If someone added `--env staging` to
 * deploy-production.yml tomorrow, that workflow would start deploying the LIVE
 * main site while still calling itself an alternate Worker that serves no
 * domain, and every assertion above would pass. So this one ignores the table
 * and resolves the Worker the way wrangler does: from the deploy invocation
 * and the config it reads.
 */
function workerActuallyDeployed(file: string): string {
  const text = read(file);
  const studio = file.includes('studio');
  const config = readFileSync(
    new URL(studio ? '../studio/wrangler.jsonc' : '../wrangler.jsonc', import.meta.url),
    'utf8'
  );
  // Strip // comments so a name mentioned in prose is never mistaken for config.
  const bare = config.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  const deploys = text
    .split('\n')
    .filter((l) => /wrangler deploy/.test(l) && !l.trim().startsWith('#'));
  assert.ok(deploys.length > 0, `${file} never runs wrangler deploy`);

  // An --env on ANY deploy line, or a CLOUDFLARE_ENV anywhere, selects the
  // named environment block; otherwise the top-level name applies.
  const envFlag = deploys.join('\n').match(/--env\s+([a-z0-9_-]+)/i);
  // Only a real YAML assignment counts. deploy-studio-production.yml explains
  // itself with the prose "No CLOUDFLARE_ENV: the top-level wrangler.jsonc
  // environment is ...", and a regex over the whole file reads that as an
  // environment called "the".
  const envVar = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .map((l) => l.match(/^\s*CLOUDFLARE_ENV:\s*([a-z0-9_-]+)\s*$/i))
    .find(Boolean);
  const env = envFlag?.[1] ?? envVar?.[1] ?? null;

  if (!env) {
    const top = bare.match(/"name"\s*:\s*"([^"]+)"/);
    assert.ok(top, 'the wrangler config has no top-level name');
    return top[1];
  }
  const block = bare.slice(bare.indexOf(`"${env}"`));
  const named = block.match(/"name"\s*:\s*"([^"]+)"/);
  assert.ok(named, `the wrangler config has no name under env "${env}"`);
  return named[1];
}

test('each deploy workflow really deploys the Worker its name claims', () => {
  for (const { file, worker } of DEPLOYS) {
    assert.equal(
      workerActuallyDeployed(file),
      worker,
      `${file} deploys a different Worker than its name and this table say`
    );
  }
});

test('no workflow header still calls a live Worker a staging environment', () => {
  // Two headers survived the rename saying "Never touches the production
  // database ... or any DNS/domain" directly above a banner stating that the
  // Worker they deploy serves levonis-iq.com and studio.levonis-iq.com. A
  // comment that contradicts the file it sits in is worse than no comment.
  for (const { file, live } of DEPLOYS) {
    if (!live) continue;
    const text = read(file);
    assert.ok(
      !/Never touches the production database/.test(text),
      `${file} still claims it never touches production data, and it deploys a live Worker`
    );
  }
});

/**
 * A wrangler command must not name a Worker AND pass --env.
 *
 * WHY THIS EXISTS. Under legacy-env semantics wrangler APPENDS the env to a
 * Worker name it was given, so `wrangler tail levonis-staging --env staging`
 * asks Cloudflare for `levonis-staging-staging` and is answered "This Worker
 * does not exist on your account. [code: 10007]". That is invisible unless
 * you read the stderr of a backgrounded process: run 33424449216 passed all
 * 33 live checks and then failed only because the log capture had silently
 * attached to nothing.
 *
 * The inverted names are exactly what makes this trap easy to fall into —
 * `levonis-staging` already looks like "levonis, staging env", so writing it
 * next to `--env staging` reads as agreement rather than duplication. Say the
 * Worker once: either the name (`--name levonis-staging`, no --env) or the
 * env (`--env staging`, no name).
 */
const wranglerLines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#'))
    // `nohup npx wrangler …` and `printf … | npx wrangler …` both count, so
    // match the word anywhere on a line that is not a comment.
    .filter((l) => /\bwrangler\s+[a-z]/.test(l));

/** The subcommands that take a Worker name as their first positional. */
const POSITIONAL_WORKER = /\bwrangler\s+(tail|deployments|triggers|versions)\b/;

test('no wrangler command names a Worker and passes --env (legacy env would suffix it twice)', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    for (const line of wranglerLines(read(file))) {
      if (!/--env\s+\S/.test(line)) continue;
      if (/--name\s+\S/.test(line)) {
        offenders.push(`${file}: --name together with --env  ->  ${line}`);
        continue;
      }
      const positional = line.match(
        /\bwrangler\s+(?:tail|deployments|triggers|versions)\s+(?!-)(\S+)/
      );
      if (POSITIONAL_WORKER.test(line) && positional) {
        offenders.push(`${file}: "${positional[1]}" together with --env  ->  ${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `wrangler would look for <name>-<env>:\n${offenders.join('\n')}`);
});

test('the live-auth log capture attaches to the Worker that serves the apex', () => {
  const text = read('verify-live-auth.yml');
  const tail = wranglerLines(text).find((l) => /wrangler\s+tail\b/.test(l));
  assert.ok(tail, 'verify-live-auth.yml no longer captures the Worker log at all');
  assert.match(tail, /--env\s+staging\b/, `the tail must resolve env.staging (levonis-staging): ${tail}`);

  // Positive proof of attachment, not just a live process: wrangler prints
  // "Connected to <script>" ONLY under --format pretty, so json cannot be
  // used here without giving up the one signal that names the Worker reached.
  assert.match(tail, /--format\s+pretty\b/, `the tail needs pretty output for its banner: ${tail}`);
  assert.match(
    text,
    /grep -q 'Connected to levonis-staging'/,
    'the tail step must assert the banner names levonis-staging, not merely that the process lives'
  );
});

test('the provider-log grep covers every way a send is refused', () => {
  const text = read('verify-live-auth.yml');
  // THE GREP, not the file. Every one of these phrases also appears in the
  // comment above the command explaining why it is there, so a whole-file
  // `includes` passes even after the pattern itself is narrowed — it did,
  // when this was written that way.
  const counting = text.split('\n').find((l) => /N=\$\(grep -c/.test(l));
  assert.ok(counting, 'verify-live-auth.yml no longer counts provider errors at all');

  // Each phrase is a literal the Worker itself logs: worker/routes/auth.ts
  // sendEmail() writes the first two, forgot-password writes the third on a
  // false return, and worker/lib/outbox.ts records the fourth in last_error.
  for (const phrase of [
    'provider responded',
    'sendEmail: request failed',
    'Password reset email send failed',
    'resend [0-9]',
  ]) {
    assert.ok(
      counting.includes(phrase),
      `the provider-log grep does not look for "${phrase}", so that refusal would read as a clean run:\n  ${counting}`
    );
  }
});

test('an unobservable provider response fails the run rather than passing quietly', () => {
  const text = read('verify-live-auth.yml');
  assert.ok(
    text.includes('errors=not captured'),
    'the provider-log step must distinguish "no error" from "could not look"'
  );
  assert.match(
    text,
    /\[ "\$\{\{ steps\.providerlog\.outputs\.errors \}\}" = "0" \]/,
    'the final gate must require a real zero — "not captured" is not evidence of delivery'
  );
});

/**
 * Since the email-first sign-up (migration 0051) POST /register opens no
 * account, so the live-auth scenario cannot get its user from it: the workflow
 * inserts the run's identity into the live database with the Worker's own
 * hash algorithm, the scenario signs in, and /register is checked for what it
 * now promises — a uniform 200 with no session — while the database proves
 * the rest by counts. Run 9 of workflow 15 failed for exactly this reason,
 * with nothing wrong on the site; these pins keep the three parts agreeing.
 */
test('the live-auth identity is inserted with the Worker\'s hash algorithm, and the scenario signs in rather than registering', () => {
  // Shell continuations (`\` + newline) are joined first, so a flag on the
  // next physical line still belongs to its command.
  const lines = read('verify-live-auth.yml')
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#'));
  const hashAt = lines.findIndex((l) => /node scripts\/live-auth-identity\.mjs --sql /.test(l));
  assert.ok(hashAt >= 0, 'the workflow no longer produces the identity with scripts/live-auth-identity.mjs');
  const maskAt = lines.findIndex((l) => /::add-mask::\$HASH/.test(l));
  assert.ok(maskAt > hashAt, 'the hash must be masked right after it is produced');
  const insertAt = lines.findIndex((l) => /wrangler d1 execute levonis-db-staging --remote --env staging .*--file/.test(l));
  assert.ok(insertAt > maskAt, 'the INSERT must run from a file, after the mask');
  assert.ok(!lines.some((l) => /--command .*INSERT INTO/i.test(l)), 'never an inline INSERT — argv would carry the hash');
  assert.ok(!lines.some((l) => /node scripts\/live-auth-identity\.mjs.*\$(TEST_PASSWORD|\{TEST_PASSWORD)/.test(l)),
    'the password reaches the script through the environment, never argv');

  const scenario = readFileSync(new URL('../scripts/e2e-live-auth.mjs', import.meta.url), 'utf8');
  assert.match(scenario, /\/api\/auth\/login/, 'the scenario must sign in');
  assert.match(scenario, /pending_email === true/, 'the scenario must assert the email-first body');
  assert.match(scenario, /SIGNUP_EMAIL/, 'the sign-up probe uses its own address');
  const register = scenario.slice(scenario.indexOf("'/api/auth/register'"));
  assert.ok(!/userId = body\?\.user\?\.id/.test(register), 'the user id must not come from /register any more');
  assert.match(read('verify-live-auth.yml'), /SIGNUP_EMAIL: \$\{\{ steps\.identity\.outputs\.signup_addr \}\}/,
    'the workflow must hand the scenario the second address');
});

test('the outbox step proves the email-first sign-up from the database, by counts only, and the gate includes the identity step', () => {
  const yml = read('verify-live-auth.yml');
  assert.match(yml, /FROM pending_signups WHERE email LIKE '%\+\$\{SIGNUP_TAG\}@%'/, 'the pending row must be counted by the sign-up tag');
  assert.match(yml, /FROM users WHERE email LIKE '%\+\$\{SIGNUP_TAG\}@%'/, 'the absence of a users row for the sign-up address must be asserted');
  assert.match(yml, /payload LIKE '%\$\{APEX\}\/auth\?finish=%'/, 'the sign-up link must be proved on APEX, inside a predicate');
  assert.match(yml, /\[ "\$SIGNUP_USERS" = "0" \]/, 'the step must fail when /register opened an account');
  assert.match(yml, /\[ "\$SIGNUP_PENDING" = "1" \]/, 'exactly one pending row, not "at least one"');

  // Every d1 query the workflow runs must be a count or a state listing. A
  // payload, token hash or event key leaving the database would print a live
  // credential (or its hash) into the log.
  for (const line of yml.split('\n')) {
    const list = /SELECT\s+(.*?)(?:\s+FROM\b|$)/.exec(line)?.[1];
    if (list === undefined) continue;
    assert.ok(!/^\*/.test(list.trim()), `a SELECT * would print row contents: ${line.trim()}`);
    assert.ok(!/\b(payload|token_hash|event_key|password_hash|email)\b/.test(list),
      `a credential- or identity-bearing column is selected: ${line.trim()}`);
  }
  assert.match(yml, /\[ "\$\{\{ steps\.account\.outcome \}\}" = "success" \]/, 'the final gate must include the identity step');
});

/* ==========================================================================
 * PHASE 1 — the per-service deploy workflows (02-MIGRATION-PLAN.md 1.9, §12).
 *
 * The six `svc-<name>.yml` files, the reusable `_deploy-worker.yml` they call,
 * `svc-probes.yml` and `verify-dark.yml` are new deploy paths, and every rule
 * above exists because a deploy workflow that misdescribed itself cost real
 * work. So the same rules apply to them, plus the three this programme adds:
 * a new Worker name never contains "staging" (on this account that suffix
 * means LIVE — ADR-011), a dark Worker says out loud that it serves no domain,
 * and no new workflow may deploy, tail or otherwise target one of the two live
 * Workers.
 * ======================================================================== */

/** The truth, read from the wrangler configs by `workerFromServiceConfig` below. */
const SVC_DEPLOYS: Array<{ file: string; service: string; worker: string; env: string }> = [
  { file: 'svc-core-dark.yml', service: 'core', worker: 'levonis-core-dark', env: 'dark' },
  { file: 'svc-gateway.yml', service: 'gateway', worker: 'levonis-gateway-dark', env: 'dark' },
  { file: 'svc-audit.yml', service: 'audit', worker: 'levonis-audit-dark', env: 'dark' },
  { file: 'svc-analytics.yml', service: 'analytics', worker: 'levonis-analytics-dark', env: 'dark' },
  { file: 'svc-ads.yml', service: 'ads', worker: 'levonis-ads-dark', env: 'dark' },
  { file: 'svc-notifications.yml', service: 'notifications', worker: 'levonis-notifications-dark', env: 'dark' },
];

const LIVE_WORKERS = ['levonis-staging', 'levonis-studio-staging'];

const REPO = new URL('../', import.meta.url);

/** Every wrangler config in the repository: root, studio, services and probes. */
function wranglerConfigs(): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 4) return;
    const url = new URL(rel, REPO);
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) walk(`${rel}${entry.name}/`, depth + 1);
      else if (entry.name === 'wrangler.jsonc' || entry.name === 'wrangler.json') out.push(new URL(`${rel}${entry.name}`, REPO).pathname);
    }
  };
  walk('', 0);
  return out.sort();
}

/** Resolve a Worker name the way wrangler does: from the config and the env the file passes. */
function workerFromServiceConfig(service: string, env: string): string {
  const rel = service === 'core' ? '../wrangler.jsonc' : `../services/${service}/wrangler.jsonc`;
  const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
  const bare = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  if (!env || env === 'production') {
    const top = bare.match(/"name"\s*:\s*"([^"]+)"/);
    assert.ok(top, `${rel} has no top-level name`);
    return top[1];
  }
  const at = bare.indexOf(`"${env}"`);
  assert.ok(at > 0, `${rel} declares no env "${env}"`);
  const named = bare.slice(at).match(/"name"\s*:\s*"([^"]+)"/);
  assert.ok(named, `${rel} has no name under env "${env}"`);
  return named[1];
}

test('every svc-*.yml names the Worker it deploys, and says it serves no domain', () => {
  for (const { file, worker } of SVC_DEPLOYS) {
    const name = displayName(read(file));
    assert.ok(name.includes(worker), `${file}: display name "${name}" does not name its Worker "${worker}"`);
    assert.match(name, /DARK/, `${file}: "${name}" deploys a dark Worker and must say DARK`);
    assert.match(name, /serves no domain/, `${file}: "${name}" must state plainly that it serves no domain`);
    assert.ok(!/LIVE/.test(name), `${file}: "${name}" says LIVE for a Worker no domain points at`);
  }
});

test('each svc-*.yml really deploys the Worker its name claims, resolved from the wrangler config', () => {
  // The display name is a claim; this resolves it the way wrangler would, from
  // the `service:`/`env:` the file hands the reusable workflow. Renaming a
  // Worker in a config without renaming the workflow fails here.
  for (const { file, service, worker, env } of SVC_DEPLOYS) {
    const text = read(file);
    const svc = text.match(/^\s*service:\s*([a-z0-9-]+)\s*$/m);
    const en = text.match(/^\s*env:\s*([a-z0-9-]+)\s*$/m);
    assert.ok(svc && en, `${file} does not pass a service and an env to _deploy-worker.yml`);
    assert.equal(svc[1], service, `${file} deploys service "${svc[1]}", not "${service}"`);
    assert.equal(en[1], env, `${file} deploys env "${en[1]}", not "${env}"`);
    assert.equal(workerFromServiceConfig(svc[1], en[1]), worker, `${file}: the config resolves to a different Worker than its name claims`);
  }
});

test('no new Worker name contains "staging" — on this account that suffix means LIVE', () => {
  for (const { file, worker } of SVC_DEPLOYS) {
    assert.ok(!/staging/.test(worker), `${file}: "${worker}" — ADR-011 forbids the suffix on any new Worker`);
  }
  // and no wrangler config in the tree introduces one either
  for (const file of wranglerConfigs()) {
    const bare = readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const m of bare.matchAll(/"name"\s*:\s*"([^"]+)"/g)) {
      if (LIVE_WORKERS.includes(m[1])) continue; // the two historical names, never renamed
      assert.ok(!/staging/.test(m[1]), `${file.split('/Levonis/')[1]}: new Worker name "${m[1]}" contains "staging"`);
    }
  }
});

test('every new deploy workflow carries the worker-truth banner and a confirmation', () => {
  for (const { file } of [...SVC_DEPLOYS, { file: 'svc-probes.yml' }, { file: 'verify-dark.yml' }]) {
    const text = read(file);
    assert.match(text, /WHICH WORKER SERVES WHOM/, `${file} has no banner`);
    assert.match(text, /studio\.levonis-iq\.com {2}-> Worker {2}levonis-studio-staging {3}\[LIVE\]/, `${file}: the banner no longer states the Studio mapping`);
    assert.match(text, /inputs:\s*[\s\S]*?confirm:/, `${file} has no confirm input`);
    const phrase = /Type ([A-Z-]+)(?: to deploy them, or ([A-Z-]+))? to confirm|Type ([A-Z-]+)/.exec(text);
    assert.ok(phrase, `${file}: the confirm input does not name a phrase to type`);
    const typed = phrase[1] ?? phrase[3];
    // Either shape counts: `[ "$..." = "PHRASE" ]` or a `case` arm `PHRASE)`.
    assert.ok(
      text.includes(`= "${typed}"`) || new RegExp(`^\\s*${typed}\\)`, 'm').test(text),
      `${file}: nothing actually compares the input against ${typed}`
    );
    assert.ok(!/DEPLOY-PRODUCTION|-PRODUCTION"/.test(text), `${file}: a Worker that serves no domain must not be confirmed with the word production`);
  }
});

test('no new workflow deploys, tails or targets one of the two live Workers', () => {
  const NEW = [...SVC_DEPLOYS.map((s) => s.file), 'svc-probes.yml', 'verify-dark.yml', '_deploy-worker.yml'];
  for (const file of NEW) {
    const text = read(file);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue; // the banner names them on purpose
      for (const live of LIVE_WORKERS) {
        if (!trimmed.includes(live)) continue;
        // The only legal mention outside a comment is the guard that REFUSES it.
        assert.match(
          trimmed,
          /error::|case |\|levonis-studio-staging\)|refus/i,
          `${file}: names the live Worker ${live} outside a refusal:  ${trimmed}`
        );
      }
    }
    assert.ok(!/wrangler\s+tail/.test(text), `${file}: a dark deploy has no business tailing a Worker`);
  }
});

test('the reusable workflow runs the gates first and the migrations before the code', () => {
  // Comment lines are stripped first: this file explains its own ordering in
  // its header, and a search over the prose would find every step before the
  // first one actually runs.
  const text = read('_deploy-worker.yml')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const order = (re: RegExp) => text.search(re);
  const gates = order(/npm run check/);
  const plan = order(/assert-paid-plan\.mjs/);
  const ids = order(/resolve-ids\.mjs/);
  const vars = order(/preserve-vars\.mjs/);
  const migrations = order(/d1 migrations apply/);
  const deploy = order(/wrangler deploy -c/);
  const secrets = order(/upload-secrets\.mjs/);
  const health = order(/probe-health\.mjs/);
  for (const [what, at] of Object.entries({ gates, plan, ids, vars, migrations, deploy, secrets, health })) {
    assert.ok(at > 0, `_deploy-worker.yml never runs ${what}`);
  }
  assert.ok(gates < plan, 'the tests must run before anything is created');
  assert.ok(plan < ids, 'the Workers Paid precondition must be checked before a resource is created');
  assert.ok(vars < deploy, 'the running vars must be read back before the deploy that would replace them');
  assert.ok(migrations < deploy, 'migrations go before the code that needs them — the 2026-08-30 outage');
  assert.ok(deploy < secrets, 'a secret uploaded to a Worker about to be replaced is pointless ordering');
  assert.ok(secrets < health, 'health is the last word');
  // The two-step first deploy is what makes self-bindings and cycles deployable.
  assert.match(text, /--full/, '_deploy-worker.yml has no second deploy pass, so a self-binding could never be deployed');
});

test('verify-dark.yml deploys the whole dark stack in the plan order: consumers, core, gateway', () => {
  const text = read('verify-dark.yml');
  for (const { service } of SVC_DEPLOYS) {
    assert.ok(new RegExp(`service:\\s*${service}\\b`).test(text), `verify-dark.yml never deploys ${service}`);
  }
  const at = (s: string) => text.search(new RegExp(`service:\\s*${s}\\b`));
  for (const consumer of ['audit', 'analytics', 'ads', 'notifications']) {
    assert.ok(at(consumer) < at('core'), `verify-dark.yml deploys core before ${consumer} — the upload API rejects a binding to a Worker that does not exist yet`);
  }
  assert.ok(at('core') < at('gateway'), 'the gateway binds the core, so the core is deployed first');
  assert.match(text, /e2e-dark\.mjs/, 'verify-dark.yml must drive the event path end to end');
  assert.match(text, /api-tests\.mjs/, 'verify-dark.yml must seed the empty dark database');
});

test('no wrangler config anywhere in the repository declares routes or custom domains', () => {
  // Routing lives in the Cloudflare dashboard (docs/WORKERS.md). The rule used
  // to cover the two configs that existed; there are now fifteen, including
  // eleven throwaway probes, and the ONE that will eventually have zone routes
  // is the gateway — whose routes are added at G3 and whose rollback is
  // deleting them, which only works while they are not in the repository.
  for (const file of wranglerConfigs()) {
    const bare = readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const rel = file.split('/Levonis/')[1] ?? file;
    assert.ok(!/"routes"\s*:/.test(bare), `${rel} now declares routes`);
    assert.ok(!/"route"\s*:/.test(bare), `${rel} now declares a route`);
    assert.ok(!/"custom_domains"\s*:/.test(bare), `${rel} now declares custom_domains`);
  }
});

/**
 * A live check that greps the served bundle must read the WHOLE module graph.
 *
 * WHY THIS EXISTS. Vite names only the entry modules in index.html; every
 * lazily loaded screen is named from inside another chunk, and those names
 * nest. When the bundles work landed, AdminProducts moved one hop further
 * out and the admin product form ended up THREE hops from the entry — so the
 * one-hop crawl these workflows used read 60 of the 93 served modules and
 * reported the shipped «Sub-section» field as missing (workflow 22, run 7).
 *
 * The one-hop crawl lies in both directions: a shipped marker reads as
 * "missing", and a marker still shipped in a deeper chunk reads as "gone" —
 * which is worse, because that is the shape of every negative assertion these
 * workflows make. So the crawl is now one shared script that walks the graph
 * until it stops growing, and this test is what stops a one-hop copy coming
 * back.
 */
test('every live check that greps served modules uses the transitive crawler', () => {
  const crawler = readFileSync(new URL('../../scripts/live-modules.sh', dir), 'utf8');
  // The property that matters is transitivity: a frontier that is refilled
  // from what each fetched chunk names, looped until it is empty.
  assert.match(crawler, /while \[ -s \/tmp\/mods-frontier \]/, 'the crawler does not loop over a frontier');
  assert.match(crawler, /sort -u \/tmp\/mods-next > \/tmp\/mods-frontier/, 'the crawler never refills its frontier');

  const files = readdirSync(dir).filter((f) => f.startsWith('verify-live-') && f.endsWith('.yml'));
  assert.ok(files.length >= 9, `expected the live verification workflows, found ${files.length}`);

  for (const file of files) {
    const text = read(file);
    if (!text.includes('/tmp/mods')) continue;
    assert.match(
      text,
      /bash scripts\/live-modules\.sh "\$APEX"/,
      `${file} reads served modules without the shared transitive crawler`,
    );
    // The one-hop shape: fetch the entries, then fetch what they name, and stop.
    assert.ok(
      !/for a in \$entries; do/.test(text),
      `${file} still carries a one-hop module crawl`,
    );
    // The script is in the repo, so the job has to check the repo out.
    assert.match(text, /actions\/checkout/, `${file} calls the crawler without checking the repo out`);
  }
});
