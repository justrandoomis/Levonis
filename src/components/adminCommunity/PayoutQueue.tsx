/**
 * «طلبات تحويل أرباح التجار» — THE ADMIN PAYOUT QUEUE (W2-B).
 *
 * Merchants ask to be paid from the finance page; the money is already
 * RESERVED in their ledger. Here the owner or a financial admin:
 *   · approves a request (it stays reserved — nothing is sent yet);
 *   · marks it paid WITH the transfer's reference (reserved → paid);
 *   · or fails it with a reason (reserved → back to the merchant's available).
 * Each is one audited server decision (worker/lib/merchantLedger.ts); a
 * double tap replays, never pays twice. The oldest open request is first.
 *
 * The account number is shown here — this is where the transfer is made
 * from — and nowhere in a group chat. An assistant-scope admin gets 403
 * FINANCIAL_SCOPE_REQUIRED, said in words, not a spinner.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Check, CircleX, Send } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../ui/Button';
import { StatusChip } from '../ui/Badge';
import { Money } from '../ui/Money';
import { Segmented } from '../ui/Segmented';
import { Overlay } from '../ui/Overlay';
import { Field, Input } from '../ui/Field';
import { useConfirm } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import ReasonSheet, { type ReasonRequest } from './ReasonSheet';

type T = (ar: string, en: string) => string;
type QueueState = 'open' | 'paid' | 'failed' | 'cancelled';

export interface QueuePayout {
  id: string;
  amount_iqd: number;
  state: 'requested' | 'approved' | 'paid' | 'failed' | 'cancelled';
  source: 'merchant' | 'admin' | 'legacy';
  method: { channel: string; label: string; account: string; holder: string };
  note: string;
  reference: string;
  decision_reason: string;
  created_at: string;
  merchant: { id: string; name: string; status: string; store_name: string; store_slug: string; available_iqd: number; reserved_iqd: number };
}

export const payoutQueueApi = {
  list: (state: QueueState, cursor?: string | null) =>
    api.get<{ payouts: QueuePayout[]; next_cursor: string | null }>(
      `/api/admin/community/payouts?state=${state}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    ),
  approve: (id: string) => api.post<{ replayed: boolean }>(`/api/admin/community/payouts/${encodeURIComponent(id)}/approve`),
  paid: (id: string, reference: string) =>
    api.post<{ replayed: boolean }>(`/api/admin/community/payouts/${encodeURIComponent(id)}/paid`, { reference }),
  fail: (id: string, reason: string) =>
    api.post<{ replayed: boolean }>(`/api/admin/community/payouts/${encodeURIComponent(id)}/fail`, { reason }),
};

/** The queue routes' refusals in the panel's words — never the code or the English. */
export function queueRefusal(e: unknown, t: T): string {
  const code = e instanceof ApiError ? e.code : '';
  if (code === 'PAYOUT_STATE_CONFLICT') return t('تغيّر هذا الطلب منذ تحميل القائمة — حدّثها.', 'This request changed since the list loaded — refresh it.');
  if (code === 'PAYOUT_REFERENCE_REQUIRED') return t('اكتب مرجع التحويل (3 أحرف على الأقل).', 'Write the transfer reference (at least 3 characters).');
  if (code === 'REASON_REQUIRED') return t('اكتب السبب.', 'Write the reason.');
  if (code === 'FINANCIAL_SCOPE_REQUIRED') return t('هذا القرار للمالك أو الدور المالي فقط.', 'Only the owner or a financial admin can decide this.');
  if (code === 'NOT_FOUND') return t('لم يعد هذا الطلب موجودًا.', 'This request no longer exists.');
  return t('تعذّر التنفيذ — حاول مجددًا.', 'Could not complete it — try again.');
}

const STATE_LABEL = (s: QueuePayout['state'], t: T) =>
  s === 'requested' ? t('بانتظار المراجعة', 'Awaiting review')
    : s === 'approved' ? t('موافق عليه — حوّله', 'Approved — transfer it')
      : s === 'paid' ? t('حُوِّل', 'Paid')
        : s === 'failed' ? t('لم يتم', 'Failed')
          : t('ألغاه التاجر', 'Cancelled by the merchant');
const STATE_TONE = (s: QueuePayout['state']) =>
  s === 'requested' ? 'warning' : s === 'approved' ? 'info' : s === 'paid' ? 'success' : s === 'failed' ? 'danger' : 'neutral';

export default function PayoutQueue({ t }: { t: T }) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [state, setState] = useState<QueueState>('open');
  const [rows, setRows] = useState<QueuePayout[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<'loading' | 'ready' | 'scope' | 'error'>('loading');
  const [ask, setAsk] = useState<ReasonRequest | null>(null);
  const [paying, setPaying] = useState<QueuePayout | null>(null);
  const lang = t('ar', 'en') === 'ar' ? 'ar' : 'en';
  const date = (iso: string) =>
    new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-IQ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  const refresh = useCallback(() => {
    setLoad((l) => (l === 'ready' ? 'ready' : 'loading'));
    payoutQueueApi
      .list(state)
      .then((d) => {
        setRows(d.payouts);
        setCursor(d.next_cursor);
        setLoad('ready');
      })
      .catch((e) => setLoad(e instanceof ApiError && e.code === 'FINANCIAL_SCOPE_REQUIRED' ? 'scope' : 'error'));
  }, [state]);
  useEffect(() => {
    setRows(null);
    refresh();
  }, [refresh]);

  const more = () =>
    cursor &&
    payoutQueueApi.list(state, cursor).then((d) => {
      setRows((r) => [...(r ?? []), ...d.payouts]);
      setCursor(d.next_cursor);
    }).catch(() => toast.error(t('تعذّر تحميل المزيد.', 'Could not load more.')));

  async function approve(p: QueuePayout) {
    const ok = await confirm({
      title: t(`الموافقة على تحويل ${p.merchant.store_name || p.merchant.name}؟`, `Approve ${p.merchant.store_name || p.merchant.name}'s payout?`),
      consequence: t('يبقى المبلغ محجوزًا حتى تسجّل التحويل بمرجعه. لم يعد التاجر قادرًا على إلغائه.', 'The amount stays reserved until you record the transfer with its reference. The merchant can no longer cancel it.'),
      confirmLabel: t('موافقة', 'Approve'),
    });
    if (!ok) return;
    try {
      await payoutQueueApi.approve(p.id);
      toast.success(t('تمت الموافقة. حوّل المبلغ ثم سجّل مرجعه.', 'Approved. Make the transfer, then record its reference.'));
    } catch (e) {
      toast.error(queueRefusal(e, t));
    }
    refresh();
  }

  return (
    <section className="space-y-3" data-payout-queue>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-white font-bold text-[14px]">{t('طلبات تحويل أرباح التجار', 'Merchant payout requests')}</h3>
      </div>
      <div className="overflow-x-auto hide-scrollbar">
        <Segmented
          items={[
            { id: 'open', label: t('مفتوحة', 'Open') },
            { id: 'paid', label: t('محوّلة', 'Paid') },
            { id: 'failed', label: t('لم تتم', 'Failed') },
            { id: 'cancelled', label: t('ملغاة', 'Cancelled') },
          ]}
          value={state}
          onChange={(v) => setState(v as QueueState)}
          label={t('حالة الطلبات', 'Request state')}
          group="payout-queue-state"
          size="sm"
          className="min-w-[380px]"
        />
      </div>
      {load === 'scope' ? (
        <p className="rounded-2xl border border-zinc-700/50 bg-zinc-800/30 px-4 py-3 text-zinc-400 text-[12.5px]" data-finance-scope>
          {t('طلبات التحويل وقراراتها للمالك أو الدور المالي فقط.', 'Payout requests and their decisions are for the owner or a financial admin only.')}
        </p>
      ) : load === 'error' && !rows ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-700/50 px-4 py-3 text-[12.5px] text-zinc-300" role="alert">
          {t('تعذّر تحميل الطلبات.', 'Could not load the requests.')}
          <Button variant="secondary" size="sm" onClick={refresh}>{t('إعادة المحاولة', 'Try again')}</Button>
        </div>
      ) : !rows ? (
        <div className="h-24 rounded-2xl bg-white/[0.04] animate-pulse" aria-hidden="true" />
      ) : rows.length === 0 ? (
        <p className="text-zinc-500 text-[12.5px]" data-queue-empty>
          {state === 'open' ? t('لا توجد طلبات تنتظر.', 'No requests are waiting.') : t('لا شيء هنا.', 'Nothing here.')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.id} className="lv-surface p-3.5" data-queue-row={p.state}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-white text-[13.5px] font-semibold truncate">{p.merchant.store_name || p.merchant.name}</p>
                  <p className="text-zinc-500 text-[11.5px]">{date(p.created_at)}{p.source !== 'merchant' ? ` · ${t('سجّلته الإدارة', 'recorded by an admin')}` : ''}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className="text-white text-[16px] font-bold"><Money iqd={p.amount_iqd} /></span>
                  <StatusChip tone={STATE_TONE(p.state)}>{STATE_LABEL(p.state, t)}</StatusChip>
                </div>
              </div>
              <dl className="mt-2.5 grid grid-cols-1 gap-1 text-[12px] sm:grid-cols-2">
                <div className="flex gap-1.5"><dt className="text-zinc-500">{t('القناة:', 'Channel:')}</dt><dd className="text-zinc-200">{p.method.label || p.method.channel}</dd></div>
                {p.method.account && (
                  <div className="flex gap-1.5"><dt className="text-zinc-500">{t('الحساب:', 'Account:')}</dt><dd className="text-zinc-200 select-all" dir="ltr">{p.method.account}</dd></div>
                )}
                {p.method.holder && (
                  <div className="flex gap-1.5"><dt className="text-zinc-500">{t('صاحب الحساب:', 'Holder:')}</dt><dd className="text-zinc-200">{p.method.holder}</dd></div>
                )}
                <div className="flex gap-1.5">
                  <dt className="text-zinc-500">{t('رصيد التاجر:', 'Merchant balance:')}</dt>
                  <dd className="text-zinc-200">
                    {t('متاح', 'available')} <Money iqd={p.merchant.available_iqd} /> · {t('محجوز', 'reserved')} <Money iqd={p.merchant.reserved_iqd} />
                  </dd>
                </div>
                {p.merchant.status && p.merchant.status !== 'active' && (
                  <div className="sm:col-span-2"><StatusChip tone="danger">{p.merchant.status === 'suspended' ? t('حساب التاجر موقوف', 'Merchant suspended') : p.merchant.status === 'restricted' ? t('حساب التاجر مقيّد', 'Merchant restricted') : t('حساب التاجر ليس نشطًا', 'Merchant not active')}</StatusChip></div>
                )}
                {p.note && <div className="sm:col-span-2 text-zinc-400">{t('ملاحظة التاجر:', 'Merchant note:')} {p.note}</div>}
                {p.reference && p.state === 'paid' && <div className="sm:col-span-2 text-zinc-400">{t('المرجع:', 'Reference:')} {p.reference}</div>}
                {p.decision_reason && p.state === 'failed' && <div className="sm:col-span-2 text-red-300">{t('السبب:', 'Reason:')} {p.decision_reason}</div>}
              </dl>
              {(p.state === 'requested' || p.state === 'approved') && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {p.state === 'requested' ? (
                    <Button variant="primary" size="sm" icon={<Check aria-hidden="true" className="h-4 w-4" />} onClick={() => approve(p)} data-approve-payout>
                      {t('موافقة', 'Approve')}
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" icon={<Send aria-hidden="true" className="h-4 w-4" />} onClick={() => setPaying(p)} data-mark-paid>
                      {t('سجّل التحويل', 'Record transfer')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<CircleX aria-hidden="true" className="h-4 w-4" />}
                    onClick={() =>
                      setAsk({
                        title: t('رفض طلب التحويل', 'Fail this payout'),
                        consequence: t(
                          'يعود المبلغ إلى رصيد التاجر المتاح، ويرى التاجر السبب الذي تكتبه.',
                          'The amount goes back to the merchant’s available balance, and the merchant sees the reason you write.'
                        ),
                        confirmLabel: t('رفض الطلب', 'Fail payout'),
                        danger: true,
                        onConfirm: async (reason) => {
                          try {
                            await payoutQueueApi.fail(p.id, reason);
                            toast.success(t('أُعيد المبلغ إلى رصيد التاجر.', 'The amount is back in the merchant’s balance.'));
                            refresh();
                          } catch (e) {
                            throw new Error(queueRefusal(e, t));
                          }
                        },
                      })
                    }
                    data-fail-payout
                  >
                    {t('رفض', 'Fail')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor && rows && (
        <Button variant="ghost" size="sm" block onClick={more}>{t('المزيد', 'Load more')}</Button>
      )}
      <MarkPaidSheet payout={paying} onClose={() => setPaying(null)} onDone={refresh} t={t} />
      <ReasonSheet request={ask} onClose={() => setAsk(null)} t={t} />
      {confirmDialog}
    </section>
  );
}

function MarkPaidSheet({ payout, onClose, onDone, t }: { payout: QueuePayout | null; onClose: () => void; onDone: () => void; t: T }) {
  const toast = useToast();
  const titleId = useId();
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!payout) return;
    setReference('');
    setError('');
    setBusy(false);
  }, [payout]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!payout || busy) return;
    if (reference.trim().length < 3) {
      setError(t('اكتب مرجع التحويل (3 أحرف على الأقل).', 'Write the transfer reference (at least 3 characters).'));
      return;
    }
    setBusy(true);
    try {
      const r = await payoutQueueApi.paid(payout.id, reference.trim());
      toast.success(r.replayed ? t('هذا التحويل مسجّل مسبقًا.', 'That transfer was already recorded.') : t('سُجّل التحويل.', 'Transfer recorded.'));
      onClose();
      onDone();
    } catch (err) {
      setError(queueRefusal(err, t));
      setBusy(false);
    }
  }
  return (
    <Overlay open={!!payout} onClose={() => !busy && onClose()} labelledBy={titleId} placement="center" panelClassName="w-full max-w-md">
      {() => (
        <form onSubmit={submit} className="p-5 space-y-3" noValidate data-mark-paid-sheet>
          <h2 id={titleId} className="text-white font-bold text-[15px]">
            {t('تسجيل التحويل', 'Record the transfer')} — <Money iqd={payout?.amount_iqd ?? null} />
          </h2>
          <p className="text-zinc-400 text-[12.5px] leading-relaxed">
            {t(
              'سجّل بعد أن ترسل المال فعلًا. ينتقل المبلغ من «محجوز» إلى «مدفوع» في سجل التاجر، ويرى التاجر المرجع.',
              'Record it after you have actually sent the money. The amount moves from Reserved to Paid in the merchant’s ledger, and the merchant sees the reference.'
            )}
          </p>
          <Field label={t('مرجع التحويل', 'Transfer reference')} error={error || undefined} required>
            <Input ltr autoComplete="off" spellCheck={false} maxLength={120} value={reference} onChange={(e) => { setReference(e.target.value); setError(''); }} />
          </Field>
          <div className="flex gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={busy} className="flex-1">{t('إلغاء', 'Cancel')}</Button>
            <Button variant="primary" type="submit" loading={busy} className="flex-1">{t('سجّل التحويل', 'Record transfer')}</Button>
          </div>
        </form>
      )}
    </Overlay>
  );
}
