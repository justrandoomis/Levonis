/**
 * A CARD IN THE CONVERSATION (docs/COMMUNITY_COMMERCE_CHAT.md §2 D2, D7).
 *
 * Every card draws two things the server sent: what it was sent as
 * (`original`, frozen) and what it is now (`current`, read on every view, for
 * this reader). Where the two differ the card says so in words — «السعر الآن»
 * beside «كان … عند الإرسال» — rather than silently showing one of them.
 *
 * The buttons are the server's `current.actions` and nothing else: the screen
 * never decides by itself that someone may buy, accept or cancel. Money moves
 * only through the existing doors — «أضف إلى السلة» is the store cart's own
 * `POST /api/cart/merchant-items` with a product id, re-priced there.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingBag, Store as StoreIcon, ExternalLink, Loader2, Sparkles } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMoney } from '../../../CurrencyContext';
import { api, ApiError } from '../../../lib/api';
import { toast } from '../../../lib/toastStore';
import { productName, type ChatCard, type ProductSnapshot, type StoreSnapshot } from '../../../lib/chatCards';
import { useConfirm } from '../../ui/ConfirmDialog';

interface CardProps {
  card: ChatCard;
  mine: boolean;
  /** The body the server stored — what an older client would have shown. */
  fallback: string | null;
}

const shell = (mine: boolean) =>
  `w-[min(80vw,19rem)] mt-1 overflow-hidden rounded-xl border border-border-subtle bg-surface text-text-primary ${
    mine ? 'ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'ltr:rounded-tl-sm rtl:rounded-tr-sm'
  }`;

/** A price, or a range when the options are priced differently. */
function priceText(money: (n: number) => string, lo: number, hi: number | null): string {
  return hi && hi > lo ? `${money(lo)} – ${money(hi)}` : money(lo);
}

// ============================================================ product

function ProductCardView({ card, mine }: CardProps) {
  const { lang, loc } = useLanguage();
  const { money } = useMoney();
  const navigate = useNavigate();
  const snap = card.original as unknown as ProductSnapshot;
  const cur = card.current;
  const [adding, setAdding] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const name = productName(snap, lang);
  const live = cur.status !== 'unavailable' && cur.status !== 'unknown' && typeof cur.price_iqd === 'number';
  const nowLo = live ? Number(cur.price_iqd) : Number(snap.price_iqd);
  const nowHi = live ? ((cur.price_max_iqd as number | null) ?? null) : snap.price_max_iqd;
  const moved = live && cur.price_changed === true;
  const compare = live ? (cur.original_price_iqd as number | null) : snap.original_price_iqd;

  const status: Record<string, { text: string; tone: string }> = {
    available: { text: loc('متوفر', 'In stock'), tone: 'bg-emerald-500' },
    out_of_stock: { text: loc('نفدت الكمية', 'Out of stock'), tone: 'bg-amber-500' },
    store_closed: { text: loc('المتجر لا يستقبل طلبات الآن', 'The store is not taking orders now'), tone: 'bg-amber-500' },
    unavailable: { text: loc('لم يعد متاحًا', 'No longer available'), tone: 'bg-zinc-400' },
  };
  // OWNER: Sorani to be written by hand (every sentence of this card).
  const st = status[cur.status];

  async function addToCart(replaceCart = false) {
    setAdding(true);
    try {
      // An id and a quantity — the price is the server's (§17).
      await api.post('/api/cart/merchant-items', { productId: card.ref, qty: 1, replaceCart }, { mascot: 'silent' });
      toast.success(loc('أُضيف إلى السلة', 'Added to cart'), {
        description: name,
        action: { label: loc('عرض السلة', 'View cart'), onClick: () => navigate('/cart') },
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_SELLER_CONFLICT') {
        /*
         * A CART HOLDS ONE SHOP (docs/MERCHANT_PLATFORM.md §2 decision 1). The
         * cart is never cleared silently: the server refuses the add unless it
         * carries `replaceCart`, which only this answered question sends — both
         * shops named, the destructive choice the deliberate one.
         */
        const d = (e.details ?? {}) as { cart_seller_name?: string | null; cart_seller_type?: string };
        const current = d.cart_seller_name || (d.cart_seller_type === 'levonis' ? 'LEVONIS' : loc('متجر آخر', 'another store', 'فرۆشگایەکی تر'));
        setAdding(false);
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
        if (replace) await addToCart(true);
        return;
      } else {
        const fallback = loc('تعذّرت الإضافة', 'Could not add to cart', 'نەتوانرا زیاد بکرێت');
        const { apiRefusal } = await import('../../../lib/refusalStrings');
        toast.error(e instanceof ApiError ? apiRefusal(e, lang, fallback) : fallback);
      }
    } finally {
      setAdding(false);
    }
  }

  const actions = cur.actions ?? [];
  return (
    <article className={shell(mine)} aria-label={loc(`منتج: ${name}`, `Product: ${name}`)} data-chat-card="product">
      {snap.image ? (
        <img referrerPolicy="no-referrer" src={snap.image} alt="" loading="lazy" className="aspect-[4/3] w-full object-cover bg-surface-raised" />
      ) : (
        <div className="aspect-[4/3] w-full bg-surface-raised flex items-center justify-center">
          <ShoppingBag className="w-7 h-7 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
        </div>
      )}
      <div className="p-3 flex flex-col gap-1.5">
        <h3 dir="auto" className="text-[14px] font-bold leading-snug line-clamp-2">{name}</h3>
        <p className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[15px] font-extrabold tabular-nums">{priceText(money, nowLo, nowHi)}</span>
          {compare && compare > nowLo && (
            <span className="text-[12px] text-text-muted line-through tabular-nums">{money(compare)}</span>
          )}
        </p>
        {moved && (
          <p className="text-[12px] text-text-secondary" data-card-price-moved>
            {loc(
              `تغيّر السعر — كان ${priceText(money, Number(snap.price_iqd), snap.price_max_iqd)} عند الإرسال`,
              `Price changed — it was ${priceText(money, Number(snap.price_iqd), snap.price_max_iqd)} when sent`
            )}
          </p>
        )}
        {st && (
          <p className="flex items-center gap-1.5 text-[12px] text-text-secondary">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${st.tone}`} aria-hidden="true" />
            {st.text}
          </p>
        )}
        {(actions.includes('add_to_cart') || actions.includes('choose_options') || actions.includes('view')) && (
          <div className="mt-1.5 flex gap-2">
            {actions.includes('add_to_cart') && (
              <button
                type="button"
                onClick={() => void addToCart()}
                disabled={adding}
                aria-busy={adding}
                className="lv-button lv-button-primary lv-button-sm flex-1"
                data-card-action="add_to_cart"
              >
                {adding ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ShoppingBag className="w-4 h-4" aria-hidden="true" />}
                {loc('أضف إلى السلة', 'Add to cart')}
              </button>
            )}
            {actions.includes('choose_options') && (
              <button
                type="button"
                onClick={() => navigate(snap.url)}
                className="lv-button lv-button-primary lv-button-sm flex-1"
                data-card-action="choose_options"
              >
                {loc('اختر الخيار', 'Choose an option')}
              </button>
            )}
            {actions.includes('view') && (
              <button
                type="button"
                onClick={() => navigate(snap.url)}
                className={`lv-button lv-button-secondary lv-button-sm ${actions.length === 1 ? 'flex-1' : ''}`}
                data-card-action="view"
              >
                {loc('عرض', 'View')}
              </button>
            )}
          </div>
        )}
      </div>
      {confirmDialog}
    </article>
  );
}

// ============================================================ store

function StoreCardView({ card, mine }: CardProps) {
  const { loc } = useLanguage();
  const navigate = useNavigate();
  const snap = card.original as unknown as StoreSnapshot;
  const cur = card.current;
  const name = typeof cur.name === 'string' && cur.name ? cur.name : snap.name;
  return (
    <article className={shell(mine)} aria-label={loc(`متجر: ${name}`, `Store: ${name}`)} data-chat-card="store">
      <div className="p-3 flex items-center gap-3">
        <div className="w-12 h-12 rounded-full overflow-hidden bg-surface-raised flex items-center justify-center shrink-0">
          {snap.logo ? (
            <img referrerPolicy="no-referrer" src={snap.logo} alt="" className="w-full h-full object-cover" />
          ) : (
            <StoreIcon className="w-5 h-5 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 dir="auto" className="text-[14px] font-bold truncate">{name}</h3>
          {snap.tagline && <p dir="auto" className="text-[12px] text-text-secondary line-clamp-2">{snap.tagline}</p>}
          <p className="mt-0.5 text-[12px] text-text-muted">
            {cur.status === 'open'
              ? loc('يستقبل الطلبات', 'Taking orders')
              : cur.status === 'closed'
                ? loc('غير متاح الآن', 'Not available right now')
                : ''}
            {/* OWNER: Sorani to be written by hand. */}
          </p>
        </div>
      </div>
      {cur.actions?.includes('view') && (
        <div className="px-3 pb-3">
          <button type="button" onClick={() => navigate(snap.url)} className="lv-button lv-button-secondary lv-button-sm w-full" data-card-action="view">
            <ExternalLink className="w-4 h-4" aria-hidden="true" />
            {loc('زيارة المتجر', 'Visit the store')}
          </button>
        </div>
      )}
    </article>
  );
}

// ============================================================ fallback

/** A card this screen has no drawing for yet: the plain line an older client shows. */
function FallbackCard({ mine, fallback }: CardProps) {
  return (
    <div
      dir="auto"
      className={`${mine ? 'bg-surface-selected ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'bg-surface ltr:rounded-tl-sm rtl:rounded-tr-sm'} px-3.5 py-2.5 rounded-lg text-[14px] leading-relaxed max-w-[min(80%,34rem)] mt-1 whitespace-pre-wrap break-words text-text-primary`}
    >
      {fallback}
    </div>
  );
}

const VIEWS: Partial<Record<ChatCard['type'], (p: CardProps) => React.ReactElement>> = {
  product: ProductCardView,
  store: StoreCardView,
};

export default function ChatCardView(props: CardProps) {
  const View = VIEWS[props.card.type] ?? FallbackCard;
  return <View {...props} />;
}

/**
 * A SYSTEM CARD — an event the server recorded («تم إنشاء الطلب»…), centred
 * and quiet: it is the thread's history, not somebody talking. Its own card
 * (an order, a job) is drawn inside when this screen knows the type.
 */
export function SystemEventCard({ card, fallback }: { card: ChatCard | null; fallback: string | null }) {
  return (
    <div className="flex justify-center" data-chat-system>
      <div className="max-w-[min(92%,26rem)] flex flex-col items-center gap-2">
        <p className="inline-flex items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1 text-[12px] font-semibold text-text-secondary">
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          <span dir="auto">{fallback}</span>
        </p>
        {card && VIEWS[card.type] && <ChatCardView card={card} mine={false} fallback={fallback} />}
      </div>
    </div>
  );
}
