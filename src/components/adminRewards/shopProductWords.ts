/**
 * THE SETTINGS' PRODUCTS FOR POINTS, WITHOUT THE EDITOR (DECISIONS row 299): the rows' shape
 * and the words of every refusal. Pure, so the settings form reads it without loading the
 * product editor and its stylesheet (./RewardsShopProducts is a lazy chunk), and a test
 * reads it as it is.
 */
import { formatFigure } from '../../lib/localeNumber';

type Tri = { ar: string; en: string; ckb: string };
export type Loc = (ar: string, en: string, ckb: string) => string;

export interface ShopProductRow {
  id: string;
  product_id: string;
  option_value_ids: string[];
  color_id: string;
  qty: number;
  sale_type: 'direct_sale' | 'pre_order';
  transport_method: '' | 'air' | 'sea' | 'land';
  points: number | null;
  enabled: boolean;
}

/** GET /api/admin/rewards/config `shop_products`: what the store says a row is, and what it has done. No cost. */
export interface ShopProductView {
  id: string;
  product: { id: string; slug: string; name: Tri; image: string; option: Tri | null; color: Tri | null; color_hex: string; qty: number } | null;
  value_iqd: number | null;
  available: boolean;
  reason: string | null;
  swapped: number;
  points_taken: number;
}

/** The most rows the shop sells (the server's `MAX_SHOP_PRODUCTS`). */
export const MAX_SHOP_ROWS = 50;

/** The server's refusal of a row, in the owner's words; null for a code that is not about the products. */
export function shopProductRefusal(code: string | undefined, loc: Loc): string | null {
  switch (code) {
    case 'REWARD_SHOP_PRICE_REQUIRED':
      return loc('ضع سعرًا بالنقاط لكل ما تعرضه للبيع.', 'Set a price in points for everything you put on sale.', 'بۆ هەر شتێک کە دەیخەیتە فرۆشتن نرخێک بە خاڵ دابنێ.');
    case 'REWARD_SHOP_ITEM_INVALID':
      return loc('هذا الصف ناقص: اختر المنتج ونوع البيع واكتب سعرًا صحيحًا، أو احذف الصف.', 'This row is incomplete: choose the product and the sale type and enter a valid price, or remove the row.', 'ئەم ڕیزە ناتەواوە: بەرهەم و جۆری فرۆشتن هەڵبژێرە و نرخێکی دروست بنووسە، یان ڕیزەکە لاببە.');
    case 'REWARD_SHOP_ITEM_DUPLICATE':
      return loc('هذا المنتج بهذه الخيارات معروض مرتين.', 'This product with these options is on sale twice.', 'ئەم بەرهەمە بەم هەڵبژاردنانە دوو جار خراوەتە فرۆشتن.');
    case 'REWARD_SHOP_ITEMS_TOO_MANY':
      return loc(`يبيع المتجر ${formatFigure(MAX_SHOP_ROWS, 'ar')} منتجًا على الأكثر.`, `The shop sells at most ${formatFigure(MAX_SHOP_ROWS, 'en')} products.`, `فرۆشگا زۆرترین ${formatFigure(MAX_SHOP_ROWS, 'ckb')} بەرهەم دەفرۆشێت.`);
    case 'GIFT_PRODUCT_NOT_FOUND':
      return loc('هذا المنتج غير موجود في المتجر.', 'This product is not in the store.', 'ئەم بەرهەمە لە فرۆشگادا نییە.');
    case 'GIFT_PRODUCT_INACTIVE':
      return loc('هذا المنتج غير معروض للزبائن الآن، فلا يُباع بالنقاط.', 'Customers cannot see this product now, so it cannot be sold for points.', 'کڕیاران ئێستا ئەم بەرهەمە نابینن، بۆیە ناتوانرێت بە خاڵ بفرۆشرێت.');
    case 'GIFT_COMPOSITION_UNSUPPORTED':
      return loc('الحزم والعروض الغامضة لا تُباع بالنقاط.', 'Bundles and mystery offers cannot be sold for points.', 'کۆمەڵە و ئۆفەری نادیار ناتوانرێن بە خاڵ بفرۆشرێن.');
    case 'GIFT_SALE_TYPE_UNAVAILABLE':
      return loc('هذا المنتج لا يُباع بنوع البيع المختار.', 'This product is not sold with the chosen sale type.', 'ئەم بەرهەمە بەو جۆری فرۆشتنە هەڵبژێردراوە نافرۆشرێت.');
    case 'GIFT_TRANSPORT_REQUIRED':
      return loc('الطلب المسبق يحتاج طريق شحن.', 'A pre-order needs a shipping route.', 'پێشداواکاری پێویستی بە ڕێگەی گواستنەوە هەیە.');
    case 'GIFT_SELECTION_INVALID':
      return loc('هذه الخيارات لا تطابق المنتج: اختر الموديل واللون من جديد.', 'These options do not match the product: choose the model and the colour again.', 'ئەم هەڵبژاردنانە لەگەڵ بەرهەمەکە ناگونجێن: مۆدێل و ڕەنگ دووبارە هەڵبژێرە.');
    case 'GIFT_QTY_INVALID':
      return loc('الكمية من 1 إلى 99.', 'The quantity is from 1 to 99.', 'بڕ لە 1 تا 99.');
    case 'GIFT_PRICE_ESTIMATE':
      return loc('سعر هذا المنتج تقديري: أكّده أولًا.', 'This product’s price is an estimate: confirm it first.', 'نرخی ئەم بەرهەمە خەمڵێنراوە: سەرەتا پشتڕاستی بکەرەوە.');
    default:
      return null;
  }
}

/** Why a row on sale cannot be swapped today, as the settings row says it. */
export function shopRowWarning(reason: string | null, loc: Loc): string {
  if (reason === 'OUT_OF_STOCK') return loc('نفد من المخزون: يراه الزبون بلا زر استبدال حتى يتوفر.', 'Out of stock: the customer sees it without a swap button until it is back.', 'لە کۆگادا نەماوە: کڕیار بەبێ دوگمەی گۆڕینەوە دەیبینێت تا دەگەڕێتەوە.');
  return shopProductRefusal(reason ?? undefined, loc) ?? loc('لا يمكن استبداله الآن.', 'It cannot be swapped right now.', 'ئێستا ناتوانرێت بگۆڕدرێتەوە.');
}
