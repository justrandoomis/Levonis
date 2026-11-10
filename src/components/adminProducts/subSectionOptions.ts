/**
 * THE SUB-SECTIONS A PRODUCT CAN BE FILED IN (owner, 2026-11-10: «أقسام مواد FDM» showed PLA with
 * «منتج واحد»; docs/DECISIONS.md row 309).
 *
 * The form used to offer only the main section's DIRECT children. Under «مواد الطباعة» that is «مواد FDM»,
 * «مواد Resin» and the like, never «PLA» or «PETG», which the Bambu import created INSIDE «مواد FDM». So the
 * owner could not file eSUN PLA+ under PLA, and a filament saved through the form stayed on «مواد FDM»
 * itself, where no section lists it: the PLA section showed one product while the shop held seventeen.
 * The server already takes any section of the main section's tree as `sub_category_id` (the import files
 * PLA Metal under PLA that way, and catalog membership counts it in every ancestor).
 *
 * So the list is every ACTIVE section under the main one, depth first, each level in the admin's own
 * order (`sort`, then the English and Arabic names, as GET /api/admin/taxonomy/catalogs reads them). A
 * deeper section is named with its path, «مواد FDM ← PLA», so two sections with the same name under
 * different parents stay apart. The section a product ALREADY carries stays in the list even when it is
 * inactive or outside this tree, so opening and saving that product never files it nowhere.
 */

export interface SectionLike {
  id: string;
  parent_id: string | null;
  active: boolean | number;
  sort?: number | null;
  name_ar: string;
  name_en: string;
}

export interface SubSectionOption {
  id: string;
  /** 1 for a direct child of the main section, 2 for a section inside it, and so on. */
  depth: number;
  label_ar: string;
  label_en: string;
  /** Kept only because the product already carries it (inactive, or not under this main section). */
  kept: boolean;
}

/** Deep enough for any tree the admin can build; a cycle in bad data cannot loop past it. */
const MAX_DEPTH = 8;

const bySortThenName = (a: SectionLike, b: SectionLike): number =>
  (Number(a.sort ?? 0) - Number(b.sort ?? 0)) || a.name_en.localeCompare(b.name_en) || a.name_ar.localeCompare(b.name_ar);

export function subSectionOptions(
  catalogs: readonly SectionLike[],
  categoryId: string | null | undefined,
  currentSubId: string | null | undefined,
): SubSectionOption[] {
  const out: SubSectionOption[] = [];
  const seen = new Set<string>();
  if (categoryId) {
    const kids = new Map<string, SectionLike[]>();
    for (const c of catalogs) {
      if (!c.parent_id || !c.active) continue;
      const list = kids.get(c.parent_id) ?? [];
      list.push(c);
      kids.set(c.parent_id, list);
    }
    const walk = (parentId: string, depth: number, pathAr: string[], pathEn: string[]) => {
      if (depth > MAX_DEPTH) return;
      for (const c of [...(kids.get(parentId) ?? [])].sort(bySortThenName)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const ar = [...pathAr, c.name_ar];
        const en = [...pathEn, c.name_en];
        out.push({ id: c.id, depth, label_ar: ar.join(' ← '), label_en: en.join(' › '), kept: false });
        walk(c.id, depth + 1, ar, en);
      }
    };
    walk(categoryId, 1, [], []);
  }
  if (currentSubId && !seen.has(currentSubId)) {
    const own = catalogs.find((c) => c.id === currentSubId);
    if (own) out.push({ id: own.id, depth: 1, label_ar: own.name_ar, label_en: own.name_en, kept: true });
  }
  return out;
}
