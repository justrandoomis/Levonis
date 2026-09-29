/**
 * «الطلبات» — WHAT THIS CUSTOMER BOUGHT FROM THIS STORE, both ways: store
 * orders (prepaid from the wallet) and custom work (held in escrow). The same
 * list for both sides of the conversation; each row opens that side's own page
 * for the order, where every step and a dispute live.
 */
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Receipt, Hammer, Loader2 } from 'lucide-react';
import { Sheet } from '../../ui/Sheet';
import { useLanguage } from '../../../LanguageContext';
import { useMoney } from '../../../CurrencyContext';
import { chatCommerceApi, type ThreadOrders } from '../../../lib/chatCommerceApi';
import { merchantHref } from '../../../lib/merchantRoutes';
import { statusText } from '../cards/cardWords';
import { shortDate, toneOf } from '../cards/parts';

const DOT: Record<string, string> = { good: 'bg-emerald-500', wait: 'bg-amber-500', stop: 'bg-red-500', muted: 'bg-zinc-400' };

export default function OrdersSheet({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { lang, loc } = useLanguage();
  const { moneyBoth } = useMoney();
  const navigate = useNavigate();
  const titleId = useId();
  const [data, setData] = useState<ThreadOrders | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFailed(false);
    chatCommerceApi
      .orders(chatId)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, chatId]);

  const merchant = data?.role === 'merchant';
  const side = merchant ? 'merchant' : 'customer';
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const empty = data && !data.store_orders.length && !data.custom_orders.length;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['medium', 'large']}
      panelClassName="sm:max-w-[480px] sm:w-[92vw]"
      testId="chat-orders-sheet"
      header={
        <h2 id={titleId} className="border-b border-border-subtle px-4 pb-3 pt-1 text-center text-[16px] font-extrabold text-text-primary">
          {loc('الطلبات', 'Orders')}
          {/* OWNER: Sorani to be written by hand (this sheet). */}
        </h2>
      }
    >
      <div className="px-2 py-2">
        {!data && !failed && (
          <div role="status" className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-text-muted" aria-hidden="true" />
            <span className="sr-only">{loc('جارٍ التحميل…', 'Loading…')}</span>
          </div>
        )}
        {failed && <p className="px-4 py-8 text-center text-[13px] text-text-secondary">{loc('تعذّر تحميل الطلبات', 'The orders could not be loaded')}</p>}
        {empty && (
          <p className="px-4 py-10 text-center text-[13px] text-text-muted">
            {merchant ? loc('لم يشترِ هذا الزبون من متجرك بعد', 'This customer has not bought from your store yet') : loc('لا طلبات لك من هذا المتجر بعد', 'You have no orders from this store yet')}
          </p>
        )}
        {data?.custom_orders.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => go(merchant ? merchantHref.customOrder(o.id) : `/requests?request=${encodeURIComponent(o.request_id)}`)}
            className="flex w-full min-h-[60px] items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-orders-row="custom"
          >
            <Hammer className="w-5 h-5 text-text-muted shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate text-[14px] font-semibold text-text-primary">{o.title}</span>
              <span className="flex items-center gap-1.5 text-[12px] text-text-secondary">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[toneOf(o.state)]}`} aria-hidden="true" />
                {statusText('custom_order', o.state, loc, side)} · {shortDate(o.created_at, lang)}
              </span>
            </span>
            <span className="text-[13px] font-bold tabular-nums text-text-primary shrink-0">{moneyBoth(o.price_iqd)}</span>
          </button>
        ))}
        {data?.store_orders.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => go(merchant ? merchantHref.order(o.id) : `/orders/${encodeURIComponent(o.id)}`)}
            className="flex w-full min-h-[60px] items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-orders-row="store"
          >
            <Receipt className="w-5 h-5 text-text-muted shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate text-[14px] font-semibold text-text-primary">
                {o.first_item || o.id}
                {o.items > 1 ? loc(` و${o.items - 1} غيرها`, ` +${o.items - 1} more`) : ''}
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-text-secondary">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[toneOf(o.status)]}`} aria-hidden="true" />
                {statusText('order', o.status, loc, side)} · <span dir="ltr">{o.id}</span>
              </span>
            </span>
            <span className="text-[13px] font-bold tabular-nums text-text-primary shrink-0">{moneyBoth(o.total_iqd)}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
