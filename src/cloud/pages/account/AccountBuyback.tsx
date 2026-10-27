/**
 * /account/buyback — SELLING UNUSED MATERIAL BACK (GET /store/categories,
 * /me/inventory, /buybacks; POST /buybacks/quote, /buybacks,
 * /buybacks/{id}/cancel).
 *
 * The workshop decides PER CATEGORY whether it buys back and at what share of
 * what was paid (the category's own switch and rate — accessories never
 * inherit the filament rule). A quote is the server's: the units come from
 * the customer's oldest purchases first and are valued at what was paid for
 * them, times the rate. Requesting holds the units until the workshop
 * decides; the final amount is the one it records on approval. A request still
 * waiting can be cancelled, and the units return once.
 *
 * Requesting is a money door (it reserves the grams): one Idempotency-Key per
 * intent (shared.tsx `useIntentKey`), kept across every retry of that intent,
 * so a request whose answer was lost, sent again, is the same request — the
 * server replays it instead of holding the grams twice.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Field, Select } from '../../../components/ui/Field';
import { Money } from '../../../components/ui/Money';
import { NumberInput } from '../../../components/ui/NumberInput';
import { formatFigure, formatPercent } from '../../../lib/localeNumber';
import { toast } from '../../../lib/toastStore';
import { buybackQuote, cancelBuyback, cloudErrorText, listBuybacks, listInventory, listStoreCategories, requestBuyback } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDate, formatQuantity, unitWord } from '../../format';
import { buybackText, sect } from '../../strings/account';
import { nameOf, tx, useCloudText } from '../../text';
import type { BuybackQuote, BuybackSummary, InventoryBalance, StoreCategory } from '../../types';
import { CloudEmptyState, CloudErrorState, CloudPageSkeleton, HandCoins, Info, SectionHeader } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { bpsPercent, buybackCancellable, buybackRates, sellableRows } from './logic';
import { BuybackPill, CapNote, Figures, MoneyLine, PayoutPill, SubPageHeader, useIntentKey } from './shared';

/** The server's own cap on the sell-backs it lists (GET /buybacks). */
const SELLBACKS_CAP = 200;

type Typed = { value: number | null; valid: boolean };

function useRateText() {
  const { lang } = useCloudText();
  // Basis points as the percentage they are, up to two decimals (3,755 → 37.55 %): display only.
  return (bps: number) => formatPercent(bpsPercent(bps), lang, 2);
}

function useQtyText() {
  const { lang } = useCloudText();
  return (qty: number, row: InventoryBalance | null | undefined) => (row ? formatQuantity(qty, row.unit_code, lang) : formatFigure(qty, lang));
}

function Rates({ categories, rates }: { categories: StoreCategory[]; rates: Map<string, number> }) {
  const { t, lang } = useCloudText();
  const rate = useRateText();
  const open = categories.filter((c) => rates.has(c.code));
  if (open.length === 0) {
    return (
      <p className="flex items-start gap-2 rounded-xl lv-well px-3 py-2 text-[13px] leading-snug text-text-secondary">
        <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        {t(buybackText.closed)}
      </p>
    );
  }
  return (
    <section aria-labelledby="cloud-buyback-rates" className="space-y-1.5">
      <h2 id="cloud-buyback-rates" className="text-sm font-bold text-text-primary">
        {t(buybackText.rates)}
      </h2>
      <ul className="space-y-1">
        {open.map((c) => (
          <li key={c.code} className="text-[13px] text-text-secondary">
            {t(buybackText.rateLine, { category: nameOf(c, lang) || c.code, rate: rate(rates.get(c.code) ?? 0) })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SellForm({ rows, preselect }: { rows: InventoryBalance[]; preselect: string | null }) {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const rate = useRateText();
  const qtyText = useQtyText();
  const [variant, setVariant] = useState(() => (preselect && rows.some((r) => r.variant_id === preselect) ? preselect : ''));
  const [qty, setQty] = useState<Typed>({ value: null, valid: true });
  const [quote, setQuote] = useState<BuybackQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const row = rows.find((r) => r.variant_id === variant) ?? null;
  const ready = !!row && qty.valid && qty.value != null && qty.value >= 1 && qty.value <= row.available_qty;
  const tooMuch = !!row && qty.value != null && qty.value > row.available_qty;
  // What the request will carry: the quoted material and quantity — its key is made once for it.
  const body = quote ? { variant_id: quote.variant_id, qty: quote.qty } : null;
  const intent = useIntentKey('buyback', body);

  const getQuote = async () => {
    if (!row || !ready || qty.value == null) return;
    setError(null);
    setQuote(null);
    try {
      setQuote(await buybackQuote(row.variant_id, qty.value));
    } catch (e) {
      setError(cloudErrorText(e, lang));
    }
  };

  const request = async () => {
    if (!body) return;
    setConfirmError(null);
    try {
      await requestBuyback(body.variant_id, body.qty, intent.key);
      intent.renew();
      toast.success(t(buybackText.requested));
      setConfirming(false);
      setQuote(null);
      setQty({ value: null, valid: true });
      cloud.refreshDashboard();
    } catch (e) {
      setConfirmError(cloudErrorText(e, lang));
    }
  };

  if (rows.length === 0) return <p className="text-[13px] text-text-muted">{t(buybackText.nothingToSell)}</p>;
  return (
    <section aria-labelledby="cloud-buyback-form" className="lv-surface space-y-3 p-4">
      <h2 id="cloud-buyback-form" className="flex items-center gap-2 text-[17px] font-bold text-text-primary">
        <HandCoins aria-hidden="true" className="h-5 w-5 text-text-secondary" />
        {t(buybackText.formTitle)}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t(buybackText.material)}>
          <Select
            value={variant}
            onChange={(e) => {
              setVariant(e.currentTarget.value);
              setQuote(null);
            }}
          >
            <option value="">{t(buybackText.choose)}</option>
            {rows.map((r) => (
              <option key={r.variant_id} value={r.variant_id}>
                {tx(r.name, lang) || r.sku}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t(buybackText.qty)}
          hint={row ? t(buybackText.freeToSell, { qty: qtyText(row.available_qty, row) }) : undefined}
          error={tooMuch ? t(buybackText.tooMuch) : undefined}
        >
          <NumberInput
            kind="number"
            decimals={0}
            min={1}
            max={row?.available_qty}
            unit={row ? unitWord(row.unit_code, lang) : undefined}
            value={qty.value}
            disabled={!row}
            onValueChange={(value, valid) => {
              setQty({ value, valid });
              setQuote(null);
            }}
          />
        </Field>
      </div>
      <Button variant="secondary" disabled={!ready} onClick={getQuote}>
        {t(buybackText.getQuote)}
      </Button>
      {error ? (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
      {quote && row ? (
        <div role="status" className="space-y-3">
          <Figures
            items={[
              { label: t(buybackText.quoteRate), value: rate(quote.rate_bps) },
              { label: t(buybackText.quotePaid), value: <Money iqd={quote.purchase_value_iqd} /> },
              { label: t(buybackText.quoteValue), value: <Money iqd={quote.estimated_value_iqd} /> },
            ]}
          />
          <p className="text-[12px] leading-relaxed text-text-muted">{t(buybackText.quoteNote)}</p>
          <Button variant="primary" block onClick={() => setConfirming(true)}>
            {t(buybackText.request)}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming && !!quote}
        title={t(buybackText.confirmTitle)}
        consequence={
          quote && row ? (
            <MoneyLine text={buybackText.confirmBody} iqd={quote.estimated_value_iqd} vars={{ qty: qtyText(quote.qty, row), name: tx(row.name, lang) || row.sku }} />
          ) : null
        }
        confirmLabel={t(buybackText.request)}
        cancelLabel={t(sect.goBack)}
        onConfirm={request}
        onCancel={() => {
          setConfirming(false);
          setConfirmError(null);
        }}
        error={confirmError}
      />
    </section>
  );
}

function SellBacks({ list, inventory }: { list: BuybackSummary[]; inventory: InventoryBalance[] }) {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const rate = useRateText();
  const qtyText = useQtyText();
  const [cancelling, setCancelling] = useState<BuybackSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rowOf = (variantId: string) => inventory.find((r) => r.variant_id === variantId) ?? null;

  const cancel = async () => {
    if (!cancelling) return;
    setError(null);
    try {
      await cancelBuyback(cancelling.id);
      toast.success(t(buybackText.cancelled));
      setCancelling(null);
      cloud.refreshDashboard();
    } catch (e) {
      setError(cloudErrorText(e, lang));
    }
  };

  return (
    <section aria-labelledby="cloud-buyback-list" className="space-y-2">
      <SectionHeader id="cloud-buyback-list" title={t(buybackText.listTitle)} count={list.length} />
      {list.length === 0 ? (
        <p className="text-[13px] text-text-muted">{t(buybackText.listEmpty)}</p>
      ) : (
        <ul className="space-y-2">
          {list.map((b) => {
            const row = rowOf(b.variant_id);
            return (
              <li key={b.id} className="lv-surface space-y-1.5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-semibold text-text-primary">
                    {row ? tx(row.name, lang) || row.sku : t(sect.unknownMaterial)} · <bdi>{qtyText(b.qty, row)}</bdi>
                  </p>
                  <BuybackPill status={b.status} />
                </div>
                <p className="text-[12px] text-text-muted">
                  {formatDate(b.created_at, lang)} · {t(buybackText.rateOf, { rate: rate(b.rate_bps) })}
                </p>
                <p className="text-[13px] font-semibold text-text-primary">
                  {b.final_value_iqd != null ? (
                    <MoneyLine text={buybackText.final} iqd={b.final_value_iqd} />
                  ) : (
                    <MoneyLine text={buybackText.estimated} iqd={b.estimated_value_iqd} />
                  )}
                </p>
                {b.status === 'approved' ? <PayoutPill status={b.payout_status} /> : null}
                {buybackCancellable(b.status) ? (
                  <Button variant="ghost" size="sm" onClick={() => setCancelling(b)}>
                    {t(buybackText.cancel)}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <CapNote shown={list.length} cap={SELLBACKS_CAP} />
      <ConfirmDialog
        open={!!cancelling}
        destructive
        title={t(buybackText.cancelTitle)}
        consequence={t(buybackText.cancelBody)}
        confirmLabel={t(buybackText.cancel)}
        cancelLabel={t(sect.goBack)}
        onConfirm={cancel}
        onCancel={() => {
          setCancelling(null);
          setError(null);
        }}
        error={error}
      />
    </section>
  );
}

export default function AccountBuyback() {
  const { t } = useCloudText();
  const { dashboardVersion } = useCloud();
  const [params] = useSearchParams();
  const data = useCloudQuery(
    (signal) =>
      Promise.all([listStoreCategories({ signal }), listInventory(undefined, { signal }), listBuybacks({ signal })]).then(([categories, inventory, list]) => ({
        categories,
        inventory,
        list,
      })),
    [dashboardVersion]
  );
  const header = <SubPageHeader title={t(buybackText.title)} subtitle={t(buybackText.subtitle)} />;

  if (data.error) {
    return (
      <div>
        {header}
        <CloudErrorState error={data.error} onRetry={data.reload} />
      </div>
    );
  }
  if (!data.data) {
    return (
      <div>
        {header}
        <CloudPageSkeleton />
      </div>
    );
  }
  const { categories, inventory, list } = data.data;
  const rates = buybackRates(categories);
  const rows = sellableRows(inventory, rates);

  return (
    <div className="space-y-5">
      {header}
      <Rates categories={categories} rates={rates} />
      {rates.size > 0 ? <SellForm key={rows.map((r) => `${r.variant_id}:${r.available_qty}`).join('|')} rows={rows} preselect={params.get('variant')} /> : null}
      {list.length === 0 && rates.size === 0 ? (
        <CloudEmptyState compact icon={<HandCoins className="h-6 w-6" />} title={t(buybackText.listEmpty)} />
      ) : (
        <SellBacks list={list} inventory={inventory} />
      )}
    </div>
  );
}
