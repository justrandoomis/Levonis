import { caught, json, type Verdict } from '../../verdict';

const QUESTION = 'An Analytics Engine dataset is created on the first `writeDataPoint`';

interface Env {
  PROBE_AE?: { writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
}

/**
 * ADR-017 (j). `01-TARGET.md` §11.1/§11.4 move counters off Workers Logs and on
 * to Analytics Engine as soon as the dataset binding is deployed — which is
 * only a config switch if the dataset needs no dashboard action. This writes
 * one point and reports whether the call threw; the workflow then queries the
 * dataset once to see whether it exists.
 */
export default {
  fetch(_request: Request, env: Env): Response {
    if (!env.PROBE_AE) {
      return json({ row: 'j', question: QUESTION, answer: 'inconclusive', verdict: 'no analytics_engine_datasets binding was deployed' });
    }
    try {
      env.PROBE_AE.writeDataPoint({ blobs: ['probe'], doubles: [1], indexes: ['probe'] });
      const v: Verdict = {
        row: 'j',
        question: QUESTION,
        answer: 'partial',
        verdict: 'writeDataPoint accepted the point without throwing — query the dataset to confirm it now exists',
        detail: { dataset: 'levonis_probe_ae', next: 'GET /accounts/<id>/analytics_engine/sql  SELECT count() FROM levonis_probe_ae' },
      };
      return json(v);
    } catch (e) {
      return json(caught('j', QUESTION, e));
    }
  },
};
