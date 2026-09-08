import { WorkerEntrypoint } from 'cloudflare:workers';
import { caught, json, type Verdict } from '../../verdict';

const QUESTION = 'PBKDF2 CPU time when the core runs UNDER a service binding';

interface Env {
  PBKDF2_ITERATIONS?: string;
}

/**
 * ADR-017 (k). Sign-in hashes a password with PBKDF2. Today that happens in a
 * Worker reached directly; from Phase 3 it happens in a Worker reached through
 * the gateway's service binding, and a CPU limit that is per-INVOCATION would
 * then be shared with the gateway's own work. If the number is close to the
 * limit, `limits.cpu_ms` goes on the core (a schema key) before the cut-over
 * rather than after the first 1102.
 *
 * Measured on BOTH sides: `hash()` over the binding (what Phase 3 looks like)
 * and `GET /` directly (today's baseline), so the delta is the answer rather
 * than one absolute number nobody can compare.
 */
async function pbkdf2(iterations: number): Promise<number> {
  const started = Date.now();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('probe-password'), 'PBKDF2', false, ['deriveBits']);
  await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('probe-salt'), iterations }, key, 256);
  return Date.now() - started;
}

export class HashEntrypoint extends WorkerEntrypoint<Env> {
  async hash(iterations: number): Promise<{ ms: number; iterations: number }> {
    return { ms: await pbkdf2(iterations), iterations };
  }
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    const iterations = Number(this.env.PBKDF2_ITERATIONS ?? '100000');
    try {
      const direct = await pbkdf2(iterations);
      const v: Verdict = {
        row: 'k',
        question: QUESTION,
        answer: 'partial',
        verdict: `${direct} ms wall for ${iterations} PBKDF2 iterations reached DIRECTLY — the caller Worker reports the same call over a binding`,
        detail: { iterations, direct_ms: direct, note: 'levonis-probe-cpu-caller measures the same work on the far side of a service binding' },
      };
      return json(v);
    } catch (e) {
      return json(caught('k', QUESTION, e));
    }
  }
}
