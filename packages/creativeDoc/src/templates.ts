/**
 * TEMPLATES AND FAMILIES (spec §7, §11, §12).
 *
 * A template is a STRUCTURE, not a picture: an ordered stack (or a split of
 * two stacks) of slots, each with its type role, line limit, optionality and
 * the gap after it, plus the product slot's share of the height. The layout
 * engine (`layout.ts`) turns a template + the real copy + the real product
 * picture + a format into absolute layers, measuring the real text — so the
 * same template re-flows into 1080×1080, 1080×1350 and 1080×1920 instead of
 * stretching (spec §24).
 *
 * VARIANTS are the three genuinely different compositions the studio
 * proposes before final output (spec §12): product-first, price-first and
 * feature-first. Which ones apply follows the objective — a lesson is never
 * forced into a price ad (`variantsFor`).
 *
 * FAMILIES (new arrival, back in stock, price offer, education, comparison,
 * service) choose a template, a default variant and an objective. A family's
 * badge ("just arrived", "back in stock") is a CLAIM: it is drawn only when
 * the request carries the evidence for it (`BuildEvidence`).
 */
import type { TypeRole } from './brand';
import type { AdLocale, LayerRole, Objective, TextAlign, VisualPriority } from './schema';
import type { Localized, PriceStatus, SnapshotAvailability } from './snapshot';

export type TemplateId = 'product_hero' | 'compact_product' | 'service_card' | 'comparison' | 'education_slide';
export type VariantId = 'product_first' | 'price_first' | 'feature_first' | 'headline_first';
export type FamilyId = 'new_arrival' | 'back_in_stock' | 'price_offer' | 'education' | 'comparison' | 'service';

export const TEMPLATE_IDS: readonly TemplateId[] = ['product_hero', 'compact_product', 'service_card', 'comparison', 'education_slide'];
export const VARIANT_IDS: readonly VariantId[] = ['product_first', 'price_first', 'feature_first', 'headline_first'];
export const FAMILY_IDS: readonly FamilyId[] = ['new_arrival', 'back_in_stock', 'price_offer', 'education', 'comparison', 'service'];

/** Slots a person or Claude writes. Everything else is bound to data. */
export type CopySlot = 'headline' | 'subhead' | 'body' | 'cta' | 'badge' | 'feature';

export type TextSlot =
  | { slot: 'headline' | 'subhead' | 'body' | 'cta' | 'badge'; source: 'copy' }
  | { slot: 'features'; source: 'copy' }
  | { slot: 'product_name' | 'price' | 'price_note' | 'availability'; source: 'product'; productSlot?: string }
  | { slot: 'service_title' | 'service_summary' | 'service_conditions'; source: 'service' }
  | { slot: 'slide_number'; source: 'slide' };

export interface TextBlock {
  kind: 'text';
  text: TextSlot;
  role: LayerRole;
  type: TypeRole;
  /** Multiplies the brand size for this variant (a price-first price is bigger). */
  boost: number;
  maxLines: number;
  align: TextAlign;
  /** May be dropped when space runs out (lowest `keep` first) or when density is `brief`. */
  optional: boolean;
  /** Higher keeps longer when the layout must shrink or drop. */
  keep: number;
  /** Shown only in `detailed` density. */
  detailedOnly?: boolean;
  gapAfter: 'small' | 'medium' | 'large';
  /** Drawn on a chip (CTA, badge). */
  chip?: boolean;
}

export interface ProductBlock {
  kind: 'product';
  productSlot: string;
  /** Share of the stack area height the product may take. */
  minFrac: number;
  maxFrac: number;
  /** Share of the column width the product may take. */
  widthFrac: number;
  gapAfter: 'small' | 'medium' | 'large';
  shadow: boolean;
}

export type StackBlock = TextBlock | ProductBlock;

export interface VariantDef {
  id: VariantId;
  label: Localized;
  priority: VisualPriority;
  /** `stack`: one column. `split`: text column on the start side, product column on the end side. `pair`: two product columns. */
  layout: 'stack' | 'split' | 'pair';
  blocks: StackBlock[];
  /** For split: the text column's share of the width. */
  textColumn?: number;
  /** Vertical placement of the stack when there is spare height. */
  justify: 'center' | 'start' | 'spread';
}

export interface TemplateDef {
  id: TemplateId;
  version: number;
  label: Localized;
  /** What kind of subject it is made for (spec §14: a wide printer, a round spool and a service each need their own structure). */
  subject: 'product_wide' | 'product_compact' | 'service' | 'two_products' | 'lesson';
  needs: { products: 0 | 1 | 2; service: boolean };
  variants: Partial<Record<VariantId, VariantDef>>;
}

const T = (type: TypeRole, text: TextSlot, role: LayerRole, o: Partial<TextBlock> = {}): TextBlock => ({
  kind: 'text', text, role, type, boost: 1, maxLines: 2, align: 'center', optional: false, keep: 5, gapAfter: 'medium', ...o,
});
const P = (o: Partial<ProductBlock> = {}): ProductBlock => ({
  kind: 'product', productSlot: 'main', minFrac: 0.3, maxFrac: 0.55, widthFrac: 0.86, gapAfter: 'medium', shadow: true, ...o,
});

const headline = (o: Partial<TextBlock> = {}) => T('headline', { slot: 'headline', source: 'copy' }, 'headline', { keep: 9, ...o });
const subhead = (o: Partial<TextBlock> = {}) => T('subhead', { slot: 'subhead', source: 'copy' }, 'subhead', { optional: true, keep: 3, detailedOnly: true, ...o });
// A badge only exists with evidence (or the owner's own words), and it IS the message of a family post — it outranks the other optional blocks.
const badge = (o: Partial<TextBlock> = {}) => T('badge', { slot: 'badge', source: 'copy' }, 'badge', { optional: true, keep: 7, maxLines: 1, chip: true, gapAfter: 'small', ...o });
const productName = (o: Partial<TextBlock> = {}) => T('product_name', { slot: 'product_name', source: 'product' }, 'product_name', { keep: 8, gapAfter: 'small', ...o });
const price = (o: Partial<TextBlock> = {}) => T('price', { slot: 'price', source: 'product' }, 'price', { keep: 8, maxLines: 1, gapAfter: 'small', ...o });
const priceNote = (o: Partial<TextBlock> = {}) => T('price_note', { slot: 'price_note', source: 'product' }, 'price_note', { optional: true, keep: 4, maxLines: 1, ...o });
const availability = (o: Partial<TextBlock> = {}) => T('price_note', { slot: 'availability', source: 'product' }, 'availability', { optional: true, keep: 6, maxLines: 1, ...o });
const features = (o: Partial<TextBlock> = {}) => T('feature', { slot: 'features', source: 'copy' }, 'feature', { optional: true, keep: 4, maxLines: 2, ...o });
// The call to action is one of the four essentials of an ad (spec §5: headline, product, price, CTA): never dropped for room, only shrunk to its floor.
const cta = (o: Partial<TextBlock> = {}) => T('cta', { slot: 'cta', source: 'copy' }, 'cta', { optional: false, keep: 8, maxLines: 1, chip: true, gapAfter: 'small', ...o });

const L = (ar: string, en: string, ckb: string): Localized => ({ ar, en, ckb });

export const VARIANT_LABELS: Readonly<Record<VariantId, Localized>> = {
  product_first: L('يبرز المنتج', 'Product first', 'بەرهەم لە پێشەوە'),
  price_first: L('يبرز السعر', 'Price first', 'نرخ لە پێشەوە'),
  feature_first: L('يبرز الميزة', 'Feature first', 'تایبەتمەندی لە پێشەوە'),
  headline_first: L('يبرز الرسالة', 'Message first', 'پەیام لە پێشەوە'),
};

export const TEMPLATES: Readonly<Record<TemplateId, TemplateDef>> = {
  // (أ) A printer with its price and one short fact. Wide products: one column, the product owns the middle.
  product_hero: {
    id: 'product_hero', version: 1, label: L('منتج مع سعر', 'Product with price', 'بەرهەم لەگەڵ نرخ'), subject: 'product_wide',
    needs: { products: 1, service: false },
    variants: {
      product_first: {
        id: 'product_first', label: VARIANT_LABELS.product_first, priority: 'product', layout: 'stack', justify: 'center',
        blocks: [badge(), headline(), subhead(), P({ minFrac: 0.5, maxFrac: 0.64 }), productName(), price(), availability(), cta({ gapAfter: 'small' })],
      },
      price_first: {
        id: 'price_first', label: VARIANT_LABELS.price_first, priority: 'price', layout: 'stack', justify: 'center',
        blocks: [badge(), headline({ boost: 0.82 }), P({ minFrac: 0.36, maxFrac: 0.5 }), productName(), price({ boost: 1.45, gapAfter: 'small' }), priceNote(), availability(), cta()],
      },
      feature_first: {
        id: 'feature_first', label: VARIANT_LABELS.feature_first, priority: 'feature', layout: 'stack', justify: 'center',
        blocks: [headline(), features({ optional: false, keep: 7 }), P({ minFrac: 0.3, maxFrac: 0.45 }), productName({ gapAfter: 'small' }), price({ boost: 0.85 }), cta()],
      },
    },
  },
  // (ب) Filament or an accessory: compact or round products sit beside the words, not under them.
  compact_product: {
    id: 'compact_product', version: 1, label: L('فلمنت أو إكسسوار', 'Filament or accessory', 'فیلامێنت یان پاشکۆ'), subject: 'product_compact',
    needs: { products: 1, service: false },
    variants: {
      product_first: {
        id: 'product_first', label: VARIANT_LABELS.product_first, priority: 'product', layout: 'split', textColumn: 0.5, justify: 'center',
        blocks: [badge({ align: 'start' }), headline({ align: 'start', maxLines: 3 }), subhead({ align: 'start', maxLines: 3 }), productName({ align: 'start' }), price({ align: 'start' }), availability({ align: 'start' }), cta({ align: 'start' }), P({ minFrac: 0.5, maxFrac: 0.82, widthFrac: 0.94 })],
      },
      price_first: {
        id: 'price_first', label: VARIANT_LABELS.price_first, priority: 'price', layout: 'split', textColumn: 0.56, justify: 'center',
        blocks: [headline({ align: 'start', boost: 0.85, maxLines: 3 }), productName({ align: 'start' }), price({ align: 'start', boost: 1.45 }), priceNote({ align: 'start' }), availability({ align: 'start' }), cta({ align: 'start' }), P({ minFrac: 0.45, maxFrac: 0.75, widthFrac: 0.92 })],
      },
      feature_first: {
        id: 'feature_first', label: VARIANT_LABELS.feature_first, priority: 'feature', layout: 'split', textColumn: 0.56, justify: 'center',
        blocks: [headline({ align: 'start', maxLines: 3 }), features({ align: 'start', optional: false, keep: 7 }), productName({ align: 'start' }), price({ align: 'start', boost: 0.85 }), cta({ align: 'start' }), P({ minFrac: 0.42, maxFrac: 0.7, widthFrac: 0.9 })],
      },
    },
  },
  // (ج) A service — warranty, delivery, a course — from an APPROVED service claim; the conditions line is never dropped.
  service_card: {
    id: 'service_card', version: 1, label: L('خدمة', 'Service', 'خزمەتگوزاری'), subject: 'service',
    needs: { products: 0, service: true },
    variants: {
      feature_first: {
        id: 'feature_first', label: VARIANT_LABELS.feature_first, priority: 'feature', layout: 'stack', justify: 'center',
        blocks: [
          headline({ maxLines: 2 }),
          T('subhead', { slot: 'service_summary', source: 'service' }, 'subhead', { keep: 8, maxLines: 3 }),
          features({ optional: true, keep: 5 }),
          T('note', { slot: 'service_conditions', source: 'service' }, 'price_note', { keep: 9, maxLines: 4, gapAfter: 'large' }),
          cta(),
        ],
      },
      headline_first: {
        id: 'headline_first', label: VARIANT_LABELS.headline_first, priority: 'headline', layout: 'stack', justify: 'center',
        blocks: [
          headline({ boost: 1.25, maxLines: 3, gapAfter: 'large' }),
          T('subhead', { slot: 'service_summary', source: 'service' }, 'subhead', { keep: 8, maxLines: 3 }),
          T('note', { slot: 'service_conditions', source: 'service' }, 'price_note', { keep: 9, maxLines: 4, gapAfter: 'large' }),
          cta(),
        ],
      },
    },
  },
  // Two products side by side, each with its own bound name and price (a price is never carried across).
  comparison: {
    id: 'comparison', version: 1, label: L('مقارنة', 'Comparison', 'بەراوردکردن'), subject: 'two_products',
    needs: { products: 2, service: false },
    variants: {
      product_first: {
        id: 'product_first', label: VARIANT_LABELS.product_first, priority: 'product', layout: 'pair', justify: 'center',
        blocks: [headline(), P({ productSlot: 'main', minFrac: 0.3, maxFrac: 0.5, widthFrac: 0.9 }), productName({ text: { slot: 'product_name', source: 'product', productSlot: 'main' } }), price({ text: { slot: 'price', source: 'product', productSlot: 'main' } }), cta()],
      },
    },
  },
  // One slide of a lesson or carousel: words lead, an optional product picture supports.
  education_slide: {
    id: 'education_slide', version: 1, label: L('شريحة تعليمية', 'Lesson slide', 'سلایدی فێرکاری'), subject: 'lesson',
    needs: { products: 0, service: false },
    variants: {
      feature_first: {
        id: 'feature_first', label: VARIANT_LABELS.feature_first, priority: 'feature', layout: 'stack', justify: 'center',
        blocks: [
          T('note', { slot: 'slide_number', source: 'slide' }, 'slide_number', { optional: true, keep: 1, maxLines: 1, gapAfter: 'small' }),
          headline({ align: 'start', maxLines: 3 }),
          T('body', { slot: 'body', source: 'copy' }, 'body', { align: 'start', maxLines: 6, keep: 8 }),
          features({ align: 'start' }),
          P({ minFrac: 0, maxFrac: 0.4, widthFrac: 0.7 }),
          cta({ align: 'start' }),
        ],
      },
    },
  },
};

export function isTemplateId(v: unknown): v is TemplateId {
  return typeof v === 'string' && (TEMPLATE_IDS as readonly string[]).includes(v);
}
export function isVariantId(v: unknown): v is VariantId {
  return typeof v === 'string' && (VARIANT_IDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

export interface FamilyDef {
  id: FamilyId;
  label: Localized;
  objective: Objective;
  template: TemplateId;
  variant: VariantId;
  /** The badge words, drawn only with the matching evidence. */
  badge: { text: Localized; needs: keyof BuildEvidence } | null;
}

/** What the request PROVES. The Worker sets these from its own records, never from a model. */
export interface BuildEvidence {
  /** A documented arrival (first sellable within the window, after the baseline import). */
  arrival: boolean;
  /** A documented unavailable → available transition. */
  back_in_stock: boolean;
  /** A live public offer on the bound product. */
  offer: boolean;
}

export const NO_EVIDENCE: BuildEvidence = Object.freeze({ arrival: false, back_in_stock: false, offer: false });

export const FAMILIES: Readonly<Record<FamilyId, FamilyDef>> = {
  new_arrival: { id: 'new_arrival', label: L('منتج جديد', 'New arrival', 'بەرهەمی نوێ'), objective: 'arrival', template: 'product_hero', variant: 'product_first', badge: { text: L('وصل حديثاً', 'Just arrived', 'تازە گەیشت'), needs: 'arrival' } },
  back_in_stock: { id: 'back_in_stock', label: L('عودة التوفر', 'Back in stock', 'گەڕانەوەی بەردەستبوون'), objective: 'back_in_stock', template: 'product_hero', variant: 'product_first', badge: { text: L('عاد للتوفر', 'Back in stock', 'دووبارە بەردەستە'), needs: 'back_in_stock' } },
  price_offer: { id: 'price_offer', label: L('عرض سعر', 'Price offer', 'پێشکەشکردنی نرخ'), objective: 'sell', template: 'product_hero', variant: 'price_first', badge: { text: L('عرض خاص', 'Special offer', 'ئۆفەری تایبەت'), needs: 'offer' } },
  education: { id: 'education', label: L('تعليم / كاروسيل', 'Lesson / carousel', 'فێرکاری / کارۆسێل'), objective: 'education', template: 'education_slide', variant: 'feature_first', badge: null },
  comparison: { id: 'comparison', label: L('مقارنة', 'Comparison', 'بەراوردکردن'), objective: 'comparison', template: 'comparison', variant: 'product_first', badge: null },
  service: { id: 'service', label: L('خدمة', 'Service', 'خزمەتگوزاری'), objective: 'service_trust', template: 'service_card', variant: 'feature_first', badge: null },
};

/**
 * The template that fits a product picture: wide subjects (printers) get the
 * hero column, compact or round ones (spools, nozzles) sit beside the words.
 * Uses the picture's real proportions, never a guess about what it shows.
 */
export function templateForProduct(image: { width: number | null; height: number | null } | null): TemplateId {
  if (!image || !image.width || !image.height) return 'product_hero';
  // Catalogue photos are often square canvases with padding around a wide
  // printer, so only a clearly TALL picture (a spool on its side, a bottle)
  // goes beside the words; the owner can switch either way.
  return image.width / image.height <= 0.8 ? 'compact_product' : 'product_hero';
}

/**
 * The variants worth proposing for an objective, in order (spec §12: the
 * proposals follow the post's goal; a price layout needs a real public price).
 */
export function variantsFor(template: TemplateId, objective: Objective, priceStatus: PriceStatus | null, priority?: VisualPriority): VariantId[] {
  const def = TEMPLATES[template];
  const available = Object.keys(def.variants) as VariantId[];
  const priced = priceStatus === 'priced';
  // A lesson or a feature post never leads with a price (spec §7: the composition follows the goal).
  const order: VariantId[] =
    objective === 'education' || objective === 'feature' ? ['feature_first', 'product_first', 'headline_first']
    : objective === 'service_trust' ? ['feature_first', 'headline_first', 'product_first']
    : objective === 'sell' ? ['product_first', 'price_first', 'feature_first', 'headline_first']
    : ['product_first', 'feature_first', 'price_first', 'headline_first'];
  const allowed = order.filter((v) => available.includes(v) && (v !== 'price_first' || priced));
  if (!priority) return allowed;
  // The element the owner chose as most important leads (spec §11), when this template has a variant for it.
  const lead = allowed.find((v) => def.variants[v]?.priority === priority);
  return lead ? [lead, ...allowed.filter((v) => v !== lead)] : allowed;
}

/** The call to action that matches what the product can actually do right now (spec §9: availability is never overstated). */
export function defaultCta(availability: SnapshotAvailability | null, priceStatus: PriceStatus | null, locale: AdLocale): string {
  const words =
    priceStatus === 'unpriced' ? L('اسألنا عن السعر', 'Ask us for the price', 'نرخەکەمان لێ بپرسە')
    : availability === 'available' ? L('اطلبها الآن', 'Order now', 'ئێستا داوای بکە')
    : availability === 'preorder' ? L('احجزها مسبقاً', 'Pre-order now', 'پێشوەختە داوای بکە')
    : availability === 'unavailable' ? L('نبّهني عند التوفر', 'Notify me when available', 'ئاگادارم بکەرەوە کاتێک بەردەست بوو')
    : availability === null ? L('اعرف التفاصيل', 'Learn more', 'وردەکارییەکان بزانە')
    : L('اعرف التفاصيل', 'Learn more', 'وردەکارییەکان بزانە');
  return words[locale];
}
