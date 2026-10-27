/**
 * A STATE, SAID IN WORDS, A DOT AND A TONE — the house StatusChip
 * (src/components/ui/Badge.tsx) with Print Cloud's vocabulary.
 *
 *   <StatusPill kind="job" state="printing" />        «Printing now», success
 *   <StatusPill kind="printer" state="stale" />       «Last report is old», warning
 *
 * Every printer state comes from what the server REPORTED: `stale` is a last
 * reading older than the window, `offline` a machine its agent cannot reach,
 * `unknown` a printer that never reported — never shown as online. The
 * helpers below turn the API's own fields into these states, so every screen
 * says the same thing about the same data.
 */
import { StatusChip, type Tone } from '../../components/ui/Badge';
import { jobStatus, printerStatus } from '../strings/common';
import { useCloudText } from '../text';
import type { JobStatus, JobTelemetry, MachineState } from '../types';

export type JobPillState = JobStatus | 'awaiting_estimate';
export type PrinterPillState = keyof typeof printerStatus;

const JOB_TONE: Record<JobPillState, Tone> = {
  draft: 'neutral',
  uploaded: 'neutral',
  analyzing: 'info',
  awaiting_estimate: 'warning',
  ready: 'info',
  awaiting_confirmation: 'warning',
  confirmed: 'info',
  queued: 'info',
  preparing: 'info',
  printing: 'success',
  paused: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  reprint_requested: 'info',
};

const PRINTER_TONE: Record<PrinterPillState, Tone> = {
  live: 'success',
  stale: 'warning',
  offline: 'neutral',
  idle: 'neutral',
  preparing: 'info',
  printing: 'info',
  paused: 'warning',
  finished: 'neutral',
  error: 'danger',
  maintenance: 'warning',
  available: 'success',
  notFree: 'neutral',
  noMachine: 'neutral',
  unknown: 'neutral',
};

export type StatusPillProps =
  | { kind: 'job'; state: JobPillState; className?: string }
  | { kind: 'printer'; state: PrinterPillState; className?: string };

export function StatusPill(props: StatusPillProps) {
  const { t } = useCloudText();
  if (props.kind === 'job') {
    return (
      <StatusChip tone={JOB_TONE[props.state]} className={props.className}>
        {t(jobStatus[props.state])}
      </StatusChip>
    );
  }
  return (
    <StatusChip tone={PRINTER_TONE[props.state]} className={props.className}>
      {t(printerStatus[props.state])}
    </StatusChip>
  );
}

/**
 * The state a job's pill shows. An analysing job has asked for an estimate
 * and has none yet: «awaiting estimate», the honest name of that wait.
 */
export function jobPillState(status: JobStatus): JobPillState {
  return status === 'analyzing' ? 'awaiting_estimate' : status;
}

/**
 * The state of the machine a job is on, from its telemetry (GET /jobs/{id}):
 * no reading at all → `unknown`; a reading past the window → `stale` (never
 * "live"); a machine its agent cannot reach → `offline`; else what it said.
 */
export function machinePillState(telemetry: JobTelemetry | null | undefined): PrinterPillState {
  if (!telemetry) return 'unknown';
  if (telemetry.stale) return 'stale';
  const state: MachineState = telemetry.machine_state;
  return state in PRINTER_TONE ? (state as PrinterPillState) : 'unknown';
}

/**
 * A printer MODEL's availability from its machine counts (GET /printers,
 * GET /me/printers): free now when the scheduler counts an idle machine;
 * «not free» otherwise — busy, silent, stale or in maintenance, which the
 * counts cannot tell apart, so the pill does not pretend to.
 */
export function modelPillState(machinesActive: number, machinesIdle: number): PrinterPillState {
  if (!machinesActive) return 'noMachine';
  return machinesIdle > 0 ? 'available' : 'notFree';
}
