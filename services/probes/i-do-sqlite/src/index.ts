import { DurableObject } from 'cloudflare:workers';
import { caught, json, type Verdict } from '../../verdict';

const QUESTION = '`wrangler deploy` creates a SQLite Durable Object class with the current token';

interface Env {
  PROBE_DO: DurableObjectNamespace<ProbeCounter>;
}

/**
 * ADR-017 (i). Every realtime and locking adapter in `01-TARGET.md` §7 (and the
 * `WALLET_LOCK`, `STOCK`, `CHAT_ROOM`, `PRESENCE`, `RateLimitCounter` classes of
 * D22) assumes that declaring `migrations[].new_sqlite_classes` and deploying is
 * enough — no dashboard action, no new token scope. If that is wrong, the
 * adapters stay on their D1/cron interims, which is exactly why they were
 * written as adapters.
 *
 * The class stores one counter in DO SQLite, so the answer covers both halves:
 * the class was created AND its storage works.
 */
export class ProbeCounter extends DurableObject {
  async bump(): Promise<number> {
    const current = ((await this.ctx.storage.get<number>('n')) ?? 0) + 1;
    await this.ctx.storage.put('n', current);
    return current;
  }
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    try {
      const stub = env.PROBE_DO.get(env.PROBE_DO.idFromName('probe'));
      const first = await stub.bump();
      const second = await stub.bump();
      const v: Verdict = {
        row: 'i',
        question: QUESTION,
        answer: second === first + 1 ? 'yes' : 'partial',
        verdict: `the SQLite DO class exists and its storage persists across calls (${first} → ${second})`,
        detail: { first, second },
      };
      return json(v);
    } catch (e) {
      return json(caught('i', QUESTION, e));
    }
  },
};
