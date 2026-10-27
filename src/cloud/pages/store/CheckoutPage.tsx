/**
 * A STORED QUOTE AND THE ORDER IT BECOMES (/store/checkout/:quoteId, signed in).
 *
 * GET /quotes/{id} — the frozen lines, promotions and totals, and when the
 * price stops being held. The countdown is to the server's own `expires_at`;
 * past it (or for a quote the server no longer calls open) the screen says
 * the quote expired and offers a new one for the same lines, at today's
 * price. A quote an order was already made from says so.
 *
 * «Place order» is a money door (POST /orders): its Idempotency-Key is made
 * for this exact body — the quote, the payment method, the address — and
 * sent again on every retry of it; a changed body is a new intent with a new
 * key (the server refuses one key for two bodies). The order holds the
 * stock; paying is the order's own screen (/orders/:id): from the Levonis
 * wallet, or at the workshop where an admin confirms it.
 *
 * Any quote of the customer's opens here, wherever it was made — the cart,
 * or the account's «top up to N» (POST /me/inventory/top-up-quote).
 */
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Money } from '../../../components/ui/Money';
import { Segmented } from '../../../components/ui/Segmented';
import { Skeleton } from '../../../components/ui/Skeleton';
import { GOVERNORATES } from '../../../lib/governorates';
import { cloudErrorCode, cloudErrorText, createOrder, createQuote, getQuote, getWallet, useIdempotencyKey } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDateTime, formatIqd } from '../../format';
import { header } from '../../strings/common';
import { address as addressWords, cart as cartWords, checkout as words, goods, paymentMethod, store } from '../../strings/store';
import { useCloudText } from '../../text';
import type { DeliveryAddress, OrderRequest, QuoteView } from '../../types';
import { CloudEmptyState, CloudErrorState, CloudPageSkeleton, ExternalLink, Hourglass, PageHeader, Receipt, TriangleAlert } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { useCart } from './cart';
import { OrderPage, warm } from './pages';
import { AmountRows, lineDetail, lineTitle, Sentence, useNameBook, useNow } from './parts';
import { addressProblems, clockText, CLOCK_LIMIT_MS, EMPTY_ADDRESS, lineKey, phoneForServer, quoteInputsOf, quoteState, type AddressDraft } from './rules';

type Method = 'levonis_wallet' | 'manual';

function QuoteLines({ quote }: { quote: QuoteView }) {
  const { t, lang } = useCloudText();
  const book = useNameBook(quote.lines);
  const problems = new Set(quote.problems.map((p) => p.line_no));
  return (
    <ul className="divide-y divide-border-subtle">
      {quote.lines.map((l) => (
        <li key={l.line_no} className="flex items-start justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">{lineTitle(l, book, lang, t)}</p>
            <p className="text-[12px] text-text-muted">
              {lineDetail(l, book, lang, t)}
              {l.kind === 'material' ? ` · ${l.fulfillment === 'delivery' ? t(goods.deliver) : t(goods.keep)}` : ''}
            </p>
            {problems.has(l.line_no) ? <p className="text-[12px] font-semibold text-danger">{t(goods.notEnoughStock)}</p> : null}
          </div>
          <span className="flex shrink-0 flex-col items-end">
            <span className="text-sm font-bold text-text-primary">
              <Money iqd={l.final_price_iqd} />
            </span>
            {l.discount_iqd > 0 ? (
              <span className="text-[11px] text-text-muted line-through">
                <span className="sr-only">{t(goods.beforeDiscount)} </span>
                <Money iqd={l.base_price_iqd} />
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AddressForm({ value, onChange, showProblems }: { value: AddressDraft; onChange: (next: AddressDraft) => void; showProblems: boolean }) {
  const { t, lang } = useCloudText();
  const base = useId();
  const problems = new Set<string>(showProblems ? addressProblems(value) : []);
  // The label names the field alone; its hint and its problem are read after it (aria-describedby).
  const parts = (key: keyof AddressDraft, hint?: string) => {
    const id = `${base}-${key}`;
    const hintId = hint ? `${id}-hint` : undefined;
    const problemId = problems.has(key) ? `${id}-problem` : undefined;
    const notes = (
      <>
        {hint ? (
          <span id={hintId} className="mt-1 block text-[11px] text-text-muted">
            {hint}
          </span>
        ) : null}
        {problemId ? (
          <span id={problemId} className="mt-1 block text-[11px] font-semibold text-danger">
            {t(addressWords.required)}
          </span>
        ) : null}
      </>
    );
    const describedBy = [hintId, problemId].filter(Boolean).join(' ') || undefined;
    return { id, describedBy, invalid: problemId ? true : undefined, notes };
  };
  const labelOf = (id: string, text: string) => (
    <label htmlFor={id} className="mb-1 block text-[12px] font-semibold text-text-secondary">
      {text}
    </label>
  );
  const field = (key: keyof AddressDraft, label: string, extra: { type?: string; inputMode?: 'tel'; autoComplete?: string; dir?: 'ltr'; hint?: string } = {}) => {
    const p = parts(key, extra.hint);
    return (
      <div>
        {labelOf(p.id, label)}
        <input
          id={p.id}
          type={extra.type ?? 'text'}
          inputMode={extra.inputMode}
          autoComplete={extra.autoComplete}
          dir={extra.dir}
          value={value[key]}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          aria-invalid={p.invalid}
          aria-describedby={p.describedBy}
          maxLength={key === 'address_line' || key === 'notes' ? 300 : key === 'phone' ? 24 : 120}
          className="lv-input"
        />
        {p.notes}
      </div>
    );
  };
  const place = parts('governorate');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field('recipient_name', t(addressWords.recipient), { autoComplete: 'name' })}
      {field('phone', t(addressWords.phone), { type: 'tel', inputMode: 'tel', autoComplete: 'tel', dir: 'ltr', hint: t(addressWords.phoneHint) })}
      <div>
        {labelOf(place.id, t(addressWords.governorate))}
        <select
          id={place.id}
          value={value.governorate}
          onChange={(e) => onChange({ ...value, governorate: e.target.value })}
          aria-invalid={place.invalid}
          aria-describedby={place.describedBy}
          className="lv-input"
        >
          <option value="">{t(addressWords.chooseGovernorate)}</option>
          {GOVERNORATES.map((g) => (
            <option key={g.id} value={g.id}>
              {g[lang]}
            </option>
          ))}
        </select>
        {place.notes}
      </div>
      {field('city', t(addressWords.city), { autoComplete: 'address-level2' })}
      <div className="sm:col-span-2">{field('address_line', t(addressWords.line), { autoComplete: 'street-address' })}</div>
      <div className="sm:col-span-2">{field('notes', t(addressWords.notes))}</div>
    </div>
  );
}

/** A refused order: the server's own words, and for a quote that already became an order, the way to it. */
function RefusalText({ error }: { error: unknown }) {
  const { t, lang } = useCloudText();
  return (
    <span className="block space-y-1">
      <span className="block">{cloudErrorText(error, lang)}</span>
      {cloudErrorCode(error) === 'QUOTE_ALREADY_ORDERED' ? (
        <Link to="/orders" className="block font-semibold underline">
          {t(words.orderedBody)}
        </Link>
      ) : null}
    </span>
  );
}

/** «Prices held for 4:59» — the server's deadline, the clock an LTR island inside the translator's sentence. */
function HeldFor({ msLeft, expiresAt }: { msLeft: number; expiresAt: string }) {
  const { t, lang } = useCloudText();
  return (
    <p className="flex items-center justify-center gap-1.5 text-[12px] text-text-muted">
      <Hourglass aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span>
        {msLeft < CLOCK_LIMIT_MS ? (
          <Sentence
            text={t(words.heldFor)}
            slots={{
              clock: (
                <bdi dir="ltr" className="font-semibold tabular-nums text-text-primary">
                  {clockText(msLeft)}
                </bdi>
              ),
            }}
          />
        ) : (
          t(words.heldUntil, { date: formatDateTime(expiresAt, lang) })
        )}
      </span>
    </p>
  );
}

function OpenQuote({ quote, msLeft }: { quote: QuoteView; msLeft: number }) {
  const { t, lang } = useCloudText();
  const navigate = useNavigate();
  const { status, mainSite } = useCloud();
  const cart = useCart();
  const wallet = useCloudQuery((signal) => getWallet({ signal }), []);
  const [method, setMethod] = useState<Method>('levonis_wallet');
  const [draft, setDraft] = useState<AddressDraft>(EMPTY_ADDRESS);
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<unknown>(null);
  const [checked, setChecked] = useState(false);
  const walletOff = wallet.data?.connected === false;

  // The wallet is the default only while it can be used; switched off, the workshop is.
  useEffect(() => {
    if (walletOff) setMethod('manual');
  }, [walletOff]);
  useEffect(() => warm(OrderPage), []);

  const needsDelivery = quote.lines.some((l) => l.fulfillment === 'delivery');
  const deliveryOff = needsDelivery && status?.delivery.enabled === false;
  const address: DeliveryAddress | undefined = needsDelivery
    ? {
        recipient_name: draft.recipient_name.trim(),
        phone: phoneForServer(draft.phone),
        governorate: draft.governorate,
        city: draft.city.trim(),
        address_line: draft.address_line.trim(),
        ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
      }
    : undefined;
  const body: OrderRequest = { quote_id: quote.quote_id, payment_method: method, ...(address ? { delivery_address: address } : {}) };
  const bodyKey = JSON.stringify(body);
  // One key per exact body: a retry of this order sends it again; another method or address is another intent.
  const intent = useIdempotencyKey('order');
  const renew = intent.renew;
  useEffect(() => renew(), [bodyKey, renew]);

  const total = formatIqd(quote.total_iqd, lang);
  const addressMissing = needsDelivery && addressProblems(draft).length > 0;

  const place = async () => {
    setRefusal(null);
    try {
      const order = await createOrder(body, intent.key);
      // The cart lines this quote was made from are an order now.
      cart.remove(
        quoteInputsOf(quote.lines).flatMap((l) =>
          l.kind === 'credit_package' ? [lineKey('package', l.package_id, 'credits')] : l.kind === 'material' ? [lineKey('material', l.variant_id, l.fulfillment === 'delivery' ? 'delivery' : 'inventory')] : []
        )
      );
      setOpen(false);
      navigate(`/orders/${encodeURIComponent(order.order_id)}`, { replace: true, state: { placed: true } });
    } catch (e) {
      setRefusal(e);
    }
  };

  return (
    <>
      <section className="lv-surface space-y-3 p-4" aria-labelledby="cloud-checkout-pay">
        <h2 id="cloud-checkout-pay" className="text-[15px] font-bold text-text-primary">
          {t(words.payWith)}
        </h2>
        <Segmented
          group="cloud-checkout-method"
          label={t(words.payWith)}
          value={method}
          onChange={(id) => setMethod(id === 'manual' ? 'manual' : 'levonis_wallet')}
          items={[
            { id: 'levonis_wallet', label: t(paymentMethod.levonis_wallet), disabled: walletOff },
            { id: 'manual', label: t(words.manualShort) },
          ]}
        />
        {method === 'levonis_wallet' ? (
          <div className="space-y-2 rounded-xl lv-well p-3 text-[13px] leading-relaxed">
            <p className="text-text-secondary">{t(words.walletNote)}</p>
            {wallet.error ? (
              <CloudErrorState compact error={wallet.error} onRetry={wallet.reload} />
            ) : !wallet.data ? (
              <Skeleton className="h-4 w-40 rounded" />
            ) : walletOff ? (
              <p className="font-semibold text-warning">{t(header.walletOff)}</p>
            ) : (
              <>
                <p className="font-semibold text-text-primary">{t(words.walletBalance, { amount: formatIqd(wallet.data.available_iqd, lang) })}</p>
                {wallet.data.available_iqd < quote.total_iqd ? (
                  <>
                    <p className="font-semibold text-warning">{t(words.walletShort)}</p>
                    {mainSite ? (
                      <a href={`${mainSite}/wallet`} className="lv-button lv-button-secondary lv-button-sm">
                        {t(header.walletAddFunds)}
                        <ExternalLink aria-hidden="true" className="h-4 w-4" />
                      </a>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <p className="rounded-xl lv-well p-3 text-[13px] leading-relaxed text-text-secondary">{t(words.manualNote)}</p>
        )}
      </section>

      {needsDelivery ? (
        <section className="lv-surface space-y-3 p-4" aria-labelledby="cloud-checkout-address">
          <h2 id="cloud-checkout-address" className="text-[15px] font-bold text-text-primary">
            {t(words.deliveryTitle)}
          </h2>
          {deliveryOff ? (
            <p role="alert" className="text-[13px] font-semibold text-warning">
              {t(words.deliveryUnavailable)}
            </p>
          ) : (
            <>
              <AddressForm value={draft} onChange={setDraft} showProblems={checked} />
              <p className="text-[12px] leading-relaxed text-text-muted">{t(words.deliveryFeeNote)}</p>
            </>
          )}
        </section>
      ) : null}

      <div className="space-y-2">
        {checked && addressMissing ? (
          <p role="alert" className="text-[13px] font-semibold text-danger">
            {t(words.addressIncomplete)}
          </p>
        ) : null}
        <Button
          variant="primary"
          block
          icon={<Receipt aria-hidden="true" className="h-4 w-4" />}
          disabled={!quote.orderable || deliveryOff || (method === 'levonis_wallet' && walletOff)}
          onClick={() => {
            setChecked(true);
            if (addressMissing) return;
            setRefusal(null);
            setOpen(true);
          }}
        >
          {t(words.placeOrder)}
        </Button>
        <HeldFor msLeft={msLeft} expiresAt={quote.expires_at} />
      </div>

      <ConfirmDialog
        open={open}
        title={t(words.confirmTitle)}
        consequence={`${method === 'levonis_wallet' ? t(words.confirmWallet, { total }) : t(words.confirmManual, { total })}${needsDelivery ? ` ${t(words.confirmDeliveryFee)}` : ''}`}
        confirmLabel={t(words.placeOrder)}
        onConfirm={place}
        onCancel={() => setOpen(false)}
        error={refusal ? <RefusalText error={refusal} /> : undefined}
      />
    </>
  );
}

export default function CheckoutPage() {
  const { quoteId = '' } = useParams();
  const { t, lang } = useCloudText();
  const navigate = useNavigate();
  const now = useNow();
  const quote = useCloudQuery((signal) => getQuote(quoteId, { signal }), [quoteId]);
  const [requoteError, setRequoteError] = useState<unknown>(null);
  const back = { to: '/store/cart', label: t(cartWords.title) };

  if (quote.error) {
    return (
      <div>
        <PageHeader title={t(words.title)} back={back} />
        <CloudErrorState error={quote.error} onRetry={quote.reload} />
      </div>
    );
  }
  if (!quote.data || quote.data.quote_id !== quoteId) return <CloudPageSkeleton />;
  const q = quote.data;
  const state = quoteState(q, now);

  const requote = async () => {
    setRequoteError(null);
    try {
      const fresh = await createQuote({ lines: quoteInputsOf(q.lines) });
      navigate(`/store/checkout/${encodeURIComponent(fresh.quote_id)}`, { replace: true });
    } catch (e) {
      setRequoteError(e);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t(words.title)} subtitle={state.kind === 'open' ? t(words.subtitle) : undefined} back={back} />

      {state.kind === 'ordered' ? (
        <CloudEmptyState
          icon={<Receipt className="h-6 w-6" />}
          title={t(words.orderedTitle)}
          body={t(words.orderedBody)}
          action={
            <Link to="/orders" className="lv-button lv-button-primary">
              {t(store.myOrders)}
            </Link>
          }
        />
      ) : state.kind === 'expired' ? (
        <CloudEmptyState
          role="alert"
          icon={<Hourglass className="h-6 w-6" />}
          title={t(words.expiredTitle)}
          body={requoteError ? cloudErrorText(requoteError, lang) : t(words.expiredBody)}
          action={
            <Button variant="primary" onClick={requote}>
              {t(words.newQuote)}
            </Button>
          }
        />
      ) : null}

      <section className="lv-surface space-y-3 p-4" aria-labelledby="cloud-checkout-lines">
        <h2 id="cloud-checkout-lines" className="text-[15px] font-bold text-text-primary">
          {t(words.title)}
        </h2>
        <QuoteLines quote={q} />
        {q.promotions.length > 0 ? (
          <div className="space-y-1">
            <p className="text-[12px] font-semibold text-text-secondary">{t(words.discounts)}</p>
            <ul className="space-y-1 text-[12px] text-text-secondary">
              {q.promotions.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3">
                  <span>{p.code ? t(words.codeDiscount, { code: p.code }) : t(words.autoDiscount)}</span>
                  <Money iqd={-p.discount_iqd} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <AmountRows
          rows={[
            ...(q.discount_iqd > 0 ? [{ label: t(cartWords.subtotal), iqd: q.subtotal_iqd }, { label: t(goods.discount), iqd: q.discount_iqd, minus: true }] : []),
            { label: t(cartWords.total), iqd: q.total_iqd, strong: true },
          ]}
        />
      </section>

      {state.kind === 'open' && !q.orderable ? (
        <CloudEmptyState
          compact
          role="alert"
          icon={<TriangleAlert className="h-6 w-6" />}
          title={t(words.notOrderableTitle)}
          body={t(words.notOrderableBody)}
          action={
            <Link to="/store/cart" className="lv-button lv-button-secondary">
              {t(words.backToCart)}
            </Link>
          }
        />
      ) : null}

      {state.kind === 'open' ? <OpenQuote quote={q} msLeft={state.msLeft} /> : null}
    </div>
  );
}
