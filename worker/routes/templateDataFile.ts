/**
 * «ملف بيانات المنتج» — THE ROUND TRIP'S THREE DOORS (owner brief 2026-10-10),
 * registered on the admin template router (`/api/admin/template`, behind
 * `requireAdmin`):
 *
 *   GET  /data-export/:productId[?format=csv]  one product's data file, as it is now
 *   GET  /data-export?ids=a,b,…                up to 25 products in one file
 *   POST /data-preview {text, format?, product_id?, product_ids?}
 *        the comparison, key by key and item by item, per product: what will be
 *        written, what is refused and why, what the save derives — WRITES NOTHING
 *        (`product_ids`: only those blocks of a bulk file). One call never runs
 *        more than D1's 1,000 queries less the reserve: the blocks it has no
 *        room for come back as `pending`, and the sheet asks for them next.
 *   POST /data-apply {text, format?, product_id, token, pricing_hash?, confirm_large_change?}
 *        ONE product: the preview recomputed from the text (never trusted from
 *        the client) and held to the token the owner read; then ONE fenced,
 *        idempotent, audited batch that writes the changed fields alone — all
 *        of them or none.
 *
 * THE BATCH'S SIZE (docs/DECISIONS.md row 212). D1 allows 1,000 queries per
 * Worker invocation, a batch counting each statement. The apply counts every
 * query IT runs before the batch (`scopedCountingD1`: this request's own, no
 * other request's) and sends the batch when it fits what is left:
 * `1000 − 50 (reserve) − (60 + the picture-detach queue) (after the batch) −
 * spent`. When it does not, nothing is written: the refusal says which lines
 * make it too large and how to apply the file in two goes — each its own
 * comparison and its own atomic apply, never two batches behind one press.
 *
 * The format and the comparison are worker/lib/productDataFile.ts; the owner's
 * pricing block is worker/lib/productDataFilePricing.ts. The writes go through
 * the same planner the form and the TXT import use (`planProductSave`), merged
 * in PATCH mode (worker/lib/template.ts `TemplatePatch`): no reorder, no
 * replace-all, no item removed unless the file says `remove=true`.
 *
 * Cost and private pricing are the verified owner's alone, decided by the
 * server: a non-owner's file has no private line, and every private line a
 * non-owner uploads is refused from the file itself (COST_OWNER_ONLY) — never
 * compared with the stored value, so the answer is the same for a right guess
 * and a wrong one.
 */
import type { Context, Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, HttpError, notFound, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { canViewCost, canWriteCost, isOwner, projectForAdmin } from '../lib/adminScope';
import { sha256Hex } from '../lib/crypto';
import { auditStatements } from '../lib/audit';
import { fence, isFenceMiss } from '../lib/operations';
import { afterCatalogueWrite } from '../lib/edgePolicy';
import { requireFreshSession } from '../lib/costAccess';
import { productEngineManaged } from '../lib/engineInstalled';
import { engineDbRefusal } from '../lib/pricingDbRefusals';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { dataFileMessage, type DataFileRefusalCode } from '../../packages/contracts/src/dataFileRefusals';
import { serialAnswerFence } from '../lib/serialPolicy';
import { EMPTY_RELATIONS, type ProductRelationsView } from '../lib/productOverlay';
import { relationsBodyFromDoc, templateVariantsFromView, deriveInventoryModeFromDoc } from '../lib/templateRelations';
import { planProductSave, saveProductAtomic, translationInputsOf, type ProductSavePlan } from '../lib/productPersistence';
import { docToEntries, effectiveNotes, type TemplatePatch } from '../lib/template';
import type { ProductDoc } from '../lib/productModel';
import type { MembershipRuleValues, ParsedMembershipRule } from '../lib/importCsv';
import type { TemplateField } from '../lib/templateFamilies';
import { csvToTemplateText, templateTextToCsv } from '../lib/sectionUpdate';
import {
  batchHead,
  batchTail,
  inputImage,
  inputStatements,
  nextInputRow,
  pricingAuditStatements,
  ruleImage,
  ruleStatements,
  storedIqdOf,
  type PricingAuditRow,
} from '../lib/pricingEngine/store';
import { unitNamesOf } from '../lib/pricingEngine/legacy';
import { D1_INVOCATION_STATEMENT_LIMIT } from '../lib/quarterHourBudget';
import { scopedCountingD1 } from '../lib/d1Count';
import { detachQueueQueries } from '../lib/mediaRefs';
import { SPEC_FIELD_LABEL_CKB } from '../lib/specFieldLabelsCkb';
import { engineWriteStatements } from '../lib/pricingEngine/engineWrite';
import {
  MAX_DATA_FILE_PRODUCTS,
  buildPatch,
  canonicalJson,
  canonicalValue,
  compareBlock,
  fingerprints,
  isPriceEntry,
  isPrivateEntry,
  normalizeEntries,
  renderBlock,
  renderDataFile,
  sectionOf,
  splitDataFile,
  type FieldResult,
  type FileError,
  type FlatEntry,
  type NEntry,
  type ParsedBlock,
  type PatchOutput,
} from '../lib/productDataFile';
import { evaluateDraft, projectItems } from '../lib/productCompleteness';
import { COMPLETENESS_ENTRIES, type CompletenessItem } from '@levonis/contracts/productCompleteness';
import { judgePricing, loadPricingLive, type PricingJudgement, type PricingLive } from '../lib/productDataFilePricing';

/** What the template router lends this module (its own internals, by reference). */
export interface DataFileDeps {
  loadProductDocWithView(db: D1Database, id: string): Promise<{ doc: ProductDoc; view: ProductRelationsView; row: Record<string, unknown> } | null>;
  exportOptsFor(db: D1Database, doc: ProductDoc): Promise<{
    brand: string | null;
    catalogs: string[];
    transportDefaults: Array<{ method: string; commission_iqd: number | null }>;
    category: string | null;
    subCategory: string | null;
    specFieldIds: string[];
    specFields: TemplateField[];
    fitsPrinters: string[];
  }>;
  analyzeTemplate(db: D1Database, text: string, target: string | null | undefined, opts: { money: boolean; owner?: boolean; patch?: TemplatePatch }): Promise<DataFileAnalysis>;
  loadMembershipRules(db: D1Database, productId: string): Promise<MembershipRuleValues[]>;
  planTemplateMembership(db: D1Database, actorId: string, productId: string, rules: readonly ParsedMembershipRule[]): Promise<{ statements: D1PreparedStatement[] } | null>;
  reattachTemplateMediaMetadata(doc: ProductDoc, body: Record<string, unknown>): void;
  attachment(text: string, filename: string): Response;
  contentDisposition(filename: string): string;
}

/** The fields of the router's `Analysis` this module reads. */
export interface DataFileAnalysis {
  parsed: { errors: Array<{ line: number; key: string; message: string }>; groups: Record<string, unknown[]>; groupClears: Record<string, unknown> };
  refs: { catalog_ids?: string[]; printer_fit_ids?: string[]; brands_to_create?: Array<{ name: string }>; needs_review?: Array<{ key: string; message: string }> };
  existing: ProductDoc | null;
  existingView: ProductRelationsView | null;
  merge: { body: Record<string, unknown>; inventory_mode?: string; needs_review: Array<{ key: string; message: string }>; warnings: string[] } | null;
  doc: ProductDoc | null;
  validation_error: { message: string; code?: string; field?: string | null; errors?: Array<{ key?: string; message?: string }> } | null;
  membership: ParsedMembershipRule[];
}

const MAX_TEXT = 1_500_000;
/**
 * Kept free under D1's 1,000 for the queries the handler's counter cannot see
 * (the session ≤ 1, private grants ≤ 1, the deception gate ≤ 2, the rate limit
 * ≤ 2) and any future middleware: the house reserve (quarterHourBudget.ts).
 */
export const DATA_APPLY_RESERVE = 50;
/**
 * After the batch, in the same invocation, whatever the batch holds: the
 * read-back `liveState` ≈ 29, the relations audit 1, `completenessAfterWrite`
 * ≈ 19 (inline after `next()`). Measured ≤ 52; tests/productDataFileBudget.test.ts
 * holds it at or below this. The picture-detach queue is NOT constant (one
 * statement per 18 pictures the save drops, and its audit row): the apply
 * sets it aside per batch (`detachQueueQueries`, worker/lib/mediaRefs.ts).
 */
export const DATA_APPLY_AFTER_BATCH = 60;
/**
 * The statements one apply's batch may hold once the handler has spent
 * `spent` queries and the batch will be followed by `afterExtra` more than
 * the constant after-phase (the pictures it detaches).
 */
export const dataApplyAllowance = (spent: number, afterExtra = 0): number =>
  D1_INVOCATION_STATEMENT_LIMIT - DATA_APPLY_RESERVE - DATA_APPLY_AFTER_BATCH - Math.max(0, afterExtra) - Math.max(0, spent);
/**
 * The queries one comparison call may run: D1's 1,000 less the reserve (the
 * middleware's few queries the handler cannot count). A block that would go
 * past it is not compared in this call — it comes back in `pending`.
 */
export const DATA_PREVIEW_BUDGET = D1_INVOCATION_STATEMENT_LIMIT - DATA_APPLY_RESERVE;
/** Blocks one preview call may name with `product_ids`. */
const PREVIEW_IDS_MAX = 25;
const STRUCTURE_GROUPS = new Set(['options', 'colors', 'variants', 'images']);
/** Keys the planner writes from what the patch says (the save's own derivation, never a side effect). */
const DERIVED_SCALARS = new Set(['selling_type', 'inventory_mode', 'serialized', 'warranty_base_months']);
/** References: written only when the file states them, resolved by the merge (not compared after it). */
const REF_KEYS = new Set(['brand', 'catalogs', 'fits_printers', 'category', 'sub_category']);
const IMAGE_STORE_KEYS = new Set(['url', 'key', 'width', 'height', 'content_type', 'bytes', 'source_url']);

interface Viewer {
  id: string;
  /** May see cost (renders private lines). */
  view: boolean;
  /** May write cost (private lines are judged, not refused). */
  write: boolean;
  owner: boolean;
}

function viewerOf(c: Context<AppContext>): Viewer {
  const user = c.get('user')!;
  const write = canWriteCost(c.env, user);
  return { id: user.id, view: canViewCost(c.env, user) && write, write: canViewCost(c.env, user) && write, owner: isOwner(c.env, user) };
}

// ----------------------------------------------------------------- the product as it is

interface LiveState {
  productId: string;
  slug: string;
  name: string;
  updatedAt: string | null;
  engine: boolean;
  doc: ProductDoc;
  view: ProductRelationsView;
  opts: Awaited<ReturnType<DataFileDeps['exportOptsFor']>>;
  entries: FlatEntry[];
  list: NEntry[];
  fps: Map<string, string>;
  notes: Map<string, string[]>;
  above: Map<string, string>;
  pricing: PricingLive | null;
  imageIds: Set<string>;
}

async function liveState(db: D1Database, deps: DataFileDeps, productId: string, viewer: Viewer): Promise<LiveState | 'missing' | 'composition'> {
  const loaded = await deps.loadProductDocWithView(db, productId);
  if (!loaded) return 'missing';
  const doc = loaded.doc;
  if ((doc.composition ?? '') !== '') return 'composition';
  deps.reattachTemplateMediaMetadata(doc, { media: loaded.view.images });
  const opts = await deps.exportOptsFor(db, doc);
  const exportOpts = {
    ...opts,
    variants: templateVariantsFromView(loaded.view),
    inventoryMode: loaded.view.inventory_mode,
    includeCost: viewer.view,
  };
  const entries: FlatEntry[] = docToEntries(doc, exportOpts).map((e) => ({ key: e.key, value: e.value }));
  const notes = new Map<string, string[]>();
  const docValues = new Map(entries.map((e) => [e.key, e.value]));
  for (const [key, note] of effectiveNotes(doc, exportOpts)) if (docValues.get(key) === null) notes.set(key, [note]);
  const above = new Map<string, string>();
  for (const f of opts.specFields) {
    above.set(`spec.${f.id}`, f.unit ? `${f.label_ar} — ${f.label_en} (${f.unit})` : `${f.label_ar} — ${f.label_en}`);
  }
  // §18 — the product's membership discount, the six keys per tier the old export carries.
  const rules = await deps.loadMembershipRules(db, productId);
  for (const tier of ['pro', 'prime'] as const) {
    const r = rules.find((x) => x.tier === tier);
    const v = (x: number | null | undefined) => (x === null || x === undefined ? '' : String(x));
    entries.push(
      { key: `membership.${tier}.discount_mode`, value: r?.discount_mode ?? '' },
      { key: `membership.${tier}.percent`, value: v(r?.percent) },
      { key: `membership.${tier}.fixed_iqd`, value: v(r?.fixed_iqd) },
      { key: `membership.${tier}.max_discount_iqd`, value: v(r?.max_discount_iqd) },
      { key: `membership.${tier}.cap_scope`, value: r?.cap_scope ?? '' },
      { key: `membership.${tier}.max_quantity`, value: v(r?.max_quantity) }
    );
  }
  // The owner's USD pricing block: never loaded for anyone else.
  const pricing = viewer.view ? await loadPricingLive(db, productId) : null;
  if (pricing) {
    entries.push(...pricing.entries);
    for (const [k, v] of pricing.notes) notes.set(k, v);
    for (const [k, v] of pricing.above) above.set(k, v);
  }
  const { list } = normalizeEntries(entries);
  return {
    productId,
    slug: doc.slug,
    name: doc.name_ar || doc.name_en || doc.slug,
    updatedAt: doc.updated_at ?? null,
    engine: await productEngineManaged(db, productId),
    doc,
    view: loaded.view,
    opts,
    entries,
    list,
    fps: await fingerprints(productId, list),
    notes,
    above,
    pricing,
    imageIds: new Set(loaded.view.images.map((i) => i.id)),
  };
}

async function renderLive(state: LiveState, viewer: Viewer): Promise<string> {
  return renderBlock({
    productId: state.productId,
    slug: state.slug,
    updatedAt: state.updatedAt,
    engine: state.engine,
    viewer: viewer.view ? 'owner' : 'staff',
    entries: state.entries,
    notes: state.notes,
    above: state.above,
  });
}

// ----------------------------------------------------------------- one product's comparison

interface DerivedChange {
  key: string;
  nkey: string;
  section: string;
  before: string | null;
  after: string | null;
}

interface BlockEval {
  productId: string;
  live: LiveState | null;
  error: { code: string; message: string } | null;
  fields: FieldResult[];
  /** The product part's accepted entries (document, relations, membership). */
  accepted: NEntry[];
  patch: PatchOutput | null;
  analysis: DataFileAnalysis | null;
  derived: DerivedChange[];
  pricing: PricingJudgement | null;
  pricingAccepted: NEntry[];
  goneItems: string[];
  token: string | null;
  /**
   * The central required-field list (worker/lib/productCompleteness.ts) on the
   * product as it is and as the accepted changes would leave it — codes only,
   * projected for the viewer (a non-owner reads one OWNER_DATA item for every
   * private field). Null on the apply path, which does not show it.
   */
  completeness: { before: CompletenessItem[]; after: CompletenessItem[] } | null;
}

/** The refusals of a planned patch, as file keys (null = a refusal no line of the file explains). */
function culpritsOf(a: DataFileAnalysis, patch: PatchOutput, accepted: readonly NEntry[]): Map<string, string> | null {
  const out = new Map<string, string>();
  const byKey = (key: string): string | null => {
    if (patch.keyMap.has(key)) return patch.keyMap.get(key)!;
    if (accepted.some((n) => n.key === key)) return key;
    return null;
  };
  let unexplained = false;
  for (const e of a.parsed.errors) {
    const k = byKey(e.key) ?? (e.key.startsWith('membership.') ? accepted.find((n) => n.head === 'membership' && e.key.startsWith(`membership.${n.path[0]}`))?.key ?? null : null);
    if (k) out.set(k, e.message);
    else unexplained = true;
  }
  for (const r of [...(a.merge?.needs_review ?? []), ...(a.refs.needs_review ?? [])]) {
    const k = byKey(r.key);
    if (k) out.set(k, r.message);
    else unexplained = true;
  }
  if ((a.refs.brands_to_create ?? []).length) {
    const k = byKey('brand');
    if (k) out.set(k, 'هذه العلامة التجارية غير موجودة — أضفها في التصنيفات أولاً / this brand does not exist — add it first / ئەم براندە بوونی نییە — سەرەتا زیادی بکە');
  }
  if (unexplained) return null;
  return out;
}

/** The field a validation or plan refusal names (`price_iqd: …`), as a file key; null when none. */
function refusalKey(message: string, field: string | null | undefined, patch: PatchOutput, accepted: readonly NEntry[]): string | null {
  const candidates = [field ?? '', /^([A-Za-z0-9_.[\]]+):/.exec(message)?.[1] ?? ''].filter(Boolean);
  for (const c of candidates) {
    if (patch.keyMap.has(c)) return patch.keyMap.get(c)!;
    const hit = accepted.find((n) => n.key === c || n.nkey === c);
    if (hit) return hit.key;
  }
  return accepted.length === 1 ? accepted[0].key : null;
}

/**
 * The save a patch makes, planned exactly as the apply plans it: the same
 * relations body (only when an option, colour, combination or picture
 * changes — or is removed — or the stock level is named), the same planner.
 * The preview plans on a copy and throws the plan away; the apply plans the
 * analysis itself. One function, so the preview cannot pass a save the apply
 * refuses.
 */
async function planSave(
  db: D1Database,
  a: DataFileAnalysis,
  accepted: readonly NEntry[],
  removals: Record<string, string[]>,
  productId: string,
  slug: string,
  viewer: Viewer,
  copy: boolean
): Promise<ProductSavePlan> {
  const doc = (copy ? JSON.parse(JSON.stringify(a.doc)) : a.doc) as ProductDoc;
  doc.id = productId;
  if (!doc.slug) doc.slug = slug;
  const structure =
    accepted.some((n) => n.item && STRUCTURE_GROUPS.has(n.item.group)) ||
    Object.keys(removals).some((g) => STRUCTURE_GROUPS.has(g)) ||
    a.merge?.inventory_mode !== undefined;
  const relations = structure
    ? relationsBodyFromDoc(doc, a.existingView ?? EMPTY_RELATIONS, { inventoryMode: a.merge?.inventory_mode, templateBody: a.merge?.body })
    : null;
  // Variants were attached for the bridge only; the document has no variant collection.
  delete (doc as unknown as Record<string, unknown>).variants;
  return planProductSave(db, {
    mode: 'update',
    doc,
    prev: a.existing,
    relations,
    catalogIds: a.refs.catalog_ids,
    printerFits: a.refs.printer_fit_ids,
    actor: { adminId: viewer.id, money: viewer.write },
    translations: translationInputsOf(doc),
  });
}

/** A line left over when the refusal rounds ran out: it is said, never silently dropped. */
const ROUNDS_EXHAUSTED =
  'رُفضت أسطر كثيرة من هذا المنتج في مقارنة واحدة — صحّح الأسطر المرفوضة ثم أرفق الملف مرة أخرى / too many of this product\'s lines were refused in one comparison — fix the refused lines, then attach the file again / هێڵی زۆری ئەم بەرهەمە لە یەک بەراوردکردندا ڕەتکرانەوە — هێڵە ڕەتکراوەکان چاک بکە، پاشان فایلەکە دووبارە هاوپێچ بکە';

/** A block with nothing compared yet (or nothing to compare: `error` says why). */
const blankEval = (productId: string, error: BlockEval['error'] = null): BlockEval => ({
  productId,
  live: null,
  error,
  fields: [],
  accepted: [],
  patch: null,
  analysis: null,
  derived: [],
  pricing: null,
  pricingAccepted: [],
  goneItems: [],
  token: null,
  completeness: null,
});

async function evaluateBlock(deps: DataFileDeps, block: ParsedBlock, viewer: Viewer, db: D1Database): Promise<BlockEval> {
  const out = blankEval(block.productId);
  const state = await liveState(db, deps, block.productId, viewer);
  if (state === 'missing') {
    out.error = { code: 'DATA_FILE_PRODUCT_MISSING', message: dataFileMessage('DATA_FILE_PRODUCT_MISSING') };
    return out;
  }
  if (state === 'composition') {
    out.error = { code: 'DATA_FILE_COMPOSITION', message: dataFileMessage('DATA_FILE_COMPOSITION') };
    return out;
  }
  out.live = state;
  const file = normalizeEntries(block.entries).list;
  const cmp = await compareBlock({
    productId: state.productId,
    file,
    live: state.list,
    liveFps: state.fps,
    owner: viewer.write,
    engine: state.engine,
    legacy: block.legacy,
    liveUpdatedAt: state.updatedAt,
    liveImageIds: state.imageIds,
    pricingScopes: viewer.write && state.pricing ? state.pricing.scopes : null,
  });
  out.fields = cmp.fields;
  out.goneItems = cmp.goneItems;
  const fileByNkey = new Map<string, NEntry>();
  for (const n of file) if (!fileByNkey.has(n.nkey)) fileByNkey.set(n.nkey, n);
  const setStatus = (key: string, status: FieldResult['status'], message: string) => {
    for (const f of out.fields) if (f.key === key && f.status === 'change') Object.assign(f, { status, message });
  };

  // ---- the product part: patch → the same merge/validation/plan the form's save runs
  let accepted = out.fields.filter((f) => f.status === 'change' && fileByNkey.get(f.nkey)?.head !== 'pricing').map((f) => fileByNkey.get(f.nkey)!);
  const removalsOf = (p: PatchOutput) => p.removals;
  for (let round = 0; round < 8 && accepted.length; round++) {
    const patch = await buildPatch(state.productId, accepted, file, state.list);
    const a = await deps.analyzeTemplate(db, patch.text, state.productId, { money: viewer.write, owner: viewer.owner, patch: { removals: removalsOf(patch) } });
    const culprits = culpritsOf(a, patch, accepted);
    if (culprits === null) {
      const why = a.parsed.errors[0]?.message ?? a.merge?.needs_review[0]?.message ?? 'refused';
      for (const n of accepted) setStatus(n.key, 'INVALID_VALUE', why);
      accepted = [];
      break;
    }
    if (culprits.size) {
      for (const [k, why] of culprits) setStatus(k, 'INVALID_VALUE', why);
      accepted = accepted.filter((n) => !culprits.has(n.key));
      continue;
    }
    if (a.validation_error || !a.doc) {
      const ve = a.validation_error ?? { message: 'refused' };
      const k = refusalKey(ve.message, ve.field, patch, accepted);
      if (k) {
        setStatus(k, 'INVALID_VALUE', ve.message);
        accepted = accepted.filter((n) => n.key !== k);
        continue;
      }
      for (const n of accepted) setStatus(n.key, 'INVALID_VALUE', ve.message);
      accepted = [];
      break;
    }
    let planned: { message: string; field: string | null } | null = null;
    if (accepted.some((n) => n.head !== 'membership')) {
      try {
        await planSave(db, a, accepted, patch.removals, state.productId, state.slug, viewer, true);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        planned = { message: e.message, field: typeof e.details?.field === 'string' ? (e.details.field as string) : null };
      }
    }
    if (planned) {
      const k = refusalKey(planned.message, planned.field, patch, accepted);
      if (k) {
        setStatus(k, 'INVALID_VALUE', planned.message);
        accepted = accepted.filter((n) => n.key !== k);
        continue;
      }
      for (const n of accepted) setStatus(n.key, 'INVALID_VALUE', planned.message);
      accepted = [];
      break;
    }
    out.patch = patch;
    out.analysis = a;
    break;
  }
  // The rounds ran out with lines still standing: each gets a verdict (the count of changes is what is shown).
  if (!out.analysis && accepted.length) for (const n of accepted) setStatus(n.key, 'INVALID_VALUE', ROUNDS_EXHAUSTED);
  if (!out.analysis) accepted = [];

  // ---- the safety net: the planned save changes the accepted fields and what they derive, nothing else
  // (a membership-only patch writes no document, so there is nothing to hold it to).
  if (out.analysis && out.patch && accepted.some((n) => n.head !== 'membership')) {
    const a = out.analysis;
    const doc = a.doc!;
    const structure =
      accepted.some((n) => n.item && STRUCTURE_GROUPS.has(n.item.group)) || accepted.some((n) => n.key === 'inventory_mode');
    const mode = structure ? deriveInventoryModeFromDoc(doc, state.view, a.merge?.inventory_mode, state.view.variants.length) : state.view.inventory_mode;
    const plannedEntries = docToEntries(doc, { ...state.opts, includeCost: viewer.view, inventoryMode: mode }).map((e) => ({ key: e.key, value: e.value }));
    const planned = normalizeEntries(plannedEntries).list;
    const ids = out.patch.newIds;
    const real = (n: NEntry) => {
      if (!n.item) return n.nkey;
      const id = ids[`${n.item.group}:${n.item.id}`];
      return id ? n.nkey.replace(`${n.item.group}[${n.item.id}]`, `${n.item.group}[${id}]`) : n.nkey;
    };
    const acceptedNkeys = new Set(accepted.map(real));
    const touchedItems = new Set(accepted.filter((n) => n.item).map((n) => `${n.item!.group}:${ids[`${n.item!.group}:${n.item!.id}`] ?? n.item!.id}`));
    const anyImages = accepted.some((n) => n.item?.group === 'images');
    const anyStructure = accepted.some((n) => n.item && (n.item.group === 'options' || n.item.group === 'colors'));
    const before = new Map(state.list.map((n) => [n.nkey, n]));
    const after = new Map(planned.map((n) => [n.nkey, n]));
    const sideEffects: string[] = [];
    for (const nkey of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(nkey);
      const p = after.get(nkey);
      const n = (p ?? b)!;
      if (n.meta || n.head === 'membership' || n.head === 'pricing' || n.head === 'header' || n.head === 'fp') continue;
      if (REF_KEYS.has(n.head)) continue;
      if (n.item?.group === 'images' && IMAGE_STORE_KEYS.has(n.path[0] ?? '')) continue;
      const bv = b ? canonicalValue(b, b.value) : undefined;
      const pv = p ? canonicalValue(p, p.value) : undefined;
      if (bv === pv) continue;
      // A key of a removed (or added) item that had no value either way says nothing.
      if ((bv ?? null) === null && (pv ?? null) === null) continue;
      if (acceptedNkeys.has(nkey)) continue;
      const itemKey = n.item ? `${n.item.group}:${n.item.id}` : null;
      const derived =
        (itemKey && (touchedItems.has(itemKey) || !b || !p)) ||
        DERIVED_SCALARS.has(n.head) ||
        (anyImages && n.item?.group === 'images' && n.path[0] === 'primary') ||
        (anyStructure && (n.item?.group === 'colors' || n.item?.group === 'variants' || n.item?.group === 'options') && /option_ids?$|option_value_ids$|color_id$|availability_type$/.test(n.path.join('.')));
      if (derived) out.derived.push({ key: (p ?? b)!.key, nkey, section: sectionOf(n), before: bv ?? null, after: pv ?? null });
      else sideEffects.push((b ?? p)!.key);
    }
    if (sideEffects.length) {
      const why = `${dataFileMessage('DATA_FILE_SIDE_EFFECT')} (${sideEffects.slice(0, 8).join(', ')})`;
      for (const n of accepted) setStatus(n.key, 'INVALID_VALUE', why);
      accepted = [];
      out.analysis = null;
      out.patch = null;
      out.derived = [];
    }
  }
  out.accepted = accepted;

  // ---- the owner's pricing block
  const pricingChanges = out.fields.filter((f) => f.status === 'change' && fileByNkey.get(f.nkey)?.head === 'pricing').map((f) => fileByNkey.get(f.nkey)!);
  if (pricingChanges.length && state.pricing && viewer.write) {
    const j = await judgePricing(db, state.pricing, pricingChanges, file, state.list, { otherChanges: accepted.length > 0, now: new Date().toISOString() });
    for (const [nkey, r] of j.refusals) {
      for (const f of out.fields) if (f.nkey === nkey && f.status === 'change') Object.assign(f, { status: r.status, message: r.message });
    }
    out.pricing = j;
    out.pricingAccepted = j.accepted;
  }

  // ---- the token: what the apply must find unchanged (everything it writes, in one batch)
  if (out.accepted.length || out.pricingAccepted.length) {
    out.token = (
      await sha256Hex(
        canonicalJson({
          v: 1,
          actor: viewer.id,
          product: state.productId,
          updated_at: state.updatedAt,
          fps: [...state.fps.entries()].sort(),
          accepted: out.accepted.map((n) => [n.nkey, canonicalValue(n, n.value)]).sort(),
          new_ids: out.patch?.newIds ?? {},
          derived: out.derived.map((d) => [d.nkey, d.after]).sort(),
          pricing: out.pricingAccepted.map((n) => [n.nkey, canonicalValue(n, n.value)]).sort(),
          pricing_kind: out.pricing?.kind ?? 'none',
          pricing_hash: out.pricing?.hash ?? null,
        })
      )
    ).slice(0, 32);
  }
  return out;
}

/** One required-field item as the sheet reads it: the code, the model, the form section. */
const completenessItemDto = (i: CompletenessItem) => ({
  code: i.code,
  option_id: i.option_id,
  section: COMPLETENESS_ENTRIES[i.code].section,
  private: COMPLETENESS_ENTRIES[i.code].private,
});

/**
 * WHAT WOULD STILL BE MISSING AFTER THE APPLY (owner brief 2026-10-10): the
 * list on the live product and on the product as the accepted lines leave it —
 * the merged document the save would write, the owner's pricing drafts laid
 * over the stored inputs and rules, and the engine's adoption when the save
 * adopts. Never fails the preview: an error reads as «no verdict».
 */
async function completenessPreview(db: D1Database, ev: BlockEval, seesPrivate: boolean): Promise<BlockEval['completeness']> {
  const state = ev.live;
  if (!state) return null;
  try {
    const mode: 'manual' | 'engine' = state.engine ? 'engine' : 'manual';
    const before = await evaluateDraft(db, { id: state.productId, doc: state.doc, view: state.view, mode });
    const j = ev.pricingAccepted.length ? ev.pricing : null;
    const afterMode: 'manual' | 'engine' = j?.kind === 'price' && j.ev?.kind === 'adopt' ? 'engine' : mode;
    const doc = ev.accepted.length && ev.analysis?.doc ? ev.analysis.doc : state.doc;
    const after = await evaluateDraft(db, {
      id: state.productId,
      doc,
      view: state.view,
      mode: afterMode,
      ...(j?.ev ? { inputs: j.ev.inputs, rules: j.ev.rules } : {}),
    });
    return { before: projectItems(before, seesPrivate), after: projectItems(after, seesPrivate) };
  } catch (error) {
    console.error('data file completeness preview failed:', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}

interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

/** `options[opt_x].name_en` / `pricing.skus[o:a|c:b].manual_cbm` → the item it names; null for a scalar. */
const itemOfNkey = (nkey: string): { group: string; id: string } | null => {
  const m = /^((?:pricing\.)?[a-z_]+)\[([^\]]+)\]/.exec(nkey);
  return m ? { group: m[1], id: m[2] } : null;
};

/**
 * The names the sheet titles its rows with (requirement 5 of the fix): each
 * item a row belongs to (the model, the colour, the combination, the pricing
 * scope, the spec group) and each spec field's label — built from what the
 * comparison already loaded (no query), for the rows shown only. Names are
 * the product's own data, never a value; a `pricing.*` item exists only in
 * the owner's comparison (no other viewer has a pricing row).
 */
function labelsOf(b: BlockEval, viewer: Viewer): { items: Record<string, Tri>; spec: Record<string, Tri>; inner: Record<string, Tri> } {
  const items: Record<string, Tri> = {};
  const spec: Record<string, Tri> = {};
  /** An item inside an item: a spec group's row (`spec_groups:<group>/rows:<row>`), by its label. */
  const inner: Record<string, Tri> = {};
  const s = b.live;
  if (!s) return { items, spec, inner };
  const doc = s.doc;
  const tri = (x: { name_ar?: string; name_en?: string; name_ckb?: string }): Tri => ({ ar: x.name_ar ?? '', en: x.name_en ?? '', ckb: x.name_ckb ?? '' });
  const nameIn = (x: { name_ar?: string | null; name_en?: string | null; name_ckb?: string | null } | undefined): Tri | null => {
    if (!x) return null;
    const ar = x.name_ar || x.name_en || '';
    const en = x.name_en || x.name_ar || '';
    const ckb = x.name_ckb || x.name_ar || x.name_en || '';
    return ar || en || ckb ? { ar, en, ckb } : null;
  };
  const comboNames = (combo: string): Tri | null => {
    const parts = combo.split('|');
    const optionIds = parts.filter((x) => x.startsWith('o:')).map((x) => x.slice(2));
    const colourId = parts.find((x) => x.startsWith('c:'))?.slice(2) ?? null;
    const names = tri(unitNamesOf(doc, optionIds, doc.colors.find((c) => c.id === colourId) ?? null));
    return names.ar || names.en || names.ckb ? names : null;
  };
  const named = (group: string, id: string): Tri | null => {
    switch (group) {
      case 'options':
      case 'pricing.options':
        return nameIn(doc.options.find((o) => o.id === id));
      case 'colors':
      case 'pricing.colors':
        return nameIn(doc.colors.find((c) => c.id === id));
      case 'variants': {
        const v = s.view.variants.find((x) => x.id === id);
        return v ? comboNames(v.combo_key) : null;
      }
      case 'pricing.skus':
        return comboNames(id);
      case 'spec_groups': {
        const g = doc.spec_groups.find((x) => x.id === id);
        return g ? nameIn({ name_ar: g.title_ar, name_en: g.title_en, name_ckb: g.title_ckb }) : null;
      }
      case 'labels': {
        const l = doc.labels.find((x) => x.id === id);
        return l ? nameIn({ name_ar: l.text_ar, name_en: l.text_en, name_ckb: l.text_ckb }) : null;
      }
      default:
        return null;
    }
  };
  const specFields = new Map(s.opts.specFields.map((f) => [f.id, f]));
  const seen = (key: string, nkey: string) => {
    if (key.startsWith('spec.')) {
      const id = key.slice(5);
      const f = specFields.get(id);
      if (f && !spec[id]) spec[id] = { ar: f.label_ar, en: f.label_en, ckb: SPEC_FIELD_LABEL_CKB[id] ?? f.label_en };
      return;
    }
    const it = itemOfNkey(nkey);
    if (!it) return;
    // A pricing scope is named to the owner alone (a non-owner's refused pricing line stays unnamed).
    if (it.group.startsWith('pricing.') && !viewer.view) return;
    // Two rows of one spec group are two lines: each is named by its own label (a pre-order
    // route by its method, which the sheet words itself — `transports[air]`).
    const row = /^spec_groups\[([^\]]+)\]\.rows\[([^\]]+)\]/.exec(nkey);
    if (row && !row[2].startsWith('#new')) {
      const rk = `spec_groups:${row[1]}/rows:${row[2]}`;
      if (!(rk in inner)) {
        const r = doc.spec_groups.find((g) => g.id === row[1])?.rows.find((x) => x.id === row[2]);
        const n = r ? nameIn({ name_ar: r.label_ar, name_en: r.label_en, name_ckb: r.label_ckb }) : null;
        if (n) inner[rk] = n;
      }
    }
    const k = `${it.group}:${it.id}`;
    if (k in items) return;
    const n = named(it.group, it.id);
    if (n) items[k] = n;
  };
  for (const f of b.fields) seen(f.key, f.nkey);
  for (const d of b.derived) seen(d.key, d.nkey);
  return { items, spec, inner };
}

/** The comparison as the sheet reads it (no internal state; private fields only for the owner). */
function blockDto(b: BlockEval, viewer: Viewer) {
  const s = b.live;
  const count = (st: FieldResult['status']) => b.fields.filter((f) => f.status === st).length;
  return {
    product_id: b.productId,
    name: s?.name ?? null,
    slug: s?.slug ?? null,
    updated_at: s?.updatedAt ?? null,
    pricing_mode: s ? (s.engine ? 'engine' : 'manual') : null,
    error: b.error,
    counts: {
      changes: b.accepted.length + b.pricingAccepted.length,
      refused: b.fields.filter((f) => f.status !== 'change' && f.status !== 'STALE_IN_FILE').length,
      stale: count('STALE_IN_FILE'),
      derived: b.derived.length,
    },
    fields: b.fields.map((f) => ({
      ...f,
      // A private line of a non-owner: neither the stored value nor the typed one travels back.
      ...(f.private && !viewer.view ? { before: null, after: null } : {}),
    })),
    derived: b.derived,
    gone_items: b.goneItems,
    completeness: b.completeness
      ? {
          before: b.completeness.before.map(completenessItemDto),
          after: b.completeness.after.map(completenessItemDto),
        }
      : null,
    pricing:
      viewer.view && b.pricing && b.pricingAccepted.length
        ? { kind: b.pricing.kind, preview_hash: b.pricing.hash, large_change: b.pricing.large_change, adoption: b.pricing.adoption }
        : null,
    labels: labelsOf(b, viewer),
    token: b.token,
  };
}

// ----------------------------------------------------------------- the routes

function sourceText(body: Record<string, unknown>): string {
  const raw = str(body.text, 'text', { min: 1, max: MAX_TEXT });
  if (body.format !== 'csv') return raw;
  const csv = csvToTemplateText(raw);
  if (csv.errors.length) throw new HttpError(400, csv.errors[0], 'DATA_FILE_MALFORMED', { errors: csv.errors });
  return csv.text;
}

const fileError = (status: 400 | 409, code: DataFileRefusalCode, errors: FileError[] = []) =>
  new HttpError(status, dataFileMessage(code), code, { errors });

/**
 * ONE COMPARISON CALL, WITHIN D1'S 1,000 (row 212). The blocks are compared
 * in the file's order on `counted` — a view of this request's own queries
 * with a hard limit (`scopedCountingD1`, DATA_PREVIEW_BUDGET): the query that
 * would cross it is refused before it is sent. The block it belonged to is
 * dropped whole (a comparison never shows half a product, even when the
 * refusal was swallowed somewhere below) and is `pending` with every block
 * after it — the sheet asks for those in its next call. The first block of a
 * call has the whole budget: if even that is not enough, it is answered with
 * `tooLarge`, so every call moves the file forward.
 */
export async function compareWithinBudget<B, T>(
  blocks: readonly B[],
  counted: { readonly db: D1Database; readonly refused: number },
  compare: (block: B, db: D1Database) => Promise<T>,
  tooLarge: (block: B) => T
): Promise<{ done: T[]; pending: B[] }> {
  const done: T[] = [];
  const pending: B[] = [];
  for (const block of blocks) {
    if (pending.length || counted.refused > 0) {
      if (done.length === 0) done.push(tooLarge(block));
      else pending.push(block);
      continue;
    }
    let out: { value: T } | null = null;
    try {
      const value = await compare(block, counted.db);
      if (counted.refused === 0) out = { value };
    } catch (error) {
      if (counted.refused === 0) throw error;
    }
    if (out) done.push(out.value);
    else if (done.length === 0) done.push(tooLarge(block));
    else pending.push(block);
  }
  return { done, pending };
}

async function previousApply(db: D1Database, productId: string, token: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(token)) return false;
  const row = await db
    .prepare("SELECT 1 AS hit FROM audit_log WHERE action = 'product.data_file.applied' AND target = ? AND detail LIKE ? LIMIT 1")
    .bind(productId, `%"token":"${token}"%`)
    .first<{ hit: number }>();
  return !!row;
}

export function registerDataFileRoutes(routes: Hono<AppContext>, deps: DataFileDeps): void {
  // ---- the file
  const exportFile = async (c: Context<AppContext>, ids: string[], csv: boolean) => {
    await rateLimit(c, 'tpl_data_export', 240, 3600);
    const viewer = viewerOf(c);
    const blocks: string[] = [];
    for (const id of ids) {
      const state = await liveState(c.env.DB, deps, id, viewer);
      if (typeof state === 'string') {
        if (ids.length === 1) throw state === 'missing' ? notFound('Product not found') : fileError(400, 'DATA_FILE_COMPOSITION');
        continue;
      }
      blocks.push(await renderLive(state, viewer));
    }
    const text = renderDataFile(blocks, viewer.view ? 'owner' : 'staff', new Date().toISOString());
    const name = ids.length === 1 ? `levonis-product-data-${ids[0]}` : `levonis-products-data-${ids.length}`;
    if (!csv) return deps.attachment(text, `${name}.txt`);
    const bytes = new TextEncoder().encode(templateTextToCsv(text));
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': deps.contentDisposition(`${name}.csv`),
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };

  routes.get('/data-export/:productId', (c) => exportFile(c, [c.req.param('productId')], c.req.query('format') === 'csv'));
  routes.get('/data-export', (c) => {
    const ids = [...new Set((c.req.query('ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
    if (ids.length === 0) throw fileError(400, 'DATA_FILE_NO_PRODUCT');
    if (ids.length > MAX_DATA_FILE_PRODUCTS) throw fileError(400, 'DATA_FILE_TOO_MANY');
    if (ids.some((id) => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) throw fileError(400, 'DATA_FILE_NO_PRODUCT');
    // A spreadsheet holds one product (key,value); a bulk file is TXT.
    return exportFile(c, ids, ids.length === 1 && c.req.query('format') === 'csv');
  });

  // ---- the comparison (writes nothing)
  routes.post('/data-preview', async (c) => {
    await rateLimit(c, 'tpl_parse', 240, 3600);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const text = sourceText(body);
    const parsed = splitDataFile(text);
    if (parsed.errors.some((e) => e.code === 'DATA_FILE_VERSION')) throw fileError(400, 'DATA_FILE_VERSION', parsed.errors);
    if (!parsed.blocks.length) throw fileError(400, 'DATA_FILE_NO_PRODUCT', parsed.errors);
    if (parsed.blocks.length > MAX_DATA_FILE_PRODUCTS) throw fileError(400, 'DATA_FILE_TOO_MANY');
    const only = typeof body.product_id === 'string' && body.product_id ? body.product_id : null;
    if (only && (parsed.blocks.length !== 1 || parsed.blocks[0].productId !== only)) throw fileError(400, 'DATA_FILE_WRONG_PRODUCT');
    // Some blocks of a bulk file (the ones a previous call left `pending`): each must be a block of this file.
    let blocks = parsed.blocks;
    if (body.product_ids !== undefined) {
      const ids = body.product_ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > PREVIEW_IDS_MAX || ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id))) {
        throw fileError(400, 'DATA_FILE_NO_PRODUCT');
      }
      const wanted = new Set(ids as string[]);
      if ([...wanted].some((id) => !parsed.blocks.some((b) => b.productId === id))) throw fileError(400, 'DATA_FILE_WRONG_PRODUCT');
      blocks = parsed.blocks.filter((b) => wanted.has(b.productId));
    }
    const viewer = viewerOf(c);
    const seesPrivate = canViewCost(c.env, c.get('user'));
    const counted = scopedCountingD1(c.env.DB, { limit: DATA_PREVIEW_BUDGET });
    const { done: products, pending } = await compareWithinBudget(
      blocks,
      counted,
      async (block, db) => {
        const ev = await evaluateBlock(deps, block, viewer, db);
        if (ev.live) ev.completeness = await completenessPreview(db, ev, seesPrivate);
        return blockDto(ev, viewer);
      },
      (block) => blockDto(blankEval(block.productId, { code: 'DATA_FILE_COMPARE_TOO_LARGE', message: dataFileMessage('DATA_FILE_COMPARE_TOO_LARGE') }), viewer)
    );
    const compared = new Set(products.map((p) => p.product_id));
    return c.json(
      projectForAdmin(c.env, c.get('user'), {
        success: true,
        viewer: viewer.view ? 'owner' : 'staff',
        file_viewer: parsed.viewer,
        errors: parsed.errors,
        malformed: blocks.filter((b) => compared.has(b.productId)).flatMap((b) => b.malformed),
        products,
        pending: pending.map((b) => b.productId),
      })
    );
  });

  // ---- the write: one product, ONE batch — all of its changes or none of them
  routes.post('/data-apply', async (c) => {
    await rateLimit(c, 'tpl_apply', 120, 3600);
    // From here on every query THIS request runs is counted, on its own view (no other request's
    // queries): the batch may hold what D1's 1,000 leave (row 212).
    const counted = scopedCountingD1(c.env.DB);
    const db = counted.db;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const productId = str(body.product_id, 'product_id', { min: 1, max: 80 });
    const token = str(body.token, 'token', { min: 32, max: 32 });
    if (body.confirm_large_change !== undefined && typeof body.confirm_large_change !== 'boolean') throw badRequest('confirm_large_change must be true or false');
    const parsed = splitDataFile(sourceText(body));
    if (parsed.errors.some((e) => e.code === 'DATA_FILE_VERSION')) throw fileError(400, 'DATA_FILE_VERSION', parsed.errors);
    const block = parsed.blocks.find((b) => b.productId === productId);
    if (!block) throw fileError(400, 'DATA_FILE_WRONG_PRODUCT');
    const viewer = viewerOf(c);

    // A replay of an apply that landed answers as it did — before anything is recomputed.
    if (await previousApply(db, productId, token)) return c.json({ success: true, already: true, product_id: productId });

    const ev = await evaluateBlock(deps, block, viewer, db);
    const fresh = () => projectForAdmin(c.env, c.get('user'), blockDto(ev, viewer));
    if (ev.error) throw new HttpError(400, ev.error.message, ev.error.code);
    if (!ev.token) throw new HttpError(400, dataFileMessage('DATA_FILE_NOTHING_TO_APPLY'), 'DATA_FILE_NOTHING_TO_APPLY', { preview: fresh() });
    if (ev.token !== token) throw new HttpError(409, dataFileMessage('DATA_FILE_CHANGED'), 'DATA_FILE_CHANGED', { preview: fresh() });
    const state = ev.live!;

    // ---- the pricing door's own gates
    const pricing = ev.pricingAccepted.length ? ev.pricing : null;
    if (pricing?.rates?.derived_stale) throw new HttpError(409, serverMessage('FX_DERIVED_STALE'), 'FX_DERIVED_STALE');
    if (pricing?.kind === 'price') {
      const sent = typeof body.pricing_hash === 'string' ? body.pricing_hash : '';
      if (sent !== pricing.hash) {
        const code = sent ? 'PRICING_PREVIEW_STALE' : 'PRICING_PREVIEW_REQUIRED';
        throw new HttpError(409, serverMessage(code), code, { preview: fresh() });
      }
      if (pricing.large_change) {
        if (body.confirm_large_change !== true) throw new HttpError(409, serverMessage('PRICING_LARGE_CHANGE_CONFIRM'), 'PRICING_LARGE_CHANGE_CONFIRM', { preview: fresh() });
        requireFreshSession(c);
      }
    } else if (pricing?.kind === 'data' && pricing.hash && body.pricing_hash !== pricing.hash) {
      throw new HttpError(409, serverMessage('PRICING_PREVIEW_STALE'), 'PRICING_PREVIEW_STALE', { preview: fresh() });
    }

    // ---- ONE batch: fence, product, membership, pricing, audit
    const now = new Date().toISOString();
    // Written against the product the comparison read: anything saved since refuses the whole batch.
    const head = fence(db, 'EXISTS(SELECT 1 FROM products WHERE id = ? AND updated_at IS ?)', [productId, state.updatedAt]);
    const docLines = ev.accepted;
    const docStmts: D1PreparedStatement[] = [];
    let plan: ProductSavePlan | null = null;
    const a = ev.analysis;
    const docAccepted = docLines.filter((n) => n.head !== 'membership');
    if (a && a.doc && docAccepted.length) {
      plan = await planSave(db, a, docAccepted, ev.patch?.removals ?? {}, productId, state.slug, viewer, false);
      let ps = plan.statements;
      // §29: a non-owner's save re-checks the stored serial answer inside its own batch (as /apply does).
      if (!viewer.owner) {
        const guard = await serialAnswerFence(db, { productId });
        if (guard) ps = guard.around(ps);
      }
      docStmts.push(...ps);
    }
    if (a && a.membership.length) {
      const mp = await deps.planTemplateMembership(db, viewer.id, productId, a.membership);
      if (mp) docStmts.push(...mp.statements);
    }
    const pricingLines = pricing ? ev.pricingAccepted : [];
    const pricingStmts: D1PreparedStatement[] = [];
    if (pricing && pricing.writes && (pricing.writes.inputWrites.length || pricing.writes.ruleWrites.length)) {
      const p = state.pricing!;
      const w = pricing.writes;
      // The values, owner-only, in pricing_audit — the same rows as before, eight to a statement.
      const auditRows: PricingAuditRow[] = [
        ...w.inputWrites.map(
          (iw): PricingAuditRow => ({
            entity: 'input',
            entity_key: `${iw.scope}:${iw.scope_id}`,
            product_id: productId,
            action: 'update',
            before: inputImage(iw.existing ? { ...iw.existing, iqd: storedIqdOf(iw.existing) } : null),
            after: inputImage(nextInputRow(iw)),
            summary: { source: 'data_file' },
            actor: viewer.id,
            now,
          })
        ),
        ...w.ruleWrites.map(
          (rw): PricingAuditRow => ({
            entity: 'rule',
            entity_key: `${rw.kind}:${rw.scope}:${rw.scope_id}`,
            product_id: productId,
            action: 'rule_set',
            before: ruleImage(rw.existing),
            after: ruleImage(rw.next),
            summary: { source: 'data_file' },
            actor: viewer.id,
            now,
          })
        ),
      ];
      if (pricing.kind === 'price' && pricing.ev) {
        pricingStmts.push(
          ...(await engineWriteStatements(db, pricing.ev, w.inputWrites, w.ruleWrites, {
            actor: viewer.id,
            now,
            source: 'data_file',
            idempotencyKey: `price:${productId}:${pricing.ev.hash}`,
            extraAudits: pricingAuditStatements(db, auditRows),
            auditDetail: { inputs_changed: w.inputWrites.length, rules_changed: w.ruleWrites.length, via: 'data_file' },
            pack: true,
          }))
        );
      } else {
        pricingStmts.push(
          ...batchHead(db, p.stored, now),
          ...inputStatements(db, productId, w.inputWrites, viewer.id, now, { pack: true }),
          ...ruleStatements(db, productId, w.ruleWrites, viewer.id, now, { pack: true }),
          ...pricingAuditStatements(db, auditRows),
          ...batchTail(db, productId)
        );
      }
    }
    // The trail: which keys, how many — never a value (values live in pricing_audit / price_history).
    const written = [...docLines, ...pricingLines];
    const appliedKeys = written.map((n) => n.key);
    const detail = {
      token,
      keys: appliedKeys.slice(0, 80),
      changed: appliedKeys.length,
      private_changed: written.filter((n) => isPrivateEntry(n)).length,
      prices_changed: docLines.filter((n) => isPriceEntry(n)).length,
      derived: ev.derived.length,
      pricing: pricing?.kind ?? 'none',
      refused: ev.fields.filter((f) => f.status !== 'change' && f.status !== 'STALE_IN_FILE').length,
    };
    const auditStmts = (await auditStatements(db, viewer.id, 'product.data_file.applied', productId, detail)).statements;
    const statements: D1PreparedStatement[] = [...head, ...docStmts, ...pricingStmts, ...auditStmts];

    // ---- what D1's 1,000 leave for this batch: counted before it, set aside after it (the
    // pictures the save drops are queued once it has committed)
    const spent = counted.executed;
    const allowance = dataApplyAllowance(spent, detachQueueQueries(plan?.detachedMedia.length ?? 0));
    if (statements.length > allowance) {
      // NOTHING is written: one product's changes land in one batch or not at all. The refusal
      // names the lines that make it too large, so the owner applies the file in two goes — each
      // its own comparison and its own atomic apply. Counts only: never a value, never a token.
      const docSize = docStmts.length ? head.length + docStmts.length + auditStmts.length : 0;
      const prSize = pricingStmts.length ? head.length + pricingStmts.length + auditStmts.length : 0;
      const sized = (size: number) => (size ? { statements: size, fits: size <= allowance } : undefined);
      const details = { needed: statements.length, allowance, spent, parts: { document: sized(docSize), pricing: sized(prSize) } };
      const code: DataFileRefusalCode =
        docSize > allowance ? 'DATA_FILE_PRODUCT_TOO_LARGE' : docSize && prSize && prSize <= allowance ? 'DATA_FILE_TOO_LARGE' : 'DATA_FILE_PRICING_TOO_LARGE';
      throw new HttpError(409, dataFileMessage(code), code, details);
    }

    try {
      if (plan) await saveProductAtomic(db, { ...plan, statements });
      else await db.batch(statements);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isFenceMiss(e) || /UNIQUE constraint failed: ops_guards/i.test(msg)) {
        if (await previousApply(db, productId, token)) return c.json({ success: true, already: true, product_id: productId });
        throw new HttpError(409, dataFileMessage('DATA_FILE_CHANGED'), 'DATA_FILE_CHANGED');
      }
      if (/UNIQUE constraint failed: pricing_audit\.idempotency_key/i.test(msg)) return c.json({ success: true, already: true, product_id: productId });
      if (/ENGINE_MANAGED/.test(msg)) throw new HttpError(409, serverMessage('ENGINE_MANAGED'), 'ENGINE_MANAGED');
      if (msg.includes('UNIQUE') && msg.includes('products.sku')) throw new HttpError(400, 'sku: already used by another product / رمز المنتج مستخدم في منتج آخر', 'SKU_TAKEN');
      const refusal = engineDbRefusal(e);
      if (refusal) throw refusal;
      throw e;
    }
    await afterCatalogueWrite(c, [state.slug]);
    c.set('completenessIds', [productId]);

    // Read back: every product line now reads as the file wrote it.
    const after = await liveState(db, deps, productId, viewer);
    const notPersisted: string[] = [];
    if (typeof after !== 'string') {
      const now2 = new Map(after.list.map((n) => [n.nkey, n]));
      for (const n of docLines) {
        if (n.meta || n.item?.isNew || n.head === 'spec') continue;
        if (/^[+-]\d+$/.test((n.value ?? '').trim())) continue; // an increase is stored as its adjustment
        const stored = now2.get(n.nkey);
        if (!stored) continue;
        if (canonicalValue(stored, stored.value) !== canonicalValue(n, n.value)) notPersisted.push(n.key);
      }
    }
    return c.json(
      projectForAdmin(c.env, c.get('user'), {
        success: true,
        already: false,
        product_id: productId,
        applied: appliedKeys,
        derived: ev.derived.map((d) => d.key),
        priced: pricing?.kind === 'price',
        not_persisted: notPersisted,
        updated_at: typeof after === 'string' ? null : after.updatedAt,
      })
    );
  });
}
