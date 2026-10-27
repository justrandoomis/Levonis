/**
 * What the editor knows besides the document — the bound snapshots, the
 * approved claims and assets, the brand kit — turned into the contexts the
 * shared package asks for (AllowedAssets for applyOps, ClaimState for the
 * quality check, BindingContext for bound text, RebuildContext for a
 * re-layout). Pure, so the rules (only the bound variant’s own same-origin
 * pictures, only approved assets) are tested in node.
 */
import type { AssetDto, BrandDto, ClaimDto, OpportunityDto, ProductListItemDto } from '../../../packages/creativeDoc/src/api';
import type { BrandKit } from '../../../packages/creativeDoc/src/brand';
import type { BindingContext, RebuildContext } from '../../../packages/creativeDoc/src/layout';
import type { AllowedAssets } from '../../../packages/creativeDoc/src/ops';
import type { ClaimState } from '../../../packages/creativeDoc/src/quality';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import type { ProductSnapshot, ServiceClaimText } from '../../../packages/creativeDoc/src/snapshot';
import type { BuildEvidence } from '../../../packages/creativeDoc/src/templates';
import { formatIqd, type TextMeasurer } from '../../../packages/creativeDoc/src/text';

export interface EditorData {
  brand: BrandDto;
  /** By product binding slot. */
  snapshots: Record<string, ProductSnapshot>;
  claims: ClaimDto[];
  assets: AssetDto[];
  opportunities: OpportunityDto[];
}

/** The pictures a person (or Claude) may place: the bound variant’s own same-origin pictures, approved assets, approved logos. */
export function allowedAssets(doc: CreativeDocument, data: EditorData): AllowedAssets {
  const products: Record<string, Array<{ url: string; width: number; height: number }>> = {};
  for (const b of doc.products) {
    const snap = data.snapshots[b.slot];
    if (!snap) continue;
    products[b.slot] = snap.data.images
      .filter((i) => i.same_origin && i.width && i.height && (i.variant_key === null || b.variant_key === null || i.variant_key === b.variant_key))
      .map((i) => ({ url: i.url, width: i.width as number, height: i.height as number }));
  }
  const approved = data.assets.filter((a) => a.review === 'approved' && a.width && a.height);
  return {
    products,
    assets: approved.filter((a) => a.kind !== 'logo').map((a) => ({ id: a.id, width: a.width as number, height: a.height as number, kind: a.kind })),
    logos: [
      { ref: 'site', width: data.brand.site_logo.width, height: data.brand.site_logo.height },
      ...approved.filter((a) => a.kind === 'logo').map((a) => ({ ref: a.id, width: a.width as number, height: a.height as number })),
    ],
  };
}

export function claimText(c: ClaimDto): ServiceClaimText {
  return { id: c.id, version: c.version, title: c.title, summary: c.summary, conditions: c.conditions, details_path: c.details_path };
}

export function claimStates(claims: readonly ClaimDto[]): Record<string, ClaimState> {
  return Object.fromEntries(claims.map((c) => [c.id, { ...claimText(c), approved: c.status === 'approved', valid_until: c.valid_until }]));
}

export function claimTexts(claims: readonly ClaimDto[]): Record<string, ServiceClaimText> {
  return Object.fromEntries(claims.filter((c) => c.status === 'approved').map((c) => [c.id, claimText(c)]));
}

export function bindingContext(doc: CreativeDocument, data: EditorData): BindingContext {
  return { snapshots: data.snapshots, claims: claimTexts(data.claims), brand: data.brand.kit, locale: doc.locale, slide: doc.slide };
}

/**
 * What the shop PROVES about the main product, from its own records: a live
 * public offer is in the snapshot; an arrival or a return to stock is an
 * opportunity the server detected. Never from a model.
 */
export function evidenceFor(productId: string | null, snapshot: ProductSnapshot | null, opportunities: readonly OpportunityDto[]): BuildEvidence {
  return {
    arrival: !!productId && opportunities.some((o) => o.kind === 'arrival' && o.ref === productId),
    back_in_stock: !!productId && opportunities.some((o) => o.kind === 'back_in_stock' && o.ref === productId),
    offer: !!snapshot?.data.price.offer || (!!productId && opportunities.some((o) => o.kind === 'offer' && o.ref === productId)),
  };
}

/** The natural size of the brand’s default background when it is an approved asset. */
export function backgroundNatural(kit: BrandKit, assets: readonly AssetDto[]): { width: number; height: number } | null {
  const bg = kit.backgrounds.find((b) => b.id === kit.default_background);
  if (!bg || bg.kind !== 'asset' || !bg.asset_id) return null;
  const a = assets.find((x) => x.id === bg.asset_id && x.review === 'approved');
  return a && a.width && a.height ? { width: a.width, height: a.height } : null;
}

export function logoNatural(kit: BrandKit, brand: BrandDto, assets: readonly AssetDto[]): { width: number; height: number } | null {
  if (kit.logo.asset === 'site') return brand.site_logo;
  const a = assets.find((x) => x.id === kit.logo.asset && x.review === 'approved');
  return a && a.width && a.height ? { width: a.width, height: a.height } : null;
}

export function rebuildContext(doc: CreativeDocument, data: EditorData, measure: TextMeasurer): RebuildContext {
  const main = doc.products[0] ?? null;
  const snap = main ? data.snapshots[main.slot] ?? null : null;
  return {
    brand: data.brand.kit,
    brandVersion: data.brand.version,
    snapshots: data.snapshots,
    claims: claimTexts(data.claims),
    evidence: evidenceFor(main?.product_id ?? null, snap, data.opportunities),
    family: null,
    logo: logoNatural(data.brand.kit, data.brand, data.assets),
    backgroundNatural: backgroundNatural(data.brand.kit, data.assets),
    measure,
  };
}

/** A snapshot marked `test` anywhere in the design — the editor says so on screen. */
export function usesTestData(doc: CreativeDocument, data: Pick<EditorData, 'snapshots'>): boolean {
  return doc.products.some((b) => data.snapshots[b.slot]?.source === 'test');
}

/**
 * The price beside a product in the studio’s admin search — the guest price
 * the server computed, as a plain IQD label for the owner choosing a product.
 * It is never drawn into an ad: an ad’s price is a binding rendered from the
 * snapshot (`renderPrice`), and the shop’s display-currency hook is for
 * customer-facing screens, which this is not.
 */
export function searchPriceLabel(item: Pick<ProductListItemDto, 'price_status' | 'display_price_iqd'>): string | null {
  return item.price_status === 'priced' && item.display_price_iqd !== null ? formatIqd(item.display_price_iqd, { digits: 'latn', label: 'IQD' }) : null;
}
