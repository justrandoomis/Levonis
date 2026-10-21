/**
 * WHAT AN OFFER COVERS, AND WHAT IT SUBSTITUTES (plan P1-05, docs/
 * DECISIONS.md row 267; migration 0208 `coverage_json`, `substitutions_json`,
 * `covers_all` on `community_offers`).
 *
 * COVERAGE names the parts of the request an offer makes. None named — or
 * every part named — is the whole request: stored as NULL with
 * `covers_all = 1`, exactly the row every offer before P1-05 is. Some parts is
 * `{"parts":[ids in the request's order]}` with `covers_all = 0`: a PARTIAL
 * offer, which the customer accepts only by saying so (`accept_partial`), and
 * whose acceptance closes the request (C12: one accepted offer).
 *
 * A SUBSTITUTION proposes another material, or other colours, for one
 * material row of a covered part. Its `from` is never the merchant's word: it
 * is read here from the request's model AT ITS CURRENT REVISION (the revision
 * row's spec, the source the order's snapshot is built from), so the customer
 * is shown «PETG بدل TPU» against what they really asked. The customer
 * accepts a substituted offer only by saying so (`accept_substitutions`).
 *
 * WHAT IS REFUSED, AND HOW (codes in packages/contracts/src/requestModel.ts,
 * words in src/lib/refusalStrings.ts):
 *
 *   OFFER_COVERAGE_INVALID       no part named, a part the request does not
 *                                have (or no longer has), a part named twice,
 *                                a «whole» offer on a request that gained a
 *                                part since (detail `added`), or coverage on a
 *                                chat or direct request
 *   OFFER_SUBSTITUTION_INVALID   a part the offer does not cover, a row that is
 *                                not in it, a material the customer left open
 *                                (choosing one is not a substitution), colours
 *                                that were all «any», a material outside the
 *                                active catalogue or of another technology, a
 *                                change that changes nothing, two on one row,
 *                                or a part written as free text
 *   OFFER_PART_NOT_ELIGIBLE      a covered part this workshop cannot make as
 *                                it would be made: with its substitution when
 *                                it carries one (capability and stock, its
 *                                colours counted again), else as asked (a
 *                                one-job request: its substitution);
 *                                `details.substitute` when the part itself
 *                                could be made as asked
 *   OFFER_COVERAGE_UNAVAILABLE   coverage or substitutions named on a database
 *                                before 0208
 *
 * Every offer write on a BOARD request — a new offer, a sent draft, an edit
 * or a re-confirm — is fenced on the hash of the revision it read before its checks
 * (`revisionHead`, or the model the coverage was resolved on;
 * `revisionHashFence`), a whole offer on a one-job request too, so a part
 * checked against one version of the request is never stored against
 * another, and never covered by a price set without it (critiques 3 and 4;
 * P1-05 review 5). A re-confirm on a DIRECT request (0151) reads no model and
 * covers no part: it is not fenced, as before P1-05 (P1-05 review 6).
 */
import { HttpError } from './http';
import { safeParse } from './types';
import { OFFER_LIMITS } from '@levonis/contracts/requestModel';
import { modelOfSpec, type ModelColour, type ModelMaterial, type ModelPart, type ModelState } from './requestModel';
import type { RevisionFile } from './requestRevisions';
import { evaluatePart, type CatalogueMaterial, type EligibilityPart } from './eligibility';
import type { LiveVerdict } from './printMatchingStore';

// ------------------------------------------------------------------ shapes

export interface SubColour {
  hex: string;
  label: string;
  /**
   * A colour the customer left open: «any colour» or «as in the reference»
   * (P1-05 review 5). No hex and no label; a merchant never names one. It is
   * carried on both sides of a substitution, so a material-only substitute
   * keeps every colour asked: it is counted (MULTICOLOR), kept in the
   * agreement and shown on both sides.
   */
  mode?: 'any' | 'as_reference';
}

export interface OfferSubstitution {
  part_id: string;
  material_row_id: string;
  /** What the customer asked, read from the request — never from the body. */
  from: { material_id: string; colors: SubColour[] };
  /** What the merchant proposes. An absent side is the same as `from`. */
  to: { material_id: string; colors: SubColour[] };
  note: string;
}

export interface OfferCoverageTerms {
  /** null = the whole request. */
  parts: string[] | null;
  substitutions: OfferSubstitution[];
}

export const DEFAULT_COVERAGE: OfferCoverageTerms = Object.freeze({ parts: null, substitutions: [] }) as OfferCoverageTerms;

export const isDefaultCoverage = (t: OfferCoverageTerms): boolean => t.parts === null && t.substitutions.length === 0;

/**
 * What a body names, shape-checked only: `undefined` = not named. `coverage:
 * null` names the whole request and `substitutions: []` names none — an edit
 * that takes a partial offer back to whole, or a substitution back out, says
 * so; and a default never needs the 0208 columns (critique High 4).
 */
export interface CoverageBody {
  coverage?: string[] | null;
  substitutions?: Array<{
    part_id: string;
    material_row_id: string;
    to: { material_id?: string; colors?: SubColour[] };
    note: string;
    /**
     * The source it was proposed against. Set by the server only (a stored
     * offer, a saved draft), never read from a body: when the customer has
     * changed that material since, the substitution is refused.
     */
    was?: OfferSubstitution['from'];
  }>;
}

/** The request as an offer is checked against: its current revision and the model that revision recorded. */
export interface RevisionModel {
  revision: number;
  /** The revision row's hash ('' when the request has no revision row). */
  hash: string;
  model: Pick<ModelState, 'parts' | 'sources'>;
  /** A chat or direct request (no print row, free text): nothing can be covered by part. */
  legacy: boolean;
}

const HEX6 = /^#[0-9a-f]{6}$/;
const s = (x: unknown) => (x === null || x === undefined ? '' : String(x));
const invalidCoverage = (message: string, details?: Record<string, unknown>) =>
  new HttpError(400, message, 'OFFER_COVERAGE_INVALID', details);
const invalidSubstitution = (message: string, details?: Record<string, unknown>) =>
  new HttpError(400, message, 'OFFER_SUBSTITUTION_INVALID', details);

// ------------------------------------------------------------ the body

function readColours(raw: unknown): SubColour[] {
  if (!Array.isArray(raw)) throw invalidSubstitution('Colours must be a list');
  if (raw.length > 16) throw invalidSubstitution('At most 16 colours');
  return raw.map((c) => {
    const o = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
    const hex = s(o.hex).trim().toLowerCase();
    const label = s(o.label).trim().slice(0, 60);
    if (hex && !HEX6.test(hex)) throw invalidSubstitution('A colour is a #rrggbb hex');
    if (!hex && !label) throw invalidSubstitution('Name the colour or give its hex');
    return { hex, label };
  });
}

/**
 * THE BODY'S COVERAGE AND SUBSTITUTIONS, shape only. The defaults written
 * out (`coverage: null`, `substitutions: []`) resolve to the default, which
 * an older database never refuses as unavailable (critique High 4).
 */
export function readCoverageBody(body: Record<string, unknown>): CoverageBody {
  const out: CoverageBody = {};
  if (body.coverage === null) out.coverage = null;
  else if (body.coverage !== undefined) {
    const raw = body.coverage as Record<string, unknown> | unknown[];
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as Record<string, unknown>).parts : undefined;
    if (!Array.isArray(list)) throw invalidCoverage('coverage is { parts: [part ids] }');
    if (list.length > 64) throw invalidCoverage('Too many parts');
    out.coverage = list.map((x) => s(x).slice(0, 80));
  }
  if (body.substitutions !== undefined && body.substitutions !== null) {
    if (!Array.isArray(body.substitutions)) throw invalidSubstitution('substitutions must be a list');
    if (body.substitutions.length > OFFER_LIMITS.substitutionsMax) throw invalidSubstitution('Too many substitutions');
    out.substitutions = body.substitutions.map((x) => {
      const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
      const to = o.to && typeof o.to === 'object' ? (o.to as Record<string, unknown>) : {};
      const note = s(o.note).trim();
      if (note.length > OFFER_LIMITS.substitutionNoteMax) throw invalidSubstitution(`A note is at most ${OFFER_LIMITS.substitutionNoteMax} characters`);
      return {
        part_id: s(o.part_id).slice(0, 80),
        material_row_id: s(o.material_row_id).slice(0, 80),
        to: {
          ...(to.material_id !== undefined && to.material_id !== null && to.material_id !== '' ? { material_id: s(to.material_id).slice(0, 60) } : {}),
          ...(to.colors !== undefined && to.colors !== null ? { colors: readColours(to.colors) } : {}),
        },
        note,
      };
    });
  }
  return out;
}

export const namesCoverage = (b: CoverageBody): boolean => b.coverage !== undefined || b.substitutions !== undefined;

// ------------------------------------------------------- against the model

const isNamedColour = (c: { mode: string }) => c.mode === 'catalogue' || c.mode === 'custom';

const specificColours = (m: Pick<ModelMaterial, 'colors'>): SubColour[] =>
  m.colors.filter(isNamedColour).map((c) => ({ hex: s(c.hex).toLowerCase(), label: s(c.label) }));

/**
 * EVERY COLOUR ENTRY OF A ROW, in its order (P1-05 review 5): a named colour
 * as its hex and label, «any» and «as in the reference» by their mode. A
 * substitution's `from` is this, so nothing the customer asked is dropped.
 */
const rowColours = (m: Pick<ModelMaterial, 'colors'>): SubColour[] =>
  m.colors.map((c) => (isNamedColour(c)
    ? { hex: s(c.hex).toLowerCase(), label: s(c.label) }
    : { hex: '', label: '', mode: c.mode === 'as_reference' ? ('as_reference' as const) : ('any' as const) }));

/** The colours a merchant named (a side without the entries the customer left open). */
const namedOf = (cs: ReadonlyArray<SubColour>): SubColour[] => cs.filter((c) => !c.mode).map((c) => ({ hex: c.hex, label: c.label }));

const sameColours = (a: SubColour[], b: SubColour[]) => JSON.stringify(a) === JSON.stringify(b);

const fromOf = (row: ModelMaterial) => ({ material_id: row.material_id, colors: rowColours(row) });

const ordered = (m: Pick<ModelState, 'parts'>) => [...m.parts].sort((a, b) => a.position - b.position);

/**
 * THE COVERAGE AND SUBSTITUTIONS AS STORED, checked against the request as
 * it now is. `body` names what changes; `stored` (an edit, a re-confirm) is
 * what the offer held. `mats` is the print-material catalogue (id, process,
 * active).
 */
export function resolveCoverage(
  body: CoverageBody,
  rm: RevisionModel,
  mats: ReadonlyArray<{ id: string; process: string; active?: boolean }>,
  stored: OfferCoverageTerms = DEFAULT_COVERAGE
): OfferCoverageTerms {
  const parts = ordered(rm.model);
  const ids = parts.map((p) => p.id);
  let covered: string[] | null = body.coverage !== undefined ? body.coverage ?? null : stored.parts;
  if (covered !== null) {
    if (rm.legacy) throw invalidCoverage('This request is not made of parts');
    if (!covered.length) throw invalidCoverage('Choose at least one part of this request');
    if (new Set(covered).size !== covered.length) throw invalidCoverage('A part is named twice', { part_id: covered.find((x, i) => covered!.indexOf(x) !== i) });
    const gone = covered.filter((id) => !ids.includes(id));
    if (gone.length) throw invalidCoverage('A chosen part is not on this request as it now is', { parts: gone });
    // Every part is the whole request: stored as the default.
    covered = ids.every((id) => covered!.includes(id)) ? null : ids.filter((id) => covered!.includes(id));
  }
  const coversPart = (id: string) => covered === null || covered.includes(id);

  const raw = body.substitutions !== undefined
    ? body.substitutions
    : stored.substitutions.map((x) => ({ part_id: x.part_id, material_row_id: x.material_row_id, to: { material_id: x.to.material_id, colors: x.to.colors }, note: x.note, was: x.from }));
  const seen = new Set<string>();
  const subs: OfferSubstitution[] = [];
  for (const x of raw ?? []) {
    const at = { part_id: x.part_id, material_row_id: x.material_row_id };
    if (rm.legacy) throw invalidSubstitution('This request is not made of parts', at);
    const part = parts.find((p) => p.id === x.part_id);
    if (!part || !coversPart(part.id)) throw invalidSubstitution('That part is not covered by this offer', at);
    if (part.legacy_text) throw invalidSubstitution('That part is written as free text', at);
    const row = part.materials.find((m) => m.id === x.material_row_id);
    if (!row) throw invalidSubstitution('That material is not in the part', at);
    if (seen.has(row.id)) throw invalidSubstitution('One substitution per material', at);
    seen.add(row.id);
    if (row.material_unsure || !row.material_id) throw invalidSubstitution('The customer left this material open: choosing one is not a substitution', at);
    const from = fromOf(row);
    // A re-read of a stored substitution whose source moved is not carried (critique 4).
    const was = x.was;
    if (was && (was.material_id !== from.material_id || !sameColours(was.colors, from.colors))) {
      throw invalidSubstitution('The customer changed this material since — propose the substitute again', at);
    }
    const partProcess = part.process || mats.find((m) => m.id === from.material_id)?.process || '';
    const toId = x.to.material_id ?? from.material_id;
    const toMat = mats.find((m) => m.id === toId && m.active !== false);
    if (!toMat) throw invalidSubstitution('Choose a material from the catalogue', at);
    if (partProcess && toMat.process !== partProcess) throw invalidSubstitution('The substitute must be of the same technology as the part', at);
    // What the merchant names replaces the colours the customer named; the
    // entries left open (any, as in the reference) stay on both sides
    // (P1-05 review 5). A stored side is read back without them.
    const named = namedOf(x.to.colors ?? []);
    const asked = specificColours(row);
    if (named.length && !asked.length) {
      throw invalidSubstitution('The customer asked for any colour here: there is no colour to substitute', at);
    }
    const toColours = named.length && !sameColours(named, asked) ? [...named, ...from.colors.filter((c) => c.mode)] : from.colors;
    if (toId === from.material_id && sameColours(toColours, from.colors)) throw invalidSubstitution('That substitute changes nothing', at);
    subs.push({ part_id: part.id, material_row_id: row.id, from, to: { material_id: toId, colors: toColours }, note: x.note });
  }
  // In the request's order, so two offers with the same terms store the same bytes.
  subs.sort((a, b) => ids.indexOf(a.part_id) - ids.indexOf(b.part_id) || a.material_row_id.localeCompare(b.material_row_id));
  return { parts: covered, substitutions: subs };
}

/**
 * A «WHOLE» OFFER NEVER STRETCHES OVER A PART ITS MERCHANT NEVER SAW
 * (critique 4): re-confirming or editing a superseded offer that covered the
 * whole request, when the request gained a part since the revision it priced,
 * is refused with the parts added — the merchant names its coverage again.
 */
export function assertNoAddedParts(stored: OfferCoverageTerms, before: Pick<ModelState, 'parts'> | null, now: RevisionModel, bodyNamesCoverage: boolean): void {
  if (stored.parts !== null || bodyNamesCoverage || !before) return;
  // More parts than the merchant priced. A part EDITED in place (a new id for
  // new content) is the ordinary re-confirm a v1 job always had.
  if (now.model.parts.length <= before.parts.length) return;
  const had = new Set(before.parts.map((p) => p.id));
  const added = ordered(now.model).filter((p) => !had.has(p.id)).map((p) => p.id);
  throw invalidCoverage('This request has new parts since your offer — choose the parts your offer covers', { added });
}

// ----------------------------------------------------------- the columns

export interface CoverageColumns {
  coverage_json: string | null;
  substitutions_json: string;
  covers_all: 0 | 1;
}

export function coverageColumns(t: OfferCoverageTerms): CoverageColumns {
  return {
    coverage_json: t.parts === null ? null : JSON.stringify({ parts: t.parts }),
    substitutions_json: JSON.stringify(t.substitutions),
    covers_all: t.parts === null ? 1 : 0,
  };
}

/**
 * AN OFFER ROW'S TERMS, read tolerantly: a database before 0208 has no
 * columns (the whole request, nothing substituted); a substitutions column
 * that is not a list reads as `unreadable` — acceptance then fails closed.
 */
export function storedCoverage(o: Record<string, unknown>): OfferCoverageTerms & { unreadable: boolean } {
  const partial = Number(o.covers_all ?? 1) === 0;
  const cov = safeParse<{ parts?: unknown } | null>(o.coverage_json, null);
  const parts = partial && cov && Array.isArray(cov.parts) ? cov.parts.map(String) : partial ? [] : null;
  if (o.substitutions_json === undefined || o.substitutions_json === null) return { parts, substitutions: [], unreadable: false };
  let subs: unknown;
  try {
    subs = JSON.parse(String(o.substitutions_json));
  } catch {
    return { parts, substitutions: [], unreadable: true };
  }
  if (!Array.isArray(subs)) return { parts, substitutions: [], unreadable: true };
  return { parts, substitutions: subs as OfferSubstitution[], unreadable: false };
}

/** What every reader of an offer gets: covers all or which parts, and the substitutions. */
export function offerCoverageShape(o: Record<string, unknown>): { coverage: { covers_all: boolean; parts: string[] | null }; substitutions: OfferSubstitution[] } {
  const t = storedCoverage(o);
  return { coverage: { covers_all: t.parts === null, parts: t.parts }, substitutions: t.substitutions };
}

// ---------------------------------------------------------- the database

/**
 * THE REQUEST AT ITS CURRENT REVISION: the revision row's hash and the model
 * its spec recorded (a v1 spec: the request's own one part, as it reads now),
 * or — a request older than revision rows — the model as it reads now.
 */
export async function loadRevisionModel(
  db: D1Database,
  requestId: string,
  live: () => Promise<Pick<ModelState, 'parts' | 'sources'> | null>
): Promise<RevisionModel | null> {
  const row = await db
    .prepare(
      `SELECT r.revision, v.spec, v.files, v.hash,
              EXISTS (SELECT 1 FROM community_print_requests p WHERE p.request_id = r.id) AS has_print
         FROM community_requests r
         LEFT JOIN community_request_revisions v ON v.request_id = r.id AND v.revision = r.revision
        WHERE r.id = ?`
    )
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const legacy = Number(row.has_print ?? 0) !== 1;
  if (row.spec === null || row.spec === undefined) {
    const m = await live();
    return m ? { revision: Number(row.revision ?? 1), hash: '', model: m, legacy } : null;
  }
  const spec = safeParse<Record<string, unknown>>(row.spec, {}) ?? {};
  const files = safeParse<RevisionFile[]>(row.files, []) ?? [];
  // A v1 revision records no model: its one part is the request's own
  // synthesised part (`rpt_<request>_1`, the ids every reader shows), which a
  // v1 request's current revision always describes.
  const model = spec.model && typeof spec.model === 'object' ? modelOfSpec(spec, files) : ((await live()) ?? modelOfSpec(spec, files));
  return { revision: Number(row.revision ?? 1), hash: String(row.hash ?? ''), model, legacy };
}

/** The model a past revision recorded, for «what did this offer see» (null when there is no such row). */
export async function modelAtRevision(db: D1Database, requestId: string, revision: number): Promise<Pick<ModelState, 'parts' | 'sources'> | null> {
  const row = await db
    .prepare('SELECT spec, files FROM community_request_revisions WHERE request_id = ? AND revision = ?')
    .bind(requestId, revision)
    .first<{ spec: string; files: string }>();
  if (!row) return null;
  return modelOfSpec(safeParse<Record<string, unknown>>(row.spec, {}) ?? {}, safeParse<RevisionFile[]>(row.files, []) ?? []);
}

/**
 * THE REQUEST'S CURRENT REVISION, ITS NUMBER AND HASH — one read, no model
 * (P1-05 review 5). Every offer write fences on it, a one-job request's too:
 * read before the checks, so a part the customer adds after them is never
 * covered by a price set without it. Null for a request that is gone; the
 * hash is '' for one older than revision rows.
 */
export async function revisionHead(db: D1Database, requestId: string): Promise<{ revision: number; hash: string } | null> {
  const row = await db
    .prepare(
      `SELECT q.revision AS revision,
              (SELECT h.hash FROM community_request_revisions h WHERE h.request_id = q.id AND h.revision = q.revision) AS hash
         FROM community_requests q WHERE q.id = ?`
    )
    .bind(requestId)
    .first<{ revision: number | null; hash: string | null }>();
  return row ? { revision: Number(row.revision ?? 1), hash: String(row.hash ?? '') } : null;
}

/**
 * THE FENCE (critique 3a): for the offer's batch, before its INSERT or
 * UPDATE. The request's `updated_at` goes NULL — the batch aborts, nothing is
 * written — unless the current revision still has the hash the coverage was
 * checked against. A customer edit that rewrote that revision in place moves
 * its hash.
 */
export function revisionHashFence(db: D1Database, requestId: string, hash: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE community_requests
          SET updated_at = CASE WHEN (SELECT v.hash FROM community_request_revisions v
                                       WHERE v.request_id = ?1 AND v.revision = community_requests.revision) IS ?2
                                THEN updated_at ELSE NULL END
        WHERE id = ?1`
    )
    .bind(requestId, hash || null);
}

/** The fence above aborted the batch (and nothing else did). */
export const isRevisionFenceAbort = (e: unknown): boolean =>
  /NOT NULL constraint failed: community_requests\.updated_at/i.test(e instanceof Error ? e.message : String(e));

// --------------------------------------------------------- eligibility

/** The colours a substituted row is made in: those the substitute names (else the ones asked), and every entry the customer left open. */
const swappedCount = (row: Pick<ModelMaterial, 'colors'>, sub: OfferSubstitution): number => {
  const named = namedOf(sub.to.colors);
  return (named.length ? named.length : row.colors.filter(isNamedColour).length) + row.colors.filter((c) => !isNamedColour(c)).length;
};

/**
 * THE COLOURS A SUBSTITUTED ROW IS STOCKED IN (P1-05 review 6): each hex; a
 * colour the merchant NAMED without one (a label only, as an older composer
 * sent it) stands as a key no stock line holds, so a workshop that tracks its
 * colours has it only on a line whose colour is not tracked and is refused
 * STOCK_COLOR otherwise, exactly as for a hex it does not hold. A colour the
 * customer asked keeps the as-asked reading (a hex, else not judged), so a
 * material-only substitute is judged on the colours as the part itself is.
 */
const stockColours = (sub: OfferSubstitution): string[] => {
  const asked = new Set(namedOf(sub.from.colors).map((c) => `${c.hex}|${c.label}`));
  return namedOf(sub.to.colors).flatMap((c) =>
    HEX6.test(c.hex) ? [c.hex] : asked.has(`${c.hex}|${c.label}`) ? [] : [`label:${c.label.trim().toLowerCase()}`]
  );
};

/**
 * A PART AS IT WOULD BE MADE: each substituted row in its substitute's
 * material and colours, and the colours laid down in one print counted again
 * (P1-05 review 4). A substitute that turns one colour into four asks for a
 * machine that lays down four; the as-asked count would let a single-colour
 * printer commit to it. `rows` are the model's rows of the part, in the order
 * of `p.materials`: a row not substituted keeps its own colour entries. With
 * no rows to count, the larger of the as-asked count and the substitutes'.
 */
const toEligibilityPart = (p: EligibilityPart, subs: Array<OfferSubstitution | undefined>, rows?: ReadonlyArray<Pick<ModelMaterial, 'colors'>>): EligibilityPart => {
  // A substituted row counts the colours its substitute names, or the ones
  // asked when it names none, AND the entries the customer left open — «any»
  // and «as in the reference» are colours the print still lays down (P1-05
  // review 5): a material-only substitute counts exactly what was asked.
  const counted = rows && rows.length === p.materials.length
    ? rows.reduce((n, row, i) => n + (subs[i] ? swappedCount(row, subs[i]!) : row.colors.length), 0)
    : Math.max(p.colors_count, p.colors_count + subs.reduce((n, x) => n + (x ? namedOf(x.to.colors).length - namedOf(x.from.colors).length : 0), 0));
  return {
    ...p,
    materials: p.materials.map((row, i) => {
      const sub = subs[i];
      if (!sub) return row;
      return { material_id: sub.to.material_id, colours: stockColours(sub) };
    }),
    colors_count: Math.max(1, counted),
  };
};

/**
 * A REQUEST THE MATCHER READS AS ONE JOB (no `parts` on the live facts), as
 * the part each substitution names: the request's own process, size and
 * grams, in the substitute's material and colours — the request's colour
 * count moved by what the substitute changes (P1-05 review 5): a
 * material-only substitute is counted on every colour asked (a v1 job of two
 * colours, one of them named, stays two), one that turns one named colour
 * into two counts one more. The job as asked was judged whole by the request-level
 * verdict; what a substitution changes is judged here, so the one-job path
 * asks the same question as a job of parts. One job has one material row, so
 * the substitution needs no row of the model to stand on (a v1 revision
 * names its part by another id).
 */
function oneJobSwapped(req: LiveVerdict['request'], terms: OfferCoverageTerms): EligibilityPart[] {
  const byPart = new Map<string, OfferSubstitution[]>();
  for (const x of terms.substitutions) byPart.set(x.part_id, [...(byPart.get(x.part_id) ?? []), x]);
  return [...byPart].map(([id, subs]) => {
    const moved = subs.reduce((n, x) => {
      const named = namedOf(x.to.colors).length;
      return n + (named ? named - namedOf(x.from.colors).length : 0);
    }, 0);
    return {
      id,
      process: req.process,
      materials: subs.map((x) => ({ material_id: x.to.material_id, colours: stockColours(x) })),
      colors_count: Math.max(1, req.colors_count + moved),
      dims_mm: req.dims_mm,
      grams: req.grams,
    };
  });
}

/**
 * A SUBSTITUTE IS JUDGED ON WHAT THE WORKSHOP CAN DO (P1-05 review 4):
 * capability and stock. Its own preferences narrow what it is shown and told
 * about; a merchant who proposes a material has chosen it, so a preference
 * that leaves it out does not refuse the offer.
 */
const substituteVerdict = (v: ReturnType<typeof evaluatePart>): { eligible: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  if (v.capability) reasons.push(v.capability);
  if (v.stock) reasons.push(v.stock);
  return { eligible: reasons.length === 0, reasons };
};

/** The first covered part this workshop cannot make, its reasons, and whether the substitute is the cause. */
export interface UncoverablePart {
  part_id: string;
  position: number;
  reasons: string[];
  /** The part can be made as asked: the substitute it carries is what fails (the merchant changes or drops it). */
  substitute?: true;
}

/**
 * THE COVERED PARTS THIS WORKSHOP CAN MAKE (D5) — the first that it cannot,
 * with its reasons, or null. What gets made is what is judged: a part that
 * carries a substitution is judged WITH it, whatever its verdict as asked (a
 * workshop never commits to a material none of its printers runs, nor to
 * more colours than they lay down), on capability and stock; any other
 * covered part, as asked. On a request the matcher reads as one job the
 * request-level verdict judged the job as asked, so only its substitutions
 * are judged here. `substitute` marks a part that could be made as asked, so
 * the merchant hears that the substitute is the problem, not the part.
 */
export function uncoverableParts(
  live: Pick<LiveVerdict, 'candidate' | 'request' | 'catalogue'>,
  terms: OfferCoverageTerms,
  model: Pick<ModelState, 'parts'>
): UncoverablePart | null {
  const catalogue = live.catalogue as ReadonlyMap<string, CatalogueMaterial>;
  const parts = live.request.parts;
  if (!parts || !parts.length) {
    for (const part of oneJobSwapped(live.request, terms)) {
      const swapped = substituteVerdict(evaluatePart(live.candidate, live.request, part, catalogue));
      if (swapped.eligible) continue;
      return { part_id: part.id, position: model.parts.find((x) => x.id === part.id)?.position ?? 0, reasons: swapped.reasons, substitute: true };
    }
    return null;
  }
  for (const part of parts) {
    if (terms.parts !== null && !terms.parts.includes(part.id)) continue;
    const mp = model.parts.find((x) => x.id === part.id);
    const rows = mp?.materials ?? [];
    const subsByRow = rows.map((row) => terms.substitutions.find((x) => x.part_id === part.id && x.material_row_id === row.id));
    const position = mp?.position ?? parts.indexOf(part);
    if (subsByRow.some(Boolean)) {
      const swapped = substituteVerdict(evaluatePart(live.candidate, live.request, toEligibilityPart(part, subsByRow, rows), catalogue));
      if (swapped.eligible) continue;
      // The part as asked, on the same two counts: when it passes, the substitute is the cause.
      const asked = substituteVerdict(evaluatePart(live.candidate, live.request, part, catalogue));
      return { part_id: part.id, position, reasons: swapped.reasons, ...(asked.eligible ? { substitute: true as const } : {}) };
    }
    const verdict = evaluatePart(live.candidate, live.request, part, catalogue);
    if (verdict.eligible) continue;
    return { part_id: part.id, position, reasons: verdict.reasons };
  }
  return null;
}

/** The terms carry something the request-level verdict did not judge: a job of parts, or a substitution. */
export const coverageNeedsPartCheck = (live: Pick<LiveVerdict, 'request'>, terms: Pick<OfferCoverageTerms, 'substitutions'>): boolean =>
  !!live.request.parts?.length || terms.substitutions.length > 0;

export function assertCoverageEligible(
  live: Pick<LiveVerdict, 'candidate' | 'request' | 'catalogue'>,
  terms: OfferCoverageTerms,
  model: Pick<ModelState, 'parts'>
): void {
  const bad = uncoverableParts(live, terms, model);
  if (!bad) return;
  if (bad.substitute) {
    throw new HttpError(
      403,
      'Your workshop cannot make the substitute proposed for this part — choose a material your printers run, or drop the substitute',
      'OFFER_PART_NOT_ELIGIBLE',
      { ...bad }
    );
  }
  throw new HttpError(403, 'Your workshop cannot make one of the chosen parts — remove it from the offer', 'OFFER_PART_NOT_ELIGIBLE', { ...bad });
}

// ---------------------------------------------------------- the snapshot

const asAgreed = (c: Pick<ModelColour, 'mode' | 'hex' | 'label'>) => ({ mode: c.mode, hex: c.hex, label: c.label });

/**
 * THE COLOURS AGREED FOR A ROW (P1-05 review 5): a material-only substitute
 * keeps every entry asked, as asked — «any» and «as in the reference»
 * included; one that names colours puts them in place of the named colours
 * asked and keeps the entries the customer left open.
 */
const agreedColours = (row: ModelMaterial, sub: OfferSubstitution) => {
  const named = namedOf(sub.to.colors);
  if (!named.length || sameColours(named, specificColours(row))) return row.colors.map(asAgreed);
  return [
    ...named.map((c) => ({ mode: 'custom', hex: c.hex, label: c.label })),
    ...row.colors.filter((c) => !isNamedColour(c)).map(asAgreed),
  ];
};

const agreedMaterial = (row: ModelMaterial, sub: OfferSubstitution | undefined) => ({
  id: row.id,
  material_id: sub ? sub.to.material_id : row.material_id,
  material_unsure: sub ? false : row.material_unsure,
  colors: sub ? agreedColours(row, sub) : row.colors.map(asAgreed),
  finish: row.finish,
  substituted: !!sub,
});

/**
 * THE AGREEMENT AN ORDER KEEPS (D7): the parts as agreed (substitutions
 * applied), the parts left out, the substitutions with what they replace, and
 * which acknowledgement the customer gave — only the ones that applied. Built
 * from the revision the offer priced, before any money moves; a covered part
 * or a substituted row that is no longer there, or a `from` that no longer
 * matches, answers null (the caller refuses OFFER_STALE). Never a budget.
 */
export function agreementSnapshot(
  model: Pick<ModelState, 'parts'>,
  terms: OfferCoverageTerms,
  ack: { partial: boolean; substitutions: boolean }
): Record<string, unknown> | null {
  const parts = ordered(model);
  if (terms.parts !== null && terms.parts.some((id) => !parts.some((p) => p.id === id))) return null;
  for (const x of terms.substitutions) {
    const row = parts.find((p) => p.id === x.part_id)?.materials.find((m) => m.id === x.material_row_id);
    if (!row) return null;
    const from = fromOf(row);
    if (from.material_id !== x.from.material_id || !sameColours(from.colors, x.from.colors)) return null;
  }
  const covered = (p: ModelPart) => terms.parts === null || terms.parts.includes(p.id);
  return {
    covers_all: terms.parts === null,
    parts: parts.filter(covered).map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      quantity: p.quantity,
      process: p.process,
      materials: p.materials.map((row) => agreedMaterial(row, terms.substitutions.find((x) => x.part_id === p.id && x.material_row_id === row.id))),
    })),
    uncovered: parts.filter((p) => !covered(p)).map((p) => ({ id: p.id, name: p.name, position: p.position })),
    substitutions: terms.substitutions,
    acknowledged: {
      ...(terms.parts !== null ? { partial: ack.partial } : {}),
      ...(terms.substitutions.length ? { substitutions: ack.substitutions } : {}),
    },
  };
}

/** A coverage refusal a body may name on a database without 0208. */
export const coverageUnavailable = () =>
  new HttpError(503, 'The covered parts and substitutes cannot be saved right now — try again shortly', 'OFFER_COVERAGE_UNAVAILABLE');

