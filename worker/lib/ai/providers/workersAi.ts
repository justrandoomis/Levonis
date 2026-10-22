/**
 * THE SPEECH PROVIDER (push B plan §6.6, §7 "Workers AI speech").
 *
 * THE ONLY READER OF `env.AI` (tests/aiSingleReaders.test.ts). The binding is
 * optional (B0 declared it on the live Worker only); everything else asks
 * `workersAiAvailable(env)`.
 *
 * The call is `env.AI.run(modelId, { audio: base64 }, { signal })` and
 * NOTHING ELSE is sent: in particular no `language`, because a forced language
 * would turn a Sorani note into plausible Arabic. The model id is the owner's
 * D1 row; no model and no model path is named in this repository.
 *
 * A thrown binding error is mapped to a code from its numeric error code
 * only (a field, or the four digits its message starts with; §7 table); the
 * message itself is never logged, stored or returned.
 */
import type { Env } from '../../types';
import { MODEL_ID_SHAPE } from './anthropic';
import { NO_USAGE, type FailCode, type ListedModel, type ProviderResult } from '../types';

/** The two calls this module makes, typed loosely on purpose: the model is a runtime choice. */
interface SpeechBinding {
  run(model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  models(params?: Record<string, unknown>): Promise<unknown[]>;
}

const binding = (env: Env): SpeechBinding | null => {
  const ai = env.AI as unknown as Partial<SpeechBinding> | undefined;
  return ai && typeof ai.run === 'function' ? (ai as SpeechBinding) : null;
};

export function workersAiAvailable(env: Env): boolean {
  return binding(env) !== null;
}

/** The numeric code a binding error carries, read from its fields, or from its message's digits only. */
function numericCodeOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  for (const k of ['code', 'status', 'errorCode']) {
    const v = Number(o[k]);
    if (Number.isInteger(v) && v >= 100 && v <= 99999) return v;
  }
  const msg = typeof o.message === 'string' ? o.message : '';
  const m = /\b(3\d{3}|5\d{3}|4\d{2})\b/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** A thrown binding error → a code (§7 "Workers AI speech" table). */
export function codeOfAiError(e: unknown, signal: AbortSignal): FailCode {
  if (signal.aborted) return 'TIMEOUT';
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'TIMEOUT';
  switch (numericCodeOf(e)) {
    case 3007:
    case 3008:
      return 'TIMEOUT';
    case 3040:
      return 'OVERLOADED';
    case 3036:
      return 'QUOTA';
    case 5007:
      return 'MODEL_GONE';
    case 3006:
    case 413:
      return 'TOO_LARGE';
    case 5035:
      return 'KEY_REJECTED';
    case 5004:
    case 400:
      return 'BAD_INPUT';
    case null:
      return 'NETWORK';
    default:
      return 'HTTP_5XX';
  }
}

/** Seconds of audio the provider reports, as milliseconds; 0 when absent. */
export function speechMsOf(raw: unknown): number {
  const info = raw && typeof raw === 'object' ? (raw as { transcription_info?: unknown }).transcription_info : undefined;
  const d = info && typeof info === 'object' ? Number((info as { duration?: unknown }).duration) : NaN;
  return Number.isFinite(d) && d > 0 ? Math.ceil(d * 1000) : 0;
}

export async function workersAiTranscribe(env: Env, modelId: string, base64: string, signal: AbortSignal): Promise<ProviderResult<unknown>> {
  const ai = binding(env);
  if (!ai) return { ok: false, code: 'NOT_CONFIGURED' };
  if (!MODEL_ID_SHAPE.test(modelId)) return { ok: false, code: 'NOT_CONFIGURED' };
  if (signal.aborted) return { ok: false, code: 'TIMEOUT' };
  let raw: unknown;
  try {
    // The binding is raced against the deadline as well: a binding that ignores the signal still
    // cannot hold the turn past it.
    raw = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('deadline'), { name: 'AbortError' }));
      signal.addEventListener('abort', onAbort, { once: true });
      ai.run(modelId, { audio: base64 }, { signal }).then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        }
      );
    });
  } catch (e) {
    return { ok: false, code: codeOfAiError(e, signal) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'BAD_OUTPUT' };
  return { ok: true, value: raw, usage: { ...NO_USAGE, speechMs: speechMsOf(raw) } };
}

/** The binding's live list of speech-recognition models; null when `models()` throws or is absent. */
export async function workersAiListSpeechModels(env: Env): Promise<ListedModel[] | null> {
  const ai = binding(env);
  if (!ai || typeof ai.models !== 'function') return null;
  const out: ListedModel[] = [];
  const seen = new Set<string>();
  try {
    for (let page = 1; page <= 3; page++) {
      const rows = await ai.models({ per_page: 100, page });
      if (!Array.isArray(rows)) return null;
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const m = r as { name?: unknown; task?: { name?: unknown } };
        const taskName = typeof m.task?.name === 'string' ? m.task.name : '';
        if (!/speech recognition/i.test(taskName)) continue;
        // The id `run()` takes is the model's name; the label is the same text.
        if (typeof m.name !== 'string' || !MODEL_ID_SHAPE.test(m.name) || seen.has(m.name)) continue;
        seen.add(m.name);
        out.push({ id: m.name, label: m.name, effortLow: false });
      }
      if (rows.length < 100) break;
    }
  } catch {
    return null;
  }
  return out;
}
