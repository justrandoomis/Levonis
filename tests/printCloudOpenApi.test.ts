/**
 * LEVONIS PRINT CLOUD — the OpenAPI document IS the routers: every route the
 * three routers register is documented, and every documented operation is
 * registered, with the same method and path. A route added without its
 * documentation (or documentation left behind by a removed route) fails here.
 * It also pins the documented access class of the money and cost doors to the
 * guards the routes actually wear.
 *
 * Run: node --import tsx --test tests/printCloudOpenApi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { ROOT } from './fixtures/d1';
import { printCloudRoutes } from '../worker/routes/printCloud';
import { printCloudAgentRoutes } from '../worker/routes/printCloudAgent';
import { adminPrintCloudRoutes } from '../worker/routes/printCloudAdmin';
import { BASE_PATHS, OPERATIONS, openApiDocument } from '../worker/lib/printCloud/openapi';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registered = (router: Hono<any>) =>
  new Set(
    router.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/'}`)
  );

test('every Print Cloud route is documented, and every documented route exists', () => {
  const routers = { customer: printCloudRoutes, agent: printCloudAgentRoutes, admin: adminPrintCloudRoutes };
  for (const [base, router] of Object.entries(routers)) {
    const routes = registered(router);
    const documented = new Set(OPERATIONS.filter((o) => o.base === base).map((o) => `${o.method} ${o.path}`));
    assert.deepEqual([...routes].filter((r) => !documented.has(r)).sort(), [], `${base}: registered but undocumented`);
    assert.deepEqual([...documented].filter((d) => !routes.has(d)).sort(), [], `${base}: documented but not registered`);
  }
});

test('the document is valid in shape: unique operation ids, every $ref resolves, idempotent doors name their header', () => {
  const doc = openApiDocument();
  const ids = new Set<string>();
  const refs: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    assert.ok(Object.values(BASE_PATHS).some((b) => path.startsWith(b)), path);
    for (const op of Object.values(item) as Array<Record<string, unknown>>) {
      assert.ok(!ids.has(String(op.operationId)), `duplicate ${op.operationId}`);
      ids.add(String(op.operationId));
      JSON.stringify(op, (k, v) => (k === '$ref' ? (refs.push(v as string), v) : v));
    }
  }
  JSON.stringify(doc.components.schemas, (k, v) => (k === '$ref' ? (refs.push(v as string), v) : v));
  for (const r of refs) {
    const name = r.replace('#/components/schemas/', '');
    assert.ok(name in doc.components.schemas, `unresolved ${r}`);
  }
  for (const op of OPERATIONS.filter((o) => o.idempotent)) {
    const params = (doc.paths[`${BASE_PATHS[op.base]}${op.path}`] as Record<string, { parameters?: Array<{ name: string }> }>)[op.method].parameters ?? [];
    assert.ok(params.some((p) => p.name === 'Idempotency-Key'), `${op.path} documents its Idempotency-Key`);
  }
});

test('documented money and cost doors wear the matching guard in the source', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/printCloudAdmin.ts'), 'utf8');
  for (const op of OPERATIONS.filter((o) => o.base === 'admin')) {
    const hono = op.path.replace(/\{(\w+)\}/g, ':$1');
    const re = new RegExp(`adminPrintCloudRoutes\\.${op.method}\\('${hono.replace(/[/.]/g, '\\$&')}',([^\\n]*)`);
    const line = re.exec(src)?.[1] ?? '';
    if (op.access === 'admin_money') assert.match(line, /requireFinancialScope/, `${op.method.toUpperCase()} ${op.path} is documented as money`);
    if (op.access === 'admin_cost') assert.match(line, /requireCost(Read|Write)/, `${op.method.toUpperCase()} ${op.path} is documented as cost`);
    if (op.access === 'admin_op') assert.doesNotMatch(line, /requireFinancialScope|requireCost(Read|Write)/, `${op.method.toUpperCase()} ${op.path} is documented as op`);
  }
});

test('the document names an owner-only cost field to the owner alone', () => {
  const costProps = (doc: ReturnType<typeof openApiDocument>) =>
    Object.entries(doc.components.schemas).flatMap(([name, schema]) =>
      Object.keys((schema as { properties?: Record<string, unknown> }).properties ?? {})
        .filter((p) => /cost/.test(p))
        .map((p) => `${name}.${p}`)
    );
  assert.deepEqual(costProps(openApiDocument()), [], 'the public document');
  assert.deepEqual(costProps(openApiDocument({ withCost: true })).sort(), [
    'LotCostRequest.total_cost_iqd',
    'MaintenanceRequest.cost_iqd',
    'MaintenanceUpdate.cost_iqd',
    'ReceiveRequest.total_cost_iqd',
  ]);
});
