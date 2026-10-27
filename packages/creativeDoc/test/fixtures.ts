/**
 * Test fixtures — every price, name and picture here is MARKED test data
 * (source: 'test', "TEST" in names); none is a Levonis price.
 */
import { defaultBrandKit } from '../src/brand';
import { buildFromTemplate, type BuildInput, type BuildProduct } from '../src/layout';
import { FORMATS, type DocFormat } from '../src/schema';
import type { ProductSnapshot, ProductSnapshotData } from '../src/snapshot';
import { NO_EVIDENCE } from '../src/templates';
import { approximateMeasurer } from '../src/text';

export function snapshotData(over: Partial<ProductSnapshotData> = {}): ProductSnapshotData {
  return {
    product_id: 'p_test_a1',
    slug: 'test-printer-a1',
    path: '/product/test-printer-a1',
    variant_key: 'combo',
    variant_label: { ar: 'كومبو (تجريبي)', en: 'Combo (test)', ckb: 'کۆمبۆ (تاقیکاری)' },
    name: { ar: 'طابعة Bambu Lab A1 Combo تجريبية', en: 'TEST Bambu Lab A1 Combo', ckb: 'چاپکەری Bambu Lab A1 Combo تاقیکاری' },
    brand: { ar: 'Bambu Lab', en: 'Bambu Lab', ckb: 'Bambu Lab' },
    category: null,
    sku: 'TEST-A1C',
    short_description: { ar: '', en: '', ckb: '' },
    specs: [],
    contents: [{ text: 'AMS lite', qty: 1 }],
    price: { status: 'priced', amount_iqd: 1250000, regular_iqd: null, from: false, offer: null, member_price_iqd: null },
    availability: 'available',
    sale_types: ['direct_sale'],
    images: [
      { url: '/files/products/test/a1-combo-front.webp', width: 1200, height: 800, alt: 'front', primary: true, variant_key: 'combo', same_origin: true },
      { url: '/files/products/test/a1-combo-side.webp', width: 900, height: 900, alt: 'side', primary: false, variant_key: 'combo', same_origin: true },
      { url: '/files/products/test/a1-solo.webp', width: 1000, height: 800, alt: 'solo', primary: false, variant_key: 'solo', same_origin: true },
    ],
    source_updated_at: '2026-10-20T10:00:00Z',
    ...over,
  };
}

export function snapshot(over: Partial<ProductSnapshotData> = {}, source: ProductSnapshot['source'] = 'test'): ProductSnapshot {
  return { id: 'snap_test_0001', data: snapshotData(over), hash: 'x'.repeat(64), source, fetched_at: '2026-10-27T09:00:00Z' };
}

export function product(snap = snapshot(), imageIndex = 0): BuildProduct {
  const img = snap.data.images[imageIndex];
  return { slot: 'main', snapshot: snap, image: { url: img.url, width: img.width!, height: img.height! } };
}

export function buildInput(over: Partial<BuildInput> = {}): BuildInput {
  return {
    template: 'product_hero',
    variant: 'product_first',
    format: FORMATS.square as DocFormat,
    locale: 'ar',
    objective: 'sell',
    density: 'brief',
    brand: defaultBrandKit(),
    brandVersion: null,
    products: [product()],
    service: null,
    copy: { headline: 'طباعة ثلاثية الأبعاد بدقة مذهلة', cta: 'اطلبها الآن' },
    evidence: NO_EVIDENCE,
    family: null,
    logo: { width: 1254, height: 1254 },
    backgroundNatural: null,
    slide: null,
    caption: '',
    alt_text: '',
    measure: approximateMeasurer,
    ...over,
  };
}

export function built(over: Partial<BuildInput> = {}) {
  return buildFromTemplate(buildInput(over));
}

export const allowedFor = (snap = snapshot()) => ({
  products: { main: snap.data.images.filter((i) => i.variant_key === 'combo').map((i) => ({ url: i.url, width: i.width!, height: i.height! })) },
  assets: [{ id: 'asset_bg_001', width: 2000, height: 2000, kind: 'background' }],
  logos: [{ ref: 'site', width: 1254, height: 1254 }],
});
