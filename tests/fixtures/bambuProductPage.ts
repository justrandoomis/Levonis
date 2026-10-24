/**
 * A MODEL OF THE STOREFRONT'S PRODUCT PAGE FOR AN IMPORTED PRODUCT, for the
 * browser check's tests (scripts/bambu-import/browser.ts `inspectProductPage`).
 *
 * It behaves the way the final page of build step 7 does, because it RUNS the
 * page's own pure modules over the page body's shapes (src/pages/Product.tsx):
 * src/lib/productChooser.ts for the opening selection (`defaultSelection`), the
 * «not offered» marks (`valueOffered`) and a press (`chooseValue`: an unoffered
 * value is taken and the clashing values of other groups let go, a group left
 * with one fitting value taking it; the chosen value un-presses), and
 * src/lib/productGallery.ts for the gallery (`mediaInStoredOrder`,
 * `galleryForSelection`); the hero is the gallery's first picture; the
 * knowledge tabs are src/lib/productKnowledge.ts `knowledgeTabs` of the answer
 * the page was served, the US 110 V rows under «إصدارات أخرى».
 *
 * The runner states its expectation through the same modules (selection.ts),
 * so this model is not a second opinion on the RULES: it is the page those
 * rules draw. What the tests prove is the check's reading and judging — and
 * knobs make the page wrong in one way at a time.
 */
import type { ImportPayload } from '../../packages/catalog/src/bambuImport/payload';
import { productVariantIdForSelection } from '../../packages/pricing/src/productSelectionMedia';
import { chooseValue, defaultSelection, valueOffered } from '../../src/lib/productChooser';
import { galleryForSelection, mediaInStoredOrder } from '../../src/lib/productGallery';
import { knowledgeTabs, rowsForSelection, type KnowledgeAnswer } from '../../src/lib/productKnowledge';
import type { MediaAnswerRow } from '../../scripts/bambu-import/opsClient';
import type { ChipDriver, KnowledgeView, ProductPageDriver } from '../../scripts/bambu-import/browser';
import { NOT_OFFERED_AR, REQUEST_AR, UNPRICED_AR } from '../../scripts/bambu-import/browser';

type Group = ImportPayload['groups'][number];
type Value = Group['values'][number];

type Row = { id: string; url: string; primary: boolean; order: number; option_value_id: string | null; variant_id: string | null; via_variant_id: string | null; color_id: null };

export interface PageKnobs {
  /** The page shows this picture as the hero for these selections (a wrong binding). */
  heroFor?: (selection: readonly string[], right: string) => string;
  /** The page marks unoffered values but says nothing (no line, no accessible name, no note). */
  noHelper?: boolean;
  /** The page disables unoffered values (the dead end of §1 row 27). */
  disableUnoffered?: boolean;
  /** The page marks nothing as unoffered. */
  noMarks?: boolean;
  /** A press keeps every other group's value (the pre-review rule), so a clash stays selected. */
  keepOnPress?: boolean;
  /** The page preselects every default even when they form no variant (the pre-§G.3 rule). */
  allDefaults?: boolean;
  /** The hero frame shows no picture (it failed); the thumbnails still do. */
  brokenHero?: boolean;
  /** The breadcrumb's text. */
  breadcrumb?: string;
  /** The knowledge answer the page was served (default: none — no tabs). */
  knowledge?: KnowledgeAnswer;
  /** The tabs draw the US 110 V rows among the shown ones (outside «إصدارات أخرى»). */
  usInTable?: boolean;
}

export class ModelProductPage implements ProductPageDriver {
  selection: string[];
  clicks = 0;
  private readonly rows: Row[];
  private readonly groups: ImportPayload['groups'];

  constructor(
    readonly payload: ImportPayload,
    media: ReadonlyMap<string, MediaAnswerRow>,
    readonly knobs: PageKnobs = {}
  ) {
    const urlOf = (id: string) => {
      const m = media.get(id);
      return m && m.status === 'stored' ? `/files/${m.r2_key}` : '';
    };
    this.groups = payload.groups.filter((g) => g.values.length > 0);
    this.rows = mediaInStoredOrder(
      payload.images
        .map((i): Row => ({ id: i.id, url: urlOf(i.source_media_id), primary: i.is_primary, order: i.sort_order, option_value_id: i.option_value_id, variant_id: i.variant_id, via_variant_id: i.via_variant_id, color_id: null }))
        .filter((r) => r.url)
    );
    this.selection = this.opening();
  }

  // ---------------------------------------------------------------- the chooser (productChooser.ts)

  /** Is the value offered with the other groups' current choices (the page leaves it unmarked)? */
  offered(valueId: string, groupId: string): boolean {
    return valueOffered(valueId, groupId, this.selection, this.groups, this.payload.variants);
  }

  private opening(): string[] {
    if (!this.knobs.allDefaults) return [];
    const defaults = this.groups.filter((g) => g.default_value_id && g.values.some((v) => v.id === g.default_value_id)).map((g) => g.default_value_id);
    const singles = this.groups.filter((g) => g.values.length === 1 && !g.default_value_id).map((g) => g.values[0].id);
    return [...defaults, ...singles];
  }

  private press(group: Group, value: Value): void {
    this.clicks++;
    if (this.knobs.keepOnPress) {
      const selected = this.selection.includes(value.id);
      this.selection = this.groups.flatMap((g) => {
        if (g.id === group.id) return selected ? [] : [value.id];
        const kept = g.values.find((v) => this.selection.includes(v.id));
        return kept ? [kept.id] : [];
      });
      return;
    }
    this.selection = chooseValue(value.id, group.id, this.selection, this.groups, this.payload.variants);
  }

  // ---------------------------------------------------------------- the gallery (productGallery.ts)

  /** The gallery the page shows for its current selection (URLs, in order). */
  galleryUrls(): string[] {
    const variantId = productVariantIdForSelection(this.payload.variants, { optionValueIds: this.selection });
    return galleryForSelection(this.rows, this.rows, { groups: this.groups, variants: this.payload.variants, completeVariants: true }, { optionValueIds: this.selection, variantId }).map((r) => r.url);
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
    if (!this.groups.some((g) => g.id === group.id && g.values.some((v) => v.id === value.id))) return null;
    const marked = () => !this.knobs.noMarks && !this.offered(value.id, group.id);
    return {
      pressed: async () => this.selection.includes(value.id),
      notOffered: async () => marked(),
      disabled: async () => !!this.knobs.disableUnoffered && !this.offered(value.id, group.id),
      helper: async () => !this.knobs.noHelper && marked(),
      click: async () => {
        if (this.knobs.disableUnoffered && !this.offered(value.id, group.id)) return; // a disabled button does nothing
        this.press(group, value);
      },
    };
  }

  async pressedValues(): Promise<string[]> {
    return [...this.selection];
  }

  async gallery(): Promise<string[]> {
    const urls = this.galleryUrls();
    return urls.length > 1 ? urls.map((u) => `https://levonis-iq.com${u}?w=96`) : [];
  }

  async knowledge(): Promise<KnowledgeView> {
    const k = this.knobs.knowledge;
    if (!k) return { shown: false, tabs: [], usNotes: 0, usOutside: 0 };
    const ids = this.selection.length ? this.selection : defaultSelection(this.groups, this.payload.variants);
    const sel = { optionValueIds: ids, variantId: productVariantIdForSelection(this.payload.variants, { optionValueIds: ids }) };
    const tabs = knowledgeTabs(k, sel);
    // The US 110 V rows the tabs draw: the specs' and materials' «إصدارات أخرى», and the packaging tab's.
    const tables = [...tabs.specs, ...tabs.materials].map((g) => rowsForSelection(g.rows, sel));
    const us = [...tables.flatMap((t) => [...t.shown, ...t.hidden]), ...tabs.packaging.other].filter((r) => r.region === 'us_110v').length;
    return { shown: tabs.order.length > 0, tabs: [...tabs.order], usNotes: us, usOutside: this.knobs.usInTable ? us : 0 };
  }

  async settle(): Promise<void> {}
}

export { NOT_OFFERED_AR };
