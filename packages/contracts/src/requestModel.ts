/**
 * THE PRINT REQUEST MODEL, V3 — ITS VOCABULARY AND ITS LIMITS (Community V3
 * §4.1–§4.3, plan P1-04, docs/DECISIONS.md row 266; migration 0208).
 *
 * A request is a job made of SOURCES (the files, links and text references it
 * comes from) and PARTS (what is made), each part in one or more MATERIALS,
 * each material in one or more COLOURS. The server (worker/lib/requestModel.ts)
 * and the browser read the same enums and the same limits from here, so the
 * editor cannot offer what the server refuses.
 *
 * The database CHECKs only the stable enums (source kind, role, review state).
 * The open lists — process, finish, colour mode — are checked against this
 * file in code, so a new finish never needs a table rebuild.
 *
 * No imports, no strings: the browser bundles this file as it is. The words
 * for every code live in src/lib/refusalStrings.ts, in Arabic, English and
 * Sorani.
 */

/** The model versions a print row can carry. 1 = the flat v1 row; 3 = sources and parts. */
export const REQUEST_SCHEMA_VERSIONS = [1, 3] as const;
export type RequestSchemaVersion = (typeof REQUEST_SCHEMA_VERSIONS)[number];

/** Where a job comes from. `studio_revision` and `project_post` are always the request's OWN copy (conflict 5). */
export const REQUEST_SOURCE_KINDS = ['file', 'link', 'text_ref', 'studio_revision', 'project_post'] as const;
export type RequestSourceKind = (typeof REQUEST_SOURCE_KINDS)[number];

/** The kinds a customer's body may create. The other two are made only by a server handoff (P1-06, P1-11). */
export const CLIENT_SOURCE_KINDS = ['file', 'link', 'text_ref'] as const;

/** Kinds that always carry a file of the request. */
export const FILE_SOURCE_KINDS = ['file', 'studio_revision', 'project_post'] as const;

/**
 * What a source is FOR. `source` (owner decision Q5) is the editable original:
 * readable by the customer, an admin and the ACCEPTED merchant only — never by
 * a merchant who is merely eligible to offer. '' reads as the kind's default.
 *
 * Only a FILE can be the original (`SOURCE_ROLE_INVALID`): a link or a text
 * reference is public by the registry below. And an original is never what
 * the public job is about — never the main source nor a part's measured model
 * (`SOURCE_ORIGINAL_PRIVATE`), never the v1 row's `primary_file_id` — so no
 * reader who may not open it is priced, matched or costed against it.
 */
export const REQUEST_SOURCE_ROLES = ['', 'production', 'source', 'reference'] as const;
export type RequestSourceRole = (typeof REQUEST_SOURCE_ROLES)[number];

/** The role '' stands for, per kind — so an editor that writes the default explicitly changes nothing. */
export const DEFAULT_SOURCE_ROLE: Readonly<Record<RequestSourceKind, Exclude<RequestSourceRole, ''>>> = {
  file: 'reference',
  link: 'reference',
  text_ref: 'reference',
  studio_revision: 'production',
  project_post: 'production',
};

/** The print processes a part can ask for. '' with `process_unsure` is «لست متأكدًا». */
export const REQUEST_PROCESSES = ['fdm', 'resin'] as const;
export type RequestProcess = (typeof REQUEST_PROCESSES)[number];

/**
 * How a colour is given: any colour, «كما في المرجع» (as a source shows it),
 * a wizard-palette colour, or a custom hex / word. Catalogue and custom are
 * the same priced fact — a colour the customer named — and hash alike.
 */
export const REQUEST_COLOUR_MODES = ['any', 'as_reference', 'catalogue', 'custom'] as const;
export type RequestColourMode = (typeof REQUEST_COLOUR_MODES)[number];

/** The wizard palette: a stable key and its hex. The names, in three languages, live with the screens. */
export const REQUEST_PALETTE: ReadonlyArray<{ key: string; hex: string }> = [
  { key: 'black', hex: '#1a1a1a' },
  { key: 'white', hex: '#f2f2f2' },
  { key: 'grey', hex: '#808080' },
  { key: 'red', hex: '#d32f2f' },
  { key: 'blue', hex: '#1976d2' },
  { key: 'green', hex: '#388e3c' },
  { key: 'yellow', hex: '#fbc02d' },
];

/** The finish a material is delivered in. '' and 'standard' are the same: as printed. */
export const REQUEST_FINISHES = ['standard', 'sanded', 'primed', 'painted', 'polished'] as const;
export type RequestFinish = (typeof REQUEST_FINISHES)[number];

/** A part's technical review. Synthesised from a v1 row it is informational only. */
export const REQUEST_REVIEW_STATES = ['', 'needs_technical_review', 'confirmed'] as const;
export type RequestReviewState = (typeof REQUEST_REVIEW_STATES)[number];

/** Why a part needs a technical look. */
export const REQUEST_REVIEW_REASONS = ['multicolor_unspecified', 'multi_material', 'mixed_process'] as const;
export type RequestReviewReason = (typeof REQUEST_REVIEW_REASONS)[number];

/**
 * THE LIMITS, one table for the editor and the server. Each one is at or
 * below the database CHECK it guards (a JS length counts UTF-16 units, at
 * least SQLite's code points), so a refusal is always the coded one and never
 * a constraint failure inside a batch.
 *
 * Sixteen colours, not eight: a stored v1 request may hold `colors_count` up
 * to sixteen (readSpec), and its first v3 save must not be refused for a job
 * the customer did not change.
 */
export const REQUEST_MODEL_LIMITS = {
  maxParts: 12,
  maxMaterialsPerPart: 4,
  maxColoursPerMaterial: 16,
  maxLinks: 4,
  maxTextRefs: 4,
  /** What a customer may type as a link, as v1 has always taken it. */
  linkUrlMax: 600,
  /**
   * The link as it is STORED: its canonical form percent-encodes every
   * non-ASCII letter (up to nine characters for one typed), so 600 typed
   * characters can store as 5400 and more. The v1 row has always kept that
   * form; the database CHECK (migration 0208) is this number.
   */
  linkCanonicalMax: 8192,
  sourceNoteMax: 500,
  textRefMax: 500,
  partNameMax: 80,
  partNotesMax: 1000,
  partQuantityMax: 1000,
  colourLabelMax: 60,
  regionReferenceMax: 200,
  requirementsMax: 300,
} as const;

/** Every refusal a v3 write can answer, beside the v1 codes it reuses (FILE_NOT_FOUND, BAD_URL, DIMENSIONS_INVALID). */
export const REQUEST_MODEL_REFUSAL_CODES = [
  'REQUEST_MODEL_V3',
  'REQUEST_MODEL_UNAVAILABLE',
  'REQUEST_PARTS_NOT_YET',
  'PARTS_EMPTY',
  'PARTS_TOO_MANY',
  'PART_MATERIALS_TOO_MANY',
  'COLOURS_TOO_MANY',
  'LINKS_TOO_MANY',
  'LINK_DUPLICATE',
  'TEXT_REFS_TOO_MANY',
  'SOURCE_PRIMARY_MULTIPLE',
  'SOURCE_NOTE_TOO_LONG',
  'SOURCE_ROLE_INVALID',
  'SOURCE_ORIGINAL_PRIVATE',
  'PART_MEASURED_FILE_INVALID',
  'PART_SOURCE_INVALID',
  'COLOUR_REF_INVALID',
] as const;
export type RequestModelRefusalCode = (typeof REQUEST_MODEL_REFUSAL_CODES)[number];

/**
 * WHY A PUBLISH REFUSES ONE PART (P1-05, docs/DECISIONS.md row 267). Each
 * answers with `{part_id, position}` so the screen names the part. A draft and
 * the live estimate keep such a part and show it unpriced, with the code as
 * its reason; only the publish refuses it.
 *
 *   PART_PROCESS_MIXED         one part in an FDM material and a resin together
 *   PART_RESIN_MULTI_MATERIAL  a resin part in more than one material
 *   PART_MATERIAL_UNKNOWN      a material that is not in the active catalogue
 *
 * Several parts in different processes are allowed: that is a technical
 * review (`mixed_process`), never a refusal.
 */
export const REQUEST_PUBLISH_REFUSAL_CODES = ['PART_PROCESS_MIXED', 'PART_RESIN_MULTI_MATERIAL', 'PART_MATERIAL_UNKNOWN'] as const;
export type RequestPublishRefusalCode = (typeof REQUEST_PUBLISH_REFUSAL_CODES)[number];

/**
 * WHAT AN OFFER COVERS AND WHAT IT SUBSTITUTES (P1-05, row 267). Coverage
 * names the parts an offer makes (none named = the whole request);
 * a substitution proposes another material or colour for one material row of
 * a covered part. The customer accepts a partial or substituted offer only by
 * acknowledging it (`accept_partial`, `accept_substitutions`).
 */
export const OFFER_COVERAGE_REFUSAL_CODES = [
  'OFFER_COVERAGE_INVALID',
  'OFFER_PART_NOT_ELIGIBLE',
  'OFFER_SUBSTITUTION_INVALID',
  'OFFER_SUBSTITUTION_UNACCEPTED',
  'OFFER_PARTIAL_UNACCEPTED',
  'OFFER_COVERAGE_UNAVAILABLE',
] as const;
export type OfferCoverageRefusalCode = (typeof OFFER_COVERAGE_REFUSAL_CODES)[number];

export const OFFER_LIMITS = {
  /** The merchant's note on one substitution. */
  substitutionNoteMax: 200,
  /** Substitutions on one offer: at most one per material row of the largest request. */
  substitutionsMax: 48,
} as const;

/**
 * WHO SEES WHICH FIELD — the registry «ما يراه الآخرون» (P1-06) renders and
 * `projectModel` enforces.
 *
 *   public     anyone the board lets in (the job as merchants price it)
 *   merchants  an eligible merchant and the accepted one
 *   accepted   the accepted merchant (and the customer, and an admin)
 *   owner      the customer and an admin only
 *
 * The customer's identity is never on this list below `accepted`
 * (conflict 62); the budget is `merchants` only when the customer shows it.
 * A `source` file's bytes, preview and costing are `accepted`; that it is
 * attached — its kind and file name on the request's file list — is public,
 * like every attachment (`files.listing`), and no projection below `accepted`
 * names it as a source, a measured model or a colour reference.
 */
export type RequestFieldAudience = 'public' | 'merchants' | 'accepted' | 'owner';
export const REQUEST_FIELD_VISIBILITY: Readonly<Record<string, RequestFieldAudience>> = {
  title: 'public',
  description: 'public',
  quantity: 'public',
  governorate: 'public',
  deadline: 'public',
  delivery_pref: 'public',
  customer_notes: 'public',
  'parts.*': 'public',
  'parts.materials.*': 'public',
  'sources.kind': 'public',
  'sources.note': 'public',
  'sources.url': 'public',
  'sources.ref_text': 'public',
  'sources.is_primary': 'public',
  'sources.file:reference': 'merchants',
  'sources.file:production': 'merchants',
  'sources.file:source': 'accepted',
  'files.listing': 'public',
  budget_iqd: 'owner',
  'budget_iqd:shown': 'merchants',
  'sources.sha256': 'owner',
  'sources.origin_*': 'owner',
  customer_identity: 'accepted',
  address: 'accepted',
};
