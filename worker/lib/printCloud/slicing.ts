/**
 * THE SLICING ADAPTER LAYER (docs/PRINT_CLOUD.md §7.2).
 *
 * No slicer runs in this Worker, and none ever runs in a public request: a
 * real slicer is a native program with printer profiles. Two adapters feed
 * MEASURED figures in, and both are labelled with their provenance:
 *
 *   agent     the workshop agent runs an installed slicer CLI (OrcaSlicer,
 *             Bambu Studio, PrusaSlicer — whichever the workshop installs)
 *             with the workshop's real printer and filament profiles. It
 *             CLAIMS a request under a lease, downloads the job's files
 *             through its job-scoped door, and posts the figures (or a
 *             failure). A lease that runs out returns the request to the
 *             queue; three failed claims fail it and the customer is told.
 *   operator  a person slices on a workstation and enters the figures the
 *             desktop slicer reported (provenance 'operator').
 *
 * With neither available, a job waits in `analyzing` and says
 * `awaiting_slicer`. An estimate is never synthesised from geometry.
 */
import { many, one, fence, runBatch } from './db';
import { pcError } from './errors';
import { loadJob, recordEstimate, slicingFailed, type EstimateInput } from './jobs';
import { agentCan, type AgentRow } from './printers';
import { addSeconds, iso, pcId } from './util';

export const SLICING_LEASE_SECONDS = 10 * 60;
export const SLICING_MAX_ATTEMPTS = 3;

export interface SlicingRequestRow {
  id: string;
  job_id: string;
  status: string;
  input_json: string;
  claimed_by: string | null;
  lease_until: string | null;
  attempts: number;
}

/** Claim the oldest waiting request (or one whose lease ran out) for this agent. */
export async function claimSlicing(db: D1Database, agent: AgentRow, now: Date) {
  const candidate = await one<SlicingRequestRow>(
    db,
    `SELECT id, job_id, status, input_json, claimed_by, lease_until, attempts FROM pc_slicing_requests
      WHERE (status = 'queued' OR (status = 'claimed' AND lease_until < ?)) AND attempts < ?
      ORDER BY created_at, id LIMIT 1`,
    iso(now),
    SLICING_MAX_ATTEMPTS
  );
  if (!candidate) return null;
  const token = pcId('tok');
  const lease = iso(addSeconds(now, SLICING_LEASE_SECONDS));
  await runBatch(db, [
    db
      .prepare(
        `UPDATE pc_slicing_requests SET status = 'claimed', claimed_by = ?, claimed_at = ?, lease_until = ?, attempts = attempts + 1, error_code = ?, updated_at = ?
          WHERE id = ? AND attempts = ? AND (status = 'queued' OR (status = 'claimed' AND lease_until < ?))`
      )
      .bind(agent.id, iso(now), lease, token, iso(now), candidate.id, candidate.attempts, iso(now)),
    fence(db, 'STATE_CHANGED', '(SELECT error_code FROM pc_slicing_requests WHERE id = ?) = ?', [candidate.id, token]),
    db.prepare('UPDATE pc_slicing_requests SET error_code = NULL WHERE id = ?').bind(candidate.id),
  ]);
  const input = JSON.parse(candidate.input_json) as { models: Array<{ file_id: string }> };
  return {
    slicing_request_id: candidate.id,
    job_id: candidate.job_id,
    lease_until: lease,
    input,
    files: [...new Set(input.models.map((m) => m.file_id))].map((id) => ({ file_id: id, path: `/api/print-cloud/v1/agent/files/${id}` })),
  };
}

async function claimedBy(db: D1Database, agent: AgentRow, requestId: string): Promise<SlicingRequestRow> {
  const r = await one<SlicingRequestRow>(
    db,
    'SELECT id, job_id, status, input_json, claimed_by, lease_until, attempts FROM pc_slicing_requests WHERE id = ?',
    requestId
  );
  if (!r || r.claimed_by !== agent.id) throw pcError('NOT_FOUND');
  if (r.status !== 'claimed') throw pcError('STATE_CHANGED', { status: r.status });
  return r;
}

export async function submitSlicingResult(db: D1Database, agent: AgentRow, requestId: string, estimate: EstimateInput, now: Date) {
  const r = await claimedBy(db, agent, requestId);
  const job = await loadJob(db, r.job_id);
  return recordEstimate(db, job, estimate, {
    provenance: 'slicer',
    submittedBy: agent.id,
    actor: { type: 'agent', id: agent.id },
    slicingRequestId: r.id,
    now,
  });
}

export async function submitSlicingFailure(db: D1Database, agent: AgentRow, requestId: string, errorCode: string, now: Date) {
  await claimedBy(db, agent, requestId);
  await slicingFailed(db, requestId, errorCode, { type: 'agent', id: agent.id }, now);
}

/** Leases that ran out: back to the queue, or — after the last attempt — failed and the customer told. */
export async function sweepSlicingLeases(db: D1Database, now: Date, unitFits?: () => boolean) {
  const expired = await many<SlicingRequestRow>(
    db,
    "SELECT id, job_id, status, input_json, claimed_by, lease_until, attempts FROM pc_slicing_requests WHERE status = 'claimed' AND lease_until < ? LIMIT 50",
    iso(now)
  );
  let requeued = 0;
  let failed = 0;
  for (const r of expired) {
    if (unitFits && !unitFits()) return { requeued, failed, more: true };
    if (r.attempts >= SLICING_MAX_ATTEMPTS) {
      await slicingFailed(db, r.id, 'SLICER_LEASE_EXPIRED', { type: 'system', id: 'system' }, now).catch(() => undefined);
      failed++;
    } else {
      await db
        .prepare("UPDATE pc_slicing_requests SET status = 'queued', claimed_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'claimed' AND lease_until < ?")
        .bind(iso(now), r.id, iso(now))
        .run();
      requeued++;
    }
  }
  return { requeued, failed, more: expired.length === 50 };
}

/**
 * May this agent download this file? Only for a job it is slicing (holding
 * the claim, with the `slicer` capability) or printing (a job on one of its
 * printers, with `job_control`). A token scoped to telemetry or the camera
 * reads no customer's model, whatever its printers are running.
 */
export async function agentMayReadFile(db: D1Database, agent: AgentRow, fileId: string): Promise<boolean> {
  const branches: string[] = [];
  const params: string[] = [];
  if (agentCan(agent, 'slicer')) {
    branches.push(`(SELECT COUNT(*) FROM pc_slicing_requests r JOIN pc_print_jobs j ON j.id = r.job_id
          JOIN pc_project_models m ON m.project_id = j.project_id
         WHERE r.claimed_by = ? AND r.status = 'claimed' AND m.file_id = ?)`);
    params.push(agent.id, fileId);
  }
  if (agentCan(agent, 'job_control')) {
    branches.push(`(SELECT COUNT(*) FROM pc_printer_assignments a JOIN pc_printers p ON p.id = a.printer_id
          JOIN pc_print_jobs j ON j.id = a.job_id JOIN pc_project_models m ON m.project_id = j.project_id
         WHERE p.agent_id = ? AND a.state = 'active' AND m.file_id = ?)`);
    params.push(agent.id, fileId);
  }
  if (!branches.length) return false;
  const row = await one<{ n: number }>(db, `SELECT ${branches.join(' + ')} AS n`, ...params);
  return Number(row?.n ?? 0) > 0;
}
