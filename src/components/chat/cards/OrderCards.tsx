/**
 * THE ORDER, IN THE CONVERSATION — a store order and a custom order, as their
 * system cards record each move (docs/COMMUNITY_COMMERCE_CHAT.md §4.3, D8).
 *
 * The next step each side takes is offered here — the store starts and
 * delivers custom work, the customer confirms receipt — and each one is the
 * order's own existing door. A dispute is opened on the order's page, where
 * its reason is written; the card links there.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Receipt, Hammer } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMoney } from '../../../CurrencyContext';
import { ApiError } from '../../../lib/api';
import { toast } from '../../../lib/toastStore';
import { chatCommerceApi } from '../../../lib/chatCommerceApi';
import { merchantHref } from '../../../lib/merchantRoutes';
import type { ChatCard } from '../../../lib/chatCards';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useCardActions } from './cardContext';
import { daysText, statusText } from './cardWords';
import { CardActions, CardButton, CardKicker, CardShell, StatusLine, toneOf } from './parts';

interface Props {
  card: ChatCard;
  mine: boolean;
}

function useRun() {
  const { lang, loc } = useLanguage();
  const actions = useCardActions();
  const [busy, setBusy] = useState<string | null>(null);
  async function run(name: string, work: () => Promise<unknown>, done: string) {
    setBusy(name);
    try {
      await work();
      toast.success(done);
      await actions?.refresh();
    } catch (e) {
      const fallback = loc('تعذّر إتمام العملية', 'That could not be done');
      const { apiRefusal } = await import('../../../lib/refusalStrings');
      toast.error(e instanceof ApiError ? apiRefusal(e, lang, fallback) : fallback);
      if (e instanceof ApiError && e.status === 409) await actions?.refresh();
    } finally {
      setBusy(null);
    }
  }
  return { busy, run };
}

export function StoreOrderCardView({ card, mine }: Props) {
  const { loc } = useLanguage();
  const { moneyBoth } = useMoney();
  const navigate = useNavigate();
  const actions = useCardActions();
  const { busy, run } = useRun();
  const [confirm, dialog] = useConfirm();
  const s = card.original;
  const cur = card.current;
  const side = actions?.role === 'merchant' ? 'merchant' : actions?.role === 'customer' ? 'customer' : 'other';
  const lines = (Array.isArray(s.lines) ? s.lines : []) as Array<{ name: string; qty: number }>;
  const items = Number(s.items ?? 0);
  const orderId = String(s.order_id ?? card.ref);
  const can = new Set(cur.actions ?? []);

  const received = async () => {
    const yes = await confirm({
      title: loc('وصلك الطلب؟', 'Did your order arrive?'),
      consequence: loc(
        'تأكيد الاستلام يُفرج عن مستحق المتجر. لا تؤكّد قبل أن يصلك الطلب كاملًا.',
        'Confirming releases the store’s share. Do not confirm before the whole order has arrived.'
      ),
      confirmLabel: loc('نعم، استلمته', 'Yes, I received it'),
    });
    if (yes) await run('confirm_receipt', () => chatCommerceApi.confirmReceipt(orderId), loc('شكرًا — سُجّل استلامك', 'Thanks — your receipt is recorded'));
  };

  return (
    <CardShell mine={mine} kind="order" label={loc(`طلب ${orderId}`, `Order ${orderId}`)}>
      <div className="p-3 flex gap-3">
        {typeof s.image === 'string' && s.image && (
          <img referrerPolicy="no-referrer" src={s.image} alt="" loading="lazy" className="w-14 h-14 rounded-lg object-cover bg-surface-raised shrink-0" />
        )}
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <CardKicker icon={Receipt}>{loc('طلب من المتجر', 'Store order')}</CardKicker>
          <p dir="ltr" className="text-[13px] font-bold tabular-nums text-start">{orderId}</p>
          {lines.length > 0 && (
            <ul className="text-[12.5px] text-text-secondary">
              {lines.map((l, i) => (
                <li key={i} dir="auto" className="truncate">{l.qty > 1 ? `${l.qty}× ` : ''}{l.name}</li>
              ))}
              {items > lines.reduce((n, l) => n + (Number(l.qty) || 0), 0) && <li>{loc('وغيرها…', 'and more…')}</li>}
            </ul>
          )}
          <p className="text-[15px] font-extrabold tabular-nums">{moneyBoth(Number(s.total_iqd ?? 0))}</p>
          <StatusLine tone={toneOf(cur.status)}>{statusText('order', cur.status, loc, side)}</StatusLine>
        </div>
      </div>
      {can.size > 0 && (
        <div className="px-3 pb-3">
          <CardActions>
            {can.has('confirm_receipt') && (
              <CardButton action="confirm_receipt" variant="primary" busy={busy === 'confirm_receipt'} onClick={() => void received()}>
                {loc('استلمت طلبي', 'I received it')}
              </CardButton>
            )}
            {can.has('view') && (
              <CardButton action="view" onClick={() => navigate(side === 'merchant' ? merchantHref.order(orderId) : `/orders/${encodeURIComponent(orderId)}`)}>
                {loc('تفاصيل الطلب', 'Order details')}
              </CardButton>
            )}
          </CardActions>
        </div>
      )}
      {dialog}
    </CardShell>
  );
}

export function CustomOrderCardView({ card, mine }: Props) {
  const { loc } = useLanguage();
  const { moneyBoth } = useMoney();
  const navigate = useNavigate();
  const actions = useCardActions();
  const { busy, run } = useRun();
  const [confirm, dialog] = useConfirm();
  const s = card.original;
  const cur = card.current;
  const side = actions?.role === 'merchant' ? 'merchant' : actions?.role === 'customer' ? 'customer' : 'other';
  const orderId = String(s.order_id ?? card.ref);
  const requestId = String(cur.request_id ?? s.request_id ?? '');
  const can = new Set(cur.actions ?? []);

  const deliver = async () => {
    const yes = await confirm({
      title: loc('سلّمت الطلب للزبون؟', 'Did you hand the order over?'),
      consequence: loc('سيُطلب من الزبون تأكيد الاستلام، والمبلغ يبقى في الضمان حتى يؤكّد.', 'The customer is asked to confirm; the money stays held until they do.'),
      confirmLabel: loc('نعم، سلّمته', 'Yes, delivered'),
    });
    if (yes) await run('deliver', () => chatCommerceApi.markDelivered(orderId), loc('سُجّل التسليم', 'Delivery recorded'));
  };
  const confirmIt = async () => {
    const yes = await confirm({
      title: loc('وصلك العمل كما اتفقتما؟', 'Did you get what you agreed?'),
      consequence: loc(
        'تأكيد الاستلام يُفرج عن المبلغ للمتجر ولا يمكن التراجع عنه. إن كانت هناك مشكلة، افتح نزاعًا من صفحة الطلب بدلًا من ذلك.',
        'Confirming releases the money to the store and cannot be undone. If something is wrong, open a dispute from the order page instead.'
      ),
      confirmLabel: loc('نعم، أؤكّد الاستلام', 'Yes, confirm'),
    });
    if (yes) await run('confirm', () => chatCommerceApi.confirmCustomOrder(orderId), loc('شكرًا — اكتمل الطلب', 'Thanks — the order is complete'));
  };

  return (
    <CardShell mine={mine} kind="custom_order" label={loc(`طلب مخصص: ${String(s.title ?? '')}`, `Custom order: ${String(s.title ?? '')}`)}>
      <div className="p-3 flex flex-col gap-1.5">
        <CardKicker icon={Hammer}>{loc('عمل مخصص — في الضمان', 'Custom work — held in escrow')}</CardKicker>
        <h3 dir="auto" className="text-[14px] font-bold leading-snug">{String(s.title ?? '')}</h3>
        <p className="text-[15px] font-extrabold tabular-nums">{moneyBoth(Number(s.price_iqd ?? 0))}</p>
        {Number(s.completion_days ?? 0) > 0 && (
          <p className="text-[12.5px] text-text-secondary">{loc('مدة التنفيذ: ', 'Ready in: ')}{daysText(Number(s.completion_days), loc)}</p>
        )}
        <StatusLine tone={toneOf(cur.status)}>{statusText('custom_order', cur.status, loc, side)}</StatusLine>
        {can.size > 0 && (
          <CardActions>
            {can.has('start') && (
              <CardButton action="start" variant="primary" busy={busy === 'start'} onClick={() => void run('start', () => chatCommerceApi.startWork(orderId), loc('بدأ العمل — أُبلغ الزبون', 'Work started — the customer is told'))}>
                {loc('ابدأ العمل', 'Start the work')}
              </CardButton>
            )}
            {can.has('deliver') && <CardButton action="deliver" variant="primary" busy={busy === 'deliver'} onClick={() => void deliver()}>{loc('تم التسليم', 'Mark delivered')}</CardButton>}
            {can.has('confirm') && <CardButton action="confirm" variant="primary" busy={busy === 'confirm'} onClick={() => void confirmIt()}>{loc('أكّد الاستلام', 'Confirm receipt')}</CardButton>}
            {can.has('view') && (
              <CardButton action="view" onClick={() => navigate(side === 'merchant' ? merchantHref.customOrder(orderId) : `/requests/${encodeURIComponent(requestId)}`)}>
                {loc('صفحة الطلب', 'Order page')}
              </CardButton>
            )}
          </CardActions>
        )}
      </div>
      {dialog}
    </CardShell>
  );
}
