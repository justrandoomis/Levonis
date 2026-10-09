/**
 * THE DATABASE'S PRICING REFUSALS, AS A 409 A PERSON CAN READ (migration 0181;
 * USD design §10 "Registries").
 *
 * The pricing triggers refuse with `RAISE(ABORT, '<CODE>')`: a lot cost that
 * would change, an IQD conversion snapshot rewritten without the owner's
 * token, an input or rule re-inserted instead of edited, a price written on an
 * engine-priced product outside the engine's batch, a mode flip without its
 * token, an input changed on an engine product without a fresh preview, an
 * order line's engine snapshot touched after insert. Each of those can be met
 * by a real request — an older deployed commit, a legacy price screen, a race
 * — and the answer must say what happened in the viewer's language, not a
 * generic 500. The client renders by CODE (`COST_REFUSALS` in ar, en, ckb);
 * the message carries no value, id or SQL.
 *
 * Only these codes cross. Anything else stays the generic 500 of
 * `worker/index.ts`, and the raw driver text never reaches a client.
 */
import { serverMessage, type CostRefusalCode } from '@levonis/contracts/costRefusals';
import { HttpError } from './http';

export const ENGINE_DB_REFUSALS = [
  'BATCH_COST_IMMUTABLE',
  'FX_SNAPSHOT_IMMUTABLE',
  'PRICING_INPUT_REINSERT',
  'ENGINE_MANAGED',
  'PRICING_MODE_ENGINE_ONLY',
  'PRICING_PREVIEW_REQUIRED',
  'ORDER_SNAPSHOT_IMMUTABLE',
] as const satisfies readonly CostRefusalCode[];

export type EngineDbRefusalCode = (typeof ENGINE_DB_REFUSALS)[number];

/** Every message an error carries, its cause's included (D1 wraps the SQLite text). */
function messagesOf(err: unknown, depth = 0): string[] {
  if (depth > 3 || err == null) return [];
  if (typeof err === 'string') return [err];
  if (typeof err !== 'object') return [];
  const own = typeof (err as { message?: unknown }).message === 'string' ? [(err as { message: string }).message] : [];
  return [...own, ...messagesOf((err as { cause?: unknown }).cause, depth + 1)];
}

/** The code of a pricing trigger's refusal inside a database error, or null. Whole-word: ENGINE_MANAGED never matches ENGINE_MANAGED_PRICES_KEPT. */
export function engineDbRefusalCode(err: unknown): EngineDbRefusalCode | null {
  if (err instanceof HttpError) return null;
  const text = messagesOf(err).join('\n');
  if (!text) return null;
  for (const code of ENGINE_DB_REFUSALS) if (new RegExp(`(^|[^A-Z0-9_])${code}([^A-Z0-9_]|$)`).test(text)) return code;
  return null;
}

/** The 409 for a pricing trigger's refusal, or null when the error is something else. */
export function engineDbRefusal(err: unknown): HttpError | null {
  const code = engineDbRefusalCode(err);
  return code ? new HttpError(409, serverMessage(code), code) : null;
}
