import { caught, json, type Verdict } from '../../verdict';

const QUESTION = 'Workflows: the `sleepUntil` ceiling, and whether sleeping instances count toward concurrency';

interface Env {
  PROBE_WORKFLOW?: {
    create(options: { params?: unknown }): Promise<{ id: string }>;
    get(id: string): Promise<{ status(): Promise<unknown> }>;
  };
}

/**
 * ADR-017 (h) — the OPTIONAL probe. `01-TARGET.md` §8 puts every long-running
 * process (`CHECKOUT_SAGA` recovery, `KYC_REVIEW`, `IMPORT_APPLY`,
 * `POINTS_RELEASE`, `WITHDRAWAL_LIFECYCLE`, `ESCROW_AUTOCOMPLETE`,
 * `SUBSCRIPTION_LIFECYCLE`) behind an adapter whose interim is the kit's
 * `CronSweepRunner`. Whether a Workflow may sleep for a week — and whether a
 * thousand sleeping instances occupy a thousand concurrency slots — decides
 * whether the adapter's Workflow implementation is ever worth switching on.
 *
 * It is deployed only with the `include_optional` input, because it is the one
 * probe that declares a binding class (a Workflow) rather than measuring the
 * platform with nothing but a fetch.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.PROBE_WORKFLOW) {
      return json({ row: 'h', question: QUESTION, answer: 'inconclusive', verdict: 'no workflows binding was deployed (this probe is opt-in)' });
    }
    try {
      const url = new URL(request.url);
      const seconds = Number(url.searchParams.get('sleep') ?? '60');
      const instance = await env.PROBE_WORKFLOW.create({ params: { sleepSeconds: seconds } });
      const v: Verdict = {
        row: 'h',
        question: QUESTION,
        answer: 'partial',
        verdict: `an instance sleeping ${seconds}s was created (${instance.id}) — read its status, and create many to see whether sleepers occupy concurrency`,
        detail: { instance_id: instance.id, sleep_seconds: seconds, next: 'GET /?sleep=604800 for the week-long ceiling' },
      };
      return json(v);
    } catch (e) {
      return json(caught('h', QUESTION, e));
    }
  },
};

export { ProbeSleepWorkflow } from './workflow';
