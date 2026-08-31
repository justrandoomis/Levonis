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
