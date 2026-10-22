/**
 * FAKES FOR THE ASSISTANT AI LAYER'S TESTS (push B). Nothing here reaches a
 * network or a provider: the text/vision provider is an injected `Transport`
 * that records every request, and the speech binding is a plain object with
 * `run` and `models`.
 *
 * No model is named: every model id here is an invented, neutral string.
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb } from './app';
import { forgetAiConfig } from '../../worker/lib/ai/config';
import type { Transport } from '../../worker/lib/ai/types';

export const TEXT_MODEL = 'test-text-model-a';
export const TEXT_MODEL_B = 'test-text-model-b';
export const SPEECH_MODEL = 'test/speech-model-a';
export const KEY = 'test-provider-key-0123456789';

export interface SeedModel {
  task: 'understand' | 'vision' | 'speech';
  rank: 0 | 1;
  model_id: string;
  inR?: number;
  outR?: number;
  cwR?: number;
  crR?: number;
  minR?: number;
  effort_low?: 0 | 1;
  gone?: 0 | 1;
}

export interface SeedOpts {
  enabled?: boolean;
  capMicro?: number;
  guests?: boolean;
  guestSharePct?: number;
  understandCkb?: boolean;
  models?: SeedModel[];
}

const PROVIDER_OF = { understand: 'anthropic', vision: 'anthropic', speech: 'workers_ai' } as const;

/** A fresh, fully migrated database with the AI settings and model rows a test needs. */
export function aiDb(opts: SeedOpts = {}): { raw: DatabaseSync; db: D1Database } {
  const raw = freshDb();
  seedAi(raw, opts);
  const db = asD1(raw);
  forgetAiConfig();
  return { raw, db };
}

export function seedAi(raw: DatabaseSync, opts: SeedOpts = {}): void {
  raw
    .prepare('UPDATE ai_settings SET enabled = ?, daily_cap_micro_usd = ?, guests = ?, guest_share_pct = ?, understand_ckb = ? WHERE id = 1')
    .run(opts.enabled === false ? 0 : 1, opts.capMicro ?? 1_000_000, opts.guests ? 1 : 0, opts.guestSharePct ?? 25, opts.understandCkb ? 1 : 0);
  for (const m of opts.models ?? []) {
    raw
      .prepare(
        `INSERT INTO ai_task_models (task, rank, provider, model_id, in_micro_per_mtok, out_micro_per_mtok, cache_write_micro_per_mtok,
                                     cache_read_micro_per_mtok, speech_micro_per_minute, effort_low, gone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(m.task, m.rank, PROVIDER_OF[m.task], m.model_id, m.inR ?? 0, m.outR ?? 0, m.cwR ?? 0, m.crR ?? 0, m.minR ?? 0, m.effort_low ?? 0, m.gone ?? 0);
  }
}

/** Cheap text rates: $1 / $5 per MTok in micro-USD. */
export const textModel = (task: 'understand' | 'vision', rank: 0 | 1, model_id = rank === 0 ? TEXT_MODEL : TEXT_MODEL_B): SeedModel => ({
  task,
  rank,
  model_id,
  inR: 1_000_000,
  outR: 5_000_000,
});
export const speechModel = (rank: 0 | 1 = 0, model_id = SPEECH_MODEL): SeedModel => ({ task: 'speech', rank, model_id, minR: 6_000 });

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect?: RequestRedirect;
}

/** A transport that records every request and answers with `answer(n, req)`. */
export function recordingTransport(answer: (n: number, req: Recorded) => Response | Promise<Response>): Transport & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const t = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const req: Recorded = { url, method: String(init.method ?? 'GET'), headers, body: typeof init.body === 'string' ? init.body : '', redirect: init.redirect };
    calls.push(req);
    return answer(calls.length, req);
  }) as Transport & { calls: Recorded[] };
  t.calls = calls;
  return t;
}

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A provider message carrying one structured answer. */
export function answer(value: unknown, opts: { stop?: string; usage?: Record<string, number>; extraBlocks?: unknown[]; rawText?: string } = {}) {
  return jsonResponse(200, {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    stop_reason: opts.stop ?? 'end_turn',
    content: [...(opts.extraBlocks ?? []), { type: 'text', text: opts.rawText ?? JSON.stringify(value) }],
    usage: opts.usage ?? { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
}

export const errorResponse = (status: number, type: string) => jsonResponse(status, { type: 'error', error: { type, message: 'provider text that must never be read' } });

/** A valid reading for the understanding schema. */
export const READING_OK = {
  action: 'triage',
  intent: 'none',
  printer: 'a1',
  part: 'none',
  symptom: 'clog',
  outcome: 'none',
  maintenance: false,
  terms: [],
};

/** A fake speech binding. */
export function fakeAi(opts: {
  run?: (model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
  models?: (params?: Record<string, unknown>) => Promise<unknown[]>;
}) {
  const runs: Array<{ model: string; inputs: Record<string, unknown>; options?: { signal?: AbortSignal } }> = [];
  return {
    runs,
    async run(model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }) {
      runs.push({ model, inputs, options });
      if (opts.run) return opts.run(model, inputs, options);
      return { text: 'hello', transcription_info: { language: 'en', duration: 3.2 } };
    },
    async models(params?: Record<string, unknown>) {
      if (opts.models) return opts.models(params);
      return [];
    },
  };
}

/** A minimal valid JPEG: SOI, APP0, SOF0 (w×h), SOS, a scan byte, EOI. Optionally an APP1 and a COM. */
export function tinyJpeg(width = 64, height = 48, opts: { app1?: boolean; com?: boolean } = {}): Uint8Array {
  const seg = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload];
  const bytes = [
    0xff,
    0xd8,
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(opts.app1 ? seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 1, 2, 3, 4]) : []),
    ...(opts.com ? seg(0xfe, [0x68, 0x69]) : []),
    ...seg(0xc0, [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0xff,
    0xd9,
  ];
  return new Uint8Array(bytes);
}

/** A clock a test moves by hand. */
export function clock(start = Date.parse('2026-10-22T10:00:00.000Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
}

/** Let `waitUntil` promises settle. */
export const settleAll = async (ps: Promise<unknown>[]) => {
  await Promise.all(ps.splice(0));
};
