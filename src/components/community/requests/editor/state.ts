/**
 * THE REQUEST EDITOR’S STATE (plan P1-06, docs/DECISIONS.md row 268) — pure:
 * no React, no fetch, so every rule here is a unit test.
 *
 *   hydrate(draft)        the draft the server answered → the editor’s state.
 *                         It reads `draft.model`, the owner’s projection of
 *                         the request model (synthesised for a version-1
 *                         request), so the editor has no version-1 branch.
 *   editorBody(state)     the state → the version-3 body the draft save, the
 *                         estimate and the publish take. It echoes every id
 *                         the server gave, so an offer’s coverage and its
 *                         substitutions keep naming the same part and
 *                         material rows (rows 266, 267); a source the server
 *                         has not seen yet travels under a `tmp_` id a part or
 *                         a colour can point at. It never sends `source_type`:
 *                         the server derives it, and sending it would arm the
 *                         version-1 «SOURCE_*_REQUIRED» checks.
 *   bodyKey(state)        the body as one string: «unsaved changes» is the
 *                         current key against the key of the last save.
 *   adoptIds(...)         after a save, the ids the server gave to what was
 *                         new, kept under the editor’s own keys.
 *
 * The delivery and budget fields are hydrated and carried, never sent: the
 * server keeps a field the body does not name (absent = carried).
 *
 * THE MAIN SOURCE. A source the customer marked is the main one; when none
 * is marked, the editor picks one the way a merchant would start — the first
 * model file, else the first link, else the first picture — and sends it, so
 * what the editor shows as «الرئيسي» is what the merchant reads. The
 * original file (Q5) is never the main source and never a measured model.
 */
import type { DraftFile, DraftShape, Quality, V3Body, V3Colour, V3Material, V3Part, V3Source } from '../api';
import { REQUEST_MODEL_LIMITS, REQUEST_PALETTE, type RequestColourMode, type RequestSourceKind } from '../../../../../packages/contracts/src/requestModel';

export type Key = string;

export interface EditorSource {
  /** Stable in the editor: the server id when it came from the server, else `tmp_<kind>_<n>`. */
  key: Key;
  /** The server id, once the server has the source. */
  id: string | null;
  kind: RequestSourceKind;
  /** The request file (file kinds). */
  fileId: string | null;
  /** A link as stored (echoed verbatim, so an unchanged link stays the priced fact it was). */
  url: string;
  /** A link’s canonical form, as the link check answered it: what is shown and compared. */
  canonical: string;
  provider: string;
  /** A written reference. */
  refText: string;
  note: string;
  /** Marked as the main source by the customer (or stored so). */
  primary: boolean;
  /** Role `source`: the editable original, for the accepted merchant only (Q5). */
  original: boolean;
  /** The role stored before, when it is not `source` — echoed so nothing changes by itself. */
  baseRole: string;
}

export interface EditorColour {
  mode: RequestColourMode;
  hex: string;
  label: string;
  /** «كما في المرجع»: the source key, or '' for the references in general. */
  ref: Key;
}

export interface EditorMaterial {
  key: Key;
  id: string | null;
  /** A catalogue id, 'unsure', or '' (a version-1 job that never named one). */
  materialId: string;
  colours: EditorColour[];
  finish: string;
  region: string;
  requirements: string;
}

export type ProcessPick = 'fdm' | 'resin' | 'unsure';

export interface EditorPart {
  key: Key;
  id: string | null;
  name: string;
  /** Pieces of this part in one set. */
  perSet: number;
  process: ProcessPick;
  dims: { x: number | null; y: number | null; z: number | null };
  measuredFileId: string | null;
  sourceKeys: Key[];
  notes: string;
  assembly: string;
  materials: EditorMaterial[];
  /** The server’s technical review, read-only here. */
  reviewState: string;
  reviewReasons: string[];
}

export interface EditorState {
  requestId: string;
  requestState: string;
  updatedAt: string;
  revision: number;
  liveOffers: number;
  direct: DraftShape['direct'] | null;
  title: string;
  description: string;
  sets: number;
  quality: Quality;
  files: DraftFile[];
  sources: EditorSource[];
  parts: EditorPart[];
  /** Carried, not edited here (see the header). */
  carried: { notes: string; governorate: string; handover: string; deadline: string; budget: number | null; budgetVisible: boolean };
  /** The counter behind `tmp_` keys. */
  seq: number;
}

const QUALITIES: readonly Quality[] = ['draft', 'standard', 'fine', 'ultra'];
export const LIMITS = REQUEST_MODEL_LIMITS;
export const FILE_KINDS: ReadonlySet<string> = new Set(['file', 'studio_revision', 'project_post']);

export const isFileSource = (s: Pick<EditorSource, 'kind'>) => FILE_KINDS.has(s.kind);

/** A new, empty colour list: «أي لون مناسب». */
export const anyColour = (): EditorColour => ({ mode: 'any', hex: '', label: '', ref: '' });

export function emptyMaterial(key: Key): EditorMaterial {
  return { key, id: null, materialId: 'unsure', colours: [anyColour()], finish: '', region: '', requirements: '' };
}

export function emptyPart(key: Key, materialKey: Key): EditorPart {
  return {
    key,
    id: null,
    name: '',
    perSet: 1,
    process: 'unsure',
    dims: { x: null, y: null, z: null },
    measuredFileId: null,
    sourceKeys: [],
    notes: '',
    assembly: '',
    materials: [emptyMaterial(materialKey)],
    reviewState: '',
    reviewReasons: [],
  };
}

/** A fresh `tmp_` key and the state that has counted it. */
export function nextKey(s: EditorState, kind: string): [Key, EditorState] {
  const seq = s.seq + 1;
  return [`tmp_${kind}_${seq}`, { ...s, seq }];
}

// ------------------------------------------------------------------ hydrate

/** The draft as the editor holds it. Every field the server answered; nothing guessed. */
export function hydrate(d: DraftShape): EditorState {
  const m = d.model;
  const sources: EditorSource[] = (m?.sources ?? []).map((x) => ({
    key: x.id,
    id: x.id,
    kind: x.kind,
    fileId: x.file_id,
    url: x.url || x.canonical_url,
    canonical: x.canonical_url || x.url,
    provider: x.provider,
    refText: x.ref_text,
    note: x.note,
    primary: !!x.is_primary,
    original: x.role === 'source',
    baseRole: x.role === 'source' ? '' : x.role,
  }));
  // Every file of the request is a source (the server’s own rule); a file the
  // model did not list yet becomes one, so a file never goes missing here.
  for (const f of d.files) {
    if (sources.some((x) => x.fileId === f.id)) continue;
    sources.push({ key: `rps_${f.id}`, id: null, kind: 'file', fileId: f.id, url: '', canonical: '', provider: '', refText: '', note: '', primary: false, original: false, baseRole: '' });
  }
  const parts: EditorPart[] = (m?.parts ?? []).map((p) => ({
    key: p.id,
    id: p.id,
    name: p.name,
    perSet: Math.max(1, p.quantity || 1),
    process: p.process_unsure || !p.process ? 'unsure' : p.process,
    dims: { x: p.stated_dims?.x ?? null, y: p.stated_dims?.y ?? null, z: p.stated_dims?.z ?? null },
    measuredFileId: p.measured_file_id,
    sourceKeys: [...p.source_ids],
    notes: p.notes,
    assembly: p.assembly_notes,
    materials: p.materials.map((x) => ({
      key: x.id,
      id: x.id,
      materialId: x.material_unsure ? 'unsure' : x.material_id,
      colours: x.colors.map((c) => ({ mode: c.mode, hex: c.hex, label: c.label, ref: c.ref })),
      finish: x.finish,
      region: x.region_reference,
      requirements: x.requirements,
    })),
    reviewState: p.review_state,
    reviewReasons: [...p.review_reasons],
  }));
  let seq = 0;
  if (!parts.length) {
    parts.push(emptyPart('tmp_part_1', 'tmp_mat_2'));
    seq = 2;
  }
  const quality = QUALITIES.includes(m?.job.quality as Quality) ? (m!.job.quality as Quality) : 'standard';
  return {
    requestId: d.id,
    requestState: d.state,
    updatedAt: d.updated_at ?? '',
    revision: d.revision,
    liveOffers: d.live_offers,
    direct: d.direct ?? null,
    title: d.title,
    description: d.description,
    sets: Math.max(1, m?.job.quantity ?? d.quantity ?? 1),
    quality,
    files: d.files,
    sources,
    parts,
    carried: {
      notes: d.customer_notes,
      governorate: d.governorate,
      handover: d.delivery_pref,
      deadline: d.deadline,
      budget: d.budget_iqd,
      budgetVisible: !!d.budget_visible,
    },
    seq,
  };
}

/** The editor before the draft exists: nothing typed, one part in «لست متأكدًا» and «أي لون». */
export function blankState(): EditorState {
  return {
    requestId: '',
    requestState: 'draft',
    updatedAt: '',
    revision: 1,
    liveOffers: 0,
    direct: null,
    title: '',
    description: '',
    sets: 1,
    quality: 'standard',
    files: [],
    sources: [],
    parts: [emptyPart('tmp_part_1', 'tmp_mat_2')],
    carried: { notes: '', governorate: '', handover: '', deadline: '', budget: null, budgetVisible: false },
    seq: 2,
  };
}

/** A draft that is still a draft; anything open for offers is an edit of a published request. */
export const isPublishedEdit = (s: Pick<EditorState, 'requestState'>) => s.requestState === 'open' || s.requestState === 'receiving_offers';
export const isEditable = (s: Pick<EditorState, 'requestState'>) => s.requestState === 'draft' || isPublishedEdit(s);

// ------------------------------------------------------------------ the main source

export const fileOf = (s: Pick<EditorState, 'files'>, fileId: string | null): DraftFile | undefined =>
  fileId ? s.files.find((f) => f.id === fileId) : undefined;

/**
 * The source the merchant starts with: the one marked, else — on a draft —
 * the first model, link or picture (never the original). A published request
 * names only what was marked: the main source is a priced fact, and picking
 * one for it would revise a job its customer did not change.
 */
export function primaryKey(s: Pick<EditorState, 'sources' | 'files' | 'requestState'>): Key | '' {
  const open = s.sources.filter((x) => !x.original);
  const marked = open.find((x) => x.primary);
  if (marked) return marked.key;
  if (isPublishedEdit(s)) return '';
  const model = open.find((x) => isFileSource(x) && fileOf(s, x.fileId)?.kind === 'model');
  if (model) return model.key;
  const link = open.find((x) => x.kind === 'link');
  if (link) return link.key;
  const picture = open.find((x) => isFileSource(x) && !!fileOf(s, x.fileId)?.inline);
  return picture ? picture.key : '';
}

/** The files a part may be measured from: the request’s models that are not the original. */
export function measurableFiles(s: Pick<EditorState, 'sources' | 'files'>): DraftFile[] {
  const originals = new Set(s.sources.filter((x) => x.original && x.fileId).map((x) => x.fileId as string));
  return s.files.filter((f) => f.kind === 'model' && !originals.has(f.id));
}

// ------------------------------------------------------------------ the body

const sourceRef = (s: Pick<EditorState, 'sources'>, key: Key): string => {
  const x = s.sources.find((y) => y.key === key);
  return x ? (x.id ?? x.key) : key;
};

function colourBody(s: EditorState, c: EditorColour): V3Colour {
  if (c.mode === 'any') return { mode: 'any' };
  if (c.mode === 'as_reference') return { mode: 'as_reference', ref: c.ref ? sourceRef(s, c.ref) : '' };
  return { mode: c.mode, hex: c.hex, label: c.label };
}

/** Three edges, each 1–5000 mm — or nothing: the server refuses a partial size. */
export function statedDims(p: Pick<EditorPart, 'dims'>): { x: number; y: number; z: number } | null {
  const { x, y, z } = p.dims;
  return x && y && z ? { x, y, z } : null;
}

/** The version-3 body of the state (see the header). */
export function editorBody(s: EditorState): V3Body {
  const main = primaryKey(s);
  const live = new Set(s.sources.map((x) => x.key));
  const sources: V3Source[] = s.sources.map((x) => {
    const out: V3Source = { id: x.id ?? x.key, kind: x.kind, note: x.note.trim(), is_primary: x.key === main };
    if (isFileSource(x)) {
      if (x.kind === 'file' && x.fileId) out.file_id = x.fileId;
      out.role = x.original ? 'source' : x.baseRole;
    } else if (x.kind === 'link') out.url = x.url || x.canonical;
    else if (x.kind === 'text_ref') out.ref_text = x.refText.trim();
    return out;
  });
  const parts: V3Part[] = s.parts.map((p) => {
    const materials: V3Material[] = p.materials.map((m) => ({
      ...(m.id ? { id: m.id } : {}),
      material_id: m.materialId,
      colors: (m.colours.length ? m.colours : [anyColour()]).map((c) => colourBody(s, c)),
      finish: m.finish,
      region_reference: m.region.trim(),
      requirements: m.requirements.trim(),
    }));
    const keys = p.sourceKeys.filter((k) => live.has(k));
    return {
      ...(p.id ? { id: p.id } : {}),
      name: p.name.trim(),
      quantity: Math.max(1, p.perSet),
      process: p.process,
      stated_dimensions_mm: statedDims(p),
      measured_file_id: p.measuredFileId,
      notes: p.notes.trim(),
      assembly_notes: p.assembly.trim(),
      source_ids: keys.map((k) => sourceRef(s, k)),
      materials,
    };
  });
  const body: V3Body = { schema_version: 3, quantity: Math.max(1, s.sets), quality: s.quality, sources, parts };
  // A published request keeps the title and description merchants read when
  // they offered: the publish door never changes them, so they are not sent.
  if (!isPublishedEdit(s)) {
    body.title = s.title.trim();
    body.description = s.description.trim();
  }
  return body;
}

export const bodyKey = (s: EditorState): string => JSON.stringify(editorBody(s));

// ------------------------------------------------------------------ after a save

/** The keys a body was made from, in its order — to read the server’s answer back onto them. */
export interface SentShape {
  sources: Array<{ key: Key; kind: string; fileId: string | null; canonical: string; refText: string }>;
  parts: Array<{ key: Key; materials: Key[] }>;
}

export function sentShape(s: EditorState): SentShape {
  return {
    sources: s.sources.map((x) => ({ key: x.key, kind: x.kind, fileId: x.fileId, canonical: x.canonical, refText: x.refText.trim() })),
    parts: s.parts.map((p) => ({ key: p.key, materials: p.materials.map((m) => m.key) })),
  };
}

/**
 * The ids the server gave, onto the editor’s keys: a source by its file, its
 * link or its words; a part and a material by their place in the body (the
 * server keeps both lists in body order). The review of each part is the
 * server’s too. Applied to the CURRENT state, so an edit made while the save
 * was on its way is kept.
 */
export function adoptIds(s: EditorState, sent: SentShape, draft: DraftShape): EditorState {
  const m = draft.model;
  if (!m) return { ...s, updatedAt: draft.updated_at ?? s.updatedAt, files: draft.files };
  const sourceIds = new Map<Key, string>();
  const taken = new Set<string>();
  for (const x of sent.sources) {
    const hit = m.sources.find(
      (y) =>
        !taken.has(y.id) &&
        y.kind === x.kind &&
        (FILE_KINDS.has(x.kind) ? y.file_id === x.fileId : x.kind === 'link' ? (y.canonical_url || y.url) === x.canonical : y.ref_text.trim() === x.refText)
    );
    if (hit) {
      sourceIds.set(x.key, hit.id);
      taken.add(hit.id);
    }
  }
  const partIds = new Map<Key, { id: string; review: string; reasons: string[]; mats: Map<Key, string> }>();
  sent.parts.forEach((p, i) => {
    const sp = m.parts[i];
    if (!sp) return;
    const mats = new Map<Key, string>();
    p.materials.forEach((k, j) => {
      if (sp.materials[j]) mats.set(k, sp.materials[j].id);
    });
    partIds.set(p.key, { id: sp.id, review: sp.review_state, reasons: [...sp.review_reasons], mats });
  });
  return {
    ...s,
    updatedAt: draft.updated_at ?? s.updatedAt,
    revision: draft.revision,
    liveOffers: draft.live_offers,
    files: mergeFiles(s.files, draft.files),
    sources: s.sources.map((x) => (sourceIds.has(x.key) ? { ...x, id: sourceIds.get(x.key)! } : x)),
    parts: s.parts.map((p) => {
      const got = partIds.get(p.key);
      if (!got) return p;
      return {
        ...p,
        id: got.id,
        reviewState: got.review,
        reviewReasons: got.reasons,
        materials: p.materials.map((mm) => (got.mats.has(mm.key) ? { ...mm, id: got.mats.get(mm.key)! } : mm)),
      };
    }),
  };
}

/** The server’s file rows win (an analysis may have arrived); a file only this tab knows yet is kept. */
function mergeFiles(local: DraftFile[], server: DraftFile[]): DraftFile[] {
  const byId = new Map(server.map((f) => [f.id, f]));
  const out = local.filter((f) => byId.has(f.id)).map((f) => ({ ...f, ...byId.get(f.id)!, analysis: byId.get(f.id)!.analysis ?? f.analysis }));
  for (const f of server) if (!out.some((x) => x.id === f.id)) out.push(f);
  return out;
}

// ------------------------------------------------------------------ edits (pure)

type Patch<T> = Partial<T> | ((x: T) => Partial<T>);
const apply = <T>(x: T, patch: Patch<T>): T => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) });

export const updatePart = (s: EditorState, key: Key, patch: Patch<EditorPart>): EditorState => ({
  ...s,
  parts: s.parts.map((p) => (p.key === key ? apply(p, patch) : p)),
});

export const updateMaterial = (s: EditorState, partKey: Key, matKey: Key, patch: Patch<EditorMaterial>): EditorState =>
  updatePart(s, partKey, (p) => ({ materials: p.materials.map((m) => (m.key === matKey ? apply(m, patch) : m)) }));

export const updateSource = (s: EditorState, key: Key, patch: Patch<EditorSource>): EditorState => ({
  ...s,
  sources: s.sources.map((x) => (x.key === key ? apply(x, patch) : x)),
});

/** A material chosen: its process becomes the part’s (the server’s own rule). */
export function chooseMaterial(s: EditorState, partKey: Key, matKey: Key, materialId: string, processOf: (id: string) => 'fdm' | 'resin' | ''): EditorState {
  const next = updateMaterial(s, partKey, matKey, { materialId });
  const part = next.parts.find((p) => p.key === partKey);
  if (!part) return next;
  const procs = [...new Set(part.materials.filter((m) => m.materialId && m.materialId !== 'unsure').map((m) => processOf(m.materialId)).filter(Boolean))];
  return procs.length === 1 ? updatePart(next, partKey, { process: procs[0] as 'fdm' | 'resin' }) : next;
}

/** The part with every material still open: only then is the process the customer’s own choice. */
export const processIsOpen = (p: EditorPart) => p.materials.every((m) => !m.materialId || m.materialId === 'unsure');

export function addPart(s: EditorState): [EditorState, Key] {
  if (s.parts.length >= LIMITS.maxParts) return [s, ''];
  const [pk, s1] = nextKey(s, 'part');
  const [mk, s2] = nextKey(s1, 'mat');
  return [{ ...s2, parts: [...s2.parts, emptyPart(pk, mk)] }, pk];
}

export function duplicatePart(s: EditorState, key: Key): [EditorState, Key] {
  const at = s.parts.findIndex((p) => p.key === key);
  if (at < 0 || s.parts.length >= LIMITS.maxParts) return [s, ''];
  const [pk, s1] = nextKey(s, 'part');
  let s2 = s1;
  const materials = s.parts[at].materials.map((m) => {
    const [mk, s3] = nextKey(s2, 'mat');
    s2 = s3;
    return { ...m, key: mk, id: null, colours: m.colours.map((c) => ({ ...c })) };
  });
  const copy: EditorPart = { ...s.parts[at], key: pk, id: null, materials, sourceKeys: [...s.parts[at].sourceKeys], reviewState: '', reviewReasons: [] };
  const parts = [...s2.parts];
  parts.splice(at + 1, 0, copy);
  return [{ ...s2, parts }, pk];
}

export function movePart(s: EditorState, key: Key, by: -1 | 1): EditorState {
  const at = s.parts.findIndex((p) => p.key === key);
  const to = at + by;
  if (at < 0 || to < 0 || to >= s.parts.length) return s;
  const parts = [...s.parts];
  [parts[at], parts[to]] = [parts[to], parts[at]];
  return { ...s, parts };
}

export function removePart(s: EditorState, key: Key): EditorState {
  if (s.parts.length <= 1) return s;
  return { ...s, parts: s.parts.filter((p) => p.key !== key) };
}

export function addMaterial(s: EditorState, partKey: Key): [EditorState, Key] {
  const part = s.parts.find((p) => p.key === partKey);
  if (!part || part.materials.length >= LIMITS.maxMaterialsPerPart) return [s, ''];
  const [mk, s1] = nextKey(s, 'mat');
  return [updatePart(s1, partKey, (p) => ({ materials: [...p.materials, emptyMaterial(mk)] })), mk];
}

export function removeMaterial(s: EditorState, partKey: Key, matKey: Key): EditorState {
  return updatePart(s, partKey, (p) => (p.materials.length <= 1 ? {} : { materials: p.materials.filter((m) => m.key !== matKey) }));
}

/**
 * A new source joins the request — and the references of a one-part job,
 * which are every source the job has (the server’s own rule for a file).
 */
function withSource(s: EditorState, src: EditorSource): EditorState {
  const parts = s.parts.length === 1 ? [{ ...s.parts[0], sourceKeys: [...s.parts[0].sourceKeys, src.key] }] : s.parts;
  return { ...s, sources: [...s.sources, src], parts };
}

/** A link the check answered (canonical form); refused here when the request already has it or is full. */
export function addLink(s: EditorState, canonical: string, provider: string): [EditorState, Key, '' | 'LINK_DUPLICATE' | 'LINKS_TOO_MANY'] {
  const links = s.sources.filter((x) => x.kind === 'link');
  if (links.some((x) => x.canonical === canonical)) return [s, '', 'LINK_DUPLICATE'];
  if (links.length >= LIMITS.maxLinks) return [s, '', 'LINKS_TOO_MANY'];
  const [k, s1] = nextKey(s, 'link');
  const src: EditorSource = { key: k, id: null, kind: 'link', fileId: null, url: canonical, canonical, provider, refText: '', note: '', primary: false, original: false, baseRole: '' };
  return [withSource(s1, src), k, ''];
}

export function addTextRef(s: EditorState, text: string): [EditorState, Key, '' | 'TEXT_REFS_TOO_MANY' | 'EMPTY'] {
  const t = text.trim().slice(0, LIMITS.textRefMax);
  if (!t) return [s, '', 'EMPTY'];
  if (s.sources.filter((x) => x.kind === 'text_ref').length >= LIMITS.maxTextRefs) return [s, '', 'TEXT_REFS_TOO_MANY'];
  const [k, s1] = nextKey(s, 'text');
  const src: EditorSource = { key: k, id: null, kind: 'text_ref', fileId: null, url: '', canonical: '', provider: '', refText: t, note: '', primary: false, original: false, baseRole: '' };
  return [withSource(s1, src), k, ''];
}

/**
 * A file the server just stored: its row joins the list and it becomes a
 * source. The first model measures the first part that has no size yet, so
 * a one-part request is priced from the file without another tap.
 */
export function fileStored(s: EditorState, f: DraftFile): EditorState {
  if (s.files.some((x) => x.id === f.id)) return s;
  const [k, s1] = nextKey(s, 'file');
  const src: EditorSource = { key: k, id: null, kind: 'file', fileId: f.id, url: '', canonical: '', provider: '', refText: '', note: '', primary: false, original: false, baseRole: '' };
  let next: EditorState = withSource({ ...s1, files: [...s1.files, f] }, src);
  if (f.kind === 'model') {
    const part = next.parts.find((p) => !p.measuredFileId && !statedDims(p));
    if (part) next = updatePart(next, part.key, { measuredFileId: f.id });
  }
  return next;
}

/** A source gone (a file deleted, a link or a reference removed): no part or colour points at it any more. */
export function removeSource(s: EditorState, key: Key): EditorState {
  const gone = s.sources.find((x) => x.key === key);
  if (!gone) return s;
  return {
    ...s,
    files: gone.fileId ? s.files.filter((f) => f.id !== gone.fileId) : s.files,
    sources: s.sources.filter((x) => x.key !== key),
    parts: s.parts.map((p) => ({
      ...p,
      measuredFileId: gone.fileId && p.measuredFileId === gone.fileId ? null : p.measuredFileId,
      sourceKeys: p.sourceKeys.filter((k) => k !== key),
      materials: p.materials.map((m) => ({ ...m, colours: m.colours.map((c) => (c.mode === 'as_reference' && c.ref === key ? { ...c, ref: '' } : c)) })),
    })),
  };
}

/** Mark one source the main one (or none): exactly one at most. */
export function setPrimary(s: EditorState, key: Key | ''): EditorState {
  return { ...s, sources: s.sources.map((x) => ({ ...x, primary: !!key && x.key === key })) };
}

/**
 * Mark a file the original (Q5) — refused while a part is measured from it
 * (SOURCE_ORIGINAL_PRIVATE). Marking it clears its main-source mark.
 */
export function setOriginal(s: EditorState, key: Key, on: boolean): [EditorState, '' | 'SOURCE_ORIGINAL_PRIVATE'] {
  const src = s.sources.find((x) => x.key === key);
  if (!src || !isFileSource(src)) return [s, ''];
  if (on && src.fileId && s.parts.some((p) => p.measuredFileId === src.fileId)) return [s, 'SOURCE_ORIGINAL_PRIVATE'];
  return [updateSource(s, key, { original: on, primary: on ? false : src.primary }), ''];
}

// ------------------------------------------------------------------ colours

export const PALETTE = REQUEST_PALETTE;
const paletteHex = new Set(REQUEST_PALETTE.map((c) => c.hex.toLowerCase()));
export const isNamed = (c: EditorColour) => c.mode === 'catalogue' || c.mode === 'custom';

/** A named colour: a palette colour by its hex, anything else as the customer wrote it. */
export function namedColour(label: string, hex: string): EditorColour {
  const h = /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : '';
  return { mode: h && paletteHex.has(h) ? 'catalogue' : 'custom', hex: h, label: label.trim().slice(0, LIMITS.colourLabelMax), ref: '' };
}

/** The same colour twice is one: a palette colour by its hex, a written one by its words. */
export const sameColour = (a: EditorColour, b: EditorColour) =>
  a.mode === b.mode && (a.mode === 'as_reference' ? a.ref === b.ref : a.mode === 'any' ? true : a.hex && b.hex ? a.hex === b.hex : a.label.trim().toLowerCase() === b.label.trim().toLowerCase());

/**
 * Toggle one choice of the colour sheet. «أي لون مناسب» stands alone: it
 * clears every other choice, and any other choice clears it. At most sixteen.
 */
export function toggleColour(list: readonly EditorColour[], c: EditorColour): EditorColour[] {
  const has = list.some((x) => sameColour(x, c) || (c.mode === 'as_reference' && x.mode === 'as_reference'));
  if (c.mode === 'any') return [anyColour()];
  if (has) {
    const rest = list.filter((x) => !(sameColour(x, c) || (c.mode === 'as_reference' && x.mode === 'as_reference')));
    return rest.length ? rest : [anyColour()];
  }
  const rest = list.filter((x) => x.mode !== 'any');
  if (rest.length >= LIMITS.maxColoursPerMaterial) return [...list];
  return [...rest, c];
}

// ------------------------------------------------------------------ the tab copy

/** What the tab copy keeps of a state: everything (a few KB). */
export function serialise(s: EditorState): string {
  return JSON.stringify(s);
}

/** A tab copy read back, or null when it is not one this build can trust. */
export function deserialise(raw: string | null | undefined): EditorState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as EditorState;
    if (!v || typeof v !== 'object' || typeof v.requestId !== 'string' || !Array.isArray(v.parts) || !Array.isArray(v.sources) || !Array.isArray(v.files)) return null;
    if (!v.parts.every((p) => p && typeof p.key === 'string' && Array.isArray(p.materials) && p.materials.length > 0)) return null;
    return v;
  } catch {
    return null;
  }
}
