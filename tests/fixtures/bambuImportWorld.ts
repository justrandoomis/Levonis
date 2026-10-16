/**
 * A FAKE WORLD FOR THE BAMBU IMPORT RUNNER (import spec §A.3, §I.1, §J):
 * a fake clock, a fake ops endpoint that keeps the §B.3 state machine (the
 * legal graph, the in-flight index, stage attempts, the lease), a fake store
 * serving the committed fixture pages, a fake CDN for document checks, and a
 * fake public site whose answers are derived from what `/write` received —
 * the runner's verification reads them, never its own payload.
 *
 * Every store request and every ops event takes a number from one global
 * sequence, so a test can prove the order of things (EXTRACT never before the
 * previous COMPLETE) the way §H.3's one-at-a-time proof reads the event log.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertImportPayload, type ImportPayload } from '../../packages/catalog/src/bambuImport/payload';
import { canonicalJson } from '../../packages/catalog/src/bambuImport/fingerprint';
import { ROOT } from './d1';
import type { Clock } from '../../scripts/bambu-import/deadline';
import { isPublicSpec } from '../../scripts/bambu-import/verify';
import { loadReviewedBundle, type ReviewedBundle } from '../../scripts/bambu-import/discover';
import { ImportLog } from '../../scripts/bambu-import/log';
import { SummaryWriter } from '../../scripts/bambu-import/summary';
import { Importer, type BrowserLike, type RunConfig } from '../../scripts/bambu-import/run';
import type { BrowserResult } from '../../scripts/bambu-import/browser';
// @ts-expect-error - plain ESM helper (the dry run's fixture bundle), no types
import { fixtureBundle } from '../../scripts/e2e-bambu-import.mjs';
// @ts-expect-error - plain ESM helper run by workflow 60, no types
import { sealBuffer, generateSealKeys } from '../../scripts/bambu-import/seal.mjs';

export const SITE = 'https://levonis-iq.com';
export const STORE = 'https://us.store.bambulab.com';
export const RUN_ID = 'cir_0123456789abcdef01234567';
export const TOKEN = 'a1'.repeat(32);
export const UA = 'Mozilla/5.0 (compatible; LevonisCatalogImport/1.0; +https://levonis-iq.com)';
const MIN = 60_000;

export class FakeClock implements Clock {
  constructor(public t = Date.parse('2026-10-16T08:00:00.000Z')) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += Math.max(0, ms);
  }
}

type Rec = Record<string, unknown>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const WORKING = ['EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING', 'PUBLISHING', 'VERIFYING_LIVE'];
const NEXT: Record<string, string> = { '': 'EXTRACTING', EXTRACTING: 'ENRICHING', ENRICHING: 'VALIDATING', VALIDATING: 'INGESTING_MEDIA', INGESTING_MEDIA: 'WRITING', WRITING: 'PUBLISHING', PUBLISHING: 'VERIFYING_LIVE', VERIFYING_LIVE: 'COMPLETE' };

/** The §B.3 transition trigger, as a function. */
export function legal(from: string, to: string, lastCompleted: string): boolean {
  if (from === 'DISCOVERED') return to === 'EXTRACTING' && lastCompleted === '';
  if (WORKING.includes(from) && NEXT[from] === to) return true;
  if (WORKING.includes(from) && (to === 'RETRYING' || to === 'BLOCKED')) return true;
  if (from === 'RETRYING' && to === 'BLOCKED') return true;
  if (from === 'BLOCKED' && to === 'RETRYING') return true;
  if ((from === 'RETRYING' || from === 'BLOCKED') && NEXT[lastCompleted] === to) return true;
  return false;
}

export interface FakeItem {
  sid: string;
  handle: string;
  queue_position: number;
  state: string;
  last_completed: string;
  attempts: number;
  stage_attempts: number;
  retry_at: string;
  blocker_code: string;
  lease_token: string;
  lease_until: number;
  levonis_product_id: string;
  slug: string;
  payload: ImportPayload | null;
  payload_sha: string;
  media: Map<string, { r2_key: string }>;
  title: string;
  /** What /write did: a new product or a merge into a reviewed existing one. */
  match_kind: '' | 'created' | 'merged';
  /** §A.10: a product this run created, hidden by a BLOCKED event after WRITTEN. */
  hidden: boolean;
  /** The edge still serves the hidden answers until /publish-finish purges them. */
  cachedHidden: boolean;
}

export interface Injection {
  method?: string;
  path: RegExp;
  times: number;
  respond: () => Response;
}

export interface WorldEvent {
  seq: number;
  sid: string;
  state: string;
  outcome: string;
  code: string;
  release: boolean;
  retry_at: string;
}

export interface WorldOptions {
  /** Robots.txt the store serves. */
  robots?: string;
  /** A store answer per handle (default: the fixture page). */
  storePage?: (handle: string, attempt: number) => Response | null;
  /**
   * ONE planted private value the fake Worker answers in EVERY field it has (the log test): free text, and
   * every field the runner shape-checks — status.current.handle, current_product, blocker, failed_stage, a
   * missing-info reason and a finance key, the lease's slug and stage_data, run/finish and withdraw state,
   * error messages. Planted on its own (never joined with others), so a value of a field's own shape — a
   * lower-case slug, an UPPER_SNAKE SKU, a snake_case key — is really tried against that field.
   */
  planted?: string;
  /** The reviewed SHA-256s /hello answers (default: the runner's own). */
  reviewed?: (own: Record<string, string>) => Record<string, string>;
  /** Initial states (sid → partial item). */
  items?: Record<string, Partial<FakeItem>>;
  /** The handles in the queue, in order (default both fixtures). */
  handles?: string[];
  /** A public-site answer that replaces the derived one (a stale cache, a broken page …). */
  siteOverride?: (method: string, path: string) => Response | null;
  /** Handles the products sitemap no longer lists. */
  sitemapExclude?: string[];
  /** Hosts other than the store and the site (document checks, trackers, the wiki): path → answer. */
  hostAnswer?: (host: string, method: string, path: string, headers: Record<string, string>) => Response | null;
  /** Reviewed existing-matches entries (a merge into an existing Levonis product, §E.1). */
  matches?: Array<{ source_product_id: string; decision: string; levonis_product_id: string; reason?: string }>;
}

export class World {
  readonly clock = new FakeClock();
  seq = 0;
  readonly events: WorldEvent[] = [];
  readonly calls: Array<{ seq: number; method: string; path: string; body: Rec | null; headers: Record<string, string>; at: number }> = [];
  readonly storeRequests: Array<{ seq: number; path: string; at: number; ua: string; cookie: string; acceptEncoding: string }> = [];
  readonly hostRequests: Array<{ host: string; method: string; path: string }> = [];
  /** Public-site reads (the runner's verification), numbered in the global sequence. */
  readonly siteRequests: Array<{ seq: number; method: string; path: string }> = [];
  readonly items = new Map<string, FakeItem>();
  readonly injections: Injection[] = [];
  readonly dir: string;
  readonly bundle: ReviewedBundle;
  readonly pages: Record<string, string>;
  runState = 'open';
  storeAttempts = new Map<string, number>();
  readonly logLines: string[] = [];
  readonly outputs: Record<string, string> = {};
  readonly sealed: Array<{ name: string; bytes: Buffer }> = [];
  readonly keys = generateSealKeys() as { publicKey: string; privateKeyPem: string };
  readonly summaryFile: string;

  constructor(readonly opts: WorldOptions = {}) {
    this.dir = mkdtempSync(join(tmpdir(), 'levonis-runner-world-'));
    const { text, rows } = fixtureBundle() as { text: Record<string, string>; rows: Array<{ source_product_id: string; handle: string; queue_position: number; title: string }> };
    const handles = opts.handles ?? rows.map((r) => r.handle);
    const kept = rows.filter((r) => handles.includes(r.handle));
    const manifest = JSON.parse(text['manifest.json']);
    manifest.rows = kept;
    text['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
    if (opts.matches) text['existing-matches.json'] = `${JSON.stringify({ version: 1, entries: opts.matches.map((m) => ({ reason: 'same_model', ...m })) }, null, 2)}\n`;
    for (const [file, body] of Object.entries(text)) {
      mkdirSync(dirname(join(this.dir, 'data', file)), { recursive: true });
      writeFileSync(join(this.dir, 'data', file), body);
    }
    this.bundle = loadReviewedBundle(join(this.dir, 'data'));
    this.pages = Object.fromEntries(
      ['filament-buffer', 'ams-2-pro'].map((h) => [h, readFileSync(join(ROOT, 'tests', 'fixtures', 'bambu', `${h}.page.html`), 'utf8')])
    );
    for (const r of kept) {
      this.items.set(r.source_product_id, {
        sid: r.source_product_id,
        handle: r.handle,
        queue_position: r.queue_position,
        state: 'DISCOVERED',
        last_completed: '',
        attempts: 0,
        stage_attempts: 0,
        retry_at: '',
        blocker_code: '',
        lease_token: '',
        lease_until: 0,
        levonis_product_id: '',
        slug: '',
        payload: null,
        payload_sha: '',
        media: new Map(),
        title: r.title,
        match_kind: '',
        hidden: false,
        cachedHidden: false,
        ...(opts.items?.[r.source_product_id] ?? {}),
      });
    }
    this.summaryFile = join(this.dir, 'summary.md');
    writeFileSync(this.summaryFile, '');
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  sid(handle: string): string {
    for (const i of this.items.values()) if (i.handle === handle) return i.sid;
    throw new Error(handle);
  }

  item(handle: string): FakeItem {
    return this.items.get(this.sid(handle))!;
  }

  inject(path: RegExp, times: number, respond: () => Response, method?: string): void {
    this.injections.push({ path, times, respond, method });
  }

  /** The Worker does the work, then the answer is lost on the way back (a 502): the runner must ask /lease. */
  readonly lost: Array<{ path: RegExp; times: number }> = [];
  loseAnswer(path: RegExp, times = 1): void {
    this.lost.push({ path, times });
  }

  private planted(): string {
    return this.opts.planted ?? '';
  }

  // ---------------------------------------------------------------- fetch

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    if (u.origin === STORE) return this.store(u, headers);
    if (u.origin === SITE && u.pathname.startsWith('/api/ops/catalog-import')) {
      const body = typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as Rec) : null;
      this.calls.push({ seq: ++this.seq, method, path: u.pathname.slice('/api/ops/catalog-import'.length), body, headers, at: this.clock.now() });
      for (const inj of this.injections) {
        if (inj.times > 0 && inj.path.test(u.pathname) && (!inj.method || inj.method === method)) {
          inj.times--;
          return inj.respond();
        }
      }
      if (headers.authorization !== `Bearer ${TOKEN}` || headers['x-levonis-import-protocol'] !== '2' || this.runState === 'closed') return json(404, { error: 'Not found' });
      const answer = this.ops(method, u.pathname.slice('/api/ops/catalog-import'.length), body);
      const lose = this.lost.find((l) => l.times > 0 && l.path.test(u.pathname));
      if (lose) {
        lose.times--;
        return json(502, { code: 'BAD_GATEWAY', message: 'lost' });
      }
      return answer;
    }
    if (u.origin === SITE) {
      this.siteRequests.push({ seq: ++this.seq, method, path: u.pathname });
      return this.opts.siteOverride?.(method, u.pathname) ?? this.site(method, u);
    }
    this.hostRequests.push({ host: u.host, method, path: u.pathname });
    const custom = this.opts.hostAnswer?.(u.host, method, u.pathname + u.search, headers);
    if (custom) return custom;
    if (u.host === 'store.bblcdn.com' || u.host === 'cdn.shopify.com') {
      return new Response(method === 'HEAD' ? null : 'PDF', { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '12345' } });
    }
    return new Response('not here', { status: 404 });
  };

  private store(u: URL, headers: Record<string, string>): Response {
    this.storeRequests.push({ seq: ++this.seq, path: u.pathname, at: this.clock.now(), ua: headers['user-agent'] ?? '', cookie: headers.cookie ?? '', acceptEncoding: headers['accept-encoding'] ?? '' });
    if (u.pathname === '/robots.txt') return new Response(this.opts.robots ?? 'User-agent: *\nDisallow: /cart\nDisallow: /*filter*\n', { status: 200 });
    if (u.pathname === '/sitemap_products_1.xml') {
      const locs = [...this.items.values()]
        .filter((i) => !(this.opts.sitemapExclude ?? []).includes(i.handle))
        .map((i) => `<url><loc>${STORE}/products/${i.handle}</loc></url>`)
        .join('');
      return new Response(`<urlset>${locs}</urlset>`, { status: 200 });
    }
    if (u.pathname.endsWith('.xml')) return new Response('<urlset></urlset>', { status: 200 });
    const m = /^\/products\/([^/]+)$/.exec(u.pathname);
    if (!m) return new Response('no', { status: 404 });
    const handle = decodeURIComponent(m[1]);
    const attempt = (this.storeAttempts.get(handle) ?? 0) + 1;
    this.storeAttempts.set(handle, attempt);
    const custom = this.opts.storePage?.(handle, attempt);
    if (custom) return custom;
    const page = this.pages[handle];
    return page ? new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('gone', { status: 404 });
  }

  // ---------------------------------------------------------------- the fake ops endpoint

  private inFlight(): FakeItem | null {
    for (const i of this.items.values()) if (!['DISCOVERED', 'COMPLETE', 'WITHDRAWN_AT_SOURCE'].includes(i.state)) return i;
    return null;
  }

  private lease(i: FakeItem): Rec {
    return {
      lease_token: i.lease_token,
      state: i.state,
      last_completed_stage: i.last_completed,
      attempts: i.attempts,
      stage_attempts: i.stage_attempts,
      retry_at: i.retry_at,
      stage_data: this.opts.planted ? { note: this.planted() } : {},
      blocker_code: i.blocker_code,
      levonis_product_id: i.levonis_product_id,
      // A slug the item does not have yet (not COMPLETE, not even written): the planted one.
      slug: i.slug || this.planted(),
      payload_sha256: i.payload_sha,
    };
  }

  private ops(method: string, path: string, body: Rec | null): Response {
    const planted = this.planted();
    if (path === '/hello') {
      return json(200, {
        protocol: 2,
        expected_migration: '0195_catalog_import_runs.sql',
        migrations_present: { '0193': true, '0194': true, '0195': true },
        reviewed: this.opts.reviewed ? this.opts.reviewed(this.bundle.sha256) : this.bundle.sha256,
        run: { id: RUN_ID, state: this.runState, cursor: 1 },
        worker_build: planted || 'test',
      });
    }
    if (path === '/run/status') {
      const counts: Record<string, number> = {};
      for (const i of this.items.values()) counts[i.state] = (counts[i.state] ?? 0) + 1;
      const current = this.inFlight();
      const next = [...this.items.values()].filter((i) => i.state === 'DISCOVERED').sort((a, b) => a.queue_position - b.queue_position)[0] ?? null;
      const ref = (i: FakeItem | null) =>
        i ? { source_product_id: i.sid, handle: planted || i.handle, queue_position: i.queue_position, state: i.state, last_completed_stage: i.last_completed } : null;
      return json(200, {
        run: { id: RUN_ID, state: this.runState },
        counts,
        current: ref(current),
        next: ref(next),
        last_verified_url: '',
        complete_count: counts.COMPLETE ?? 0,
        discovered_total: this.items.size,
        ...(planted
          ? {
              current_product: planted,
              blocker: planted,
              failed_stage: planted,
              missing_info_by_reason: { [planted]: 1, not_applicable: 2 },
              finance_protection: { guard_hits: 0, [planted]: 1, snapshots: { before: 1, [planted]: 2 } },
            }
          : {}),
      });
    }
    if (path === '/manifest') return json(200, { accepted: Array.isArray(body?.rows) ? body!.rows.length : 0 });
    if (path === '/run/prepare-taxonomy') return json(200, { created_nodes: 2, brand_created: false, synonyms_inserted: 5 });
    if (path === '/run/protect-snapshot') return json(200, { subjects: 43 });
    if (path === '/run/finish') {
      const partial = [...this.items.values()].some((i) => i.state === 'BLOCKED' || i.state === 'WITHDRAWN_AT_SOURCE');
      this.runState = 'closed';
      return json(200, { state: planted || (partial ? 'partial' : 'closed') });
    }
    const m = /^\/items\/(\d+)\/([a-z-]+)$/.exec(path);
    if (!m) return json(404, { code: 'NO_ROUTE', message: 'no route' });
    const i = this.items.get(m[1]);
    if (!i) return json(404, { code: 'ITEM_NOT_IN_RUN', message: `item ${planted}` });
    const action = m[2];
    const leaseOk = () => body?.lease_token === i.lease_token && i.lease_until > this.clock.now();
    const renew = () => {
      i.lease_until = this.clock.now() + 15 * MIN;
    };
    if (action === 'lease') {
      // The Worker's leaseItem (worker/lib/catalogImport/items.ts): the presented token is renewed while its lease
      // is live; any other caller — a new job after a lost one, a /lease retried after its answer was lost —
      // takes the item over with a fresh token, which makes the old one stale.
      if (!(body?.lease_token && body.lease_token === i.lease_token && i.lease_until > this.clock.now())) i.lease_token = `lt_${sha(`${i.sid}${this.seq}`).slice(0, 16)}`;
      renew();
      return json(200, this.lease(i));
    }
    if (action === 'readback') return json(200, { ok: true, mismatches: 0, ...(planted ? { names: planted } : {}) });
    if (action === 'withdraw') {
      if (i.state !== 'BLOCKED' || i.blocker_code !== 'SOURCE_WITHDRAWN' || typeof body?.approval_ref !== 'string') return json(409, { code: 'IMPORT_ILLEGAL_TRANSITION', message: 'withdraw' });
      i.state = 'WITHDRAWN_AT_SOURCE';
      this.events.push({ seq: ++this.seq, sid: i.sid, state: 'WITHDRAWN_AT_SOURCE', outcome: 'withdrawn', code: 'SOURCE_WITHDRAWN', release: false, retry_at: '' });
      return json(200, { state: planted || i.state });
    }
    if (!leaseOk()) return json(409, { code: 'IMPORT_LEASE_LOST', message: 'lease' });
    renew();
    if (action === 'event') {
      const to = String(body?.state ?? '');
      if (!legal(i.state, to, i.last_completed)) return json(409, { code: 'IMPORT_ILLEGAL_TRANSITION', message: `${i.state}->${to}` });
      if (i.state === 'DISCOVERED') {
        const other = this.inFlight();
        if (other && other.sid !== i.sid) return json(409, { code: 'IMPORT_ILLEGAL_TRANSITION', message: 'in flight' });
        i.attempts++;
      }
      if (WORKING.includes(i.state) && NEXT[i.state] === to) {
        i.last_completed = i.state;
        i.stage_attempts = 0;
      }
      if (to === 'RETRYING') {
        i.stage_attempts++;
        i.retry_at = String(body?.retry_at ?? '');
        if (body?.release === true) i.lease_until = this.clock.now();
      }
      if (to === 'BLOCKED') {
        i.blocker_code = String(body?.code ?? '');
        // §A.10: a product this run created is hidden in the same call when it blocks after WRITTEN.
        if (i.match_kind === 'created' && ['WRITING', 'PUBLISHING', 'VERIFYING_LIVE'].includes(i.last_completed)) i.hidden = true;
      }
      // A resume straight into VERIFYING_LIVE puts the hidden product back in D1; the edge keeps the hidden
      // answers until a purge (/publish-finish).
      if (to === 'VERIFYING_LIVE' && i.hidden) {
        i.hidden = false;
        i.cachedHidden = true;
      }
      if ((i.state === 'BLOCKED' || i.state === 'RETRYING') && to !== 'BLOCKED' && to !== 'RETRYING') i.blocker_code = '';
      i.state = to;
      const seq = ++this.seq;
      this.events.push({ seq, sid: i.sid, state: to, outcome: String(body?.outcome ?? ''), code: String(body?.code ?? ''), release: body?.release === true, retry_at: String(body?.retry_at ?? '') });
      return json(200, { state: i.state, last_completed_stage: i.last_completed, stage_attempts: i.stage_attempts, seq });
    }
    if (action === 'stage') {
      if (!['VALIDATING', 'INGESTING_MEDIA', 'WRITING'].includes(i.state)) return json(409, { code: 'IMPORT_ILLEGAL_TRANSITION', message: 'stage' });
      try {
        assertImportPayload(body?.payload);
      } catch {
        return json(400, { code: 'IMPORT_PAYLOAD_KEY_REFUSED', message: 'refused' });
      }
      i.payload = body!.payload as ImportPayload;
      // The Worker's own digest (worker/lib/catalogImport/reviewed.ts payloadSha256): sha256 of the canonical JSON.
      i.payload_sha = sha(canonicalJson(body!.payload));
      return json(200, {
        payload_sha256: i.payload_sha,
        invocation_estimate: 300,
        conflicts: planted ? [{ kind: 'field_kept_existing', detail: planted }] : [],
        warnings: planted ? [planted] : [],
      });
    }
    if (action === 'media') {
      const media = (Array.isArray(body?.media) ? body!.media : []) as Array<{ source_media_id: string; source_url: string }>;
      return json(200, {
        media: media.map((x) => {
          const key = `products/import/gallery/${sha(x.source_media_id)}.webp`;
          i.media.set(x.source_media_id, { r2_key: key });
          return { source_media_id: x.source_media_id, status: 'stored', r2_key: key, width: 800, height: 800, ...(planted ? { note: planted } : {}) };
        }),
      });
    }
    if (action === 'write') {
      if (i.state !== 'WRITING') return json(409, { code: 'IMPORT_ILLEGAL_TRANSITION', message: 'write' });
      if (body?.payload_sha256 !== i.payload_sha) return json(409, { code: 'PAYLOAD_SHA_MISMATCH', message: 'sha' });
      i.levonis_product_id = i.payload!.product_id;
      i.slug = `bambu-${i.handle}`;
      i.state = 'PUBLISHING';
      i.last_completed = 'WRITING';
      const merged = i.payload!.write_mode === 'merge';
      i.match_kind = merged ? 'merged' : 'created';
      this.events.push({ seq: ++this.seq, sid: i.sid, state: 'WRITTEN', outcome: 'ok', code: '', release: false, retry_at: '' });
      return json(200, {
        product_id: i.levonis_product_id,
        slug: i.slug,
        created: !merged,
        merged,
        match_kind: i.match_kind,
        counts: { groups: i.payload!.groups.length },
        before_fp_equal: merged ? true : null,
        after_money_default: merged ? null : true,
        ...(planted ? { note: planted } : {}),
      });
    }
    if (action === 'publish-finish') {
      if (!['PUBLISHING', 'VERIFYING_LIVE'].includes(i.state)) return json(409, { code: 'IMPORT_ILLEGAL_TRANSITION', message: 'publish-finish' });
      // Republish a product hidden on a block, and purge: the edge answers what D1 holds again.
      i.hidden = false;
      i.cachedHidden = false;
      if (i.state === 'PUBLISHING') {
        i.state = 'VERIFYING_LIVE';
        i.last_completed = 'PUBLISHING';
      }
      return json(200, { state: i.state });
    }
    if (action === 'complete') {
      if (i.state !== 'VERIFYING_LIVE') return json(409, { code: 'IMPORT_ILLEGAL_TRANSITION', message: 'complete' });
      i.state = 'COMPLETE';
      i.last_completed = 'VERIFYING_LIVE';
      const seq = ++this.seq;
      this.events.push({ seq, sid: i.sid, state: 'COMPLETE', outcome: 'ok', code: '', release: false, retry_at: '' });
      return json(200, { state: 'COMPLETE', seq, d1_checks: { visible: true, sellable: false, ...(planted ? { names: planted } : {}) } });
    }
    return json(404, { code: 'NO_ROUTE', message: 'no route' });
  }

  // ---------------------------------------------------------------- the fake public site

  /** Section slugs (root → leaf) and the tree nodes the fixtures' leaves resolve to. */
  private sectionsOf(handle: string): string[] {
    return handle === 'ams-2-pro' ? ['printer-accessories', 'fdm-accessories', 'ams-filament-feeding'] : ['maintenance', 'spare-parts', 'x1-p1-series-parts'];
  }

  private bySlug(slug: string): FakeItem | null {
    for (const i of this.items.values()) if (i.slug === slug && i.payload && !i.hidden && !i.cachedHidden) return i;
    return null;
  }

  private files(i: FakeItem, id: string): string {
    const m = i.media.get(id);
    return m ? `/files/${m.r2_key}` : '';
  }

  private site(method: string, u: URL): Response {
    const p = u.pathname;
    if (p === '/api/public/v1/context') return json(200, { data: { content: { products: 10, products_priced: 4 } } });
    if (p === '/api/catalog/tree') {
      const node = (id: string, slug: string, parent: string, name_en: string, name_ar: string, children: Rec[] = []) => ({ id, slug, parent_id: parent, name_en, name_ar, name_ckb: '', product_count: 1, children });
      return json(200, {
        success: true,
        roots: [
          node('cat_maint', 'maintenance', '', 'Maintenance', 'الصيانة', [
            node('cat_maint_spare', 'spare-parts', 'cat_maint', 'Spare parts', 'قطع الغيار', [node('cat_x1p1', 'x1-p1-series-parts', 'cat_maint_spare', 'X1 & P1 series parts', 'قطع غيار سلسلة X1 وP1')]),
          ]),
          node('cat_pacc', 'printer-accessories', '', 'Printer accessories', 'ملحقات الطابعات', [
            node('cat_pacc_fdm', 'fdm-accessories', 'cat_pacc', 'FDM accessories', 'ملحقات FDM', [node('cat_ams', 'ams-filament-feeding', 'cat_pacc_fdm', 'AMS & filament feeding', 'أنظمة تغذية المواد (AMS)')]),
          ]),
        ],
      });
    }
    if (p === '/api/products' && method === 'GET') {
      const items = [...this.items.values()].filter((i) => i.payload && this.sectionsOf(i.handle).includes(u.searchParams.get('category') ?? ''));
      return json(200, { products: items.map((i) => ({ slug: i.slug, id: i.levonis_product_id })), total: items.length, truncated: false });
    }
    if (p === '/api/public/v1/search') {
      const all = [...this.items.values()].filter((i) => i.payload);
      return json(200, { data: { products: all.map((i) => ({ slug: i.slug })) } });
    }
    if (p.startsWith('/files/') && method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
    if (p === '/api/price-requests' && method === 'POST') return json(401, { success: false, error: 'Authentication required', code: 'UNAUTHORIZED' });
    if (p === '/api/compare') return json(200, { products: [{ id: u.searchParams.get('ids') }] });
    if (p === '/api/compare/candidates') return json(200, { candidates: [...this.items.values()].filter((i) => i.payload).map((i) => ({ id: i.levonis_product_id })) });
    if (p === '/api/public/v1/products') return json(200, { data: [...this.items.values()].filter((i) => i.payload).map((i) => ({ slug: i.slug, price: { status: 'unpriced' } })), pagination: { next_cursor: null } });
    const v1 = /^\/api\/public\/v1\/products\/([^/]+)$/.exec(p);
    const siteP = /^\/api\/products\/([^/]+)(\/knowledge|\/quote)?$/.exec(p);
    const i = v1 ? this.bySlug(decodeURIComponent(v1[1])) : siteP ? this.bySlug(decodeURIComponent(siteP[1])) : null;
    if (!i || !i.payload) return json(404, { success: false, error: 'Not found', code: 'NOT_FOUND' });
    const pay = i.payload;
    const stored = pay.images.filter((x) => this.files(i, x.source_media_id));
    if (v1) {
      return json(200, {
        data: {
          slug: i.slug,
          name: { ar: pay.product.title_en, en: pay.product.title_en, ckb: pay.product.title_en },
          sections: this.sectionsOf(i.handle).map((slug) => ({ slug })),
          images: [...new Set(stored.map((x) => this.files(i, x.source_media_id)))].map((url) => ({ url: `${SITE}${url}` })),
          price: { currency: 'IQD', status: 'unpriced', amount: null, regular: null, from: false },
          purchase: null,
        },
      });
    }
    if (siteP?.[2] === '/quote') return json(409, { success: false, error: 'not available', code: 'PRICE_NOT_AVAILABLE', details: { price_status: 'unpriced' } });
    if (siteP?.[2] === '/knowledge') {
      const pub = pay.specs.filter((s) => isPublicSpec(s));
      const groups = new Map<string, Rec[]>();
      for (const s of pub.filter((x) => x.key !== 'package.contents')) {
        const list = groups.get(s.group) ?? [];
        list.push({ key: s.key, scope: { kind: s.scope_kind, id: s.scope_id }, region: s.region, status: s.status, unit: s.unit, value_num: s.value_num });
        groups.set(s.group, list);
      }
      const box = pub.filter((s) => s.key === 'package.contents').flatMap((s) => s.value_list.map((x) => ({ text: typeof x === 'object' ? x.text : String(x), scope: { kind: s.scope_kind, id: s.scope_id } })));
      return json(200, {
        specs: [...groups].map(([group, rows]) => ({ group, rows })),
        logistics: { product: [], package: [], shipment: [], carton: [] },
        in_the_box: box,
        compatibility: { compatible: pay.relations.map((r) => ({ relation: r.relation, label: r.target_label, state: r.state, scope: { kind: r.scope_kind, id: r.scope_id } })), not_compatible: [], requires: [], related: [] },
        documents: pay.documents.map((d) => ({ kind: d.kind, url: d.url })),
        swatches: pay.swatches.filter((s) => this.files(i, s.source_media_id)).map((s) => ({ option_value_id: s.value_id, url: this.files(i, s.source_media_id) })),
      });
    }
    return json(200, {
      price_status: 'unpriced',
      relations: {
        option_groups: pay.groups.map((g) => ({
          id: g.id,
          name_en: g.name_en,
          sort: g.sort,
          default_value_id: g.default_value_id,
          values: g.values.map((v) => ({ id: v.id, sort: v.sort })),
        })),
        variants: pay.variants.map((v) => ({ id: v.id, combo_key: v.combo_key })),
        images: stored.map((x) => ({ id: x.id, url: this.files(i, x.source_media_id), is_primary: x.is_primary, option_value_id: x.option_value_id, variant_id: x.variant_id })),
      },
    });
  }

  // ---------------------------------------------------------------- the runner, wired

  config(over: Partial<RunConfig> = {}): RunConfig {
    return {
      mode: 'run',
      runId: RUN_ID,
      maxItems: 0,
      resume: false,
      chain: true,
      chainCount: 0,
      item: '',
      siteOrigin: SITE,
      storeOrigin: STORE,
      dataDir: join(this.dir, 'data'),
      outDir: join(this.dir, 'out'),
      sealKey: this.keys.publicKey,
      githubRunId: '123',
      codeCommit: '',
      deadlineMs: this.clock.now() + 330 * MIN,
      ...over,
    };
  }

  /** A browser that passes (or the given result), with one screenshot. */
  browser(result: Partial<BrowserResult> = {}): () => Promise<BrowserLike> {
    return async () => ({
      check: async () => ({
        ok: true,
        checks: { image_decodes: true, unpriced_label: true },
        counts: { values_checked: 2, values_failed: 0, blocked_requests: 0, store_requests: 0, page_errors: 0 },
        selections: [],
        screenshots: [Buffer.from('PNG-SCREENSHOT')],
        ...result,
      }),
      close: async () => {},
    });
  }

  importer(over: Partial<RunConfig> = {}, browser: (() => Promise<BrowserLike | null>) | null = null): Importer {
    const log = new ImportLog((line) => this.logLines.push(line), { siteOrigin: SITE });
    return new Importer(this.config(over), {
      clock: this.clock,
      fetch: this.fetch,
      log,
      token: TOKEN,
      bundle: this.bundle,
      seal: (name, data) => {
        const bytes = sealBuffer(this.keys.publicKey, data) as Buffer;
        mkdirSync(join(this.dir, 'out'), { recursive: true });
        writeFileSync(join(this.dir, 'out', `${name}.sealed`), bytes);
        this.sealed.push({ name, bytes });
        return bytes.length;
      },
      output: (k, v) => {
        this.outputs[k] = v;
      },
      summary: new SummaryWriter(this.summaryFile),
      browser: browser ?? this.browser(),
    });
  }
}
