/**
 * THE DARK STACK MUST BE BRINGABLE UP FROM NOTHING.
 *
 * `verify-dark.yml` is the gated G1 rollout, and its job graph is a claim about
 * an ORDER: which Workers must exist before which others can be deployed. The
 * Workers upload API rejects a `services` binding whose target Worker does not
 * exist, so a job that binds a Worker a LATER job creates cannot deploy that
 * binding — `scripts/resolve-ids.mjs` strips it, and something has to put it
 * back afterwards.
 *
 * This file reads the graph and every dark `services` block and holds the two
 * together, because the failure it guards against is invisible until the
 * workflow is actually run on a clean account, behind an owner gate, once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './lib/wrangler';
import { listServices } from './lib/boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

interface Job {
  name: string;
  needs: string[];
  service: string | null;
}

/** The job graph of a workflow: name, `needs`, and the service each job deploys. */
function jobsOf(file: string): Job[] {
  const src = readFileSync(join(WORKFLOWS, file), 'utf8');
  const body = src.slice(src.indexOf('\njobs:'));
  const out: Job[] = [];
  const blocks = [...body.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):$/gm)];
  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i].index!;
    const end = i + 1 < blocks.length ? blocks[i + 1].index! : body.length;
    const block = body.slice(start, end);
    const needsLine = /^\s*needs:\s*(.+)$/m.exec(block);
    const needs = needsLine
      ? needsLine[1].replace(/[[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean)
      : [];
    const svc = /(?:^|[\s{,])service:\s*'?([a-z-]+)'?/m.exec(block);
    out.push({ name: blocks[i][1], needs, service: svc ? svc[1] : null });
  }
  return out;
}

/** Every Worker name a job's service binds in its `env.dark` block. */
function darkServiceTargets(service: string): string[] {
  const cfg = parseJsonc(readFileSync(join(ROOT, 'services', service, 'wrangler.jsonc'), 'utf8')) as {
    env?: { dark?: { services?: Array<{ service: string }> } };
  };
  return (cfg.env?.dark?.services ?? []).map((s) => s.service);
}

/** The Worker name a dark job creates, as its own config declares it. */
function darkWorkerName(service: string): string {
  if (service === 'core') {
    const cfg = parseJsonc(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')) as { env?: { dark?: { name?: string } } };
    return cfg.env?.dark?.name ?? '';
  }
  const cfg = parseJsonc(readFileSync(join(ROOT, 'services', service, 'wrangler.jsonc'), 'utf8')) as { env?: { dark?: { name?: string } } };
  return cfg.env?.dark?.name ?? '';
}

test('every dark binding target is deployed by verify-dark before the binder, or the binder is re-deployed after it', () => {
  const jobs = jobsOf('verify-dark.yml');
  const byName = new Map(jobs.map((j) => [j.name, j]));

  /** Transitive `needs` closure — everything guaranteed to have run first. */
  const before = (job: Job, seen = new Set<string>()): Set<string> => {
    for (const n of job.needs) {
      if (seen.has(n)) continue;
      seen.add(n);
      const parent = byName.get(n);
      if (parent) before(parent, seen);
    }
    return seen;
  };

  const problems: string[] = [];
  for (const job of jobs) {
    if (!job.service || job.service === 'core') continue;
    const targets = darkServiceTargets(job.service);
    if (targets.length === 0) continue;
    const earlier = new Set([...before(job)].map((n) => byName.get(n)?.service).filter(Boolean).map((s) => darkWorkerName(s as string)));
    for (const target of targets) {
      if (earlier.has(target)) continue;
      // Not deployed first — then a LATER job must re-deploy this service once
      // the target exists, or the binding is lost for the life of the stack.
      const rebound = jobs.some((j) => j.service === job.service && j !== job && [...before(j)].some((n) => darkWorkerName(byName.get(n)?.service ?? '') === target));
      if (!rebound) {
        problems.push(`${job.name} (services/${job.service}) binds ${target}, which no earlier job creates and no later job rebinds`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('resolve-ids --full re-checks the account instead of restoring bindings blind', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'resolve-ids.mjs'), 'utf8');
  // The account check must not be behind `!full`: the second pass has to look
  // again, or it produces a deploy the upload API refuses for the same reason
  // the first one did.
  assert.ok(!/if\s*\(!full\s*&&/.test(src), '--full must still consult deployedWorkers()');
  assert.match(src, /restored=\$\{restored\.length\}/, 'the second pass reports whether anything was actually restored');

  const wf = readFileSync(join(WORKFLOWS, '_deploy-worker.yml'), 'utf8');
  assert.match(wf, /steps\.ids2\.outputs\.restored != '0'/, 'the redeploy is conditional on something having been restored');
});

test('no dark service binds a Worker that no wrangler config in the tree creates', () => {
  const declared = new Set<string>();
  for (const svc of [...listServices(ROOT), 'core']) {
    const name = darkWorkerName(svc);
    if (name) declared.add(name);
  }
  const dangling: string[] = [];
  for (const svc of listServices(ROOT)) {
    for (const target of darkServiceTargets(svc)) {
      if (!declared.has(target)) dangling.push(`services/${svc} binds ${target}, which nothing in the tree declares`);
    }
  }
  assert.deepEqual(dangling, [], dangling.join('\n'));
});
