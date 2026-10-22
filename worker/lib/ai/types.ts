/**
 * THE SHAPES OF THE ASSISTANT'S AI LAYER (push B plan §6.5).
 *
 * worker/lib/ai is the only code that does I/O to a model provider. It never
 * imports the assistant's dictionaries or `tr`, and it never builds a reply
 * text: a provider answer leaves this folder as `unknown`, and the pure
 * validators in worker/lib/assist/ai turn it into closed-set values or into
 * nothing (basic mode).
 *
 * No model is named anywhere in the repository (the repository is public):
 * every model id is a D1 row the owner chose in admin from the provider's own
 * live list (migration 0210, `ai_task_models`).
 */
export const AI_TASKS = ['understand', 'vision', 'speech'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const PROVIDER_KINDS = ['anthropic', 'workers_ai'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Each task runs on one provider in push B (plan §0): text and vision on one, speech on the other. */
export const TASK_PROVIDER: Record<AiTask, ProviderKind> = { understand: 'anthropic', vision: 'anthropic', speech: 'workers_ai' };

export const FAIL_CODES = [
  'NOT_CONFIGURED',
  'DISABLED',
  'NO_RATES',
  'BUDGET',
  'LIMITED',
  'CIRCUIT',
  'TIMEOUT',
  'NETWORK',
  'REDIRECT_REFUSED',
  'KEY_REJECTED',
  'QUOTA',
  'RATE_LIMITED',
  'OVERLOADED',
  'MODEL_GONE',
  'TOO_LARGE',
  'HTTP_4XX',
  'HTTP_5XX',
  'REFUSAL',
  'TRUNCATED',
  'BAD_OUTPUT',
  'BAD_INPUT',
] as const;
export type FailCode = (typeof FAIL_CODES)[number];
/** What `ai_usage.outcome` and the log line carry: `OK` or a code, never a message. */
export type Outcome = FailCode | 'OK';
export const isFailCode = (v: unknown): v is FailCode => typeof v === 'string' && (FAIL_CODES as readonly string[]).includes(v);

/** Owner-entered prices, integer micro-USD: per million tokens, or per minute of audio. */
export interface Rates {
  inPerMTok: number;
  outPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  speechPerMinute: number;
}

/** One `ai_task_models` row as the runtime reads it. A row marked gone is never loaded. */
export interface TaskModel {
  task: AiTask;
  rank: 0 | 1;
  provider: ProviderKind;
  modelId: string;
  rates: Rates;
  effortLow: boolean;
}

export interface AiConfig {
  version: number;
  enabled: boolean;
  capMicro: number;
  guests: boolean;
  guestSharePct: number;
  understandCkb: boolean;
  /** Ordered by rank; a task with no row runs in basic mode. */
  models: Record<AiTask, TaskModel[]>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  speechMs: number;
}
export const NO_USAGE: Usage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, speechMs: 0 });

export type ProviderResult<T> = { ok: true; value: T; usage: Usage } | { ok: false; code: FailCode; usage?: Usage };

/** One structured-output request, provider-neutral. */
export interface StructuredRequest {
  system: string;
  userText: string;
  /** Already metadata-stripped and checked (./jpeg.ts). */
  jpegs?: Uint8Array[];
  schema: object;
  maxTokens: number;
  effortLow: boolean;
  signal: AbortSignal;
}

/** The one way a provider is reached over HTTP: injectable, so tests never touch the network. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** One model from a provider's live list, as the admin dropdown shows it. */
export interface ListedModel {
  id: string;
  label: string;
  effortLow: boolean;
}

/** One `ai_usage` row: codes and counts only, never text, user or address. */
export interface LedgerRow {
  task: AiTask;
  rank: 0 | 1;
  provider: ProviderKind;
  modelId: string;
  outcome: Outcome;
  guest: boolean;
  usage: Usage;
  costMicro: number;
  latencyMs: number;
}

/**
 * What GET /api/support/assistant/readiness answers (plan §5.5). Flags and
 * company names only: never a model id, a cost, the cap or a rate.
 */
export interface Readiness {
  mode: 'basic' | 'ai';
  text: boolean;
  photo: boolean;
  clip: boolean;
  voice: boolean;
  voice_locales: Array<'ar' | 'en'>;
  photo_provider: 'anthropic' | null;
  voice_provider: 'cloudflare' | null;
}

/** Injected by tests; the routes pass `later(c)` as `waitUntil`. */
export interface Deps {
  transport?: Transport;
  now?: () => number;
  waitUntil?: (p: Promise<unknown>) => void;
}
