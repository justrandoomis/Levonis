/**
 * The var-preservation rule, extracted from `scripts/prepare-deploy-config.mjs`
 * into `scripts/lib/preserve-vars.mjs` so `_deploy-worker.yml` can apply the
 * SAME rule to every new Worker (`02-MIGRATION-PLAN.md` §11.6, §12).
 *
 * WHY IT IS TESTED AT ALL. `wrangler deploy` replaces a Worker's plain-text
 * vars WHOLESALE: any name not passed on the command line is deleted from the
 * running Worker. That is not a hypothetical — it took `STORE_ROOT_DOMAIN` off
 * the live site, and merchant subdomain resolution went with it, because the
 * merge loop only considered names the committed config happened to declare.
 * The extraction had to keep that fix, and the two behaviours below are the
 * fix: EVERY live name is considered, and an unreadable Worker is `null` rather
 * than an empty set.
 *
 * The module is loaded through its file URL because it is a `.mjs` script, not
 * a workspace package — the same way `tests/sqlSplit.test.ts` loads
 * `scripts/lib/sql-split.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mod = await import(new URL('../scripts/lib/preserve-vars.mjs', import.meta.url).href);
const { liveVars, mergeVars, toTsv } = mod as {
  liveVars: (name: string, opts?: Record<string, unknown>) => Promise<Record<string, string> | null>;
  mergeVars: (
    configVars?: Record<string, string>,
    live?: Record<string, string> | null,
    overrides?: Record<string, string | undefined>
  ) => { vars: Record<string, string>; preserved: string[]; overridden: string[]; empty: string[] };
  toTsv: (vars: Record<string, string>) => string;
};

test('EVERY live name is preserved — including one the committed config does not declare', () => {
  // This is the exact shape of the STORE_ROOT_DOMAIN loss: the config knows
  // GOOGLE_CLIENT_ID and APP_ORIGIN; the running Worker also has
  // STORE_ROOT_DOMAIN, set by a different deploy. A merge that iterated the
  // config's keys would drop it, and the deploy would clear it.
  const config = { GOOGLE_CLIENT_ID: '', APP_ORIGIN: '' };
  const live = { GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com' };
  const merged = mergeVars(config, live, {});
  assert.equal(merged.vars.STORE_ROOT_DOMAIN, 'levonis-iq.com');
  assert.deepEqual(merged.preserved, ['APP_ORIGIN', 'GOOGLE_CLIENT_ID', 'STORE_ROOT_DOMAIN']);
  assert.deepEqual(merged.empty, []);
});

test('an explicit value wins over the live one, and a new name is added', () => {
  const merged = mergeVars({ APP_ORIGIN: '' }, { APP_ORIGIN: 'https://old.example' }, { APP_ORIGIN: 'https://levonis-iq.com', EMAIL_FROM: 'no-reply@levonis-iq.com' });
  assert.equal(merged.vars.APP_ORIGIN, 'https://levonis-iq.com');
  assert.equal(merged.vars.EMAIL_FROM, 'no-reply@levonis-iq.com');
  assert.deepEqual(merged.overridden, ['APP_ORIGIN', 'EMAIL_FROM']);
});

test('a name that ends up empty is reported, because deploying it CLEARS the live value', () => {
  const merged = mergeVars({ GOOGLE_CLIENT_ID: '', APP_ORIGIN: '' }, null, {});
  assert.deepEqual(merged.empty, ['APP_ORIGIN', 'GOOGLE_CLIENT_ID']);
});

test('an unreadable Worker is null and an undeployed one is {} — the caller must be able to tell them apart', async () => {
  const settings = { success: true, result: { bindings: [{ type: 'plain_text', name: 'A', text: '1' }, { type: 'secret_text', name: 'S' }] } };
  const ok = await liveVars('levonis-audit-dark', {
    token: 't',
    account: 'a',
    fetch: async () => new Response(JSON.stringify(settings), { status: 200 }),
  });
  assert.deepEqual(ok, { A: '1' }, 'only plain_text bindings; a secret is never read');

  const firstDeploy = await liveVars('levonis-audit-dark', { token: 't', account: 'a', fetch: async () => new Response('{}', { status: 404 }) });
  assert.deepEqual(firstDeploy, {}, '404 = the Worker has never been deployed, which has no vars to lose');

  const unreadable = await liveVars('levonis-audit-dark', { token: 't', account: 'a', fetch: async () => new Response('nope', { status: 500 }) });
  assert.equal(unreadable, null, 'a failed read must be null, so the caller refuses to deploy blind');

  const threw = await liveVars('levonis-audit-dark', {
    token: 't',
    account: 'a',
    fetch: async () => {
      throw new Error('network');
    },
  });
  assert.equal(threw, null);

  const noCreds = await liveVars('levonis-audit-dark', { token: '', account: '', fetch: async () => new Response('{}') });
  assert.equal(noCreds, null);
});

test('the TSV the workflow reads is name<TAB>value, sorted', () => {
  assert.equal(toTsv({ B: '2', A: '1' }), 'A\t1\nB\t2');
});

test('prepare-deploy-config.mjs uses the extracted module and kept everything else', () => {
  // The extraction must not have changed what that script does: it still only
  // runs inside Workers Builds, still refuses to guess an environment, still
  // resolves the D1 id by name, and still folds the target environment into the
  // top level for a bare `wrangler deploy`.
  const src = readFileSync(new URL('../scripts/prepare-deploy-config.mjs', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/lib\/preserve-vars\.mjs'/, 'it must use the extracted module, not a second copy');
  assert.ok(!/async function liveVars/.test(src), 'the old private copy is gone, so the two cannot drift');
  assert.match(src, /if \(!inWorkersBuilds\) process\.exit\(0\)/, 'it still does nothing outside Workers Builds');
  assert.match(src, /Refusing to guess which database this Worker should bind to/, 'it still refuses an ambiguous environment');
  assert.match(src, /wrangler', 'd1', 'list', '--json'/, 'it still resolves the D1 id by name');
  // `images` joined the fold list when server-side WebP conversion landed: it
  // is a NON-INHERITABLE wrangler key, so an environment folded without it
  // deploys a Worker where `env.IMAGES` is undefined and every upload quietly
  // stops being converted. The list IS the contract between wrangler.jsonc's
  // environments and the bare `wrangler deploy` this build ends with.
  assert.match(src, /for \(const key of \['name', 'd1_databases', 'r2_buckets', 'images', 'vars', 'assets', 'observability', 'triggers'\]\)/, 'it still folds the target environment into the top level, now including images');
  assert.match(src, /mergeVars\(cfg\.vars, live, fromEnv\)/, 'the merge is the shared one');
});
