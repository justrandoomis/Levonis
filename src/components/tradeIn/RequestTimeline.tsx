/**
 * THE REQUEST PAGE — a vertical timeline of where the trade-in stands (trade-in design B.2, spec
 * §10.1), replacing the old request card:
 *
 *   sent → waiting for your device (the next action, the hand-over choice, the date it must
 *   arrive by) → received & inspected → final value (accept / decline when lower than the offer)
 *   → credit ready until … («أكمل الشراء»: the cart with the new device and the credit code) →
 *   waiting for the new device → complete; or the ending it took — the credit back (any device
 *   sold directly), the offer or the credit expired, the device ready to collect, cancelled.
 *
 * Every state is the server's (`stage`); nothing here decides one. It polls nothing and refreshes
 * when the tab comes back into view.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Circle, CircleDot, Repeat, Store, Truck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, type CartItem } from '../../lib/api';
import { storePromo } from '../PromoCodeField';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { StatusChip } from '../ui/Badge';
import { Money } from '../ui/Money';
import Note from '../ui/Note';
import SafeImage from '../ui/SafeImage';
import Spinner from '../ui/Spinner';
import { useT } from './useT';
import { ErrorLine, useErrText } from './parts';
import TargetSearchSheet from './TargetSearchSheet';
import { dateText, labelOf, nameOf, stageTone, triText, type CheckoutAnswer, type RequestView, type TradeInStage } from './model';
import type { CopyKey } from './copy';

type NodeState = 'done' | 'now' | 'later';
interface TLNode {
  key: string;
  title: React.ReactNode;
  date?: string | null;
  state: NodeState;
  body?: React.ReactNode;
}

const SCOPE_KEY: Record<string, CopyKey> = {
  whole: 'scope.wholeDevice',
  printer_only: 'scope.printer',
  ams_only: 'scope.ams',
};
const ENDINGS: Partial<Record<TradeInStage, CopyKey>> = {
  offer_expired: 'st.expired',
  credit_expired: 'st.creditExpired',
  device_to_collect: 'st.collect',
  cancelled: 'st.cancelled',
  rejected: 'st.rejected',
};

export default function RequestTimeline({ id, onResume, onBack }: { id: string; onResume: (r: RequestView) => void; onBack: () => void }) {
  const { t, tx } = useT();
  const { loc, lang } = useLanguage();
  const errText = useErrText();
  const navigate = useNavigate();
  const [req, setReq] = useState<RequestView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [confirm, setConfirm] = useState<null | 'reject' | 'cancel'>(null);
  const [cartConflict, setCartConflict] = useState<null | {
    product_id: string;
    option_value_ids: string[];
    color_id: string | null;
  }>(null);
  const [anySheet, setAnySheet] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ request: RequestView }>(`/api/trade-in/requests/${encodeURIComponent(id)}`);
      setReq(d.request);
      setLoadError('');
    } catch (e) {
      setLoadError(errText(e, t('loadRequestError')));
    }
  }, [id, errText, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // No polling: the page reads again when the customer comes back to it.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [load]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setActionError('');
    try {
      await fn();
    } catch (e) {
      setActionError(errText(e));
      if (e instanceof ApiError && e.code === 'TRADE_IN_OFFER_STALE') void load();
    } finally {
      setBusy('');
    }
  };

  const decide = (d: 'accept' | 'reject') =>
    act(d, async () => {
      if (!req?.value_proposal) return;
      const r = await api.post<{ request: RequestView }>(`/api/trade-in/requests/${req.id}/${d}`, { offer_no: req.value_proposal.offer_no });
      setReq(r.request);
      setConfirm(null);
    });

  const cancel = () =>
    act('cancel', async () => {
      if (!req) return;
      const r = await api.post<{ request: RequestView }>(`/api/trade-in/requests/${req.id}/cancel`, {});
      setReq(r.request);
      setConfirm(null);
    });

  const handover = (h: 'store' | 'pickup') =>
    act('handover', async () => {
      if (!req) return;
      setReq((await api.patch<{ request: RequestView }>(`/api/trade-in/requests/${req.id}`, { handover: h })).request);
    });

  /** «أكمل الشراء»: the credit's code, the new device in the ordinary cart, the ordinary checkout. */
  const pay = (
    chosen?: {
      product_id: string;
      option_value_ids: string[];
      color_id: string | null;
    },
    replaceCart = false
  ) =>
    act('pay', async () => {
      if (!req) return;
      setCartConflict(null);
      const d = await api.post<CheckoutAnswer>(`/api/trade-in/requests/${req.id}/checkout`);
      if (d.order_id) {
        navigate(`/orders/${encodeURIComponent(d.order_id)}`);
        return;
      }
      if (!d.coupon_code) {
        await load();
        return;
      }
      const target = d.any_device ? (chosen ?? null) : d.target;
      if (!target) {
        // A credit given back buys any device sold directly: the customer chooses it first.
        setAnySheet(true);
        return;
      }
      const body: Record<string, unknown> = {
        productId: target.product_id,
        qty: 1,
        fulfillmentType: 'direct_sale',
      };
      if (target.option_value_ids.length) body.optionValueIds = target.option_value_ids;
      if (target.color_id) body.colorId = target.color_id;
      if (replaceCart) body.replaceCart = true;
      let items: CartItem[] = [];
      try {
        items = (await api.post<{ items: CartItem[] }>('/api/cart/items', body)).items ?? [];
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'CART_SHIPPING_CONFLICT' || e.code === 'CART_SELLER_CONFLICT')) {
          setCartConflict(target);
          return;
        }
        throw e;
      }
      const line = items.find(
        (it) =>
          it.productId === target.product_id &&
          (target.option_value_ids.length === 0 || target.option_value_ids.every((v) => (it.option_value_ids ?? [it.option_id]).includes(v))) &&
          (!target.color_id || it.color_id === target.color_id)
      );
      // The code rides to the checkout the way a typed promo does; the checkout re-validates it.
      storePromo(d.coupon_code);
      navigate('/checkout', {
        state: line ? { itemIds: [line.id] } : undefined,
      });
    });

  if (loadError) {
    return (
      <div className="lv-surface space-y-3 p-4">
        <ErrorLine>{loadError}</ErrorLine>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={load}>
            {t('retry')}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            {t('tab.requests')}
          </Button>
        </div>
      </div>
    );
  }
  if (!req) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const stage = req.stage;
  const received = !!req.intake;
  const fixed = req.final_value_iqd !== null;
  const ordered = !!req.credit_order || req.status === 'completed';
  const completed = req.status === 'completed';
  const offerIqd = req.offer?.offer_iqd ?? req.estimated_iqd;
  const handIn = req.offer?.valid_until ?? null;
  const ending = ENDINGS[stage];

  const buyButton = (label: CopyKey) => (
    <Button variant="accent" block onClick={() => (stage === 'credit_reissued' ? setAnySheet(true) : pay())} loading={busy === 'pay'} disabled={!req.can.pay} data-pay>
      {t(label)}
    </Button>
  );

  const nodes: TLNode[] = [
    {
      key: 'sent',
      title: t('st.sent'),
      date: req.submitted_at,
      state: 'done',
      body: offerIqd !== null && offerIqd !== undefined ? <p className="text-[13px] text-text-secondary">{tx('tl.offer', { x: <Money iqd={offerIqd} /> })}</p> : null,
    },
    {
      key: 'await',
      title: t('st.awaitDevice'),
      state: received ? 'done' : stage === 'awaiting_device' ? 'now' : 'later',
      body:
        stage === 'awaiting_device' ? (
          <div className="space-y-2">
            {handIn ? <p className="text-[13.5px] font-semibold text-text-primary">{t('tl.handIn', { date: dateText(handIn, lang) })}</p> : null}
            <p className="text-[12.5px] text-text-secondary">{t('tl.handover')}</p>
            {req.can.choose_handover ? (
              <div role="radiogroup" aria-label={t('handover.title')} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(
                  [
                    ['store', Store, 'handover.store'],
                    ['pickup', Truck, 'handover.pickup'],
                  ] as const
                ).map(([h, Icon, key]) => (
                  <button
                    key={h}
                    type="button"
                    role="radio"
                    aria-checked={(req.handover ?? 'store') === h}
                    disabled={busy === 'handover'}
                    onClick={() => void handover(h)}
                    className="lv-choice flex items-center gap-2 px-3 py-2.5 text-start text-[13px] font-semibold"
                    data-handover={h}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    {t(key)}
                  </button>
                ))}
              </div>
            ) : null}
            {req.handover === 'pickup' ? (
              <p className="text-[12px] text-text-muted">
                {tx('handover.fee', {
                  fee: <Money iqd={req.pickup_fee_iqd} />,
                })}{' '}
                · {t('handover.contact')}
              </p>
            ) : null}
          </div>
        ) : null,
    },
    {
      key: 'received',
      title: t('st.received'),
      date: req.intake?.received_at ?? null,
      state: received ? (stage === 'inspecting' ? 'now' : 'done') : 'later',
      body: req.intake?.serial_matched ? <p className="text-[12.5px] text-success">{t('tl.serialOk')}</p> : null,
    },
    {
      key: 'final',
      title: stage === 'decision' ? t('tl.newValue') : t('st.final'),
      date: req.decided_at,
      state: stage === 'decision' ? 'now' : fixed ? 'done' : 'later',
      body:
        stage === 'decision' && req.value_proposal ? (
          <div className="space-y-3" data-decision>
            <p className="text-[12.5px] leading-5 text-text-secondary">{t('tl.newValueHint')}</p>
            <p className="text-[24px] font-black text-text-primary">
              <Money iqd={req.value_proposal.value_iqd} />
            </p>
            {req.value_proposal.reason ? (
              <p className="lv-well rounded-md p-3 text-[13px] leading-6 text-text-secondary">{t('tl.reason', { x: req.value_proposal.reason })}</p>
            ) : null}
            {req.can.decide ? (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => setConfirm('reject')} data-reject>
                  {t('reject')}
                </Button>
                <Button variant="accent" onClick={() => decide('accept')} loading={busy === 'accept'} data-accept>
                  {t('accept')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : fixed ? (
          <p className="text-[15px] font-black text-text-primary">
            <Money iqd={req.final_value_iqd} />
          </p>
        ) : null,
    },
    {
      key: 'credit',
      title: req.credit_expires_at && stage === 'credit_ready' ? t('st.creditReady', { date: dateText(req.credit_expires_at, lang) }) : t('st.creditReadyShort'),
      state: stage === 'credit_ready' ? 'now' : ordered ? 'done' : 'later',
      body:
        stage === 'credit_ready' ? (
          <div className="space-y-3">
            <dl className="divide-y divide-border-subtle text-[13.5px]">
              {req.target ? (
                <div className="flex items-baseline justify-between gap-3 py-1.5">
                  <dt className="min-w-0 truncate text-text-secondary">{nameOf(req.target, loc)}</dt>
                  <dd className="text-text-primary">
                    <Money iqd={req.target.price_iqd} />
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-3 py-1.5">
                <dt className="text-text-secondary">{t('offer.credit')}</dt>
                <dd className="text-text-primary">
                  <Money iqd={req.credit_iqd !== null ? -req.credit_iqd : null} signed />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-1.5">
                <dt className="font-bold text-text-primary">{t('offer.pay')}</dt>
                <dd className="font-black text-text-primary">
                  <Money iqd={req.difference_iqd} />
                </dd>
              </div>
            </dl>
            {req.excess_iqd && req.excess_iqd > 0 ? (
              <Note tone="amber" compact animate={false}>
                {t('offer.excess')}
              </Note>
            ) : null}
            {buyButton('act.buy')}
          </div>
        ) : null,
    },
    {
      key: 'new',
      title: t('st.awaitNew'),
      state: stage === 'awaiting_new_device' ? 'now' : completed ? 'done' : 'later',
      body: req.credit_order ? (
        <Link to={`/orders/${encodeURIComponent(req.credit_order.id)}`} className="lv-button lv-button-secondary lv-button-sm" data-credit-order>
          {t('tl.yourOrder')}{' '}
          <bdi dir="ltr" className="font-mono">
            {req.credit_order.id}
          </bdi>
        </Link>
      ) : null,
    },
    {
      key: 'done',
      title: t('st.completed'),
      date: req.completed_at,
      state: completed ? (stage === 'completed' ? 'now' : 'done') : 'later',
      body: stage === 'completed' ? <p className="text-[12.5px] text-text-secondary">{t('thanks')}</p> : null,
    },
  ];

  let shown = nodes;
  if (stage === 'credit_reissued' && req.reissue) {
    shown = [
      ...nodes,
      {
        key: 'reissued',
        title: t('st.reissued', { date: dateText(req.reissue.ends_at, lang) }),
        state: 'now',
        body: (
          <div className="space-y-3">
            <p className="text-[12.5px] leading-5 text-text-secondary">{t('st.reissuedAny')}</p>
            {buyButton('act.chooseDevice')}
          </div>
        ),
      },
    ];
  } else if (ending) {
    shown = [
      ...nodes.filter((n) => n.state === 'done'),
      {
        key: 'end',
        title: t(ending),
        date: req.cancelled_at,
        state: 'now',
        body:
          stage === 'offer_expired' ? (
            <p className="text-[12.5px] text-text-secondary">{t('st.expiredHint')}</p>
          ) : stage === 'cancelled' && req.cancel_reason ? (
            <p className="text-[12.5px] text-text-secondary">{t('cancel.reason', { x: req.cancel_reason })}</p>
          ) : null,
      },
    ];
  }

  const icon = (s: NodeState) =>
    s === 'done' ? (
      <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
    ) : s === 'now' ? (
      <CircleDot className="h-5 w-5 text-gold" aria-hidden />
    ) : (
      <Circle className="h-5 w-5 text-text-muted" aria-hidden />
    );
  const stateWord = (s: NodeState) => t(s === 'done' ? 'tl.done' : s === 'now' ? 'tl.now' : 'tl.next');

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-trade-in-request={req.id} data-stage={stage}>
      <section className="lv-surface p-4">
        <div className="flex items-center gap-3">
          <SafeImage sizes="56px" src={req.source.image ?? ''} alt="" aspect="square" className="h-14 w-14 shrink-0 rounded-md" bgClassName="bg-surface" />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-bold leading-5 text-text-primary line-clamp-2">{req.source.name}</p>
            <p className="text-[12px] text-text-muted">{t(SCOPE_KEY[req.scope] ?? 'scope.wholeDevice')}</p>
          </div>
        </div>
        <StatusChip tone={stageTone(stage)} className="mt-3">
          {triText(req.stage_label, loc)}
        </StatusChip>
        {req.target ? (
          <p className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-3 text-[13px] text-text-secondary">
            <Repeat className="h-4 w-4 shrink-0 text-gold" aria-hidden />
            <span className="min-w-0 truncate">
              <strong className="text-text-primary">{nameOf(req.target, loc)}</strong>
              {req.target.options?.length ? <span className="text-text-muted"> · {req.target.options.map((o) => labelOf(o, loc)).join(' · ')}</span> : null}
            </span>
          </p>
        ) : null}
      </section>

      {stage === 'draft' ? (
        <section className="lv-surface space-y-3 p-4">
          <h2 className="text-[15px] font-bold text-text-primary">{t('draft.title')}</h2>
          <Button variant="primary" block onClick={() => onResume(req)} data-resume>
            {t('draft.continue')}
          </Button>
        </section>
      ) : (
        <section className="lv-surface p-4" aria-labelledby="ti-timeline">
          <h2 id="ti-timeline" className="mb-3 text-[15px] font-bold text-text-primary">
            {t('tl.title')}
          </h2>
          <ol className="space-y-0">
            {shown.map((n, i) => (
              <li key={n.key} className="relative flex gap-3 pb-4 last:pb-0" data-node={n.key} data-node-state={n.state} aria-current={n.state === 'now' ? 'step' : undefined}>
                {i < shown.length - 1 ? <span className="absolute start-[9.5px] top-6 bottom-0 w-px bg-border-subtle" aria-hidden /> : null}
                <span className="relative z-[1] mt-0.5 shrink-0 bg-surface">{icon(n.state)}</span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className={`text-[14px] leading-5 ${n.state === 'later' ? 'text-text-muted' : 'font-bold text-text-primary'}`}>
                    <span className="sr-only">{stateWord(n.state)}: </span>
                    {n.title}
                  </p>
                  {n.date && n.state !== 'later' ? <p className="text-[11.5px] text-text-muted tabular-nums">{dateText(n.date, lang)}</p> : null}
                  {n.body}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <ErrorLine>{actionError}</ErrorLine>
      {cartConflict ? (
        <Note tone="amber" animate={false}>
          <p>{t('cartConflict')}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => pay(cartConflict, true)}>
            {t('emptyCart')}
          </Button>
        </Note>
      ) : null}

      {req.can.cancel && stage !== 'decision' ? (
        <Button variant="ghost" block onClick={() => setConfirm('cancel')} data-cancel>
          {t('cancel.btn')}
        </Button>
      ) : null}

      <TargetSearchSheet
        open={anySheet}
        onClose={() => setAnySheet(false)}
        confirmLabel={t('act.buy')}
        onPicked={async (q) => {
          setAnySheet(false);
          await pay({
            product_id: q.product_id,
            option_value_ids: q.option_value_ids,
            color_id: q.color_id,
          });
        }}
      />
      <ConfirmDialog
        open={confirm === 'reject'}
        title={t('reject.title')}
        consequence={t('reject.body')}
        confirmLabel={t('reject')}
        destructive
        onConfirm={() => decide('reject')}
        onCancel={() => setConfirm(null)}
        error={actionError || undefined}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        title={t('cancel.title')}
        consequence={received ? t('cancel.bodyInShop') : t('cancel.body')}
        confirmLabel={t('cancel.btn')}
        destructive
        onConfirm={cancel}
        onCancel={() => setConfirm(null)}
        error={actionError || undefined}
      />
    </div>
  );
}
