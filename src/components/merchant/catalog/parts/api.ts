/**
 * THE PART DOORS, TYPED (Programme C, C1): the Levonis items marked for use
 * inside printed products (GET /api/products/print-parts,
 * worker/routes/printParts.ts) and «من ليفونيس» / «حدّث من ليفونيس»
 * (worker/routes/merchantParts.ts). Every figure is the server's: the price is
 * the Levonis guest price, the part's own price is the merchant's to set.
 */
import { api } from '../../../../lib/api';
import type { PartKind } from '../../../../../packages/catalog/src/personalize/parts';
import type { CatalogProductDetail } from '../catalogApi';

export type PartWords = { ar: string; en: string; ckb: string };

export interface PrintPartOption {
  key: string;
  name: string;
  name_ar: string;
  name_ckb: string;
  price_iqd: number;
  in_stock: boolean;
  words: PartWords;
}

export interface PrintPart {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ckb: string;
  price_iqd: number;
  in_stock: boolean;
  image: string | null;
  kind: PartKind;
  words: PartWords;
  options: PrintPartOption[];
}

export interface LevonisPrice {
  id: string;
  option_key: string | null;
  price_iqd: number;
  in_stock: boolean;
}

const qs = (o: Record<string, string | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

export const partsApi = {
  printParts: (q: { kind?: string; q?: string; cursor?: string }) =>
    api.get<{ parts: PrintPart[]; next_cursor: string | null }>(`/api/products/print-parts?${qs(q)}`),
  fromLevonis: (productId: string, optionKey?: string | null) =>
    api.post<{ product: CatalogProductDetail; images: { copied: number; skipped: number } }>('/api/merchant/parts/from-levonis', {
      product_id: productId,
      ...(optionKey ? { option_key: optionKey } : {}),
    }),
  refresh: (productId: string) =>
    api.post<{ product: CatalogProductDetail; levonis: LevonisPrice }>(`/api/merchant/parts/${encodeURIComponent(productId)}/refresh`),
};
