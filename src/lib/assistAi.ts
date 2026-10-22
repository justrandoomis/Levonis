/**
 * THE ASSISTANT AI LAYER, BROWSER SIDE (push B1; plan §5.2-§5.5, §12.2, §15).
 *
 * Nothing here reads, writes or names a model. The browser never speaks to a
 * provider (the CSP `connect-src` lists none); it speaks to this origin only,
 * through three doors:
 *
 *   READINESS  GET /api/support/assistant/readiness: what this viewer may use
 *              right now. Anything but a well-formed answer (a 404 before the
 *              server half is deployed, a dropped connection, a malformed
 *              body) reads as BASIC: the push A assistant, unchanged. A task
 *              whose provider the answer does not name is read as off, because
 *              the consent sheet must say where a file goes before it goes.
 *   THE READS  POST /api/support/assistant/read (a photo or a voice note, by
 *              its owned attachment key) and /read-frames (2-4 JPEG frames the
 *              browser took from an owned clip). Every read carries
 *              `consent: true`; the server refuses one without it. A reply is
 *              rendered like any other reply. A transcript goes only into the
 *              composer of the customer, to be read, edited and sent by them:
 *              it is never a bubble, a chip or a reply (plan I1).
 *   CONSENT    sessionStorage `levonis.assist.aiConsent.v1`, one choice for
 *              photos and clips and one for voice notes, because the two go to
 *              different companies. A convenience only, every access guarded:
 *              without storage the sheet simply asks again.
 */
import { ApiError, api } from './api';

export type AiReadKind = 'photo' | 'clip' | 'voice';
/** The company a read goes to, as the readiness answer names it. A company, never a model. */
export type AiProvider = 'anthropic' | 'cloudflare';

export interface AiReadiness {
  mode: 'basic' | 'ai';
  text: boolean;
  photo: boolean;
  clip: boolean;
  voice: boolean;
  /** The languages speech may be turned into text in; Sorani is never one of them (plan I10). */
  voiceLocales: string[];
  photoProvider: AiProvider | null;
  voiceProvider: AiProvider | null;
}

export const BASIC_READINESS: AiReadiness = Object.freeze({
  mode: 'basic',
  text: false,
  photo: false,
  clip: false,
  voice: false,
  voiceLocales: [] as string[],
  photoProvider: null,
  voiceProvider: null,
}) as AiReadiness;

export const READINESS_PATH = '/api/support/assistant/readiness';
/**
 * The privacy clause of the layer (plan §12.5: worker/lib/policies/assistant_ai.ts,
 * registered as `assistant_ai`), linked from the consent sheet so the whole
 * clause is one tap away before anything is sent.
 */
export const AI_POLICY_PATH = '/policies/assistant_ai';
export const READ_PATH = '/api/support/assistant/read';
export const READ_FRAMES_PATH = '/api/support/assistant/read-frames';

/** The company names the consent sheet fills `{provider}` with (plan §5.5). */
export const PROVIDER_NAMES: Record<AiProvider, string> = { anthropic: 'Anthropic', cloudflare: 'Cloudflare' };

const PROVIDERS: ReadonlySet<string> = new Set(Object.keys(PROVIDER_NAMES));
/** Speech is turned into text in these two only (plan §5.4); anything else in the list is ignored. */
const VOICE_LOCALES: ReadonlySet<string> = new Set(['ar', 'en']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const provider = (v: unknown): AiProvider | null => (typeof v === 'string' && PROVIDERS.has(v) ? (v as AiProvider) : null);

/**
 * The readiness answer as this page may trust it. Strict: a flag is on only
 * when it is literally `true`, and a read whose company is not named is off.
 */
export function readReadiness(raw: unknown): AiReadiness {
  if (!isRecord(raw) || raw.success === false || (raw.mode !== 'ai' && raw.mode !== 'basic')) return BASIC_READINESS;
  const photoProvider = provider(raw.photo_provider);
  const voiceProvider = provider(raw.voice_provider);
  const voiceLocales = Array.isArray(raw.voice_locales)
    ? [...new Set(raw.voice_locales.filter((l): l is string => typeof l === 'string' && VOICE_LOCALES.has(l)))]
    : [];
  const text = raw.text === true;
  const photo = raw.photo === true && !!photoProvider;
  const clip = raw.clip === true && !!photoProvider;
  const voice = raw.voice === true && !!voiceProvider && voiceLocales.length > 0;
  const any = text || photo || clip || voice;
  if (raw.mode !== 'ai' || !any) return BASIC_READINESS;
  return {
    mode: 'ai',
    text,
    photo,
    clip,
    voice,
    voiceLocales,
    photoProvider: photo || clip ? photoProvider : null,
    voiceProvider: voice ? voiceProvider : null,
  };
}

/** Never throws: every failure is basic mode. Silent, so the character does not react to it. */
export async function fetchReadiness(): Promise<AiReadiness> {
  try {
    return readReadiness(await api.get<unknown>(READINESS_PATH, { mascot: 'silent', timeoutMs: 8000 }));
  } catch {
    return BASIC_READINESS;
  }
}

// ------------------------------------------------------------------ consent

export const AI_CONSENT_KEY = 'levonis.assist.aiConsent.v1';
/** Photos and clip frames go to one company, voice notes to another: two choices. */
export type ConsentScope = 'media' | 'voice';
export const consentScope = (kind: AiReadKind): ConsentScope => (kind === 'voice' ? 'voice' : 'media');

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStore(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function readStored(store: StorageLike | null): Partial<Record<ConsentScope, 0 | 1>> {
  try {
    const raw = store?.getItem(AI_CONSENT_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!isRecord(v)) return {};
    const out: Partial<Record<ConsentScope, 0 | 1>> = {};
    for (const scope of ['media', 'voice'] as const) if (v[scope] === 0 || v[scope] === 1) out[scope] = v[scope] as 0 | 1;
    return out;
  } catch {
    return {};
  }
}

/** true: accepted in this browser session; false: declined; null: not asked yet (or no storage). */
export function readConsent(scope: ConsentScope, store: StorageLike | null = sessionStore()): boolean | null {
  const v = readStored(store)[scope];
  return v === 1 ? true : v === 0 ? false : null;
}

export function rememberConsent(scope: ConsentScope, accepted: boolean, store: StorageLike | null = sessionStore()): void {
  try {
    store?.setItem(AI_CONSENT_KEY, JSON.stringify({ ...readStored(store), [scope]: accepted ? 1 : 0 }));
  } catch {
    /* a private window or a full quota: the sheet asks again next time */
  }
}

// ---------------------------------------------------------------- the chips

/**
 * The intent of a read chip. It never reaches the server: the page catches it
 * and runs the read itself, so a stored chip after a reload is still the
 * customer asking, never an action taken for them.
 */
export const AI_READ_INTENT = 'assist_ai_read';

export type AttachmentKind = 'image' | 'video' | 'audio';
export const readKindOf = (kind: AttachmentKind): AiReadKind => (kind === 'image' ? 'photo' : kind === 'video' ? 'clip' : 'voice');

/** May this viewer ask for this read, in this language, right now? */
export function canRead(kind: AiReadKind, r: AiReadiness, lang: string): boolean {
  if (r.mode !== 'ai') return false;
  if (kind === 'photo') return r.photo && !!r.photoProvider;
  if (kind === 'clip') return r.clip && !!r.photoProvider;
  return r.voice && !!r.voiceProvider && lang !== 'ckb' && r.voiceLocales.includes(lang);
}

/** The company a read goes to, for the consent sheet. */
export function providerFor(kind: AiReadKind, r: AiReadiness): string {
  const p = kind === 'voice' ? r.voiceProvider : r.photoProvider;
  return p ? PROVIDER_NAMES[p] : '';
}

/** A Sorani voice note on a Sorani screen: the page says so instead of offering a read (plan §5.4). */
export const voiceCkbHintDue = (r: AiReadiness, lang: string, kinds: readonly AttachmentKind[]): boolean =>
  lang === 'ckb' && r.mode === 'ai' && r.voice && kinds.includes('audio');

export interface ReadChoice {
  label: string;
  intent: typeof AI_READ_INTENT;
  params: { key: string; kind: AiReadKind };
}

const KEY_SHAPE = /^assist\/[A-Za-z0-9._/-]{1,240}$/;

/** A read chip as a stored reply carries it, or null: an owned key and a known kind only. */
export function readChoiceTarget(params: unknown): { key: string; kind: AiReadKind } | null {
  if (!isRecord(params) || typeof params.key !== 'string' || !KEY_SHAPE.test(params.key) || params.key.includes('..')) return null;
  const kind = params.kind;
  return kind === 'photo' || kind === 'clip' || kind === 'voice' ? { key: params.key, kind } : null;
}

/** «٢» on an Arabic or Sorani screen, «2» on an English one. */
const count = (n: number, lang: string) => (lang === 'en' ? String(n) : n.toLocaleString('ar-EG'));

/**
 * One chip per attachment this viewer may have read, in the order attached.
 * Two photos read «اقرأ الصورة ١» and «اقرأ الصورة ٢», so each chip names one file.
 * A read the customer declined in this session is not offered again.
 */
export function readChoices(
  files: ReadonlyArray<{ key: string; kind: AttachmentKind }>,
  r: AiReadiness,
  lang: string,
  labels: Record<AiReadKind, string>,
  declined: (scope: ConsentScope) => boolean = () => false
): ReadChoice[] {
  const offered = files
    .map((f) => ({ key: f.key, kind: readKindOf(f.kind) }))
    .filter((f) => KEY_SHAPE.test(f.key) && canRead(f.kind, r, lang) && !declined(consentScope(f.kind)));
  const total = (kind: AiReadKind) => offered.filter((f) => f.kind === kind).length;
  const seen: Partial<Record<AiReadKind, number>> = {};
  return offered.map((f) => {
    const n = (seen[f.kind] = (seen[f.kind] ?? 0) + 1);
    const label = total(f.kind) > 1 ? `${labels[f.kind]} ${count(n, lang)}` : labels[f.kind];
    return { label, intent: AI_READ_INTENT, params: { key: f.key, kind: f.kind } };
  });
}

// ---------------------------------------------------------------- the reads

export interface AiReply {
  intent: string;
  text: string;
  [field: string]: unknown;
}

export type AiReadResult = { kind: 'reply'; reply: AiReply } | { kind: 'transcript'; text: string };

/** The longest draft the composer takes (Support.tsx `maxLength`). */
export const TRANSCRIPT_MAX = 500;

/**
 * The transcript as it may enter the composer: control and direction-override
 * characters removed, whitespace collapsed, 1-500 characters. Anything else is
 * not a transcript.
 */
export function cleanTranscript(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length >= 1 && text.length <= TRANSCRIPT_MAX ? text : null;
}

/**
 * The answer of a read as this page may use it, or null. A transcript wins
 * over everything else in the body, so it can never be drawn as a bubble.
 */
export function readResult(raw: unknown): AiReadResult | null {
  if (!isRecord(raw) || raw.success === false) return null;
  if (typeof raw.transcript === 'string') {
    const text = cleanTranscript(raw.transcript);
    return text ? { kind: 'transcript', text } : null;
  }
  const reply = raw.reply;
  if (isRecord(reply) && typeof reply.intent === 'string' && typeof reply.text === 'string' && reply.text.trim()) {
    return { kind: 'reply', reply: reply as AiReply };
  }
  return null;
}

/** A read answered with something this page cannot use: shown as a failed turn, never guessed at. */
export const AI_READ_INVALID = 'AI_READ_INVALID';

function settled(raw: unknown): AiReadResult {
  const r = readResult(raw);
  if (!r) throw new ApiError(0, '', AI_READ_INVALID);
  return r;
}

/** Vision answers inside 10 s and speech inside 10 s on the server; the rest is the network. */
const READ_TIMEOUT_MS = 30000;

/** A photo or a voice note, by the key the upload gave it (plan §5.2, §5.4). */
export async function readAttachment(input: { kind: 'photo' | 'voice'; key: string; locale: string; context?: unknown }): Promise<AiReadResult> {
  const body = { kind: input.kind, key: input.key, consent: true, locale: input.locale, ...(input.context !== undefined ? { context: input.context } : {}) };
  return settled(await api.post<unknown>(READ_PATH, body, { timeoutMs: READ_TIMEOUT_MS }));
}

/** The 2-4 frames the browser took from an owned clip (plan §5.3): `key`, `consent`, `locale`, `context`, `f0`..`f3`. */
export async function readFrames(input: { key: string; frames: Blob[]; locale: string; context?: unknown }): Promise<AiReadResult> {
  const form = new FormData();
  form.append('key', input.key);
  form.append('consent', '1');
  form.append('locale', input.locale);
  if (input.context !== undefined) form.append('context', JSON.stringify(input.context));
  input.frames.slice(0, 4).forEach((frame, i) => form.append(`f${i}`, frame, `f${i}.jpg`));
  return settled(await api.post<unknown>(READ_FRAMES_PATH, form, { timeoutMs: READ_TIMEOUT_MS }));
}
