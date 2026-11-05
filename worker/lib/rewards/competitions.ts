/**
 * COMPETITIONS — created by the owner, entered free or with points, judged by
 * the owner (owner, 2026-11-03: «i added it later, enter free or by point and
 * etc.»; migration 0220; docs/DECISIONS.md row 286).
 *
 * THE LIFECYCLE. A competition is written as a DRAFT (any admin), PUBLISHED by
 * the owner — the prizes are the shop's money — and then either FINISHED, when
 * the owner names the winners after it closes, or CANCELLED, which gives every
 * entry fee back. Whether a published competition is upcoming, open or closed
 * is its window against the server's clock, never a stored flag a sweep has to
 * remember to flip.
 *
 * WINNERS ARE CHOSEN, NEVER DRAWN. The legality of draws in Iraq is an open
 * owner decision (docs/DECISIONS.md row 25), so nothing here picks a winner by
 * chance: the owner reads the entries and names the places.
 *
 * MONEY. An entry fee is a POINT withdrawal written in the SAME batch as the
 * entry, with the checkout's own guard (an amount that turns negative when the
 * balance no longer covers it, aborting the batch). A prize and a refund are
 * POINT deposits with deterministic ids (`wtx_cmp_prize_<entry>`,
 * `wtx_cmp_refund_<entry>`), so a replayed announcement or cancel can never
 * credit twice.
 */
import type { Env } from '../types';
import { safeParse } from '../types';
import { badRequest, conflict, notFound, HttpError, int, oneOf, str } from '../http';
import { newId } from '../crypto';
import { notifyStatement } from '../notifications';
import { rewardText, type Trilingual } from './strings';

export type CompetitionState = 'draft' | 'published' | 'finished' | 'cancelled';
export type CompetitionPhase = 'draft' | 'upcoming' | 'open' | 'closed' | 'finished' | 'cancelled';
export type EntryMode = 'free' | 'points';
export type Submission = 'none' | 'text' | 'photo' | 'photo_text';
export type Eligibility = 'everyone' | 'printer_owners';
export type EntryState = 'entered' | 'disqualified' | 'winner' | 'refunded';

export const MAX_PRIZE_PLACES = 10;
export const MAX_ENTRY_POINTS = 1_000_000;
export const MAX_PRIZE_POINTS = 10_000_000;
export const MAX_ANSWER_CHARS = 1000;
const MAX_DAYS = 366;

export interface CompetitionRow {
  id: string;
  title_ar: string;
  title_en: string;
  title_ckb: string;
  description_ar: string;
  description_en: string;
  description_ckb: string;
  prize_ar: string;
  prize_en: string;
  prize_ckb: string;
  entry_mode: EntryMode;
  entry_points: number;
  submission: Submission;
  eligibility: Eligibility;
  prize_points: string;
  max_entries: number | null;
  starts_at: string;
  ends_at: string;
  state: CompetitionState;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
}

export interface CompetitionInput {
  title: Trilingual;
  description: Trilingual;
  prize: Trilingual;
  entry_mode: EntryMode;
  entry_points: number;
  submission: Submission;
  eligibility: Eligibility;
  prize_points: number[];
  max_entries: number | null;
  starts_at: string;
  ends_at: string;
}

const iso = (v: unknown, name: string): string => {
  const s = str(v, name, { min: 1, max: 40 });
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw badRequest(`${name} must be a date and time`, 'COMPETITION_DATE_INVALID');
  return new Date(t).toISOString();
};

const tri = (body: Record<string, unknown>, field: string, max: number): Trilingual => ({
  ar: str(body[`${field}_ar`], `${field}_ar`, { max, required: false }),
  en: str(body[`${field}_en`], `${field}_en`, { max, required: false }),
  ckb: str(body[`${field}_ckb`], `${field}_ckb`, { max, required: false }),
});

/** The admin's form, validated field by field. A draft may still be incomplete. */
export function parseCompetitionInput(body: Record<string, unknown>): CompetitionInput {
  const title = tri(body, 'title', 120);
  if (!title.ar) throw badRequest('title_ar is required', 'COMPETITION_TITLE_REQUIRED');
  const entry_mode = oneOf(body.entry_mode ?? 'free', 'entry_mode', ['free', 'points'] as const);
  const entry_points = entry_mode === 'points' ? int(body.entry_points, 'entry_points', { min: 1, max: MAX_ENTRY_POINTS }) : 0;
  const rawPrizes = body.prize_points ?? [];
  if (!Array.isArray(rawPrizes) || rawPrizes.length > MAX_PRIZE_PLACES) {
    throw badRequest(`prize_points must list at most ${MAX_PRIZE_PLACES} places`, 'COMPETITION_PRIZES_INVALID');
  }
  const prize_points = rawPrizes.map((p, i) => int(p, `prize_points[${i}]`, { min: 0, max: MAX_PRIZE_POINTS }));
  const max_entries =
    body.max_entries === null || body.max_entries === undefined || body.max_entries === ''
      ? null
      : int(body.max_entries, 'max_entries', { min: 1, max: 100_000 });
  const starts_at = iso(body.starts_at, 'starts_at');
  const ends_at = iso(body.ends_at, 'ends_at');
  if (Date.parse(ends_at) <= Date.parse(starts_at)) throw badRequest('The end must be after the start', 'COMPETITION_DATES_INVALID');
  if (Date.parse(ends_at) - Date.parse(starts_at) > MAX_DAYS * 86_400_000) {
    throw badRequest(`A competition runs at most ${MAX_DAYS} days`, 'COMPETITION_DATES_INVALID');
  }
  return {
    title,
    description: tri(body, 'description', 2000),
    prize: tri(body, 'prize', 300),
    entry_mode,
    entry_points,
    submission: oneOf(body.submission ?? 'none', 'submission', ['none', 'text', 'photo', 'photo_text'] as const),
    eligibility: oneOf(body.eligibility ?? 'everyone', 'eligibility', ['everyone', 'printer_owners'] as const),
    prize_points,
    max_entries,
    starts_at,
    ends_at,
  };
}

export const inputOfRow = (r: CompetitionRow): CompetitionInput => ({
  title: { ar: r.title_ar, en: r.title_en, ckb: r.title_ckb },
  description: { ar: r.description_ar, en: r.description_en, ckb: r.description_ckb },
  prize: { ar: r.prize_ar, en: r.prize_en, ckb: r.prize_ckb },
  entry_mode: r.entry_mode,
  entry_points: Number(r.entry_points) || 0,
  submission: r.submission,
  eligibility: r.eligibility,
  prize_points: prizePointsOf(r.prize_points),
  max_entries: r.max_entries === null || r.max_entries === undefined ? null : Number(r.max_entries),
  starts_at: r.starts_at,
  ends_at: r.ends_at,
});

export function prizePointsOf(raw: unknown): number[] {
  const parsed = typeof raw === 'string' ? safeParse<unknown>(raw, []) : raw;
  return Array.isArray(parsed)
    ? parsed.slice(0, MAX_PRIZE_PLACES).map((x) => Math.max(0, Math.min(MAX_PRIZE_POINTS, Math.trunc(Number(x) || 0))))
    : [];
}

/**
 * What still stops a draft from being published, or null: every customer-
 * facing word in all three languages (CLAUDE.md «Languages»), a prize of some
 * kind, and a window that has not already closed. A CODE, which the admin
 * screen words in the reader's language: 'missing:<field>_<lang>',
 * 'prize_languages', 'no_prize', 'ended' or 'sorani_copy'.
 */
export type PublishProblem =
  | `missing:${'title' | 'description'}_${'ar' | 'en' | 'ckb'}`
  | 'prize_languages'
  | 'no_prize'
  | 'ended'
  | 'sorani_copy';

export function publishProblem(input: CompetitionInput, nowMs: number): PublishProblem | null {
  for (const field of ['title', 'description'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      if (!input[field][lang].trim()) return `missing:${field}_${lang}`;
    }
  }
  const prizeWords = [input.prize.ar, input.prize.en, input.prize.ckb].map((s) => s.trim());
  if (prizeWords.some(Boolean) && !prizeWords.every(Boolean)) return 'prize_languages';
  if (!input.prize_points.some((p) => p > 0) && !prizeWords.every(Boolean)) return 'no_prize';
  if (Date.parse(input.ends_at) <= nowMs) return 'ended';
  // DECISIONS row 183: a ckb slot never carries a copy of the Arabic.
  if (input.title.ckb.trim() === input.title.ar.trim() || input.description.ckb.trim() === input.description.ar.trim()) return 'sorani_copy';
  return null;
}

/** The API's own sentence for a refusal (the admin screen words the code itself). */
export function publishProblemText(p: PublishProblem): string {
  if (p.startsWith('missing:')) return `${p.slice('missing:'.length)} is required before publishing`;
  return {
    prize_languages: 'The prize text must be written in all three languages',
    no_prize: 'A competition needs a prize: points for a place, or the prize in words',
    ended: 'The competition has already ended',
    sorani_copy: 'The Sorani text must be Sorani, not a copy of the Arabic',
  }[p as 'prize_languages' | 'no_prize' | 'ended' | 'sorani_copy'];
}

export function phaseOf(r: Pick<CompetitionRow, 'state' | 'starts_at' | 'ends_at'>, nowMs: number): CompetitionPhase {
  if (r.state === 'draft') return 'draft';
  if (r.state === 'finished') return 'finished';
  if (r.state === 'cancelled') return 'cancelled';
  if (nowMs < Date.parse(r.starts_at)) return 'upcoming';
  if (nowMs < Date.parse(r.ends_at)) return 'open';
  return 'closed';
}

/** «Sara B.» / «Om***» — the reviews' masking (worker/routes/reviews.ts `maskName`), never the full identity. */
export function maskedName(name: string | null, username: string | null): string {
  const src = String(name ?? '').trim() || String(username ?? '').trim();
  if (!src) return 'Levonis';
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${parts[1].charAt(0)}.`;
  const p = parts[0];
  return p.length <= 2 ? p : `${p.slice(0, 2)}***`;
}

const PRINTER_OWNER_SQL = `SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
   WHERE o.user_id = ?1 AND o.status = 'delivered' AND oi.product_id IS NOT NULL AND oi.gift_entitlement_id IS NULL
     AND EXISTS (SELECT 1 FROM product_catalogs pc JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                  WHERE pc.product_id = oi.product_id)
   LIMIT 1`;

export async function ownsDeliveredPrinter(db: D1Database, userId: string): Promise<boolean> {
  return !!(await db.prepare(PRINTER_OWNER_SQL).bind(userId).first());
}

/** A photo the entrant stored through purpose=post, still live, and theirs. */
const POST_IMAGE_KEY = /^users\/([A-Za-z0-9_-]{1,64})\/posts\/[A-Za-z0-9_-]{4,64}\.(jpg|jpeg|png|webp|gif|avif)$/;

export async function ownedEntryPhoto(db: D1Database, userId: string, raw: unknown): Promise<string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const key = value.startsWith('/files/') ? value.slice('/files/'.length) : value;
  const m = POST_IMAGE_KEY.exec(key);
  if (!m || m[1] !== userId) throw badRequest('Upload the photo first, then send the entry', 'COMPETITION_PHOTO_INVALID');
  const row = await db
    .prepare("SELECT 1 AS x FROM file_objects WHERE object_key = ? AND owner_id = ? AND deleted_at IS NULL AND mime_type LIKE 'image/%'")
    .bind(key, userId)
    .first();
  if (!row) throw badRequest('Upload the photo first, then send the entry', 'COMPETITION_PHOTO_INVALID');
  return key;
}

// --------------------------------------------------------------- views

export interface EntryView {
  id: string;
  state: EntryState;
  place: number | null;
  prize_points: number;
  entry_points: number;
  answer: string;
  media_url: string | null;
  created_at: string;
}

export interface WinnerView {
  place: number;
  name: string;
  prize_points: number;
  answer: string;
  media_url: string | null;
}

export interface CompetitionView {
  id: string;
  title: Trilingual;
  description: Trilingual;
  prize: Trilingual;
  entry_mode: EntryMode;
  entry_points: number;
  submission: Submission;
  eligibility: Eligibility;
  prize_points: number[];
  max_entries: number | null;
  starts_at: string;
  ends_at: string;
  phase: CompetitionPhase;
  entries_count: number;
  /** Null for a guest-less view; false when the eligibility rule shuts this customer out. */
  eligible: boolean;
  my_entry: EntryView | null;
  winners: WinnerView[];
  /** When the winners were announced: `finished_at` once finished, else null. */
  results_at: string | null;
}

/**
 * WHY THIS CUSTOMER CAN OR CANNOT ENTER, AS THE PAGE SAYS IT (DECISIONS row
 * 290). The rewards area draws its button and its reason from this and does no
 * arithmetic of its own: what is short, how many places are left. It decides
 * nothing either — `enterCompetition` re-reads every one of these inside its
 * own batch and stays the authority.
 */
export type GateBlock = 'entered' | 'upcoming' | 'closed' | 'not_eligible' | 'full' | 'insufficient_points';

export interface CompetitionGate {
  can_enter: boolean;
  blocked_by: GateBlock | null;
  /** The fee less the balance when the fee is what blocks, else 0. */
  points_short: number;
  /** Places left under the cap, never below 0; null when there is no cap. */
  spots_left: number | null;
}

type GateFacts = Pick<CompetitionView, 'phase' | 'eligible' | 'my_entry' | 'max_entries' | 'entries_count' | 'entry_mode' | 'entry_points'>;

/**
 * Pure. Checked in the order the page explains it: an entry already made, then
 * the window, then who may enter, then the cap, then the fee.
 */
export function gateOf(v: GateFacts, balance: number): CompetitionGate {
  const spots_left = v.max_entries === null ? null : Math.max(0, v.max_entries - v.entries_count);
  // The fee exactly as enterCompetition charges it.
  const fee = v.entry_mode === 'points' ? Math.max(0, Number(v.entry_points) || 0) : 0;
  const points = Number(balance) || 0;
  let blocked_by: GateBlock | null = null;
  if (v.my_entry) blocked_by = 'entered';
  else if (v.phase === 'upcoming') blocked_by = 'upcoming';
  else if (v.phase !== 'open') blocked_by = 'closed';
  else if (!v.eligible) blocked_by = 'not_eligible';
  else if (spots_left === 0) blocked_by = 'full';
  else if (points < fee) blocked_by = 'insufficient_points';
  return {
    can_enter: blocked_by === null,
    blocked_by,
    points_short: blocked_by === 'insufficient_points' ? fee - points : 0,
    spots_left,
  };
}

/** Every view with its gate, against the customer's spendable balance. */
export function withGates<T extends CompetitionView>(views: T[], balance: number): Array<T & { gate: CompetitionGate }> {
  return views.map((v) => ({ ...v, gate: gateOf(v, balance) }));
}

const mediaUrl = (key: string | null | undefined) => (key ? `/files/${key}` : null);

export function entryView(r: Record<string, unknown>): EntryView {
  return {
    id: String(r.id),
    state: r.state as EntryState,
    place: r.place === null || r.place === undefined ? null : Number(r.place),
    prize_points: Number(r.prize_points) || 0,
    entry_points: Number(r.entry_points) || 0,
    answer: String(r.answer ?? ''),
    media_url: mediaUrl(r.media_key as string | null),
    created_at: String(r.created_at ?? ''),
  };
}

function competitionView(
  r: CompetitionRow,
  nowMs: number,
  extra: { entries_count: number; eligible: boolean; my_entry: EntryView | null; winners: WinnerView[] }
): CompetitionView {
  const input = inputOfRow(r);
  return {
    id: r.id,
    title: input.title,
    description: input.description,
    prize: input.prize,
    entry_mode: input.entry_mode,
    entry_points: input.entry_points,
    submission: input.submission,
    eligibility: input.eligibility,
    prize_points: input.prize_points,
    max_entries: input.max_entries,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    phase: phaseOf(r, nowMs),
    ...extra,
    results_at: r.state === 'finished' ? (r.finished_at ?? null) : null,
  };
}

async function winnersOf(db: D1Database, ids: string[]): Promise<Map<string, WinnerView[]>> {
  const out = new Map<string, WinnerView[]>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare(
      `SELECT e.competition_id, e.place, e.prize_points, e.answer, e.media_key, u.name, u.username
         FROM reward_competition_entries e JOIN users u ON u.id = e.user_id
        WHERE e.competition_id IN (SELECT value FROM json_each(?1)) AND e.state = 'winner' AND e.place IS NOT NULL
        ORDER BY e.competition_id, e.place`
    )
    .bind(JSON.stringify(ids))
    .all<{ competition_id: string; place: number; prize_points: number; answer: string; media_key: string; name: string | null; username: string | null }>();
  for (const w of results ?? []) {
    const list = out.get(w.competition_id) ?? [];
    list.push({
      place: Number(w.place),
      name: maskedName(w.name, w.username),
      prize_points: Number(w.prize_points) || 0,
      answer: String(w.answer ?? ''),
      media_url: mediaUrl(w.media_key),
    });
    out.set(w.competition_id, list);
  }
  return out;
}

/**
 * What the rewards page shows: every published competition that is upcoming,
 * open or closed awaiting its winners, and the ones finished in the last 60
 * days with their winners — each with this customer's own entry.
 */
export async function listCompetitionsForUser(db: D1Database, userId: string, nowIso = new Date().toISOString()): Promise<CompetitionView[]> {
  const nowMs = Date.parse(nowIso);
  const since = new Date(nowMs - 60 * 86_400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM reward_competition_entries e WHERE e.competition_id = c.id AND e.state IN ('entered', 'winner')) AS entries_count
         FROM reward_competitions c
        WHERE c.state = 'published' OR (c.state = 'finished' AND c.finished_at >= ?1)
        ORDER BY CASE WHEN c.state = 'published' THEN 0 ELSE 1 END, c.ends_at ASC
        LIMIT 20`
    )
    .bind(since)
    .all<CompetitionRow & { entries_count: number }>();
  return forCustomer(db, userId, results ?? [], nowMs);
}

const ENTRIES_COUNT_SQL = `(SELECT COUNT(*) FROM reward_competition_entries e WHERE e.competition_id = c.id AND e.state IN ('entered', 'winner')) AS entries_count`;

/** Each row with this customer's own entry, whether they may enter, and — once finished — its winners. */
async function forCustomer(
  db: D1Database,
  userId: string,
  rows: Array<CompetitionRow & { entries_count: number }>,
  nowMs: number
): Promise<CompetitionView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [mine, winners, owner] = await Promise.all([
    db
      .prepare('SELECT * FROM reward_competition_entries WHERE user_id = ?1 AND competition_id IN (SELECT value FROM json_each(?2))')
      .bind(userId, JSON.stringify(ids))
      .all<Record<string, unknown>>(),
    winnersOf(db, rows.filter((r) => r.state === 'finished').map((r) => r.id)),
    rows.some((r) => r.eligibility === 'printer_owners') ? ownsDeliveredPrinter(db, userId) : Promise.resolve(true),
  ]);
  const byCompetition = new Map((mine.results ?? []).map((e) => [String(e.competition_id), entryView(e)]));
  return rows.map((r) =>
    competitionView(r, nowMs, {
      entries_count: Number(r.entries_count) || 0,
      eligible: r.eligibility === 'printer_owners' ? owner : true,
      my_entry: byCompetition.get(r.id) ?? null,
      winners: winners.get(r.id) ?? [],
    })
  );
}

// ----------------------------------------------------- the competitions page

/**
 * THE COMPETITIONS PAGE (DECISIONS row 290) — two lists, so that a year of
 * results never pushes a live competition down:
 *
 *   current   every published competition: open first (the soonest to close
 *             first), then upcoming (the soonest to open), then closed and
 *             waiting for the team's verdict. Never more than a few at once;
 *             capped at CURRENT_MAX all the same.
 *   results   every finished one, newest first, RESULTS_PAGE at a time with a
 *             cursor — no 60-day horizon, unlike the rewards hub's preview.
 *             With `mine` («مشاركاتي فقط»): only the ones THIS customer
 *             entered that ended for good — finished, or cancelled with their
 *             points back — newest first by the moment they ended, paged the
 *             same way. Never another customer's.
 *
 * Drafts never; a cancelled competition only to someone who entered it: on its
 * own page (competitionForCustomer) and in their own results.
 */
export type CompetitionList = 'current' | 'results';
export const CURRENT_MAX = 50;
export const RESULTS_PAGE = 20;

/** `<finished_at>|<id>` — the last result a page showed (with `mine`, the moment it finished or was cancelled). */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([A-Za-z0-9_-]{1,64})$/;

export function parseResultsCursor(raw: string | null | undefined): { finishedAt: string; id: string } | null {
  if (!raw) return null;
  const m = CURSOR.exec(raw);
  if (!m) throw badRequest('That page of results does not exist', 'BAD_CURSOR');
  return { finishedAt: m[1], id: m[2] };
}

export async function listCompetitionsPage(
  db: D1Database,
  userId: string,
  list: CompetitionList,
  cursor: string | null,
  nowIso = new Date().toISOString(),
  opts: { mine?: boolean } = {}
): Promise<{ competitions: CompetitionView[]; next_cursor: string | null }> {
  const nowMs = Date.parse(nowIso);
  if (list === 'current') {
    const { results } = await db
      .prepare(
        `SELECT c.*, ${ENTRIES_COUNT_SQL}
           FROM reward_competitions c
          WHERE c.state = 'published'
          ORDER BY CASE WHEN c.starts_at <= ?1 AND c.ends_at > ?1 THEN 0 WHEN c.starts_at > ?1 THEN 1 ELSE 2 END,
                   CASE WHEN c.starts_at > ?1 THEN c.starts_at ELSE c.ends_at END ASC,
                   c.id
          LIMIT ${CURRENT_MAX}`
      )
      .bind(nowIso)
      .all<CompetitionRow & { entries_count: number }>();
    return { competitions: await forCustomer(db, userId, results ?? [], nowMs), next_cursor: null };
  }
  const after = parseResultsCursor(cursor);
  // With `mine`, the moment each one ended for good: its announcement, or its cancellation.
  const ended = 'COALESCE(c.finished_at, c.cancelled_at)';
  const statement = opts.mine
    ? db
        .prepare(
          `SELECT c.*, ${ENTRIES_COUNT_SQL}
             FROM reward_competitions c
             JOIN reward_competition_entries me ON me.competition_id = c.id AND me.user_id = ?3
            WHERE c.state IN ('finished', 'cancelled') AND ${ended} IS NOT NULL
              AND (?1 IS NULL OR ${ended} < ?1 OR (${ended} = ?1 AND c.id < ?2))
            ORDER BY ${ended} DESC, c.id DESC
            LIMIT ${RESULTS_PAGE + 1}`
        )
        .bind(after?.finishedAt ?? null, after?.id ?? '', userId)
    : db
        .prepare(
          `SELECT c.*, ${ENTRIES_COUNT_SQL}
             FROM reward_competitions c
            WHERE c.state = 'finished' AND c.finished_at IS NOT NULL
              AND (?1 IS NULL OR c.finished_at < ?1 OR (c.finished_at = ?1 AND c.id < ?2))
            ORDER BY c.finished_at DESC, c.id DESC
            LIMIT ${RESULTS_PAGE + 1}`
        )
        .bind(after?.finishedAt ?? null, after?.id ?? '');
  const { results } = await statement.all<CompetitionRow & { entries_count: number }>();
  const rows = results ?? [];
  const page = rows.slice(0, RESULTS_PAGE);
  const last = page[page.length - 1];
  // The ordering instant of the last row shown (a finished row always has finished_at).
  const lastAt = last ? (last.finished_at ?? last.cancelled_at) : null;
  return {
    competitions: await forCustomer(db, userId, page, nowMs),
    next_cursor: rows.length > RESULTS_PAGE && lastAt ? `${lastAt}|${last.id}` : null,
  };
}

/** How many each list holds, for the page's two tabs. */
export async function competitionCounts(db: D1Database): Promise<{ current: number; results: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN state = 'published' THEN 1 ELSE 0 END), 0) AS current,
              COALESCE(SUM(CASE WHEN state = 'finished' THEN 1 ELSE 0 END), 0) AS results
         FROM reward_competitions`
    )
    .first<{ current: number; results: number }>();
  return { current: Math.min(CURRENT_MAX, Number(row?.current) || 0), results: Number(row?.results) || 0 };
}

export interface CompetitionWindowCounts {
  open: number;
  upcoming: number;
  closed: number;
  /** Open, not entered by this customer, theirs to enter, and below the cap. */
  open_to_enter: number;
}

/**
 * THE HUB'S COMPETITIONS DOOR (DECISIONS row 290): the published competitions
 * by window against the server's clock — open, upcoming, closed awaiting the
 * verdict — and how many open ones this customer could still enter. Counted,
 * never read off the hub's 20-row preview, so the door is right however many
 * there are. The fee is not part of «could enter»: a customer short of points
 * is still invited, and the competition's own page says what they lack.
 *
 * One aggregate. A printer owners' competition counts only for a customer who
 * owns a delivered printer, and that is asked only when one is open to them.
 */
export async function competitionWindowCounts(db: D1Database, userId: string, nowIso = new Date().toISOString()): Promise<CompetitionWindowCounts> {
  // The windows exactly as phaseOf reads them.
  const open = 'c.starts_at <= ?2 AND c.ends_at > ?2';
  const enterable = `${open}
           AND NOT EXISTS (SELECT 1 FROM reward_competition_entries me WHERE me.competition_id = c.id AND me.user_id = ?1)
           AND (c.max_entries IS NULL
                OR (SELECT COUNT(*) FROM reward_competition_entries x
                     WHERE x.competition_id = c.id AND x.state IN ('entered', 'winner')) < c.max_entries)`;
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN ${open} THEN 1 ELSE 0 END), 0) AS open,
              COALESCE(SUM(CASE WHEN c.starts_at > ?2 THEN 1 ELSE 0 END), 0) AS upcoming,
              COALESCE(SUM(CASE WHEN c.starts_at <= ?2 AND c.ends_at <= ?2 THEN 1 ELSE 0 END), 0) AS closed,
              COALESCE(SUM(CASE WHEN c.eligibility = 'everyone' AND ${enterable} THEN 1 ELSE 0 END), 0) AS open_to_enter_everyone,
              COALESCE(SUM(CASE WHEN c.eligibility = 'printer_owners' AND ${enterable} THEN 1 ELSE 0 END), 0) AS open_to_enter_owners
         FROM reward_competitions c
        WHERE c.state = 'published'`
    )
    .bind(userId, nowIso)
    .first<{ open: number; upcoming: number; closed: number; open_to_enter_everyone: number; open_to_enter_owners: number }>();
  const n = (v: unknown) => Math.max(0, Number(v) || 0);
  const owners = n(row?.open_to_enter_owners);
  const ownsPrinter = owners > 0 ? await ownsDeliveredPrinter(db, userId) : false;
  return {
    open: n(row?.open),
    upcoming: n(row?.upcoming),
    closed: n(row?.closed),
    open_to_enter: n(row?.open_to_enter_everyone) + (ownsPrinter ? owners : 0),
  };
}

/**
 * ONE COMPETITION'S PAGE — what a notification («you won», «your points came
 * back») links to. Published and finished ones are anyone's to read; a draft
 * is nobody's; a cancelled one only its entrants', who were refunded and are
 * owed the reason. Null means «not found» for this customer.
 */
export async function competitionForCustomer(db: D1Database, userId: string, id: string, nowIso = new Date().toISOString()): Promise<CompetitionView | null> {
  const row = await db
    .prepare(`SELECT c.*, ${ENTRIES_COUNT_SQL} FROM reward_competitions c WHERE c.id = ?1 AND c.state IN ('published', 'finished', 'cancelled')`)
    .bind(id)
    .first<CompetitionRow & { entries_count: number }>();
  if (!row) return null;
  const [view] = await forCustomer(db, userId, [row], Date.parse(nowIso));
  if (row.state === 'cancelled' && !view.my_entry) return null;
  return view;
}

// --------------------------------------------------------------- entering

export class CompetitionError extends HttpError {}

const refuse = (status: number, code: string, message: string) => new CompetitionError(status, message, code);

/**
 * Enters one customer, once. The entry and its fee are ONE batch: the entry is
 * written only while the competition is published and inside its window and
 * below its cap (all re-read inside the INSERT, so a competition that closed a
 * millisecond ago, or filled up, refuses); the fee only if that entry was
 * written, and only while the balance covers it.
 */
export async function enterCompetition(
  env: Env,
  userId: string,
  competitionId: string,
  body: Record<string, unknown>,
  nowIso = new Date().toISOString()
): Promise<EntryView> {
  const db = env.DB;
  const c = await db.prepare('SELECT * FROM reward_competitions WHERE id = ?').bind(competitionId).first<CompetitionRow>();
  if (!c || c.state === 'draft') throw notFound('Competition not found');
  const nowMs = Date.parse(nowIso);
  const phase = phaseOf(c, nowMs);
  if (phase === 'upcoming') throw refuse(409, 'COMPETITION_NOT_OPEN', 'This competition has not opened yet');
  if (phase !== 'open') throw refuse(409, 'COMPETITION_CLOSED', 'This competition is closed');
  if (c.eligibility === 'printer_owners' && !(await ownsDeliveredPrinter(db, userId))) {
    throw refuse(403, 'COMPETITION_NOT_ELIGIBLE', 'This competition is for customers who received a printer from Levonis');
  }

  const wantsText = c.submission === 'text' || c.submission === 'photo_text';
  const wantsPhoto = c.submission === 'photo' || c.submission === 'photo_text';
  const answer = wantsText ? str(body.answer, 'answer', { max: MAX_ANSWER_CHARS, required: false }) : '';
  if (wantsText && !answer) throw badRequest('Write your answer first', 'COMPETITION_ANSWER_REQUIRED');
  const mediaKey = wantsPhoto ? await ownedEntryPhoto(db, userId, body.media_key) : '';

  const entryId = newId('rce');
  const fee = c.entry_mode === 'points' ? Math.max(0, Number(c.entry_points) || 0) : 0;
  const txId = fee > 0 ? `wtx_cmp_entry_${entryId}` : null;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO reward_competition_entries (id, competition_id, user_id, answer, media_key, entry_points, entry_tx_id, state, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'entered', ?8
          WHERE EXISTS (SELECT 1 FROM reward_competitions c
                         WHERE c.id = ?2 AND c.state = 'published' AND c.starts_at <= ?8 AND c.ends_at > ?8
                           AND (c.max_entries IS NULL
                                OR (SELECT COUNT(*) FROM reward_competition_entries x
                                     WHERE x.competition_id = c.id AND x.state IN ('entered', 'winner')) < c.max_entries))`
      )
      .bind(entryId, competitionId, userId, answer, mediaKey, fee, txId, nowIso),
  ];
  if (fee > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           SELECT ?1, ?2, 'withdrawal', 'POINT',
                  CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0)
                               FROM wallet_transactions WHERE user_id = ?2 AND currency = 'POINT' AND status = 'approved') >= ?3
                       THEN ?3 ELSE -1 END,
                  'approved', ?4, ?5, 'system', ?6
            WHERE EXISTS (SELECT 1 FROM reward_competition_entries WHERE id = ?7)`
        )
        .bind(txId, userId, fee, 'Competition entry', `competition_entry:${competitionId}`, nowIso, entryId)
    );
  }
  try {
    await db.batch(statements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) throw refuse(409, 'COMPETITION_ALREADY_ENTERED', 'You have already entered this competition');
    if (/CHECK/i.test(msg)) throw refuse(409, 'INSUFFICIENT_POINTS', 'You do not have enough points to enter');
    throw e;
  }
  const row = await db.prepare('SELECT * FROM reward_competition_entries WHERE id = ?').bind(entryId).first<Record<string, unknown>>();
  if (!row) {
    // The INSERT's own guard refused: closed in the meantime, or full.
    const now = await db.prepare('SELECT state, ends_at FROM reward_competitions WHERE id = ?').bind(competitionId).first<{ state: string; ends_at: string }>();
    if (now && now.state === 'published' && Date.parse(now.ends_at) > Date.parse(nowIso)) {
      throw refuse(409, 'COMPETITION_FULL', 'This competition is full');
    }
    throw refuse(409, 'COMPETITION_CLOSED', 'This competition is closed');
  }
  return entryView(row);
}

// --------------------------------------------------------------- admin

export interface AdminCompetitionView extends Omit<CompetitionView, 'eligible' | 'my_entry' | 'winners' | 'results_at'> {
  state: CompetitionState;
  created_at: string;
  published_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  points_collected: number;
  publish_problem: PublishProblem | null;
}

export async function listCompetitionsForAdmin(db: D1Database, nowIso = new Date().toISOString()): Promise<AdminCompetitionView[]> {
  const nowMs = Date.parse(nowIso);
  const { results } = await db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM reward_competition_entries e WHERE e.competition_id = c.id AND e.state IN ('entered', 'winner')) AS entries_count,
              (SELECT COALESCE(SUM(e.entry_points), 0) FROM reward_competition_entries e
                WHERE e.competition_id = c.id AND e.state IN ('entered', 'winner', 'disqualified')) AS points_collected
         FROM reward_competitions c
        ORDER BY CASE c.state WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, c.ends_at DESC
        LIMIT 100`
    )
    .all<CompetitionRow & { entries_count: number; points_collected: number }>();
  return (results ?? []).map((r) => {
    const input = inputOfRow(r);
    return {
      id: r.id,
      title: input.title,
      description: input.description,
      prize: input.prize,
      entry_mode: input.entry_mode,
      entry_points: input.entry_points,
      submission: input.submission,
      eligibility: input.eligibility,
      prize_points: input.prize_points,
      max_entries: input.max_entries,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      phase: phaseOf(r, nowMs),
      entries_count: Number(r.entries_count) || 0,
      state: r.state,
      created_at: r.created_at,
      published_at: r.published_at,
      finished_at: r.finished_at,
      cancelled_at: r.cancelled_at,
      points_collected: Number(r.points_collected) || 0,
      publish_problem: r.state === 'draft' ? publishProblem(inputOfRow(r), nowMs) : null,
    };
  });
}

const inputBinds = (i: CompetitionInput) => [
  i.title.ar, i.title.en, i.title.ckb,
  i.description.ar, i.description.en, i.description.ckb,
  i.prize.ar, i.prize.en, i.prize.ckb,
  i.entry_mode, i.entry_points, i.submission, i.eligibility,
  JSON.stringify(i.prize_points), i.max_entries, i.starts_at, i.ends_at,
];

export async function createCompetition(db: D1Database, adminId: string, input: CompetitionInput, nowIso = new Date().toISOString()): Promise<string> {
  const id = newId('cmp');
  await db
    .prepare(
      `INSERT INTO reward_competitions
         (title_ar, title_en, title_ckb, description_ar, description_en, description_ckb, prize_ar, prize_en, prize_ckb,
          entry_mode, entry_points, submission, eligibility, prize_points, max_entries, starts_at, ends_at,
          id, state, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'draft', ?19, ?20, ?20)`
    )
    .bind(...inputBinds(input), id, adminId, nowIso)
    .run();
  return id;
}

/** A draft is edited freely; once published, its terms are a promise and stay as they are. */
export async function updateDraftCompetition(db: D1Database, id: string, input: CompetitionInput, nowIso = new Date().toISOString()): Promise<void> {
  const res = await db
    .prepare(
      `UPDATE reward_competitions
          SET title_ar = ?1, title_en = ?2, title_ckb = ?3, description_ar = ?4, description_en = ?5, description_ckb = ?6,
              prize_ar = ?7, prize_en = ?8, prize_ckb = ?9, entry_mode = ?10, entry_points = ?11, submission = ?12,
              eligibility = ?13, prize_points = ?14, max_entries = ?15, starts_at = ?16, ends_at = ?17, updated_at = ?18
        WHERE id = ?19 AND state = 'draft'`
    )
    .bind(...inputBinds(input), nowIso, id)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    const exists = await db.prepare('SELECT state FROM reward_competitions WHERE id = ?').bind(id).first<{ state: string }>();
    if (!exists) throw notFound('Competition not found');
    throw conflict('Only a draft can be edited; a published competition keeps the terms customers entered under', 'COMPETITION_NOT_DRAFT');
  }
}

export async function publishCompetition(db: D1Database, id: string, nowIso = new Date().toISOString()): Promise<void> {
  const row = await db.prepare('SELECT * FROM reward_competitions WHERE id = ?').bind(id).first<CompetitionRow>();
  if (!row) throw notFound('Competition not found');
  if (row.state !== 'draft') throw conflict('Only a draft can be published', 'COMPETITION_NOT_DRAFT');
  const problem = publishProblem(inputOfRow(row), Date.parse(nowIso));
  if (problem) throw badRequest(publishProblemText(problem), 'COMPETITION_INCOMPLETE', { problem });
  const res = await db
    .prepare("UPDATE reward_competitions SET state = 'published', published_at = ?1, updated_at = ?1 WHERE id = ?2 AND state = 'draft'")
    .bind(nowIso, id)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw conflict('Only a draft can be published', 'COMPETITION_NOT_DRAFT');
}

const competitionTitle = (r: CompetitionRow): Trilingual => ({ ar: r.title_ar, en: r.title_en, ckb: r.title_ckb });

/**
 * Cancels a draft or a published competition and gives every entry fee back
 * (deposits with deterministic ids), telling each paying entrant. A finished
 * competition cannot be cancelled: its prizes were paid.
 */
export async function cancelCompetition(env: Env, id: string, nowIso = new Date().toISOString()): Promise<{ refunded: number }> {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM reward_competitions WHERE id = ?').bind(id).first<CompetitionRow>();
  if (!row) throw notFound('Competition not found');
  if (row.state === 'finished') throw conflict('A finished competition cannot be cancelled', 'COMPETITION_FINISHED');
  if (row.state === 'cancelled') return { refunded: 0 };
  const { results } = await db
    .prepare("SELECT id, user_id, entry_points FROM reward_competition_entries WHERE competition_id = ? AND state IN ('entered', 'disqualified') AND entry_points > 0")
    .bind(id)
    .all<{ id: string; user_id: string; entry_points: number }>();
  const paid = results ?? [];
  const statements: D1PreparedStatement[] = [
    db
      .prepare("UPDATE reward_competitions SET state = 'cancelled', cancelled_at = ?1, updated_at = ?1 WHERE id = ?2 AND state IN ('draft', 'published')")
      .bind(nowIso, id),
  ];
  const cancelled = (c: string, t: string) =>
    `EXISTS (SELECT 1 FROM reward_competitions WHERE id = ${c} AND state = 'cancelled' AND cancelled_at = ${t})`;
  for (const e of paid) {
    statements.push(
      db
        .prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           SELECT ?1, ?2, 'deposit', 'POINT', ?3, 'approved', 'Competition cancelled: entry refunded', ?4, 'system', ?6
            WHERE ${cancelled('?5', '?6')}`
        )
        .bind(`wtx_cmp_refund_${e.id}`, e.user_id, e.entry_points, `competition_refund:${id}`, id, nowIso),
      db
        .prepare(`UPDATE reward_competition_entries SET state = 'refunded', decided_at = ?3 WHERE id = ?1 AND ${cancelled('?2', '?3')}`)
        .bind(e.id, id, nowIso)
    );
  }
  const res = await db.batch(statements);
  // A concurrent cancel won the flip: every refund above was fenced off, and
  // nobody is told about a refund this call did not make.
  if ((res[0]?.meta.changes ?? 0) === 0) return { refunded: 0 };
  await tell(
    db,
    paid.map((e) => {
      const text = rewardText({ kind: 'competition_refund', title: competitionTitle(row), points: e.entry_points });
      return { userId: e.user_id, text, competitionId: id, eventKey: `reward:competition:${id}:refund`, meta: {} };
    })
  );
  return { refunded: paid.length };
}

/** In-app notices after the money has committed; never able to undo it. */
async function tell(
  db: D1Database,
  notes: Array<{ userId: string; text: ReturnType<typeof rewardText>; competitionId: string; eventKey: string; meta: Record<string, unknown> }>
): Promise<void> {
  if (!notes.length) return;
  try {
    await db.batch(
      notes.map((n) =>
        notifyStatement(db, {
          userId: n.userId,
          kind: 'reward',
          title_ar: n.text.title.ar,
          title_en: n.text.title.en,
          body_ar: n.text.body.ar,
          body_en: n.text.body.en,
          // Its own page (DECISIONS row 290): the result, the prize or the refund, and the winners.
          link: `/rewards/competitions/${encodeURIComponent(n.competitionId)}`,
          entity_type: 'competition',
          entity_id: n.competitionId,
          meta: { title_ckb: n.text.title.ckb, body_ckb: n.text.body.ckb, ...n.meta },
          eventKey: n.eventKey,
        }).stmt
      )
    );
  } catch (e) {
    console.error('competition notices not written', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Disqualifies one entry before the winners are named. A paid entry's points
 * go back: a disqualification is the shop's judgement, not a fee it keeps.
 */
export async function disqualifyEntry(db: D1Database, competitionId: string, entryId: string, note: string, nowIso = new Date().toISOString()): Promise<void> {
  const e = await db
    .prepare('SELECT e.*, c.state AS competition_state FROM reward_competition_entries e JOIN reward_competitions c ON c.id = e.competition_id WHERE e.id = ? AND e.competition_id = ?')
    .bind(entryId, competitionId)
    .first<Record<string, unknown> & { competition_state: string; state: string; user_id: string; entry_points: number }>();
  if (!e) throw notFound('Entry not found');
  if (e.competition_state !== 'published') throw conflict('Entries can only be judged while the competition is running or closed', 'COMPETITION_NOT_PUBLISHED');
  if (e.state !== 'entered') throw conflict('This entry was already decided', 'ENTRY_DECIDED');
  const fee = Math.max(0, Number(e.entry_points) || 0);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE reward_competition_entries SET state = ?1, admin_note = ?2, decided_at = ?3 WHERE id = ?4 AND state = 'entered'`)
      .bind(fee > 0 ? 'refunded' : 'disqualified', note.slice(0, 300), nowIso, entryId),
  ];
  if (fee > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           SELECT ?1, ?2, 'deposit', 'POINT', ?3, 'approved', 'Competition entry not accepted: refunded', ?4, 'system', ?5
            WHERE EXISTS (SELECT 1 FROM reward_competition_entries WHERE id = ?6 AND state = 'refunded' AND decided_at = ?5)`
        )
        .bind(`wtx_cmp_refund_${entryId}`, e.user_id, fee, `competition_refund:${competitionId}`, nowIso, entryId)
    );
  }
  await db.batch(statements);
}

export interface WinnerPick {
  entry_id: string;
  place: number;
}

/**
 * Names the winners of a closed competition, pays each place its points and
 * tells each winner — one batch, fenced on the competition flipping from
 * published to finished in this very call, so a second press pays nothing.
 */
export async function finishCompetition(
  env: Env,
  id: string,
  picks: WinnerPick[],
  nowIso = new Date().toISOString()
): Promise<{ winners: number; points: number }> {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM reward_competitions WHERE id = ?').bind(id).first<CompetitionRow>();
  if (!row) throw notFound('Competition not found');
  if (row.state !== 'published') throw conflict('Only a running competition can be finished', 'COMPETITION_NOT_PUBLISHED');
  if (Date.parse(nowIso) < Date.parse(row.ends_at)) {
    throw conflict('The winners are named after the competition closes', 'COMPETITION_STILL_OPEN');
  }
  if (!Array.isArray(picks) || picks.length > MAX_PRIZE_PLACES) throw badRequest(`Name at most ${MAX_PRIZE_PLACES} winners`, 'COMPETITION_WINNERS_INVALID');
  const places = new Set<number>();
  const entries = new Set<string>();
  for (const p of picks) {
    if (!p || typeof p.entry_id !== 'string' || !Number.isSafeInteger(p.place) || p.place < 1 || p.place > MAX_PRIZE_PLACES) {
      throw badRequest('Every winner needs an entry and a place from 1 to 10', 'COMPETITION_WINNERS_INVALID');
    }
    if (places.has(p.place)) throw badRequest(`Place ${p.place} is given twice`, 'COMPETITION_WINNERS_INVALID');
    if (entries.has(p.entry_id)) throw badRequest('One entry cannot win two places', 'COMPETITION_WINNERS_INVALID');
    places.add(p.place);
    entries.add(p.entry_id);
  }
  const { results } = picks.length
    ? await db
        .prepare(
          "SELECT id, user_id FROM reward_competition_entries WHERE competition_id = ?1 AND state = 'entered' AND id IN (SELECT value FROM json_each(?2))"
        )
        .bind(id, JSON.stringify(picks.map((p) => p.entry_id)))
        .all<{ id: string; user_id: string }>()
    : { results: [] as Array<{ id: string; user_id: string }> };
  const owners = new Map((results ?? []).map((r) => [r.id, r.user_id]));
  for (const p of picks) {
    if (!owners.has(p.entry_id)) throw badRequest('A winner must be an accepted entry of this competition', 'COMPETITION_WINNERS_INVALID');
  }
  const prizes = prizePointsOf(row.prize_points);
  const statements: D1PreparedStatement[] = [
    db
      .prepare("UPDATE reward_competitions SET state = 'finished', finished_at = ?1, updated_at = ?1 WHERE id = ?2 AND state = 'published'")
      .bind(nowIso, id),
  ];
  const finished = (c: string, t: string) =>
    `EXISTS (SELECT 1 FROM reward_competitions WHERE id = ${c} AND state = 'finished' AND finished_at = ${t})`;
  let total = 0;
  for (const p of picks) {
    const userId = owners.get(p.entry_id)!;
    const points = prizes[p.place - 1] ?? 0;
    total += points;
    const txId = points > 0 ? `wtx_cmp_prize_${p.entry_id}` : null;
    statements.push(
      db
        .prepare(
          `UPDATE reward_competition_entries
              SET state = 'winner', place = ?1, prize_points = ?2, prize_tx_id = ?3, decided_at = ?6
            WHERE id = ?4 AND state = 'entered' AND ${finished('?5', '?6')}`
        )
        .bind(p.place, points, txId, p.entry_id, id, nowIso)
    );
    if (points > 0) {
      statements.push(
        db
          .prepare(
            `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
             SELECT ?1, ?2, 'deposit', 'POINT', ?3, 'approved', ?4, ?5, 'system', ?7
              WHERE ${finished('?6', '?7')}`
          )
          .bind(txId, userId, points, `Competition prize: place ${p.place}`, `competition_prize:${id}`, id, nowIso)
      );
    }
  }
  const res = await db.batch(statements);
  if ((res[0]?.meta.changes ?? 0) === 0) throw conflict('Only a running competition can be finished', 'COMPETITION_NOT_PUBLISHED');
  await tell(
    db,
    picks.map((p) => {
      const points = prizes[p.place - 1] ?? 0;
      return {
        userId: owners.get(p.entry_id)!,
        text: rewardText({ kind: 'competition_won', title: competitionTitle(row), place: p.place, points }),
        competitionId: id,
        eventKey: `reward:competition:${id}:won`,
        meta: { place: p.place, points },
      };
    })
  );
  return { winners: picks.length, points: total };
}

/** Every entry of one competition, for the owner's judging screen. */
export async function entriesForAdmin(db: D1Database, competitionId: string): Promise<Array<EntryView & { user_id: string; user_name: string; username: string; admin_note: string }>> {
  const { results } = await db
    .prepare(
      `SELECT e.*, u.name AS user_name, u.username FROM reward_competition_entries e JOIN users u ON u.id = e.user_id
        WHERE e.competition_id = ? ORDER BY e.created_at ASC LIMIT 2000`
    )
    .bind(competitionId)
    .all<Record<string, unknown>>();
  return (results ?? []).map((r) => ({
    ...entryView(r),
    user_id: String(r.user_id),
    user_name: String(r.user_name ?? ''),
    username: String(r.username ?? ''),
    admin_note: String(r.admin_note ?? ''),
  }));
}
