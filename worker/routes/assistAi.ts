/**
 * THE SUPPORT ASSISTANT'S AI LAYER, AT THE ROUTE (push B plan §5.1–§5.5).
 *
 * Registered from worker/routes/support.ts (`mountAssistAi`), under the same
 * `/api/support` prefix:
 *
 *   GET  /assistant/readiness    public: which reads this viewer may be offered
 *   POST /assistant/read         a session: read one OWNED photo or voice note
 *   POST /assistant/read-frames  a session: read 2–4 JPEG frames of one OWNED clip
 *
 * and `maybeUnderstand`, the ONE consult point of the text path: support.ts
 * asks it only after every rule, the legacy scorer and the strong catalogue
 * lookup found nothing, just before the clarify menu.
 *
 * WHAT HOLDS EVERYWHERE HERE
 *   - Basic mode is push A, byte for byte (I11). `null`, `photo_unavailable`
 *     and the voice templates are what every failure becomes: no key, no
 *     binding, the switch off, the cap, a limit, an open circuit, a provider
 *     fault, a refusal, invalid output. Nothing here throws a provider's
 *     trouble at the customer.
 *   - Nothing a model wrote is said (I1). A reading is validated
 *     (worker/lib/assist/ai/validate.ts) and answered by push A's own paths
 *     and templates; the voice transcript alone goes back, in its own
 *     top-level field, to the customer's own composer.
 *   - Nothing derived from customer media or text is stored (I6). A photo is
 *     re-encoded in memory, frames are read in memory, and the only rows
 *     written are the ledger's and the rate limiter's.
 *   - Ownership before any provider call: a key must be under the caller's own
 *     `assist/<uid>/` prefix, in the folder of the kind asked for, and stored.
 *   - Every response is `Cache-Control: private, no-store`.
 */
import type { Context, Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { HttpError, requireAuth } from '../lib/http';
import { getMediaObject, headMediaObject, isSafeMediaKey } from '../lib/mediaStorage';
import { GuardedFetchError, readResponseBytes } from '../lib/fetchGuard';
import { rateLimitAllows } from '../lib/ratelimit';
import { visionRendition, webpConversionAvailable } from '../lib/imageConvert';
import { assistKindOf, type AssistAttachmentKind } from '../lib/assist/attachments';
import { readContext, SHOWN_MAX, type AssistContext } from '../lib/assist/context';
import { handleReading, type TurnOutcome } from '../lib/assist/orchestrator';
import { callTool } from '../lib/assist/registry';
import { tr } from '../lib/assist/strings';
import type { AssistCard, AssistChoice, AssistReply, CardRenderer, Locale, Viewer } from '../lib/assist/types';
import { viewerFor } from '../lib/assist/viewer';
import type { RoutableIntent } from '../lib/assist/ai/adapter';
import { aliasOfToken } from '../lib/assist/ai/aliases';
import { LABEL_CARDS_MAX, photoReply, photoUnavailable, photoUnclear, voiceReply, type ReadSource } from '../lib/assist/ai/media';
import { readPhotoReading, readReading, readTranscript } from '../lib/assist/ai/validate';
import { loadAiState } from '../lib/ai/config';
import { bytesToBase64, checkJpeg, stripJpegMetadata } from '../lib/ai/jpeg';
import { redactForModel } from '../lib/ai/redact';
import {
  aiReady,
  FRAME_LIMITS,
  later,
  PHOTO_LIMITS,
  readiness,
  runTask,
  runUnderstand,
  SORANI_ONLY,
  SPEECH_MAX_BYTES,
  speechSpec,
  visionSpec,
  type TaskOutcome,
} from '../lib/ai/run';
import type { Outcome } from '../lib/ai/types';
import { assistAiReadMessage, type AssistAiReadRefusalCode } from '../../packages/contracts/src/assistAiRefusals';

// ------------------------------------------------------------------ shared

/** A reply this layer built: push A's shape, plus `mode: 'ai'` only when a model's reading shaped it. */
export type AiReply = AssistReply & { mode?: 'ai'; context?: AssistContext };

/** The «ليس هذا ما قصدته» chip: tapped, it reaches the route's clarify reply (the `menu` intent is no intent). */
export const AI_NOT_MEANT_INTENT = 'menu';

/**
 * AN AI-ASSISTED REPLY SAYS SO (plan §5.1). `mode: 'ai'` (the page shows its
 * «فُهم بمساعدة الذكاء الاصطناعي» tag under the bubble) and one more chip,
 * «ليس هذا ما قصدته», which takes the customer to the topic menu. A basic
 * reply never passes through here (I11).
 */
export function markAi<R extends { choices?: unknown[] }>(reply: R, loc: Locale): R & { mode: 'ai' } {
  const chip = { label: tr(loc, 'ai_not_meant'), intent: AI_NOT_MEANT_INTENT } satisfies AssistChoice;
  return { ...reply, mode: 'ai', choices: [...(reply.choices ?? []), chip] };
}

function refuse(status: 400 | 403 | 413, code: AssistAiReadRefusalCode): HttpError {
  return new HttpError(status, assistAiReadMessage(code), code);
}

/** The customer's language: the one the page asked for, else the account's, else Arabic (as support.ts reads it). */
function localeOf(c: Context<AppContext>, requested: unknown): Locale {
  if (requested === 'ar' || requested === 'en' || requested === 'ckb') return requested;
  const u = c.get('user');
  if (u?.locale === 'en') return 'en';
  if (u?.locale === 'ku') return 'ckb';
  return 'ar';
}

const FOLDER: Readonly<Record<'photo' | 'clip' | 'voice', AssistAttachmentKind>> = { photo: 'image', clip: 'video', voice: 'audio' };

/**
 * The caller's OWN key, of the kind asked for, or a refusal before anything
 * else happens: another customer's key is 403 (the gateway lets guests and
 * every account through to this prefix, so the handler is the gate).
 */
function ownKey(raw: unknown, userId: string, kind: AssistAttachmentKind): string {
  if (typeof raw !== 'string' || !isSafeMediaKey(raw)) throw refuse(400, 'AI_READ_INVALID');
  if (!raw.startsWith(`assist/${userId}/`)) throw new HttpError(403, 'That file is not yours to attach', 'ATTACHMENT_NOT_YOURS');
  if (assistKindOf(raw) !== kind) throw refuse(400, 'AI_READ_KIND');
  return raw;
}

/**
 * The key is stored (a HEAD), with its size and type from the uploader's own
 * ledger row, the HEAD's size failing that. Read only: nothing is held,
 * protected or written (the read is over before any cleanup could matter, and
 * an object gone mid-read is simply an unclear read).
 */
async function storedAttachment(env: Env, userId: string, key: string): Promise<{ mime: string; bytes: number }> {
  const head = await headMediaObject(env, 'private', key);
  if (!head) throw new HttpError(400, 'That attachment was not uploaded — attach it again', 'ATTACHMENT_NOT_FOUND');
  let row: { mime_type?: unknown; byte_size?: unknown } | null = null;
  try {
    row = await env.DB.prepare('SELECT mime_type, byte_size FROM file_objects WHERE object_key = ? AND owner_id = ? AND deleted_at IS NULL')
      .bind(key, userId)
      .first<{ mime_type: unknown; byte_size: unknown }>();
  } catch {
    // A ledger that cannot be read leaves the HEAD's size and no type.
  }
  return {
    mime: String(row?.mime_type ?? '').slice(0, 100),
    bytes: Math.max(0, Number(row?.byte_size ?? (head as { size?: number }).size ?? 0) || 0),
  };
}

/** A context sent as a JSON string (multipart) or an object (JSON), read through the same closed sets. */
function contextOf(raw: unknown): AssistContext {
  if (typeof raw === 'string') {
    if (raw.length > 4096) return readContext(null);
    try {
      return readContext(JSON.parse(raw));
    } catch {
      return readContext(null);
    }
  }
  return readContext(raw);
}

const ok = (c: Context<AppContext>, reply: AiReply) => c.json({ success: true, reply });

// ------------------------------------------------------------------ text: the one consult point

export type Understanding = { kind: 'reply'; turn: TurnOutcome } | { kind: 'intent'; intent: RoutableIntent };

export const UNDERSTAND_MIN_CHARS = 4;
export const TEXT_LIMIT = { bucket: 'assist-ai-text', limit: 20, windowSeconds: 300 } as const;
export const TEXT_DAY_LIMIT = { bucket: 'assist-ai-text-day', limit: 60, windowSeconds: 86_400 } as const;

/**
 * A FREE TEXT NOTHING ELSE COULD PLACE, READ BY A MODEL (plan §5.1).
 *
 * `null` (basic: push A's clarify reply) unless ALL of these hold, checked in
 * this order so that nothing is written before the cheap checks pass:
 *   1. the understanding task is ready for this viewer (the switch, a model
 *      with its rates, the key, the 0210 tables, the cap, the circuit, and the
 *      guest toggle for a signed-out viewer);
 *   2. the text is at least four characters;
 *   3. it is not Sorani (the page's language or a Sorani-only letter), unless
 *      the owner allowed Sorani reading;
 *   4. the per-visitor limits allow it (20 per 5 minutes, 60 a day).
 * Then the REDACTED text goes to the model, the answer is validated against
 * the UNREDACTED text, and push A's own paths answer it (`handleReading`), or
 * the read-only legacy intent it names falls through to the legacy switch.
 * Never throws.
 */
export async function maybeUnderstand(
  c: Context<AppContext>,
  args: { text: string; loc: Locale; context: AssistContext; viewer: Viewer; render: CardRenderer }
): Promise<Understanding | null> {
  try {
    const env = c.env;
    const guest = !args.viewer.userId;
    if (!(await aiReady(env, 'understand', { guest }))) return null;
    const text = args.text.trim();
    if (text.length < UNDERSTAND_MIN_CHARS) return null;
    if (args.loc === 'ckb' || SORANI_ONLY.test(text)) {
      const state = await loadAiState(env.DB);
      if (!state?.config.understandCkb) return null;
    }
    if (!(await rateLimitAllows(c, TEXT_LIMIT.bucket, TEXT_LIMIT.limit, TEXT_LIMIT.windowSeconds))) return null;
    if (!(await rateLimitAllows(c, TEXT_DAY_LIMIT.bucket, TEXT_DAY_LIMIT.limit, TEXT_DAY_LIMIT.windowSeconds))) return null;

    const ctx = args.context;
    const printer = ctx.printer && ctx.printer.model !== 'other' ? aliasOfToken(ctx.printer.model) : undefined;
    const raw = await runUnderstand(
      env,
      { text: redactForModel(text), locale: args.loc, ...(ctx.triage ? { stage: ctx.triage.stage } : {}), ...(printer ? { printer } : {}) },
      { guest },
      { waitUntil: later(c) }
    );
    if (raw === null) return null;
    const reading = readReading(raw, text, ctx);
    if (!reading || reading.action === 'none') return null;
    if (reading.action === 'intent') return { kind: 'intent', intent: reading.intent };
    const turn = await handleReading(env.DB, args.viewer, reading, text, ctx, args.render);
    return turn ? { kind: 'reply', turn } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ photos and clips

export const READ_LIMIT = { bucket: 'assist-ai-read', limit: 10, windowSeconds: 3_600 } as const;
export const READ_DAY_LIMIT = { bucket: 'assist-ai-read-day', limit: 15, windowSeconds: 86_400 } as const;
export const VOICE_LIMIT = { bucket: 'assist-ai-voice', limit: 20, windowSeconds: 3_600 } as const;
/** The whole multipart body of `/read-frames`: four frames of 400 KB and the fields beside them. */
export const FRAMES_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** A picture the model could not make sense of is unclear; any other failure is "not available now". */
const UNREADABLE: ReadonlySet<Outcome> = new Set(['REFUSAL', 'TRUNCATED', 'BAD_OUTPUT', 'BAD_INPUT', 'TOO_LARGE']);

async function readAllowed(c: Context<AppContext>): Promise<boolean> {
  return (
    (await rateLimitAllows(c, READ_LIMIT.bucket, READ_LIMIT.limit, READ_LIMIT.windowSeconds)) &&
    (await rateLimitAllows(c, READ_DAY_LIMIT.bucket, READ_DAY_LIMIT.limit, READ_DAY_LIMIT.windowSeconds))
  );
}

/**
 * The storefront cards a label code names EXACTLY (the identifier lane), and
 * only those: a code with no exact hit is dropped silently, and no code is
 * ever shown. At most six cards, each once.
 */
async function labelCards(db: D1Database, viewer: Viewer, codes: readonly string[], render: CardRenderer): Promise<AssistCard[]> {
  const cards: AssistCard[] = [];
  const seen = new Set<string>();
  for (const code of codes) {
    if (cards.length >= LABEL_CARDS_MAX) break;
    try {
      const r = await callTool('catalog.search', db, viewer, { text: code, limit: 4 });
      if (!r.ok || r.data.exactIds.length === 0) continue;
      for (const item of r.data.items) {
        if (!r.data.exactIds.includes(item.id) || seen.has(item.id) || cards.length >= LABEL_CARDS_MAX) continue;
        seen.add(item.id);
        cards.push(render.card(viewer.locale, item.card, item.row));
      }
    } catch {
      /* a lane that fails shows nothing */
    }
  }
  return cards;
}

/** A vision task's outcome as the customer's reply. */
async function visionReply(
  env: Env,
  out: TaskOutcome,
  args: { loc: Locale; source: ReadSource; frames?: number; viewer: Viewer; render: CardRenderer; context: AssistContext }
): Promise<AiReply> {
  const { loc, source, frames } = args;
  if (!out.ok) return UNREADABLE.has(out.code) ? photoUnclear(loc, source, frames) : photoUnavailable(loc, source);
  const reading = readPhotoReading(out.value);
  if (!reading) return photoUnclear(loc, source, frames);
  const cards = reading.labelCodes.length ? await labelCards(env.DB, args.viewer, reading.labelCodes, args.render) : [];
  const reply: AiReply = { ...photoReply(loc, reading, cards, source, frames), mode: 'ai' };
  // Cards shown are the conversation's «shown», so «شكد سعره؟» reads them again.
  const shown = (reply.cards ?? []).map((card) => card.product_id).filter((id): id is string => typeof id === 'string' && id !== '');
  if (shown.length) reply.context = { ...args.context, shown: [...new Set(shown)].slice(0, SHOWN_MAX) };
  return reply;
}

async function readPhoto(
  c: Context<AppContext>,
  key: string,
  stored: { mime: string },
  loc: Locale,
  context: AssistContext,
  render: CardRenderer
): Promise<AiReply> {
  const env = c.env;
  // Readiness first: a dark layer writes nothing, not even a rate-limit row.
  if (!(await aiReady(env, 'vision')) || !webpConversionAvailable(env)) return photoUnavailable(loc, 'photo');
  if (!(await readAllowed(c))) return photoUnavailable(loc, 'photo');
  const object = await getMediaObject(env, 'private', key);
  if (!object) return photoUnclear(loc, 'photo');
  const source = new Uint8Array(await object.arrayBuffer());
  const rendition = await visionRendition(env, source, stored.mime || 'image/webp');
  if (!rendition.ok) return rendition.reason === 'unavailable' ? photoUnavailable(loc, 'photo') : photoUnclear(loc, 'photo');
  // EXIF, GPS, XMP, ICC and comments out; then the picture must be a plain JPEG within the limits.
  const jpeg = stripJpegMetadata(rendition.bytes);
  if (!checkJpeg(jpeg, PHOTO_LIMITS.maxSide, PHOTO_LIMITS.maxBytes)) return photoUnclear(loc, 'photo');
  const deps = { waitUntil: later(c) };
  const spec = visionSpec(env, [jpeg], 'photo', deps);
  if (!spec) return photoUnclear(loc, 'photo');
  const out = await runTask(env, spec, deps);
  const viewer = viewerFor(env.DB, c.get('user')?.id ?? null, loc);
  return visionReply(env, out, { loc, source: 'photo', viewer, render, context });
}

// ------------------------------------------------------------------ voice

async function readVoice(c: Context<AppContext>, key: string, stored: { bytes: number }, loc: Locale): Promise<Response> {
  const env = c.env;
  // Sorani speech is never sent anywhere (I10): the note stays attached for the team.
  if (loc === 'ckb') return ok(c, voiceReply(loc, 'voice_ckb'));
  if (stored.bytes > SPEECH_MAX_BYTES) return ok(c, voiceReply(loc, 'voice_too_long'));
  if (!(await aiReady(env, 'speech'))) return ok(c, voiceReply(loc, 'voice_unavailable'));
  if (!(await rateLimitAllows(c, VOICE_LIMIT.bucket, VOICE_LIMIT.limit, VOICE_LIMIT.windowSeconds))) return ok(c, voiceReply(loc, 'voice_unavailable'));
  const object = await getMediaObject(env, 'private', key);
  if (!object) return ok(c, voiceReply(loc, 'voice_unclear'));
  const audio = new Uint8Array(await object.arrayBuffer());
  if (audio.byteLength > SPEECH_MAX_BYTES) return ok(c, voiceReply(loc, 'voice_too_long'));
  const spec = speechSpec(env, bytesToBase64(audio), audio.byteLength);
  if (!spec) return ok(c, voiceReply(loc, 'voice_unclear'));
  const out = await runTask(env, spec, { waitUntil: later(c) });
  if (!out.ok) return ok(c, voiceReply(loc, UNREADABLE.has(out.code) ? 'voice_unclear' : 'voice_unavailable'));
  const heard = readTranscript(out.value);
  if (!heard) return ok(c, voiceReply(loc, 'voice_unclear'));
  // The one model-derived string a customer ever sees, in its own field, for their own composer (I1).
  // Never stored, logged or placed in a reply or a context.
  return c.json({ success: true, transcript: heard.text });
}

// ------------------------------------------------------------------ the routes

/**
 * The three sub-routes, on support.ts's router. `render` is support.ts's own
 * card mapper (one mapper, no import cycle).
 */
export function mountAssistAi(routes: Hono<AppContext>, render: CardRenderer): void {
  /**
   * GET /assistant/readiness — public; flags and company names only, never a
   * model id, a cost, the cap or a rate. A missing table, key or binding all
   * read as basic. Served from the 30 s config memo.
   */
  routes.get('/assistant/readiness', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const state = await readiness(c.env, { signedIn: !!c.get('user') });
    return c.json({ success: true, ...state });
  });

  /**
   * POST /assistant/read — `{ kind: 'photo' | 'voice', key, consent: true, locale, context }`.
   * → `{ success: true, reply }`, or `{ success: true, transcript }` for a voice note heard.
   */
  routes.post('/assistant/read', requireAuth, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const user = c.get('user')!;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse(400, 'AI_READ_INVALID');
    const loc = localeOf(c, body.locale);
    if (body.consent !== true) throw refuse(400, 'AI_CONSENT_REQUIRED');
    const kind = body.kind === 'photo' || body.kind === 'voice' ? body.kind : null;
    if (!kind) throw refuse(400, 'AI_READ_INVALID');
    const key = ownKey(body.key, user.id, FOLDER[kind]);
    const stored = await storedAttachment(c.env, user.id, key);
    if (kind === 'voice') return readVoice(c, key, stored, loc);
    return ok(c, await readPhoto(c, key, stored, loc, contextOf(body.context), render));
  });

  /**
   * POST /assistant/read-frames — multipart: `key` (the clip's own), `consent=1`,
   * `locale`, `context`, and `f0`…`f3`, two to four JPEG frames the browser took
   * from the clip. The frames are read in memory and never stored; they count
   * against no attachment limit. → `{ success: true, reply }`.
   */
  routes.post('/assistant/read-frames', requireAuth, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const user = c.get('user')!;
    const declared = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declared) && declared > FRAMES_BODY_MAX_BYTES) throw refuse(413, 'AI_FRAMES_TOO_LARGE');
    const type = c.req.header('content-type') ?? '';
    if (!/^multipart\/form-data/i.test(type)) throw refuse(400, 'AI_FRAMES_INVALID');
    // Read under the cap whatever the header said (a chunked body declares nothing).
    let body: Uint8Array;
    try {
      body = await readResponseBytes(new Response(c.req.raw.body), { maxBytes: FRAMES_BODY_MAX_BYTES });
    } catch (e) {
      if (e instanceof GuardedFetchError && e.code === 'SOURCE_TOO_LARGE') throw refuse(413, 'AI_FRAMES_TOO_LARGE');
      throw refuse(400, 'AI_FRAMES_INVALID');
    }
    let form: FormData;
    try {
      form = await new Response(body as unknown as BodyInit, { headers: { 'content-type': type } }).formData();
    } catch {
      throw refuse(400, 'AI_FRAMES_INVALID');
    }
    const loc = localeOf(c, form.get('locale'));
    const consent = form.get('consent');
    if (consent !== '1' && consent !== 'true') throw refuse(400, 'AI_CONSENT_REQUIRED');
    const key = ownKey(form.get('key'), user.id, FOLDER.clip);
    await storedAttachment(c.env, user.id, key);

    // f0…f3 and nothing else: each a JPEG within the frame limits, with no EXIF block.
    const files: string[] = [];
    form.forEach((value, name) => {
      if (typeof value !== 'string') files.push(name);
    });
    if (files.some((name) => !/^f[0-3]$/.test(name)) || new Set(files).size !== files.length) throw refuse(400, 'AI_FRAMES_INVALID');
    const frames: Uint8Array[] = [];
    for (const name of ['f0', 'f1', 'f2', 'f3']) {
      const value = form.get(name);
      if (value === null) continue;
      if (typeof value === 'string') throw refuse(400, 'AI_FRAMES_INVALID');
      if (value.size <= 0 || value.size > FRAME_LIMITS.maxBytes) throw refuse(400, 'AI_FRAMES_INVALID');
      const bytes = new Uint8Array(await value.arrayBuffer());
      if (!checkJpeg(bytes, FRAME_LIMITS.maxSide, FRAME_LIMITS.maxBytes)) throw refuse(400, 'AI_FRAMES_INVALID');
      frames.push(stripJpegMetadata(bytes));
    }
    if (frames.length < FRAME_LIMITS.min || frames.length > FRAME_LIMITS.max) throw refuse(400, 'AI_FRAMES_INVALID');

    const env = c.env;
    if (!(await aiReady(env, 'vision'))) return ok(c, photoUnavailable(loc, 'clip'));
    if (!(await readAllowed(c))) return ok(c, photoUnavailable(loc, 'clip'));
    const deps = { waitUntil: later(c) };
    const spec = visionSpec(env, frames, 'clip', deps);
    if (!spec) return ok(c, photoUnclear(loc, 'clip', frames.length));
    const out = await runTask(env, spec, deps);
    const viewer = viewerFor(env.DB, user.id, loc);
    return ok(c, await visionReply(env, out, { loc, source: 'clip', frames: frames.length, viewer, render, context: contextOf(form.get('context')) }));
  });
}
