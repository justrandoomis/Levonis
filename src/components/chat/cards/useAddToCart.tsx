/**
 * «أضف إلى السلة» FROM A CARD — the store cart's own door
 * (`POST /api/cart/merchant-items`, an id and a quantity; the server prices it).
 *
 * A cart holds one store (docs/MERCHANT_PLATFORM.md §2 decision 1) and is never
 * emptied silently: the server refuses the add unless it carries `replaceCart`,
 * which only the answered question below sends — both stores named, the
 * destructive choice the deliberate one.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../../../LanguageContext';
import { api, ApiError } from '../../../lib/api';
import { toast } from '../../../lib/toastStore';
import { useConfirm } from '../../ui/ConfirmDialog';

export function useAddToCart(originChatId?: string) {
  const { lang, loc } = useLanguage();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [confirm, dialog] = useConfirm();

  async function add(productId: string, name: string, replaceCart = false): Promise<boolean> {
    setBusy(true);
    try {
      await api.post(
        '/api/cart/merchant-items',
        // The thread is where the order will be announced — never a price.
        { productId, qty: 1, replaceCart, ...(originChatId ? { origin_chat_id: originChatId } : {}) },
        { mascot: 'silent' }
      );
      toast.success(loc('أُضيف إلى السلة', 'Added to cart'), {
        description: name,
        action: { label: loc('إتمام الشراء', 'Check out'), onClick: () => navigate('/cart') },
      });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_SELLER_CONFLICT') {
        const d = (e.details ?? {}) as { cart_seller_name?: string | null; cart_seller_type?: string };
        const current = d.cart_seller_name || (d.cart_seller_type === 'levonis' ? 'LEVONIS' : loc('متجر آخر', 'another store', 'فرۆشگایەکی تر'));
        setBusy(false);
        const replace = await confirm({
          title: loc(`سلتك فيها منتجات من ${current}`, `Your cart has items from ${current}`),
          consequence: loc(
            `السلة تحمل منتجات متجر واحد. إفراغها يحذف ما فيها الآن ويضيف «${name}».`,
            `A cart holds one store's items. Emptying it removes what is in it now and adds “${name}”.`
          ),
          confirmLabel: loc('إفراغ السلة وإضافة المنتج', 'Empty the cart and add'),
          cancelLabel: loc('أبقِ سلتي', 'Keep my cart'),
          destructive: true,
        });
        // OWNER: Sorani to be written by hand (this question).
        return replace ? add(productId, name, true) : false;
      }
      const fallback = loc('تعذّرت الإضافة', 'Could not add to cart', 'نەتوانرا زیاد بکرێت');
      const { apiRefusal } = await import('../../../lib/refusalStrings');
      toast.error(e instanceof ApiError ? apiRefusal(e, lang, fallback) : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { add, busy, dialog };
}
