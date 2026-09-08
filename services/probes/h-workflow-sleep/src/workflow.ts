/**
 * The instance the probe creates. It does one thing: sleep for as long as it
 * was asked to, so the ceiling is discovered by being refused rather than by
 * reading a number nobody here can reach.
 *
 * Imported dynamically by nothing — `wrangler.jsonc` names this file as the
 * Workflow's `class_name` source through `main`, so it is re-exported there.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

export class ProbeSleepWorkflow extends WorkflowEntrypoint<Record<string, never>, { sleepSeconds: number }> {
  async run(event: WorkflowEvent<{ sleepSeconds: number }>, step: WorkflowStep): Promise<string> {
    const seconds = event.payload?.sleepSeconds ?? 60;
    await step.sleep('probe sleep', `${seconds} seconds`);
    return `slept ${seconds}s`;
  }
}
