/**
 * «استيراد فاتورة الشراء من الصور» — mounted beside the procurement router at
 * `/api/admin/procurement` (worker/index.ts). Owner only: cost class
 * (tests/routeClass/procurementImport.ts), and every call spends the owner's
 * AI budget.
 *
 *   POST /import/extract   { idempotency_key, files: [{ label, media_type, data }] }
 *                          → { job_id, document, orders, groups, lines, notes, rejected, usage }
 *                          The pictures / PDFs are read by the owner's chosen model through the Creative
 *                          Studio's provider door (worker/lib/creative/ai.ts: key, model, budget, job ledger).
 *   POST /import/match     { job_id, idempotency_key }
 *                          → { lines: [{ ref, key, confidence, via }], groups: [{ index, keys }], selections, usage }
 *                          Catalogue candidates are found here by text (worker/lib/procurementInvoiceImport.ts);
 *                          the model only chooses among them. `key` = `${product_id}|${scope}|${scope_id}`.
 *
 * Nothing is written to the catalogue or a purchase: the client shows the
 * proposal, the owner corrects it, and the lines join the purchase draft.
 * Creating products from an invoice is deliberately NOT offered here: the
 * product save contract (POST /api/admin/products-v2 + relations) is the
 * product form's, and an unmatched line is picked by hand (StockSelection).
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, HttpError, notFound, requireAdmin } from '../lib/http';
import { isOwner } from '../lib/adminScope';
import { costRefusal } from '../lib/costAccess';
import { requireCapability } from '../lib/operations';
import { ensureReady, runAi, type KeepAlive } from '../lib/creative/ai';
import type { Transport } from '../lib/creative/anthropic';
import { sha256OfBytes } from '../lib/creative/files';
import { imageTokenAllowance } from '../lib/creative/budget';
import { jobById } from '../lib/creative/jobs';
import { sniffImageBytes } from '../lib/imageConvert';
import { productSelections, type Selection } from '../lib/inventorySelection';
import { rasterDimensions } from '../lib/imageMetadata';
import {
  INVOICE_SCHEMA,
  INVOICE_SYSTEM,
  MATCH_SCHEMA,
  MATCH_SYSTEM,
  MAX_CANDIDATE_PRODUCTS,
  MAX_IMPORT_IMAGE_BYTES,
  MAX_IMPORT_PARTS,
  MAX_IMPORT_PDF_BYTES,
  MAX_IMPORT_TOTAL_BYTES,
  MAX_SELECTIONS_PER_PRODUCT,
  catalogueDf,
  extractContent,
  matchContent,
  pdfTokenAllowance,
  rankProducts,
  skuMatch,
  validateInvoice,
  validateMatch,
  withoutControls,
  type Candidate,
  type CatalogueProduct,
  type Confidence,
  type ImportFile,
  type InvoiceExtract,
} from '../lib/procurementInvoiceImport';

export const adminProcurementImportRoutes = new Hono<AppContext>();
adminProcurementImportRoutes.use('*', requireAdmin);

/** Tests replace the provider transport; production sends for real. */
export const procurementImportTransport: Transport = {};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,80}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The owner alone: the purchase capability (cost write) and then the owner check (no delegated grantee spends the AI budget). */
async function ownerPurchase(c: Context<AppContext>): Promise<string> {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'purchase');
  if (!isOwner(c.env, user)) throw costRefusal(c.env, user);
  return String(user.id);
}

function keepAliveOf(c: Context<AppContext>): KeepAlive | undefined {
  try {
    const ctx = c.executionCtx;
    return (work) => ctx.waitUntil(work);
  } catch {
    return undefined;
  }
}

async function jsonBody(c: Context<AppContext>, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'The files are too large for one reading; send fewer pages.', 'IMPORT_TOO_LARGE');
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON body required', 'INVALID_INPUT');
  return body as Record<string, unknown>;
}

function idemKey(v: unknown): string {
  if (typeof v !== 'string' || !IDEMPOTENCY_KEY.test(v)) throw badRequest('idempotency_key is required (8-80 letters, digits, _ or -)', 'INVALID_INPUT');
  return v;
}

/** The submitted files → checked parts (type sniffed from the bytes, sizes capped), their hashes and token allowance. */
async function readFiles(raw: unknown): Promise<{ files: ImportFile[]; hashes: string[]; tokens: number }> {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('files: at least one picture or PDF is required', 'INVALID_INPUT');
  if (raw.length > MAX_IMPORT_PARTS) throw badRequest(`files: at most ${MAX_IMPORT_PARTS} pictures or PDFs in one reading`, 'IMPORT_TOO_MANY_FILES');
  const files: ImportFile[] = [];
  const hashes: string[] = [];
  let tokens = 0;
  let total = 0;
  for (const [i, f] of raw.entries()) {
    const o = f && typeof f === 'object' ? (f as Record<string, unknown>) : {};
    const data = typeof o.data === 'string' ? o.data.replace(/^data:[a-z/+-]+;base64,/, '') : '';
    if (!data || !B64.test(data)) throw badRequest(`files[${i}]: base64 data required`, 'INVALID_INPUT');
    if (data.length > Math.ceil((MAX_IMPORT_PDF_BYTES * 4) / 3) + 8) throw new HttpError(413, `files[${i}] is too large`, 'IMPORT_TOO_LARGE');
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    } catch {
      throw badRequest(`files[${i}]: invalid base64`, 'INVALID_INPUT');
    }
    total += bytes.byteLength;
    if (total > MAX_IMPORT_TOTAL_BYTES) throw new HttpError(413, 'The files are too large for one reading; send fewer pages.', 'IMPORT_TOO_LARGE');
    const label = withoutControls(typeof o.label === 'string' ? o.label : `file ${i + 1}`).slice(0, 120);
    const isPdf = bytes.byteLength > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
    if (isPdf) {
      files.push({ label, media_type: 'application/pdf', data });
      tokens += pdfTokenAllowance(bytes);
    } else {
      const s = sniffImageBytes(bytes);
      if (!s || (s.mime !== 'image/png' && s.mime !== 'image/jpeg' && s.mime !== 'image/webp')) {
        throw new HttpError(415, `files[${i}]: a PNG, JPEG or WebP picture or a PDF is required`, 'IMPORT_UNSUPPORTED_FILE');
      }
      if (bytes.byteLength > MAX_IMPORT_IMAGE_BYTES) throw new HttpError(413, `files[${i}]: a picture must be under 3.75 MB`, 'IMPORT_TOO_LARGE');
      const dims = rasterDimensions(bytes, s.mime);
      if (dims && (dims.width > 8000 || dims.height > 8000)) throw badRequest(`files[${i}]: a picture side must be at most 8000 px`, 'IMPORT_IMAGE_TOO_TALL');
      files.push({ label, media_type: s.mime, data });
      tokens += dims ? imageTokenAllowance(dims.width, dims.height) : 5_000;
    }
    hashes.push(await sha256OfBytes(bytes));
  }
  return { files, hashes, tokens };
}

adminProcurementImportRoutes.post('/import/extract', async (c) => {
  const actor = await ownerPurchase(c);
  const body = await jsonBody(c, Math.ceil((MAX_IMPORT_TOTAL_BYTES * 4) / 3) + 256 * 1024);
  const key = idemKey(body.idempotency_key);
  const { files, hashes, tokens } = await readFiles(body.files);
  const ready = await ensureReady(c.env);
  if (ready.settings.capabilities.vision === false) {
    throw new HttpError(409, 'The chosen model cannot read pictures; choose another model in Creative Studio settings.', 'MODEL_NO_VISION');
  }
  const out = await runAi<InvoiceExtract>(
    c.env,
    ready,
    {
      task: 'invoice',
      actorId: actor,
      idempotencyKey: key,
      request: { kind: 'purchase_invoice_extract', files: hashes },
      documentId: null,
      baseVersion: null,
      targetIds: [],
      system: INVOICE_SYSTEM,
      // Transcription, not reasoning: low effort keeps a 60-row order inside the deadline.
      effort: 'low',
      content: extractContent(files),
      schema: INVOICE_SCHEMA,
      imageTokens: tokens,
      validate: (raw) => validateInvoice(raw),
    },
    procurementImportTransport,
    keepAliveOf(c)
  );
  return c.json({ success: true, job_id: out.job.id, ...out.result, usage: out.usage });
});

/** A stored extraction (written by the route above) → its shape again, or null. */
function storedExtract(json: string | null): InvoiceExtract | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as InvoiceExtract;
    return v && Array.isArray(v.lines) && Array.isArray(v.groups) && v.document && typeof v.document === 'object' ? v : null;
  } catch {
    return null;
  }
}

const selectionKey = (s: Pick<Selection, 'product_id' | 'scope' | 'scope_id'>) => `${s.product_id}|${s.scope}|${s.scope_id ?? ''}`;

async function catalogue(db: D1Database): Promise<CatalogueProduct[]> {
  const plain = `SELECT id, COALESCE(name,'') AS name, COALESCE(name_ar,'') AS name_ar, COALESCE(sku,'') AS sku, COALESCE(brand,'') AS brand FROM products WHERE COALESCE(composition,'') = '' LIMIT 20000`;
  try {
    // The brand's own name (brand_id → brands) where the product carries one.
    const { results } = await db
      .prepare(
        `SELECT p.id, COALESCE(p.name,'') AS name, COALESCE(p.name_ar,'') AS name_ar, COALESCE(p.sku,'') AS sku,
                TRIM(COALESCE(b.name_en,'') || ' ' || COALESCE(p.brand,'')) AS brand
           FROM products p LEFT JOIN brands b ON b.id = p.brand_id
          WHERE COALESCE(p.composition,'') = '' LIMIT 20000`
      )
      .all<CatalogueProduct>();
    return results ?? [];
  } catch (e) {
    if (!/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) throw e;
    return (await db.prepare(plain).all<CatalogueProduct>()).results ?? [];
  }
}

type MatchPicks = Record<string, { key: string; confidence: Confidence }>;

adminProcurementImportRoutes.post('/import/match', async (c) => {
  const actor = await ownerPurchase(c);
  const body = await jsonBody(c, 64 * 1024);
  const jobId = typeof body.job_id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(body.job_id) ? body.job_id : null;
  if (!jobId) throw badRequest('job_id is required', 'INVALID_INPUT');
  const key = idemKey(body.idempotency_key);
  const ready = await ensureReady(c.env);
  const job = await jobById(c.env.DB, jobId);
  const extract = job && job.actor_id === actor && job.status === 'succeeded' ? storedExtract(job.result_json) : null;
  if (!extract) throw notFound('Invoice reading not found');

  // 1. Candidates, by text.
  const products = await catalogue(c.env.DB);
  const df = catalogueDf(products);
  const ranked = new Map(extract.groups.map((g) => [g.index, rankProducts(g, products, 4, df)]));
  // Load selections for the best products first (rank 1 of every group, then rank 2…), bounded.
  const order: string[] = [];
  for (let r = 0; r < 4; r++) for (const list of ranked.values()) if (list[r] && !order.includes(list[r].product.id)) order.push(list[r].product.id);
  const selectionsOf = new Map<string, Selection[]>();
  for (const id of order.slice(0, MAX_CANDIDATE_PRODUCTS)) {
    try {
      selectionsOf.set(id, (await productSelections(c.env.DB, id)).slice(0, MAX_SELECTIONS_PER_PRODUCT));
    } catch {
      // A bundle or an invalid inventory mode is not a purchasable selection: skipped.
    }
  }
  const nameOf = new Map(products.map((p) => [p.id, [p.name, p.name_ar].filter(Boolean).join(' / ')]));
  const byGroup = new Map<number, Candidate[]>();
  const selections: Record<string, Selection> = {};
  let next = 1;
  for (const g of extract.groups) {
    const list: Candidate[] = [];
    for (const { product } of ranked.get(g.index) ?? []) {
      for (const s of selectionsOf.get(product.id) ?? []) {
        list.push({ id: `c${next++}`, selection: s, product_name: nameOf.get(product.id) ?? product.id });
        selections[selectionKey(s)] = s;
      }
    }
    byGroup.set(g.index, list);
  }

  // 2. A SKU that names exactly one selection decides without the model.
  const decided: MatchPicks = {};
  for (const l of extract.lines) {
    const hit = skuMatch(l, byGroup.get(l.group) ?? []);
    if (hit) decided[l.ref] = { key: selectionKey(hit.selection), confidence: 'high' };
  }
  const open = extract.lines.filter((l) => !decided[l.ref] && (byGroup.get(l.group) ?? []).length > 0);

  // 3. The model chooses among the candidates of the open lines.
  let ai: MatchPicks = {};
  let usage = null;
  if (open.length) {
    const out = await runAi<MatchPicks>(
      c.env,
      ready,
      {
        task: 'invoice',
        actorId: actor,
        idempotencyKey: key,
        request: { kind: 'purchase_invoice_match', job_id: jobId },
        documentId: null,
        baseVersion: null,
        targetIds: [],
        system: MATCH_SYSTEM,
        effort: 'low',
        content: matchContent(open, byGroup),
        schema: MATCH_SCHEMA,
        validate: (raw) => {
          const v = validateMatch(raw, open, byGroup);
          if (!v.ok) return v;
          const picks: MatchPicks = {};
          for (const [ref, p] of Object.entries(v.result)) {
            const cand = p.candidate ? (byGroup.get(open.find((l) => l.ref === ref)!.group) ?? []).find((x) => x.id === p.candidate) : undefined;
            if (cand) picks[ref] = { key: selectionKey(cand.selection), confidence: p.confidence };
          }
          return { ok: true, result: picks };
        },
      },
      procurementImportTransport,
      keepAliveOf(c)
    );
    ai = out.result;
    usage = out.usage;
  }

  const lines = extract.lines.map((l) => {
    const d = decided[l.ref];
    if (d) return { ref: l.ref, key: d.key, confidence: d.confidence, via: 'sku' as const };
    const p = ai[l.ref];
    // A replayed pick whose selection is no longer a candidate (the catalogue changed) is dropped, never guessed.
    if (p && selections[p.key]) return { ref: l.ref, key: p.key, confidence: p.confidence, via: 'ai' as const };
    return { ref: l.ref, key: null, confidence: null, via: null };
  });
  const groups = extract.groups.map((g) => ({ index: g.index, keys: [...new Set((byGroup.get(g.index) ?? []).map((x) => selectionKey(x.selection)))] }));
  return c.json({ success: true, lines, groups, selections, usage });
});

