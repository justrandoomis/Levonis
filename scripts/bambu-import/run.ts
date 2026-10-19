/**
 * THE IMPORT RUNNER (Bambu import spec §A.1, §A.7, §A.9, §B.5, §I, §J; build step 8).
 *
 * Run by workflow 60's importer step: `node --import tsx scripts/bambu-import/run.ts`.
 * It never holds a Cloudflare credential. Its only door to production is the
 * ops endpoint, through a per-job token it reads from a 0600 file and deletes
 * at once (IMPORT_TOKEN_FILE). Every artifact it produces is sealed in memory
 * to the dispatch's one-time key; only `*.sealed` files reach the disk.
 *
 * THE LOOP (§A.1), ONE item at a time:
 *
 *   lease ─► EXTRACT (store page: only after the previous COMPLETE has
 *   committed, ≥ 11 s after the last store request; robots.txt read once per
 *   job) ─► ENRICH ─► VALIDATE (local) ─► /stage ─► /media (≤ 4 per call)
 *   ─► /write (only with ≥ 13 min left) ─► /publish-finish ─► VERIFY (the
 *   public site) ─► /complete ─► next item.
 *
 * A BLOCKED item stops the loop (no SKIP exists). Every wait is checked
 * against the absolute deadline; a wait that does not fit releases the lease
 * (event RETRYING with retry_at) and the job exits `more=true blocked=false`,
 * so the chain job continues. The durable state is D1; this process keeps
 * nothing it cannot rebuild (a resumed item re-reads its page, and VERIFY
 * checks that the rebuilt payload is, digest for digest, the one written).
 *
 * THE LEASE IS KEPT WHILE THE RUNNER WAITS. The Worker's lease lasts 15
 * minutes and every item call renews it; every sleep of this job (a backoff,
 * a Retry-After honoured in a call, the store's spacing, the cache wait, the
 * wait for a RETRYING item's retry time) goes through `pause`, which renews
 * the lease with `/lease` so that no 10 minutes pass without a renewal. A
 * transition outside a stage's own retries (start, resume, retry, park,
 * blocked) that fails transiently asks `/lease` what committed and is retried
 * within the deadline rules; if it never settles, the item is left to the
 * next job (`more=true`), never reported BLOCKED.
 *
 * Modes (workflow 60 §K.3): preflight (public checks), open (hello, the
 * manifest, the taxonomy, the protected snapshot `before`), run, close (§A.9,
 * §I.3), withdraw, delta (§O: a NEW run whose queue is the closed run's
 * completed items with failed media — a media-only stage — then the products
 * the sitemaps list that no run ever held; then the queue, as in run; with
 * item=content, §O.6: a NEW run of content items only, the closed run's failed
 * description and in-the-box pictures put where the import meant them).
 * snapshot, report, revoke and dryrun need no importer.
 *
 * Outputs (GITHUB_OUTPUT): more, blocked, run_id.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, mediaPath } from '@levonis/catalog/bambuImport/fingerprint';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractPage, identityCrossCheck, type Extraction } from '@levonis/catalog/bambuImport/extract';
import { extractionFingerprint } from '@levonis/catalog/bambuImport/fingerprint';
import { assertImportPayload, buildImportPayload, ImportPayloadRefused, type BuildResult, type ImportPayload } from '@levonis/catalog/bambuImport/payload';
import { productTypeOf } from '@levonis/catalog/bambuImport/registry/types';
import { rewritesOnResume, type MergeMatch } from '@levonis/catalog/bambuImport/merge';
import { backoff, Deadline, MAX_STAGE_ATTEMPTS, parseDeadlineEpoch, realClock, WORST, type Clock, type WorstKey } from './deadline';
import {
  bundleDigest,
  DEFAULT_DATA_DIR,
  loadReviewedBundle,
  manifestBatches,
  parseSitemap,
  productHandles,
  rawHandleOf,
  reviewedDifferences,
  sitemapDiff,
  writeModeOf,
  type ManifestRow,
  type ReviewedBundle,
} from './discover';
import { curatedGate, enrich, type EnrichReport } from './enrich';
import { blockedStop, HostFetcher, ImportStop, StoreFetcher, transientStop, type FetchLike } from './fetch';
import { ImportLog, type LogStage } from './log';
import {
  attachedMediaOf,
  contentInsertedOf,
  OpsClient,
  OpsError,
  writtenDocumentsOf,
  writtenImagesOf,
  type AttachedMedia,
  type ContentInserted,
  type ContentPlanAnswer,
  type DeltaRowView,
  type DocumentCheck,
  type HeldRef,
  type MediaAnswerRow,
  type MediaPlanAnswer,
  type MediaRequest,
  type StatusAnswer,
  type WriteAnswer,
  type WrittenImage,
} from './opsClient';
import { writtenGallery, type Gallery } from './gallery';
import { NO_ROBOTS, parseRobots, robotsAllows, SITEMAP_PATHS, type Robots } from './robots';
import { renderSummary, SummaryWriter, type SummaryItem } from './summary';
import { AFTER_CACHE_WAIT, cacheWaitOf, edgeEvidence, modelCodesOf, publicBrandSweep, Site, siteFacts, verifyPublic, type VerifyContext, type VerifyOutcome } from './verify';
import type { BrowserInput, BrowserResult } from './browser';
// @ts-expect-error - plain ESM helper run by workflow 60, no types
import { sealBuffer } from './seal.mjs';

export const SITE_ORIGIN = 'https://levonis-iq.com';
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;

/**
 * A local dry run (§K step 10 (b) and (c): the site is http://127.0.0.1:<port>): the importer's own
 * requests reach 127.0.0.1 only. Anything else — a document check, a tracker, a wiki page on the store's
 * CDNs — is refused before it is sent (the check records it dead, as an unreachable host) and counted;
 * main() logs the count at the job's end, and the dry run requires that line.
 */
export function localOnlyFetch(inner: FetchLike, refused: { count: number }): FetchLike {
  return (url, init) => {
    let host = '';
    try {
      const u = new URL(url);
      host = u.protocol === 'http:' ? u.hostname : '';
    } catch {
      host = '';
    }
    if (host === '127.0.0.1') return inner(url, init);
    refused.count++;
    return Promise.reject(new TypeError('a local dry run sends no request off 127.0.0.1'));
  };
}
const MEDIA_SPACING_MS = 1000;
/** At most this many new products in one delta run (worker/lib/catalogImport/delta.ts DELTA_NEW_MAX). */
export const DELTA_NEW_MAX = 20;
const HELLO_EVERY = 50;
/** The wait before the run status is read again after /lease refused a queued item (another one is in flight). */
const LEASE_CLASH_WAIT_MS = 30_000;
/**
 * auto_withdraw's wait before the second fetch: the Worker takes an automatic withdrawal whose second fetch is at
 * least 60 s after the block (§1 row 20); the 10 s above it absorb the two clocks' difference.
 */
export const AUTO_WITHDRAW_WAIT_MS = 70_000;
/** The Worker's lease is 15 minutes; the runner renews it before 10 have passed since the last item call. */
/**
 * Catalog-only is live when the public context document (worker/lib/publicApi/meta.ts,
 * GET /api/public/v1/context) counts the priced products: `content.products_priced`, a number.
 * The document is the answer itself, with no `data` envelope.
 */
export function catalogOnlyLive(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const content = (doc as Record<string, unknown>).content;
  return !!content && typeof content === 'object' && typeof (content as Record<string, unknown>).products_priced === 'number';
}

export const LEASE_KEEP_MS = 10 * 60_000;
/** A transition outside a stage's retries: this many tries (30 s × 2^k apart) before the item is left to the next job. */
const TRANSITION_ATTEMPTS = 4;
/** How many times close asks /hello after /run/finish before the old token's end is recorded as unconfirmed. */
const TOKEN_GONE_ATTEMPTS = 5;
/** How many times close sends /run/finish when /hello says an unsettled one did not commit (the run still answers). */
const FINISH_ATTEMPTS = 3;

/** The Worker's `catalog_import_items.payload_sha256` of a payload (worker/lib/catalogImport/reviewed.ts payloadSha256). */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export const STAGES = ['EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING', 'PUBLISHING', 'VERIFYING_LIVE'] as const;
export type Stage = (typeof STAGES)[number];
const WORST_OF: Readonly<Record<Stage, WorstKey>> = {
  EXTRACTING: 'EXTRACT',
  ENRICHING: 'ENRICH',
  VALIDATING: 'VALIDATE',
  INGESTING_MEDIA: 'MEDIA_CALL',
  WRITING: 'WRITE',
  PUBLISHING: 'PUBLISH_FINISH',
  VERIFYING_LIVE: 'VERIFY',
};

/** The stage after `last_completed_stage` (the trigger's own CASE, §B.3). */
export function stageAfter(lastCompleted: string): Stage | null {
  if (lastCompleted === '') return 'EXTRACTING';
  const at = STAGES.indexOf(lastCompleted as Stage);
  return at >= 0 && at + 1 < STAGES.length ? STAGES[at + 1] : null;
}

/**
 * Where a BLOCKED item resumes: the stage after the last completed one — or WRITING again for a merge that VERIFY
 * failed after its write (@levonis/catalog/bambuImport/merge `rewritesOnResume`, the Worker's own rule in items.ts
 * `resumeRewrites`): writing it again is what applies a writer fix to an item already written.
 *
 * A media or content item of a delta run (§O.4, §O.6) never rewrites, whatever its product: it writes no product,
 * /write refuses it, and the Worker reads the merge from the item's own `match_kind`, which /media-attach and
 * /content-attach never set. Asking it for WRITING would be refused as an illegal transition at every resume, and
 * the item would stay BLOCKED for good. Only an ordinary item (`kind === 'item'`) may rewrite: a positive test, so a
 * kind added later never does by default.
 */
export function resumeTargetOf(w: { kind: ItemKind; merge: boolean; blockerCode: string; lastCompleted: string; productId: string }): Stage | null {
  if (w.kind === 'item' && rewritesOnResume({ blocker_code: w.blockerCode, last_completed_stage: w.lastCompleted, merge: w.merge, product_id: w.productId })) return 'WRITING';
  return stageAfter(w.lastCompleted);
}

/** What an item of the queue is: an ordinary item (or a delta's new product), a media-only item, a content item. */
export type ItemKind = 'item' | 'media' | 'content';

// ------------------------------------------------------------------ configuration

export type RunMode = 'preflight' | 'open' | 'run' | 'close' | 'withdraw' | 'delta';

export interface RunConfig {
  mode: RunMode;
  runId: string;
  maxItems: number;
  resume: boolean;
  chain: boolean;
  chainCount: number;
  /** mode=run or delta: the owner's standing approval (2026-10-18) withdraws a page gone at the source and goes on. */
  autoWithdraw: boolean;
  /** mode=delta: the closed run the delta is taken from (workflow 60 passes it as run_id); the new run is the opened one. */
  fromRun: string;
  /** mode=delta: '' or absent (pictures and new products, §O.1) or 'content' (the content pass, §O.6: item=content). */
  deltaPass?: '' | 'content';
  item: string;
  siteOrigin: string;
  storeOrigin: string;
  dataDir: string;
  outDir: string;
  sealKey: string;
  githubRunId: string;
  codeCommit: string;
  deadlineMs: number;
}

export class ConfigError extends Error {}

/** The importer's environment, every value validated before anything runs. */
export function configFromEnv(env: NodeJS.ProcessEnv, root: string): RunConfig {
  const mode = env.IN_MODE ?? '';
  if (!/^(preflight|open|run|close|withdraw|delta)$/.test(mode)) throw new ConfigError('the importer runs only in preflight, open, run, close, withdraw and delta modes');
  const given = env.IN_RUN_ID ?? '';
  if (given && !/^cir_[0-9a-f]{24}$/.test(given)) throw new ConfigError('run_id is not cir_ followed by 24 hex characters');
  // mode=delta: run_id names the CLOSED run the delta is taken from; the run this job works on is the one it opened.
  if (mode === 'delta' && !given) throw new ConfigError('delta needs the closed run it is taken from (run_id)');
  const runId = mode === 'delta' ? '' : given;
  const fromRun = mode === 'delta' ? given : '';
  const maxItems = env.IN_MAX_ITEMS ?? '1';
  if (!/^[0-9]{1,4}$/.test(maxItems)) throw new ConfigError('max_items is not a whole number');
  const chainCount = env.IN_CHAIN_COUNT ?? '0';
  if (!/^([0-9]|1[0-2])$/.test(chainCount)) throw new ConfigError('chain_count is not 0 to 12');
  // A bounded job (the canary, an audit class) is reviewed before the next one (§K.4): it never chains.
  if ((mode === 'run' || mode === 'delta') && env.IN_CHAIN === 'true' && Number(maxItems) !== 0) throw new ConfigError('chain runs only with max_items 0');
  const autoWithdraw = env.IN_AUTO_WITHDRAW === 'true';
  if (autoWithdraw && mode !== 'run' && mode !== 'delta') throw new ConfigError('auto_withdraw runs only in modes run and delta');
  const rawItem = env.IN_ITEM ?? '';
  // mode=delta reads `item` as its pass: empty (pictures and new products) or `content` (§O.6); nothing else.
  const deltaPass = mode === 'delta' && rawItem === 'content' ? 'content' : '';
  if (rawItem === 'content' && mode !== 'delta') throw new ConfigError('item=content runs only with mode delta');
  if (mode === 'delta' && rawItem && rawItem !== 'content') throw new ConfigError('delta takes item empty or content');
  const item = deltaPass ? '' : rawItem;
  if (item && !/^[0-9]{1,20}$/.test(item)) throw new ConfigError('item is not a source product id');
  const sealKey = env.IN_SEAL_PUBKEY ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(sealKey)) throw new ConfigError('seal_pubkey is not a one-time public key');
  const siteOrigin = (env.IMPORT_SITE_ORIGIN || SITE_ORIGIN).replace(/\/+$/, '');
  if (siteOrigin !== SITE_ORIGIN && !LOCAL_ORIGIN.test(siteOrigin)) throw new ConfigError('the site origin is the live site or a local dry run, nothing else');
  const storeOrigin = (env.IMPORT_STORE_ORIGIN || 'https://us.store.bambulab.com').replace(/\/+$/, '');
  if (storeOrigin !== 'https://us.store.bambulab.com' && !LOCAL_ORIGIN.test(storeOrigin)) throw new ConfigError('the store origin is the US store or a local dry run, nothing else');
  return {
    mode: mode as RunMode,
    runId,
    maxItems: Number(maxItems),
    resume: env.IN_RESUME === 'true',
    chain: env.IN_CHAIN === 'true',
    chainCount: Number(chainCount),
    autoWithdraw,
    fromRun,
    deltaPass,
    item,
    siteOrigin,
    storeOrigin,
    dataDir: resolve(root, env.IMPORT_DATA_DIR || DEFAULT_DATA_DIR),
    outDir: resolve(env.IMPORT_OUT_DIR || join(env.RUNNER_TEMP || resolve(root, '.bambu-import'), 'out')),
    sealKey,
    githubRunId: /^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? '') ? (env.GITHUB_RUN_ID as string) : '',
    codeCommit: /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ? (env.GITHUB_SHA as string) : '',
    deadlineMs: parseDeadlineEpoch(env.DEADLINE_EPOCH),
  };
}

/** Reads the job token from its 0600 file and deletes the file at once. */
export function takeToken(file: string | undefined): string {
  if (!file) throw new ConfigError('IMPORT_TOKEN_FILE is not set');
  if (!existsSync(file)) throw new ConfigError('the token file does not exist (the mint step did not run)');
  const mode = statSync(file).mode & 0o777;
  const text = readFileSync(file, 'utf8');
  rmSync(file, { force: true });
  if (mode & 0o077) throw new ConfigError('the token file is readable by others');
  const token = text.trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new ConfigError('the token file does not hold a 64-hex token');
  return token;
}

/**
 * A delta run's new product as a manifest row (§O.2): the source id, handle, route and type the Worker registered,
 * its section the reviewed map's resolution of that route (/delta/rows); nothing curated, held or reviewed beyond it.
 */
export function deltaManifestRowOf(d: Pick<DeltaRowView, 'source_product_id' | 'handle' | 'canonical_url' | 'type' | 'route' | 'queue_position' | 'leaf' | 'also'>): ManifestRow {
  return {
    queue_position: d.queue_position,
    source: 'bambu_us',
    source_product_id: d.source_product_id,
    handle: d.handle,
    canonical_url: d.canonical_url,
    title: '',
    type: d.type,
    currentAllIdRoute: d.route,
    leaf: d.leaf,
    also: d.also,
    curated: false,
    hold_code: '',
    sku_codes: {},
    value_labels: {},
    audit_classes: [],
  };
}

/**
 * What a media item sends (§O.4): the payload as the importer builds it, WITHOUT its prose — no description block,
 * spec, document, relation, external id or note, no short description or usage guide. The Worker refuses a media
 * payload that carries any (so the allow-list of text it never writes cannot stop a picture), and reads only the
 * identity, the options and variants, the images and the swatches.
 */
export function mediaOnlyPayload(p: ImportPayload): ImportPayload {
  return {
    ...p,
    product: { ...p.product, short_description_en: '', usage_steps: [], usage_official_url: '' },
    content_blocks: [],
    specs: [],
    documents: [],
    relations: [],
    external_ids: [],
    notes: [],
  };
}

/**
 * What a content item sends (§O.6): the media-only payload WITH its description blocks whole and its
 * `package.contents` rows (no other spec). The text travels only to PROVE where each picture goes: the Worker compares
 * it with what the import wrote and never writes it.
 */
export function contentOnlyPayload(p: ImportPayload): ImportPayload {
  return { ...mediaOnlyPayload(p), content_blocks: p.content_blocks, specs: p.specs.filter((s) => s.key === 'package.contents') };
}

/** The cache rule's wait from one answer (§I.1.9): its s-maxage + 60 s, at most 360 s (300 s when it names none). */
export function cacheWaitOfHeaders(headers: Headers): number {
  const m = /s-maxage=(\d{1,6})/.exec(headers.get('cache-control') ?? '');
  return Math.min(360_000, ((m ? Number(m[1]) : 300) + 60) * 1000);
}

// ------------------------------------------------------------------ dependencies

export interface BrowserLike {
  check(input: BrowserInput): Promise<BrowserResult>;
  close(): Promise<void>;
}

export interface RunnerDeps {
  clock: Clock;
  fetch: FetchLike;
  log: ImportLog;
  token: string;
  bundle: ReviewedBundle;
  /** Writes `<name>.sealed` (sealed in memory) and returns its size. */
  seal: (name: string, data: Buffer) => number;
  output: (key: string, value: string) => void;
  summary: SummaryWriter;
  browser: () => Promise<BrowserLike | null>;
  /** The run id an `open` mode's cf.mjs step created (read from its file). */
  openedRunId?: string;
  /** Store request hook (tests count and order them). */
  onStoreRequest?: (path: string) => void;
}

// ------------------------------------------------------------------ the gate (§J.1)

/**
 * EXTRACT is never started before the previous item's COMPLETE has committed.
 * The structural proof is the Worker's in-flight index (an item's EXTRACTING
 * start fails while another item is in flight); the runner asserts it again
 * against the event sequence: the EXTRACTING start event of an item must carry
 * a sequence number above the previous item's COMPLETE.
 */
export class ExtractGate {
  private lastCompleteSeq: number | null = null;
  private inFlight: string | null = null;

  noteStart(sid: string): void {
    if (this.inFlight && this.inFlight !== sid) throw new ImportStop('ORDER_VIOLATION', 'blocked', 'another item of this job has not completed');
    this.inFlight = sid;
  }

  /** Called with the EXTRACTING start event's sequence number, before the store page is fetched. */
  assertMayExtract(sid: string, startSeq: number | null): void {
    if (this.inFlight !== sid) throw new ImportStop('ORDER_VIOLATION', 'blocked', 'EXTRACT for an item this job did not start');
    if (this.lastCompleteSeq !== null && startSeq !== null && startSeq <= this.lastCompleteSeq) {
      throw new ImportStop('ORDER_VIOLATION', 'blocked', 'EXTRACT before the previous COMPLETE');
    }
  }

  noteComplete(sid: string, seq: number | null): void {
    if (this.inFlight !== sid) throw new ImportStop('ORDER_VIOLATION', 'blocked', 'COMPLETE for an item this job did not start');
    if (seq !== null) this.lastCompleteSeq = seq;
    this.inFlight = null;
  }

  /** An item that left the loop without COMPLETE (blocked, parked at the deadline): the job stops with it. */
  release(): void {
    this.inFlight = null;
  }
}

// ------------------------------------------------------------------ one item's work (rebuilt after a restart)

interface ItemWork {
  sid: string;
  row: ManifestRow;
  leaseToken: string;
  state: string;
  lastCompleted: string;
  stageAttempts: number;
  extraction?: Extraction;
  build?: BuildResult;
  payload?: ImportPayload;
  documentChecks: DocumentCheck[];
  enrichReport?: EnrichReport;
  stagedSha?: string;
  estimate?: number;
  stageAnswer?: { conflicts: number; warnings: number };
  media: Map<string, MediaAnswerRow>;
  write?: WriteAnswer;
  productId: string;
  slug: string;
  verify?: VerifyOutcome;
  browser?: BrowserResult | null;
  shots: Buffer[];
  /** The staged (and, after WRITING, written) payload's digest, as /lease reports it. */
  writtenSha: string;
  /** stage_data.before_fp_equal, when the Worker records the merge's protected-fields result there. */
  stageFpEqual: boolean | null;
  /** stage_data.images, when the Worker records the written image rows there (a resume after /write; gallery.ts). */
  stageImages: WrittenImage[] | null;
  /** stage_data.documents_inactive: the document ids the write stored inactive, when the Worker records them. */
  stageDocumentsInactive: string[] | null;
  /** The document checks this job sent with /write (whether or not its answer came back): what the write stored. */
  writeChecks: DocumentCheck[] | null;
  /** The gallery VERIFY expected (gallery.ts), for the sealed report. */
  gallery?: Gallery;
  /** /publish-finish ran for this item in this job (it purges, and republishes a product hidden on a block). */
  publishedThisJob: boolean;
  /** 'media': a delta run's media-only item (§O.3), whose stages write pictures and nothing else; 'content': a content
   *  item (§O.6), whose stages put description and in-the-box pictures into the fields the import wrote. */
  kind: ItemKind;
  /**
   * A media item's plan (/media-plan): the failed media to fetch again, and the payload digest the Worker recorded.
   * `payload` null: the moot plan (the page no longer reads as this product; nothing is fetched or attached).
   */
  retry?: { sha: string; payload: ImportPayload | null; requests: MediaRequest[]; skipped: Record<string, number>; failed: number };
  /** A media item whose page no longer reads as its product in this job (a renamed store handle): moot (§O.4). */
  moot?: boolean;
  /** A media item's attached rows: this job's /media-attach answer, or stage_data.media_retry on a resume. */
  attached: AttachedMedia | null;
  /** A content item's plan (/content-plan); `payload` null: the moot plan (`mootCode`). */
  content?: { sha: string; payload: ImportPayload | null; requests: MediaRequest[]; skipped: Record<string, number>; failed: number; storedNotWritten: number };
  /** A content item's moot (the page no longer reads as its product, or the store page is gone). */
  mootCode?: 'identity_changed' | 'source_gone';
  /** A content item's inserted pictures: this job's /content-attach answer, or stage_data.content_media on a resume. */
  inserted: ContentInserted | null;
}

const stageFpEqualOf = (stageData: Record<string, unknown>): boolean | null =>
  typeof stageData.before_fp_equal === 'boolean' ? stageData.before_fp_equal : null;

type ItemOutcome =
  | { kind: 'complete'; url: string }
  | { kind: 'blocked'; code: string }
  | { kind: 'deadline' }
  | { kind: 'skip' };

/** A withdrawal's evidence (§1 row 20): the second fetch of the page, and whether the sitemap no longer lists it. */
type WithdrawEvidence = { second: { at: string; outcome: string; status: number }; absent: boolean };

class JobStop extends Error {
  constructor(
    readonly code: string,
    readonly blocked: boolean
  ) {
    super(code);
    this.name = 'JobStop';
  }
}

// ------------------------------------------------------------------ the runner

export class Importer {
  readonly deadline: Deadline;
  readonly ops: OpsClient;
  readonly store: StoreFetcher;
  readonly hosts: HostFetcher;
  readonly site: Site;
  readonly gate = new ExtractGate();
  private robots: Robots | null = null;
  /** When the current site-reading stage must be done by (VERIFY's worst case from its start); null outside one. */
  private siteBudgetEnd: number | null = null;
  private browserChecker: BrowserLike | null | undefined;
  private readonly items: SummaryItem[] = [];
  private status: StatusAnswer | null = null;
  /** The held items /run/finish named (close): the summary names them. */
  private finishedHeld: HeldRef[] | null = null;
  private runId: string;
  private resumeUsed = false;
  /** A delta run's items (§O), by source id, as /delta/rows answers them; read once per job (null outside runQueue). */
  private deltaView: Map<string, DeltaRowView> | null = null;
  /** mode=delta: the queue is registered and the snapshot taken; a door that fails later leaves the run to a chained job. */
  private deltaOpened = false;
  /** /hello: the run holds delta items (§O). */
  private runIsDelta = false;
  /** The item whose lease this job holds, and when an item call last renewed it (null between items). */
  private held: { w: ItemWork; renewedAt: number } | null = null;
  private renewing = false;
  /** The clock every fetcher sleeps on: its sleeps keep the held lease alive (`pause`). */
  readonly leaseClock: Clock;

  constructor(
    readonly cfg: RunConfig,
    readonly deps: RunnerDeps
  ) {
    this.deadline = new Deadline(cfg.deadlineMs, deps.clock);
    this.runId = cfg.runId || deps.openedRunId || '';
    this.leaseClock = { now: () => deps.clock.now(), sleep: (ms) => this.pause(ms) };
    this.ops = new OpsClient({
      siteOrigin: cfg.siteOrigin,
      token: deps.token,
      fetch: deps.fetch,
      clock: this.leaseClock,
      deadline: this.deadline,
      githubRunId: cfg.githubRunId,
      codeCommit: cfg.codeCommit,
      onRenewed: (sid) => {
        if (this.held && this.held.w.sid === sid) this.held.renewedAt = deps.clock.now();
      },
    });
    this.store = new StoreFetcher({ fetch: deps.fetch, clock: this.leaseClock, deadline: this.deadline, origin: cfg.storeOrigin, onRequest: deps.onStoreRequest });
    this.hosts = new HostFetcher({ fetch: deps.fetch, clock: this.leaseClock, deadline: this.deadline, siteOrigin: cfg.siteOrigin });
    this.site = new Site(cfg.siteOrigin, this.hosts, () => (this.siteBudgetEnd === null ? 0 : Math.max(0, this.siteBudgetEnd - deps.clock.now())));
    deps.log.addSecret(deps.token);
  }

  private get log(): ImportLog {
    return this.deps.log;
  }

  private now(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }

  /**
   * Every sleep of this job. While an item is held, its lease is renewed with `/lease` before 10 minutes pass
   * since the last item call (the Worker's lease is 15), so no wait — a 30-minute backoff, a Retry-After, the
   * wait for a retry time — lets the lease lapse under the next call.
   */
  private async pause(ms: number): Promise<void> {
    let left = Math.max(0, ms);
    while (left > 0) {
      const h = this.held;
      if (!h || this.renewing) {
        await this.deps.clock.sleep(left);
        return;
      }
      const room = h.renewedAt + LEASE_KEEP_MS - this.deps.clock.now();
      if (room <= 0) {
        await this.renew(h);
        continue;
      }
      const step = Math.min(left, room);
      await this.deps.clock.sleep(step);
      left -= step;
    }
  }

  /** `/lease` with the held token: renews it (or, after a lapse, takes the item again with a fresh token). */
  private async renew(h: { w: ItemWork; renewedAt: number }): Promise<void> {
    this.renewing = true;
    try {
      const a = await this.ops.lease(h.w.sid, h.w.leaseToken);
      if (a.lease_token) h.w.leaseToken = a.lease_token;
    } catch (err) {
      if (err instanceof OpsError && err.kind === 'gone') throw new JobStop('OPS_GONE', true);
      // Anything else: the next item call learns what it must (a lapsed lease is re-leased by relearn).
    } finally {
      this.renewing = false;
      h.renewedAt = this.deps.clock.now();
    }
  }

  private seal(name: string, value: unknown): void {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const bytes = this.deps.seal(name, data);
    this.log.info('artifact', { name: `${name}.sealed`, bytes });
  }

  private writeSummary(more: boolean, closedState?: string): void {
    const blocked = this.items.filter((i) => i.outcome === 'blocked').map((i) => ({ handle: i.handle, code: i.code ?? '' }));
    // Held items, named by the REVIEWED manifest (its handle and hold code), never by the Worker's text.
    const held = (this.finishedHeld ?? this.status?.held ?? []).flatMap((h) => {
      const row = this.deps.bundle.bySid.get(h.source_product_id);
      return row ? [{ handle: row.handle, code: row.hold_code ?? '' }] : [];
    });
    this.deps.summary.write(
      renderSummary({
        mode: this.cfg.mode,
        runId: this.runId,
        siteOrigin: this.cfg.siteOrigin,
        status: this.status,
        handleOf: (sid) => this.deps.bundle.bySid.get(sid)?.handle ?? this.deltaView?.get(sid)?.handle ?? null,
        items: this.items,
        blocked,
        withdrawn: [],
        held,
        more,
        closedState,
      })
    );
  }

  // ---------------------------------------------------------------- hello

  /** /hello: the protocol, the migrations, and the reviewed files byte for byte. */
  async hello(): Promise<void> {
    let a;
    try {
      a = await this.ops.hello();
    } catch (err) {
      if (err instanceof OpsError && err.kind === 'gone') {
        this.log.error('hello_gone');
        throw new JobStop('OPS_GONE', true);
      }
      throw err;
    }
    const present = ['0193', '0194', '0195'].every((m) => a.migrations_present[m] === true);
    const diff = reviewedDifferences(this.deps.bundle.sha256, a.reviewed);
    this.log.info('hello_ok', { protocol: a.protocol, present, equal: diff.length === 0, files: Object.keys(this.deps.bundle.sha256).length });
    if (a.protocol !== 2) throw new JobStop('PROTOCOL_MISMATCH', true);
    if (!present) throw new JobStop('MIGRATIONS_MISSING', true);
    if (diff.length) {
      this.log.error('bundle_mismatch', { files: diff.length });
      throw new JobStop('REVIEWED_BUNDLE_MISMATCH', true);
    }
    if (a.run.id && /^cir_[0-9a-f]{24}$/.test(a.run.id)) {
      if (this.runId && this.runId !== a.run.id) throw new JobStop('RUN_MISMATCH', true);
      this.runId = a.run.id;
    }
    this.runIsDelta = a.run.delta;
  }

  // ---------------------------------------------------------------- modes

  async main(): Promise<number> {
    this.log.info('job_start', { mode: this.cfg.mode, max: this.cfg.maxItems, resume: this.cfg.resume, chain: this.cfg.chain, count: this.cfg.chainCount });
    let more = false;
    let blocked = false;
    let code = 0;
    try {
      switch (this.cfg.mode) {
        case 'preflight':
          code = await this.preflight();
          break;
        case 'open':
          await this.open();
          break;
        case 'run':
          ({ more, blocked } = await this.runQueue());
          break;
        case 'close':
          code = await this.close();
          break;
        case 'withdraw':
          code = await this.withdraw();
          break;
        case 'delta':
          ({ more, blocked } = await this.delta());
          break;
      }
    } catch (err) {
      blocked = true;
      more = false;
      code = 1;
      // mode=delta: only once its queue is registered — a delta whose registration did not finish never chains.
      if ((this.cfg.mode === 'run' || (this.cfg.mode === 'delta' && this.deltaOpened)) && err instanceof OpsError && err.kind === 'transient') {
        // A door that did not settle between items (/hello, /run/status: a 503 D1_OVERLOADED on the token read, a
        // 5xx, a 429) is passing, never "token gone" and never a block: this job holds nothing open, and the next
        // job resumes where D1 says (the chain stays bounded by its count).
        blocked = false;
        more = true;
        code = 0;
        this.log.error('door_unsettled', { call: err.call, code: err.code, status: err.status });
      } else if (err instanceof JobStop) this.log.error('note', { code: err.code });
      else if (err instanceof OpsError) this.log.error('ops_error', { call: err.call, code: err.code, status: err.status });
      else if (err instanceof ImportStop) this.log.error('note', { code: err.code });
      else this.log.exception('JOB', err);
    } finally {
      await this.browserChecker?.close().catch(() => {});
    }
    this.deps.output('more', more ? 'true' : 'false');
    this.deps.output('blocked', blocked ? 'true' : 'false');
    this.deps.output('run_id', this.runId);
    this.log.info('job_end', { complete: this.items.filter((i) => i.outcome === 'complete').length, more, blocked });
    return code;
  }

  /** mode=preflight: the public half (cf.mjs did the database half): catalog-only is live. */
  async preflight(): Promise<number> {
    const a = await this.site.read('GET', '/api/public/v1/context');
    const priced = a.status === 200 && catalogOnlyLive(a.json);
    // The status too: a refusal on the way (a challenge, a 5xx) is not the same finding as a document without the count.
    this.log.info('preflight', { status: a.status, priced });
    return priced ? 0 : 1;
  }

  /** mode=open: /hello, the whole manifest, the taxonomy, the protected snapshot `before` (§K.2 step 11). */
  async open(): Promise<void> {
    await this.hello();
    const batches = manifestBatches(this.deps.bundle.rows, this.now());
    let rows = 0;
    for (const batch of batches) rows += (await this.ops.manifest(batch)).accepted;
    this.log.info('manifest_sent', { rows, calls: batches.length });
    const tax = await this.ops.prepareTaxonomy();
    this.log.info('taxonomy', { nodes: tax.created_nodes, brand: tax.brand_created, synonyms: tax.synonyms_inserted });
    const snap = await this.ops.protectSnapshot('before');
    this.log.info('protect', { phase: 'before', subjects: snap.subjects });
    this.status = await this.ops.status();
    this.seal('open-report.json', {
      run_id: this.runId,
      manifest_rows: this.deps.bundle.rows.length,
      accepted: rows,
      reviewed: this.deps.bundle.sha256,
      reviewed_bundle_sha256: bundleDigest(this.deps.bundle.sha256),
      taxonomy: tax,
      protect_before: snap,
      status: this.status,
    });
    this.writeSummary(true);
  }

  /** mode=run: the queue, one item at a time, until max_items, the deadline or a BLOCKED item. */
  async runQueue(): Promise<{ more: boolean; blocked: boolean }> {
    await this.hello();
    // A delta run's items (§O): its media items and the new products the reviewed manifest does not hold.
    this.deltaView = new Map(this.runIsDelta ? (await this.ops.deltaRows()).map((r) => [r.source_product_id, r]) : []);
    // The browser before any item: a job that cannot run check 7 claims nothing (§I.1: COMPLETE needs both sides).
    if (!(await this.browserFor())) throw new JobStop('BROWSER_UNAVAILABLE', true);
    let processed = 0;
    let skips = 0;
    for (;;) {
      if (this.cfg.maxItems > 0 && processed >= this.cfg.maxItems) break;
      if (processed > 0 && processed % HELLO_EVERY === 0) await this.hello();
      this.status = await this.ops.status();
      const ref = this.status.current ?? this.status.next;
      if (!ref) {
        this.writeSummary(false);
        return { more: false, blocked: false };
      }
      const found = this.rowOf(ref.source_product_id);
      if (!found) throw new JobStop('REVIEWED_SCOPE_REFUSED', true);
      const row = found.row;
      if ((ref.state === 'DISCOVERED' || ref.state === '') && !this.deadline.canStartItem()) {
        this.log.info('deadline_exit', { need: Math.round((WORST.EXTRACT + WORST.ENRICH) / 1000), left: Math.round(this.deadline.left() / 1000) });
        this.writeSummary(true);
        return { more: true, blocked: false };
      }
      const outcome = await this.processItem(row, found.kind);
      if (outcome.kind === 'skip') {
        // The status named an item its lease says is finished: a stale answer. Never loop on it.
        if (++skips > 3) throw new JobStop('STATUS_INCONSISTENT', true);
        continue;
      }
      skips = 0;
      if (outcome.kind === 'complete') {
        processed++;
        this.items.push({ position: row.queue_position, handle: row.handle, outcome: 'complete', url: outcome.url });
        this.status = await this.ops.status().catch(() => this.status);
        this.writeSummary(true);
        continue;
      }
      if (outcome.kind === 'deadline') {
        this.items.push({ position: row.queue_position, handle: row.handle, outcome: 'deadline' });
        this.writeSummary(true);
        return { more: true, blocked: false };
      }
      if (outcome.code === 'SOURCE_WITHDRAWN' && this.cfg.autoWithdraw) {
        // The owner's standing approval (2026-10-18): a page gone at the source is withdrawn and the queue goes on.
        const auto = await this.autoWithdraw(row);
        if (auto === 'deadline') {
          this.items.push({ position: row.queue_position, handle: row.handle, outcome: 'deadline' });
          this.writeSummary(true);
          return { more: true, blocked: false };
        }
        if (auto === 'withdrawn') {
          this.items.push({ position: row.queue_position, handle: row.handle, outcome: 'withdrawn' });
          this.status = await this.ops.status().catch(() => this.status);
          this.writeSummary(true);
          continue;
        }
      }
      this.items.push({ position: row.queue_position, handle: row.handle, outcome: 'blocked', code: outcome.code });
      this.status = await this.ops.status().catch(() => this.status);
      this.writeSummary(false);
      return { more: false, blocked: true };
    }
    this.status = await this.ops.status();
    const more = !!(this.status.current ?? this.status.next);
    this.writeSummary(more);
    return { more, blocked: false };
  }

  // ---------------------------------------------------------------- one item

  /**
   * The row an item is worked from: the reviewed manifest's; for a delta run's media item the reviewed row at its
   * position in the new run; for a delta run's new product the row the Worker registered (never one the reviewed
   * manifest holds). null: the run names an item neither knows.
   */
  private rowOf(sid: string): { row: ManifestRow; kind: ItemKind } | null {
    const delta = this.deltaView?.get(sid);
    const reviewed = this.deps.bundle.bySid.get(sid);
    if (delta?.kind === 'media') return reviewed ? { row: { ...reviewed, queue_position: delta.queue_position }, kind: 'media' } : null;
    if (delta?.kind === 'new') return reviewed ? null : { row: deltaManifestRowOf(delta), kind: 'item' };
    // A content item: the reviewed row at its new position; a delta's new product's, the row its write was built from.
    if (delta?.kind === 'content') {
      if (reviewed) return { row: { ...reviewed, queue_position: delta.queue_position }, kind: 'content' };
      return delta.route ? { row: deltaManifestRowOf(delta), kind: 'content' } : null;
    }
    // A delta kind this runner does not read is never worked as an ordinary item (fail closed).
    if (delta) return null;
    return reviewed ? { row: reviewed, kind: 'item' } : null;
  }

  private async processItem(row: ManifestRow, kind: ItemKind = 'item'): Promise<ItemOutcome> {
    const sid = row.source_product_id;
    let lease;
    try {
      lease = await this.ops.lease(sid);
    } catch (err) {
      // §A.3: /lease refuses a queued item while another item of the run is in flight (409, stale): the status read
      // before it is out of date. Wait a moment and read it again — it names the item in flight — never block; the
      // run loop stops the job after a few such answers in a row (STATUS_INCONSISTENT) rather than spin.
      if (err instanceof OpsError && err.kind === 'stale') {
        const wait = LEASE_CLASH_WAIT_MS;
        if (!this.deadline.fits(wait, WORST.EXTRACT)) return { kind: 'deadline' };
        this.log.item(row.queue_position, row.handle, 'LEASE', 'lease_refused', { seconds: Math.round(wait / 1000) });
        await this.pause(wait);
        return { kind: 'skip' };
      }
      // No settled answer (its in-call retries spent): the item is left to the next job, never reported BLOCKED.
      if (err instanceof OpsError && err.kind === 'transient') {
        this.log.item(row.queue_position, row.handle, 'LEASE', 'ops_unsettled', { call: 'lease', attempts: 1 });
        return { kind: 'deadline' };
      }
      if (err instanceof OpsError && err.kind === 'gone') throw new JobStop('OPS_GONE', true);
      throw err;
    }
    const w: ItemWork = {
      sid,
      row,
      leaseToken: lease.lease_token,
      state: lease.state,
      lastCompleted: lease.last_completed_stage,
      stageAttempts: lease.stage_attempts,
      documentChecks: [],
      media: new Map(),
      productId: lease.levonis_product_id,
      slug: lease.slug,
      shots: [],
      writtenSha: lease.payload_sha256,
      stageFpEqual: stageFpEqualOf(lease.stage_data),
      stageImages: writtenImagesOf(lease.stage_data.images),
      stageDocumentsInactive: writtenDocumentsOf(lease.stage_data.documents_inactive),
      writeChecks: null,
      publishedThisJob: false,
      kind,
      attached: attachedMediaOf(lease.stage_data.media_retry),
      inserted: contentInsertedOf(lease.stage_data.content_media),
    };
    const pos = row.queue_position;
    const log = (stage: LogStage, t: Parameters<ImportLog['item']>[3], p: Parameters<ImportLog['item']>[4] = {}) => this.log.item(pos, row.handle, stage, t, p);
    if (w.state === 'COMPLETE' || w.state === 'WITHDRAWN_AT_SOURCE') return { kind: 'skip' };
    this.held = { w, renewedAt: this.deps.clock.now() };
    try {
      return await this.workItem(w, lease.blocker_code, lease.retry_at, log);
    } finally {
      this.held = null;
    }
  }

  private async workItem(w: ItemWork, blockerCode: string, retryAt: string, log: (stage: LogStage, t: Parameters<ImportLog['item']>[3], p?: Parameters<ImportLog['item']>[4]) => void): Promise<ItemOutcome> {
    const sid = w.sid;
    try {
      this.gate.noteStart(sid);
      if (w.state === 'BLOCKED') {
        if (!this.cfg.resume || this.resumeUsed) {
          log('BLOCKED', 'blocked', { code: blockerCode || 'BLOCKED' });
          this.gate.release();
          return { kind: 'blocked', code: blockerCode || 'BLOCKED' };
        }
        this.resumeUsed = true;
        const target = this.blockedResumeTarget(w, blockerCode);
        if (!target) throw blockedStop('RETRIES_EXHAUSTED', 'nothing to resume');
        await this.transition(w, target, 'resume');
        log(target, 'resumed', { from: 'BLOCKED', stage: target });
      } else if (w.state === 'RETRYING') {
        const target = stageAfter(w.lastCompleted);
        if (!target) throw blockedStop('RETRIES_EXHAUSTED', 'nothing to resume');
        const wait = Math.max(0, (Date.parse(retryAt) || 0) - this.deps.clock.now());
        if (!this.deadline.fitsStage(wait, WORST_OF[target])) {
          log('RETRYING', 'deadline_exit', { need: Math.round((wait + WORST[WORST_OF[target]]) / 1000), left: Math.round(this.deadline.left() / 1000) });
          this.gate.release();
          return { kind: 'deadline' };
        }
        // The lease was taken before the wait: `pause` keeps it alive until the retry time.
        if (wait > 0) await this.pause(wait);
        await this.transition(w, target, 'resume');
        log(target, 'resumed', { from: 'RETRYING', stage: target });
      } else if (w.state === 'DISCOVERED' || w.state === '') {
        const a = await this.transition(w, 'EXTRACTING', 'start');
        // A start whose answer was lost but committed carries no sequence number: the Worker's in-flight index is the proof.
        this.gate.assertMayExtract(sid, a?.seq ?? null);
      } else if (!(STAGES as readonly string[]).includes(w.state)) {
        throw new JobStop('ITEM_STATE_UNKNOWN', true);
      }
      return await this.runStages(w);
    } catch (err) {
      return this.stopItem(w, err);
    }
  }

  /** Where a BLOCKED item resumes (`resumeTargetOf`: a media item never rewrites). */
  private blockedResumeTarget(w: ItemWork, blockerCode: string): Stage | null {
    const merge = writeModeOf(this.deps.bundle, w.sid).mode === 'merge';
    return resumeTargetOf({ kind: w.kind, merge, blockerCode, lastCompleted: w.lastCompleted, productId: w.productId });
  }

  /** A merge's reviewed match, which the Worker's writer maps through; null without a map (VERIFY then expects every id). */
  private mergeMatchOf(w: ItemWork): MergeMatch | null {
    const m = this.deps.bundle.matches.get(w.sid);
    return m?.value_map ? { value_map: m.value_map, unmapped_variants: m.unmapped_variants ?? [] } : null;
  }

  /** Turns a stop into the item's state: BLOCKED (the queue stops), or released at the deadline. */
  private async stopItem(w: ItemWork, err: unknown): Promise<ItemOutcome> {
    const log = (stage: LogStage, t: Parameters<ImportLog['item']>[3], p: Parameters<ImportLog['item']>[4] = {}) => this.log.item(w.row.queue_position, w.row.handle, stage, t, p);
    this.gate.release();
    if (err instanceof JobStop) throw err;
    if (err instanceof OpsError && err.kind === 'gone') throw new JobStop('OPS_GONE', true);
    if (err instanceof ImportStop && err.code === 'ORDER_VIOLATION') {
      this.log.error('order_violation');
      throw new JobStop('ORDER_VIOLATION', true);
    }
    if (err instanceof ImportStop && err.kind === 'deadline') return { kind: 'deadline' };
    const code = err instanceof ImportStop ? err.code : err instanceof OpsError && err.kind === 'permanent' ? err.code : '';
    if (!code) throw err;
    if (code === 'ACCESS_CHALLENGE') log('BLOCKED', 'challenge');
    try {
      if (w.state !== 'BLOCKED') await this.transition(w, 'BLOCKED', 'blocked', { code });
    } catch (e) {
      if (e instanceof OpsError && e.kind === 'gone') throw new JobStop('OPS_GONE', true);
      // The BLOCKED event never settled: the item is not BLOCKED in D1, and the next job meets the same cause.
      if (e instanceof ImportStop && e.kind === 'deadline') return { kind: 'deadline' };
      throw e;
    }
    log('BLOCKED', 'blocked', { code });
    this.sealItem(w, { outcome: 'blocked', code });
    return { kind: 'blocked', code };
  }

  private async event(w: ItemWork, state: string, outcome: 'start' | 'ok' | 'retry' | 'blocked' | 'resume', extra: { code?: string; retry_at?: string; release?: boolean; detail?: Record<string, unknown> } = {}) {
    const a = await this.ops.event(w.sid, w.leaseToken, { state, outcome, code: extra.code, retry_at: extra.retry_at, release: extra.release, detail: extra.detail, message: '' });
    w.state = a.state || state;
    w.lastCompleted = a.last_completed_stage || w.lastCompleted;
    if (typeof a.stage_attempts === 'number') w.stageAttempts = a.stage_attempts;
    return a;
  }

  /** Re-lease to learn what committed (an ambiguous call, a lost lease, a stale transition). */
  private async relearn(w: ItemWork): Promise<void> {
    const lease = await this.ops.lease(w.sid, w.leaseToken);
    w.leaseToken = lease.lease_token || w.leaseToken;
    w.state = lease.state;
    w.lastCompleted = lease.last_completed_stage;
    w.stageAttempts = lease.stage_attempts;
    if (lease.levonis_product_id) w.productId = lease.levonis_product_id;
    if (lease.slug) w.slug = lease.slug;
    if (lease.payload_sha256) w.writtenSha = lease.payload_sha256;
    const fp = stageFpEqualOf(lease.stage_data);
    if (fp !== null) w.stageFpEqual = fp;
    const images = writtenImagesOf(lease.stage_data.images);
    if (images) w.stageImages = images;
    const inactive = writtenDocumentsOf(lease.stage_data.documents_inactive);
    if (inactive) w.stageDocumentsInactive = inactive;
    const attached = attachedMediaOf(lease.stage_data.media_retry);
    if (attached) w.attached = attached;
    const inserted = contentInsertedOf(lease.stage_data.content_media);
    if (inserted) w.inserted = inserted;
  }

  /**
   * A transition outside a stage's own retries (start, resume, RETRYING, park, BLOCKED). `/event` is never
   * retried inside its call, so a 5xx, a timeout or a stale answer here asks `/lease` what committed: a
   * transition that committed is done (its answer is null), one that did not is sent again after the §B.5
   * backoff, within the deadline rules. If it never settles, the item is left to the next job: an ImportStop
   * of kind `deadline` (`more=true`), never BLOCKED for a passing failure. Two stale answers stop the job.
   */
  private async transition(
    w: ItemWork,
    state: string,
    outcome: 'start' | 'retry' | 'blocked' | 'resume',
    extra: { code?: string; retry_at?: string; release?: boolean } = {}
  ): Promise<Awaited<ReturnType<Importer['event']>> | null> {
    let stale = 0;
    for (let attempt = 0; ; attempt++) {
      let failure: OpsError;
      try {
        return await this.event(w, state, outcome, extra);
      } catch (err) {
        if (!(err instanceof OpsError) || (err.kind !== 'transient' && err.kind !== 'stale')) throw err;
        failure = err;
      }
      if (failure.kind === 'stale' && ++stale > 2) throw new JobStop('LEASE_UNSTABLE', true);
      try {
        await this.relearn(w);
        if (w.state === state) return null; // it committed; only the answer was lost
      } catch (err) {
        if (err instanceof OpsError && err.kind === 'gone') throw err;
        if (!(err instanceof OpsError)) throw err;
        // /lease did not answer either: try again after the wait.
      }
      const wait = Math.max(failure.retryAfterMs ?? 0, backoff(attempt));
      if (attempt + 1 >= TRANSITION_ATTEMPTS || !this.deadline.fits(wait, WORST.PUBLISH_FINISH)) {
        this.log.item(w.row.queue_position, w.row.handle, 'LEASE', 'ops_unsettled', { call: 'event', attempts: attempt + 1 });
        throw new ImportStop('OPS_UNSETTLED', 'deadline', 'a transition never settled', { needMs: wait });
      }
      await this.pause(wait);
    }
  }

  private async runStages(w: ItemWork): Promise<ItemOutcome> {
    for (;;) {
      // A re-lease after an ambiguous call can report a state the runner did not set itself.
      if (w.state === 'COMPLETE') {
        this.gate.noteComplete(w.sid, null);
        this.log.item(w.row.queue_position, w.row.handle, 'COMPLETE', 'complete', { url: this.liveUrl(w) });
        this.sealItem(w, { outcome: 'complete' });
        return { kind: 'complete', url: this.liveUrl(w) };
      }
      if (w.state === 'BLOCKED') {
        this.gate.release();
        return { kind: 'blocked', code: 'BLOCKED' };
      }
      if (w.state === 'RETRYING') {
        const target = stageAfter(w.lastCompleted);
        if (!target) throw blockedStop('RETRIES_EXHAUSTED', 'nothing to resume');
        await this.transition(w, target, 'resume');
        continue;
      }
      const stage = w.state as Stage;
      if (!(STAGES as readonly string[]).includes(stage)) throw new JobStop('ITEM_STATE_UNKNOWN', true);
      const done = await this.withRetries(w, stage, () => this.runStage(w, stage));
      if (done) return done;
    }
  }

  /**
   * One stage with the §B.5 retry rules: transient → RETRYING with 30 s × 2^k
   * (Retry-After honoured), within the deadline, 8 attempts at most; a stale
   * view → re-lease; a permanent code → BLOCKED.
   */
  private async withRetries(w: ItemWork, stage: Stage, fn: () => Promise<ItemOutcome | null>): Promise<ItemOutcome | null> {
    let stale = 0;
    for (;;) {
      if (!this.deadline.fitsStage(0, WORST_OF[stage])) {
        await this.park(w, stage, 0, 'DEADLINE_EXIT');
        return { kind: 'deadline' };
      }
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ImportStop && err.kind === 'deadline') {
          await this.park(w, stage, err.detail.needMs ?? 0, 'DEADLINE_EXIT');
          return { kind: 'deadline' };
        }
        if (err instanceof OpsError && err.kind === 'stale') {
          // The Worker keeps saying the runner's view is stale: stop rather than spin.
          if (++stale > 3) throw new JobStop('LEASE_UNSTABLE', true);
          await this.relearn(w);
          if (w.state !== stage) return null; // runStages reads the state the Worker reports
          continue;
        }
        const transient = (err instanceof ImportStop && err.kind === 'transient') || (err instanceof OpsError && err.kind === 'transient');
        if (!transient) throw err;
        if (err instanceof OpsError && err.ambiguous) {
          await this.relearn(w);
          if (w.state !== stage) return null; // it committed: continue at the stage the Worker reports
        }
        const code = err instanceof ImportStop ? err.code : (err as OpsError).code;
        const retryAfter = err instanceof ImportStop ? err.detail.retryAfterMs ?? null : (err as OpsError).retryAfterMs;
        if (w.stageAttempts + 1 >= MAX_STAGE_ATTEMPTS) throw blockedStop('RETRIES_EXHAUSTED', 'eight attempts of one stage');
        const wait = Math.max(retryAfter ?? 0, backoff(w.stageAttempts));
        // The curated file can only arrive with a new commit, never inside this job (its bundle is loaded once):
        // the item waits in D1 for a later job instead of an hour here.
        if (code === 'CURATION_PENDING' || !this.deadline.fitsStage(wait, WORST_OF[stage])) {
          await this.park(w, stage, wait, code);
          return { kind: 'deadline' };
        }
        await this.transition(w, 'RETRYING', 'retry', { code, retry_at: this.deadline.retryAt(wait) });
        this.log.item(w.row.queue_position, w.row.handle, 'RETRYING', 'retrying', { code, seconds: Math.round(wait / 1000), attempt: w.stageAttempts });
        await this.pause(wait);
        await this.transition(w, stage, 'resume');
      }
    }
  }

  /** Rule 3: release the lease (event RETRYING, lease expires now) and let the job exit `more=true`. */
  private async park(w: ItemWork, stage: Stage, waitMs: number, code: string): Promise<void> {
    if (code === 'CURATION_PENDING') this.log.item(w.row.queue_position, w.row.handle, stage, 'parked', { code, seconds: Math.round(waitMs / 1000) });
    else {
      this.log.item(w.row.queue_position, w.row.handle, stage, 'deadline_exit', {
        need: Math.round((waitMs + WORST[WORST_OF[stage]]) / 1000),
        left: Math.round(this.deadline.left() / 1000),
      });
    }
    await this.transition(w, 'RETRYING', 'retry', { code, retry_at: this.deadline.retryAt(waitMs), release: true });
    // The lease is released: nothing renews it any more.
    if (this.held?.w === w) this.held = null;
    this.gate.release();
  }

  // ---------------------------------------------------------------- the stages

  private async runStage(w: ItemWork, stage: Stage): Promise<ItemOutcome | null> {
    if (w.kind === 'media') return this.runMediaStage(w, stage);
    if (w.kind === 'content') return this.runContentStage(w, stage);
    switch (stage) {
      case 'EXTRACTING':
        await this.extract(w);
        await this.event(w, 'ENRICHING', 'ok', { detail: { source_fingerprint: w.payload?.extraction_sha256 ?? '' } });
        return null;
      case 'ENRICHING':
        await this.ensureExtracted(w);
        await this.enrich(w);
        await this.event(w, 'VALIDATING', 'ok', { detail: this.enrichDetail(w) });
        return null;
      case 'VALIDATING':
        await this.ensureEnriched(w);
        await this.validateAndStage(w);
        await this.event(w, 'INGESTING_MEDIA', 'ok', { detail: { payload_sha256: w.stagedSha ?? '', invocation_estimate: w.estimate ?? 0 } });
        return null;
      case 'INGESTING_MEDIA':
        await this.ensureStaged(w);
        await this.ingest(w);
        if (!this.deadline.canStartWrite()) throw new ImportStop('DEADLINE_EXIT', 'deadline', 'not enough time to write, publish and verify', { needMs: 0 });
        await this.event(w, 'WRITING', 'ok', { detail: this.mediaDetail(w) });
        return null;
      case 'WRITING':
        await this.ensureStaged(w);
        if (w.media.size === 0) await this.ingest(w);
        if (!this.deadline.canStartWrite()) throw new ImportStop('DEADLINE_EXIT', 'deadline', 'not enough time to write, publish and verify', { needMs: 0 });
        await this.writeItem(w);
        return null;
      case 'PUBLISHING':
        await this.publish(w);
        return null;
      case 'VERIFYING_LIVE':
        return this.verifyAndComplete(w);
    }
  }

  private robotsOk(): Robots {
    return this.robots ?? NO_ROBOTS;
  }

  /** robots.txt, re-read once per job (§J.1); a Disallow of the planned path stops the item (policy). */
  private async ensureRobots(): Promise<Robots> {
    if (this.robots) return this.robots;
    const text = await this.store.robotsTxt();
    this.robots = text === null ? NO_ROBOTS : parseRobots(text);
    this.log.info('robots_read', { rules: this.robots.rules.length, allowed: true });
    return this.robots;
  }

  private async extract(w: ItemWork): Promise<void> {
    // The item must be the one this job holds in flight (its EXTRACTING start, or a resumed item).
    this.gate.assertMayExtract(w.sid, null);
    const robots = await this.ensureRobots();
    const raw = rawHandleOf(w.row);
    if (!robotsAllows(robots, `/products/${raw}`)) {
      this.log.item(w.row.queue_position, w.row.handle, 'EXTRACTING', 'robots_disallow');
      throw blockedStop('ACCESS_CHALLENGE', 'robots.txt disallows the product page');
    }
    const started = this.deps.clock.now();
    const page = await this.store.productPage(raw);
    this.log.item(w.row.queue_position, w.row.handle, 'EXTRACTING', 'store_status', { status: page.status, ms: this.deps.clock.now() - started });
    let x: Extraction;
    try {
      x = extractPage(page.html).extraction;
    } catch {
      throw blockedStop('IDENTITY_AMBIGUOUS', 'the page holds no product of the expected shape');
    }
    if (x.sourceProductId !== w.row.source_product_id || x.handle !== w.row.handle) throw blockedStop('IDENTITY_AMBIGUOUS', 'the page names another product');
    const cross = identityCrossCheck(x);
    if (!cross.ok) throw blockedStop('IDENTITY_AMBIGUOUS', 'the JSON-LD identity disagrees');
    const mode = writeModeOf(this.deps.bundle, w.sid);
    const build = buildImportPayload({
      extraction: x,
      writeMode: mode.mode === 'merge' ? 'merge' : 'create',
      mergeProductId: mode.mode === 'merge' ? mode.productId : undefined,
      extractionSha256: extractionFingerprint(x),
      manifestRow: w.row,
      identity: this.deps.bundle.identity[w.row.handle] ?? null,
      targets: this.deps.bundle.targets,
      overrides: this.deps.bundle.overrides,
      retrievedAt: page.fetchedAt,
    });
    w.extraction = x;
    w.build = build;
    w.payload = build.payload;
    const c = build.report.counts;
    this.log.item(w.row.queue_position, w.row.handle, 'EXTRACTING', 'extracted', { groups: c.groups, values: c.values, variants: c.variants, images: c.images });
  }

  private async enrich(w: ItemWork): Promise<void> {
    const gate = curatedGate(this.cfg.dataDir, w.row.handle, w.row.curated === true, this.deps.bundle.curatedIndex);
    const end = this.deps.clock.now() + WORST.ENRICH;
    const r = await enrich(
      this.hosts,
      {
        payload: w.build!.payload,
        productType: productTypeOf(w.extraction!.route),
        trackerLinks: w.build!.described.trackerLinks,
        retrievedAt: this.now(),
        curated: gate,
        afterMs: () => Math.max(0, end - this.deps.clock.now()),
      },
      () => this.now()
    );
    w.payload = r.payload;
    w.documentChecks = r.documentChecks;
    w.enrichReport = r.report;
    this.log.item(w.row.queue_position, w.row.handle, 'ENRICHING', 'enriched', {
      documents: r.report.documents_checked,
      dead: r.report.documents_dead,
      trackers: r.report.trackers_resolved,
      tracker_links: r.report.tracker_links,
      wiki: r.report.wiki_parsed,
      wiki_specs: r.report.wiki_specs,
    });
  }

  private enrichDetail(w: ItemWork): Record<string, unknown> {
    const r = w.enrichReport;
    return r
      ? { documents_checked: r.documents_checked, documents_dead: r.documents_dead, trackers_resolved: r.trackers_resolved, tracker_links: r.tracker_links, wiki_parsed: r.wiki_parsed, wiki_specs: r.wiki_specs }
      : {};
  }

  private mediaDetail(w: ItemWork): Record<string, unknown> {
    const rows = [...w.media.values()];
    return { stored: rows.filter((m) => m.status === 'stored').length, failed: rows.filter((m) => m.status === 'failed').length, omitted: rows.filter((m) => m.status === 'omitted_cap').length };
  }

  /** The holds and the gates the runner applies before the Worker's own (§B.5, §E.1.4, §F). */
  private async validateAndStage(w: ItemWork): Promise<void> {
    const build = w.build!;
    const errors = build.report.errors;
    if (errors.includes('IDENTITY_AMBIGUOUS') || errors.includes('DUPLICATE_VALUE_TEXT') || errors.includes('DUPLICATE_VARIANT')) throw blockedStop('IDENTITY_AMBIGUOUS', 'the options do not resolve');
    if (errors.length) throw blockedStop('PAYLOAD_REFUSED', 'the builder refused the product');
    const mode = writeModeOf(this.deps.bundle, w.sid);
    const decided = this.deps.bundle.matches.has(w.sid);
    if (mode.mode === 'hold' || (w.row.hold_code === 'OWNER_HIDDEN' && !decided)) throw blockedStop('OWNER_HIDDEN', 'an owner decision is pending');
    if (build.report.hold === 'ORDER_TYPE_WORD') throw blockedStop('ORDER_TYPE_WORD', 'an option value reads as an order type');
    const gate = curatedGate(this.cfg.dataDir, w.row.handle, w.row.curated === true, this.deps.bundle.curatedIndex);
    if (gate.kind === 'mismatch') throw blockedStop('REVIEWED_BUNDLE_MISMATCH', 'the curated file is not the reviewed one');
    if (gate.kind === 'pending') {
      if (w.stageAttempts >= 2) throw blockedStop('CURATION_MISSING', 'the curated file never arrived');
      throw new ImportStop('CURATION_PENDING', 'transient', 'the curated file is not in the bundled index', { retryAfterMs: 60 * 60_000 });
    }
    try {
      assertImportPayload(JSON.parse(JSON.stringify(w.payload)));
    } catch (err) {
      if (err instanceof ImportPayloadRefused) throw blockedStop('PAYLOAD_REFUSED', 'the allow-list refused the payload');
      throw err;
    }
    await this.stageOnly(w);
    const p = w.payload!;
    this.log.item(w.row.queue_position, w.row.handle, 'VALIDATING', 'validated', { specs: p.specs.length, relations: p.relations.length, documents: p.documents.length, estimate: w.estimate ?? 0 });
  }

  private async stageOnly(w: ItemWork): Promise<void> {
    const a = await this.ops.stage(w.sid, w.leaseToken, w.payload!, w.documentChecks);
    w.stagedSha = a.payload_sha256;
    w.estimate = a.invocation_estimate;
    w.stageAnswer = { conflicts: a.conflicts.length, warnings: a.warnings.length };
    this.log.item(w.row.queue_position, w.row.handle, 'VALIDATING', 'staged', { estimate: a.invocation_estimate, conflicts: a.conflicts.length, warnings: a.warnings.length });
    if (a.invocation_estimate > 900) throw blockedStop('PLAN_TOO_LARGE', 'the plan exceeds the invocation budget');
  }

  /** A resumed item rebuilds its work: the page again (≥ 11 s spacing), never a stored payload. */
  private async ensureExtracted(w: ItemWork): Promise<void> {
    if (!w.payload) await this.extract(w);
  }

  private async ensureEnriched(w: ItemWork): Promise<void> {
    await this.ensureExtracted(w);
    if (!w.enrichReport) await this.enrich(w);
  }

  private async ensureStaged(w: ItemWork): Promise<void> {
    await this.ensureEnriched(w);
    if (w.stagedSha) return;
    await this.stageOnly(w);
  }

  /** §A.3 /media: ≤ 4 per call, ≥ 1 s apart; a stored medium is never fetched again (the Worker HEADs it). */
  private async ingest(w: ItemWork): Promise<void> {
    const p = w.payload!;
    const wanted = new Map<string, MediaRequest>();
    for (const i of p.images) if (i.source_media_id && i.source_url) wanted.set(i.source_media_id, { source_media_id: i.source_media_id, role: 'gallery', source_url: i.source_url });
    for (const s of p.swatches) if (!wanted.has(s.source_media_id)) wanted.set(s.source_media_id, { source_media_id: s.source_media_id, role: 'swatch', source_url: s.source_url });
    for (const b of p.content_blocks) if (b.kind === 'image' && b.source_media_id && !wanted.has(b.source_media_id)) wanted.set(b.source_media_id, { source_media_id: b.source_media_id, role: 'description', source_url: b.source_url });
    for (const s of p.specs) {
      if (s.key !== 'package.contents') continue;
      for (const item of s.value_list) {
        if (typeof item === 'object' && item && item.source_media_id && item.source_url && !wanted.has(item.source_media_id)) {
          wanted.set(item.source_media_id, { source_media_id: item.source_media_id, role: 'in_the_box', source_url: item.source_url });
        }
      }
    }
    await this.fetchMedia(w, [...wanted.values()]);
    const primary = p.images.find((i) => i.is_primary);
    const pm = primary ? w.media.get(primary.source_media_id) : undefined;
    if (primary && pm?.status !== 'stored') {
      if (pm?.error_code === 'MEDIA_HOST_NOT_ALLOWED') throw blockedStop('MEDIA_HOST_NOT_ALLOWED', 'the primary image is on a host outside the allow-list');
      throw blockedStop('PRIMARY_MEDIA_FAILED', 'the primary image could not be stored');
    }
    this.logMediaDone(w, wanted.size);
  }

  /** The media calls themselves: ≤ 4 a call, ≥ 1 s apart, a pending medium asked again (at most 20 rounds). */
  private async fetchMedia(w: ItemWork, requests: readonly MediaRequest[]): Promise<void> {
    const pending = requests.filter((m) => w.media.get(m.source_media_id)?.status !== 'stored');
    let lastCall: number | null = null;
    let rounds = 0;
    while (pending.length) {
      const batch = pending.splice(0, 4);
      const wait = lastCall === null ? 0 : Math.max(0, lastCall + MEDIA_SPACING_MS - this.deps.clock.now());
      if (!this.deadline.fitsStage(wait, 'MEDIA_CALL')) throw new ImportStop('DEADLINE_EXIT', 'deadline', 'a media call does not fit', { needMs: wait });
      if (wait > 0) await this.pause(wait);
      const t0 = this.deps.clock.now();
      lastCall = t0;
      const rows = await this.ops.media(w.sid, w.leaseToken, batch);
      for (const r of rows) w.media.set(r.source_media_id, r);
      const again = batch.filter((m) => (w.media.get(m.source_media_id)?.status ?? 'pending') === 'pending');
      this.log.item(w.row.queue_position, w.row.handle, 'INGESTING_MEDIA', 'media_call', {
        sent: batch.length,
        stored: rows.filter((r) => r.status === 'stored').length,
        failed: rows.filter((r) => r.status === 'failed').length,
        pending: again.length,
        ms: this.deps.clock.now() - t0,
      });
      if (again.length) {
        if (++rounds > 20) throw transientStop('MEDIA_TIMEOUT', 'media keep coming back pending');
        pending.push(...again);
      }
    }
  }

  private logMediaDone(w: ItemWork, total: number): void {
    const all = [...w.media.values()];
    this.log.item(w.row.queue_position, w.row.handle, 'INGESTING_MEDIA', 'media_done', {
      stored: all.filter((m) => m.status === 'stored').length,
      failed: all.filter((m) => m.status === 'failed').length,
      omitted: all.filter((m) => m.status === 'omitted_cap').length,
      total,
    });
  }

  private async writeItem(w: ItemWork): Promise<void> {
    // Before the call: an answer lost after the commit still leaves these as what the write stored.
    w.writeChecks = w.documentChecks;
    const a = await this.ops.write(w.sid, w.leaseToken, w.stagedSha!, w.payload!, w.documentChecks);
    w.write = a;
    w.productId = a.product_id || w.productId;
    w.slug = a.slug || w.slug;
    w.state = 'PUBLISHING';
    w.lastCompleted = 'WRITING';
    this.log.item(w.row.queue_position, w.row.handle, 'WRITING', 'written', {
      created: a.created,
      groups: a.counts.groups ?? w.payload!.groups.length,
      variants: a.counts.variants ?? w.payload!.variants.length,
      images: a.counts.images ?? w.payload!.images.length,
      fp_equal: a.before_fp_equal,
    });
  }

  private async publish(w: ItemWork): Promise<void> {
    const t0 = this.deps.clock.now();
    const a = await this.ops.publishFinish(w.sid, w.leaseToken);
    w.publishedThisJob = true;
    w.state = a.state || 'VERIFYING_LIVE';
    w.lastCompleted = 'PUBLISHING';
    this.log.item(w.row.queue_position, w.row.handle, 'PUBLISHING', 'published', { ms: this.deps.clock.now() - t0 });
  }

  private liveUrl(w: ItemWork): string {
    return `${this.cfg.siteOrigin}/product/${w.slug}`;
  }

  /** The job's one browser, launched once; null when it cannot be (the launch error is never printed: it may name paths). */
  private async browserFor(): Promise<BrowserLike | null> {
    if (this.browserChecker === undefined) this.browserChecker = await this.deps.browser().catch(() => null);
    return this.browserChecker;
  }

  /** VERIFY (§I.1) with the cache rule (§I.1.9), then /complete. */
  private async verifyAndComplete(w: ItemWork): Promise<ItemOutcome> {
    if (!w.slug || !w.productId) await this.relearn(w);
    if (!w.slug || !w.productId) throw blockedStop('VERIFY_FAILED_PERSISTENT', 'the write answer named no product');
    await this.ensureEnriched(w);
    // A resumed item (no /write in this job) rebuilt its payload from the page read NOW. It is verified only when
    // it is, digest for digest, the payload the Worker staged and wrote; otherwise the expectations would be
    // another build's. A passing difference (an optional wiki or tracker read that failed) is retried; a lasting
    // one (the store changed the product after the write) stops the item for the owner.
    if (!w.write && w.writtenSha && payloadDigest(w.payload!) !== w.writtenSha) {
      this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'rebuilt_differs', { attempt: w.stageAttempts + 1 });
      this.forgetBuild(w);
      if (w.stageAttempts < 2) throw transientStop('VERIFY_STALE', 'the page read again is not the payload written');
      throw blockedStop('VERIFY_FAILED_PERSISTENT', 'the source changed after the write');
    }
    if (w.media.size === 0) await this.ingest(w);
    // Resumed into VERIFY in this job (after a block that hid the product, a park, a lost job): /publish-finish
    // first. It is idempotent in VERIFYING_LIVE; it puts back a product hidden on the block (§A.10) and purges
    // every page that cached it hidden, so round 1 reads the product as it is.
    if (!w.publishedThisJob) {
      await this.ops.publishFinish(w.sid, w.leaseToken);
      w.publishedThisJob = true;
    }
    const isMerge = w.payload!.write_mode === 'merge' || (!!w.write && !w.write.created);
    // The gallery as WRITTEN (§C.4 step 1: byte-identical images collapsed), never the payload's pre-collapse list.
    const gallery = this.galleryOf(w);
    w.gallery = gallery;
    this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'gallery', { rows: gallery.images.length, images: w.payload!.images.length, what: gallery.source });
    const ctx = {
      payload: w.payload!,
      productId: w.productId,
      slug: w.slug,
      media: w.media,
      images: gallery.images,
      ...this.documentsOf(w),
      leaf: w.row.leaf ?? '',
      also: w.row.also ?? [],
      taxonomy: this.deps.bundle.taxonomy,
      modelCodes: modelCodesOf(w.payload!.product.title_en, this.deps.bundle.rows.map((r) => r.title ?? '')),
      merge: isMerge ? this.mergeEvidence(w) : null,
      mergeMatch: isMerge ? this.mergeMatchOf(w) : null,
      readback: () => this.ops.readback(w.sid),
    };
    const audit = (w.row.audit_classes ?? []).length > 0;
    for (let round = 1; round <= 2; round++) {
      // Each round's reads must fit in what is left of VERIFY's worst case (§A.7 rule 1).
      this.siteBudgetEnd = this.deps.clock.now() + (round === 1 ? WORST.VERIFY : AFTER_CACHE_WAIT);
      const outcome = await verifyPublic(this.site, ctx);
      if (round === 1) {
        const k = outcome.checks.knowledge;
        this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'documents_written', {
          shown: k?.counts?.expected_documents ?? null,
          total: w.payload!.documents.length,
          what: typeof k?.detail?.documents_from === 'string' ? k.detail.documents_from : null,
        });
      }
      let browser: BrowserResult | null = null;
      if (outcome.ok) {
        // Check 7 is part of every COMPLETE (§I.1): no browser, no /complete. runQueue launched it before item 1.
        const checker = await this.browserFor();
        if (!checker) throw new JobStop('BROWSER_UNAVAILABLE', true);
        browser = await checker.check({
          slug: w.slug,
          payload: w.payload!,
          media: w.media,
          images: gallery.images,
          allValues: audit,
          // The knowledge answer VERIFY expected: the tabs the page must draw for it.
          knowledge: outcome.knowledge ? { ...outcome.knowledge, completeness: null } : null,
          screenshot: audit || w.row.queue_position % 25 === 0,
        });
        w.shots.push(...browser.screenshots);
        this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'browser', { checks: Object.keys(browser.checks).length, failed: Object.values(browser.checks).filter((v) => !v).length, screens: browser.screenshots.length });
      }
      const passed = Object.values(outcome.checks).filter((c) => c.ok).length;
      this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'verify_done', { passed, total: Object.keys(outcome.checks).length });
      // Which ones failed, by name, every round: the sealed report keeps only the last round's outcome.
      for (const [check, c] of Object.entries(outcome.checks)) if (!c.ok) this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'verify_check', { check, ok: false, status: c.status ?? null });
      for (const [check, ok] of Object.entries(browser?.checks ?? {})) if (!ok) this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'verify_check', { check: `browser_${check}`, ok: false, status: null });
      w.verify = outcome;
      w.browser = browser;
      const allOk = outcome.ok && browser !== null && browser.ok;
      if (allOk && browser) {
        const evidence = edgeEvidence(
          outcome,
          browser ? { ok: browser.ok, checks: browser.checks, counts: browser.counts, selections: browser.selections, not_applicable: browser.not_applicable } : null,
          this.liveUrl(w),
          w.payload!,
          round
        );
        const done = await this.ops.complete(w.sid, w.leaseToken, this.liveUrl(w), evidence);
        if (done.state === 'COMPLETE') {
          this.gate.noteComplete(w.sid, done.seq);
          w.state = 'COMPLETE';
          this.log.item(w.row.queue_position, w.row.handle, 'COMPLETE', 'complete', { url: this.liveUrl(w) });
          this.sealItem(w, { outcome: 'complete', d1_checks: done.d1_checks });
          return { kind: 'complete', url: this.liveUrl(w) };
        }
      }
      if (round === 2) break;
      // The cache rule: purge again and wait s-maxage + 60 s (≤ 360 s), within the deadline.
      const wait = cacheWaitOf(outcome);
      if (!this.deadline.fits(wait, AFTER_CACHE_WAIT)) throw new ImportStop('DEADLINE_EXIT', 'deadline', 'the cache wait does not fit', { needMs: wait });
      this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'cache_wait', { seconds: Math.round(wait / 1000) });
      await this.ops.publishFinish(w.sid, w.leaseToken);
      await this.pause(wait);
    }
    throw blockedStop('VERIFY_FAILED_PERSISTENT', 'a check failed again after a purge and a wait');
  }

  /**
   * The gallery VERIFY expects (gallery.ts): this job's /write answer; else the rows the Worker recorded in
   * stage_data; else the Worker's collapse recomputed from the payload written (its digest was checked) and the
   * stored keys /media answered.
   */
  private galleryOf(w: ItemWork): Gallery {
    const written = w.write?.images ? { rows: w.write.images, source: 'write' as const } : w.stageImages ? { rows: w.stageImages, source: 'stage_data' as const } : null;
    return writtenGallery(w.payload!, w.media, written);
  }

  /**
   * The merge's protected-fields proof (§I.1.8): this job's /write answer; else what the Worker recorded in
   * stage_data; else the committed write itself — the item is past WRITING in D1, and its batch could not have
   * committed had a guard trigger seen a protected column move (§A.5, §E.3). A resumed runner never fails a
   * hard check on a value it cannot have.
   */
  private mergeEvidence(w: ItemWork): { before_fp_equal: boolean | null; source: 'write' | 'stage_data' | 'not_recorded' } {
    if (w.write) return { before_fp_equal: w.write.before_fp_equal, source: 'write' };
    if (w.stageFpEqual !== null) return { before_fp_equal: w.stageFpEqual, source: 'stage_data' };
    // The Worker records the write's own result in stage_data after its commit, and completes a merge only on that
    // record (complete.ts: `write.before_fp_equal`). Without it there is no proof here either: the check fails.
    return { before_fp_equal: null, source: 'not_recorded' };
  }

  /**
   * The documents as the write stored them, for VERIFY (verify.ts writtenDocuments): the checks this job sent with
   * /write; else, resumed in a later job, the ids the Worker recorded inactive at the write (stage_data); else not
   * recorded — never the checks this job took again, which are not what /write stored (nothing rewrites a
   * document's `active` after WRITING), so one timeout among a product's documents would fail a correct import.
   */
  private documentsOf(w: ItemWork): Pick<VerifyContext, 'documentChecks' | 'writtenDocuments'> {
    if (w.writeChecks) return { documentChecks: w.writeChecks };
    if (w.stageDocumentsInactive) return { writtenDocuments: { inactive: w.stageDocumentsInactive } };
    return { writtenDocuments: 'not_recorded' };
  }

  /** Drops a rebuilt work so the next attempt reads the page again. */
  private forgetBuild(w: ItemWork): void {
    w.extraction = undefined;
    w.build = undefined;
    w.payload = undefined;
    w.enrichReport = undefined;
    w.documentChecks = [];
    w.stagedSha = undefined;
  }

  /** The per-item report and its screenshots, sealed (they may name sources and media URLs). */
  private sealItem(w: ItemWork, end: Record<string, unknown>): void {
    const name = `item-${String(w.row.queue_position).padStart(4, '0')}`;
    const b = w.build;
    this.seal(`${name}.json`, {
      source_product_id: w.sid,
      handle: w.row.handle,
      queue_position: w.row.queue_position,
      ...end,
      product_id: w.productId,
      slug: w.slug,
      build: b ? { report: b.report, media_report: b.media.report } : null,
      enrich: w.enrichReport ?? null,
      document_checks: w.documentChecks,
      staged: { payload_sha256: w.stagedSha ?? '', invocation_estimate: w.estimate ?? 0, ...(w.stageAnswer ?? {}) },
      media: [...w.media.values()],
      write: w.write ?? null,
      gallery: w.gallery ? { source: w.gallery.source, rows: w.gallery.images.length, payload_images: w.payload?.images.length ?? 0 } : null,
      verify: w.verify ?? null,
      browser: w.browser ? { ok: w.browser.ok, checks: w.browser.checks, counts: w.browser.counts, selections: w.browser.selections, not_applicable: w.browser.not_applicable } : null,
    });
    w.shots.forEach((shot, i) => this.seal(`${name}-shot-${i + 1}.png`, shot));
    w.shots = [];
  }

  // ---------------------------------------------------------------- the delta run (§O)

  /**
   * mode=delta: the NEW run's queue (cf.mjs opened the run and minted this job's token), then the queue itself, as
   * in mode=run. The store's robots.txt and its three sitemaps (§I.3.1, at the store's pace); /delta/plan names the
   * listed handles no run ever held and the closed run's completed items with failed media; each new handle's page
   * is read once (≥ 11 s apart) for its source id and route; /delta/manifest registers the media items first and the
   * new products last (a new product may wait for the owner's §E.1 review at its turn — the retries never wait
   * behind it); the reviewed taxonomy (insert-only, as at open) and the protected snapshot `before`.
   */
  async delta(): Promise<{ more: boolean; blocked: boolean }> {
    if (this.cfg.deltaPass === 'content') return this.deltaContent();
    await this.hello();
    const robots = await this.ensureRobots();
    if (SITEMAP_PATHS.some((path) => !robotsAllows(robots, path))) {
      this.log.error('note', { code: 'SITEMAP_DISALLOWED' });
      throw new JobStop('SITEMAP_DISALLOWED', true);
    }
    const urls: string[] = [];
    for (const path of SITEMAP_PATHS) urls.push(...parseSitemap(await this.store.sitemap(path)));
    const listed = productHandles(urls);
    const plan = await this.ops.deltaPlan(this.cfg.fromRun, listed);
    this.log.info('delta_plan', { run: this.cfg.fromRun, ...plan.counts });
    // More new products than one delta takes (the Worker's DELTA_NEW_MAX) is a review of the store, not a delta:
    // nothing is read or registered.
    if (plan.new_handles.length > DELTA_NEW_MAX) {
      this.log.error('note', { code: 'DELTA_TOO_MANY_NEW' });
      throw new JobStop('DELTA_TOO_MANY_NEW', true);
    }
    const at = this.now();
    const fresh: Array<Record<string, unknown>> = [];
    const newProducts: Array<Record<string, unknown>> = [];
    for (const handle of plan.new_handles) {
      const raw = encodeURIComponent(handle);
      if (!robotsAllows(robots, `/products/${raw}`)) {
        this.log.info('delta_new_skipped', { what: 'robots_disallow' });
        continue;
      }
      let page;
      try {
        page = await this.store.productPage(raw);
      } catch (err) {
        // A page gone or redirected to another product is not queued (a later delta finds it again if it comes
        // back); a challenge, a store that does not answer or the deadline stop the job (never bypassed).
        if (err instanceof ImportStop && (err.code === 'SOURCE_WITHDRAWN' || err.code === 'IDENTITY_AMBIGUOUS')) {
          this.log.info('delta_new_skipped', { what: err.code === 'SOURCE_WITHDRAWN' ? 'page_gone' : 'other_product' });
          continue;
        }
        throw err;
      }
      let x: Extraction;
      try {
        x = extractPage(page.html).extraction;
      } catch {
        this.log.info('delta_new_skipped', { what: 'unreadable' });
        continue;
      }
      if (x.handle !== handle || !/^\d{1,24}$/.test(x.sourceProductId)) {
        this.log.info('delta_new_skipped', { what: 'other_product' });
        continue;
      }
      // Two listed handles that read as the same product (a renamed handle whose old one is still listed), or a new
      // handle that is a media item's product: one row per product (the Worker refuses a call naming one twice).
      if (fresh.some((f) => f.source_product_id === x.sourceProductId) || plan.media.some((m) => m.source_product_id === x.sourceProductId)) {
        this.log.info('delta_new_skipped', { what: 'same_product' });
        continue;
      }
      fresh.push({ kind: 'new', source_product_id: x.sourceProductId, handle, route: x.route, discovered_at: at });
      newProducts.push({ handle, source_product_id: x.sourceProductId, title: x.title, route: x.route, type: productTypeOf(x.route) });
    }
    // The media items in their own calls first, the new products after them in theirs: a new row can never take a
    // media item down with it. A row the Worker finds moot (a new row whose source id an earlier run or a product
    // already holds — a renamed store handle —, a media item whose product is gone or that an earlier delta already
    // completed) is left out and counted, never refused.
    const mediaRows = plan.media.map((m) => ({ kind: 'media', source_product_id: m.source_product_id, discovered_at: at }));
    let calls = 0;
    const registered = { new: 0, media: 0 };
    const skipped = { known: 0, media_product_gone: 0, media_already_retried: 0, content_already_settled: 0 };
    for (const group of [mediaRows, fresh]) {
      for (let i = 0; i < group.length; i += 100) {
        const a = await this.ops.deltaManifest(this.cfg.fromRun, group.slice(i, i + 100));
        calls++;
        registered.new += a.new;
        registered.media += a.media;
        skipped.known += a.skipped.known;
        skipped.media_product_gone += a.skipped.media_product_gone;
        skipped.media_already_retried += a.skipped.media_already_retried;
      }
    }
    this.log.info('delta_registered', { media: registered.media, new: registered.new, calls, known: skipped.known, product_gone: skipped.media_product_gone, retried: skipped.media_already_retried });
    const tax = await this.ops.prepareTaxonomy();
    this.log.info('taxonomy', { nodes: tax.created_nodes, brand: tax.brand_created, synonyms: tax.synonyms_inserted });
    const snap = await this.ops.protectSnapshot('before');
    this.log.info('protect', { phase: 'before', subjects: snap.subjects });
    this.status = await this.ops.status();
    // Sealed: the new products' handles, titles and routes are for the owner's review (§E.1), never for the log.
    this.seal('delta-open-report.json', {
      run_id: this.runId,
      from_run: this.cfg.fromRun,
      sitemap_listed: listed.length,
      plan: plan.counts,
      new_products: newProducts,
      media_items: plan.media,
      registered,
      skipped,
      reviewed_bundle_sha256: bundleDigest(this.deps.bundle.sha256),
      taxonomy: tax,
      protect_before: snap,
      status: this.status,
    });
    this.deltaOpened = true;
    return this.runQueue();
  }

  /**
   * A media item (§O.3): the page read again and the payload rebuilt exactly as the importer builds it (EXTRACT; never
   * enriched — nothing but pictures is sent), the plan the Worker proves and answers (/media-plan), the failed media
   * fetched again (/media, ≤ 4 a call), ONE guarded INSERT-only batch (/media-attach), the ordinary /publish-finish,
   * and COMPLETE on the public product's own answer (/media-complete).
   */
  private async runMediaStage(w: ItemWork, stage: Stage): Promise<ItemOutcome | null> {
    switch (stage) {
      case 'EXTRACTING':
        await this.extractMedia(w);
        await this.event(w, 'ENRICHING', 'ok', { detail: { source_fingerprint: w.payload?.extraction_sha256 ?? '', media_only: true } });
        return null;
      case 'ENRICHING':
        await this.event(w, 'VALIDATING', 'ok', { detail: { media_only: true } });
        return null;
      case 'VALIDATING':
        await this.mediaPlan(w);
        await this.event(w, 'INGESTING_MEDIA', 'ok', { detail: { media_only: true, failed: w.retry!.failed, requests: w.retry!.requests.length } });
        return null;
      case 'INGESTING_MEDIA':
        if (!w.retry) await this.mediaPlan(w);
        await this.fetchMedia(w, w.retry!.requests);
        this.logMediaDone(w, w.retry!.requests.length);
        await this.event(w, 'WRITING', 'ok', { detail: this.mediaDetail(w) });
        return null;
      case 'WRITING':
        if (!w.retry) await this.mediaPlan(w);
        if (w.media.size === 0) await this.fetchMedia(w, w.retry!.requests);
        await this.attachMedia(w);
        return null;
      case 'PUBLISHING':
        await this.publish(w);
        return null;
      case 'VERIFYING_LIVE':
        return this.verifyMediaRetry(w);
    }
  }

  /**
   * A media item's page, read again (once a job). A lasting identity change — the store redirects the reviewed handle
   * to another one (a renamed product), the page names another product or its JSON-LD disagrees, its options do not
   * resolve — makes the item MOOT instead of BLOCKED IDENTITY_AMBIGUOUS: a media item writes nothing but pictures, so
   * nothing needs proving, and a block could never clear (it is not SOURCE_WITHDRAWN, a resume meets the same page,
   * the run could not close and the queue behind it would never run). The item then completes with nothing attached;
   * a later delta takes it again (§O.4). Every other stop (a challenge, the page gone, the deadline) stays as it is.
   */
  private async extractMedia(w: ItemWork): Promise<void> {
    if (w.payload || w.moot) return;
    try {
      await this.extract(w);
      const errors = w.build!.report.errors;
      if (errors.includes('IDENTITY_AMBIGUOUS') || errors.includes('DUPLICATE_VALUE_TEXT') || errors.includes('DUPLICATE_VARIANT')) throw blockedStop('IDENTITY_AMBIGUOUS', 'the options do not resolve');
    } catch (err) {
      if (!(err instanceof ImportStop) || err.code !== 'IDENTITY_AMBIGUOUS') throw err;
      this.makeMoot(w);
    }
  }

  private makeMoot(w: ItemWork): void {
    w.moot = true;
    w.payload = undefined;
    w.build = undefined;
    w.extraction = undefined;
    this.log.item(w.row.queue_position, w.row.handle, 'EXTRACTING', 'media_moot', { what: 'identity_changed' });
  }

  /**
   * /media-plan: the rebuilt payload (the page read in this job), proved by the Worker; what to fetch again. A moot
   * item (extractMedia), or a payload the Worker finds is no longer this item's product as the import wrote it
   * (IDENTITY_AMBIGUOUS: the handle, the product or the write mode), sends the moot plan instead.
   */
  private async mediaPlan(w: ItemWork): Promise<void> {
    await this.extractMedia(w);
    let a: MediaPlanAnswer | null = null;
    let payload: ImportPayload | null = null;
    if (!w.moot) {
      payload = mediaOnlyPayload(w.payload!);
      try {
        a = await this.ops.mediaPlan(w.sid, w.leaseToken, payload);
      } catch (err) {
        if (!(err instanceof OpsError) || err.kind !== 'permanent' || err.code !== 'IDENTITY_AMBIGUOUS') throw err;
        this.makeMoot(w);
        payload = null;
      }
    }
    if (!a) a = await this.ops.mediaPlan(w.sid, w.leaseToken, null);
    w.retry = { sha: a.payload_sha256, payload, requests: a.media, skipped: a.skipped, failed: a.failed };
    w.stagedSha = a.payload_sha256;
    const k = a.skipped;
    this.log.item(w.row.queue_position, w.row.handle, 'VALIDATING', 'media_plan', {
      failed: a.failed,
      requests: a.media.length,
      role_not_attachable: k.role_not_attachable ?? 0,
      not_in_source: k.not_in_source ?? 0,
      primary_unchanged: k.primary_unchanged ?? 0,
      product_not_public: k.product_not_public ?? 0,
      identity_changed: k.identity_changed ?? 0,
    });
  }

  /** /media-attach: one guarded batch; an ambiguous answer is settled by /lease (the batch moves the item on). */
  private async attachMedia(w: ItemWork): Promise<void> {
    const a = await this.ops.mediaAttach(w.sid, w.leaseToken, w.retry!.sha, w.retry!.payload);
    w.attached = { rows: a.rows, swatches: a.swatches };
    w.productId = a.product_id || w.productId;
    w.slug = a.slug || w.slug;
    w.state = 'PUBLISHING';
    w.lastCompleted = 'WRITING';
    const c = a.counts;
    this.log.item(w.row.queue_position, w.row.handle, 'WRITING', 'media_attached', {
      attached: c.attached ?? 0,
      rows: a.rows.length,
      swatches: a.swatches.length,
      already_present: c.already_present ?? 0,
      owner_removed: c.owner_removed ?? 0,
      duplicate_content: c.duplicate_content ?? 0,
      target_missing: c.target_missing ?? 0,
      not_stored: c.not_stored ?? 0,
    });
  }

  /**
   * VERIFY of a media item: the anonymous site answer of the product (its image rows, its values' swatches), with the
   * cache rule (§I.1.9: purge again, wait s-maxage + 60 s, once). What it saw goes to /media-complete every round: the
   * Worker decides, against what the product still holds (a picture the owner removed or replaced since the attach,
   * or a product hidden since, is not expected) and the objects in R2. Nothing attached: nothing to see.
   */
  private async verifyMediaRetry(w: ItemWork): Promise<ItemOutcome> {
    if (!w.slug || !w.attached) await this.relearn(w);
    const att = w.attached;
    if (!w.slug || !att) throw blockedStop('VERIFY_FAILED_PERSISTENT', 'the attach recorded no rows');
    if (!w.publishedThisJob) {
      await this.ops.publishFinish(w.sid, w.leaseToken);
      w.publishedThisJob = true;
    }
    const nothing = att.rows.length + att.swatches.length === 0;
    for (let round = 1; round <= 2; round++) {
      let status = 0;
      let rowsSeen = 0;
      let swatchesSeen = 0;
      let wait = 0;
      if (!nothing) {
        this.siteBudgetEnd = this.deps.clock.now() + (round === 1 ? WORST.VERIFY : AFTER_CACHE_WAIT);
        try {
          const a = await this.site.read('GET', `/api/products/${encodeURIComponent(w.slug)}`);
          status = a.status;
          const rel = a.json && typeof a.json.relations === 'object' && a.json.relations !== null && !Array.isArray(a.json.relations) ? (a.json.relations as Record<string, unknown>) : {};
          const facts = siteFacts(rel);
          const shown = new Set(facts.images.map((i) => mediaPath(i.url)));
          const swatches = new Set(facts.groups.flatMap((g) => g.values.map((v) => mediaPath(v.swatch))));
          rowsSeen = att.rows.filter((r) => shown.has(`/files/${r.r2_key}`)).length;
          swatchesSeen = att.swatches.filter((sw) => swatches.has(`/files/${sw.r2_key}`)).length;
          wait = cacheWaitOfHeaders(a.headers);
        } finally {
          this.siteBudgetEnd = null;
        }
      }
      this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'media_seen', { rows_seen: rowsSeen, rows: att.rows.length, swatches_seen: swatchesSeen, swatches: att.swatches.length, status });
      const done = await this.ops.mediaComplete(w.sid, w.leaseToken, this.liveUrl(w), { version: 1, live_url: this.liveUrl(w), round, status, rows_seen: rowsSeen, swatches_seen: swatchesSeen });
      if (done.state === 'COMPLETE') {
        this.gate.noteComplete(w.sid, done.seq);
        w.state = 'COMPLETE';
        this.log.item(w.row.queue_position, w.row.handle, 'COMPLETE', 'complete', { url: this.liveUrl(w) });
        this.sealItem(w, { outcome: 'complete', media_only: true, plan: w.retry ? { failed: w.retry.failed, requests: w.retry.requests.length, skipped: w.retry.skipped } : null, attached: { rows: att.rows.length, swatches: att.swatches.length }, d1_checks: done.d1_checks });
        return { kind: 'complete', url: this.liveUrl(w) };
      }
      if (round === 2) break;
      if (!this.deadline.fits(wait, AFTER_CACHE_WAIT)) throw new ImportStop('DEADLINE_EXIT', 'deadline', 'the cache wait does not fit', { needMs: wait });
      this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'cache_wait', { seconds: Math.round(wait / 1000) });
      await this.ops.publishFinish(w.sid, w.leaseToken);
      await this.pause(wait);
    }
    throw blockedStop('VERIFY_FAILED_PERSISTENT', 'an attached picture is not on the public product after a purge and a wait');
  }

  // ---------------------------------------------------------------- the content pass (§O.6)

  /**
   * mode=delta item=content: the NEW run's queue is the closed run's content items only (cf.mjs opened the run and
   * minted this job's token). robots.txt (no sitemap is read, no new product's page); /delta/plan with the content
   * pass, its parts reconciled against the closed run's failures (every failed description and in-the-box medium in
   * exactly one part, or the job stops before registering anything); /delta/manifest; the reviewed taxonomy (insert-
   * only) and the protected snapshot `before`; the sealed open report; then the queue as in mode=run.
   */
  private async deltaContent(): Promise<{ more: boolean; blocked: boolean }> {
    await this.hello();
    await this.ensureRobots();
    const plan = await this.ops.deltaPlan(this.cfg.fromRun, [], 'content');
    const c = plan.counts;
    this.log.info('delta_content_plan', { run: this.cfg.fromRun, ...c });
    for (const [code, failed] of Object.entries(plan.failed_by_error).sort()) this.log.info('delta_content_code', { code, failed });
    const parts = (c.content_failed ?? 0) + (c.content_failed_not_complete ?? 0) + (c.content_failed_product_gone ?? 0) + (c.content_failed_not_reviewed ?? 0) + (c.content_failed_settled ?? 0);
    if (typeof c.content_failed_total !== 'number' || parts !== c.content_failed_total || plan.content.reduce((n, x) => n + x.failed, 0) !== (c.content_failed ?? -1)) {
      this.log.error('note', { code: 'DELTA_PLAN_INCONSISTENT' });
      throw new JobStop('DELTA_PLAN_INCONSISTENT', true);
    }
    const at = this.now();
    const rows = plan.content.map((m) => ({ kind: 'content', source_product_id: m.source_product_id, discovered_at: at }));
    let calls = 0;
    const registered = { content: 0 };
    const skipped = { media_product_gone: 0, content_already_settled: 0 };
    for (let i = 0; i < rows.length; i += 100) {
      const a = await this.ops.deltaManifest(this.cfg.fromRun, rows.slice(i, i + 100));
      calls++;
      registered.content += a.content;
      skipped.media_product_gone += a.skipped.media_product_gone;
      skipped.content_already_settled += a.skipped.content_already_settled;
    }
    this.log.info('delta_content_registered', { content: registered.content, calls, product_gone: skipped.media_product_gone, settled: skipped.content_already_settled });
    const tax = await this.ops.prepareTaxonomy();
    this.log.info('taxonomy', { nodes: tax.created_nodes, brand: tax.brand_created, synonyms: tax.synonyms_inserted });
    const snap = await this.ops.protectSnapshot('before');
    this.log.info('protect', { phase: 'before', subjects: snap.subjects });
    this.status = await this.ops.status();
    this.seal('delta-open-report.json', {
      run_id: this.runId,
      from_run: this.cfg.fromRun,
      pass: 'content',
      plan: plan.counts,
      failed_by_error: plan.failed_by_error,
      content_items: plan.content.map((x) => ({ sid: x.source_product_id, handle: this.deps.bundle.bySid.get(x.source_product_id)?.handle ?? x.handle, failed: x.failed })),
      registered,
      skipped,
      reviewed_bundle_sha256: bundleDigest(this.deps.bundle.sha256),
      taxonomy: tax,
      protect_before: snap,
      status: this.status,
    });
    this.deltaOpened = true;
    return this.runQueue();
  }

  /**
   * A content item (§O.6): the page read again and the payload rebuilt exactly as the importer builds it (never
   * enriched), the plan the Worker proves (/content-plan), the planned media fetched again (/media, ≤ 4 a call), ONE
   * guarded batch (/content-attach), the ordinary /publish-finish, and COMPLETE on the public answers
   * (/content-complete).
   */
  private async runContentStage(w: ItemWork, stage: Stage): Promise<ItemOutcome | null> {
    switch (stage) {
      case 'EXTRACTING':
        await this.extractContent(w);
        await this.event(w, 'ENRICHING', 'ok', { detail: { source_fingerprint: w.payload?.extraction_sha256 ?? '', content_only: true } });
        return null;
      case 'ENRICHING':
        await this.event(w, 'VALIDATING', 'ok', { detail: { content_only: true } });
        return null;
      case 'VALIDATING':
        await this.contentPlan(w);
        await this.event(w, 'INGESTING_MEDIA', 'ok', { detail: { content_only: true, failed: w.content!.failed, requests: w.content!.requests.length } });
        return null;
      case 'INGESTING_MEDIA':
        if (!w.content) await this.contentPlan(w);
        await this.fetchMedia(w, w.content!.requests);
        this.logMediaDone(w, w.content!.requests.length);
        await this.event(w, 'WRITING', 'ok', { detail: this.mediaDetail(w) });
        return null;
      case 'WRITING':
        if (!w.content) await this.contentPlan(w);
        if (w.media.size === 0) await this.fetchMedia(w, w.content!.requests);
        await this.contentAttach(w);
        return null;
      case 'PUBLISHING':
        await this.publish(w);
        return null;
      case 'VERIFYING_LIVE':
        return this.verifyContent(w);
    }
  }

  /**
   * A content item's page, read again (once a job). A lasting identity change (as for a media item) makes the item
   * moot `identity_changed`; a page gone at the store makes it moot `source_gone` — never BLOCKED: a content item
   * writes nothing without proof, a block could never clear, and a later pass takes it again.
   */
  private async extractContent(w: ItemWork): Promise<void> {
    if (w.payload || w.mootCode) return;
    try {
      await this.extract(w);
      const errors = w.build!.report.errors;
      if (errors.includes('IDENTITY_AMBIGUOUS') || errors.includes('DUPLICATE_VALUE_TEXT') || errors.includes('DUPLICATE_VARIANT')) throw blockedStop('IDENTITY_AMBIGUOUS', 'the options do not resolve');
    } catch (err) {
      if (!(err instanceof ImportStop) || (err.code !== 'IDENTITY_AMBIGUOUS' && err.code !== 'SOURCE_WITHDRAWN')) throw err;
      this.makeContentMoot(w, err.code === 'SOURCE_WITHDRAWN' ? 'source_gone' : 'identity_changed');
    }
  }

  private makeContentMoot(w: ItemWork, code: 'identity_changed' | 'source_gone'): void {
    w.mootCode = code;
    w.payload = undefined;
    w.build = undefined;
    w.extraction = undefined;
    this.log.item(w.row.queue_position, w.row.handle, 'EXTRACTING', 'content_moot', { what: code });
  }

  /** /content-plan: the rebuilt payload (description blocks and box rows), proved by the Worker; what to fetch again. */
  private async contentPlan(w: ItemWork): Promise<void> {
    await this.extractContent(w);
    let a: ContentPlanAnswer | null = null;
    let payload: ImportPayload | null = null;
    if (!w.mootCode) {
      payload = contentOnlyPayload(w.payload!);
      try {
        a = await this.ops.contentPlan(w.sid, w.leaseToken, payload);
      } catch (err) {
        if (!(err instanceof OpsError) || err.kind !== 'permanent' || err.code !== 'IDENTITY_AMBIGUOUS') throw err;
        this.makeContentMoot(w, 'identity_changed');
        payload = null;
      }
    }
    if (!a) a = await this.ops.contentPlan(w.sid, w.leaseToken, null, w.mootCode ?? 'identity_changed');
    w.content = { sha: a.payload_sha256, payload, requests: a.media, skipped: a.skipped, failed: a.failed, storedNotWritten: a.stored_not_written };
    w.stagedSha = a.payload_sha256;
    const k = a.skipped;
    this.log.item(w.row.queue_position, w.row.handle, 'VALIDATING', 'content_plan', {
      failed: a.failed,
      requests: a.media.length,
      owner_edited: k.owner_edited ?? 0,
      not_imported: k.not_imported ?? 0,
      source_changed: k.source_changed ?? 0,
      not_on_page: k.not_on_page ?? 0,
      already_present: k.already_present ?? 0,
      owner_removed: k.owner_removed ?? 0,
      product_not_public: k.product_not_public ?? 0,
      identity_changed: k.identity_changed ?? 0,
      source_gone: k.source_gone ?? 0,
      stored_not_written: a.stored_not_written,
    });
  }

  /** /content-attach: one guarded batch; an ambiguous answer is settled by /lease (the batch moves the item on). */
  private async contentAttach(w: ItemWork): Promise<void> {
    const plan = w.content!;
    const a = await this.ops.contentAttach(w.sid, w.leaseToken, plan.sha, plan.payload, w.mootCode ?? 'identity_changed');
    w.inserted = a.inserted;
    w.productId = a.product_id || w.productId;
    w.slug = a.slug || w.slug;
    w.state = 'PUBLISHING';
    w.lastCompleted = 'WRITING';
    const c = a.counts;
    this.log.item(w.row.queue_position, w.row.handle, 'WRITING', 'content_attached', {
      attached: c.attached ?? 0,
      blocks: a.inserted.blocks.length,
      box: a.inserted.box.length,
      already_present: c.already_present ?? 0,
      owner_removed: c.owner_removed ?? 0,
      owner_edited: c.owner_edited ?? 0,
      not_imported: c.not_imported ?? 0,
      source_changed: c.source_changed ?? 0,
      not_stored: c.not_stored ?? 0,
    });
  }

  /**
   * VERIFY of a content item: the anonymous product answer (each inserted block on its key) when blocks went in, the
   * anonymous knowledge answer (each inserted box picture) when box items did, with the cache rule (§I.1.9: purge
   * again, wait s-maxage + 60 s — the larger of the answers read —, once). What it saw goes to /content-complete every
   * round; the Worker decides against what the product still holds and shows. Nothing inserted: nothing to see.
   */
  private async verifyContent(w: ItemWork): Promise<ItemOutcome> {
    if (!w.slug || !w.inserted) await this.relearn(w);
    const ins = w.inserted;
    if (!w.slug || !ins) throw blockedStop('VERIFY_FAILED_PERSISTENT', 'the attach recorded nothing');
    if (!w.publishedThisJob) {
      await this.ops.publishFinish(w.sid, w.leaseToken);
      w.publishedThisJob = true;
    }
    const occurrences = new Map<string, number>();
    for (const b of ins.box) occurrences.set(b.r2_key, (occurrences.get(b.r2_key) ?? 0) + 1);
    for (let round = 1; round <= 2; round++) {
      let status = 0;
      let knowledgeStatus = 0;
      let blocksSeen = 0;
      let boxSeen = 0;
      let wait = 0;
      if (ins.blocks.length + ins.box.length > 0) {
        this.siteBudgetEnd = this.deps.clock.now() + (round === 1 ? WORST.VERIFY : AFTER_CACHE_WAIT);
        try {
          if (ins.blocks.length) {
            const a = await this.site.read('GET', `/api/products/${encodeURIComponent(w.slug)}`);
            status = a.status;
            const doc = a.json && typeof a.json === 'object' ? (a.json as Record<string, unknown>) : {};
            const product = doc.product && typeof doc.product === 'object' ? (doc.product as Record<string, unknown>) : doc;
            const shown = Array.isArray(product.content_blocks) ? (product.content_blocks as unknown[]) : [];
            blocksSeen = ins.blocks.filter((b) => shown.some((x) => !!x && typeof x === 'object' && (x as Record<string, unknown>).id === b.id && mediaPath(String((x as Record<string, unknown>).url ?? '')) === `/files/${b.r2_key}`)).length;
            wait = Math.max(wait, cacheWaitOfHeaders(a.headers));
          }
          if (ins.box.length) {
            const k = await this.site.read('GET', `/api/products/${encodeURIComponent(w.slug)}/knowledge`);
            knowledgeStatus = k.status;
            const box = k.json && Array.isArray((k.json as Record<string, unknown>).in_the_box) ? ((k.json as Record<string, unknown>).in_the_box as unknown[]) : [];
            const seen = new Map<string, number>();
            for (const it of box) {
              const img = it && typeof it === 'object' ? String((it as Record<string, unknown>).image ?? '') : '';
              if (img) seen.set(mediaPath(img), (seen.get(mediaPath(img)) ?? 0) + 1);
            }
            for (const [key, n] of occurrences) boxSeen += Math.min(n, seen.get(`/files/${key}`) ?? 0);
            wait = Math.max(wait, cacheWaitOfHeaders(k.headers));
          }
        } finally {
          this.siteBudgetEnd = null;
        }
      }
      this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'content_seen', {
        blocks_seen: blocksSeen,
        blocks: ins.blocks.length,
        box_seen: boxSeen,
        box: ins.box.length,
        status,
        knowledge_status: knowledgeStatus,
      });
      const done = await this.ops.contentComplete(w.sid, w.leaseToken, this.liveUrl(w), {
        version: 1,
        live_url: this.liveUrl(w),
        round,
        status,
        knowledge_status: knowledgeStatus,
        blocks_seen: blocksSeen,
        box_seen: boxSeen,
      });
      if (done.state === 'COMPLETE') {
        this.gate.noteComplete(w.sid, done.seq);
        w.state = 'COMPLETE';
        this.log.item(w.row.queue_position, w.row.handle, 'COMPLETE', 'complete', { url: this.liveUrl(w) });
        this.sealItem(w, {
          outcome: 'complete',
          content_only: true,
          plan: w.content ? { failed: w.content.failed, requests: w.content.requests.length, skipped: w.content.skipped, stored_not_written: w.content.storedNotWritten } : null,
          inserted: { blocks: ins.blocks.length, box: ins.box.length },
          d1_checks: done.d1_checks,
        });
        return { kind: 'complete', url: this.liveUrl(w) };
      }
      if (round === 2) break;
      wait = wait || cacheWaitOfHeaders(new Headers());
      if (!this.deadline.fits(wait, AFTER_CACHE_WAIT)) throw new ImportStop('DEADLINE_EXIT', 'deadline', 'the cache wait does not fit', { needMs: wait });
      this.log.item(w.row.queue_position, w.row.handle, 'VERIFYING_LIVE', 'cache_wait', { seconds: Math.round(wait / 1000) });
      await this.ops.publishFinish(w.sid, w.leaseToken);
      await this.pause(wait);
    }
    throw blockedStop('VERIFY_FAILED_PERSISTENT', 'an inserted picture is not on the public answers after a purge and a wait');
  }

  // ---------------------------------------------------------------- close (§A.9, §I.3)

  async close(): Promise<number> {
    await this.hello();
    this.status = await this.ops.status();
    const c = this.status.counts;
    // The items the reviewed manifest holds are DISCOVERED for good (the first blocks at its turn and the in-flight
    // index keeps the rest queued): not open work. /run/finish closes the run partial around them and names them.
    const held = this.status.held.length;
    const open = Math.max(0, (c.DISCOVERED ?? 0) - held) + (c.RETRYING ?? 0) + STAGES.reduce((n, s) => n + (c[s] ?? 0), 0);
    this.log.info('status', { complete: c.COMPLETE ?? 0, blocked: c.BLOCKED ?? 0, withdrawn: c.WITHDRAWN_AT_SOURCE ?? 0, held, remaining: open });
    if (open > 0) {
      this.log.error('note', { code: 'QUEUE_NOT_EMPTY' });
      this.writeSummary(true);
      return 1;
    }
    // §I.3.1: the three sitemaps again, at the store's pace, and the diff with the manifest. A sitemap the store's
    // robots.txt now disallows is a policy stop (§J.1), never an empty answer: the close is refused before the
    // protected snapshot and the irreversible /run/finish, rather than report every product "no longer listed".
    const robots = await this.ensureRobots();
    if (SITEMAP_PATHS.some((path) => !robotsAllows(robots, path))) {
      this.log.error('note', { code: 'SITEMAP_DISALLOWED' });
      this.writeSummary(true);
      return 1;
    }
    const urls: string[] = [];
    for (const path of SITEMAP_PATHS) urls.push(...parseSitemap(await this.store.sitemap(path)));
    const diff = sitemapDiff(productHandles(urls), this.deps.bundle.rows);
    this.log.info('sitemap', { listed: diff.listed, new: diff.added.length, removed: diff.removed.length });
    // §I.3.3: the public sweep of the brand's visible products (v1), at ≤ 4 requests per second. Its numbers are the
    // BRAND's (every visible Bambu Lab product, this run's and the ones it never wrote), labelled so (verify.ts).
    const sweep = await publicBrandSweep(this.site);
    this.log.info('sweep', { visible: sweep.visible, pages: sweep.pages, unpriced: sweep.unpriced, whole: sweep.whole, complete: c.COMPLETE ?? 0 });
    const after = await this.ops.protectSnapshot('after');
    this.log.info('protect', { phase: 'after', subjects: after.subjects });
    const fin = await this.finishSettled();
    if (fin.state === 'unconfirmed') {
      if (fin.gone === 'yes') this.log.warning('finish_unconfirmed', { gone: fin.gone });
      else this.log.error('finish_unconfirmed', { gone: fin.gone });
    } else this.log.info('finish', { state: fin.state });
    if (fin.held.length) this.finishedHeld = fin.held;
    const gone = fin.gone ?? (await this.tokenGone());
    if (fin.gone === null) this.log.info('token_gone', { gone });
    this.seal('close-report.json', { run_id: this.runId, status: this.status, sitemap: diff, sweep, protect_after: after, finish: { state: fin.state, held: fin.held }, token_gone: gone });
    this.writeSummary(false, fin.state);
    // A lost /run/finish answer with the token gone: the run is finished as far as the door can say (a second close
    // could not even start), so the close passes, unconfirmed, and the owner reads the state with mode=report. With
    // /hello unsettled as well nothing is known: the report is sealed, and the close is not green.
    if (fin.state === 'unconfirmed') return gone === 'yes' ? 0 : 1;
    return gone !== 'no' && (fin.state === 'closed' || fin.state === 'partial') ? 0 : 1;
  }

  /**
   * /run/finish, settled. It is not idempotent, and its answer can be lost after it committed (a 5xx on the way
   * back, no answer at all): then /hello says what happened, as after a finish that answered (tokenGone). A 404 —
   * the run's token is gone: the finish committed (or the kill switch cleared the token) — records the end
   * `unconfirmed`, never sent again. A 200 — the run still answers, so the finish did not commit — sends it again
   * after the §B.5 wait, within the deadline (its UPDATE is guarded on an open run, so a second one cannot apply
   * twice). A /hello that never settles leaves the end `unconfirmed` too, with the token unconfirmed.
   */
  private async finishSettled(): Promise<{ state: string; held: HeldRef[]; gone: 'yes' | 'unconfirmed' | null }> {
    for (let attempt = 0; ; attempt++) {
      let failure: OpsError;
      try {
        return { ...(await this.ops.finish()), gone: null };
      } catch (err) {
        if (!(err instanceof OpsError) || err.kind !== 'transient') throw err;
        failure = err;
      }
      this.log.warning('finish_unsettled', { code: failure.code, status: failure.status });
      const gone = await this.tokenGone();
      if (gone !== 'no') return { state: 'unconfirmed', held: [], gone };
      const wait = Math.max(failure.retryAfterMs ?? 0, backoff(attempt));
      if (attempt + 1 >= FINISH_ATTEMPTS || !this.deadline.fits(wait, 60_000)) throw failure;
      await this.pause(wait);
    }
  }

  /**
   * After /run/finish: does the old token answer 404 now? A 404 is `yes`; an answer (200, or a refusal that is not
   * transient) is `no` — the token still opens a door. A transient one (429, 5xx, no answer) is neither: asked again
   * with backoff inside the deadline, and when it never settles the end is `unconfirmed`. The run is finished either
   * way, and a second close could not confirm it (its first /hello meets the 404 and the importer never starts), so
   * an unconfirmed end is recorded, never a failed close.
   */
  private async tokenGone(): Promise<'yes' | 'no' | 'unconfirmed'> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ops.hello();
        return 'no';
      } catch (err) {
        if (!(err instanceof OpsError)) throw err;
        if (err.kind === 'gone') return 'yes';
        if (err.kind !== 'transient') return 'no';
        const wait = Math.max(err.retryAfterMs ?? 0, backoff(attempt));
        if (attempt + 1 >= TOKEN_GONE_ATTEMPTS || !this.deadline.fits(wait, 60_000)) return 'unconfirmed';
        await this.pause(wait);
      }
    }
  }

  // ---------------------------------------------------------------- withdraw (§1 row 20, §A.3)

  async withdraw(): Promise<number> {
    if (!this.cfg.item) throw new ConfigError('withdraw needs the item');
    await this.hello();
    // A delta run's new product is not in the reviewed manifest: its row is the one the Worker registered (rowOf).
    this.deltaView = new Map(this.runIsDelta ? (await this.ops.deltaRows()).map((r) => [r.source_product_id, r]) : []);
    const row = this.rowOf(this.cfg.item)?.row;
    if (!row) throw new JobStop('REVIEWED_SCOPE_REFUSED', true);
    const found = await this.withdrawEvidence(row);
    if (!found) {
      this.log.error('note', { code: 'SITEMAP_DISALLOWED' });
      return 1;
    }
    const { second, absent } = found;
    if (second.outcome !== 'withdrawn' || !absent) {
      this.log.error('note', { code: 'SOURCE_STILL_PRESENT' });
      return 1;
    }
    const approval = `workflow-60-run-${this.cfg.githubRunId || 'local'}`;
    let a: { state: string };
    try {
      a = await this.ops.withdraw(row.source_product_id, approval, { second_fetch: second, sitemap_absent: absent });
    } catch (err) {
      // The door refuses a withdrawal with a 409: IMPORT_WITHDRAW_REFUSED (permanent) when the item is not BLOCKED
      // SOURCE_WITHDRAWN or its evidence does not hold (a second fetch less than 6 h after the block, an approval it
      // does not take), IMPORT_ILLEGAL_TRANSITION (stale) when the item moved under the batch. The runner cannot tell
      // which from the code: it reads where the item is and reports it in words that do not guess; an irreversible,
      // owner-approved step is never sent again on a guess.
      if (!(err instanceof OpsError) || (err.kind !== 'stale' && err.code !== 'IMPORT_WITHDRAW_REFUSED')) throw err;
      this.status = await this.ops.status().catch(() => this.status);
      const ref = [this.status?.current, this.status?.next].find((r) => r?.source_product_id === row.source_product_id);
      if (ref) this.log.item(row.queue_position, row.handle, 'WITHDRAW', 'withdraw_refused', { code: err.code, state: ref.state });
      else this.log.item(row.queue_position, row.handle, 'WITHDRAW', 'withdraw_refused_unseen', { code: err.code });
      return 1;
    }
    this.log.item(row.queue_position, row.handle, 'WITHDRAW', 'withdrawn', { state: a.state });
    return a.state === 'WITHDRAWN_AT_SOURCE' ? 0 : 1;
  }

  /**
   * A withdrawal's evidence: the second fetch (the page gone: 404/410 or a redirect away) and a real read of the
   * sitemap, whose handles are compared decoded (a non-ASCII handle is percent-encoded there). null when robots.txt
   * disallows the sitemap: a policy stop (§J.1), never an empty sitemap — nothing is withdrawn.
   */
  private async withdrawEvidence(row: ManifestRow): Promise<WithdrawEvidence | null> {
    const robots = await this.ensureRobots();
    let second: WithdrawEvidence['second'] = { at: this.now(), outcome: 'present', status: 200 };
    if (robotsAllows(robots, `/products/${rawHandleOf(row)}`)) {
      try {
        const page = await this.store.productPage(rawHandleOf(row));
        second = { at: this.now(), outcome: 'present', status: page.status };
      } catch (err) {
        if (!(err instanceof ImportStop) || err.code !== 'SOURCE_WITHDRAWN') throw err;
        second = { at: this.now(), outcome: 'withdrawn', status: err.detail.status ?? 0 };
      }
    }
    if (!robotsAllows(robots, '/sitemap_products_1.xml')) return null;
    const listed = productHandles(parseSitemap(await this.store.sitemap('/sitemap_products_1.xml')));
    return { second, absent: !listed.includes(row.handle.normalize('NFC')) };
  }

  /**
   * mode=run with auto_withdraw (the owner's standing approval of 2026-10-18, §1 row 20): an item BLOCKED
   * SOURCE_WITHDRAWN is fetched again AUTO_WITHDRAW_WAIT_MS later, at the store's pace, and withdrawn when the page
   * is still gone and the sitemap no longer lists it. Anything less — the page back, still listed, a fetch that did
   * not settle, a refusal at the door — keeps it BLOCKED ('kept'), and the queue stops as without it.
   */
  private async autoWithdraw(row: ManifestRow): Promise<'withdrawn' | 'kept' | 'deadline'> {
    const log = (t: Parameters<ImportLog['item']>[3], p: Parameters<ImportLog['item']>[4] = {}) => this.log.item(row.queue_position, row.handle, 'WITHDRAW', t, p);
    // The wait and two store reads must fit: else the next job (the chain carries auto_withdraw) meets it BLOCKED.
    if (!this.deadline.fits(AUTO_WITHDRAW_WAIT_MS, 2 * WORST.EXTRACT)) return 'deadline';
    log('withdraw_auto_wait', { seconds: AUTO_WITHDRAW_WAIT_MS / 1000 });
    await this.pause(AUTO_WITHDRAW_WAIT_MS);
    let found: WithdrawEvidence | null;
    try {
      found = await this.withdrawEvidence(row);
    } catch (err) {
      if (!(err instanceof ImportStop)) throw err;
      this.log.error('note', { code: err.code });
      return 'kept';
    }
    if (!found) {
      this.log.error('note', { code: 'SITEMAP_DISALLOWED' });
      return 'kept';
    }
    if (found.second.outcome !== 'withdrawn' || !found.absent) {
      log('withdraw_auto_kept', { what: found.second.outcome, status: found.second.status, absent: found.absent });
      return 'kept';
    }
    const approval = `workflow-60-run-${this.cfg.githubRunId || 'local'}-auto`;
    try {
      const a = await this.ops.withdraw(row.source_product_id, approval, { second_fetch: found.second, sitemap_absent: true, auto: true });
      log('withdrawn_auto', { state: a.state });
      return a.state === 'WITHDRAWN_AT_SOURCE' ? 'withdrawn' : 'kept';
    } catch (err) {
      // As in mode withdraw: a refusal is reported, never sent again on a guess.
      if (!(err instanceof OpsError) || (err.kind !== 'stale' && err.code !== 'IMPORT_WITHDRAW_REFUSED')) throw err;
      log('withdraw_auto_refused', { code: err.code });
      return 'kept';
    }
  }
}

// ------------------------------------------------------------------ the process entry

/** A sealer writing only `<outDir>/<name>.sealed` (mode 0600, never over an existing file). */
export function fileSealer(outDir: string, publicKey: string): (name: string, data: Buffer) => number {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  return (name, data) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(name)) throw new Error('an artifact name the import does not write');
    const sealed: Buffer = sealBuffer(publicKey, data);
    data.fill(0);
    writeFileSync(join(outDir, `${name}.sealed`), sealed, { mode: 0o600, flag: 'wx' });
    return sealed.length;
  };
}

export function githubOutput(file: string | undefined): (key: string, value: string) => void {
  return (key, value) => {
    if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(value)) throw new Error('a malformed step output');
    if (file) appendFileSync(file, `${key}=${value}\n`);
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = resolve(new URL('../../', import.meta.url).pathname);
  let cfg: RunConfig;
  try {
    cfg = configFromEnv(env, root);
  } catch (err) {
    process.stdout.write(`::error::[import] ${err instanceof ConfigError ? err.message : 'the importer configuration is invalid'}\n`);
    return 2;
  }
  const log = new ImportLog((line) => process.stdout.write(`${line}\n`), { siteOrigin: cfg.siteOrigin });
  const output = githubOutput(env.GITHUB_OUTPUT);
  let token = '0'.repeat(64);
  let openedRunId = '';
  try {
    if (cfg.mode !== 'preflight') token = takeToken(env.IMPORT_TOKEN_FILE);
    if (env.IMPORT_RUN_FILE && existsSync(env.IMPORT_RUN_FILE)) {
      const id = readFileSync(env.IMPORT_RUN_FILE, 'utf8').trim();
      if (/^cir_[0-9a-f]{24}$/.test(id)) openedRunId = id;
    }
  } catch (err) {
    log.error('note', { code: 'TOKEN_FILE_REFUSED' });
    log.exception('JOB', err);
    output('more', 'false');
    output('blocked', 'true');
    output('run_id', cfg.runId);
    return 1;
  }
  let bundle: ReviewedBundle;
  try {
    bundle = loadReviewedBundle(cfg.dataDir);
  } catch (err) {
    log.exception('JOB', err);
    output('more', 'false');
    output('blocked', 'true');
    output('run_id', cfg.runId || openedRunId);
    return 1;
  }
  const summary = new SummaryWriter(env.GITHUB_STEP_SUMMARY);
  if (env.GITHUB_STEP_SUMMARY && existsSync(env.GITHUB_STEP_SUMMARY)) summary.begin(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'));
  const local = LOCAL_ORIGIN.test(cfg.siteOrigin);
  const refused = { count: 0 };
  const network: FetchLike = (url, init) => fetch(url, init);
  const importer = new Importer(cfg, {
    clock: realClock,
    fetch: local ? localOnlyFetch(network, refused) : network,
    log,
    token,
    bundle,
    seal: fileSealer(cfg.outDir, cfg.sealKey),
    output,
    summary,
    openedRunId,
    browser: async () => {
      if (cfg.mode !== 'run' && cfg.mode !== 'delta') return null;
      const { BrowserChecker } = await import('./browser');
      return BrowserChecker.launch(cfg.siteOrigin, env);
    },
  });
  const code = await importer.main();
  if (local) log.info('local_only', { refused: refused.count });
  return code;
}

/** A digest that names a token without revealing it (tests compare it with the stored hash). */
export const tokenSha256 = (token: string) => createHash('sha256').update(token).digest('hex');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write('::error::[import] the importer stopped unexpectedly\n');
      process.exitCode = 1;
    }
  );
}
