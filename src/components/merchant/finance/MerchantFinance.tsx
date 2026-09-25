/**
 * «الأرباح» — THE MERCHANT'S MONEY, AS THE LEDGER SAYS IT IS (W2-B).
 *
 * A self-contained screen the wave-3 workspace mounts unchanged at
 * /merchant/money; today the dashboard's earnings tab mounts it lazily.
 *
 * WHAT IT SHOWS, IN THE ORDER A MERCHANT ASKS:
 *   1. how much can I take out now — the one large figure, and the one
 *      primary action (a payout request);
 *   2. where the rest is — pending (and how much of it a complaint holds),
 *      reserved for requests, paid out, and custom-order money in escrow;
 *   3. how it adds up — a statement: sales, the commission, delivery fees,
 *      refunds, adjustments, and the net;
 *   4. my payout requests, with their state, reference or reason;
 *   5. every line, filterable, each linked to its order or request.
 *
 * NO FIGURE IS COMPUTED HERE. Every number is what the server summed over the
 * append-only ledger (worker/lib/merchantLedger.ts); an unanswered request is
 * a skeleton or an error with retry, never a zero.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Banknote, Clock, Lock, Send, ShieldCheck, ArrowUpRight, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { formatMoney } from '../../../lib/money';
import { Card } from '../../ui/Card';
import { KpiTile } from '../../ui/KpiTile';
import { Money } from '../../ui/Money';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { ErrorState } from '../../ui/AsyncStates';
import { CardSkeleton, KpiRowSkeleton } from '../../ui/DashboardSkeletons';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { Overlay } from '../../ui/Overlay';
import { financeApi, type FinanceSummary, type Payout, type PayoutsAnswer } from './financeApi';
import { financeStrings, payoutRefusalText, payoutStateLabel, payoutTone } from './strings';
import FinanceLedger from './FinanceLedger';
import PayoutRequestSheet from './PayoutRequestSheet';

export interface MerchantFinanceProps {
  /** Opens an order in the host's orders screen (the dashboard's tab today, a route in wave 3). */
  onOpenOrder?: (orderId: string) => void;
  /** Opens the host's custom-orders screen. */
  onOpenCustomOrders?: () => void;
}

type Load<T> = { data: T | null; error: unknown };

export default function MerchantFinance({ onOpenOrder, onOpenCustomOrders }: MerchantFinanceProps) {
  const { loc, lang } = useLanguage();
  const s = financeStrings(loc);
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const money = useCallback((iqd: number) => formatMoney(iqd, lang), [lang]);

  const [summary, setSummary] = useState<Load<FinanceSummary>>({ data: null, error: null });
  const [payouts, setPayouts] = useState<Load<PayoutsAnswer>>({ data: null, error: null });
  const [requesting, setRequesting] = useState(false);
  const [ledgerVersion, setLedgerVersion] = useState(0);
  const [focusPayout, setFocusPayout] = useState<string | null>(null);
  const [quickOrder, setQuickOrder] = useState<string | null>(null);

  const load = useCallback(() => {
    financeApi
      .summary()
      .then((d) => setSummary({ data: d.summary, error: null }))
      .catch((error) => setSummary((was) => ({ data: was.data, error })));
    financeApi
      .payouts()
      .then((d) => setPayouts({ data: d, error: null }))
      .catch((error) => setPayouts((was) => ({ data: was.data, error })));
  }, []);
  useEffect(load, [load]);

  const refreshAll = () => {
    load();
    setLedgerVersion((v) => v + 1);
  };

  const sum = summary.data;
  if (!sum && summary.error) {
    return <ErrorState error={summary.error} onRetry={load} />;
  }

  async function cancel(p: Payout) {
    const ok = await confirm({
      title: s.cancelTitle,
      consequence: s.cancelConsequence(money(p.amount_iqd)),
      confirmLabel: s.cancelRequest,
      cancelLabel: s.keepRequest,
      destructive: true,
    });
    if (!ok) return;
    try {
      await financeApi.cancelPayout(p.id);
      toast.success(s.cancelled);
      refreshAll();
    } catch (e) {
      toast.error(payoutRefusalText(e instanceof ApiError ? e.code : undefined, e instanceof ApiError ? e.details : undefined, loc, money));
      refreshAll();
    }
  }

  const available = sum?.available ?? 0;

  return (
    <div className="space-y-3" data-merchant-finance>
      {/* 1 · what can I take out now */}
      <section aria-labelledby="finance-available" className="lv-surface p-4 sm:p-5">
        <p id="finance-available" className="text-[13px] font-medium text-text-secondary">{s.availableHero}</p>
        {sum ? (
          <p className="mt-1 text-[30px] sm:text-[34px] leading-tight font-bold text-text-primary" data-finance-available>
            <Money iqd={sum.available} />
          </p>
        ) : (
          <div aria-hidden="true" className="mt-2 h-9 w-44 rounded-md bg-white/[0.06] animate-pulse" />
        )}
        {sum && sum.available < 0 && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-warning" role="note">{s.debt}</p>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            variant="primary"
            icon={<Send aria-hidden="true" className="h-4 w-4" />}
            onClick={() => setRequesting(true)}
            disabled={!sum || !payouts.data || available <= 0}
            className="sm:min-w-[220px]"
            data-request-payout
          >
            {s.requestPayout}
          </Button>
          {sum && available <= 0 && <p className="text-[12.5px] text-text-muted">{s.nothingToWithdraw}</p>}
        </div>
      </section>

      {/* 2 · where the rest is */}
      {sum ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-finance-tiles>
          <KpiTile
            label={s.pending}
            icon={<Clock className="h-4 w-4" />}
            value={<Money iqd={sum.pending} />}
            hint={sum.pending_frozen > 0 ? s.frozenHint(money(sum.pending_frozen)) : s.pendingHint}
          />
          <KpiTile
            label={s.reserved}
            icon={<Lock className="h-4 w-4" />}
            value={<Money iqd={sum.reserved} />}
            hint={sum.open_payouts > 0 ? s.reservedHint(sum.open_payouts) : undefined}
          />
          <KpiTile label={s.paidOut} icon={<Banknote className="h-4 w-4" />} value={<Money iqd={sum.paid_out} />} />
          <KpiTile label={s.escrowHeld} icon={<ShieldCheck className="h-4 w-4" />} value={<Money iqd={sum.escrow_held} />} hint={s.escrowHint} />
        </div>
      ) : (
        <KpiRowSkeleton count={4} />
      )}

      {/* 3 · how it adds up */}
      {sum ? <Statement sum={sum} /> : <CardSkeleton lines={5} />}

      {/* 4 · my payout requests */}
      <PayoutHistory
        load={payouts}
        focus={focusPayout}
        onRetry={load}
        onCancel={cancel}
      />

      {/* 5 · every line */}
      <FinanceLedger
        version={ledgerVersion}
        onOpenOrder={(id) => setQuickOrder(id)}
        onOpenPayout={(id) => {
          setFocusPayout(id);
          document.getElementById(`payout-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
        onOpenCustomOrders={onOpenCustomOrders}
      />

      {payouts.data && sum && (
        <PayoutRequestSheet
          open={requesting}
          onClose={() => setRequesting(false)}
          available={sum.available}
          methods={payouts.data.methods}
          onRequested={() => {
            toast.success(s.requested);
            refreshAll();
          }}
        />
      )}
      <OrderQuickLook id={quickOrder} onClose={() => setQuickOrder(null)} onOpenOrder={onOpenOrder} />
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------- statement

function Statement({ sum }: { sum: FinanceSummary }) {
  const { loc, lang } = useLanguage();
  const s = financeStrings(loc);
  const money = (iqd: number) => formatMoney(iqd, lang);
  const rows: Array<{ label: string; value: number; sign: '+' | '−' | '±'; sub?: string }> = [
    { label: s.gross, value: sum.gross, sign: '+', sub: sum.custom_gross > 0 ? `${s.grossMeans} ${s.grossBreakdown(money(sum.store_gross), money(sum.custom_gross))}` : s.grossMeans },
    { label: s.commission, value: sum.commission, sign: '−' },
    { label: s.deliveryFees, value: sum.delivery_fees, sign: '+' },
    { label: s.refunds, value: sum.refunds, sign: '−' },
  ];
  if (sum.adjustments !== 0) rows.push({ label: s.adjustments, value: sum.adjustments, sign: '±' });
  return (
    <Card title={s.statement} description={s.statementNote}>
      <dl className="text-[13.5px]" data-finance-statement>
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 py-2 border-b border-white/[0.06]">
            <dt className="min-w-0">
              <span className="text-text-secondary">{r.label}</span>
              {r.sub && <span className="block text-[12px] text-text-muted">{r.sub}</span>}
            </dt>
            <dd className="shrink-0 font-semibold text-text-primary">
              {r.sign === '±' ? <Money iqd={r.value} signed /> : (
                <>
                  <span aria-hidden="true" className="text-text-muted">{r.value === 0 ? '' : r.sign === '+' ? '+' : '−'}</span>
                  <Money iqd={r.value} />
                </>
              )}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 pt-3">
          <dt className="font-bold text-text-primary">{s.receivable}</dt>
          <dd className="shrink-0 text-[15px] font-bold text-text-primary" data-finance-receivable>
            <Money iqd={sum.receivable} />
          </dd>
        </div>
      </dl>
    </Card>
  );
}

// ------------------------------------------------------------------ payouts

function maskAccount(account: string): string {
  const a = account.trim();
  return a.length > 4 ? `•••${a.slice(-4)}` : a;
}

function PayoutHistory({
  load,
  focus,
  onRetry,
  onCancel,
}: {
  load: Load<PayoutsAnswer>;
  focus: string | null;
  onRetry: () => void;
  onCancel: (p: Payout) => void;
}) {
  const { loc, lang } = useLanguage();
  const s = financeStrings(loc);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-IQ', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const list = load.data?.payouts;
  return (
    <Card title={s.payouts} padding="none">
      {!list && load.error ? (
        <ErrorState error={load.error} onRetry={onRetry} compact />
      ) : !list ? (
        <div className="p-4"><CardSkeleton lines={2} /></div>
      ) : list.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-text-muted">{s.payoutsEmpty}</p>
      ) : (
        <ul className="divide-y divide-white/[0.06]" data-payout-history>
          {list.map((p) => (
            <li
              key={p.id}
              id={`payout-${p.id}`}
              className={`px-4 py-3 transition-colors ${focus === p.id ? 'bg-white/[0.04]' : ''}`}
              data-payout-state={p.state}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-bold text-text-primary"><Money iqd={p.amount_iqd} /></p>
                  <p className="mt-0.5 text-[12px] text-text-muted">
                    {date(p.created_at)}
                    {p.method.label ? ` · ${p.method.label}` : ''}
                    {p.method.account ? <> · <bdi dir="ltr">{maskAccount(p.method.account)}</bdi></> : null}
                    {p.source !== 'merchant' ? ` · ${s.byLevonis}` : ''}
                  </p>
                </div>
                <StatusChip tone={payoutTone(p.state)}>{payoutStateLabel(p.state, loc)}</StatusChip>
              </div>
              {p.state === 'paid' && p.reference && p.source !== 'legacy' && (
                <p className="mt-1.5 text-[12px] text-text-secondary">{s.reference(p.reference)}</p>
              )}
              {p.state === 'failed' && p.decision_reason && (
                <p className="mt-1.5 text-[12px] text-danger">{s.failReason(p.decision_reason)}</p>
              )}
              {p.state === 'requested' && (
                <div className="mt-2">
                  <Button variant="ghost" size="sm" icon={<X aria-hidden="true" className="h-4 w-4" />} onClick={() => onCancel(p)} data-cancel-payout>
                    {s.cancelRequest}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------ order quick look

function OrderQuickLook({ id, onClose, onOpenOrder }: { id: string | null; onClose: () => void; onOpenOrder?: (id: string) => void }) {
  const { loc } = useLanguage();
  const s = financeStrings(loc);
  const titleId = useId();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    financeApi.order(id).then((d) => setData(d.order)).catch(setError);
  }, [id]);
  const credit = String(data?.credit_state ?? '');
  const creditLabel =
    credit === 'pending' ? loc('قيد الانتظار', 'Pending', 'چاوەڕوان')
      : credit === 'available' ? loc('متاح', 'Available', 'بەردەست')
        : credit === 'reversed' ? loc('أُلغي — لا يُحتسب', 'Reversed — not counted') // OWNER: Sorani to be written by hand.
          : '—';
  return (
    <Overlay open={!!id} onClose={onClose} labelledBy={titleId} placement="center" panelClassName="w-full max-w-sm">
      {() => (
        <div className="p-4 space-y-3" data-order-quicklook>
          <div className="flex items-center justify-between gap-2">
            <h2 id={titleId} className="text-[15px] font-bold text-text-primary"><bdi dir="ltr">{id}</bdi></h2>
            <button type="button" onClick={onClose} aria-label={s.back} className="h-11 w-11 -me-2 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
          {error ? (
            <ErrorState error={error} compact />
          ) : !data ? (
            <CardSkeleton lines={3} />
          ) : (
            <dl className="text-[13px] space-y-2">
              {[
                [loc('المجموع الذي دفعه الزبون', 'Customer paid'), <Money key="t" iqd={Number(data.total_iqd)} />], // OWNER: Sorani to be written by hand.
                [loc('عمولة المنصة', 'Platform commission', 'کۆمیشن'), <Money key="f" iqd={Number(data.platform_fee_iqd)} />],
                [loc('حصتك', 'Your share'), <Money key="r" iqd={Number(data.merchant_receivable_iqd)} />], // OWNER: Sorani to be written by hand.
                [loc('حالة المبلغ', 'Money status'), creditLabel], // OWNER: Sorani to be written by hand.
              ].map(([k, v], i) => (
                <div key={i} className="flex items-baseline justify-between gap-3">
                  <dt className="text-text-muted">{k}</dt>
                  <dd className="font-semibold text-text-primary">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {onOpenOrder && id && (
            <Button variant="secondary" block iconEnd={<ArrowUpRight aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />} onClick={() => { onClose(); onOpenOrder(id); }}>
              {loc('افتح في الطلبات', 'Open in Orders')}
              {/* OWNER: Sorani to be written by hand. */}
            </Button>
          )}
        </div>
      )}
    </Overlay>
  );
}
