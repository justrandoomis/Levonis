/**
 * PRINT REQUESTS v2 — THE JOB'S REVISIONS, THE OFFER'S TERMS, AND WHAT AN
 * ACCEPTANCE HANDS EACH SIDE (stream W5-A; migration 0130; docs/merchant-
 * platform/audit/03 §9 G1–G5, G15–G17, §11 items 9–12, 19–20).
 *
 * WHAT A REVISION IS. A request's `revision` (0116) is the version of the job
 * merchants price. This module decides what counts as a change to the job —
 * the PRICED FACTS, hashed — and keeps a row per revision in
 * `community_request_revisions` with the spec, the attachment list and the
 * estimate as they stood. The rule the brief sets, and every writer follows:
 *
 *   a material change AFTER THE FIRST OFFER creates a new revision, and every
 *   pending offer that priced an older one becomes `superseded` (its merchant
 *   is told, and may re-confirm or edit it for the job as it now is);
 *   a change NOBODY PRICED YET rewrites the current revision's row in place —
 *   there is no offer it could strand.
 *
 * Both halves are decided INSIDE the write (`bumpRevisionIfOfferedSql`), not
 * from a read before it, so an offer that lands between the read and the
 * write is still seen: it either priced the old job and is superseded, or
 * priced the new one.
 *
 * NOTHING HERE TRUSTS A CLIENT FIGURE. The hash is computed on the server
 * from normalised facts; the contact snapshot is read from the customer's
 * own saved address and the store's own settings at the moment of acceptance.
 */
import { sha256Hex } from './crypto';
import { safeParse } from './types';

/** How long an untouched draft lives before the sweep calls it abandoned. */
export const DRAFT_TTL_DAYS = 14;

/** Where the customer's job comes from (wizard v2). */
export const SOURCE_TYPES = ['model', 'link', 'images', 'description'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** How a merchant hands the finished job over. An enum, never free text, in v2. */
export const OFFER_DELIVERY_METHODS = ['pickup', 'merchant_delivery', 'courier'] as const;
export type OfferDeliveryMethod = (typeof OFFER_DELIVERY_METHODS)[number];

/** At most this many catalogue materials on one offer. */
export const OFFER_MAX_MATERIALS = 5;
/** An offer's validity, in days, when the merchant sets one. */
export const OFFER_VALIDITY_MAX_DAYS = 60;

export interface Dims {
  x: number;
  y: number;
  z: number;
}

/**
 * THE FACTS A MERCHANT PRICES — flat, typed, and the ONLY input to the hash.
 * Built from the database rows (`factsFromRows`) and from a publish body (the
 * route builds the same shape), so "did the job change?" compares like with
 * like. Title, description and budget are deliberately absent: rewording the
 * title does not change what is made, and the budget is the customer's hope,
 * not the job.
 */
export interface PricedFacts {
  quantity: number;
  source_type: string;
  process: string | null;
  material_id: string | null;
  color_hex: string;
  color_name: string;
  quality: string;
  infill_percent: number;
  supports: boolean;
  colors_count: number;
  post_processing_minutes: number;
  primary_file_id: string | null;
  source_url: string;
  stated_dims: Dims | null;
  governorate: string;
  delivery_pref: string;
  deadline: string;
  customer_notes: string;
  file_ids: string[];
}

export interface RevisionFile {
  id: string;
  kind: string;
  content_type: string;
  size_bytes: number;
  file_name: string;
}

/** A dimension triple the customer typed, or null. Each edge 1–5000 mm. */
export function readDims(raw: unknown): Dims | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 1 && x <= 5000 ? Math.round(x * 10) / 10 : NaN;
  };
  const d = { x: n(r.x), y: n(r.y), z: n(r.z) };
  return Number.isNaN(d.x) || Number.isNaN(d.y) || Number.isNaN(d.z) ? null : d;
}

/** The stated dimensions column, parsed. '' and garbage are "none". */
export function parseDims(raw: unknown): Dims | null {
  return readDims(safeParse<unknown>(raw, null));
}

/** «لست متأكدًا» — the process a row really asks for, or null when unsure. */
export function effectiveProcess(p: Record<string, unknown> | null | undefined): 'fdm' | 'resin' | null {
  if (!p) return null;
  if (Number(p.process_unsure ?? 0) === 1) return null;
  return p.process === 'resin' ? 'resin' : p.process === 'fdm' ? 'fdm' : null;
}

/** The material a row really asks for, or null when unsure / not chosen. */
export function effectiveMaterial(p: Record<string, unknown> | null | undefined): string | null {
  if (!p) return null;
  if (Number(p.material_unsure ?? 0) === 1) return null;
  const id = String(p.material_id ?? '');
  return id || null;
}

/** What `source_type` a row carries; older rows are derived from 0045's `source_kind`. */
export function effectiveSourceType(p: Record<string, unknown> | null | undefined, fileKinds: string[] = []): SourceType {
  const t = String(p?.source_type ?? '');
  if ((SOURCE_TYPES as readonly string[]).includes(t)) return t as SourceType;
  if (p?.source_kind === 'link') return 'link';
  if (p?.primary_file_id || fileKinds.includes('model')) return 'model';
  if (fileKinds.includes('reference')) return 'images';
  return 'description';
}

/** The priced facts as a canonical string: fixed key order, sorted file ids. */
export function canonicalFacts(f: PricedFacts): string {
  return JSON.stringify([
    f.quantity, f.source_type, f.process, f.material_id, f.color_hex.toLowerCase(), f.color_name,
    f.quality, f.infill_percent, f.supports, f.colors_count, f.post_processing_minutes,
    f.primary_file_id, f.source_url, f.stated_dims ? [f.stated_dims.x, f.stated_dims.y, f.stated_dims.z] : null,
    f.governorate, f.delivery_pref, f.deadline, f.customer_notes.trim(), [...f.file_ids].sort(),
  ]);
}

export async function factsHash(f: PricedFacts): Promise<string> {
  return sha256Hex(canonicalFacts(f));
}

/** The priced facts of a request as the database holds them now. */
export function factsFromRows(
  r: Record<string, unknown>,
  p: Record<string, unknown> | null,
  files: RevisionFile[]
): PricedFacts {
  return {
    quantity: Number(r.quantity ?? 1),
    source_type: effectiveSourceType(p, files.map((f) => f.kind)),
    process: effectiveProcess(p),
    material_id: effectiveMaterial(p),
    color_hex: String(p?.color_hex ?? ''),
    color_name: String(p?.color_name ?? ''),
    quality: String(p?.quality ?? 'standard'),
    infill_percent: Number(p?.infill_percent ?? 20),
    supports: Number(p?.supports ?? 1) === 1,
    colors_count: Number(p?.colors_count ?? 1),
    post_processing_minutes: Number(p?.post_processing_minutes ?? 0),
    primary_file_id: (p?.primary_file_id as string | null) ?? null,
    source_url: String(p?.source_url ?? ''),
    stated_dims: parseDims(p?.stated_dims),
    governorate: String(r.governorate ?? ''),
    delivery_pref: String(r.delivery_pref ?? ''),
    deadline: String(r.deadline ?? ''),
    customer_notes: String(r.customer_notes ?? ''),
    file_ids: files.map((f) => f.id),
  };
}

export async function readRevisionFiles(db: D1Database, requestId: string): Promise<RevisionFile[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, content_type, size_bytes, file_name FROM community_request_files
        WHERE request_id = ? ORDER BY created_at, id`
    )
    .bind(requestId)
    .all<RevisionFile>();
  return (results ?? []).map((f) => ({
    id: String(f.id),
    kind: String(f.kind),
    content_type: String(f.content_type),
    size_bytes: Number(f.size_bytes ?? 0),
    file_name: String(f.file_name ?? ''),
  }));
}

export interface RevisionSnapshot {
  spec: Record<string, unknown>;
  files: RevisionFile[];
  estimate: Record<string, unknown>;
  hash: string;
}

/** The estimate as a customer and merchant may read it: never the cost lines. */
export function publicEstimate(raw: unknown): Record<string, unknown> {
  const e = { ...(safeParse<Record<string, unknown>>(raw, {}) ?? {}) };
  delete e.cost_lines;
  delete e.cost_iqd;
  delete e.floor_iqd;
  delete e.margin_percent;
  return e;
}

/** The spec half of a snapshot: the priced facts plus what describes the job. */
export function snapshotSpec(r: Record<string, unknown>, facts: PricedFacts, measured: Dims | null): Record<string, unknown> {
  return {
    title: String(r.title ?? ''),
    description: String(r.description ?? ''),
    budget_iqd: r.budget_iqd === null || r.budget_iqd === undefined ? null : Number(r.budget_iqd),
    ...facts,
    process_unsure: facts.process === null,
    material_unsure: facts.material_id === null,
    measured_dims: measured,
  };
}

/** Everything a revision row holds, read from the request as it is now. */
export async function composeSnapshot(db: D1Database, requestId: string): Promise<RevisionSnapshot | null> {
  const r = await db.prepare('SELECT * FROM community_requests WHERE id = ?').bind(requestId).first<Record<string, unknown>>();
  if (!r) return null;
  const p = await db
    .prepare('SELECT * FROM community_print_requests WHERE request_id = ?')
    .bind(requestId)
    .first<Record<string, unknown>>();
  const files = await readRevisionFiles(db, requestId);
  const facts = factsFromRows(r, p ?? null, files);
  const analysis = safeParse<{ measured?: boolean; dimensions_mm?: Dims } | null>(p?.analysis, null);
  return {
    spec: snapshotSpec(r, facts, analysis?.measured && analysis.dimensions_mm ? analysis.dimensions_mm : null),
    files,
    estimate: publicEstimate(p?.estimate),
    hash: await factsHash(facts),
  };
}

/**
 * RECORD THE REQUEST'S CURRENT REVISION. The revision number is read from the
 * request INSIDE the statement, so the row always lands on the revision the
 * same batch left the request at — a bump earlier in the batch makes this a
 * new row; no bump makes it an in-place rewrite of the current one.
 */
export function recordRevisionStatement(
  db: D1Database,
  requestId: string,
  snap: RevisionSnapshot,
  reason: 'publish' | 'edit' | 'files',
  userId: string | null,
  ts: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO community_request_revisions
         (id, request_id, revision, spec, files, estimate, hash, reason, created_by, created_at)
       SELECT 'crv_' || r.id || '_' || r.revision, r.id, r.revision, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         FROM community_requests r WHERE r.id = ?1 AND r.state <> 'draft'
       ON CONFLICT (request_id, revision) DO UPDATE SET
         spec = excluded.spec, files = excluded.files, estimate = excluded.estimate,
         hash = excluded.hash, reason = excluded.reason, created_at = excluded.created_at`
    )
    .bind(
      requestId,
      JSON.stringify(snap.spec),
      JSON.stringify(snap.files),
      JSON.stringify(snap.estimate),
      snap.hash,
      reason,
      userId,
      ts
    );
}

/**
 * THE REVISION MOVES ONLY WHEN SOMEBODY PRICED THE CURRENT ONE. An SQL
 * expression for a `SET revision = …` inside an UPDATE of community_requests:
 * `?changed` is 1 when the priced facts changed. Evaluated in the write, so
 * an offer inserted a moment before it is counted.
 */
export const bumpRevisionIfOfferedSql = (changedParam: string) =>
  `CASE WHEN ${changedParam} = 1 AND EXISTS (
          SELECT 1 FROM community_offers o
           WHERE o.request_id = community_requests.id AND o.state = 'pending'
             AND o.request_revision = community_requests.revision)
        THEN revision + 1 ELSE revision END`;

/**
 * An attachment changed on a PUBLISHED job: a new revision if it has a pending
 * offer on the current one (which is now superseded), else nothing — the
 * snapshot is rewritten in place by `recordRevisionStatement` after it.
 */
export function reviseIfOfferedStatement(db: D1Database, requestId: string, ts: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE community_requests SET revision = revision + 1, updated_at = ?2
        WHERE id = ?1 AND state IN ('open','receiving_offers')
          AND EXISTS (SELECT 1 FROM community_offers o
                       WHERE o.request_id = ?1 AND o.state = 'pending'
                         AND o.request_revision = community_requests.revision)`
    )
    .bind(requestId, ts);
}

/**
 * EVERY PENDING OFFER THAT PRICED AN OLDER REVISION IS SUPERSEDED — in the same
 * batch as the change that made it old. `updated_at = ts` is the mark the
 * notifications read (`supersededNoticeStatements`), so a merchant is told
 * about the change that superseded them, once.
 */
export function supersedeStatement(db: D1Database, requestId: string, ts: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE community_offers SET state = 'superseded', updated_at = ?2
        WHERE request_id = ?1 AND state = 'pending'
          AND request_revision < (SELECT r.revision FROM community_requests r WHERE r.id = ?1)`
    )
    .bind(requestId, ts);
}

/**
 * THE OFFER'S TERMS AT THIS REVISION, appended (never updated) in the same
 * batch as the write that made the revision. Read back from the offer row
 * itself, so what is recorded is what was written.
 */
export function recordOfferRevisionStatement(
  db: D1Database,
  offerId: string,
  reason: 'create' | 'edit' | 'reconfirm'
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO community_offer_revisions
         (id, offer_id, revision, request_revision, price_iqd, terms, reason, created_at)
       SELECT 'cor_' || o.id || '_' || o.revision, o.id, o.revision, o.request_revision, o.price_iqd,
              json_object('completion_days', o.completion_days, 'delivery_method', o.delivery_method,
                          'materials', o.materials, 'material_ids', json(o.material_ids),
                          'included', o.included, 'warranty_terms', o.warranty_terms,
                          'message', o.message, 'expires_at', o.expires_at),
              ?2, o.updated_at
         FROM community_offers o WHERE o.id = ?1`
    )
    .bind(offerId, reason);
}

// ------------------------------------------------------------------- contact

export interface ContactSnapshot {
  /** What the MERCHANT receives: how to reach and deliver to the customer. */
  customer: {
    name: string;
    phone: string;
    governorate: string;
    area: string;
    address: string;
    landmark: string;
    address_notes: string;
  };
  /** What the CUSTOMER receives: how to reach the merchant. */
  merchant: {
    name: string;
    store_name: string;
    store_slug: string;
    phone: string;
    governorate: string;
  };
  delivery_method: string;
  captured_at: string;
}

/**
 * WHO THE TWO SIDES BECOME TO EACH OTHER AT ACCEPTANCE (§4.7). Read now and
 * frozen onto the order, so a later edit of an address does not rewrite a
 * delivery already promised. The customer's address is the one they chose in
 * the acceptance sheet (`addressId`, which must be theirs) or their default;
 * for a pickup job only their name and phone travel. Returns `null` for a
 * named address that is not the customer's — the caller refuses.
 */
export async function contactSnapshot(
  db: D1Database,
  p: { customerId: string; merchantId: string; storeId: string | null; addressId: string | null; deliveryMethod: string; ts: string }
): Promise<ContactSnapshot | null> {
  const [user, address, merchant] = await Promise.all([
    db.prepare('SELECT name, phone_e164 FROM users WHERE id = ?').bind(p.customerId).first<{ name: string; phone_e164: string | null }>(),
    p.addressId
      ? db
          .prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
          .bind(p.addressId, p.customerId)
          .first<Record<string, unknown>>()
      : db
          .prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC LIMIT 1')
          .bind(p.customerId)
          .first<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT m.name, m.phone, m.governorate, s.name AS store_name, s.slug, s.contact_phone, s.governorate AS store_governorate
           FROM community_merchants m LEFT JOIN merchant_stores s ON s.merchant_id = m.id
          WHERE m.id = ?`
      )
      .bind(p.merchantId)
      .first<Record<string, unknown>>(),
  ]);
  if (p.addressId && !address) return null;
  const pickup = p.deliveryMethod === 'pickup';
  const a = address ?? {};
  return {
    customer: {
      name: String(a.name || user?.name || ''),
      phone: String(a.phone || user?.phone_e164 || ''),
      governorate: String(a.governorate ?? ''),
      area: pickup ? '' : String(a.area ?? ''),
      address: pickup ? '' : String(a.address ?? ''),
      landmark: pickup ? '' : String(a.landmark ?? ''),
      address_notes: pickup ? '' : String(a.notes ?? ''),
    },
    merchant: {
      name: String(merchant?.name ?? ''),
      store_name: String(merchant?.store_name ?? merchant?.name ?? ''),
      store_slug: String(merchant?.slug ?? ''),
      phone: String(merchant?.contact_phone || merchant?.phone || ''),
      governorate: String(merchant?.store_governorate || merchant?.governorate || ''),
    },
    delivery_method: p.deliveryMethod,
    captured_at: p.ts,
  };
}

/** Each side sees the OTHER side's contact, and only after acceptance. */
export function contactFor(role: 'customer' | 'merchant', raw: unknown): Record<string, unknown> | null {
  const c = safeParse<Partial<ContactSnapshot>>(raw, {});
  if (!c || !c.customer || !c.merchant) return null;
  return role === 'merchant'
    ? { ...c.customer, delivery_method: c.delivery_method ?? '' }
    : { ...c.merchant, delivery_method: c.delivery_method ?? '' };
}
