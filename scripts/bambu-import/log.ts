/**
 * THE IMPORT LOG: AN ALLOW-LIST FORMATTER (Bambu import spec §A.8).
 *
 * The repository is public, and so are its Actions logs. Nothing reaches the
 * log as free text: every line is built here from typed fields, and each field
 * is checked against its own shape before it is printed. It prints only
 *
 *   - the Bambu handle (a public store word), the stage, the HTTP status,
 *     counts, durations and booleans;
 *   - the public live URL of a COMPLETE product (https://<site>/product/<slug>);
 *   - error codes and TEMPLATE messages (a fixed table; parameters are numbers,
 *     codes, stages and handles only).
 *
 * It never prints the token, a request header, the D1 database id, an account
 * id, a protected fingerprint, a Levonis product name / slug / id that is not
 * public, a `source_url` or `canonical_url`, or conflict details — none of them
 * has a field here, and a value of the wrong shape is replaced by a marker.
 *
 * Unhandled exceptions print `err.name` plus a scrubbed message: hex runs of
 * 32+ characters, `Bearer` values and anything after `://` are redacted, and
 * every secret the logger was told about is masked.
 */

export type LogSink = (line: string) => void;

/** The stages and steps a log line may name. */
export const LOG_STAGES = [
  'JOB',
  'HELLO',
  'MANIFEST',
  'ROBOTS',
  'SITEMAP',
  'LEASE',
  'EXTRACTING',
  'ENRICHING',
  'VALIDATING',
  'INGESTING_MEDIA',
  'WRITING',
  'PUBLISHING',
  'VERIFYING_LIVE',
  'COMPLETE',
  'RETRYING',
  'BLOCKED',
  'WITHDRAW',
  'TAXONOMY',
  'PROTECT',
  'FINISH',
  'STATUS',
  'SWEEP',
  'BROWSER',
  'PREFLIGHT',
  'ARTIFACT',
] as const;
export type LogStage = (typeof LOG_STAGES)[number];

/**
 * The template messages. Parameters in `{name}` are filled only from
 * `Params` values that passed their shape check; anything else prints `[?]`.
 */
export const TEMPLATES = {
  job_start: 'job start: mode {mode}; max items {max}; resume {resume}; chain {chain} ({count})',
  job_end: 'job end: {complete} complete this job; more {more}; blocked {blocked}',
  hello_ok: 'hello: protocol {protocol}; migrations 0193/0194/0195 present {present}; reviewed files equal {equal} ({files})',
  hello_gone: 'hello: the run token answers 404 (revoked, expired or closed run)',
  bundle_mismatch: 'hello: the reviewed files differ from the Worker bundle ({files} differ)',
  manifest_sent: 'manifest: {rows} rows sent in {calls} calls',
  robots_read: 'robots.txt: {rules} rules read; planned paths allowed {allowed}',
  robots_disallow: 'robots.txt disallows a planned store path: the item stops (policy)',
  challenge: 'store answered a bot challenge or 403: never bypassed; the item stops',
  store_status: 'store page: HTTP {status} in {ms} ms',
  store_wait: 'store asks to wait {seconds} s',
  extracted: 'extracted: {groups} groups, {values} values, {variants} variants, {images} images',
  enriched: 'enriched: {documents} documents checked ({dead} dead), {trackers} trackers resolved of {tracker_links}, {wiki} wiki pages read, {wiki_specs} wiki specs',
  validated: 'validated: payload accepted; {specs} specs, {relations} relations, {documents} documents; plan estimate {estimate}',
  staged: 'staged: plan estimate {estimate}; {conflicts} conflicts; {warnings} warnings',
  media_call: 'media: {sent} sent, {stored} stored, {failed} failed, {pending} pending ({ms} ms)',
  media_done: 'media: {stored} stored, {failed} failed, {omitted} omitted of {total}',
  written: 'written: created {created}; groups {groups}; variants {variants}; images {images}; protected fields equal {fp_equal}',
  published: 'publish-finish: done ({ms} ms)',
  gallery: 'gallery as written: {rows} image rows of {images} in the payload (from {what})',
  verify_check: 'verify {check}: ok {ok} (HTTP {status})',
  verify_done: 'verified: {passed} of {total} checks passed',
  cache_wait: 'verify: a stale answer; purge again and wait {seconds} s',
  complete: 'COMPLETE: {url}',
  retrying: 'retrying {code}: wait {seconds} s (stage attempt {attempt})',
  deadline_exit: 'deadline: {need} s needed, {left} s left; the lease is released and the job exits (more)',
  parked: 'parked {code}: retry in {seconds} s, in a later job; the lease is released and the job exits (more)',
  ops_unsettled: 'ops {call}: no settled answer after {attempts} tries; the item is left to the next job (more)',
  lease_refused: 'lease refused: another item of the run is in flight; the run status is read again in {seconds} s (nothing blocks)',
  door_unsettled: 'ops {call}: {code} (HTTP {status}) after its retries; nothing is open in this job, the next job resumes (more)',
  withdraw_refused: 'withdraw refused ({code}; the item is {state} now): the door withdraws only an item BLOCKED SOURCE_WITHDRAWN whose second fetch is at least 24 h after the block; nothing is sent again',
  withdraw_refused_unseen: 'withdraw refused ({code}; the run status does not name the item): the door withdraws only an item BLOCKED SOURCE_WITHDRAWN whose second fetch is at least 24 h after the block; nothing is sent again',
  rebuilt_differs: 'the page read again is not the payload written (attempt {attempt}): nothing is verified against it',
  blocked: 'BLOCKED {code}; the queue stops here',
  resumed: 'resumed from {from} at {stage}',
  ops_error: 'ops {call}: {code} (HTTP {status})',
  status: 'run status: {complete} complete, {blocked} blocked, {withdrawn} withdrawn, {held} held by the manifest, {remaining} remaining',
  taxonomy: 'prepare-taxonomy: {nodes} nodes, brand created {brand}, {synonyms} synonyms',
  protect: 'protect-snapshot {phase}: {subjects} subjects',
  finish: 'run finished: state {state}',
  token_gone: 'the old token now answers 404: {gone}',
  sitemap: 'sitemaps re-read: {listed} listed, {new} new, {removed} no longer listed',
  sweep: 'sweep {what}: {passed} of {total} passed',
  withdrawn: 'withdrawn at the source: state {state}',
  artifact: 'sealed artifact {name}: {bytes} bytes',
  browser: 'browser: {checks} checks, {failed} failed, {screens} screenshots',
  preflight: 'preflight: public context carries products_priced {priced}',
  order_violation: 'EXTRACT refused: the previous item has no committed COMPLETE (runner bug); the job stops',
  local_only: 'local dry run: {refused} requests to a host other than 127.0.0.1 refused, never sent',
  note: '{code}',
} as const;
export type TemplateKey = keyof typeof TEMPLATES;

export type Param = string | number | boolean | null | undefined;
export type Params = Readonly<Record<string, Param>>;

const HANDLE = /^[\p{Ll}\p{Nd}][\p{Ll}\p{Nd}\p{M}._-]{0,159}$/u;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const WORD = /^[a-z][a-z0-9_]{0,31}$/;
const RUN_ID = /^cir_[0-9a-f]{24}$/;
const MODE = /^(snapshot|preflight|open|run|close|report|dryrun|withdraw|revoke)$/;

/** Parameter names whose values are checked as something other than a number or boolean. */
const PARAM_SHAPES: Readonly<Record<string, RegExp>> = {
  code: CODE,
  stage: new RegExp(`^(?:${LOG_STAGES.join('|')})$`),
  from: new RegExp(`^(?:${LOG_STAGES.join('|')}|DISCOVERED|)$`),
  mode: MODE,
  check: WORD,
  call: /^[a-z][a-z/_:-]{0,40}$/,
  phase: /^(before|after)$/,
  // A run state or an item state, from the fixed lists (§B.3): a Worker answer of any other text prints [?].
  state: /^(?:open|running|blocked|closed|partial|DISCOVERED|EXTRACTING|ENRICHING|VALIDATING|INGESTING_MEDIA|WRITING|PUBLISHING|VERIFYING_LIVE|RETRYING|BLOCKED|COMPLETE|WITHDRAWN_AT_SOURCE)$/,
  what: WORD,
  name: /^[a-z0-9][a-z0-9._-]{0,80}\.sealed$/,
  run: RUN_ID,
  gone: /^(?:yes|no|unconfirmed)$/,
};

const MASK = '[?]';

/** One reason, one line, nothing an outsider could use (also used for exceptions). */
export function scrub(text: unknown, secrets: readonly string[] = []): string {
  let out = String(text ?? '');
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join('[masked]');
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/[0-9a-f]{32,}/gi, '[hex]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/:\/\/\S*/g, '://[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export interface LiveUrlRule {
  /** The public site origin, e.g. https://levonis-iq.com (or http://127.0.0.1:<port> in a local dry run). */
  siteOrigin: string;
}

export class ImportLog {
  private secrets: string[] = [];
  readonly lines: string[] = [];

  constructor(
    private readonly sink: LogSink,
    private readonly rule: LiveUrlRule
  ) {}

  /** A value that must never be printed, even through an exception message. */
  addSecret(secret: string): void {
    if (secret) this.secrets.push(secret);
  }

  /** A handle as the store writes it (lower-case words, digits, dashes), else the marker. */
  static handle(value: unknown): string {
    return typeof value === 'string' && HANDLE.test(value) ? value : MASK;
  }

  private param(name: string, value: Param): string {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : MASK;
    const shape = PARAM_SHAPES[name];
    if (name === 'url') return this.liveUrl(value) ?? MASK;
    if (shape) return shape.test(value) ? value : MASK;
    // A string where a number was expected (e.g. a count passed as text): digits only.
    return /^\d{1,12}$/.test(value) ? value : MASK;
  }

  /** The public live URL of a COMPLETE product: <site>/product/<slug>, nothing else. */
  liveUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const origin = this.rule.siteOrigin.replace(/\/+$/, '');
    if (!value.startsWith(`${origin}/product/`)) return null;
    const slug = value.slice(origin.length + '/product/'.length);
    return /^[a-z0-9][a-z0-9-]{0,159}$/.test(slug) ? value : null;
  }

  private format(template: TemplateKey, params: Params): string {
    return TEMPLATES[template].replace(/\{([a-z_]+)\}/g, (_m, name: string) => this.param(name, params[name]));
  }

  private emit(line: string): void {
    const clean = line.replace(/[\r\n]+/g, ' ');
    this.lines.push(clean);
    this.sink(clean);
  }

  /** A job-level line. */
  info(template: TemplateKey, params: Params = {}): void {
    this.emit(`[import] ${this.format(template, params)}`);
  }

  /** A line about one item: its queue position, its handle and the stage. */
  item(position: number, handle: string, stage: LogStage, template: TemplateKey, params: Params = {}): void {
    const pos = Number.isInteger(position) && position >= 0 ? String(position) : MASK;
    const st = (LOG_STAGES as readonly string[]).includes(stage) ? stage : MASK;
    this.emit(`[import] #${pos} ${ImportLog.handle(handle)} ${st}: ${this.format(template, params)}`);
  }

  /** A GitHub annotation built from a template (never free text). */
  error(template: TemplateKey, params: Params = {}): void {
    this.emit(`::error::${this.format(template, params)}`);
  }

  warning(template: TemplateKey, params: Params = {}): void {
    this.emit(`::warning::${this.format(template, params)}`);
  }

  /** An unhandled exception: its name and a scrubbed message. */
  exception(where: LogStage, err: unknown): void {
    const name = err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    this.emit(`::error::[import] ${where}: ${name}: ${scrub(message, this.secrets)}`);
  }
}

/** A logger that writes to stdout (GitHub reads it). */
export function consoleLog(siteOrigin: string): ImportLog {
  return new ImportLog((line) => process.stdout.write(`${line}\n`), { siteOrigin });
}
