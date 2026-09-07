/**
 * Long-running processes behind an adapter (`01-TARGET.md` §8, ADR-008):
 * `ProcessRunner.start(name, input)` records the intent; `CronSweepRunner`
 * (today) writes the row the owning table's sweep works from — and stays the
 * design for per-row schedules with thousands of concurrent waits;
 * `WorkflowRunner` calls `env.<WF>.create({id, params})` when Workflows are
 * approved. The same step functions serve both.
 */
export interface ProcessRunner {
  start(name: string, input: { id: string; params: Record<string, unknown>; dueAt?: string }): Promise<{ id: string; mode: 'cron' | 'workflow' }>;
}

/** What the sweep needs from the owning table: an idempotent "record the intent" statement. */
export type IntentRecorder = (name: string, input: { id: string; params: Record<string, unknown>; dueAt?: string }) => Promise<void>;

export class CronSweepRunner implements ProcessRunner {
  constructor(private readonly record: IntentRecorder) {}
  async start(name: string, input: { id: string; params: Record<string, unknown>; dueAt?: string }) {
    await this.record(name, input);
    return { id: input.id, mode: 'cron' as const };
  }
}

/** The Workflow binding shape (`workflows: [{ binding, name, class_name }]`). */
export interface WorkflowBindingLike {
  create(options: { id: string; params: Record<string, unknown> }): Promise<unknown>;
}

export class WorkflowRunner implements ProcessRunner {
  constructor(private readonly bindings: Partial<Record<string, WorkflowBindingLike>>, private readonly fallback: ProcessRunner) {}
  async start(name: string, input: { id: string; params: Record<string, unknown>; dueAt?: string }) {
    const wf = this.bindings[name];
    if (!wf) return this.fallback.start(name, input);
    await wf.create({ id: input.id, params: { ...input.params, dueAt: input.dueAt ?? null } });
    return { id: input.id, mode: 'workflow' as const };
  }
}

/**
 * The core's 13-step cron dissolves step by step: a step listed in
 * `LEGACY_DISABLED_STEPS` (comma-separated indexes or names) no longer runs
 * in the core because its owner has taken it. Nothing runs twice.
 */
export function disabledSteps(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function stepEnabled(step: { index: number; name: string }, disabled: Set<string>): boolean {
  return !disabled.has(String(step.index)) && !disabled.has(step.name);
}

/** From G2 the core's trigger is per minute; the legacy steps keep their 15-minute cadence by modulo. */
export function legacyStepDue(minuteOfHour: number, cadenceMinutes = 15): boolean {
  return minuteOfHour % cadenceMinutes === 0;
}
