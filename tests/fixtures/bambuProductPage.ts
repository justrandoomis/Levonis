/**
 * A MODEL OF THE STOREFRONT'S PRODUCT PAGE FOR AN IMPORTED PRODUCT, for the
 * browser check's tests (scripts/bambu-import/browser.ts `inspectProductPage`).
 *
 * It behaves the way the page of build step 7 does (src/pages/Product.tsx with
 * src/lib/productChooser.ts and src/lib/productGallery.ts): the opening
 * selection is the defaults while they form a variant, else the first default
 * alone, plus every single-value group that fits; a click changes that
 * group's value and keeps the others (a click on the chosen value clears it);
 * a value that forms no variant with the other groups' choices is disabled
 * with «غير متاح مع هذا الاختيار»; the gallery drops what the selection
 * contradicts, ranks the rest with the shared `productMediaForSelection` and
 * de-duplicates by URL, and the hero is its first picture.
 *
 * The rules are written here from the storefront's code, apart from the
 * runner's own copy (scripts/bambu-import/selection.ts), so a test of the
 * check against this page is not a test of one function against itself.
 * Knobs make the page wrong in one way at a time.
 */
import { productMediaForSelection, productVariantIdForSelection } from '../../packages/pricing/src/productSelectionMedia';
import type { ImportPayload } from '../../packages/catalog/src/bambuImport/payload';
import type { MediaAnswerRow } from '../../scripts/bambu-import/opsClient';
import type { ChipDriver, ProductPageDriver } from '../../scripts/bambu-import/browser';
import { NOT_OFFERED_AR, REQUEST_AR, UNPRICED_AR } from '../../scripts/bambu-import/browser';

type Group = ImportPayload['groups'][number];
type Value = Group['values'][number];

type Row = { url: string; primary: boolean; option_value_id: string | null; variant_id: string | null; via_variant_id: string | null };

const parts = (combo: string) => combo.split('|').filter((p) => p.startsWith('o:')).map((p) => p.slice(2));

export interface PageKnobs {
  /** The page shows this picture as the hero for these selections (a wrong binding). */
  heroFor?: (selection: readonly string[], right: string) => string;
  /** The page disables impossible values but shows no helper. */
  noHelper?: boolean;
  /** The page preselects every default even when they form no variant (the pre-§G.3 rule). */
  allDefaults?: boolean;
  /** The hero frame shows no picture (it failed); the thumbnails still do. */
  brokenHero?: boolean;
  /** The breadcrumb's text. */
  breadcrumb?: string;
}

export class ModelProductPage implements ProductPageDriver {
  selection: string[];
  clicks = 0;
  private readonly rows: Row[];

  constructor(
    readonly payload: ImportPayload,
    media: ReadonlyMap<string, MediaAnswerRow>,
    readonly knobs: PageKnobs = {}
  ) {
    const urlOf = (id: string) => {
      const m = media.get(id);
      return m && m.status === 'stored' ? `/files/${m.r2_key}` : '';
    };
    this.rows = payload.images
      .map((i, index) => ({ i, index }))
      .sort((a, b) => (a.i.is_primary !== b.i.is_primary ? (a.i.is_primary ? -1 : 1) : a.i.sort_order - b.i.sort_order || a.index - b.index))
      .map(({ i }) => ({ url: urlOf(i.source_media_id), primary: i.is_primary, option_value_id: i.option_value_id, variant_id: i.variant_id, via_variant_id: i.via_variant_id }))
      .filter((r) => r.url);
    this.selection = this.opening();
  }

  // ---------------------------------------------------------------- the chooser (productChooser.ts)

  private formsVariant(ids: readonly string[]): boolean {
    if (!this.payload.variants.length) return true;
    return this.payload.variants.some((v) => ids.every((id) => parts(v.combo_key).includes(id)));
  }

  /** Is the value offered with the other groups' current choices (the page enables it)? */
  offered(valueId: string, groupId: string): boolean {
    const others = this.payload.groups
      .filter((g) => g.id !== groupId)
      .map((g) => g.values.find((v) => this.selection.includes(v.id))?.id)
      .filter((id): id is string => !!id);
    return this.formsVariant([valueId, ...others]);
  }

  private opening(): string[] {
    const groups = this.payload.groups;
    const defaults = groups.filter((g) => g.default_value_id && g.values.some((v) => v.id === g.default_value_id)).map((g) => ({ group: g.id, id: g.default_value_id }));
    let chosen = this.knobs.allDefaults
      ? defaults
      : defaults.length && this.formsVariant(defaults.map((d) => d.id))
        ? defaults
        : defaults.length && this.formsVariant([defaults[0].id])
          ? [defaults[0]]
          : [];
    chosen = [...chosen];
    for (const g of groups) {
      if (g.values.length !== 1 || chosen.some((c) => c.group === g.id)) continue;
      if (this.formsVariant([...chosen.map((c) => c.id), g.values[0].id])) chosen.push({ group: g.id, id: g.values[0].id });
    }
    const order = new Map(groups.map((g, i) => [g.id, i]));
    return chosen.sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0)).map((c) => c.id);
  }

  private click(group: Group, value: Value): void {
    this.clicks++;
    const selected = this.selection.includes(value.id);
    this.selection = this.payload.groups.flatMap((g) => {
      if (g.id === group.id) return selected ? [] : [value.id];
      const kept = g.values.find((v) => this.selection.includes(v.id));
      return kept ? [kept.id] : [];
    });
  }

  // ---------------------------------------------------------------- the gallery (productGallery.ts)

  /** The gallery the page shows for its current selection (URLs, in order). */
  galleryUrls(): string[] {
    const selection = this.selection;
    const dedupe = (urls: string[]) => [...new Set(urls)];
    if (!selection.length) return dedupe(this.rows.map((r) => r.url));
    const groupOf = new Map<string, string>();
    for (const g of this.payload.groups) for (const v of g.values) groupOf.set(v.id, g.id);
    const chosen = new Map<string, string>();
    for (const id of selection) if (groupOf.has(id)) chosen.set(groupOf.get(id)!, id);
    const variants = new Map(this.payload.variants.map((v) => [v.id, parts(v.combo_key)]));
    const combos = [...variants.values()];
    const partClashes = (id: string) => {
      const g = groupOf.get(id);
      return !!g && chosen.has(g) && chosen.get(g) !== id;
    };
    const variantClashes = (id: string) => (variants.get(id) ?? []).some(partClashes);
    const contradicts = (b: Row) => {
      if (b.variant_id) return variantClashes(b.variant_id);
      if (b.via_variant_id && variantClashes(b.via_variant_id)) return true;
      if (b.option_value_id) {
        if (partClashes(b.option_value_id)) return true;
        if (combos.length && groupOf.has(b.option_value_id)) {
          const own = groupOf.get(b.option_value_id);
          const others = [...chosen.entries()].filter(([g]) => g !== own).map(([, id]) => id);
          if (!combos.some((p) => p.includes(b.option_value_id!) && others.every((o) => p.includes(o)))) return true;
        }
      }
      return false;
    };
    const kept = this.rows.filter((r) => !contradicts(r));
    const pool = kept.length ? kept : this.rows;
    const variantId = productVariantIdForSelection(this.payload.variants, { optionValueIds: selection });
    const ranked = productMediaForSelection(
      pool.map((r) => ({ ...r, color_id: null })),
      { optionValueIds: selection, variantId }
    );
    return dedupe(ranked.map((r) => r.url));
  }

  // ---------------------------------------------------------------- what the check reads

  async hero(): Promise<{ w: number; fit: string; src: string }> {
    if (this.knobs.brokenHero) return { w: 0, fit: '', src: '' };
    const right = this.galleryUrls()[0] ?? '';
    const src = this.knobs.heroFor ? this.knobs.heroFor(this.selection, right) : right;
    return { w: src ? 1000 : 0, fit: 'contain', src: src ? `https://levonis-iq.com${src}?w=960` : '' };
  }

  async text(): Promise<string> {
    return [this.knobs.breadcrumb ?? 'الرئيسية / قطع الغيار', UNPRICED_AR, REQUEST_AR, this.payload.product.title_en].join('\n');
  }

  async requestCta(): Promise<boolean> {
    return true;
  }

  async chip(group: Group, value: Value): Promise<ChipDriver | null> {
    if (!this.payload.groups.some((g) => g.id === group.id && g.values.some((v) => v.id === value.id))) return null;
    return {
      pressed: async () => this.selection.includes(value.id),
      disabled: async () => !this.offered(value.id, group.id),
      helper: async () => !this.knobs.noHelper && !this.offered(value.id, group.id),
      click: async () => {
        if (!this.offered(value.id, group.id)) return; // a disabled button does nothing
        this.click(group, value);
      },
    };
  }

  async gallery(): Promise<string[]> {
    const urls = this.galleryUrls();
    return urls.length > 1 ? urls.map((u) => `https://levonis-iq.com${u}?w=96`) : [];
  }

  async settle(): Promise<void> {}
}

export { NOT_OFFERED_AR };
