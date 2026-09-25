/**
 * THE CUSTOMER'S OFFERS, SIDE BY SIDE (offers v2, stream W5-A).
 *
 * Every offer answers the same seven questions in the same rows — price,
 * time, handover, materials, what is included, warranty, how long it stands —
 * so the eye can run across them. On a phone the columns scroll sideways with
 * a snap; from `sm` up they sit in a grid. An edited offer says so, with the
 * price it replaced. A superseded or expired one says why it cannot be taken.
 *
 * ACCEPTING MOVES MONEY, AND ONLY FOR THE VERSION ON SCREEN. The sheet names
 * the exact price and version, says the money is HELD, says who receives the
 * customer's phone and address (the chosen merchant, and only now), lets the
 * customer pick the address for a delivered job, and sends back exactly the
 * version it showed. `OFFER_CHANGED` swaps in the fresh terms and asks again.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, MessageCircle, Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api, ApiError, type ApiAddress } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { Segmented } from '../../ui/Segmented';
import { StatusChip } from '../../ui/Badge';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import type { CatalogMaterial } from '../requests/api';
import OrderContactCard from './OrderContactCard';
import { CommunityStoreLink } from '../../../pages/community/access';
import { deliveryLabel, offerStateLabel, offersApi, validUntil, type Loc, type OfferV2 } from './types';

type Sort = 'price' | 'time' | 'rating';

export default function OfferCompare({
  requestId,
  offers,
  takingOffers,
  materials,
  onChanged,
}: {
  requestId: string;
  offers: OfferV2[];
  /** The request still takes offers — acceptance and decline are possible. */
  takingOffers: boolean;
  materials: CatalogMaterial[];
  onChanged: () => void;
}) {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const [sort, setSort] = useState<Sort>('price');
  const [accepting, setAccepting] = useState<OfferV2 | null>(null);
  const L = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';

  const matName = (id: string) => {
    const m = materials.find((x) => x.id === id);
    return m ? (lang === 'en' ? m.name_en : m.name_ar || m.name_en) : id;
  };

  const sorted = useMemo(() => {
    const live = (o: OfferV2) => (o.state === 'accepted' ? 0 : o.state === 'pending' && !o.stale && !o.expired ? 1 : 2);
    const key = (o: OfferV2) =>
      sort === 'price' ? o.price_iqd : sort === 'time' ? o.completion_days || 9999 : -(o.merchant?.rating ?? 0);
    return [...offers].sort((a, b) => live(a) - live(b) || key(a) - key(b));
  }, [offers, sort]);

  async function decline(o: OfferV2) {
    const ok = await confirm({
      title: loc('الاعتذار عن هذا العرض؟', 'Decline this offer?'),
      consequence: loc(`سيُبلَّغ ${o.merchant?.name ?? 'التاجر'} أنك لم تختر عرضه.`, `${o.merchant?.name ?? 'The merchant'} will be told you did not choose it.`),
      confirmLabel: loc('اعتذر', 'Decline'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await offersApi.decline(o.id);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? apiRefusal(e, L, e.message) : loc('تعذّر', 'Could not decline'));
    }
  }

  async function chat(o: OfferV2) {
    try {
      const r = await offersApi.openThread(requestId, o.merchant_id);
      navigate(`/chat/${encodeURIComponent(r.chatId)}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? apiRefusal(e, L, e.message) : loc('تعذّر فتح المحادثة', 'Could not open the conversation'));
    }
  }

  if (!offers.length) {
    return (
      <p className="py-8 text-center text-[13px] text-text-muted" data-offers="empty">
        {loc('لا عروض بعد. نُعلمك حين يصل أول عرض.', 'No offers yet. We will tell you when the first one arrives.')}
      </p>
    );
  }

  return (
    <div data-offer-compare>
      {offers.length > 1 && (
        <div className="mb-3 max-w-sm">
          <Segmented
            group="offer-sort"
            size="sm"
            label={loc('ترتيب العروض', 'Sort offers')}
            value={sort}
            onChange={(id) => setSort(id as Sort)}
            items={[
              { id: 'price', label: loc('الأقل سعرًا', 'Lowest price') },
              { id: 'time', label: loc('الأسرع', 'Fastest') },
              { id: 'rating', label: loc('الأعلى تقييمًا', 'Top rated') },
            ]}
          />
        </div>
      )}
      {/* Phone: columns that scroll sideways and snap; wider: a grid. */}
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">
        {sorted.map((o) => (
          <OfferColumn
            key={o.id}
            o={o}
            loc={loc}
            lang={lang}
            matName={matName}
            canAct={takingOffers && o.state === 'pending' && !o.stale && !o.expired}
            onAccept={() => setAccepting(o)}
            onDecline={() => decline(o)}
            onChat={() => chat(o)}
          />
        ))}
      </div>
      <AcceptSheet offer={accepting} onClose={() => setAccepting(null)} onAccepted={() => { setAccepting(null); onChanged(); }} />
      {confirmDialog}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="shrink-0 text-[12px] text-text-muted">{k}</dt>
      <dd className="min-w-0 text-end text-[12.5px] text-text-primary break-words" dir="auto">{children}</dd>
    </div>
  );
}

function OfferColumn({
  o,
  loc,
  lang,
  matName,
  canAct,
  onAccept,
  onDecline,
  onChat,
}: {
  o: OfferV2;
  loc: Loc;
  lang: string;
  matName: (id: string) => string;
  canAct: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onChat: () => void;
}) {
  const m = o.merchant;
  const st = offerStateLabel(o, loc);
  const prev = (o.history ?? []).length > 1 ? o.history![o.history!.length - 2] : null;
  const until = validUntil(o.expires_at, lang);
  return (
    <article
      className={`lv-surface flex w-[85%] shrink-0 snap-start flex-col p-4 sm:w-auto ${o.state === 'accepted' ? 'ring-1 ring-success/40' : ''}`}
      data-offer={o.id}
      data-offer-state={o.state}
      data-offer-stale={o.stale ? 'true' : undefined}
      aria-label={m?.name ?? ''}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-[14px] font-semibold text-text-primary">
            <bdi className="truncate">{m?.name ?? '—'}</bdi>
            {m?.verified && <BadgeCheck aria-label={loc('موثّق', 'Verified')} className="h-4 w-4 shrink-0 text-gold" />}
          </p>
          <p className="mt-0.5 flex items-center gap-2 text-[11.5px] text-text-muted">
            {m?.rating != null && (
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <Star aria-hidden="true" className="h-3 w-3 fill-gold text-gold" />
                {m.rating.toFixed(1)} ({m.rating_count})
              </span>
            )}
            {!!m?.completed_orders && <span>{loc(`${m.completed_orders} عمل منجز`, `${m.completed_orders} jobs done`)}</span>}
          </p>
        </div>
        <StatusChip tone={st.tone}>{st.text}</StatusChip>
      </header>

      <p className="mt-3 text-[20px] font-bold text-text-primary" data-offer-price>
        <Money iqd={o.price_iqd} />
      </p>
      {/* Always one line tall, so the rows below line up across columns. */}
      <p className="min-h-[18px] text-[11.5px] text-text-muted" data-offer-edited={prev && prev.price_iqd !== o.price_iqd ? '' : undefined}>
        {prev && prev.price_iqd !== o.price_iqd && (
          <>
            {loc('عُدِّل — كان', 'Edited — was')} <Money iqd={prev.price_iqd} className="line-through" />
          </>
        )}
      </p>

      <dl className="mt-2 divide-y divide-white/[0.06]">
        <Row k={loc('التنفيذ', 'Completion')}>{o.completion_days ? loc(`${o.completion_days} يوم`, `${o.completion_days} days`) : '—'}</Row>
        <Row k={loc('التسليم', 'Handover')}>{deliveryLabel(o.delivery_method, loc)}</Row>
        <Row k={loc('المواد', 'Materials')}>{o.material_ids?.length ? o.material_ids.map(matName).join('، ') : o.materials || '—'}</Row>
        <Row k={loc('يشمل', 'Included')}>{o.included || '—'}</Row>
        <Row k={loc('الضمان', 'Warranty')}>{o.warranty_terms || '—'}</Row>
        <Row k={loc('صالح حتى', 'Valid until')}>{until ?? loc('مفتوح', 'Open-ended')}</Row>
      </dl>
      {o.message && <p className="mt-2 rounded-xl bg-white/[0.03] px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary" dir="auto">{o.message}</p>}

      {o.stale && o.state !== 'accepted' && (
        <p className="mt-2 flex items-start gap-2 text-[12px] leading-relaxed text-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {loc('عدّلتَ الطلب بعد هذا العرض، فهو بانتظار أن يؤكده التاجر من جديد.', 'You changed the request after this offer, so it waits for the merchant to re-confirm it.')}
        </p>
      )}

      <div className="mt-auto pt-3">
        {o.state === 'accepted' && o.order_id ? (
          <OrderContactCard orderId={o.order_id} compact />
        ) : (
          <div className="flex flex-wrap gap-2">
            {canAct && (
              <Button variant="primary" block onClick={onAccept} className="whitespace-nowrap" data-offer-accept={o.id}>
                {loc('اقبل العرض', 'Accept offer')}
              </Button>
            )}
            {(o.state === 'pending' || o.state === 'superseded') && (
              <Button variant="secondary" size="sm" onClick={onChat} icon={<MessageCircle aria-hidden="true" className="h-4 w-4" />}>
                {loc('اسأل التاجر', 'Ask')}
              </Button>
            )}
            {m?.store_slug && (
              <CommunityStoreLink
                id={m.store_slug}
                className="lv-button lv-button-ghost lv-button-sm"
              >
                {loc('زيارة المتجر', 'View store', 'بینینی فرۆشگا')}
              </CommunityStoreLink>
            )}
            {canAct && (
              <Button variant="ghost" size="sm" onClick={onDecline} data-offer-decline={o.id}>
                {loc('اعتذر', 'Decline')}
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function AcceptSheet({ offer, onClose, onAccepted }: { offer: OfferV2 | null; onClose: () => void; onAccepted: () => void }) {
  const { loc, lang } = useLanguage();
  const titleId = useId();
  const [shown, setShown] = useState<OfferV2 | null>(offer);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState('');
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [addresses, setAddresses] = useState<ApiAddress[] | null>(null);
  const [addressId, setAddressId] = useState('');
  const L = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';

  useEffect(() => {
    if (!offer) return;
    setShown(offer);
    setChanged(false);
    setError('');
    setNeedsTopUp(false);
    if (offer.delivery_method !== 'pickup') {
      api
        .get<{ addresses: ApiAddress[] }>('/api/addresses')
        .then((d) => {
          setAddresses(d.addresses);
          const def = d.addresses.find((a) => a.is_default) ?? d.addresses[0];
          setAddressId(def?.id ?? '');
        })
        .catch(() => setAddresses([]));
    }
  }, [offer]);

  const o = shown;
  async function accept() {
    if (!o) return;
    setError('');
    setNeedsTopUp(false);
    try {
      await offersApi.accept(o.id, {
        expected_price_iqd: o.price_iqd,
        offer_revision: o.revision,
        ...(addressId && o.delivery_method !== 'pickup' ? { address_id: addressId } : {}),
      });
      onAccepted();
    } catch (e) {
      const fresh = e instanceof ApiError && e.code === 'OFFER_CHANGED' ? (e.details?.offer as OfferV2 | undefined) : undefined;
      if (fresh) {
        setShown({ ...o, ...fresh, merchant: o.merchant });
        setChanged(true);
      } else {
        setError(e instanceof ApiError ? apiRefusal(e, L, e.message) : loc('تعذّر قبول العرض', 'Could not accept the offer'));
        setNeedsTopUp(e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS');
      }
    }
  }

  return (
    <Sheet
      open={!!offer}
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="w-full sm:max-w-md"
      header={
        <div className="px-5 pb-1 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">{loc('قبول هذا العرض؟', 'Accept this offer?')}</h2>
        </div>
      }
      footer={
        <div className="space-y-2 px-5 py-3">
          {error && <p className="lv-field-error" role="alert">{error}</p>}
          {needsTopUp && (
            <Link to="/wallet" className="inline-flex min-h-[44px] items-center text-[13px] font-semibold text-gold underline-offset-4 hover:underline">
              {loc('اشحن المحفظة', 'Top up the wallet')}
            </Link>
          )}
          <Button variant="primary" block onClick={accept} loadingLabel={loc('جارٍ حجز المبلغ…', 'Holding the money…')} data-accept-confirm>
            {changed ? loc('اقبل الشروط الجديدة', 'Accept the new terms') : loc('اقبل واحجز المبلغ', 'Accept and hold the money')}
          </Button>
          <Button block variant="ghost" onClick={onClose}>{loc('ليس الآن', 'Not now')}</Button>
        </div>
      }
    >
      {o && (
        <div className="space-y-3 px-5 pb-3 pt-1 text-[13px] leading-relaxed text-text-secondary" data-accept-sheet>
          {changed && (
            <p role="status" className="lv-alert lv-alert-warning" data-accept="changed">
              {loc('غيّر التاجر هذا العرض بعد أن فتحته — هذه شروطه الآن.', 'The merchant changed this offer after you opened it — these are its terms now.')}
            </p>
          )}
          <div className="rounded-xl bg-white/[0.03] px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <bdi className="truncate font-semibold text-text-primary">{o.merchant?.name ?? '—'}</bdi>
              <span className="shrink-0 text-[16px] font-bold text-text-primary" data-accept="price"><Money iqd={o.price_iqd} /></span>
            </div>
            <p className="mt-1 text-[12px] text-text-muted">
              {o.completion_days ? loc(`خلال ${o.completion_days} يوم`, `In ${o.completion_days} days`) : ''} · {deliveryLabel(o.delivery_method, loc)} · {loc(`النسخة ${o.revision}`, `Version ${o.revision}`)}
            </p>
          </div>
          <p>
            {loc('يُحجز المبلغ من رصيدك الآن، ولا يُدفع للتاجر إلا بعد تأكيدك للاستلام.', 'The amount is held from your balance now; the merchant is paid only after you confirm delivery.')}
          </p>
          {o.delivery_method !== 'pickup' && (
            <div>
              <label htmlFor="accept-address" className="mb-1.5 block text-[12.5px] font-semibold text-text-secondary">{loc('عنوان التسليم', 'Delivery address')}</label>
              {addresses === null ? (
                <div className="h-11 animate-pulse rounded-xl bg-white/[0.04]" />
              ) : addresses.length ? (
                <select id="accept-address" className="lv-input w-full" value={addressId} onChange={(e) => setAddressId(e.target.value)}>
                  {addresses.map((a) => (
                    <option key={a.id} value={a.id}>{`${a.label} — ${a.address}`}</option>
                  ))}
                </select>
              ) : (
                <p className="text-[12.5px] text-text-muted">
                  {loc('لا عنوان محفوظ — سيصل للتاجر اسمك ورقمك، ويتفق معك على التسليم.', 'No saved address — the merchant receives your name and phone and arranges the handover with you.')}{' '}
                  <Link to="/addresses" className="font-semibold text-gold underline-offset-4 hover:underline">{loc('أضف عنوانًا', 'Add an address')}</Link>
                </p>
              )}
            </div>
          )}
          <p className="text-[12px] text-text-muted" data-accept="contact-consent">
            {loc(
              `عند القبول يصل إلى ${o.merchant?.name ?? 'التاجر'} اسمك ورقمك${o.delivery_method !== 'pickup' ? ' وعنوان التسليم' : ''}، ويصلك رقم متجره. لا يصل شيء منها لأي تاجر آخر.`,
              `On acceptance ${o.merchant?.name ?? 'the merchant'} receives your name and phone${o.delivery_method !== 'pickup' ? ' and the delivery address' : ''}, and you receive the store’s phone. No other merchant receives any of it.`
            )}
          </p>
        </div>
      )}
    </Sheet>
  );
}
