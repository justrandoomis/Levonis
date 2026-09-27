/**
 * THE SECTIONS IN TREE ORDER — every main section followed by its own branch.
 *
 * The owner, on the import panel: «في الأقسام يظهر أنها غير صحيحة وغير مرتبة
 * حيث يظهر الأقسام الرئيسية والأقسام الفرعية متداخلة، وهنالك أقسام فرعية
 * متداخلة مع أقسام أخرى». The lists were read `ORDER BY sort, name` over the
 * WHOLE table, so `sort` — which only means something among siblings — was
 * compared across levels: a sub-section with sort 3 printed above the main
 * section it belongs to, and children of two different parents interleaved
 * whenever their numbers did.
 *
 * This walks the tree instead. Siblings keep the order they arrived in (the
 * caller's `sort, name`), each row is followed by its descendants, and a row
 * whose parent is missing — or that sits in a cycle a hand-edited database
 * could contain — is placed as a root rather than dropped: a section that
 * exists must be choosable.
 *
 * Pure, with no I/O, so the Worker (the listings and the downloaded templates)
 * and the SPA (the import panel's select) order the same tree the same way.
 */

export interface SectionTreeRow {
  id: string;
  parent_id: string | null;
}

export interface SectionPlacement<T> {
  row: T;
  /** 0 for a main section, 1 for its sub-sections, and so on. */
  depth: number;
  /** The branch above this row, main section first. Empty for a main section. */
  ancestors: T[];
  /** The main section this row files under (itself, for a main section). */
  root: T;
}

export function sectionTreeOrder<T extends SectionTreeRow>(rows: readonly T[]): SectionPlacement<T>[] {
  const byId = new Map<string, T>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);

  const children = new Map<string | null, T[]>();
  for (const r of byId.values()) {
    const parent = r.parent_id && r.parent_id !== r.id && byId.has(r.parent_id) ? r.parent_id : null;
    const list = children.get(parent);
    if (list) list.push(r);
    else children.set(parent, [r]);
  }

  const out: SectionPlacement<T>[] = [];
  const placed = new Set<string>();
  const walk = (parentId: string, ancestors: T[]) => {
    for (const child of children.get(parentId) ?? []) {
      if (placed.has(child.id)) continue;
      placed.add(child.id);
      out.push({ row: child, depth: ancestors.length, ancestors, root: ancestors[0] ?? child });
      walk(child.id, [...ancestors, child]);
    }
  };
  const plant = (root: T) => {
    placed.add(root.id);
    out.push({ row: root, depth: 0, ancestors: [], root });
    walk(root.id, [root]);
  };

  for (const root of children.get(null) ?? []) if (!placed.has(root.id)) plant(root);
  // A cycle has no root to be reached from: each such row becomes one, in the
  // order it arrived, so nothing the table holds disappears from a list.
  for (const r of byId.values()) if (!placed.has(r.id)) plant(r);
  return out;
}

/** «الطابعات › طابعات FDM» — the branch as one readable line. */
export function sectionPath<T>(placement: SectionPlacement<T>, name: (row: T) => string, sep = ' › '): string {
  return [...placement.ancestors, placement.row].map(name).filter((s) => s !== '').join(sep);
}
