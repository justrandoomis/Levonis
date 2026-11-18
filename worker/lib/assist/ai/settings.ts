/**
 * THE SUPPORT ASSISTANT'S CLAUDE SWITCH (owner, 2026-11-18; DECISIONS row 348).
 *
 * One `admin_settings` row, `supportAssistantAi`, written only by the owner
 * (worker/routes/adminSupportAi.ts). No migration: the table exists since
 * 0001 and a settings row can be emptied without leaving a column behind.
 *
 * EVERY UNREADABLE VALUE READS OFF. A missing row, bad JSON, `"enabled":
 * "true"`, a model that is not a plain id: the assistant stays on its rules
 * (basic mode), exactly as before this switch existed. The model id lives here
 * and nowhere in the repository, which is public (docs/handoff/assist-ai-layer-B1-plan.md).
 */
export const ASSIST_AI_SETTING_KEY = 'supportAssistantAi';

export interface AssistAiSettings {
  /** True only when the stored value literally says `"enabled": true` AND names a model. */
  enabled: boolean;
  /** The model id the owner picked from the provider's live list. */
  model: string | null;
  /** Signed-out customers get Claude replies too (owner, 2026-11-18: «Everyone»). */
  guests: boolean;
  /** Sorani customers get Claude replies (off by default: Sorani is never machine-written unless the owner says so). */
  ckb: boolean;
  /** Claude looks printer error codes up on the makers' wikis (DECISIONS row 349). On unless the owner turns it off. */
  wiki: boolean;
  /** Claude reads a photo a signed-in customer attaches (DECISIONS row 349). On unless the owner turns it off. */
  photos: boolean;
  /** Claude-answered turns per UTC day, the whole shop together. */
  daily_turns: number;
  /** The share of `daily_turns` signed-out customers may use, in percent. */
  guest_share_pct: number;
}

export const DAILY_TURNS_DEFAULT = 300;
export const DAILY_TURNS_MAX = 5000;
export const GUEST_SHARE_DEFAULT = 50;

export const ASSIST_AI_OFF: AssistAiSettings = Object.freeze({
  enabled: false,
  model: null,
  guests: true,
  ckb: false,
  wiki: true,
  photos: true,
  daily_turns: DAILY_TURNS_DEFAULT,
  guest_share_pct: GUEST_SHARE_DEFAULT,
}) as AssistAiSettings;

/** A model id's shape: what the provider's list returns, nothing that could be a URL or carry spaces. */
export const MODEL_ID_SHAPE = /^[a-z0-9][a-z0-9._-]{1,99}$/;

const intIn = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt;

export function assistAiFromSetting(value: string | null | undefined): AssistAiSettings {
  if (typeof value !== 'string' || !value.trim()) return ASSIST_AI_OFF;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return ASSIST_AI_OFF;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ASSIST_AI_OFF;
  const o = raw as Record<string, unknown>;
  const model = typeof o.model === 'string' && MODEL_ID_SHAPE.test(o.model) ? o.model : null;
  return {
    enabled: o.enabled === true && model !== null,
    model,
    guests: o.guests !== false,
    ckb: o.ckb === true,
    wiki: o.wiki !== false,
    photos: o.photos !== false,
    daily_turns: intIn(o.daily_turns, 1, DAILY_TURNS_MAX, DAILY_TURNS_DEFAULT),
    guest_share_pct: intIn(o.guest_share_pct, 0, 100, GUEST_SHARE_DEFAULT),
  };
}

/** One indexed read. A database without the row (or a failing read) is basic mode. */
export async function readAssistAi(db: D1Database): Promise<AssistAiSettings> {
  try {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(ASSIST_AI_SETTING_KEY).first<{ value: string }>();
    return assistAiFromSetting(row?.value);
  } catch {
    return ASSIST_AI_OFF;
  }
}

export async function writeAssistAi(db: D1Database, s: AssistAiSettings): Promise<void> {
  const value = JSON.stringify({
    enabled: s.enabled,
    model: s.model,
    guests: s.guests,
    ckb: s.ckb,
    wiki: s.wiki,
    photos: s.photos,
    daily_turns: s.daily_turns,
    guest_share_pct: s.guest_share_pct,
  });
  await db
    .prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(ASSIST_AI_SETTING_KEY, value)
    .run();
}
