/**
 * THE ONLY ENTRY POINTS A ROUTE USES (push B plan §6.7).
 *
 *   aiReady(env, task, who?)               may the task run now? (./readiness.ts)
 *   readiness(env, viewer)                 the readiness answer (./readiness.ts)
 *   runUnderstand(env, input, who, deps?)  a customer's free text → raw JSON or null
 *   runVision(env, jpegs, source, deps?)   checked JPEGs → raw JSON or null
 *   runSpeech(env, base64, bytes, deps?)   one voice note → raw transcript object or null
 *
 * `null` always means basic mode, whatever the reason. The raw value is
 * `unknown` on purpose: it goes straight to the pure validators
 * (worker/lib/assist/ai/validate.ts) and is never shown, stored or logged.
 *
 * `runTask` is the one loop behind all three (§6.7):
 *   1. the 30 s memo (./config.ts); no 0210 tables → basic, before any write;
 *   2. the master switch (the owner's admin Test alone may run while it is off);
 *   3. for each model rank, 0 then 1: the provider must be reachable, the
 *      rates present, the circuit closed, one call's worst case within a
 *      tenth of the cap; then the RESERVATION (./budget.ts), then the call
 *      under a deadline shared across ranks (understand 4 s, vision and
 *      speech 10 s), then settle + health through `waitUntil` (awaited when
 *      there is none, as in tests), then ONE log line (./log.ts);
 *   4. rank 1 runs only after TIMEOUT, NETWORK, OVERLOADED, RATE_LIMITED,
 *      HTTP_5XX or MODEL_GONE and with at least 2 s left; a refusal, a
 *      truncation, invalid output, a bad input, a rejected key or an empty
 *      quota goes straight to basic. No retries inside a rank.
 */
import type { Env } from '../types';
import type { Locale } from '../assist/types';
import { anthropicStructured } from './providers/anthropic';
import { workersAiTranscribe } from './providers/workersAi';
import { loadAiState, noteCircuitOpen, noteModelGone } from './config';
import { MAX_OUTPUT_TOKENS, costMicro, estimateInputTokens, hasRequiredRates, perCallLimitMicro, reserve, settle, utcDay, worstCaseMicro } from './budget';
import { markModelGone, recordHealth } from './health';
import { FRAME_LIMITS, PHOTO_LIMITS, checkJpeg, imageTokens } from './jpeg';
import { logAiCall } from './log';
import { UNDERSTAND_SYSTEM, VISION_SYSTEM, understandUserText, visionUserText } from './prompts';
import { PHOTO_SCHEMA, READING_SCHEMA } from './schemas';
import { providerAvailable } from './readiness';
import { NO_USAGE, TASK_PROVIDER, type AiConfig, type AiTask, type Deps, type FailCode, type Outcome, type ProviderResult, type TaskModel, type Usage } from './types';

export { aiReady, readiness } from './readiness';
export type { Deps } from './types';

export const DEADLINE_MS: Readonly<Record<AiTask, number>> = { understand: 4_000, vision: 10_000, speech: 10_000 };
export const MIN_FALLBACK_MS = 2_000;
export const FALLBACK_CODES: ReadonlySet<FailCode> = new Set(['TIMEOUT', 'NETWORK', 'OVERLOADED', 'RATE_LIMITED', 'HTTP_5XX', 'MODEL_GONE']);

/** Photo and frame limits (§5.2, §5.3), defined beside the JPEG check. */
export { PHOTO_LIMITS, FRAME_LIMITS } from './jpeg';
/** A voice note the ledger may send: 1.5 MB (§5.4). */
export const SPEECH_MAX_BYTES = 1_500_000;

/** Letters only Sorani writes; an Arabic-script text holding one is Sorani (§5.1 step 3). */
export const SORANI_ONLY = /[ڕڵۆێەڤڎ]/;

/**
 * `c.executionCtx` throws in Hono when there is none (tests, a second entry
 * point). The routes pass `later(c)` as `waitUntil`, which is then either
 * the request's own `waitUntil` or undefined (and the bookkeeping is awaited).
 */
export function later(c: { readonly executionCtx: { waitUntil(p: Promise<unknown>): void } }): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    if (!ctx || typeof ctx.waitUntil !== 'function') return undefined;
    return (p) => ctx.waitUntil(p);
  } catch {
    return undefined;
  }
}

/** What `runTask` did. `value` is the provider's raw answer, only when `ok`. */
export interface TaskOutcome {
  ok: boolean;
  code: Outcome;
  value: unknown;
  /** Wall time of the whole task, ranks included. */
  ms: number;
  /** What the calls were charged (actual cost, or the reservation when none came back). */
  costMicro: number;
  /** How many provider calls were made (0, 1 or 2). */
  calls: number;
}

/** One task's request, built by `understandSpec` / `visionSpec` / `speechSpec`. */
export interface TaskSpec {
  task: AiTask;
  guest: boolean;
  /** A refusal before anything is reserved (the Sorani switch), or null. */
  precheck?: (cfg: AiConfig) => FailCode | null;
  estimate: (m: TaskModel) => { inputTokens: number; maxTokens: number; speechMs?: number };
  call: (m: TaskModel, signal: AbortSignal) => Promise<ProviderResult<unknown>>;
}

export interface RunOptions {
  /** The owner's admin Test: runs while the switch is off or the circuit open (still budgeted and recorded). */
  adminTest?: boolean;
  /** The admin Test of a model id not saved yet (a manual speech id): used instead of the saved rows. */
  models?: TaskModel[];
}

const hasUsage = (u: Usage | undefined): u is Usage =>
  !!u && u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens + u.speechMs > 0;

export async function runTask(env: Env, spec: TaskSpec, deps: Deps = {}, opts: RunOptions = {}): Promise<TaskOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const done = (code: Outcome, extra: Partial<TaskOutcome> = {}): TaskOutcome => ({
    ok: code === 'OK',
    code,
    value: null,
    ms: Math.max(0, now() - started),
    costMicro: 0,
    calls: 0,
    ...extra,
  });

  const state = await loadAiState(env.DB, started);
  if (!state) return done('NOT_CONFIGURED');
  const cfg = state.config;
  if (!cfg.enabled && !opts.adminTest) return done('DISABLED');
  if (spec.guest && (spec.task !== 'understand' || !cfg.guests)) return done('DISABLED');
  const pre = spec.precheck?.(cfg) ?? null;
  if (pre) return done(pre);
  const provider = TASK_PROVIDER[spec.task];
  if (!providerAvailable(env, provider)) return done('NOT_CONFIGURED');
  const circuitOpenNow = () => {
    const until = state.openUntil[provider];
    return !opts.adminTest && until !== undefined && until > now();
  };
  if (circuitOpenNow()) return done('CIRCUIT');
  const candidates = (opts.models ?? cfg.models[spec.task]).filter((m) => m.task === spec.task && m.provider === provider);
  if (candidates.length === 0) return done('NOT_CONFIGURED');

  const deadline = started + DEADLINE_MS[spec.task];
  let last: Outcome = 'NOT_CONFIGURED';
  let mayFallBack = true;
  let charged = 0;
  let calls = 0;

  for (const m of candidates) {
    if (!mayFallBack) break;
    if (calls > 0 && deadline - now() < MIN_FALLBACK_MS) break;
    if (calls > 0 && circuitOpenNow()) {
      last = 'CIRCUIT';
      break;
    }
    if (!hasRequiredRates(m)) {
      last = 'NO_RATES';
      continue; // nothing was called: the next row may still run
    }
    const worst = worstCaseMicro(m, spec.estimate(m));
    if (worst <= 0 || worst > perCallLimitMicro(cfg.capMicro)) {
      last = 'BUDGET';
      continue;
    }
    const day = utcDay(now());
    if (!(await reserve(env.DB, day, worst, cfg, spec.guest))) {
      last = 'BUDGET';
      break; // the day is spent: a cheaper row would only nibble at a cap that already said no
    }

    const t0 = now();
    const remaining = deadline - t0;
    let result: ProviderResult<unknown>;
    if (remaining <= 0) {
      result = { ok: false, code: 'TIMEOUT' };
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        result = await spec.call(m, controller.signal);
      } catch {
        result = { ok: false, code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
      } finally {
        clearTimeout(timer);
      }
    }
    calls++;
    const ms = Math.max(0, now() - t0);
    const outcome: Outcome = result.ok ? 'OK' : result.code;
    const usage = result.usage;
    // A timeout, or an answer with no usage (or a speech answer with no duration), is charged the
    // whole reservation: the provider may have billed what it never reported.
    const cost = outcome !== 'TIMEOUT' && hasUsage(usage) && (spec.task !== 'speech' || usage.speechMs > 0) ? costMicro(m.rates, usage) : worst;
    charged += cost;

    if (outcome === 'MODEL_GONE' && !opts.models) noteModelGone(env.DB, spec.task, m.rank);
    const bookkeeping = async () => {
      await settle(env.DB, day, worst, spec.guest, {
        task: spec.task,
        rank: m.rank,
        provider,
        modelId: m.modelId,
        outcome,
        guest: spec.guest,
        usage: usage ?? { ...NO_USAGE },
        costMicro: cost,
        latencyMs: ms,
      });
      const openedUntil = await recordHealth(env.DB, provider, outcome, now());
      if (openedUntil !== null) noteCircuitOpen(env.DB, provider, openedUntil);
      if (outcome === 'MODEL_GONE' && !opts.models) await markModelGone(env.DB, spec.task, m.rank, m.modelId);
    };
    if (deps.waitUntil) deps.waitUntil(bookkeeping());
    else await bookkeeping();

    logAiCall({
      task: spec.task,
      provider,
      outcome,
      ms,
      tin: usage?.inputTokens ?? 0,
      tout: usage?.outputTokens ?? 0,
      sec: (usage?.speechMs ?? 0) / 1000,
      cost,
    });

    if (result.ok) return done('OK', { value: result.value, costMicro: charged, calls });
    last = outcome;
    mayFallBack = FALLBACK_CODES.has(result.code);
  }
  return done(last, { costMicro: charged, calls });
}

// ------------------------------------------------------------------ the three tasks

/** A customer's free text (already redacted) → the understanding request. */
export function understandSpec(
  env: Env,
  input: { text: string; locale: Locale; stage?: string; printer?: string },
  who: { guest: boolean },
  deps: Deps = {}
): TaskSpec {
  const userText = understandUserText({ message: input.text, stage: input.stage, printer: input.printer });
  const inputTokens = estimateInputTokens(UNDERSTAND_SYSTEM, userText);
  return {
    task: 'understand',
    guest: who.guest,
    // I10: Sorani text reaches a model only when the owner turned that on.
    precheck: (cfg) => ((input.locale === 'ckb' || SORANI_ONLY.test(input.text)) && !cfg.understandCkb ? 'DISABLED' : null),
    estimate: () => ({ inputTokens, maxTokens: MAX_OUTPUT_TOKENS }),
    call: (m, signal) =>
      anthropicStructured(
        env,
        m.modelId,
        { system: UNDERSTAND_SYSTEM, userText, schema: READING_SCHEMA, maxTokens: MAX_OUTPUT_TOKENS, effortLow: m.effortLow, signal },
        deps.transport
      ),
  };
}

/** Checked JPEGs → the vision request, or null when a picture fails the limits (BAD_INPUT, no call). */
export function visionSpec(env: Env, jpegs: Uint8Array[], source: 'photo' | 'clip', deps: Deps = {}): TaskSpec | null {
  const limits = source === 'clip' ? FRAME_LIMITS : PHOTO_LIMITS;
  if (jpegs.length < limits.min || jpegs.length > limits.max) return null;
  const tokens: number[] = [];
  for (const b of jpegs) {
    const dims = checkJpeg(b, limits.maxSide, limits.maxBytes);
    if (!dims) return null;
    tokens.push(imageTokens(dims.width, dims.height));
  }
  const userText = visionUserText(source, jpegs.length);
  const inputTokens = estimateInputTokens(VISION_SYSTEM, userText, tokens);
  return {
    task: 'vision',
    guest: false,
    estimate: () => ({ inputTokens, maxTokens: MAX_OUTPUT_TOKENS }),
    call: (m, signal) =>
      anthropicStructured(
        env,
        m.modelId,
        { system: VISION_SYSTEM, userText, jpegs, schema: PHOTO_SCHEMA, maxTokens: MAX_OUTPUT_TOKENS, effortLow: m.effortLow, signal },
        deps.transport
      ),
  };
}

/** One voice note → the speech request, or null when it is over the byte cap. */
export function speechSpec(env: Env, base64: string, bytes: number): TaskSpec | null {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > SPEECH_MAX_BYTES || !base64) return null;
  return {
    task: 'speech',
    guest: false,
    estimate: () => ({ inputTokens: 0, maxTokens: 0 }),
    call: (m, signal) => workersAiTranscribe(env, m.modelId, base64, signal),
  };
}

export async function runUnderstand(
  env: Env,
  input: { text: string; locale: Locale; stage?: string; printer?: string },
  who: { guest: boolean },
  deps: Deps = {}
): Promise<unknown | null> {
  try {
    const out = await runTask(env, understandSpec(env, input, who, deps), deps);
    return out.ok ? out.value : null;
  } catch {
    return null;
  }
}

export async function runVision(env: Env, jpegs: Uint8Array[], source: 'photo' | 'clip', deps: Deps = {}): Promise<unknown | null> {
  try {
    const spec = visionSpec(env, jpegs, source, deps);
    if (!spec) return null;
    const out = await runTask(env, spec, deps);
    return out.ok ? out.value : null;
  } catch {
    return null;
  }
}

export async function runSpeech(env: Env, base64: string, bytes: number, deps: Deps = {}): Promise<unknown | null> {
  try {
    const spec = speechSpec(env, base64, bytes);
    if (!spec) return null;
    const out = await runTask(env, spec, deps);
    return out.ok ? out.value : null;
  } catch {
    return null;
  }
}
