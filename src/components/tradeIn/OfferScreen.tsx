/**
 * SCREEN 5 — «عرضك» (trade-in design B.2, spec §10.1.5): THE ONLY PLACE A FIGURE FOR THE OLD
 * DEVICE APPEARS, and it is ONE figure — «حتى X», the store-safe offer the server works out for
 * these answers and today's prices (POST /requests/:id/preview, counted: asked once when the
 * screen opens and again only on «حدّث العرض»). Then the new device, what the credit takes off,
 * what is left to pay, how long the offer holds if sent now, the two promises (the final value
 * never exceeds this; the credit is never cash) and how the device reaches the shop. No offer →
 * the sentence, and no send button.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Info, RefreshCw, Store, Truck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import { Button } from '../ui/Button';
import { Money } from '../ui/Money';
import Note from '../ui/Note';
import SafeImage from '../ui/SafeImage';
import Spinner from '../ui/Spinner';
import { useT } from './useT';
import { ErrorLine, useErrText } from './parts';
import { dateText, nameOf, withFee, type PreviewOffer, type RequestView } from './model';

export default function OfferScreen({
  req,
  onReq,
  onSent,
  onBackToCondition,
}: {
  req: RequestView;
  onReq: (r: RequestView) => void;
  onSent: (id: string) => void;
  onBackToCondition: () => void;
}) {
  const { t, tx } = useT();
  const { loc, lang } = useLanguage();
  const errText = useErrText();
  const [offer, setOffer] = useState<PreviewOffer | null>(null);
  const [left, setLeft] = useState<number | null>(req.previews_left ?? null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState('');
  const [noOffer, setNoOffer] = useState(false);
  const [sendError, setSendError] = useState('');
  const [proofError, setProofError] = useState(false);
  const [handoverBusy, setHandoverBusy] = useState(false);
  const asked = useRef(false);

  const ask = useCallback(async () => {
    setAsking(true);
    setAskError('');
    try {
      const d = await api.post<{
        offer?: PreviewOffer;
        previews_left?: number;
      }>(`/api/trade-in/requests/${encodeURIComponent(req.id)}/preview`, {});
      if (d.offer) {
        setOffer(d.offer);
        setNoOffer(d.offer.offer_iqd === null);
      }
      if (typeof d.previews_left === 'number') setLeft(d.previews_left);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TRADE_IN_PREVIEW_LIMIT') setLeft(0);
      if (e instanceof ApiError && e.code === 'TRADE_IN_NO_OFFER') setNoOffer(true);
      setAskError(errText(e));
    } finally {
      setAsking(false);
    }
  }, [req.id, errText]);

  // Asked ONCE when the screen opens (never a live ticker: each answer is counted, G11).
  useEffect(() => {
    if (asked.current || left === 0) return;
    asked.current = true;
    void ask();
  }, [ask, left]);

  const handover = req.handover ?? 'store';
  const setHandover = async (h: 'store' | 'pickup') => {
    if (h === handover) return;
    setHandoverBusy(true);
    try {
      onReq((await api.patch<{ request: RequestView }>(`/api/trade-in/requests/${encodeURIComponent(req.id)}`, { handover: h })).request);
    } catch (e) {
      setSendError(errText(e));
    } finally {
      setHandoverBusy(false);
    }
  };

  const send = async () => {
    setSendError('');
    setProofError(false);
    try {
      await api.post(`/api/trade-in/requests/${encodeURIComponent(req.id)}/submit`);
      onSent(req.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TRADE_IN_NO_OFFER') setNoOffer(true);
      if (e instanceof ApiError && ['TRADE_IN_HOURS_PHOTO', 'TRADE_IN_DAMAGE_PHOTO', 'TRADE_IN_PHOTOS_MISSING', 'TRADE_IN_INPUTS_INVALID'].includes(e.code ?? ''))
        setProofError(true);
      setSendError(errText(e, t('sendError')));
    }
  };

  const target = req.target;
  const x = offer?.offer_iqd ?? null;
  const targetPrice = offer?.target_price_iqd ?? target?.price_iqd ?? null;
  const fee = handover === 'pickup' ? (offer?.pickup_fee_if_collected_iqd ?? 0) : 0;
  const money = x !== null && targetPrice !== null ? withFee(targetPrice, x, fee) : null;
  const limitReached = left === 0 && !offer;

  return (
    <div className="space-y-4" data-trade-in-offer>
      {/* THE FIGURE */}
      <section className="lv-surface p-5 text-center" aria-live="polite" data-offer-figure>
        <h3 className="text-[14px] font-semibold text-text-secondary">{t('offer.title')}</h3>
        {asking && !offer ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <Spinner />
            <span className="text-[12.5px] text-text-muted">{t('offer.computing')}</span>
          </div>
        ) : noOffer ? (
          <div className="space-y-1 py-2" data-no-offer>
            <p className="text-[16px] font-bold text-text-primary">{t('offer.noOffer')}</p>
            <p className="text-[12.5px] leading-5 text-text-secondary">{t('offer.noOfferHint')}</p>
          </div>
        ) : x !== null ? (
          <p className="mt-1 text-[30px] font-black leading-10 text-text-primary" data-offer-iqd={x}>
            {tx('offer.upTo', { x: <Money iqd={x} /> })}
          </p>
        ) : limitReached ? (
          <p className="py-2 text-[13px] leading-6 text-text-secondary">{t('offer.limit')}</p>
        ) : askError ? (
          <ErrorLine>{askError}</ErrorLine>
        ) : null}
        {!noOffer && left !== 0 ? (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <Button variant="ghost" size="sm" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={() => void ask()} loading={asking} data-offer-refresh>
              {t('offer.refresh')}
            </Button>
            {left !== null ? <span className="text-[11.5px] text-text-muted tabular-nums">{t('offer.left', { n: left })}</span> : null}
          </div>
        ) : null}
      </section>

      {/* THE NEW DEVICE AND WHAT IS LEFT TO PAY */}
      {target && !noOffer ? (
        <section className="lv-surface p-4">
          <div className="flex items-center gap-3 border-b border-border-subtle pb-3">
            <SafeImage sizes="48px" src={target.image} alt="" aspect="square" className="h-12 w-12 shrink-0 rounded-md" bgClassName="bg-surface" />
            <p className="min-w-0 flex-1 text-[14px] font-bold leading-5 text-text-primary line-clamp-2">{nameOf(target, loc)}</p>
            <span className="shrink-0 text-[14px] font-bold text-text-primary">
              <Money iqd={targetPrice} />
            </span>
          </div>
          <dl className="divide-y divide-border-subtle text-[13.5px]">
            {fee > 0 && x !== null ? (
              <div className="flex items-baseline justify-between gap-3 py-2">
                <dt className="text-text-secondary">{t('offer.fee')}</dt>
                <dd className="text-text-primary">
                  <Money iqd={-fee} signed />
                </dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3 py-2">
              <dt className="text-text-secondary">{t('offer.credit')}</dt>
              <dd className="text-text-primary">{money ? <Money iqd={-money.credit} signed /> : '—'}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-2">
              <dt className="font-bold text-text-primary">{t('offer.pay')}</dt>
              <dd className="text-[16px] font-black text-text-primary" data-offer-pay>
                {money ? <Money iqd={money.pay} /> : '—'}
              </dd>
            </div>
            <div className="flex justify-end py-1.5 text-[12px] text-text-muted">{t('offer.delivery')}</div>
          </dl>
          {offer ? (
            <p className="mt-1 text-[12.5px] font-semibold text-text-secondary">
              {t('offer.valid', {
                date: dateText(offer.valid_until_if_sent, lang),
              })}
            </p>
          ) : null}
          {money && money.excess > 0 ? (
            <Note tone="amber" compact animate={false} className="mt-3">
              {t('offer.excess')}
            </Note>
          ) : null}
        </section>
      ) : null}

      {!noOffer ? (
        <div className="space-y-2">
          <Note tone="gold" compact animate={false} icon={<Info className="h-4 w-4" />}>
            {t('offer.final')}
          </Note>
          <Note tone="zinc" compact animate={false}>
            {t('credit.note')}
          </Note>
        </div>
      ) : null}

      {/* HOW THE DEVICE REACHES THE SHOP */}
      {!noOffer && req.can.choose_handover !== false ? (
        <section className="lv-surface space-y-2 p-4">
          <h3 id="ti-handover" className="text-[15px] font-bold text-text-primary">
            {t('handover.title')}
          </h3>
          <div role="radiogroup" aria-labelledby="ti-handover" className="space-y-2">
            {(
              [
                ['store', Store, t('handover.store'), t('handover.storeHint')],
                ['pickup', Truck, t('handover.pickup'), t('handover.contact')],
              ] as const
            ).map(([id, Icon, title, hint]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={handover === id}
                disabled={handoverBusy}
                onClick={() => void setHandover(id)}
                data-handover={id}
                className="lv-choice flex w-full items-center gap-3 p-3 text-start"
              >
                <Icon className="h-5 w-5 shrink-0 text-text-secondary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-text-primary">{title}</span>
                  <span className="block text-[12.5px] leading-5 text-text-muted">
                    {id === 'pickup' && offer
                      ? tx('handover.fee', {
                          fee: <Money iqd={offer.pickup_fee_if_collected_iqd} />,
                        })
                      : hint}
                  </span>
                  {id === 'pickup' && offer && handover === 'pickup' ? <span className="block text-[12px] text-text-secondary">{t('handover.contact')}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <ErrorLine>{sendError}</ErrorLine>
      {proofError ? (
        <Button variant="secondary" block onClick={onBackToCondition}>
          {t('offer.backToCondition')}
        </Button>
      ) : null}

      {!noOffer ? (
        <div className="sticky bottom-[calc(var(--nav-stack,0px)+8px)] z-20 lg:static">
          <div className="rounded-2xl border border-border-subtle bg-surface-raised p-2 shadow-dock lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
            <Button variant="primary" block onClick={send} disabled={asking || (!offer && !limitReached)} data-trade-in-send>
              {t('send')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
