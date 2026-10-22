/**
 * THE ONE LOG LINE A PROVIDER CALL LEAVES (push B plan §10 "Log line", I7).
 *
 *   {"ev":"assist_ai","task":…,"provider":…,"outcome":…,"ms":…,"tin":…,"tout":…,"sec":…,"cost":…}
 *
 * Task, provider kind, outcome code, milliseconds, token and second counts and
 * cost. Never a text, a transcript, an image, base64, a prompt, a key, a
 * provider body or a model id. Built from a closed set of numeric and coded
 * fields, so nothing else can be passed in. Only ./run.ts calls it.
 */
import type { AiTask, Outcome, ProviderKind } from './types';

export interface AiLogLine {
  task: AiTask;
  provider: ProviderKind;
  outcome: Outcome;
  ms: number;
  tin: number;
  tout: number;
  sec: number;
  cost: number;
}

const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export function logAiCall(l: AiLogLine): void {
  console.log(
    JSON.stringify({
      ev: 'assist_ai',
      task: l.task,
      provider: l.provider,
      outcome: l.outcome,
      ms: n(l.ms),
      tin: n(l.tin),
      tout: n(l.tout),
      sec: Math.round(n(l.sec * 10)) / 10,
      cost: n(l.cost),
    })
  );
}
