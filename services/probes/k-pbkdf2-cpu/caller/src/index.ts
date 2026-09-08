import { caught, json, type Verdict } from '../../../verdict';

const QUESTION = 'PBKDF2 CPU time when the core runs UNDER a service binding';

interface Env {
  HASHER?: { hash(iterations: number): Promise<{ ms: number; iterations: number }> };
  PBKDF2_ITERATIONS?: string;
}

/** ADR-017 (k), the caller half: the same work, measured across the hop. */
export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    if (!env.HASHER) {
      return json({ row: 'k', question: QUESTION, answer: 'inconclusive', verdict: 'the HASHER binding is absent — deploy levonis-probe-cpu first' });
    }
    const iterations = Number(env.PBKDF2_ITERATIONS ?? '100000');
    try {
      const started = Date.now();
      const inner = await env.HASHER.hash(iterations);
      const round = Date.now() - started;
      const v: Verdict = {
        row: 'k',
        question: QUESTION,
        answer: 'yes',
        verdict: `${inner.ms} ms of hashing inside the callee, ${round} ms round trip through the binding (${iterations} iterations)`,
        detail: { iterations, callee_ms: inner.ms, round_trip_ms: round, hop_overhead_ms: round - inner.ms },
      };
      return json(v);
    } catch (e) {
      return json(caught('k', QUESTION, e));
    }
  },
};
