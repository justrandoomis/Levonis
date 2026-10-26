/**
 * LEVONIS PRINT CLOUD — the WORKSHOP AGENT API, mounted at
 * /api/print-cloud/v1/agent (docs/PRINT_CLOUD.md §9).
 *
 * No cookie, no session: an agent presents `Authorization: Bearer pca_…`,
 * whose SHA-256 is the only thing stored. Every door is scoped to the
 * printers bound to THAT agent; a printer, job, file or slicing request
 * outside its scope answers 404. Printer credentials never pass through here
 * in either direction.
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppContext } from '../lib/types';
import { jsonObject } from '../lib/http';
import { limitRoute } from '../lib/ratelimit';
import { mediaBucket } from '../lib/mediaStorage';
import { many, one } from '../lib/printCloud/db';
import { invalid, pcError } from '../lib/printCloud/errors';
import { ok, pcGate, requestConfig } from '../lib/printCloud/http';
import {
  completeJob,
  failJob,
  loadJob,
  parseConsumption,
  parseEstimate,
  parseFailure,
  pauseJob,
  reportCompletion,
  resumeJob,
  startJob,
  type Actor,
  type JobStatus,
} from '../lib/printCloud/jobs';
import { agentCan, agentPrinter, authenticateAgent, commandsForAgent, ingestTelemetry, parseTelemetry, type AgentRow } from '../lib/printCloud/printers';
import { agentMayReadFile, claimSlicing, submitSlicingFailure, submitSlicingResult } from '../lib/printCloud/slicing';
import { reqString } from '../lib/printCloud/util';

export const printCloudAgentRoutes = new Hono<AppContext>();

const agents = new WeakMap<Request, AgentRow>();

async function requireAgent(c: Context<AppContext>, next: Next) {
  const agent = await authenticateAgent(c.env.DB, c.req.header('Authorization'), new Date());
  if (!agent) throw pcError('AGENT_UNAUTHORIZED');
  agents.set(c.req.raw, agent);
  await next();
}

const agentOf = (c: Context<AppContext>): AgentRow => {
  const a = agents.get(c.req.raw);
  if (!a) throw pcError('AGENT_UNAUTHORIZED');
  return a;
};

printCloudAgentRoutes.use('*', pcGate);
printCloudAgentRoutes.use('*', limitRoute('pc_agent', 20000));
printCloudAgentRoutes.use('*', requireAgent);

printCloudAgentRoutes.get('/printers', async (c) => {
  const agent = agentOf(c);
  return ok(
    c,
    await many(
      c.env.DB,
      `SELECT p.id, p.name, p.model_id, m.code AS model_code, p.status, p.connection_ref, p.nozzle_um, p.ams_slots,
              (SELECT a.job_id FROM pc_printer_assignments a WHERE a.printer_id = p.id AND a.state = 'active') AS current_job_id
         FROM pc_printers p JOIN pc_printer_models m ON m.id = p.model_id WHERE p.agent_id = ? ORDER BY p.name`,
      agent.id
    )
  );
});

printCloudAgentRoutes.post('/printers/:id/telemetry', async (c) => {
  const agent = agentOf(c);
  if (!agentCan(agent, 'telemetry')) throw pcError('FORBIDDEN', { capability: 'telemetry' });
  const { config } = await requestConfig(c);
  const t = parseTelemetry(await jsonObject(c));
  return ok(c, await ingestTelemetry(c.env.DB, agent, c.req.param('id'), t, config.telemetry_stale_seconds, new Date()));
});

const EVENT_TARGET: Record<string, JobStatus> = { started: 'printing', paused: 'paused', resumed: 'printing', completed: 'completed', failed: 'failed' };

/**
 * A job event from the machine. Each one is a state-machine transition; an
 * event re-sent after it was applied answers `already_applied` and changes
 * nothing, so a flaky workshop network cannot start, bill or fail a job twice.
 */
printCloudAgentRoutes.post('/jobs/:id/events', async (c) => {
  const agent = agentOf(c);
  if (!agentCan(agent, 'job_control')) throw pcError('FORBIDDEN', { capability: 'job_control' });
  const body = await jsonObject(c);
  const event = reqString(body.event, 'event', { max: 20 });
  if (!(event in EVENT_TARGET)) throw invalid('event', 'not_allowed');
  const printerId = reqString(body.printer_id, 'printer_id', { max: 120 });
  await agentPrinter(c.env.DB, agent, printerId);
  const job = await loadJob(c.env.DB, c.req.param('id'));
  const assignment = await one<{ printer_id: string }>(c.env.DB, "SELECT printer_id FROM pc_printer_assignments WHERE job_id = ? AND state = 'active'", job.id);
  const target = EVENT_TARGET[event];
  if (job.status === target || (event === 'completed' && job.status === 'completed')) return ok(c, { job_id: job.id, status: job.status, already_applied: true });
  if (!assignment || assignment.printer_id !== printerId) throw pcError('NOT_FOUND', { reason: 'job_not_on_this_printer' });
  const actor: Actor = { type: 'agent', id: agent.id };
  const now = new Date();
  const { config } = await requestConfig(c);
  switch (event) {
    case 'started':
      await startJob(c.env.DB, job, actor, now);
      break;
    case 'paused':
      await pauseJob(c.env.DB, job, actor, now, typeof body.reason === 'string' ? body.reason.slice(0, 200) : 'agent');
      break;
    case 'resumed':
      await resumeJob(c.env.DB, job, actor, now);
      break;
    case 'completed': {
      const consumption = parseConsumption(body);
      if (config.agent_reports_need_verification) return ok(c, await reportCompletion(c.env.DB, job, consumption, actor, now), 202);
      return ok(c, await completeJob(c.env.DB, job, consumption, actor, config, now));
    }
    case 'failed':
      return ok(c, await failJob(c.env.DB, job, parseFailure({ ...body, responsible: 'undetermined' }), actor, now));
  }
  return ok(c, { job_id: job.id, status: target });
});

printCloudAgentRoutes.get('/commands', async (c) => ok(c, await commandsForAgent(c.env.DB, agentOf(c), c.req.query('since') ?? null)));

printCloudAgentRoutes.post('/slicing/claim', async (c) => {
  const agent = agentOf(c);
  if (!agentCan(agent, 'slicer')) throw pcError('FORBIDDEN', { capability: 'slicer' });
  return ok(c, await claimSlicing(c.env.DB, agent, new Date()));
});

printCloudAgentRoutes.post('/slicing/:id/result', async (c) => {
  const agent = agentOf(c);
  if (!agentCan(agent, 'slicer')) throw pcError('FORBIDDEN', { capability: 'slicer' });
  return ok(c, await submitSlicingResult(c.env.DB, agent, c.req.param('id'), parseEstimate(await jsonObject(c)), new Date()));
});

printCloudAgentRoutes.post('/slicing/:id/failure', async (c) => {
  const agent = agentOf(c);
  if (!agentCan(agent, 'slicer')) throw pcError('FORBIDDEN', { capability: 'slicer' });
  const body = await jsonObject(c);
  await submitSlicingFailure(c.env.DB, agent, c.req.param('id'), reqString(body.error_code, 'error_code', { max: 80 }), new Date());
  return ok(c, { slicing_request_id: c.req.param('id'), status: 'failed' });
});

/** The bytes of a file the agent is slicing or printing right now — and no other. */
printCloudAgentRoutes.get('/files/:id', async (c) => {
  const agent = agentOf(c);
  const fileId = c.req.param('id');
  if (!(await agentMayReadFile(c.env.DB, agent, fileId))) throw pcError('NOT_FOUND');
  const f = await one<{ storage_key: string; original_name: string }>(c.env.DB, 'SELECT storage_key, original_name FROM pc_model_files WHERE id = ? AND deleted_at IS NULL', fileId);
  if (!f) throw pcError('NOT_FOUND');
  const obj = await mediaBucket(c.env, 'private').get(f.storage_key);
  if (!obj) throw pcError('NOT_FOUND');
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${f.original_name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});
