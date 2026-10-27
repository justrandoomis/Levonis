/**
 * What the carousel and batch screens need to lay a design out the way New
 * design does: the approved brand kit, the reviewed assets (logo and
 * background sizes), the shop's opportunities (badge evidence), the brand
 * fonts loaded, and a product's first same-site picture with its size.
 */
import type { AssetDto, BrandDto, OpportunityDto } from '../../../packages/creativeDoc/src/api';
import type { ProductSnapshot } from '../../../packages/creativeDoc/src/snapshot';
import { ai, assets as assetsApi, brand as brandApi } from './client';
import { ensureNeeds, kitFontNeeds } from './fonts';

export interface BuildKit { brand: BrandDto; assets: AssetDto[]; opportunities: OpportunityDto[] }

export async function loadBuildKit(known: BrandDto | null): Promise<BuildKit> {
  const [brand, assets, opportunities] = await Promise.all([known ? Promise.resolve(known) : brandApi.get(), assetsApi.list(), ai.opportunities()]);
  return { brand, assets, opportunities };
}

/** Loads the brand faces for these words; answers the faces that failed. */
export async function loadFonts(kit: BuildKit, sample: string): Promise<string[]> {
  const k = kit.brand.kit;
  return (await ensureNeeds(kitFontNeeds([k.fonts.primary, k.fonts.display], `${sample} 0123456789 د.ع`))).failed;
}

function naturalSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The snapshot's first SAME-ORIGIN picture (a remote one would taint the export canvas), or null. */
export async function firstPicture(snapshot: ProductSnapshot): Promise<{ url: string; width: number; height: number } | null> {
  for (const img of snapshot.data.images) {
    if (!img.same_origin) continue;
    const size = img.width && img.height ? { width: img.width, height: img.height } : await naturalSize(img.url);
    if (size) return { url: img.url, ...size };
  }
  return null;
}
