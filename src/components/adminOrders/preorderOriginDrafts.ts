export const SOURCE_FIELDS = ['batch_name', 'batch_ref', 'purchase_ref', 'supplier_order_no', 'tracking_no', 'note'] as const;
export type SourceKey = typeof SOURCE_FIELDS[number];
export type SourceFields = Record<SourceKey, string>;
export type PreorderSource = SourceFields & {
  id: string | null;
  order_item_id: string;
  unit_index: number;
  product_name: string;
  selection: string;
  version: number;
  state?: 'active' | 'cancelled' | 'returned' | 'delivered';
};
export type SourceView = {
  installed: boolean;
  editable: boolean;
  historical: boolean;
  rows: PreorderSource[];
};
export type SourceDrafts = Record<string, SourceFields>;
export const emptySource = (): SourceFields => ({ batch_name: '', batch_ref: '', purchase_ref: '', supplier_order_no: '', tracking_no: '', note: '' });
export const rowKey = (row: Pick<PreorderSource, 'order_item_id' | 'unit_index'>) => `${row.order_item_id}:${row.unit_index}`;
export const sourceFields = (row: SourceFields): SourceFields => Object.fromEntries(SOURCE_FIELDS.map((field) => [field, row[field] ?? ''])) as SourceFields;
export const changedSources = (view: SourceView | null, drafts: SourceDrafts) => view?.rows.filter((row) =>
  SOURCE_FIELDS.some((field) => (drafts[rowKey(row)]?.[field] ?? '') !== (row[field] ?? ''))) ?? [];
type SourceUpdate = SourceFields & Pick<PreorderSource, 'order_item_id' | 'unit_index' | 'version'>;
export type SourceProgress = { view: SourceView; drafts: SourceDrafts; completed: number; total: number };

/** Commit at most 500 units per request. Unsent drafts keep their original
 * version, even if a response contains a concurrent edit by another admin. */
export async function saveSourceChunks(
  initial: SourceView,
  drafts: SourceDrafts,
  patch: (body: { units: SourceUpdate[] }) => Promise<SourceView>,
  onProgress: (progress: SourceProgress) => void,
) {
  const changed = changedSources(initial, drafts);
  const pending = new Map(changed.map((row) => [rowKey(row), row]));
  for (let offset = 0; offset < changed.length; offset += 500) {
    const chunk = changed.slice(offset, offset + 500);
    const latest = await patch({ units: chunk.map((row) => ({
      order_item_id: row.order_item_id, unit_index: row.unit_index, version: row.version,
      ...Object.fromEntries(SOURCE_FIELDS.map((field) => [field, drafts[rowKey(row)][field].trim()])) as SourceFields,
    })) });
    for (const row of chunk) pending.delete(rowKey(row));
    const seen = new Set(latest.rows.map(rowKey));
    const rows = [
      ...latest.rows.map((row) => pending.get(rowKey(row)) ?? row),
      ...[...pending.values()].filter((row) => !seen.has(rowKey(row))),
    ];
    onProgress({ view: { ...latest, rows },
      drafts: Object.fromEntries(rows.map((row) => [rowKey(row), pending.has(rowKey(row)) ? drafts[rowKey(row)] : sourceFields(row)])),
      completed: changed.length - pending.size, total: changed.length,
    });
    if (pending.size && !latest.editable) throw new Error('Preorder source editing closed during save');
  }
}
