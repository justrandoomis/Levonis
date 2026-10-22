/**
 * IS A TASK READY, AND WHAT MAY THE CUSTOMER'S SCREEN OFFER (push B plan
 * §5.1 step 1, §5.5, §6.7).
 *
 * A task is ready only when ALL of these hold:
 *   - the 0210 tables exist and the master switch is on;
 *   - the cap is above zero and today's spend plus reservations is below it;
 *   - the task's provider is reachable (the key or the binding is there) and
 *     its circuit is closed;
 *   - a model row exists with the rates the task needs, and one call's
 *     largest possible cost fits within a tenth of the cap.
 * A guest only ever gets text understanding, and only with the guest toggle.
 *
 * Served from the 30 s config memo (./config.ts). NEVER THROWS: any failure
 * reads as basic. The readiness answer carries flags and company names only,
 * never a model id, a cost, the cap or a rate.
 */
import type { Env } from '../types';
import { webpConversionAvailable } from '../imageConvert';
import { anthropicAvailable } from './providers/anthropic';
import { workersAiAvailable } from './providers/workersAi';
import { loadAiState, type AiState } from './config';
import { hasRequiredRates, nominalWorstCaseMicro, perCallLimitMicro } from './budget';
import { UNDERSTAND_SYSTEM, VISION_SYSTEM } from './prompts';
import { TASK_PROVIDER, type AiTask, type ProviderKind, type Readiness, type TaskModel } from './types';

export function providerAvailable(env: Env, provider: ProviderKind): boolean {
  return provider === 'anthropic' ? anthropicAvailable(env) : workersAiAvailable(env);
}

const promptBytes = (task: AiTask): number =>
  task === 'understand'
    ? new TextEncoder().encode(UNDERSTAND_SYSTEM).byteLength
    : task === 'vision'
      ? new TextEncoder().encode(VISION_SYSTEM).byteLength
      : 0;

/** The most one call of this task could cost on this model (the admin's `worst_case_warn` reads the same). */
export function taskWorstCaseMicro(m: TaskModel): number {
  return nominalWorstCaseMicro(m, promptBytes(m.task));
}

/** Can this model row run at all under this cap? */
export function modelRunnable(m: TaskModel, capMicro: number): boolean {
  return hasRequiredRates(m) && taskWorstCaseMicro(m) <= perCallLimitMicro(capMicro);
}

/** The readiness rule over an already-loaded state (pure but for the env's bindings). */
export function taskReadyIn(state: AiState | null, env: Env, task: AiTask, nowMs: number, who: { guest: boolean } = { guest: false }): boolean {
  if (!state) return false;
  const cfg = state.config;
  if (!cfg.enabled || cfg.capMicro <= 0) return false;
  if (who.guest && (task !== 'understand' || !cfg.guests)) return false;
  if (state.today.spentMicro + state.today.reservedMicro >= cfg.capMicro) return false;
  const provider = TASK_PROVIDER[task];
  if (!providerAvailable(env, provider)) return false;
  const open = state.openUntil[provider];
  if (open !== undefined && open > nowMs) return false;
  return cfg.models[task].some((m) => modelRunnable(m, cfg.capMicro));
}

export async function aiReady(env: Env, task: AiTask, who?: { guest: boolean }, nowMs: number = Date.now()): Promise<boolean> {
  try {
    return taskReadyIn(await loadAiState(env.DB, nowMs), env, task, nowMs, who ?? { guest: false });
  } catch {
    return false;
  }
}

export const BASIC_READINESS: Readiness = Object.freeze({
  mode: 'basic',
  text: false,
  photo: false,
  clip: false,
  voice: false,
  voice_locales: ['ar', 'en'],
  photo_provider: null,
  voice_provider: null,
}) as Readiness;

/** GET /api/support/assistant/readiness's body, minus `success` (plan §5.5). */
export async function readiness(env: Env, viewer: { signedIn: boolean }, nowMs: number = Date.now()): Promise<Readiness> {
  try {
    const state = await loadAiState(env.DB, nowMs);
    if (!state) return { ...BASIC_READINESS, voice_locales: ['ar', 'en'] };
    const guest = !viewer.signedIn;
    const understand = taskReadyIn(state, env, 'understand', nowMs, { guest });
    const vision = !guest && taskReadyIn(state, env, 'vision', nowMs);
    const speech = !guest && taskReadyIn(state, env, 'speech', nowMs);
    const photo = vision && webpConversionAvailable(env);
    const flags = { text: understand, photo, clip: vision, voice: speech };
    return {
      mode: flags.text || flags.photo || flags.clip || flags.voice ? 'ai' : 'basic',
      ...flags,
      voice_locales: ['ar', 'en'],
      photo_provider: vision ? 'anthropic' : null,
      voice_provider: speech ? 'cloudflare' : null,
    };
  } catch {
    return { ...BASIC_READINESS, voice_locales: ['ar', 'en'] };
  }
}
