/**
 * «أرسل منتجًا» — THE STORE'S PRODUCTS, TO SEND AS A CARD.
 *
 * Lists what `GET /api/chats/:id/products` answers: this thread's store's
 * published products and nothing else — never another store's, never a hidden
 * or private one. A tap sends the product's ID; the server builds the card
 * from the database (worker/lib/chatCards.ts). Either side may send one: the
 * store suggests, the customer asks «هل هذا متوفر؟» about a product.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Search, ShoppingBag, Loader2 } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { api } from '../../lib/api';
import { productName, type PickerProduct } from '../../lib/chatCards';

export default function ProductPickerSheet({
  open,
  onClose,
  chatId,
  onPick,
  title,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  /** The product as listed — the private product sheet starts from its name, price and picture. */
  onPick: (productId: string, product: PickerProduct) => Promise<void> | void;
  /** Another purpose than sending it, said in the sheet's title. */
  title?: string;
}) {
  const { lang, loc } = useLanguage();
  const { money } = useMoney();
  const titleId = useId();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PickerProduct[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (term: string, after: string | null) => {
      const mine = ++seq.current;
      setLoading(true);
      setFailed(false);
      try {
        const qs = new URLSearchParams();
        if (term.trim()) qs.set('q', term.trim());
        if (after) qs.set('cursor', after);
        const data = await api.get<{ products: PickerProduct[]; next_cursor: string | null }>(
          `/api/chats/${chatId}/products${qs.toString() ? `?${qs}` : ''}`,
          { mascot: 'silent' }
        );
        if (mine !== seq.current) return;
        setItems((prev) => (after ? [...prev, ...data.products] : data.products));
        setCursor(data.next_cursor);
      } catch {
        if (mine === seq.current) setFailed(true);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [chatId]
  );

  // A new search replaces the list; typing waits a beat before asking.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void load(q, null), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, q, load]);

  const pick = async (product: PickerProduct) => {
    if (sending) return;
    setSending(product.id);
    try {
      await onPick(product.id, product);
      onClose();
    } finally {
      setSending(null);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['medium', 'large']}
      panelClassName="sm:max-w-[480px] sm:w-[92vw]"
      testId="chat-product-picker"
      header={
        <div className="border-b border-border-subtle px-4 pb-3 pt-1">
          <h2 id={titleId} className="text-center text-[16px] font-extrabold text-text-primary">
            {title ?? loc('أرسل منتجًا', 'Send a product')}
          </h2>
          <label className="mt-3 flex min-h-11 items-center gap-2 rounded-lg border border-border-subtle bg-surface-raised px-3">
            <Search className="w-4 h-4 text-text-muted shrink-0" aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={loc('ابحث في منتجات المتجر', 'Search the store’s products')}
              aria-label={loc('ابحث في منتجات المتجر', 'Search the store’s products')}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          {/* OWNER: Sorani to be written by hand (this sheet). */}
        </div>
      }
    >
      <div className="px-2 py-2" data-picker-list>
        {items.map((p) => {
          const name = productName(p, lang);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => void pick(p)}
              disabled={!!sending}
              data-picker-product={p.id}
              className="flex w-full min-h-[64px] items-center gap-3 rounded-xl px-2 py-2 text-start hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
            >
              <span className="w-14 h-14 shrink-0 overflow-hidden rounded-lg bg-surface-raised flex items-center justify-center">
                {p.image ? (
                  <img referrerPolicy="no-referrer" src={p.image} alt="" loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <ShoppingBag className="w-5 h-5 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-[14px] font-semibold text-text-primary">{name}</span>
                <span className="block text-[13px] tabular-nums text-text-secondary">
                  {p.price_max_iqd && p.price_max_iqd > p.price_iqd ? `${money(p.price_iqd)} – ${money(p.price_max_iqd)}` : money(p.price_iqd)}
                  {!p.in_stock && <span className="ms-2 text-warning">{loc('نفدت الكمية', 'Out of stock')}</span>}
                </span>
              </span>
              {sending === p.id && <Loader2 className="w-4 h-4 animate-spin text-text-muted" aria-hidden="true" />}
            </button>
          );
        })}
        {!loading && !failed && items.length === 0 && (
          <p className="px-4 py-10 text-center text-[13px] text-text-muted">
            {q.trim() ? loc('لا نتائج لهذا البحث', 'No products match this search') : loc('لا منتجات منشورة في هذا المتجر بعد', 'This store has no published products yet')}
          </p>
        )}
        {failed && (
          <div className="px-4 py-6 text-center">
            <p className="text-[13px] text-text-secondary">{loc('تعذّر تحميل المنتجات', 'The products could not be loaded')}</p>
            <button type="button" onClick={() => void load(q, null)} className="lv-button lv-button-secondary lv-button-sm mt-2">
              {loc('إعادة المحاولة', 'Try again')}
            </button>
          </div>
        )}
        {loading && (
          <div role="status" className="flex justify-center py-4">
            <Loader2 className="w-5 h-5 animate-spin text-text-muted" aria-hidden="true" />
            <span className="sr-only">{loc('جارٍ التحميل…', 'Loading…')}</span>
          </div>
        )}
        {!loading && cursor && (
          <div className="flex justify-center py-2">
            <button type="button" onClick={() => void load(q, cursor)} className="lv-button lv-button-ghost lv-button-sm">
              {loc('عرض المزيد', 'Show more')}
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

