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
 * `POST /api/cart/merchant-items` with a product id, re-priced there; a quote
 * is accepted through the escrow's own door.
 */
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingBag, Store as StoreIcon, ExternalLink, Sparkles } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMoney } from '../../../CurrencyContext';
import { productName, type ChatCard, type ProductSnapshot, type StoreSnapshot } from '../../../lib/chatCards';
import { useCardActions } from './cardContext';
import { eventText } from './cardWords';
import { CardButton, CardShell, StatusLine } from './parts';
import { useAddToCart } from './useAddToCart';
import { CustomProductCardView, PrintRequestCardView, QuoteCardView } from './DealCards';
import { CustomOrderCardView, StoreOrderCardView } from './OrderCards';

interface CardProps {
  card: ChatCard;
  mine: boolean;
  /** The body the server stored — what an older client would have shown. */
  fallback: string | null;
}

/** A price, or a range when the options are priced differently. */
function priceText(money: (n: number) => string, lo: number, hi: number | null): string {
  return hi && hi > lo ? `${money(lo)} – ${money(hi)}` : money(lo);
}

// ============================================================ product

function ProductCardView({ card, mine }: CardProps) {
  const { lang, loc } = useLanguage();
  const { money } = useMoney();
  const navigate = useNavigate();
  const actions = useCardActions();
  // The thread rides with the add, so the order it becomes is announced here.
  const cart = useAddToCart(actions?.chatId);
  const snap = card.original as unknown as ProductSnapshot;
  const cur = card.current;

  const name = productName(snap, lang);
  const live = cur.status !== 'unavailable' && cur.status !== 'unknown' && typeof cur.price_iqd === 'number';
  const nowLo = live ? Number(cur.price_iqd) : Number(snap.price_iqd);
  const nowHi = live ? ((cur.price_max_iqd as number | null) ?? null) : snap.price_max_iqd;
  const moved = live && cur.price_changed === true;
  const compare = live ? (cur.original_price_iqd as number | null) : snap.original_price_iqd;

  // OWNER: Sorani to be written by hand (every sentence of this card).
  const status: Record<string, { text: string; tone: 'good' | 'wait' | 'muted' }> = {
    available: { text: loc('متوفر', 'In stock'), tone: 'good' },
    out_of_stock: { text: loc('نفدت الكمية', 'Out of stock'), tone: 'wait' },
    store_closed: { text: loc('المتجر لا يستقبل طلبات الآن', 'The store is not taking orders now'), tone: 'wait' },
    unavailable: { text: loc('لم يعد متاحًا', 'No longer available'), tone: 'muted' },
  };
  const st = status[cur.status];
  const acts = cur.actions ?? [];

  return (
    <CardShell mine={mine} kind="product" label={loc(`منتج: ${name}`, `Product: ${name}`)}>
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
          {compare && compare > nowLo && <span className="text-[12px] text-text-muted line-through tabular-nums">{money(compare)}</span>}
        </p>
        {moved && (
          <p className="text-[12px] text-text-secondary" data-card-price-moved>
            {loc(
              `تغيّر السعر — كان ${priceText(money, Number(snap.price_iqd), snap.price_max_iqd)} عند الإرسال`,
              `Price changed — it was ${priceText(money, Number(snap.price_iqd), snap.price_max_iqd)} when sent`
            )}
          </p>
        )}
        {st && <StatusLine tone={st.tone}>{st.text}</StatusLine>}
        {acts.length > 0 && (
          <div className="mt-1.5 flex gap-2">
            {acts.includes('add_to_cart') && (
              <CardButton action="add_to_cart" variant="primary" busy={cart.busy} onClick={() => void cart.add(card.ref, name)}>
                <ShoppingBag className="w-4 h-4" aria-hidden="true" />
                {loc('أضف إلى السلة', 'Add to cart')}
              </CardButton>
            )}
            {acts.includes('choose_options') && (
              <CardButton action="choose_options" variant="primary" onClick={() => navigate(snap.url)}>
                {loc('اختر الخيار', 'Choose an option')}
              </CardButton>
            )}
            {acts.includes('view') && (
              <CardButton action="view" onClick={() => navigate(snap.url)}>
                {loc('عرض', 'View')}
              </CardButton>
            )}
          </div>
        )}
      </div>
      {cart.dialog}
    </CardShell>
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
    <CardShell mine={mine} kind="store" label={loc(`متجر: ${name}`, `Store: ${name}`)}>
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
            {cur.status === 'open' ? loc('يستقبل الطلبات', 'Taking orders') : cur.status === 'closed' ? loc('غير متاح الآن', 'Not available right now') : ''}
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
    </CardShell>
  );
}

// ============================================================ fallback

/** A card this screen has no drawing for: the plain line an older client shows. */
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
  print_request: PrintRequestCardView,
  quote: QuoteCardView,
  custom_product: CustomProductCardView,
  order: StoreOrderCardView,
  custom_order: CustomOrderCardView,
};

export default function ChatCardView(props: CardProps) {
  const View = VIEWS[props.card.type] ?? FallbackCard;
  return <View {...props} />;
}

/**
 * A SYSTEM CARD — an event the server recorded («تم إنشاء الطلب»…), centred
 * and quiet: it is the thread's history, not somebody talking. The sentence
 * says what happened; under the order's NEWEST event (`withCard`), the order's
 * own card says where it stands now and offers the next step.
 */
export function SystemEventCard({ card, fallback, withCard = true }: { card: ChatCard | null; fallback: string | null; withCard?: boolean }) {
  const { loc } = useLanguage();
  const text = eventText(card, loc) ?? fallback;
  return (
    <div className="flex justify-center" data-chat-system>
      <div className="w-full max-w-md flex flex-col items-center gap-2">
        <p className="inline-flex items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1 text-[12px] font-semibold text-text-secondary text-center">
          <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span dir="auto">{text}</span>
        </p>
        {withCard && card && VIEWS[card.type] && <ChatCardView card={card} mine={false} fallback={fallback} />}
      </div>
    </div>
  );
}
