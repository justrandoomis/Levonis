import { WorkerEntrypoint } from 'cloudflare:workers';
import { caught, json, type Verdict } from '../../verdict';

const QUESTION = 'A Worker can bind to its OWN named entrypoint (self-binding RPC)';

interface Env {
  /** Bound to THIS Worker, entrypoint `ProbeEntrypoint`. */
  SELF?: { ping(n: number): Promise<{ pong: number; from: string }> };
}

/**
 * ADR-017 (c). This is the fact ADR-004 rests on: a merged deployable
 * (Catalog, Commerce, Ledger, Marketplace) hosts several packages that call
 * each other through the SAME Worker's named entrypoints, so that splitting one
 * out later is a wrangler change instead of a code change. If a Worker cannot
 * bind to itself, sibling packages may only share statement descriptors and
 * every command between them becomes a real RPC on the day of the split.
 */
export class ProbeEntrypoint extends WorkerEntrypoint {
  ping(n: number): { pong: number; from: string } {
    return { pong: n + 1, from: 'ProbeEntrypoint' };
  }
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    if (!this.env.SELF) {
      return json({
        row: 'c',
        question: QUESTION,
        answer: 'no',
        verdict: 'the SELF binding is absent — the deploy stripped it, which is itself the answer',
      });
    }
    try {
      const res = await this.env.SELF.ping(41);
      const ok = res?.pong === 42 && res?.from === 'ProbeEntrypoint';
      const v: Verdict = {
        row: 'c',
        question: QUESTION,
        answer: ok ? 'yes' : 'partial',
        verdict: ok
          ? 'a Worker called its own named entrypoint over a service binding and got the answer back'
          : `the call returned something unexpected: ${JSON.stringify(res)}`,
        detail: { response: res },
      };
      return json(v);
    } catch (e) {
      return json(caught('c', QUESTION, e));
    }
  }
}
