import { caught, json, type Verdict } from '../../verdict';

const QUESTION = 'Subrequest and D1-statement budget of one full pump invocation';

interface Env {
  /** Optional: bound to the DARK database only, and only ever read from. */
  PROBE_DB?: D1Database;
  MAX_SUBREQUESTS?: string;
  MAX_STATEMENTS?: string;
}

/**
 * ADR-017 (e). ADR-005's pump budgets (`pumpIds`, the fan-out per event, the
 * one-statement delivery state) are guesses until this runs. The measurement is
 * "how many before the runtime refuses", so the loop is deliberately allowed to
 * fail and the FAILING number is the answer.
 *
 * It only ever reads (`SELECT 1`): a budget probe that wrote rows would leave
 * them behind in the database it was measuring.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const origin = new URL(request.url).origin;
      const maxSub = Number(env.MAX_SUBREQUESTS ?? '80');
      const maxStmt = Number(env.MAX_STATEMENTS ?? '400');

      let subrequests = 0;
      let subrequestError: string | null = null;
      for (let i = 0; i < maxSub; i++) {
        try {
          await fetch(`${origin}/ping?i=${i}`);
          subrequests++;
        } catch (e) {
          subrequestError = e instanceof Error ? e.message : String(e);
          break;
        }
      }

      let statements = 0;
      let statementError: string | null = null;
      let batched = 0;
      if (env.PROBE_DB) {
        for (let i = 0; i < maxStmt; i++) {
          try {
            await env.PROBE_DB.prepare('SELECT 1').first();
            statements++;
          } catch (e) {
            statementError = e instanceof Error ? e.message : String(e);
            break;
          }
        }
        try {
          // A batch is what the outbox pump actually issues; whether it counts
          // as one statement or many is the number ADR-005 needs.
          const stmts = Array.from({ length: 50 }, () => env.PROBE_DB!.prepare('SELECT 1'));
          await env.PROBE_DB.batch(stmts);
          batched = 50;
        } catch (e) {
          statementError ??= `batch(50): ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const v: Verdict = {
        row: 'e',
        question: QUESTION,
        answer: subrequestError || statementError ? 'partial' : 'yes',
        verdict:
          `${subrequests} subrequests` +
          (subrequestError ? ` then refused (${subrequestError})` : ` with no refusal at the ${maxSub} tried`) +
          (env.PROBE_DB
            ? `; ${statements} single D1 reads` + (statementError ? ` then refused (${statementError})` : '') + `; batch(50) ${batched ? 'accepted' : 'refused'}`
            : '; no database bound, so the D1 half was not measured'),
        detail: { subrequests, subrequestError, statements, statementError, batched, tried: { maxSub, maxStmt } },
      };
      return json(v);
    } catch (e) {
      return json(caught('e', QUESTION, e));
    }
  },
};
