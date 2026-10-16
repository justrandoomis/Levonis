/**
 * A BAMBU FIXTURE AS THE PRODUCT PAGE RECEIVES IT (the import spec §C.4,
 * §G.1, §G.3): the import's own option model and media plan
 * (packages/catalog/src/bambuImport options.ts / media.ts) turned into the
 * page body's relations shapes — `option_groups` with their 0194 kind,
 * labels and default, `variants[].combo_key`, and one image row per binding
 * (a value_set picture is several rows of ONE url, as the import stores it),
 * with `via_variant_id` on the representative rows.
 *
 * Used by tests/productGallerySelection.test.ts and the local e2e seed, so the
 * client rule is tested on the import's real bindings, not hand-made ones.
 */
import { buildOptions, newProductId, type OptionModel } from '../../packages/catalog/src/bambuImport/options';
import { planMedia, type MediaPlan } from '../../packages/catalog/src/bambuImport/media';
import { sample, type SampleHandle } from './bambu/load';

/** Gallery entries the import only knows to be copies after ingestion (tests/bambuMediaBinding.test.ts). */
const DUPLICATES: Partial<Record<SampleHandle, Record<number, number>>> = {
  a1: { 3: 0, 4: 1 },
  h2d: { 5: 0, 6: 1, 7: 2 },
};

export interface FixtureImage {
  id: string;
  url: string;
  primary: boolean;
  order: number;
  option_value_id: string | null;
  color_id: string | null;
  variant_id: string | null;
  via_variant_id?: string;
  /** The source file name, for assertions (`FAP035`, `H2DC` …). */
  file: string;
}

export interface FixtureRelations {
  productId: string;
  title: string;
  model: OptionModel;
  media: MediaPlan;
  option_groups: Array<{
    id: string;
    name_en: string;
    name_ar: string;
    name_ckb: string;
    kind: string;
    default_value_id: string;
    sort: number;
    values: Array<{ id: string; name_en: string; sort: number }>;
  }>;
  variants: Array<{ id: string; combo_key: string }>;
  images: FixtureImage[];
  /** Value names → ids, for readable tests. */
  valueId: (name: string) => string;
  fileOf: (url: string) => string;
}

export function fixtureRelations(handle: SampleHandle): FixtureRelations {
  const x = sample(handle);
  const productId = newProductId(x.sourceProductId);
  const model = buildOptions(x, productId);
  const dup = DUPLICATES[handle] ?? {};
  const keyOf = new Map(x.gallery.map((g, i) => [g.resourceFileId, `k${dup[i] ?? i}`]));
  const media = planMedia({ productId, title: x.title, gallery: x.gallery, model, contentKey: (rid) => keyOf.get(rid) });
  const names = new Map(
    x.gallery.map((g) => [g.resourceFileId, (g.url.split('/').pop() ?? '').replace(/-compressed/g, '').replace(/\.[a-z]+$/i, '')])
  );
  const urlOf = (rid: string) => `/files/products/import/gallery/${(names.get(rid) ?? rid).replace(/[^A-Za-z0-9_-]/g, '_')}.webp`;
  const images: FixtureImage[] = media.rows.map((r) => ({
    id: r.id,
    url: urlOf(r.resourceFileId),
    primary: r.isPrimary,
    order: r.sortOrder,
    option_value_id: r.optionValueId,
    color_id: null,
    variant_id: r.variantId,
    ...(r.viaVariantId ? { via_variant_id: r.viaVariantId } : {}),
    file: names.get(r.resourceFileId) ?? r.resourceFileId,
  }));
  const byUrl = new Map(images.map((i) => [i.url, i.file]));
  const all = model.groups.flatMap((g) => g.values);
  return {
    productId,
    title: x.title,
    model,
    media,
    option_groups: model.groups.map((g) => ({
      id: g.id,
      name_en: g.nameEn,
      name_ar: g.nameAr,
      name_ckb: g.nameCkb,
      kind: g.kind,
      default_value_id: g.defaultValueId,
      sort: g.position,
      values: g.values.map((v, i) => ({ id: v.id, name_en: v.nameEn, sort: i })),
    })),
    variants: model.variants.map((v) => ({ id: v.id, combo_key: v.comboKey })),
    images,
    valueId: (name: string) => {
      const hit = all.find((v) => v.nameEn === name);
      if (!hit) throw new Error(`no value ${name} in ${handle}: ${all.map((v) => v.nameEn).join(', ')}`);
      return hit.id;
    },
    fileOf: (url: string) => byUrl.get(url) ?? url,
  };
}
