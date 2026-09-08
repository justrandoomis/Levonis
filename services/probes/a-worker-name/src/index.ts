import { json, type Verdict } from '../../verdict';

/**
 * ADR-017 (a). The Worker's BODY is not the evidence — the DEPLOY is. If
 * `wrangler deploy` created `levonis-probe-name`, the CI token can create a new
 * Worker name and every later slice may deploy its own Worker; if it failed
 * with a permission error, the owner creates each Worker in the dashboard once
 * and the workflows bind by name.
 *
 * So this answers with what it can see of itself, and the workflow records the
 * exit status of the deploy step beside it.
 */
export default {
  fetch(_request: Request, env: { SVC_VERSION?: string }): Response {
    const v: Verdict = {
      row: 'a',
      question: 'The CI token can create a new Worker name',
      answer: 'yes',
      verdict: 'this Worker answered, so `wrangler deploy` created a name that did not exist before',
      detail: { deployed_version: env.SVC_VERSION ?? null },
    };
    return json(v);
  },
};
