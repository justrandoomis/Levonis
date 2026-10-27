/**
 * «ما يراه الآخرون» — WHO SEES WHAT OF THIS REQUEST (plan P1-06,
 * docs/DECISIONS.md row 268; `17.public-private-preview`). Pure: no React.
 *
 * Every row is read from the contract, never written here a second time:
 * the field registry `REQUEST_FIELD_VISIBILITY` and the file matrix
 * `REQUEST_FILE_VISIBILITY` (packages/contracts/src/requestModel.ts), which
 * tests/requestAudiencePanel.test.ts holds equal to what `projectModel` and
 * `mayReadBytes` actually serve. Only what THIS request carries is listed.
 *
 *   public    everyone on the board (a direct request: this store)
 *   merchants the merchants the request is meant for (a direct one: this store)
 *   dealing   the merchants you deal with: your name, on the request page
 *             and its conversation once they offer (`partyRequest`)
 *   accepted  the merchant whose offer you accept
 *   private   you and the site staff — the budget you keep, where copies
 *             came from
 *
 * THE NAME IS NOT «ACCEPTED ONLY» (design critique 7): a merchant with a
 * standing offer reads it in the request's conversation, and the store a
 * direct request is sent to reads it from the start; the phone number and
 * the address wait for acceptance (the contact snapshot).
 */
import { REQUEST_FIELD_VISIBILITY, REQUEST_FILE_VISIBILITY, type RequestFieldAudience } from '../../../../../packages/contracts/src/requestModel';
import { fileOf, isFileSource, type EditorState } from './state';
import type { EditorStrings } from './strings';

export type PanelGroup = 'public' | 'merchants' | 'dealing' | 'accepted' | 'private';

export interface PanelRow {
  key: string;
  label: keyof EditorStrings;
  group: PanelGroup;
  /** The registry keys the row speaks for (empty for a row read from the file matrix or the parties’ view). */
  registry: string[];
}

export const PANEL_GROUPS: readonly PanelGroup[] = ['public', 'merchants', 'dealing', 'accepted', 'private'];

/** A registry audience as a panel group. */
export const groupOf = (a: RequestFieldAudience): PanelGroup => (a === 'owner' ? 'private' : a);

/** The group of a registry key — read, never restated. */
const reg = (key: string): PanelGroup => groupOf(REQUEST_FIELD_VISIBILITY[key]);

/**
 * Every row the panel can show, with the registry keys it speaks for. The
 * group of a registry row IS the registry's audience; a file row reads the
 * file matrix.
 */
export const PANEL_ROWS = {
  title: { label: 'rowTitle', registry: ['title', 'description'] },
  parts: { label: 'rowParts', registry: ['parts.*', 'parts.materials.*'] },
  quantity: { label: 'rowQuantity', registry: ['quantity'] },
  place: { label: 'rowPlace', registry: ['governorate'] },
  when: { label: 'rowWhen', registry: ['deadline', 'delivery_pref'] },
  notes: { label: 'rowNotes', registry: ['customer_notes'] },
  links: { label: 'rowLinks', registry: ['sources.kind', 'sources.url', 'sources.ref_text', 'sources.note', 'sources.is_primary'] },
  fileNames: { label: 'rowFileNames', registry: ['files.listing'] },
  pictures: { label: 'rowPictures', registry: ['sources.file:reference'] },
  modelPreview: { label: 'rowModelPreview', registry: ['sources.file:production'] },
  budgetShown: { label: 'rowBudget', registry: ['budget_iqd:shown'] },
  models: { label: 'rowModels', registry: [] },
  original: { label: 'rowOriginal', registry: ['sources.file:source'] },
  name: { label: 'rowName', registry: [] },
  contact: { label: 'rowContact', registry: ['customer_identity', 'address'] },
  budgetKept: { label: 'rowBudget', registry: ['budget_iqd'] },
  provenance: { label: 'rowProvenance', registry: ['sources.sha256', 'sources.origin_*'] },
} as const satisfies Record<string, { label: keyof EditorStrings; registry: readonly string[] }>;

export type PanelRowKey = keyof typeof PANEL_ROWS;

/** The group each row belongs to: the registry's, or the file matrix's, or the parties’ view. */
export function rowGroup(key: PanelRowKey): PanelGroup {
  if (key === 'models') return groupOf(REQUEST_FILE_VISIBILITY.model.bytes);
  if (key === 'modelPreview') return groupOf(REQUEST_FILE_VISIBILITY.model.preview);
  if (key === 'pictures') return groupOf(REQUEST_FILE_VISIBILITY.image.bytes);
  if (key === 'original') return groupOf(REQUEST_FILE_VISIBILITY.source.bytes);
  if (key === 'fileNames') return groupOf(REQUEST_FILE_VISIBILITY.model.listing);
  if (key === 'name') return 'dealing';
  return reg(PANEL_ROWS[key].registry[0]);
}

/** What this request carries, row by row, in the order the panel reads. */
export function audienceRows(s: EditorState): PanelRow[] {
  const d = s.delivery ?? s.carried;
  const files = s.sources.filter(isFileSource);
  const kindOf = (x: (typeof files)[number]) => fileOf(s, x.fileId)?.kind ?? '';
  const open = files.filter((x) => !x.original);
  const has = {
    place: !!d.governorate,
    when: !!d.deadline || !!d.handover,
    notes: !!d.notes.trim(),
    links: s.sources.some((x) => x.kind === 'link' || x.kind === 'text_ref' || !!x.note.trim()),
    fileNames: files.length > 0,
    pictures: open.some((x) => kindOf(x) !== 'model'),
    models: open.some((x) => kindOf(x) === 'model'),
    original: files.some((x) => x.original),
    budget: d.budget !== null && d.budget > 0,
    provenance: s.sources.some((x) => x.kind === 'project_post' || x.kind === 'studio_revision' || !!x.origin),
  };
  const keys: PanelRowKey[] = ['title', 'parts', 'quantity'];
  if (has.place) keys.push('place');
  if (has.when) keys.push('when');
  if (has.notes) keys.push('notes');
  if (has.links) keys.push('links');
  if (has.fileNames) keys.push('fileNames');
  if (has.pictures) keys.push('pictures');
  if (has.models) keys.push('modelPreview');
  if (has.budget && d.budgetVisible) keys.push('budgetShown');
  if (has.models) keys.push('models');
  if (has.original) keys.push('original');
  keys.push('name', 'contact');
  if (has.budget && !d.budgetVisible) keys.push('budgetKept');
  if (has.provenance) keys.push('provenance');
  return keys.map((k) => ({ key: k, label: PANEL_ROWS[k].label, group: rowGroup(k), registry: [...PANEL_ROWS[k].registry] }));
}

/** The group headings, in the words of a board request or of a request for one store. */
export function groupLabel(g: PanelGroup, direct: boolean): keyof EditorStrings {
  switch (g) {
    case 'public':
      return direct ? 'groupPublicDirect' : 'groupPublic';
    case 'merchants':
      return direct ? 'groupMerchantsDirect' : 'groupMerchants';
    case 'dealing':
      return direct ? 'groupMerchantsDirect' : 'groupDealing';
    case 'accepted':
      return 'groupAccepted';
    default:
      return 'groupPrivate';
  }
}

/** The rows grouped for display; a request for one store folds «dealing» into what the store sees. */
export function groupedRows(s: EditorState): Array<{ group: PanelGroup; rows: PanelRow[] }> {
  const direct = !!s.direct;
  const rows = audienceRows(s).map((r) => (direct && r.group === 'dealing' ? { ...r, group: 'merchants' as const } : r));
  return PANEL_GROUPS.map((g) => ({ group: g, rows: rows.filter((r) => r.group === g) })).filter((x) => x.rows.length > 0);
}
