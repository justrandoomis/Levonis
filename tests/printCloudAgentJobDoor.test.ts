/**
 * THE AGENT'S JOB DOOR — GET /api/print-cloud/v1/agent/jobs/{id}
 * (docs/PRINT_CLOUD.md §9; worker/routes/printCloudAgent.ts).
 *
 * The file door (`GET /agent/files/{id}`) lets a `job_control` agent download
 * a model of a job it PRINTS — but before this door no agent door named that
 * job's files or settings. An agent that had not sliced the job itself (an
 * operator entered the estimate, or the job is a workshop reprint, which
 * copies its parent's estimate and is never sliced) could not learn what to
 * print. This door states it, read-only, scoped exactly like the file door's
 * printing branch:
 *
 *   - the `job_control` capability (a telemetry-only token: 403);
 *   - only while the job holds a printer bound to THIS agent (a job not yet
 *     on a machine, or on another agent's: 404);
 *   - the job's slicing input (models and their file ids, settings, plate,
 *     materials), its status and printer, and the file door paths — nothing
 *     about the customer, and reading it changes nothing.
 *
 * Run: node --import tsx --test tests/printCloudAgentJobDoor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctx } from './fixtures/app';
import { ADMIN, AGENT, API, buy, call, estimatedJob, idem, ok, pcWorld, refused, row, seedCatalog, type Json } from './fixtures/printCloud';

const H = 3600;

test('GET /agent/jobs/{id}: with job_control, only a job on one of the agent\'s printers — its input and file doors, read-only', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const printer = cat.printers[0];
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Bay 1', capabilities: ['telemetry', 'job_control'] });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${printer}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: 'lan-1' });
  const bearer = { Authorization: `Bearer ${agent.token}` };
  const telemetryOnly = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Camera', capabilities: ['telemetry'] });
  const otherBay = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Bay 2', capabilities: ['telemetry', 'job_control'] });
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  // An operator's estimate: no agent ever claimed this job's slicing request.
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }] });

  // Not on any machine yet: nothing to say.
  await refused(w.guest, 'GET', `${AGENT}/jobs/${jobId}`, undefined, 'NOT_FOUND', bearer);

  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'))).status, 'queued');
  await ok(w.guest, 'POST', `${AGENT}/printers/${printer}/telemetry`, { machine_state: 'idle', boot: 1, seq: 1 }, bearer);
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: jobId, printer_id: printer }]);

  const before = row<Json>(w, 'SELECT status, op_token, updated_at FROM pc_print_jobs WHERE id = ?', jobId);
  const r = await call(w.guest, 'GET', `${AGENT}/jobs/${jobId}`, undefined, bearer);
  assert.equal(r.status, 200);
  const data = r.json.data;
  assert.deepEqual(Object.keys(data).sort(), ['files', 'input', 'job_id', 'printer_id', 'status']);
  assert.deepEqual([data.job_id, data.status, data.printer_id], [jobId, 'preparing', printer]);
  assert.equal(data.input.printer_model.code, 'BBL-X2D-COMBO');
  assert.equal(data.input.models.length, 1);
  assert.deepEqual(data.input.variants.map((v: Json) => v.variant_id), [cat.white]);
  const fileId = data.input.models[0].file_id;
  assert.deepEqual(data.files, [{ file_id: fileId, path: `${AGENT}/files/${fileId}` }]);
  assert.deepEqual(row<Json>(w, 'SELECT status, op_token, updated_at FROM pc_print_jobs WHERE id = ?', jobId), before, 'reading it changes nothing');
  assert.equal(JSON.stringify(data).includes('usr_pc_a'), false, 'nothing about the customer');

  // The file it names is the one the file door serves to this agent.
  const file = await w.guest.request(data.files[0].path, { headers: { ...bearer, 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(file.status, 200);
  // A token without job_control, and another agent's token, learn nothing.
  await refused(w.guest, 'GET', `${AGENT}/jobs/${jobId}`, undefined, 'FORBIDDEN', { Authorization: `Bearer ${telemetryOnly.token}` });
  await refused(w.guest, 'GET', `${AGENT}/jobs/${jobId}`, undefined, 'NOT_FOUND', { Authorization: `Bearer ${otherBay.token}` });
  await refused(w.guest, 'GET', `${AGENT}/jobs/pcj_does_not_exist`, undefined, 'NOT_FOUND', bearer);

  // Once the job leaves the machine (completed), the door closes again.
  await ok(w.guest, 'POST', `${AGENT}/jobs/${jobId}/events`, { event: 'started', printer_id: printer }, bearer);
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: settings.version, config: { agent_reports_need_verification: false } });
  await ok(w.guest, 'POST', `${AGENT}/jobs/${jobId}/events`, { event: 'completed', printer_id: printer, printed_seconds: H }, bearer);
  await refused(w.guest, 'GET', `${AGENT}/jobs/${jobId}`, undefined, 'NOT_FOUND', bearer);
});
