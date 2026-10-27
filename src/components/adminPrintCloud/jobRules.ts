/**
 * WHICH OPERATOR ACTION A JOB OFFERS, BY ITS STATE.
 *
 * The server's state machine (`TRANSITIONS` in worker/lib/printCloud/jobs.ts)
 * and its doors decide what may happen to a job; a button the server would
 * refuse is a button that lies. So each action names the state it moves the
 * job to, and it is offered only from the states whose door accepts it:
 *
 *   approve, reject     confirmed (approveJob; the reject route checks it)
 *   estimate            analyzing (recordEstimate)
 *   assign              queued (assignJob)
 *   unassign, start     preparing (unassignJob, startJob)
 *   pause               printing
 *   resume              paused
 *   complete, verify    printing (completeJob)
 *   fail                preparing, printing, paused (failJob)
 *   cancel              every state whose transitions include `cancelled`
 *   priority            confirmed, queued (setPriority) — not a transition
 *
 * tests/printCloudAdminUi.test.ts checks every offered move against
 * `TRANSITIONS`. Pure data, no React.
 */

export type JobAction =
  | 'approve'
  | 'reject'
  | 'estimate'
  | 'assign'
  | 'unassign'
  | 'start'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'verify'
  | 'fail'
  | 'cancel'
  | 'priority';

/** The state each action moves the job to; `priority` moves nothing. */
export const ACTION_TARGET: Readonly<Record<JobAction, string | null>> = {
  approve: 'queued',
  reject: 'cancelled',
  estimate: 'ready',
  assign: 'preparing',
  unassign: 'queued',
  start: 'printing',
  pause: 'paused',
  resume: 'printing',
  complete: 'completed',
  verify: 'completed',
  fail: 'failed',
  cancel: 'cancelled',
  priority: null,
};

export const JOB_ACTIONS: Readonly<Record<string, readonly JobAction[]>> = {
  draft: ['cancel'],
  uploaded: ['cancel'],
  analyzing: ['estimate', 'cancel'],
  ready: ['cancel'],
  awaiting_confirmation: ['cancel'],
  confirmed: ['approve', 'reject', 'priority', 'cancel'],
  queued: ['assign', 'priority', 'cancel'],
  preparing: ['start', 'unassign', 'fail', 'cancel'],
  printing: ['complete', 'verify', 'pause', 'fail'],
  paused: ['resume', 'fail'],
  completed: [],
  failed: [],
  cancelled: [],
  reprint_requested: [],
};

/** Actions that lose work or money and are asked twice. */
export const DESTRUCTIVE: ReadonlySet<JobAction> = new Set(['reject', 'cancel', 'fail', 'unassign']);

/** The actions a job in `status` offers (`verify` only when an agent report waits). */
export function actionsFor(status: string, pendingReport: boolean): JobAction[] {
  return (JOB_ACTIONS[status] ?? []).filter((a) => a !== 'verify' || pendingReport);
}

/** A shipment's moves an operator may make (fulfillment.ts `SHIPMENT_TRANSITIONS` and `advanceFrom`). */
export function shipmentMoves(status: string, kind: string): string[] {
  switch (status) {
    // Paid through its fee order only; cancelling closes the unpaid fee order with it.
    case 'awaiting_payment':
      return ['cancelled'];
    case 'preparing':
      return [kind === 'pickup' ? 'ready_for_pickup' : 'shipped', 'cancelled'];
    case 'ready_for_pickup':
      return ['picked_up', 'cancelled'];
    case 'shipped':
      return ['delivered'];
    default:
      return [];
  }
}
