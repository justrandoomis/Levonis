/**
 * THE WRITE SWEEP — owner decision 2, critique A3 (brief 1 §31, §42), step S1.
 *
 * tests/costRoleMatrix.test.ts walks every GET. The routes that touch cost
 * INTERNALLY are writes: a receipt writes a lot at its unit cost, a count and
 * a transfer move lots, a template parse and apply carry the stored cost
 * forward, a grid bulk preview compares against the cost (leak L4 was exactly
 * that), a product save re-reads the whole document. None of their answers —
 * success or refusal, `details` included — was leak-checked.
 *
 * This file calls every POST, PUT, PATCH and DELETE of the base mounts as every
 * role of tests/fixtures/roleMatrix.ts on its own throwaway database: once
 * with an empty body (the invalid body, which walks every validation refusal)
 * and once more with the route's own VALID body from tests/routeClass/*.ts —
 * built, where the screen does it that way, from what the same caller just
 * read. Every answer is walked with `leaks()`.
 *
 * Run: node --import tsx --test tests/costRoleMatrixWrites.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './fixtures/d1';
import { ROLES, sweepWrites, writeRoutes, type RoleName, type WriteBodies } from './fixtures/roleMatrix';
import { ruleOf, type RouteClassFile } from './routeClass/_types';

const ADMINS: ReadonlySet<RoleName> = new Set(['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant']);

async function bodies(): Promise<WriteBodies> {
  const dir = join(ROOT, 'tests/routeClass');
  const out: Record<string, { body: unknown; path?: string } | { noBody: string; path?: string }> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.startsWith('_'))) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default: RouteClassFile };
    for (const m of mod.default.mounts) {
      for (const [route, spec] of Object.entries(m.routes)) {
        const [method, path] = route.split(' ') as [string, string];
        if (method === 'GET') continue;
        const rule = ruleOf(spec);
        const k = `${method} ${m.prefix}${path === '/' ? '' : path}`;
        if (rule.body !== undefined) out[k] = { body: rule.body, path: rule.path };
        else if (rule.path) out[k] = { noBody: rule.noBody ?? m.writes ?? rule.cls, path: rule.path };
      }
    }
  }
  return out;
}

test('the write sweep reaches every write route, and the valid bodies are wired to them', async () => {
  const all = writeRoutes();
  assert.ok(all.length > 300, `only ${all.length} write routes`);
  const b = await bodies();
  const keys = new Set(all.map((r) => r.key));
  const orphan = Object.keys(b).filter((k) => !keys.has(k));
  assert.deepEqual(orphan, [], 'a classified body names a route the sweep does not mount');
  assert.ok(Object.values(b).filter((x) => 'body' in x).length >= 25);
});

for (const role of Object.keys(ROLES) as RoleName[]) {
  test(`no write answer to ${role} — success or refusal — carries a cost`, async () => {
    const result = (await sweepWrites({ roles: { [role]: ROLES[role] }, bodies: await bodies() }))[role]!;
    assert.ok(result.called > 300, `only ${result.called} calls made`);
    // The valid bodies must reach the SUCCESS path for the admins, or the sweep
    // walks refusals only: about 25 writes succeed on the empty body alone, and
    // the bodies add some 17 more in the sweep's order (each one is accepted in
    // isolation — tests/costRouteClassification.test.ts).
    if (ADMINS.has(role)) assert.ok(result.succeeded >= 40, `only ${result.succeeded} writes succeeded for ${role}`);
    assert.deepEqual(result.leaks, [], `cost reached ${role} through a write:\n${result.leaks.join('\n')}`);
    assert.deepEqual(result.timedOut, [], `writes that hung for ${role}`);
  });
}
