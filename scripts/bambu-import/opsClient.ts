/**
 * THE OPS CLIENT: THE RUNNER'S ONLY DOOR TO PRODUCTION (Bambu import spec
 * §A.3, §A.7, §B.5).
 *
 * Every call goes to `<site>/api/ops/catalog-import/…` with
 *
 *   Authorization: Bearer <the job's 64-hex token>
 *   X-Levonis-Import-Protocol: 2
 *
 * and nothing else that identifies anyone. The token lives in this object's
 * memory only (it was read from a 0600 file that run.ts deleted at once).
 *
 * THE CALLS (method, path, request body keys → answer keys read):
 *
 *   POST /hello                         {protocol, github_run_id, code_commit}
 *                                       → {protocol, expected_migration, migrations_present{0193,0194,0195,0196}, reviewed{file: sha256}, run{id, state, cursor, delta}, worker_build}
 *   POST /manifest                      {rows: [≤ 100 × {source_product_id, handle, type, curated, hold_code, queue_position,
 *                                                      canonical_url, source_collections, breadcrumbs, discovery_sources, discovered_at}]}
 *                                       → {accepted}
 *   POST /items/:sid/lease              {lease_token}            → {lease_token, state, last_completed_stage, attempts, stage_attempts, retry_at, stage_data,
 *                                                                   blocker_code?, levonis_product_id?, slug?, payload_sha256?}
 *   POST /items/:sid/event              {lease_token, state, outcome, code, message, retry_at, release, detail}
 *                                       → {state, last_completed_stage, stage_attempts, seq}
 *   POST /items/:sid/stage              {lease_token, payload, document_checks} → {payload_sha256, invocation_estimate, conflicts[], warnings[]}
 *   POST /items/:sid/media              {lease_token, media: [≤ 4 × {source_media_id, role, source_url}]}
 *                                       → {media: [{source_media_id, status, r2_key, width, height, error_code?}]}
 *   POST /items/:sid/write              {lease_token, payload_sha256, payload, document_checks}
 *                                       → {product_id, slug, created | merged, counts, before_fp_equal, after_money_default,
 *                                          images: [{id, source_media_id, r2_key, sort_order, is_primary, option_value_id,
 *                                                    variant_id, color_id, binding_rule}]}
 *                                       (`images`: the rows the write bound AFTER the content-duplicate collapse, §C.4
 *                                       step 1 — the gallery VERIFY expects, gallery.ts)
 *   POST /items/:sid/publish-finish     {lease_token}            → {state}
 *   GET  /items/:sid/readback                                    → {ok, mismatches, …}
 *   POST /items/:sid/complete           {lease_token, live_url, edge_evidence} → {state, seq?, d1_checks?}
 *   POST /items/:sid/withdraw           {approval_ref, evidence} → {state}
 *   POST /run/prepare-taxonomy          {}                       → {created_nodes?, brand_created?, synonyms_inserted?}
 *   POST /run/protect-snapshot          {phase: 'before'|'after'} → {subjects?, changed?}
 *   POST /run/finish                    {}                       → {state: 'closed'|'partial'}
 *   POST /run/translations              {part, text}             → {part, skipped, rows, inserted, updated, unchanged, refs_added,
 *                                                                   purge_ids, purge_truncated, purged_products}
 *                                       (one committed part of the translation memory, I18N-DESIGN §A.4: its exact text,
 *                                       proved by the Worker against its bundled index; idempotent by the part's ledger)
 *   GET  /run/status                                             → {run, counts, current, next, last_verified_url, …progress fields}
 *
 * The delta run (workflow 60 mode=delta, spec §O):
 *
 *   POST /delta/plan                    {from_run, sitemap_handles}  → {from_run, new_handles, media: [{source_product_id, handle, failed}], counts}
 *   POST /delta/manifest                {from_run, rows: [≤ 100 × {kind, source_product_id, handle?, route?, discovered_at}]}
 *                                       → {accepted, new, media}
 *   GET  /delta/rows                                             → {rows: [{kind, from_run, source_product_id, handle, canonical_url,
 *                                                                   type, route, queue_position, leaf, also}]}
 *   POST /items/:sid/media-plan         {lease_token, payload}   → {payload_sha256, media: [{source_media_id, role, source_url}], skipped, failed}
 *   POST /items/:sid/media-attach       {lease_token, payload_sha256, payload} → {product_id, slug, counts, rows, swatches}
 *   POST /items/:sid/media-complete     {lease_token, live_url, edge_evidence} → {state, seq?, d1_checks?}
 *
 * Every body is JSON ≤ 2 MB. Errors are `{code, message}`; a token that is
 * revoked, expired or whose run is closed gets the uniform 404 `{error}`.
 *
 * CLASSIFICATION (§B.5). Network errors, 5xx, 429 (Retry-After honoured),
 * SQLITE_BUSY / overload and media timeouts are TRANSIENT; a code of the §B.5
 * blocker table is PERMANENT (the item goes BLOCKED with that code); the
 * uniform 404 is GONE (the job stops: no token, no run); IMPORT_LEASE_LOST and
 * IMPORT_ILLEGAL_TRANSITION mean the runner's view is stale: it re-leases.
 * Idempotent calls are retried in-call (3 attempts, deadline-checked); a
 * non-idempotent one (`/write`, `/event`, `/complete` …) never is: an
 * ambiguous failure is reported as such and the runner asks `/lease` what
 * committed (§A.7). A 429 (the handler never ran) is retried in-call for a
 * non-idempotent call too, except `/write`: rule 2 is checked again first.
 */
import type { ImportPayload } from '@levonis/catalog/bambuImport/payload';
import { Deadline, retryAfterMs, type Clock } from './deadline';
import { USER_AGENT, type FetchLike } from './fetch';

export const OPS_PATH = '/api/ops/catalog-import';
export const PROTOCOL = 2;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const IN_CALL_ATTEMPTS = 3;
const CALL_TIMEOUT_MS = 100_000;

/** The permanent codes of §B.5 (the item goes BLOCKED with one of these). */
export const BLOCKER_CODES: ReadonlySet<string> = new Set([
  'ACCESS_CHALLENGE',
  'SOURCE_WITHDRAWN',
  'IDENTITY_AMBIGUOUS',
  'REVIEWED_SCOPE_REFUSED',
  'REVIEWED_BUNDLE_MISMATCH',
  'TAXONOMY_UNMAPPED',
  'PAYLOAD_REFUSED',
  'PLAN_TOO_LARGE',
  'ROW_CAP',
  'PRIMARY_MEDIA_FAILED',
  'MEDIA_HOST_NOT_ALLOWED',
  'PROTECTED_FIELDS_CHANGED',
  'IMPORT_FINANCIAL_WRITE_REFUSED',
  'VERIFY_FAILED_PERSISTENT',
  'CURATION_MISSING',
  'OWNER_HIDDEN',
  'ORDER_TYPE_WORD',
  'RETRIES_EXHAUSTED',
]);

/** Codes the Worker answers for a passing condition (§B.5 transient list). */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'SQLITE_BUSY',
  'D1_BUSY',
  'D1_OVERLOADED',
  'OVERLOADED',
  'RATE_LIMITED',
  'MEDIA_TIMEOUT',
  'CURATION_PENDING',
  'VERIFY_STALE',
  // The write committed but its read-back has not run yet; the media storage did not answer (both 503).
  'IMPORT_READBACK_PENDING',
  'IMPORT_STORAGE_UNAVAILABLE',
  // An R2 error under /write, /complete or /media (writer lane, 503): the storage, not the image, failed.
  'IMAGE_STORAGE_FAILED',
]);

/** The Worker's code → the code the runner records. `IMPORT_` codes of §C.11 name the same blockers. */
export function normaliseCode(code: string): string {
  if (code === 'IMPORT_PAYLOAD_KEY_REFUSED') return 'PAYLOAD_REFUSED';
  if (code === 'IMPORT_FINANCIAL_WRITE_REFUSED') return code;
  if (code.startsWith('IMPORT_') && BLOCKER_CODES.has(code.slice(7))) return code.slice(7);
  return code;
}

export type OpsErrorKind = 'transient' | 'permanent' | 'gone' | 'stale';

export class OpsError extends Error {
  constructor(
    readonly call: string,
    readonly kind: OpsErrorKind,
    readonly code: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
    /** True when a non-idempotent request may have reached the Worker: ask /lease what committed. */
    readonly ambiguous = false
  ) {
    super(`ops ${call}: ${code} (HTTP ${status})`);
    this.name = 'OpsError';
  }
}

/** §B.5: what one answer means. */
export function classify(status: number, code: string): OpsErrorKind {
  if (status === 404 && code === '') return 'gone';
  if (status === 429 || status >= 500) return 'transient';
  const c = normaliseCode(code);
  if (TRANSIENT_CODES.has(c)) return 'transient';
  if (c === 'IMPORT_LEASE_LOST' || c === 'IMPORT_ILLEGAL_TRANSITION') return 'stale';
  return 'permanent';
}

// ------------------------------------------------------------------ the answers

export interface HelloAnswer {
  protocol: number;
  expected_migration: string;
  migrations_present: Record<string, boolean>;
  reviewed: Record<string, string>;
  /** `delta`: the run holds delta items (§O) — the runner reads /delta/rows before its queue. */
  run: { id: string; state: string; cursor: number | null; delta: boolean };
  worker_build: string;
}

export interface ItemRef {
  source_product_id: string;
  handle: string;
  queue_position: number;
  state: string;
  last_completed_stage: string;
}

/**
 * A DISCOVERED item the bundled manifest holds (an end-of-queue hold, §K.2 step 13): it waits for the owner, not the
 * queue. `/run/status` lists them as `held` and `/run/finish` closes the run partial around them and names them.
 * Only the source id, the position and the code are read; the reviewed manifest names the item.
 */
export interface HeldRef {
  source_product_id: string;
  queue_position: number;
  hold_code: string;
}

export interface StatusAnswer {
  run: { id: string; state: string } | null;
  counts: Record<string, number>;
  current: ItemRef | null;
  next: ItemRef | null;
  /** The held items (none from a Worker that does not send them). */
  held: HeldRef[];
  last_verified_url: string;
  /** The §H.3 progress fields, when the Worker sends them (counts only). */
  progress: Record<string, unknown>;
}

export interface LeaseAnswer {
  lease_token: string;
  state: string;
  last_completed_stage: string;
  attempts: number;
  stage_attempts: number;
  retry_at: string;
  stage_data: Record<string, unknown>;
  blocker_code: string;
  levonis_product_id: string;
  slug: string;
  payload_sha256: string;
}

export interface EventAnswer {
  state: string;
  last_completed_stage: string;
  stage_attempts: number;
  seq: number | null;
}

export interface StageAnswer {
  payload_sha256: string;
  invocation_estimate: number;
  conflicts: unknown[];
  warnings: unknown[];
}

export type MediaRole = 'gallery' | 'swatch' | 'description' | 'in_the_box';
export interface MediaRequest {
  source_media_id: string;
  role: MediaRole;
  source_url: string;
}
export interface MediaAnswerRow {
  source_media_id: string;
  status: 'stored' | 'failed' | 'omitted_cap' | 'pending';
  r2_key: string;
  width: number | null;
  height: number | null;
  error_code: string;
}

export interface WriteAnswer {
  product_id: string;
  slug: string;
  created: boolean;
  counts: Record<string, number>;
  before_fp_equal: boolean | null;
  after_money_default: boolean | null;
  /** The image rows the write bound, after the content-duplicate collapse; null when the answer names none. */
  images: WrittenImage[] | null;
}

/**
 * One image row as the Worker wrote it (worker/lib/catalogImport/writer.ts ImportWriteResult.images): a payload
 * image on its stored object, after the content-duplicate collapse (§C.4 step 1) — a payload image absent from the
 * list was collapsed into the earlier copy of the same bytes; a later bound copy took that position
 * (`binding_rule 'content_duplicate'`).
 */
export interface WrittenImage {
  id: string;
  source_media_id: string;
  r2_key: string;
  sort_order: number;
  is_primary: boolean;
  option_value_id: string | null;
  variant_id: string | null;
  color_id: string | null;
  binding_rule: string;
}

export interface DocumentCheck {
  document_id: string;
  check_status: number;
  content_type: string;
  byte_size: number | null;
  content_sha256: string;
  checked_at: string;
  tracker_source: string;
}

export interface EventBody {
  state: string;
  outcome: 'start' | 'ok' | 'retry' | 'blocked' | 'resume' | 'info';
  code?: string;
  message?: string;
  retry_at?: string;
  release?: boolean;
  detail?: Record<string, unknown>;
}

// ------------------------------------------------------------------ readers

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The written image rows of a /write answer (or of what the Worker records of it): null unless `raw` is a list
 * whose every entry names an id, a source medium and a stored key — a half-read gallery is never an expectation.
 */
export function writtenImagesOf(raw: unknown): WrittenImage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WrittenImage[] = [];
  for (const r of raw) {
    if (!isRec(r) || !str(r.id) || !str(r.source_media_id) || !str(r.r2_key) || typeof r.sort_order !== 'number') return null;
    out.push({
      id: str(r.id),
      source_media_id: str(r.source_media_id),
      r2_key: str(r.r2_key),
      sort_order: r.sort_order,
      is_primary: r.is_primary === true || r.is_primary === 1,
      option_value_id: idOrNull(r.option_value_id),
      variant_id: idOrNull(r.variant_id),
      color_id: idOrNull(r.color_id),
      binding_rule: str(r.binding_rule),
    });
  }
  return out;
}

/**
 * stage_data.documents_inactive: the payload document ids the write stored inactive (a dead link at the checks it
 * was sent), recorded in its checkpoint for a VERIFY resumed in a later job. null when the Worker records none (one
 * before review 2 of step 8) or the record is not a list of ids.
 */
export function writtenDocumentsOf(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 400) return null;
  return raw.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 80) ? (raw as string[]) : null;
}

function heldRefs(v: unknown): HeldRef[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRec).flatMap((r) => {
    const sid = str(r.source_product_id);
    return sid ? [{ source_product_id: sid, queue_position: num(r.queue_position), hold_code: str(r.hold_code) }] : [];
  });
}

function itemRef(v: unknown): ItemRef | null {
  if (!isRec(v)) return null;
  const sid = str(v.source_product_id);
  if (!sid) return null;
  return {
    source_product_id: sid,
    handle: str(v.handle),
    queue_position: num(v.queue_position, -1),
    state: str(v.state) || str(v.processing_state),
    last_completed_stage: str(v.last_completed_stage),
  };
}

const SID = /^[0-9]{1,20}$/;
const TOKEN = /^[0-9a-f]{64}$/;

/** A delta run's item as `/delta/rows` answers it (the runner's view of rows the reviewed manifest may not hold). */
export interface DeltaRowView {
  kind: 'new' | 'media';
  from_run: string;
  source_product_id: string;
  handle: string;
  canonical_url: string;
  type: string;
  route: string;
  queue_position: number;
  /** A new product's section: the reviewed map's resolution of its route (catalog ids); '' for a media item. */
  leaf: string;
  also: string[];
}

export interface DeltaPlanAnswer {
  from_run: string;
  new_handles: string[];
  media: Array<{ source_product_id: string; handle: string; failed: number }>;
  counts: Record<string, number>;
}

export interface MediaPlanAnswer {
  payload_sha256: string;
  media: MediaRequest[];
  skipped: Record<string, number>;
  failed: number;
}

/** The rows a media-only stage attached (stage_data.media_retry, or the /media-attach answer). */
export interface AttachedMedia {
  rows: Array<{ id: string; r2_key: string }>;
  swatches: Array<{ option_value_id: string; r2_key: string }>;
}

export interface MediaAttachAnswer extends AttachedMedia {
  product_id: string;
  slug: string;
  counts: Record<string, number>;
}

const numbers = (v: unknown): Record<string, number> =>
  isRec(v) ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'number' && Number.isFinite(x))) as Record<string, number>) : {};

/** The attached rows of stage_data.media_retry or of a /media-attach answer; null unless every entry is whole. */
export function attachedMediaOf(raw: unknown): AttachedMedia | null {
  if (!isRec(raw) || !Array.isArray(raw.rows) || !Array.isArray(raw.swatches)) return null;
  const rows: AttachedMedia['rows'] = [];
  for (const r of raw.rows) {
    if (!isRec(r) || !str(r.id) || !str(r.r2_key)) return null;
    rows.push({ id: str(r.id), r2_key: str(r.r2_key) });
  }
  const swatches: AttachedMedia['swatches'] = [];
  for (const r of raw.swatches) {
    if (!isRec(r) || !str(r.option_value_id) || !str(r.r2_key)) return null;
    swatches.push({ option_value_id: str(r.option_value_id), r2_key: str(r.r2_key) });
  }
  return { rows, swatches };
}

function deltaRowOf(v: unknown): DeltaRowView | null {
  if (!isRec(v)) return null;
  const kind = v.kind === 'new' || v.kind === 'media' ? v.kind : null;
  const sid = str(v.source_product_id);
  if (!kind || !SID.test(sid)) return null;
  return {
    kind,
    from_run: str(v.from_run),
    source_product_id: sid,
    handle: str(v.handle),
    canonical_url: str(v.canonical_url),
    type: str(v.type),
    route: str(v.route),
    queue_position: num(v.queue_position, -1),
    leaf: str(v.leaf),
    also: Array.isArray(v.also) ? v.also.filter((x): x is string => typeof x === 'string') : [],
  };
}

function mediaRequestOf(v: unknown): MediaRequest | null {
  if (!isRec(v)) return null;
  const role = str(v.role);
  if (role !== 'gallery' && role !== 'swatch') return null;
  const id = str(v.source_media_id);
  const url = str(v.source_url);
  return id && url ? { source_media_id: id, role, source_url: url } : null;
}

export interface OpsClientOptions {
  /** The public site origin (https://levonis-iq.com; http://127.0.0.1:<port> in a local dry run). */
  siteOrigin: string;
  token: string;
  fetch: FetchLike;
  clock: Clock;
  deadline: Deadline;
  githubRunId?: string;
  codeCommit?: string;
  /** Every call, as sent (tests): method, path, the body's keys. */
  onCall?: (method: string, path: string, body: Rec | null) => void;
  /** An item call that renewed the item's lease answered 2xx (every item call with the lease renews it, §A.7). */
  onRenewed?: (sid: string) => void;
}

/** The item calls that take or renew the lease (the Worker's holdLease / leaseItem). */
const LEASE_CALL = /^\/items\/(\d{1,20})\/(?:lease|event|stage|media|write|publish-finish|complete|media-plan|media-attach|media-complete)$/;

/** `/run/translations`'s answer, as far as the runner reads it (counts; the purged ids stay in the Worker's answer). */
export interface TranslationsAnswer {
  part: string;
  skipped: boolean;
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  refs_added: number;
  purge_truncated: boolean;
  purged_products: number;
}

export class OpsClient {
  private readonly base: string;
  private readonly token: string;

  constructor(private readonly opts: OpsClientOptions) {
    if (!TOKEN.test(opts.token)) throw new Error('the import token is not 64 lowercase hex characters');
    this.base = `${opts.siteOrigin.replace(/\/+$/, '')}${OPS_PATH}`;
    this.token = opts.token;
  }

  /**
   * `retry429`: a non-idempotent call that answered 429 never reached the Worker's handler, so it may be sent
   * again in the call — except `/write`, whose retry must pass rule 2 (§A.7) again: its 429 goes to the stage's
   * own retry, which checks the 13 minutes before it sends anything.
   */
  private async send(call: string, method: 'GET' | 'POST', path: string, body: Rec | null, idempotent: boolean, retry429 = true): Promise<Rec> {
    const text = body === null ? undefined : JSON.stringify(body);
    if (text !== undefined && Buffer.byteLength(text) > MAX_BODY_BYTES) throw new OpsError(call, 'permanent', 'PLAN_TOO_LARGE', 413);
    for (let attempt = 0; ; attempt++) {
      this.opts.onCall?.(method, path, body);
      let status = 0;
      let answer: Rec = {};
      let retryAfter: number | null = null;
      let failed: OpsError | null = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
      try {
        const res = await this.opts.fetch(`${this.base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'X-Levonis-Import-Protocol': String(PROTOCOL),
            Accept: 'application/json',
            ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}),
            'User-Agent': USER_AGENT,
          },
          body: text,
          redirect: 'manual',
          credentials: 'omit',
          signal: controller.signal,
        });
        status = res.status;
        retryAfter = retryAfterMs(res.headers.get('retry-after'), this.opts.clock.now());
        const raw = await res.text();
        try {
          const parsed: unknown = raw ? JSON.parse(raw) : {};
          answer = isRec(parsed) ? parsed : {};
        } catch {
          answer = {};
          if (status >= 200 && status < 300) failed = new OpsError(call, 'transient', 'OPS_BAD_ANSWER', status, null, !idempotent);
        }
      } catch {
        // No answer: the request may or may not have reached the Worker.
        failed = new OpsError(call, 'transient', 'OPS_UNREACHABLE', 0, null, !idempotent);
      } finally {
        clearTimeout(timer);
      }
      if (!failed && status >= 200 && status < 300) {
        const renewed = LEASE_CALL.exec(path);
        if (renewed) this.opts.onRenewed?.(renewed[1]);
        return answer;
      }
      if (!failed) {
        const code = str(answer.code);
        const kind = classify(status, code);
        failed = new OpsError(call, kind, kind === 'gone' ? 'OPS_GONE' : normaliseCode(code) || `HTTP_${status}`, status, retryAfter, kind === 'transient' && status >= 500 && !idempotent);
      }
      const canRetry = failed.kind === 'transient' && (idempotent || (retry429 && !failed.ambiguous && failed.status === 429)) && attempt + 1 < IN_CALL_ATTEMPTS;
      if (!canRetry) throw failed;
      const wait = failed.retryAfterMs ?? 2000 * 2 ** attempt;
      if (!this.opts.deadline.fits(wait, 60_000)) throw failed;
      await this.opts.clock.sleep(wait);
    }
  }

  private sidPath(sid: string, tail: string): string {
    if (!SID.test(sid)) throw new OpsError(tail, 'permanent', 'BAD_SOURCE_ID', 0);
    return `/items/${sid}/${tail}`;
  }

  async hello(): Promise<HelloAnswer> {
    const a = await this.send('hello', 'POST', '/hello', { protocol: PROTOCOL, github_run_id: this.opts.githubRunId ?? '', code_commit: this.opts.codeCommit ?? '' }, true);
    const run = isRec(a.run) ? a.run : {};
    const present = isRec(a.migrations_present) ? a.migrations_present : {};
    const reviewed = isRec(a.reviewed) ? a.reviewed : {};
    return {
      protocol: num(a.protocol, -1),
      expected_migration: str(a.expected_migration),
      migrations_present: Object.fromEntries(Object.entries(present).map(([k, v]) => [k, v === true])),
      reviewed: Object.fromEntries(Object.entries(reviewed).filter(([, v]) => typeof v === 'string') as Array<[string, string]>),
      run: { id: str(run.id), state: str(run.state), cursor: typeof run.cursor === 'number' ? run.cursor : null, delta: run.delta === true },
      worker_build: str(a.worker_build),
    };
  }

  async manifest(rows: readonly Rec[]): Promise<{ accepted: number }> {
    if (rows.length > 100) throw new OpsError('manifest', 'permanent', 'MANIFEST_BATCH_TOO_LARGE', 0);
    const a = await this.send('manifest', 'POST', '/manifest', { rows: rows as Rec[] }, true);
    return { accepted: num(a.accepted, rows.length) };
  }

  async lease(sid: string, leaseToken = ''): Promise<LeaseAnswer> {
    const a = await this.send('lease', 'POST', this.sidPath(sid, 'lease'), { lease_token: leaseToken }, true);
    return {
      lease_token: str(a.lease_token),
      state: str(a.state),
      last_completed_stage: str(a.last_completed_stage),
      attempts: num(a.attempts),
      stage_attempts: num(a.stage_attempts),
      retry_at: str(a.retry_at),
      stage_data: isRec(a.stage_data) ? a.stage_data : {},
      blocker_code: str(a.blocker_code),
      levonis_product_id: str(a.levonis_product_id),
      slug: str(a.slug),
      payload_sha256: str(a.payload_sha256),
    };
  }

  async event(sid: string, leaseToken: string, body: EventBody): Promise<EventAnswer> {
    const a = await this.send('event', 'POST', this.sidPath(sid, 'event'), {
      lease_token: leaseToken,
      state: body.state,
      outcome: body.outcome,
      code: body.code ?? '',
      message: body.message ?? '',
      retry_at: body.retry_at ?? '',
      release: body.release === true,
      detail: body.detail ?? {},
    }, false);
    return {
      state: str(a.state),
      last_completed_stage: str(a.last_completed_stage),
      stage_attempts: num(a.stage_attempts),
      seq: typeof a.seq === 'number' ? a.seq : null,
    };
  }

  async stage(sid: string, leaseToken: string, payload: ImportPayload, documentChecks: readonly DocumentCheck[]): Promise<StageAnswer> {
    const a = await this.send('stage', 'POST', this.sidPath(sid, 'stage'), { lease_token: leaseToken, payload: payload as unknown as Rec, document_checks: documentChecks as unknown as Rec[] }, true);
    return {
      payload_sha256: str(a.payload_sha256),
      invocation_estimate: num(a.invocation_estimate),
      conflicts: Array.isArray(a.conflicts) ? a.conflicts : [],
      warnings: Array.isArray(a.warnings) ? a.warnings : [],
    };
  }

  async media(sid: string, leaseToken: string, media: readonly MediaRequest[]): Promise<MediaAnswerRow[]> {
    if (media.length === 0 || media.length > 4) throw new OpsError('media', 'permanent', 'MEDIA_BATCH_SIZE', 0);
    const a = await this.send('media', 'POST', this.sidPath(sid, 'media'), { lease_token: leaseToken, media: media as unknown as Rec[] }, true);
    const rows = Array.isArray(a.media) ? a.media : [];
    return rows.filter(isRec).map((r) => {
      const status = str(r.status);
      return {
        source_media_id: str(r.source_media_id),
        status: status === 'stored' || status === 'failed' || status === 'omitted_cap' ? status : 'pending',
        r2_key: str(r.r2_key),
        width: typeof r.width === 'number' ? r.width : null,
        height: typeof r.height === 'number' ? r.height : null,
        error_code: str(r.error_code),
      };
    });
  }

  async write(sid: string, leaseToken: string, payloadSha256: string, payload: ImportPayload, documentChecks: readonly DocumentCheck[]): Promise<WriteAnswer> {
    const a = await this.send(
      'write',
      'POST',
      this.sidPath(sid, 'write'),
      { lease_token: leaseToken, payload_sha256: payloadSha256, payload: payload as unknown as Rec, document_checks: documentChecks as unknown as Rec[] },
      false,
      false
    );
    const counts = isRec(a.counts) ? Object.fromEntries(Object.entries(a.counts).filter(([, v]) => typeof v === 'number') as Array<[string, number]>) : {};
    // `created: true` or `match_kind: 'created'` (the §A.3 answer names it either way); a merge says `merged`.
    const created = a.created === true || str(a.match_kind) === 'created';
    return {
      product_id: str(a.product_id),
      slug: str(a.slug),
      created,
      counts,
      before_fp_equal: bool(a.before_fp_equal),
      after_money_default: bool(a.after_money_default),
      images: writtenImagesOf(a.images),
    };
  }

  async publishFinish(sid: string, leaseToken: string): Promise<{ state: string }> {
    const a = await this.send('publish-finish', 'POST', this.sidPath(sid, 'publish-finish'), { lease_token: leaseToken }, true);
    return { state: str(a.state) };
  }

  async readback(sid: string): Promise<{ ok: boolean; mismatches: number; raw: Rec }> {
    const a = await this.send('readback', 'GET', this.sidPath(sid, 'readback'), null, true);
    return { ok: a.ok === true, mismatches: num(a.mismatches), raw: a };
  }

  async complete(sid: string, leaseToken: string, liveUrl: string, edgeEvidence: Rec): Promise<{ state: string; seq: number | null; d1_checks: Rec }> {
    const a = await this.send('complete', 'POST', this.sidPath(sid, 'complete'), { lease_token: leaseToken, live_url: liveUrl, edge_evidence: edgeEvidence }, false);
    return { state: str(a.state), seq: typeof a.seq === 'number' ? a.seq : null, d1_checks: isRec(a.d1_checks) ? a.d1_checks : {} };
  }

  async withdraw(sid: string, approvalRef: string, evidence: Rec): Promise<{ state: string }> {
    const a = await this.send('withdraw', 'POST', this.sidPath(sid, 'withdraw'), { approval_ref: approvalRef, evidence }, false);
    return { state: str(a.state) };
  }

  async prepareTaxonomy(): Promise<{ created_nodes: number; brand_created: boolean; synonyms_inserted: number }> {
    const a = await this.send('run/prepare-taxonomy', 'POST', '/run/prepare-taxonomy', {}, true);
    return { created_nodes: num(a.created_nodes), brand_created: a.brand_created === true, synonyms_inserted: num(a.synonyms_inserted) };
  }

  async protectSnapshot(phase: 'before' | 'after'): Promise<{ subjects: number; changed: number | null }> {
    const a = await this.send('run/protect-snapshot', 'POST', '/run/protect-snapshot', { phase }, true);
    return { subjects: num(a.subjects), changed: typeof a.changed === 'number' ? a.changed : null };
  }

  /** closed, or partial (BLOCKED, withdrawn or held items); the held ones named by source id. */
  async finish(): Promise<{ state: string; held: HeldRef[] }> {
    const a = await this.send('run/finish', 'POST', '/run/finish', {}, false);
    return { state: str(a.state), held: heldRefs(a.held) };
  }

  /**
   * One committed part of the translation memory (I18N-DESIGN §A.4): the file's exact text. Idempotent (the Worker
   * skips a part its ledger already holds), so it is retried in-call like any idempotent call. Counts only come back.
   */
  async loadTranslations(part: string, text: string): Promise<TranslationsAnswer> {
    if (!/^p[0-9]{3,}$/.test(part)) throw new OpsError('run/translations', 'permanent', 'IMPORT_BAD_REQUEST', 0);
    const a = await this.send('run/translations', 'POST', '/run/translations', { part, text }, true);
    return {
      part: str(a.part),
      skipped: a.skipped === true,
      rows: num(a.rows),
      inserted: num(a.inserted),
      updated: num(a.updated),
      unchanged: num(a.unchanged),
      refs_added: num(a.refs_added),
      purge_truncated: a.purge_truncated === true,
      purged_products: num(a.purged_products),
    };
  }

  // ---------------------------------------------------------------- the delta run (§O)

  async deltaPlan(fromRun: string, sitemapHandles: readonly string[]): Promise<DeltaPlanAnswer> {
    const a = await this.send('delta/plan', 'POST', '/delta/plan', { from_run: fromRun, sitemap_handles: [...sitemapHandles] }, true);
    const media = Array.isArray(a.media) ? a.media.filter(isRec) : [];
    return {
      from_run: str(a.from_run),
      new_handles: Array.isArray(a.new_handles) ? a.new_handles.filter((h): h is string => typeof h === 'string') : [],
      media: media.flatMap((m) => (SID.test(str(m.source_product_id)) ? [{ source_product_id: str(m.source_product_id), handle: str(m.handle), failed: num(m.failed) }] : [])),
      counts: numbers(a.counts),
    };
  }

  /**
   * Idempotent: a row registered already keeps its position (the Worker answers it accepted again). A row the Worker
   * finds moot is left out and counted in `skipped` (counts only).
   */
  async deltaManifest(
    fromRun: string,
    rows: readonly Rec[]
  ): Promise<{ accepted: number; new: number; media: number; skipped: { known: number; media_product_gone: number; media_already_retried: number } }> {
    if (rows.length > 100) throw new OpsError('delta/manifest', 'permanent', 'MANIFEST_BATCH_TOO_LARGE', 0);
    const a = await this.send('delta/manifest', 'POST', '/delta/manifest', { from_run: fromRun, rows: rows as Rec[] }, true);
    const k = isRec(a.skipped) ? a.skipped : {};
    return {
      accepted: num(a.accepted),
      new: num(a.new),
      media: num(a.media),
      skipped: { known: num(k.known), media_product_gone: num(k.media_product_gone), media_already_retried: num(k.media_already_retried) },
    };
  }

  async deltaRows(): Promise<DeltaRowView[]> {
    const a = await this.send('delta/rows', 'GET', '/delta/rows', null, true);
    return (Array.isArray(a.rows) ? a.rows : []).flatMap((r) => {
      const row = deltaRowOf(r);
      return row ? [row] : [];
    });
  }

  /** Idempotent: it records the payload's digest again and answers the same plan for the same page. */
  async mediaPlan(sid: string, leaseToken: string, payload: ImportPayload): Promise<MediaPlanAnswer> {
    const a = await this.send('media-plan', 'POST', this.sidPath(sid, 'media-plan'), { lease_token: leaseToken, payload: payload as unknown as Rec }, true);
    return {
      payload_sha256: str(a.payload_sha256),
      media: (Array.isArray(a.media) ? a.media : []).flatMap((m) => {
        const r = mediaRequestOf(m);
        return r ? [r] : [];
      }),
      skipped: numbers(a.skipped),
      failed: num(a.failed),
    };
  }

  /** Not idempotent in the call: an ambiguous failure asks /lease what committed (the batch moves the item on). */
  async mediaAttach(sid: string, leaseToken: string, payloadSha256: string, payload: ImportPayload): Promise<MediaAttachAnswer> {
    const a = await this.send('media-attach', 'POST', this.sidPath(sid, 'media-attach'), { lease_token: leaseToken, payload_sha256: payloadSha256, payload: payload as unknown as Rec }, false);
    const rows = attachedMediaOf(a) ?? { rows: [], swatches: [] };
    return { product_id: str(a.product_id), slug: str(a.slug), counts: numbers(a.counts), ...rows };
  }

  async mediaComplete(sid: string, leaseToken: string, liveUrl: string, evidence: Rec): Promise<{ state: string; seq: number | null; d1_checks: Rec }> {
    const a = await this.send('media-complete', 'POST', this.sidPath(sid, 'media-complete'), { lease_token: leaseToken, live_url: liveUrl, edge_evidence: evidence }, false);
    return { state: str(a.state), seq: typeof a.seq === 'number' ? a.seq : null, d1_checks: isRec(a.d1_checks) ? a.d1_checks : {} };
  }

  async status(): Promise<StatusAnswer> {
    const a = await this.send('run/status', 'GET', '/run/status', null, true);
    const run = isRec(a.run) ? { id: str(a.run.id), state: str(a.run.state) } : null;
    const counts = isRec(a.counts) ? Object.fromEntries(Object.entries(a.counts).filter(([, v]) => typeof v === 'number') as Array<[string, number]>) : {};
    const known = new Set(['run', 'counts', 'current', 'next', 'held', 'last_verified_url']);
    return {
      run,
      counts,
      current: itemRef(a.current),
      next: itemRef(a.next),
      held: heldRefs(a.held),
      last_verified_url: str(a.last_verified_url),
      progress: Object.fromEntries(Object.entries(a).filter(([k]) => !known.has(k))),
    };
  }
}
