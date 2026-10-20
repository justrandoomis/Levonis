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
  'PART_MEASURED_FILE_INVALID',
  'PART_SOURCE_INVALID',
  'COLOUR_REF_INVALID',
] as const;
export type RequestModelRefusalCode = (typeof REQUEST_MODEL_REFUSAL_CODES)[number];

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
  budget_iqd: 'owner',
  'budget_iqd:shown': 'merchants',
  'sources.sha256': 'owner',
  'sources.origin_*': 'owner',
  customer_identity: 'accepted',
  address: 'accepted',
};
