/**
 * The one shape every probe answers with, so `svc-probes.yml` can collect
 * eleven answers with one `jq` expression and paste them into ADR-017.
 *
 * `verdict` is the line that goes in the table. `detail` is everything the
 * next reader will wish had been recorded — headers, counts, timings — because
 * a probe is run once, by the owner, at a gate, and re-running it costs
 * another gate.
 */
export interface Verdict {
  /** The ADR-017 row this Worker answers: 'a' … 'k'. */
  row: string;
  /** The question, verbatim from ADR-017, so the answer is never orphaned. */
  question: string;
  /** yes | no | partial | inconclusive — never left to the reader to infer. */
  answer: 'yes' | 'no' | 'partial' | 'inconclusive';
  /** One line for the table. */
  verdict: string;
  detail?: Record<string, unknown>;
}

export const json = (v: Verdict, status = 200): Response =>
  new Response(JSON.stringify(v, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Never let a probe fail silently: an exception IS a verdict. */
export const caught = (row: string, question: string, e: unknown): Verdict => ({
  row,
  question,
  answer: 'no',
  verdict: `threw: ${e instanceof Error ? e.message : String(e)}`,
  detail: { error: e instanceof Error ? e.stack?.split('\n').slice(0, 3).join(' | ') : String(e) },
});
