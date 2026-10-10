/**
 * «تحديث البيانات» ON LARGE PRODUCTS — the shared harness of
 * tests/productDataFileLargeApply.test.ts and tests/productDataFileBudget.test.ts
 * (docs/DECISIONS.md row 212).
 *
 * THE CENSUS: the D1 binding is wrapped (prepare / bind / run / first / all /
 * raw / batch), never the product code. Every statement is tagged at prepare
 * time with the frames of its stack (`planProductSave`, `inputStatements`,
 * `pricingAuditStatement`, `engineWriteStatements`, `auditStatements`, …), so
 * the write batch is broken down by who built each statement. A refused apply
 * never reaches `db.batch`: its batch is reconstructed as every statement
 * prepared from the route's own product fence onwards that was never run on
 * its own — the method is checked against real batches of applies that pass.
 * Queries are what D1 counts: each standalone run/first/all/raw is one, each
 * statement of each batch is one. Every request runs on a FRESH binding (cold
 * per-binding memos: a new isolate), the worst case.
 */
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteD1, type SqliteStatement } from './d1';
import { stubApp, post, get, type StubUser } from './app';
import { pricingWorld } from './procurementPricing';
import { templateRoutes } from '../../worker/routes/template';
import { OWNER, type PreviewProduct } from './dataFile';

// ------------------------------------------------------------------ the counting binding

Error.stackTraceLimit = 80;

export const KNOWN_FRAMES = [
  'rateLimit',
  'previousApply',
  'evaluateBlock',
  'liveState',
  'analyzeTemplate',
  'buildPatch',
  'compareBlock',
  'judgePricing',
  'loadPricingLive',
  'completenessPreview',
  'planSave',
  'planProductSave',
  'planTemplateMembership',
  'serialAnswerFence',
  'engineWriteStatements',
  'inputStatements',
  'ruleStatements',
  'batchHead',
  'batchTail',
  'pricingAuditStatement',
  'auditStatements',
  'audit',
  'saveProductAtomic',
  'queueDetachedProductMediaAfterCommit',
  'afterCatalogueWrite',
  'afterProductsChanged',
  'recomputeMany',
  'completenessAfterWrite',
  'fence',
] as const;

export interface Rec {
  id: number;
  sql: string;
  params: unknown[];
  frames: string[];
  /** Bound further (not itself a statement anything sends). */
  parent: boolean;
  exec: Array<'run' | 'first' | 'all' | 'raw' | 'batch'>;
  /** The batch it was sent in, when it was. */
  batchNo: number | null;
}

export class Census {
  recs: Rec[] = [];
  /** Every query D1 would count, in order: a standalone execution, or one statement of a batch. */
  queries: Array<{ rec: Rec; how: 'run' | 'first' | 'all' | 'raw' | 'batch'; batch: number | null }> = [];
  batches: Rec[][] = [];
  add(sql: string, params: unknown[]): Rec {
    const stack = new Error().stack ?? '';
    const frames: string[] = [];
    for (const m of stack.matchAll(/at (?:async )?(?:Object\.|exports\.)?([A-Za-z0-9_$]+)[ (]/g)) {
      if ((KNOWN_FRAMES as readonly string[]).includes(m[1]) && frames[frames.length - 1] !== m[1]) frames.push(m[1]);
    }
    const rec: Rec = { id: this.recs.length, sql, params, frames, parent: false, exec: [], batchNo: null };
    this.recs.push(rec);
    return rec;
  }
}

export class CStmt {
  constructor(private readonly census: Census, readonly inner: SqliteStatement, readonly rec: Rec) {}
  bind(...values: unknown[]) {
    this.rec.parent = true;
    return new CStmt(this.census, this.inner.bind(...values), this.census.add(this.rec.sql, values));
  }
  private hit(how: 'run' | 'first' | 'all' | 'raw') {
    this.rec.exec.push(how);
    this.census.queries.push({ rec: this.rec, how, batch: null });
  }
  run() { this.hit('run'); return this.inner.run(); }
  first<T = Record<string, unknown>>() { this.hit('first'); return this.inner.first<T>(); }
  all<T = Record<string, unknown>>() { this.hit('all'); return this.inner.all<T>(); }
  raw() { this.hit('raw'); return (this.inner as unknown as { raw(): unknown }).raw(); }
}

export class CensusD1 {
  readonly census = new Census();
  private readonly inner: SqliteD1;
  constructor(raw: DatabaseSync) { this.inner = new SqliteD1(raw); }
  prepare(sql: string) { return new CStmt(this.census, this.inner.prepare(sql), this.census.add(sql, [])); }
  async batch(statements: CStmt[]) {
    const n = this.census.batches.length;
    this.census.batches.push(statements.map((s) => s.rec));
    for (const s of statements) {
      s.rec.exec.push('batch');
      s.rec.batchNo = n;
      this.census.queries.push({ rec: s.rec, how: 'batch', batch: n });
    }
    return this.inner.batch(statements.map((s) => s.inner));
  }
}

/** A fresh binding and app per request: cold per-binding memos (a new isolate). */
export function coldApp(raw: DatabaseSync, user: StubUser & { admin_scope?: string | null } = OWNER) {
  const d1 = new CensusD1(raw);
  const app = stubApp(d1, user, (a) => a.route('/api/admin/template', templateRoutes));
  return { d1, app };
}

/** The refusals that still build the whole write (so the census reconstructs it). */
export const TOO_LARGE_CODES = new Set(['DATA_FILE_TOO_LARGE', 'DATA_FILE_PRODUCT_TOO_LARGE', 'DATA_FILE_PRICING_TOO_LARGE']);

// ------------------------------------------------------------------ reading a census

export const ROUTE_FENCE = 'INSERT INTO ops_guards(id,ok) SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM products WHERE id = ? AND updated_at IS ?) THEN 1 ELSE 0 END';

export function paramCount(r: Rec): number {
  let maxIdx = 0;
  for (const m of r.sql.matchAll(/\?(\d+)/g)) maxIdx = Math.max(maxIdx, Number(m[1]));
  return Math.max(maxIdx, r.params.length);
}
export const tableOf = (sql: string): string => {
  const s = sql.replace(/\s+/g, ' ').trim();
  const m = /^(INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+([A-Za-z0-9_]+)/i.exec(s);
  if (m) return `${m[1].split(' ')[0].toUpperCase()} ${m[2]}`;
  const sel = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(s);
  return `SELECT ${sel?.[1] ?? '?'}`;
};

/** Who built a batch statement (the stack frames it was prepared under). */
export function categoryOf(r: Rec): string {
  const f = new Set(r.frames);
  const inEngine = f.has('engineWriteStatements') ? ' (engine)' : '';
  if (f.has('planProductSave')) return 'planSave doc+relations';
  if (f.has('planTemplateMembership')) return 'membership';
  if (f.has('pricingAuditStatement')) return `pricing_audit${inEngine}`;
  if (f.has('inputStatements')) return `pricing input writes${inEngine}`;
  if (f.has('ruleStatements')) return `pricing rule writes${inEngine}`;
  if (f.has('batchHead')) return `pricing head: fences+owner token+state${inEngine}`;
  if (f.has('batchTail')) return `pricing tail: owner token${inEngine}`;
  if (f.has('auditStatements')) return `audit_log${inEngine}`;
  if (f.has('engineWriteStatements')) return 'engine: fences/guards/prices/costs/state';
  if (f.has('serialAnswerFence')) return 'serial fence';
  if (r.sql.startsWith(ROUTE_FENCE) || /^DELETE FROM ops_guards WHERE id=\?$/.test(r.sql)) return 'fence (products.updated_at)';
  return `other: ${tableOf(r.sql)}`;
}

/** The phase a standalone read belongs to (its most specific known frame; the middleware that wraps every handler is skipped). */
export function phaseOf(r: Rec): string {
  const order = [
    'afterProductsChanged', 'saveProductAtomic', 'rateLimit', 'previousApply', 'completenessPreview', 'judgePricing', 'loadPricingLive',
    'analyzeTemplate', 'planSave', 'planTemplateMembership', 'engineWriteStatements', 'auditStatements', 'liveState', 'evaluateBlock',
  ];
  for (const o of order) if (r.frames.includes(o)) return o;
  return `other: ${tableOf(r.sql)}`;
}

export const tally = (xs: string[]) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};

export interface WriteBatch {
  size: number;
  reconstructed: boolean;
  byCategory: Record<string, number>;
  planSaveByTable: Record<string, number>;
  /** Per category, then table: statements and the most bound parameters one of them carries. */
  shape: Record<string, { n: number; maxParams: number }>;
  maxParams: number;
  maxParamsSql: string;
  maxSqlBytes: number;
  maxValueBytes: number;
}

export function describeBatch(recs: Rec[], reconstructed: boolean): WriteBatch {
  let maxParams = 0;
  let maxParamsSql = '';
  let maxSqlBytes = 0;
  let maxValueBytes = 0;
  for (const r of recs) {
    const p = paramCount(r);
    if (p > maxParams) { maxParams = p; maxParamsSql = r.sql.replace(/\s+/g, ' ').slice(0, 90); }
    maxSqlBytes = Math.max(maxSqlBytes, Buffer.byteLength(r.sql));
    for (const v of r.params) if (typeof v === 'string') maxValueBytes = Math.max(maxValueBytes, Buffer.byteLength(v));
  }
  return {
    size: recs.length,
    reconstructed,
    byCategory: tally(recs.map(categoryOf)),
    planSaveByTable: tally(recs.filter((r) => categoryOf(r) === 'planSave doc+relations').map((r) => tableOf(r.sql))),
    shape: recs.reduce<Record<string, { n: number; maxParams: number }>>((acc, r) => {
      const k = `${categoryOf(r)} | ${tableOf(r.sql)}`;
      const at = (acc[k] ??= { n: 0, maxParams: 0 });
      at.n += 1;
      at.maxParams = Math.max(at.maxParams, paramCount(r));
      return acc;
    }, {}),
    maxParams,
    maxParamsSql,
    maxSqlBytes,
    maxValueBytes,
  };
}

/** The statements the route had built for its write when it answered (its batch, sent or refused). */
export function writeBatchOf(c: Census): { recs: Rec[]; sent: boolean } {
  // The route's own product fence: the first one prepared outside the evaluation's discarded plan.
  const marker = c.recs.find((r) => r.sql === ROUTE_FENCE && !r.frames.includes('evaluateBlock') && !r.frames.includes('planProductSave'));
  assert.ok(marker, 'the route built its fence');
  const sentNo = c.batches.findIndex((b) => b.length && b.some((r) => r.sql === ROUTE_FENCE && r.id >= marker.id));
  // Leaves built from the fence on that nothing ran: what a refused write had built.
  const built = c.recs.filter((r) => r.id >= marker.id && !r.parent && r.exec.length === 0);
  if (sentNo >= 0) {
    // THE METHOD, CHECKED on every apply that passes: the leaves built from the fence on, that ran
    // nowhere but in the write, are exactly the sent batch — so a refused write's leaves are its batch.
    const sent = c.batches[sentNo];
    const rule = c.recs.filter((r) => r.id >= marker.id && !r.parent && (r.exec.length === 0 || (r.exec.every((e) => e === 'batch') && r.batchNo === sentNo)));
    assert.deepEqual(rule.filter((r) => r.batchNo !== sentNo).map((r) => r.sql.slice(0, 80)), [], 'nothing built for the write is left unsent');
    assert.equal(rule.length, sent.length, 'every statement of the sent batch was built from the fence on');
    return { recs: sent, sent: true };
  }
  return { recs: built, sent: false };
}

export interface InvocationCensus {
  status: number;
  code: string | null;
  totalQueries: number;
  readsBeforeWrite: number;
  /** Of those: the comparison recomputed (before the route's fence was built) … */
  readsEvaluate: number;
  /** … and the reads made while building the write (the real plan, the engine write, the audit). */
  readsBuildingWrite: number;
  readsBeforeByPhase: Record<string, number>;
  write: WriteBatch | null;
  /** Queries after the write batch (read-back, post-commit audits, completeness hook). */
  after: number;
  afterByPhase: Record<string, number>;
  otherBatches: number[];
}

export function readInvocation(c: Census, status: number, code: string | null, withWrite: boolean): InvocationCensus {
  let write: WriteBatch | null = null;
  let writeBatchNo: number | null = null;
  let builtSize = 0;
  if (withWrite) {
    const wb = writeBatchOf(c);
    write = describeBatch(wb.recs, !wb.sent);
    if (wb.sent) writeBatchNo = c.batches.findIndex((b) => b === wb.recs);
    else builtSize = wb.recs.length;
  }
  const firstWriteQuery = writeBatchNo === null ? c.queries.length : c.queries.findIndex((q) => q.batch === writeBatchNo);
  const before = c.queries.slice(0, firstWriteQuery).filter((q) => q.batch === null || q.batch !== writeBatchNo);
  const afterQ = writeBatchNo === null ? [] : c.queries.slice(firstWriteQuery).filter((q) => q.batch !== writeBatchNo);
  const marker = c.recs.find((r) => r.sql === ROUTE_FENCE && !r.frames.includes('evaluateBlock') && !r.frames.includes('planProductSave'));
  const building = marker ? before.filter((q) => q.rec.id > marker.id).length : 0;
  return {
    status,
    code,
    // A refused write is counted as if it had been sent: what the invocation would need.
    totalQueries: c.queries.length + builtSize,
    readsBeforeWrite: before.length,
    readsEvaluate: before.length - building,
    readsBuildingWrite: building,
    readsBeforeByPhase: tally(before.map((q) => (q.batch === null ? phaseOf(q.rec) : `batch#${q.batch}: ${phaseOf(q.rec)}`))),
    write,
    after: afterQ.length,
    afterByPhase: tally(afterQ.map((q) => (q.batch === null ? phaseOf(q.rec) : `batch#${q.batch}: ${phaseOf(q.rec)}`))),
    otherBatches: c.batches.filter((b) => b.length && !(writeBatchNo !== null && b === c.batches[writeBatchNo])).map((b) => b.length),
  };
}

// ------------------------------------------------------------------ the product and its files

/**
 * A product of `opts` models (one group) × `cols` colours, every exact
 * combination its own stock (VARIANT_COMBINATION), and a six-row spec group.
 * The default (24 × 1) is the census product: 50 pricing scopes.
 */
export function bigProductText(shape: { opts?: number; cols?: readonly string[]; slug?: string } = {}): string {
  const OPTS = shape.opts ?? 24;
  const COLS = shape.cols ?? ['black'];
  const L = [
    'template_version=2',
    `slug=${shape.slug ?? 'big-kit'}`,
    'name_ar=طقم كبير',
    'name_en=Big Kit',
    'name_ckb=کیتی گەورە',
    'price_iqd=250000',
    'selling_type=direct_sale',
    'inventory_mode=VARIANT_COMBINATION',
    'sku=BIG-KIT',
  ];
  for (let i = 1; i <= OPTS; i++) {
    L.push(`options.${i}.id=opt_m${i}`, `options.${i}.group=Model`, `options.${i}.name_ar=طراز ${i}`, `options.${i}.name_en=Model ${i}`, `options.${i}.active=true`, `options.${i}.direct.enabled=true`, `options.${i}.stock=__NULL__`);
  }
  COLS.forEach((c, j) => L.push(`colors.${j + 1}.id=col_${c}`, `colors.${j + 1}.name_en=${c}`, `colors.${j + 1}.hex=#${(j * 0x10101).toString(16).padStart(6, '0').slice(-6)}`, `colors.${j + 1}.option_id=__NULL__`, `colors.${j + 1}.active=true`));
  let k = 0;
  for (let i = 1; i <= OPTS; i++) for (const c of COLS) {
    k++;
    L.push(`variants.${k}.id=pv_m${i}_${c}`, `variants.${k}.option_value_ids=opt_m${i}`, `variants.${k}.color_id=col_${c}`, `variants.${k}.active=true`, `variants.${k}.stock=${k}`);
  }
  L.push('spec_groups.1.id=sg_main', 'spec_groups.1.title_ar=أساسي', 'spec_groups.1.title_en=Main');
  for (let r = 1; r <= 6; r++) L.push(`spec_groups.1.rows.${r}.id=sr_${r}`, `spec_groups.1.rows.${r}.label_ar=بند ${r}`, `spec_groups.1.rows.${r}.label_en=Row ${r}`, `spec_groups.1.rows.${r}.value_en=${r} mm`);
  return L.join('\n') + '\n';
}

/** Set many `key=value` lines of a file at once (every key must be in the file). */
export function setLines(text: string, values: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  const out = text.split('\n').map((line) => {
    const eq = line.indexOf('=');
    if (eq < 0) return line;
    const key = line.slice(0, eq);
    if (!values.has(key)) return line;
    seen.add(key);
    return `${key}=${values.get(key)}`;
  });
  for (const k of values.keys()) assert.ok(seen.has(k), `the file has ${k}`);
  return out.join('\n');
}

/** Every pricing scope prefix of the file (`pricing.base`, `pricing.options.N`, …). */
export const scopePrefixes = (text: string): string[] => [
  'pricing.base',
  ...[...text.matchAll(/^(pricing\.(?:options|colors)\.\d+)\.id=/gm)].map((m) => m[1]),
  ...[...text.matchAll(/^(pricing\.skus\.\d+)\.combo_key=/gm)].map((m) => m[1]),
];

export const SHIPPING5 = (i: number): Array<[string, string]> => [
  ['shipping_weight_g', String(1000 + 10 * i)],
  ['shipping_length_mm', '300'],
  ['shipping_width_mm', '200'],
  ['shipping_height_mm', String(100 + i)],
  ['manual_cbm', '0.006'],
];
/** The seven input fields: the five shipping measures, the extra cost, the route. */
export const INPUTS7 = (i: number): Array<[string, string]> => [
  ...SHIPPING5(i),
  ['additional_cost_iqd', String(1000 * ((i % 5) + 1))],
  ['shipping_profile', 'CHINA_SEA'],
];
/** The owner's two rules. */
export const RULES2 = (): Array<[string, string]> => [
  ['minimum_target_profit_usd', '10'],
  ['direct_sale_extra_iqd', '5000'],
];

export function fillPricing(text: string, fields: (i: number) => Array<[string, string]>, only?: (prefix: string) => boolean): Map<string, string> {
  const m = new Map<string, string>();
  scopePrefixes(text).forEach((prefix, i) => {
    if (only && !only(prefix)) return;
    for (const [f, v] of fields(i)) m.set(`${prefix}.${f}`, v);
  });
  return m;
}

/**
 * The owner-sized pricing file: the seven input fields on all 50 scopes (350
 * lines) and the two rules on the product and its 24 models (50 lines) —
 * 400 lines, as many rules as one pricing save takes today (60).
 */
export const ownerPricing = (text: string) =>
  new Map([...fillPricing(text, INPUTS7), ...fillPricing(text, RULES2, (p) => p === 'pricing.base' || p.startsWith('pricing.options.'))]);

export function docChanges(text: string): Map<string, string> {
  const m = new Map<string, string>([['name_en', 'Big Kit 2026'], ['name_ckb', 'کیتی گەورەی ٢٠٢٦']]);
  for (const x of text.matchAll(/^variants\.(\d+)\.id=/gm)) m.set(`variants.${x[1]}.stock`, String(100 + Number(x[1])));
  for (const x of text.matchAll(/^options\.(\d+)\.id=opt_/gm)) m.set(`options.${x[1]}.name_en`, `Model ${x[1]} (2026)`);
  for (const x of text.matchAll(/^spec_groups\.1\.rows\.(\d+)\.id=/gm)) m.set(`spec_groups.1.rows.${x[1]}.value_en`, `${x[1]}0 mm`);
  return m;
}

// ------------------------------------------------------------------ one measured apply

export interface World { raw: DatabaseSync; id: string; text: string }

export async function bigWorld(shape: Parameters<typeof bigProductText>[0] = {}): Promise<World> {
  const w = pricingWorld();
  const { app } = coldApp(w.raw);
  const res = await post(app, '/api/admin/template/apply', { text: bigProductText(shape), mode: 'draft', confirm: true });
  const body = (await res.json()) as { product_id?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  const id = body.product_id!;
  const dl = await get(coldApp(w.raw).app, `/api/admin/template/data-export/${id}`);
  assert.equal(dl.status, 200);
  return { raw: w.raw, id, text: await dl.text() };
}

export interface Measured {
  name: string;
  lines: { changes: number; refused: number; stale: number; derived: number; pricingKind: string | null; docLines: number; pricingLines: number };
  preview: { totalQueries: number; byPhase: Record<string, number>; batches: number[] };
  apply: InvocationCensus;
}

export const RESULTS: Measured[] = [];

export async function measure(
  name: string,
  w: World,
  edits: Map<string, string>,
  opts: { warm?: boolean } = {}
): Promise<{ m: Measured; body: Record<string, unknown>; p: PreviewProduct }> {
  const text = setLines(w.text, edits);
  // The preview, cold.
  const pv = coldApp(w.raw);
  const pres = await post(pv.app, '/api/admin/template/data-preview', { text, product_id: w.id });
  const pbody = (await pres.json()) as { products: PreviewProduct[] };
  assert.equal(pres.status, 200, JSON.stringify(pbody).slice(0, 400));
  const p = pbody.products[0];
  const previewCensus = {
    totalQueries: pv.d1.census.queries.length,
    byPhase: tally(pv.d1.census.queries.map((q) => (q.batch === null ? phaseOf(q.rec) : `batch: ${phaseOf(q.rec)}`))),
    batches: pv.d1.census.batches.map((b) => b.length),
  };
  // The apply: cold (a fresh binding), or warm (the preview's binding, its memos filled).
  const ap = opts.warm ? pv : coldApp(w.raw);
  if (opts.warm) {
    // Count the apply alone: forget what the preview did on this binding (its memos stay).
    ap.d1.census.queries.length = 0;
    ap.d1.census.batches.length = 0;
  }
  const res = await post(ap.app, '/api/admin/template/data-apply', {
    text,
    product_id: w.id,
    token: p.token,
    ...(p.pricing?.preview_hash ? { pricing_hash: p.pricing.preview_hash } : {}),
    ...(p.pricing?.large_change ? { confirm_large_change: true } : {}),
  });
  const body = (await res.json()) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code : null;
  const wrote = res.status === 200 || (code !== null && TOO_LARGE_CODES.has(code));
  const accepted = p.fields.filter((f) => f.status === 'change');
  const m: Measured = {
    name,
    lines: {
      changes: p.counts.changes,
      refused: p.counts.refused,
      stale: p.counts.stale,
      derived: p.counts.derived,
      pricingKind: p.pricing?.kind ?? null,
      docLines: accepted.filter((f) => !f.key.startsWith('pricing.')).length,
      pricingLines: accepted.filter((f) => f.key.startsWith('pricing.')).length,
    },
    preview: previewCensus,
    apply: readInvocation(ap.d1.census, res.status, code, wrote),
  };
  RESULTS.push(m);
  return { m, body, p };
}

