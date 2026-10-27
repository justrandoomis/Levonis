/**
 * THE AI CONTRACTS — what Claude may return, as JSON schemas for the API's
 * structured outputs (`output_config.format`), and the local validators that
 * decide what the app actually accepts (spec §28).
 *
 * Valid JSON proves nothing about truth (spec §15). Every response passes a
 * second gate here: lengths (the API cannot enforce them), references that
 * must point at things the request supplied (product ids, evidence ids,
 * template variants, layer ids of THIS document at THIS version), and the
 * content rules — no price-like text, no links, no claim the evidence does
 * not support, no Sorani written by the model (DECISIONS row 262).
 *
 * Schema rules forced by the API (verified against the structured-outputs
 * docs, 2026-10-27): every object `additionalProperties: false`; no
 * min/max/length constraints; at most 16 union-typed parameters and 24
 * optional ones per request — so every property here is REQUIRED and
 * "nothing" is an empty string or an empty list, never a nullable union. The
 * one union is the operation list of an edit.
 */
import { applyOps, type ApplyResult, type OpsContext } from './ops';
import { ID_PATTERN, OBJECTIVES, VISUAL_PRIORITIES, type CreativeDocument, type Objective, type VisualPriority } from './schema';
import { VARIANT_IDS, type VariantId } from './templates';
import { cleanText, containsPriceLike, containsUrl, unsupportedClaims, type ClaimKind } from './text';

type JsonSchema = Record<string, unknown>;
const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const bool = { type: 'boolean' } as const;
const strArr = { type: 'array', items: str } as const;
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const en = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] });

/** The locales Claude may write ad copy in. Sorani (ckb) copy is written by people (DECISIONS row 262). */
export const AI_COPY_LOCALES = ['ar', 'en'] as const;
export type AiCopyLocale = (typeof AI_COPY_LOCALES)[number];

// ---------------------------------------------------------------------------
// 1) «شنو أنشر اليوم؟» — post ideas (spec §10)
// ---------------------------------------------------------------------------

export const IDEA_POST_TYPES = ['single', 'carousel', 'story'] as const;
export const IDEA_TARGET_KINDS = ['product', 'service', 'category', 'topic'] as const;

export const IDEAS_SCHEMA: JsonSchema = obj({
  ideas: {
    type: 'array',
    items: obj({
      objective: en(OBJECTIVES),
      target_kind: en(IDEA_TARGET_KINDS),
      /** A product id, claim id or category id FROM THE REQUEST; empty for a topic. */
      target_ref: str,
      audience: str,
      reason: str,
      /** Evidence ids FROM THE REQUEST that support the idea. */
      evidence_ids: strArr,
      message: str,
      headline: str,
      subhead: str,
      cta: str,
      post_type: en(IDEA_POST_TYPES),
      layout: en(['product_first', 'price_first', 'feature_first', 'headline_first']),
      caption: str,
      alt_text: str,
    }),
  },
  notes: strArr,
});

export interface Idea {
  objective: Objective;
  target_kind: (typeof IDEA_TARGET_KINDS)[number];
  target_ref: string;
  audience: string;
  reason: string;
  evidence_ids: string[];
  message: string;
  headline: string;
  subhead: string;
  cta: string;
  post_type: (typeof IDEA_POST_TYPES)[number];
  layout: VariantId;
  caption: string;
  alt_text: string;
}

export interface Evidence {
  id: string;
  /** What it proves. `offer` allows offer wording for its product; `service_claim` allows that claim's terms. */
  kind: 'arrival' | 'back_in_stock' | 'offer' | 'coverage_gap' | 'service_claim' | 'owner_priority' | 'education_topic' | 'history';
  /** The product, claim or category it is about (empty for a general one). */
  ref: string;
}

export interface IdeasContext {
  products: ReadonlySet<string>;
  services: ReadonlySet<string>;
  categories: ReadonlySet<string>;
  evidence: readonly Evidence[];
  max: number;
}

export interface Rejected {
  index: number;
  code: 'unknown_target' | 'unknown_evidence' | 'no_evidence' | 'price_like_text' | 'invented_link' | 'unsupported_claim' | 'empty' | 'invalid';
  detail?: string;
}

const C = (v: unknown, max: number, multiline = false) => cleanText(v, max, multiline).value;

/** Free text a model wrote: price-like words, links and unsupported claims are refused. */
export function textProblems(texts: readonly string[], evidence: { offer: boolean; serviceClaim: boolean }): { code: Rejected['code']; detail?: string } | null {
  for (const t of texts) {
    if (!t) continue;
    if (containsPriceLike(t)) return { code: 'price_like_text', detail: t.slice(0, 80) };
    if (containsUrl(t)) return { code: 'invented_link', detail: t.slice(0, 80) };
    const bad: ClaimKind[] = unsupportedClaims(t, evidence);
    if (bad.length) return { code: 'unsupported_claim', detail: bad.join(',') };
  }
  return null;
}

export function validateIdeas(raw: unknown, ctx: IdeasContext): { ideas: Idea[]; rejected: Rejected[]; notes: string[] } {
  const out: Idea[] = [];
  const rejected: Rejected[] = [];
  const src = raw && typeof raw === 'object' ? (raw as { ideas?: unknown; notes?: unknown }) : {};
  const list = Array.isArray(src.ideas) ? src.ideas : [];
  const evidenceById = new Map(ctx.evidence.map((e) => [e.id, e]));
  list.slice(0, 12).forEach((r, index) => {
    if (out.length >= ctx.max) return;
    if (!r || typeof r !== 'object') return rejected.push({ index, code: 'invalid' });
    const o = r as Record<string, unknown>;
    const objective = (OBJECTIVES as readonly string[]).includes(o.objective as string) ? (o.objective as Objective) : null;
    const target_kind = (IDEA_TARGET_KINDS as readonly string[]).includes(o.target_kind as string) ? (o.target_kind as Idea['target_kind']) : null;
    const post_type = (IDEA_POST_TYPES as readonly string[]).includes(o.post_type as string) ? (o.post_type as Idea['post_type']) : 'single';
    const layout = (VARIANT_IDS as readonly string[]).includes(o.layout as string) ? (o.layout as VariantId) : 'product_first';
    if (!objective || !target_kind) return rejected.push({ index, code: 'invalid' });
    const target_ref = typeof o.target_ref === 'string' ? o.target_ref.trim() : '';
    const known = target_kind === 'product' ? ctx.products.has(target_ref) : target_kind === 'service' ? ctx.services.has(target_ref) : target_kind === 'category' ? ctx.categories.has(target_ref) : true;
    if (!known) return rejected.push({ index, code: 'unknown_target', detail: target_ref.slice(0, 64) });
    const evidence_ids = Array.isArray(o.evidence_ids) ? [...new Set(o.evidence_ids.filter((x): x is string => typeof x === 'string'))].slice(0, 6) : [];
    if (evidence_ids.some((id) => !evidenceById.has(id))) return rejected.push({ index, code: 'unknown_evidence' });
    if (!evidence_ids.length) return rejected.push({ index, code: 'no_evidence' });
    // Arrival / back-in-stock objectives need the matching documented evidence (spec §10).
    const kinds = evidence_ids.map((id) => evidenceById.get(id)!);
    if (objective === 'arrival' && !kinds.some((e) => e.kind === 'arrival' && e.ref === target_ref)) return rejected.push({ index, code: 'no_evidence', detail: 'arrival' });
    if (objective === 'back_in_stock' && !kinds.some((e) => e.kind === 'back_in_stock' && e.ref === target_ref)) return rejected.push({ index, code: 'no_evidence', detail: 'back_in_stock' });
    const idea: Idea = {
      objective, target_kind, target_ref, post_type, layout, evidence_ids,
      audience: C(o.audience, 120), reason: C(o.reason, 300), message: C(o.message, 300), headline: C(o.headline, 90),
      subhead: C(o.subhead, 160), cta: C(o.cta, 40), caption: C(o.caption, 1200, true), alt_text: C(o.alt_text, 300),
    };
    if (!idea.headline || !idea.reason) return rejected.push({ index, code: 'empty' });
    const ev = { offer: kinds.some((e) => e.kind === 'offer' && e.ref === target_ref), serviceClaim: kinds.some((e) => e.kind === 'service_claim') };
    const bad = textProblems([idea.headline, idea.subhead, idea.cta, idea.message, idea.caption, idea.alt_text], ev);
    if (bad) return rejected.push({ index, ...bad });
    out.push(idea);
  });
  const notes = Array.isArray(src.notes) ? src.notes.map((n) => C(n, 200)).filter(Boolean).slice(0, 6) : [];
  return { ideas: out, rejected, notes };
}

// ---------------------------------------------------------------------------
// 2) Three compositions — copy and emphasis for each variant (spec §12)
// ---------------------------------------------------------------------------

export const COMPOSE_SCHEMA: JsonSchema = obj({
  proposals: {
    type: 'array',
    items: obj({
      variant: en(VARIANT_IDS),
      reason: str,
      headline: str,
      subhead: str,
      features: strArr,
      cta: str,
      caption: str,
      alt_text: str,
    }),
  },
  warnings: strArr,
  /** Facts the request lacked that a better ad would need (asked of the owner, never invented). */
  missing: strArr,
});

export interface Proposal {
  variant: VariantId;
  reason: string;
  headline: string;
  subhead: string;
  features: string[];
  cta: string;
  caption: string;
  alt_text: string;
}

export function validateCompose(raw: unknown, ctx: { variants: readonly VariantId[]; evidence: { offer: boolean; serviceClaim: boolean }; maxFeatures: number }): { proposals: Proposal[]; rejected: Rejected[]; warnings: string[]; missing: string[] } {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const proposals: Proposal[] = [];
  const rejected: Rejected[] = [];
  (Array.isArray(src.proposals) ? src.proposals : []).slice(0, 6).forEach((r, index) => {
    if (!r || typeof r !== 'object') return rejected.push({ index, code: 'invalid' });
    const o = r as Record<string, unknown>;
    if (!ctx.variants.includes(o.variant as VariantId)) return rejected.push({ index, code: 'invalid', detail: String(o.variant).slice(0, 32) });
    if (proposals.some((p) => p.variant === o.variant)) return rejected.push({ index, code: 'invalid', detail: 'duplicate variant' });
    const p: Proposal = {
      variant: o.variant as VariantId,
      reason: C(o.reason, 240),
      headline: C(o.headline, 90),
      subhead: C(o.subhead, 160),
      features: Array.isArray(o.features) ? o.features.map((f) => C(f, 80)).filter(Boolean).slice(0, ctx.maxFeatures) : [],
      cta: C(o.cta, 40),
      caption: C(o.caption, 1200, true),
      alt_text: C(o.alt_text, 300),
    };
    if (!p.headline) return rejected.push({ index, code: 'empty' });
    const bad = textProblems([p.headline, p.subhead, p.cta, p.caption, p.alt_text, ...p.features], ctx.evidence);
    if (bad) return rejected.push({ index, ...bad });
    proposals.push(p);
  });
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => C(x, 200)).filter(Boolean).slice(0, 6) : []);
  return { proposals, rejected, warnings: list(src.warnings), missing: list(src.missing) };
}

// ---------------------------------------------------------------------------
// 3) A bounded edit — the patch (spec §16, §28)
// ---------------------------------------------------------------------------

const opSchema = (op: string, props: Record<string, JsonSchema>) => obj({ op: { type: 'string', const: op }, ...props });

/** Every operation Claude may emit, all fields required (no optional or nullable members). */
export const EDIT_OP_SCHEMA: JsonSchema = {
  anyOf: [
    opSchema('set_text', { layer_id: str, value: str }),
    opSchema('move_layer', { layer_id: str, x: num, y: num }),
    opSchema('nudge_layer', { layer_id: str, dx: num, dy: num }),
    opSchema('scale_asset_uniform', { layer_id: str, factor: num, anchor: en(['center', 'top', 'bottom', 'start', 'end']) }),
    opSchema('set_alignment', { layer_id: str, align: en(['start', 'center', 'end']) }),
    opSchema('set_font_size', { layer_id: str, size: num }),
    opSchema('set_color', { layer_id: str, color: str }),
    opSchema('set_spacing', { relation_id: str, gap: num }),
    opSchema('replace_asset', { layer_id: str, ref: str }),
    opSchema('apply_background_preset', { preset_id: str }),
    opSchema('set_visibility', { layer_id: str, visible: bool }),
    opSchema('reorder_layer', { layer_id: str, to: en(['front', 'back', 'forward', 'backward']) }),
    opSchema('set_priority', { priority: en(VISUAL_PRIORITIES) }),
    opSchema('switch_template_variant', { variant: en(VARIANT_IDS) }),
    opSchema('create_format_variant', { format: en(['square', 'portrait', 'story']) }),
    opSchema('set_caption', { value: str }),
    opSchema('set_alt_text', { value: str }),
  ],
};

export const EDIT_SCHEMA: JsonSchema = obj({
  schema_version: { type: 'integer', enum: [1] },
  document_id: str,
  base_document_version: { type: 'integer' },
  intent: str,
  target_layer_ids: strArr,
  operations: { type: 'array', items: EDIT_OP_SCHEMA },
  reason: str,
  warnings: strArr,
  /** A short question when the request is ambiguous (spec §17) — then `operations` is empty. Empty string otherwise. */
  clarification: str,
});

export interface EditPatch {
  schema_version: 1;
  document_id: string;
  base_document_version: number;
  intent: string;
  target_layer_ids: string[];
  operations: unknown[];
  reason: string;
  warnings: string[];
  clarification: string;
}

export interface PatchContext {
  documentId: string;
  /** The document version the request was made against — the patch must name it (spec §16: stale answers are dropped). */
  version: number;
  doc: CreativeDocument;
  /**
   * The layers the owner selected or pointed at. When set, every target must
   * be one of them (spec §16: «غيّر العنوان فقط» changes the headline only);
   * design-wide operations then need an explicit design-wide request (null).
   */
  scope: readonly string[] | null;
  evidence: { offer: boolean; serviceClaim: boolean };
  ops: Omit<OpsContext, 'actor'>;
}

export type PatchVerdict =
  | { ok: true; patch: EditPatch; applied: Extract<ApplyResult, { ok: true }> | null }
  | { ok: false; code: 'invalid_patch' | 'wrong_document' | 'stale_version' | 'target_outside_document' | 'target_outside_scope' | 'op_target_undeclared' | 'design_wide_needs_scope' | 'text_refused' | 'ops_refused'; detail?: unknown };

const DESIGN_WIDE: ReadonlySet<string> = new Set(['apply_background_preset', 'set_priority', 'switch_template_variant', 'create_format_variant', 'set_caption', 'set_alt_text']);

/**
 * The gate an edit patch passes before the editor may even preview it.
 * Order matters: identity and version first (a stale answer never gets as
 * far as being applied), then targets, then the operations themselves on a
 * copy of the document.
 */
export function validateEditPatch(raw: unknown, ctx: PatchContext): PatchVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_patch' };
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== 1 || !Array.isArray(o.operations) || !Array.isArray(o.target_layer_ids)) return { ok: false, code: 'invalid_patch' };
  if (o.document_id !== ctx.documentId) return { ok: false, code: 'wrong_document' };
  if (o.base_document_version !== ctx.version) return { ok: false, code: 'stale_version', detail: { expected: ctx.version, got: o.base_document_version } };
  const targets = [...new Set(o.target_layer_ids.filter((x): x is string => typeof x === 'string'))];
  if (targets.length !== o.target_layer_ids.length || targets.some((t) => !ID_PATTERN.test(t))) return { ok: false, code: 'invalid_patch' };
  const ids = new Set(ctx.doc.layers.map((l) => l.id));
  const relIds = new Set(ctx.doc.relations.map((r) => r.id));
  const outside = targets.filter((t) => !ids.has(t));
  if (outside.length) return { ok: false, code: 'target_outside_document', detail: outside };
  if (ctx.scope) {
    const scope = new Set(ctx.scope);
    const extra = targets.filter((t) => !scope.has(t));
    if (extra.length) return { ok: false, code: 'target_outside_scope', detail: extra };
  }
  const operations = o.operations.slice(0, 24);
  if (o.operations.length > 24) return { ok: false, code: 'invalid_patch', detail: 'too many operations' };
  for (const op of operations) {
    const name = op && typeof op === 'object' ? (op as { op?: unknown }).op : undefined;
    if (typeof name === 'string' && DESIGN_WIDE.has(name)) {
      if (ctx.scope) return { ok: false, code: 'design_wide_needs_scope', detail: name };
      continue;
    }
    const lid = op && typeof op === 'object' ? (op as { layer_id?: unknown; relation_id?: unknown }) : {};
    if (typeof lid.layer_id === 'string' && !targets.includes(lid.layer_id)) return { ok: false, code: 'op_target_undeclared', detail: lid.layer_id };
    if (typeof lid.relation_id === 'string') {
      if (!relIds.has(lid.relation_id)) return { ok: false, code: 'target_outside_document', detail: lid.relation_id };
      const rel = ctx.doc.relations.find((r) => r.id === lid.relation_id)!;
      const subjects = rel.kind === 'order' ? rel.members : rel.kind === 'anchor' || rel.kind === 'shadow_of' ? [rel.subject] : [rel.subject];
      if (!subjects.some((s) => targets.includes(s))) return { ok: false, code: 'op_target_undeclared', detail: lid.relation_id };
    }
  }
  const patch: EditPatch = {
    schema_version: 1,
    document_id: ctx.documentId,
    base_document_version: ctx.version,
    intent: C(o.intent, 60),
    target_layer_ids: targets,
    operations,
    reason: C(o.reason, 300),
    warnings: Array.isArray(o.warnings) ? o.warnings.map((w) => C(w, 200)).filter(Boolean).slice(0, 8) : [],
    clarification: C(o.clarification, 200),
  };
  // Claims (discount, free, warranty term…) in any text the patch writes need evidence.
  const texts = operations.flatMap((op) => (op && typeof op === 'object' && typeof (op as { value?: unknown }).value === 'string' ? [(op as { value: string }).value] : []));
  const bad = textProblems(texts, ctx.evidence);
  if (bad) return { ok: false, code: 'text_refused', detail: bad };
  if (!operations.length) return { ok: true, patch, applied: null };
  const applied = applyOps(ctx.doc, operations, { ...ctx.ops, actor: 'ai' });
  // `=== false`, not `!`: src/ (a non-strict tsconfig) compiles this file too, and only a literal comparison narrows the union there.
  if (applied.ok === false) return { ok: false, code: 'ops_refused', detail: applied.refusals };
  return { ok: true, patch, applied };
}

// ---------------------------------------------------------------------------
// 4) Visual review notes (spec §23, §44 layer 3) — advice, never approval
// ---------------------------------------------------------------------------

export const REVIEW_CATEGORIES = ['balance', 'density', 'product_size', 'readability', 'edges', 'shadow', 'lighting', 'brand', 'other'] as const;
export const REVIEW_SEVERITIES = ['blocker', 'review', 'optional'] as const;

export const REVIEW_SCHEMA: JsonSchema = obj({
  notes: {
    type: 'array',
    items: obj({
      /** A layer id of the reviewed document, or empty when the note is about an area or the whole. */
      layer_id: str,
      category: en(REVIEW_CATEGORIES),
      severity: en(REVIEW_SEVERITIES),
      issue: str,
      suggestion: str,
    }),
  },
  summary: str,
});

export interface ReviewNote {
  layer_id: string;
  category: (typeof REVIEW_CATEGORIES)[number];
  severity: (typeof REVIEW_SEVERITIES)[number];
  issue: string;
  suggestion: string;
}

export function validateReview(raw: unknown, ctx: { layerIds: ReadonlySet<string> }): { notes: ReviewNote[]; summary: string } {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const notes: ReviewNote[] = [];
  for (const r of (Array.isArray(src.notes) ? src.notes : []).slice(0, 12)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const category = (REVIEW_CATEGORIES as readonly string[]).includes(o.category as string) ? (o.category as ReviewNote['category']) : 'other';
    // A model's visual opinion is never a blocker on its own (spec §44): it is downgraded to "review".
    const severity = o.severity === 'optional' ? 'optional' : 'review';
    const layer_id = typeof o.layer_id === 'string' && ctx.layerIds.has(o.layer_id) ? o.layer_id : '';
    const issue = C(o.issue, 240);
    if (!issue) continue;
    notes.push({ layer_id, category, severity, issue, suggestion: C(o.suggestion, 240) });
  }
  return { notes, summary: C(src.summary, 400) };
}

// ---------------------------------------------------------------------------
// 5) A carousel plan (spec §20) — editable before any slide is designed
// ---------------------------------------------------------------------------

export const CAROUSEL_SCHEMA: JsonSchema = obj({
  slides: {
    type: 'array',
    items: obj({
      purpose: en(['opening', 'explain', 'example', 'compare', 'contents', 'service', 'cta']),
      headline: str,
      body: str,
      uses_product: bool,
    }),
  },
  caption: str,
  alt_texts: strArr,
});

export interface CarouselSlidePlan {
  purpose: 'opening' | 'explain' | 'example' | 'compare' | 'contents' | 'service' | 'cta';
  headline: string;
  body: string;
  uses_product: boolean;
}

export function validateCarousel(raw: unknown, ctx: { evidence: { offer: boolean; serviceClaim: boolean }; maxSlides: number }): { slides: CarouselSlidePlan[]; caption: string; rejected: Rejected[] } {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const slides: CarouselSlidePlan[] = [];
  const rejected: Rejected[] = [];
  const purposes = ['opening', 'explain', 'example', 'compare', 'contents', 'service', 'cta'];
  (Array.isArray(src.slides) ? src.slides : []).slice(0, ctx.maxSlides).forEach((r, index) => {
    if (!r || typeof r !== 'object') return rejected.push({ index, code: 'invalid' });
    const o = r as Record<string, unknown>;
    const s: CarouselSlidePlan = {
      purpose: (purposes.includes(o.purpose as string) ? o.purpose : 'explain') as CarouselSlidePlan['purpose'],
      headline: C(o.headline, 90),
      body: C(o.body, 360, true),
      uses_product: o.uses_product === true,
    };
    if (!s.headline) return rejected.push({ index, code: 'empty' });
    const bad = textProblems([s.headline, s.body], ctx.evidence);
    if (bad) return rejected.push({ index, ...bad });
    slides.push(s);
  });
  return { slides, caption: C(src.caption, 1500, true), rejected };
}

/** Schema → the `output_config.format` body for the Messages API. */
export function outputFormat(schema: JsonSchema): { type: 'json_schema'; schema: JsonSchema } {
  return { type: 'json_schema', schema };
}

export type { VisualPriority };
