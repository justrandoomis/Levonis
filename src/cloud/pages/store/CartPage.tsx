/**
 * THE CART (/store/cart, signed in).
 *
 * The lines live in this tab's memory and belong to the signed-in account
 * (./cart.ts). Their prices do not live anywhere: once the lines settle, the
 * whole cart is priced by POST /pricing/quote — the server's price list,
 * promotions and the customer's own limits, nothing stored or reserved — and
 * every figure on this screen is that answer, labelled as today's price.
 * A stock problem or a refused line is marked on its line.
 *
 * «Get a quote» stores the price (POST /quotes): the frozen lines, promotions
 * and totals under an expiry, which is what an order is made from
 * (/store/checkout/:quoteId).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, IconButton } from '../../../components/ui/Button';
import { Money } from '../../../components/ui/Money';
import { Skeleton } from '../../../components/ui/Skeleton';
import { toast } from '../../../lib/toastStore';
import { cloudErrorText, createQuote, priceQuote } from '../../api';
import { formatHours } from '../../format';
import { cart as words, checkout, goods, store } from '../../strings/store';
import { tx, useCloudText } from '../../text';
import type { PricedQuote, QuoteLineInput } from '../../types';
import { Clock, CloudEmptyState, PageHeader, ShoppingBag, X } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { useCart } from './cart';
import { CheckoutPage, warm } from './pages';
import { AmountRows, QuantityPicker, Swatch, useDebounced } from './parts';
import { couponRefused, quoteLinesOf, refusedLine, type CartLine } from './rules';

function LinePrice({ priced, stale }: { priced: PricedQuote['lines'][number] | undefined; stale: boolean }) {
  const { t } = useCloudText();
  if (stale || !priced) return <Skeleton className="h-5 w-20 rounded" />;
  return (
    <span className="flex flex-col items-end">
      <span className="text-sm font-bold text-text-primary">
        <Money iqd={priced.final_price_iqd} />
      </span>
      {priced.discount_iqd > 0 ? (
        <span className="text-[11px] text-text-muted line-through">
          <span className="sr-only">{t(goods.beforeDiscount)} </span>
          <Money iqd={priced.base_price_iqd} />
        </span>
      ) : null}
    </span>
  );
}

function CartRow({
  line,
  index,
  priced,
  stale,
  problem,
}: {
  line: CartLine;
  index: number;
  priced: PricedQuote['lines'][number] | undefined;
  stale: boolean;
  problem: string | null;
}) {
  const { t, lang } = useCloudText();
  const cart = useCart();
  const name = tx(line.label.name, lang) || (line.label.seconds != null ? formatHours(line.label.seconds, lang) : '');
  const detail = [line.label.detail ? tx(line.label.detail, lang) : null, line.label.seconds != null ? t(words.hoursEach, { hours: formatHours(line.label.seconds, lang) }) : null]
    .filter(Boolean)
    .join(' · ');
  const remove = () => {
    cart.remove([line.key]);
    toast.success(t(words.removed), { id: `cloud-cart-remove-${line.key}`, action: { label: t(words.undo), onClick: () => cart.restore(line, index) } });
  };
  return (
    <li className={`lv-surface p-3 ${problem ? 'border border-danger' : ''}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl lv-well text-text-secondary">
          {line.label.color ? <Swatch hex={line.label.color} /> : <Clock className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
          {detail ? <p className="truncate text-[12px] text-text-muted">{detail}</p> : null}
          {line.kind === 'material' ? (
            <p className="text-[12px] text-text-muted">{line.fulfillment === 'delivery' ? t(goods.deliver) : t(goods.keep)}</p>
          ) : null}
        </div>
        <IconButton label={t(words.removeNamed, { name })} icon={<X aria-hidden="true" className="h-4 w-4" />} onClick={remove} />
      </div>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <QuantityPicker value={line.quantity} rule={line.rule} unit={line.label.unit} onChange={(q) => cart.setQuantity(line.key, q)} label={`${t(goods.quantity)}: ${name}`} />
        <LinePrice priced={priced} stale={stale} />
      </div>
      {problem ? (
        <p role="alert" className="mt-2 text-[12px] font-semibold text-danger">
          {problem}
        </p>
      ) : null}
    </li>
  );
}

export default function CartPage() {
  const { t, lang } = useCloudText();
  const navigate = useNavigate();
  const cart = useCart();
  const [couponDraft, setCouponDraft] = useState('');
  const [coupon, setCoupon] = useState<string | null>(null);
  const [couponError, setCouponError] = useState(false);
  const [quoteError, setQuoteError] = useState<unknown>(null);

  const body = useMemo(() => quoteLinesOf(cart.lines), [cart.lines]);
  const request = JSON.stringify({ lines: body, coupon });
  const settled = useDebounced(request, 400);
  const pricing = useCloudQuery<PricedQuote | null>(
    (signal) => {
      const { lines, coupon: c } = JSON.parse(settled) as { lines: QuoteLineInput[]; coupon: string | null };
      return lines.length ? priceQuote(c ? { lines, coupon: c } : { lines }, { signal }) : Promise.resolve(null);
    },
    [settled]
  );
  const stale = settled !== request || pricing.loading;

  // A coupon the server does not accept is said once, and the cart is priced without it.
  useEffect(() => {
    if (coupon && couponRefused(pricing.error)) {
      setCouponError(true);
      setCoupon(null);
    }
  }, [pricing.error, coupon]);
  useEffect(() => {
    if (cart.count > 0) warm(CheckoutPage);
  }, [cart.count]);

  if (cart.lines.length === 0) {
    return (
      <div>
        <PageHeader title={t(words.title)} back={{ to: '/store', label: t(store.title) }} />
        <CloudEmptyState
          icon={<ShoppingBag className="h-6 w-6" />}
          title={t(words.emptyTitle)}
          body={t(words.emptyBody)}
          action={
            <>
              <Link to="/store?tab=hours" className="lv-button lv-button-primary">
                {t(words.browseHours)}
              </Link>
              <Link to="/store?tab=materials" className="lv-button lv-button-secondary">
                {t(words.browseMaterials)}
              </Link>
            </>
          }
        />
      </div>
    );
  }

  const data = stale ? null : pricing.data;
  const failed = !stale && pricing.error && !couponRefused(pricing.error) ? pricing.error : null;
  const failedLine = failed ? refusedLine(failed) : null;
  const problemOf = (index: number): string | null => {
    const lineNo = index + 1;
    if (failedLine === lineNo) return cloudErrorText(failed, lang);
    if (data?.problems.some((p) => p.line_no === lineNo)) return t(goods.notEnoughStock);
    return null;
  };
  const canQuote = !!data && data.orderable && !failed;

  const getQuote = async () => {
    setQuoteError(null);
    try {
      const quote = await createQuote(coupon ? { lines: body, coupon } : { lines: body });
      navigate(`/store/checkout/${encodeURIComponent(quote.quote_id)}`);
    } catch (e) {
      setQuoteError(e);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t(words.title)} subtitle={t(words.subtitle)} back={{ to: '/store', label: t(store.title) }} />
      <ul className="space-y-2">
        {cart.lines.map((line, index) => (
          <CartRow key={line.key} line={line} index={index} priced={data?.lines[index]} stale={stale || !!failed} problem={problemOf(index)} />
        ))}
      </ul>
      {failed && failedLine === null ? (
        <p role="alert" className="lv-alert lv-alert-danger text-[13px] leading-relaxed text-text-primary">
          {cloudErrorText(failed, lang)}
        </p>
      ) : null}

      <section className="lv-surface space-y-3 p-4" aria-labelledby="cloud-cart-totals">
        <h2 id="cloud-cart-totals" className="text-[15px] font-bold text-text-primary">
          {t(words.todaysPrices)}
        </h2>
        {data ? (
          <AmountRows
            rows={[
              ...(data.discount_iqd > 0 ? [{ label: t(words.subtotal), iqd: data.subtotal_iqd }, { label: t(goods.discount), iqd: data.discount_iqd, minus: true }] : []),
              { label: t(words.total), iqd: data.total_iqd, strong: true },
            ]}
          />
        ) : failed ? null : (
          <Skeleton className="h-7 w-40 rounded-md" />
        )}
        {data && data.promotions.length > 0 ? (
          <ul className="space-y-1 text-[12px] text-text-secondary">
            {data.promotions.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3">
                <span>{p.code ? t(checkout.codeDiscount, { code: p.code }) : t(checkout.autoDiscount)}</span>
                <Money iqd={-p.discount_iqd} />
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-[12px] leading-relaxed text-text-muted">{t(words.pricesNote)}</p>

        {coupon ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl lv-well px-3 py-2">
            <span className="text-[13px] font-semibold text-text-primary">
              {/* «Applied» only once the server's price carries its discount: a valid code may give none to this cart. */}
              {!data
                ? t(checkout.codeDiscount, { code: coupon })
                : data.promotions.some((p) => p.code === coupon)
                  ? t(words.couponApplied, { code: coupon })
                  : t(words.couponNoDiscount, { code: coupon })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setCoupon(null)}>
              {t(words.removeCoupon)}
            </Button>
          </div>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const code = couponDraft.trim();
              if (!code) return;
              setCouponError(false);
              setCoupon(code);
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[12px] font-semibold text-text-secondary">{t(words.coupon)}</span>
              <input
                type="text"
                value={couponDraft}
                onChange={(e) => {
                  setCouponDraft(e.target.value);
                  setCouponError(false);
                }}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                dir="ltr"
                maxLength={64}
                aria-invalid={couponError || undefined}
                className="lv-input"
              />
            </label>
            <Button type="submit" variant="secondary" disabled={!couponDraft.trim()}>
              {t(words.applyCoupon)}
            </Button>
          </form>
        )}
        {couponError ? (
          <p role="alert" className="text-[12px] font-semibold text-danger">
            {t(words.couponRefused)}
          </p>
        ) : null}

        {data && !data.orderable ? <p className="text-[13px] font-semibold text-warning">{t(words.fixLines)}</p> : null}
        <Button variant="primary" block disabled={!canQuote} loadingLabel={t(words.gettingQuote)} onClick={getQuote}>
          {t(words.getQuote)}
        </Button>
        {quoteError ? (
          <p role="alert" className="text-[13px] font-medium text-danger">
            {cloudErrorText(quoteError, lang)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
