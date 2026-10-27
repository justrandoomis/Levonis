/**
 * WHAT THE STUDIO SCREENS DECIDE, WITHOUT A BROWSER — New design, Home,
 * Settings, the Archive and «الخدمات المعتمدة», as pure functions
 * (tests/creativeStudioScreensModel.test.ts).
 *
 *  - the visual priority is a real choice: only the priorities the template
 *    can honour for the goal are offered, and the chosen one's composition
 *    leads (spec §11, §34.18: no control without an effect);
 *  - «use this idea» carries every field of the idea a design can use, and a
 *    design keeps who wrote its words (origin 'ai' + the job, spec §27, §28);
 *  - a family's badge is a claim: drawn only with its evidence, and when it
 *    is not drawn the screen says why (spec §7, §10);
 *  - Settings sends the model and the priorities only when they changed, so a
 *    budget can be saved while the provider's model list is down;
 *  - the catalogue watch runs to the end of a pass, and says when the pass
 *    was only the baseline (spec §10);
 *  - the archive's «to» date includes its own day.
 */
import type {
  AssetDto, BudgetSettings, OpportunityDto, ClaimDto, Effort, IdeaRecordDto, IdeasRequest, ProviderSettingsRequest, ProviderStatusDto, Rates, VersionOrigin, WatchSyncResponse,
} from '../../../packages/creativeDoc/src/api';
import type { Objective, VisualPriority } from '../../../packages/creativeDoc/src/schema';
import type { Localized, PriceStatus } from '../../../packages/creativeDoc/src/snapshot';
import { FAMILIES, TEMPLATES, variantsFor, type BuildEvidence, type FamilyId, type TemplateId, type VariantId } from '../../../packages/creativeDoc/src/templates';
import type { ClaimInputBody, DocumentFilters } from './client';
import type { ChatIdea } from '../../../packages/creativeDoc/src/aiContracts';
import type { NewDesignPrefill } from './shared';
import { S, type Tri } from './strings';

// ---------------------------------------------------------------------------
// New design: priority, compositions, family
// ---------------------------------------------------------------------------

/** At most three compositions side by side; a template with fewer variants shows fewer (the header says «up to three»). */
export const MAX_COMPOSITIONS = 3;

/** The element each variant puts first — the same in every template that has the variant. */
export const VARIANT_PRIORITY: Readonly<Record<VariantId, VisualPriority>> = {
  product_first: 'product',
  price_first: 'price',
  feature_first: 'feature',
  headline_first: 'headline',
};

/** The priorities this template can honour for this goal: one per variant it would propose, in its order. */
export function supportedPriorities(template: TemplateId, objective: Objective, priceStatus: PriceStatus | null): VisualPriority[] {
  const def = TEMPLATES[template];
  const out: VisualPriority[] = [];
  for (const v of variantsFor(template, objective, priceStatus)) {
    const p = def.variants[v]?.priority;
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The owner's choice when the template honours it; otherwise the template's own first. */
export function effectivePriority(chosen: VisualPriority, supported: readonly VisualPriority[]): VisualPriority {
  return supported.includes(chosen) ? chosen : supported[0] ?? chosen;
}

/** The compositions to build: the chosen priority's variant first (`variantsFor`'s 4th argument), at most three. */
export function compositionVariants(template: TemplateId, objective: Objective, priceStatus: PriceStatus | null, priority: VisualPriority): VariantId[] {
  return variantsFor(template, objective, priceStatus, priority).slice(0, MAX_COMPOSITIONS);
}

/** The families New design offers per mode. A comparison needs two products, which New design does not bind yet. */
export const PRODUCT_FAMILIES: readonly FamilyId[] = ['new_arrival', 'back_in_stock', 'price_offer', 'education'];

/** The family a goal implies when nothing else chose one (an idea's goal, a service post). */
export function familyForObjective(objective: Objective, mode: 'product' | 'service'): FamilyId | null {
  if (mode === 'service') return 'service';
  return objective === 'arrival' ? 'new_arrival' : objective === 'back_in_stock' ? 'back_in_stock' : objective === 'education' ? 'education' : null;
}

/** What choosing a family sets: its goal, its template, and its variant's priority (so its variant leads). */
export function familyChoice(family: FamilyId): { objective: Objective; template: TemplateId; priority: VisualPriority } {
  const f = FAMILIES[family];
  return { objective: f.objective, template: f.template, priority: VARIANT_PRIORITY[f.variant] };
}

export type BadgeState =
  | { kind: 'none' }
  | { kind: 'drawn'; text: Localized }
  | { kind: 'no_evidence'; text: Localized; needs: keyof BuildEvidence };

/** A family's badge is a claim: drawn only with the evidence the shop's own records hold (an offer on the snapshot, an arrival or a return to stock in the opportunities). */
export function familyBadge(family: FamilyId | null, evidence: BuildEvidence): BadgeState {
  const badge = family ? FAMILIES[family].badge : null;
  if (!badge) return { kind: 'none' };
  return evidence[badge.needs] ? { kind: 'drawn', text: badge.text } : { kind: 'no_evidence', text: badge.text, needs: badge.needs };
}

// ---------------------------------------------------------------------------
// Ideas → New design, and who wrote a new design
// ---------------------------------------------------------------------------

/** Home's request for ideas: the owner's own priorities live in Settings; the opportunity kinds on screen are never sent as priorities. */
export function ideasRequest(idempotencyKey: string, count = 5): IdeasRequest {
  return { count, priorities: [], idempotency_key: idempotencyKey };
}

/** «Use this idea»: the target, the goal, the composition direction, the words, the caption and alt text, and the job. */
export function ideaPrefill(idea: IdeaRecordDto): NewDesignPrefill {
  const service = idea.target_kind === 'service';
  return {
    mode: service ? 'service' : 'product',
    productId: idea.target_kind === 'product' && idea.target_ref ? idea.target_ref : undefined,
    claimId: service && idea.target_ref ? idea.target_ref : undefined,
    objective: idea.objective,
    variant: idea.layout,
    copy: { headline: idea.headline, subhead: idea.subhead || undefined, cta: idea.cta || undefined },
    caption: idea.caption,
    alt: idea.alt_text,
    jobId: idea.job_id,
  };
}

/**
 * A Home opportunity row, clicked: a product row opens New design on that product with the goal its
 * evidence supports (an arrival, a return to stock, a live offer → sell); a service row on that approved
 * claim; a topic row (a category not posted about, an education topic) with the goal set.
 */
export function opportunityPrefill(o: Pick<OpportunityDto, 'kind' | 'ref'>): NewDesignPrefill {
  switch (o.kind) {
    case 'offer': return { mode: 'product', productId: o.ref, objective: 'sell' };
    case 'arrival': return { mode: 'product', productId: o.ref, objective: 'arrival' };
    case 'back_in_stock': return { mode: 'product', productId: o.ref, objective: 'back_in_stock' };
    case 'service_claim': return { mode: 'service', claimId: o.ref, objective: 'service_trust' };
    case 'education_topic': return { mode: 'product', objective: 'education' };
    default: return { mode: 'product', objective: 'sell' };
  }
}

/** A chat suggestion turned into a design: its words and goal, its product when it named one, and the chat job (stored as an ideas job). */
export function chatIdeaPrefill(idea: ChatIdea, jobId: string): NewDesignPrefill {
  return {
    mode: 'product',
    productId: idea.product_ref || undefined,
    objective: idea.objective,
    copy: { headline: idea.headline, subhead: idea.subhead || undefined },
    jobId,
  };
}

/** The visual priority to start New design with: the idea's composition direction, else the product. */
export function initialPriority(prefill: NewDesignPrefill | null): VisualPriority {
  return prefill?.variant ? VARIANT_PRIORITY[prefill.variant] : 'product';
}

/**
 * The job whose words a person's build carries: the idea's job while the
 * headline is still the idea's own; once the owner rewrote it, the words are
 * the owner's and the design is from the template.
 */
export function ideaJobFor(prefill: NewDesignPrefill | null, headline: string): string | null {
  const theirs = prefill?.copy?.headline?.trim();
  return prefill?.jobId && theirs && headline.trim() === theirs ? prefill.jobId : null;
}

/** A design built from Claude's words (a composition or an idea) is Claude's, with its job; one built from the template alone stays 'template'. */
export function createOrigin(jobId: string | null): { origin: VersionOrigin; job_id: string | null } {
  return jobId ? { origin: 'ai', job_id: jobId } : { origin: 'template', job_id: null };
}

/**
 * A refusal that may concern only the JOB (already applied to another design
 * — five ideas share one job —, cancelled, unknown, or not a job a new design
 * may cite). The design is then created once more from the template instead
 * of not at all: the words are on screen either way, and the version history
 * must not claim a job the server would not link. A refusal of the CONTENT
 * fails the second attempt the same way, and that error is shown.
 */
export function isJobRefusal(code: string): boolean {
  return ['JOB_ALREADY_APPLIED', 'JOB_CANCELLED', 'JOB_IN_PROGRESS', 'INVALID_INPUT', 'NOT_FOUND'].includes(code);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsForm {
  model: string;
  effort: Effort | '';
  budget: BudgetSettings;
  rates: Rates | null;
  vision: boolean;
  /** One priority per line. */
  priorities: string;
}

/** The owner's priorities as the server keeps them: one per line, spaces collapsed, at most 120 characters, at most 12, no repeats. */
export function parsePriorities(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const p = line.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (p && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 12);
}

/**
 * PUT /provider/settings: the model only when it CHANGED (the server checks a
 * model against the provider's live list, which is down when the key is
 * revoked — the caps must still be savable then), the priorities only when
 * they changed (an older Worker does not report them, and an untouched field
 * must not erase them).
 */
export function settingsPayload(s: Pick<ProviderStatusDto, 'model' | 'priorities'>, f: SettingsForm): ProviderSettingsRequest {
  const out: ProviderSettingsRequest = { effort: f.effort || null, budget: f.budget, rates: f.rates, vision_review: f.vision };
  if (f.model !== (s.model ?? '')) out.model = f.model || null;
  const next = parsePriorities(f.priorities);
  if (next.join('\n') !== (s.priorities ?? []).join('\n')) out.priorities = next;
  return out;
}

// ---------------------------------------------------------------------------
// Catalogue watch
// ---------------------------------------------------------------------------

export interface SyncTotals {
  steps: number;
  processed: number;
  arrivals: number;
  back_in_stock: number;
  /** Some step of this run was the baseline pass: nothing it saw is an arrival or a return to stock. */
  baseline: boolean;
  /** The pass reached the end of the catalogue. */
  complete: boolean;
}

/** A pass over a large catalogue is many bounded steps; this many is far past any real shop, and stops a runaway loop. */
export const SYNC_MAX_STEPS = 400;

/** Repeats POST /watch/sync until the pass is complete (or `stop()` / the step cap), reporting the running totals. */
export async function runCatalogSync(
  step: () => Promise<WatchSyncResponse>,
  onProgress: (t: SyncTotals) => void = () => undefined,
  stop: () => boolean = () => false,
  maxSteps = SYNC_MAX_STEPS,
): Promise<SyncTotals> {
  const t: SyncTotals = { steps: 0, processed: 0, arrivals: 0, back_in_stock: 0, baseline: false, complete: false };
  while (t.steps < maxSteps && !stop()) {
    const r = await step();
    t.steps += 1;
    t.processed += r.processed;
    t.arrivals += r.arrivals;
    t.back_in_stock += r.back_in_stock;
    t.baseline = t.baseline || r.baseline;
    if (r.pass_complete) t.complete = true;
    onProgress({ ...t });
    if (r.pass_complete) break;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** The words after an upload follow the review the SERVER gave the new asset (the owner's: approved; another admin's: waiting). */
export function uploadedText(review: AssetDto['review']): Tri {
  return review === 'approved' ? S.assetsUploaded : review === 'rejected' ? S.assetsUploadedRejected : S.assetsUploadedPending;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The filters as the server compares them: «to» is a whole day, so a bare date reaches the end of that day. */
export function archiveQuery(f: DocumentFilters): DocumentFilters {
  return { ...f, to: f.to && BARE_DATE.test(f.to) ? `${f.to}T23:59:59.999Z` : f.to };
}

// ---------------------------------------------------------------------------
// Service claims
// ---------------------------------------------------------------------------

export interface ClaimGroup {
  id: string;
  key: string;
  approved: ClaimDto | null;
  /** A newer version waiting for approval. */
  pending: ClaimDto | null;
}

/** GET /claims lists a claim's approved version and its newer pending one as two rows; the screen shows one claim. */
export function groupClaims(list: readonly ClaimDto[]): ClaimGroup[] {
  const out = new Map<string, ClaimGroup>();
  for (const c of list) {
    const g = out.get(c.id) ?? { id: c.id, key: c.key, approved: null, pending: null };
    if (c.status === 'approved' && (!g.approved || c.version > g.approved.version)) g.approved = c;
    if (c.status === 'pending' && (!g.pending || c.version > g.pending.version)) g.pending = c;
    out.set(c.id, g);
  }
  // A pending version older than the approved one is not newer work (the server lists only the newest pending).
  for (const g of out.values()) if (g.pending && g.approved && g.pending.version < g.approved.version) g.pending = null;
  return [...out.values()];
}

export interface ClaimForm {
  key: string;
  title: Localized;
  summary: Localized;
  conditions: Localized;
  details_path: string;
  product_ids: string[];
  valid_from: string;
  valid_until: string;
  last_verified_at: string;
  source_note: string;
}

const EMPTY_L: Localized = { ar: '', en: '', ckb: '' };
const day = (v: string | null) => (v ? v.slice(0, 10) : '');

/** The form for a new claim, or for a new version of `c` (it starts from the newest version's words). */
export function claimForm(c?: ClaimDto | null): ClaimForm {
  if (!c) {
    return { key: '', title: { ...EMPTY_L }, summary: { ...EMPTY_L }, conditions: { ...EMPTY_L }, details_path: '', product_ids: [], valid_from: '', valid_until: '', last_verified_at: '', source_note: '' };
  }
  return {
    key: c.key, title: { ...c.title }, summary: { ...c.summary }, conditions: { ...c.conditions }, details_path: c.details_path ?? '', product_ids: [...c.product_ids],
    valid_from: day(c.valid_from), valid_until: day(c.valid_until), last_verified_at: day(c.last_verified_at), source_note: c.source_note,
  };
}

export type ClaimProblem = 'key' | 'title' | 'ckb_copy' | 'dates' | 'path';

/** What the server would refuse, said before the request (worker/lib/creative/claims.ts `claimInput`, `createClaim`). */
export function claimFormProblems(f: ClaimForm, isNew: boolean): ClaimProblem[] {
  const out: ClaimProblem[] = [];
  if (isNew && !/^[a-z][a-z0-9_]{0,59}$/.test(f.key)) out.push('key');
  if (!f.title.ar.trim() && !f.title.en.trim()) out.push('title');
  if ([f.title, f.summary, f.conditions].some((l) => l.ckb.trim() !== '' && l.ckb.trim() === l.ar.trim())) out.push('ckb_copy');
  if (f.valid_from && f.valid_until && f.valid_from > f.valid_until) out.push('dates');
  const path = f.details_path.trim();
  if (path && (!/^\/(?!\/)[A-Za-z0-9/_\-.~?=&%]{0,200}$/.test(path) || path.includes('..'))) out.push('path');
  return out;
}

/** The request body: trimmed words, empty dates as null. */
export function claimBody(f: ClaimForm): ClaimInputBody {
  const l = (x: Localized): Localized => ({ ar: x.ar.trim(), en: x.en.trim(), ckb: x.ckb.trim() });
  const d = (v: string) => (v.trim() ? v.trim() : null);
  return {
    title: l(f.title), summary: l(f.summary), conditions: l(f.conditions), details_path: d(f.details_path), product_ids: [...new Set(f.product_ids)],
    valid_from: d(f.valid_from), valid_until: d(f.valid_until), last_verified_at: d(f.last_verified_at), source_note: f.source_note.trim(),
  };
}

/** Approval needs the title and summary in all three languages (the server refuses otherwise); the button says so first. */
export function claimApprovable(c: ClaimDto): boolean {
  return [c.title, c.summary].every((l) => !!l.ar.trim() && !!l.en.trim() && !!l.ckb.trim());
}
