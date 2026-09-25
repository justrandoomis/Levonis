/**
 * THE MERCHANT'S SIDE OF ONE REQUEST (offers v2, stream W5-A): their own offer
 * — or the button to make one — and what they can do with it.
 *
 *   pending     edit (a new version the customer sees) · withdraw · ask
 *   superseded  the customer changed the job: WHAT changed (from the
 *               request's revisions), then re-confirm as is · edit · withdraw
 *   accepted    the customer's contact and delivery details, and the
 *               request conversation
 *   expired / rejected / withdrawn   said plainly; a new offer when the
 *               request still takes offers
 *
 * A merchant only ever sees their own offer; the server filters competitors'
 * prices in SQL.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, MessageCircle, Send } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { StatusChip } from '../../ui/Badge';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { requestsApi, type CatalogMaterial } from '../requests/api';
import OfferComposer from './OfferComposer';
import OrderContactCard from './OrderContactCard';
import { deliveryLabel, offerStateLabel, offersApi, validUntil, type Loc, type OfferV2 } from './types';

/** The words for a revision's changed fields — a merchant reads «المادة», not `material_id`. */
function changeLabel(k: string, loc: Loc): string {
  const map: Record<string, [string, string]> = {
    quantity: ['الكمية', 'quantity'],
    source_type: ['مصدر الطلب', 'source'],
    process: ['طريقة الطباعة', 'process'],
    material_id: ['المادة', 'material'],
    color_hex: ['اللون', 'colour'],
    color_name: ['اللون', 'colour'],
    quality: ['الدقة', 'detail'],
    infill_percent: ['الحشوة', 'infill'],
    supports: ['الدعامات', 'supports'],
    colors_count: ['عدد الألوان', 'colours'],
    post_processing_minutes: ['التشطيب', 'finishing'],
    primary_file_id: ['الملف', 'model file'],
    source_url: ['الرابط', 'link'],
    stated_dims: ['المقاس', 'size'],
    governorate: ['المحافظة', 'governorate'],
    delivery_pref: ['الاستلام', 'handover'],
    deadline: ['الموعد', 'deadline'],
    customer_notes: ['الملاحظات', 'notes'],
    file_ids: ['المرفقات', 'attachments'],
  };
  const v = map[k];
  return v ? loc(v[0], v[1]) : k;
}

export default function MerchantOfferPanel({
  requestId,
  offers,
  canOffer,
  takingOffers,
  materials,
  onChanged,
  prefill = null,
  onPrefillDone,
}: {
  requestId: string;
  /** This merchant's offers on the request (the server sends only theirs). */
  offers: OfferV2[];
  /** The account may make offers (plan, store and merchant state). */
  canOffer: boolean;
  takingOffers: boolean;
  materials: CatalogMaterial[];
  onChanged: () => void;
  /** «استخدم هذا كعرضي» (W5-B): open the composer filled with this private price. */
  prefill?: { price_iqd: number; quote_id: string } | null;
  /** The composer that took the prefill closed. */
  onPrefillDone?: () => void;
}) {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const [composing, setComposing] = useState<'' | 'new' | 'edit'>('');
  const [changes, setChanges] = useState<string[] | null>(null);
  const L = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const live = offers.find((o) => o.state === 'pending' || o.state === 'superseded' || o.state === 'accepted') ?? null;
  const latest = live ?? offers[offers.length - 1] ?? null;
  const stale = !!live && (live.state === 'superseded' || live.stale);

  // A costing handed over as «my offer»: a new offer, or a new version of the standing one.
  useEffect(() => {
    if (!prefill || !takingOffers) return;
    if (live && (live.state === 'pending' || live.state === 'superseded')) setComposing('edit');
    else if (!live && canOffer) setComposing('new');
  }, [prefill, takingOffers, canOffer, live]);

  useEffect(() => {
    if (!stale) return;
    let alive = true;
    requestsApi
      .revisions(requestId)
      .then((d) => {
        if (!alive) return;
        // Everything that moved since the revision this offer priced.
        const since = d.revisions.filter((r) => r.revision > (live?.request_revision ?? 0)).flatMap((r) => r.changes);
        setChanges([...new Set(since.map((k) => changeLabel(k, loc)))]);
      })
      .catch(() => alive && setChanges([]));
    return () => {
      alive = false;
    };
  }, [stale, requestId, live?.request_revision, loc]);

  const fail = (e: unknown, fb: string) => toast.error(e instanceof ApiError ? apiRefusal(e, L, e.message) : fb);

  async function withdraw() {
    if (!live) return;
    const ok = await confirm({
      title: loc('سحب عرضك؟', 'Withdraw your offer?'),
      consequence: loc('لن يستطيع الزبون قبوله. يمكنك تقديم عرض جديد ما دام الطلب يستقبل العروض.', 'The customer can no longer accept it. You can make a new offer while the request takes offers.'),
      confirmLabel: loc('اسحب العرض', 'Withdraw offer'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await offersApi.withdraw(live.id);
      onChanged();
    } catch (e) {
      fail(e, loc('تعذّر سحب العرض', 'Could not withdraw the offer'));
    }
  }

  async function reconfirm() {
    if (!live) return;
    try {
      await offersApi.reconfirm(live.id);
      toast.success(loc('أكّدت عرضك للطلب بصيغته الحالية.', 'You re-confirmed your offer for the request as it is now.'));
      onChanged();
    } catch (e) {
      fail(e, loc('تعذّر تأكيد العرض', 'Could not re-confirm the offer'));
    }
  }

  async function chat() {
    try {
      const r = await offersApi.openThread(requestId);
      navigate(`/chat/${encodeURIComponent(r.chatId)}`);
    } catch (e) {
      fail(e, loc('تعذّر فتح المحادثة', 'Could not open the conversation'));
    }
  }

  const composer = (
    <OfferComposer
      open={!!composing}
      requestId={requestId}
      offer={composing === 'edit' ? live : null}
      materials={materials}
      prefill={prefill}
      onClose={() => {
        setComposing('');
        onPrefillDone?.();
      }}
      onSaved={() => {
        setComposing('');
        onPrefillDone?.();
        onChanged();
      }}
    />
  );

  if (!latest || (!live && takingOffers && canOffer)) {
    return (
      <div data-merchant-offer="none">
        {latest && (
          <p className="mb-2 text-[12.5px] text-text-muted">
            {loc('عرضك السابق:', 'Your previous offer:')} {offerStateLabel(latest, loc).text}
          </p>
        )}
        {takingOffers && canOffer ? (
          <Button variant="primary" block onClick={() => setComposing('new')} icon={<Send aria-hidden="true" className="h-4 w-4" />} data-offer-make>
            {loc('قدّم عرضًا', 'Make an offer')}
          </Button>
        ) : (
          !latest && <p className="text-[12.5px] text-text-muted">{loc('لا يمكنك تقديم عرض على هذا الطلب الآن.', 'You cannot make an offer on this request now.')}</p>
        )}
        {composer}
        {confirmDialog}
      </div>
    );
  }

  const o = latest;
  const st = offerStateLabel(o, loc);
  const until = validUntil(o.expires_at, lang);
  return (
    <div className="lv-surface p-4" data-merchant-offer={o.state} data-offer={o.id}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] text-text-muted">{loc(`عرضك — النسخة ${o.revision}`, `Your offer — version ${o.revision}`)}</p>
          <p className="mt-0.5 text-[20px] font-bold text-text-primary"><Money iqd={o.price_iqd} /></p>
        </div>
        <StatusChip tone={st.tone}>{st.text}</StatusChip>
      </div>
      <p className="mt-1 text-[12.5px] text-text-secondary">
        {o.completion_days ? loc(`${o.completion_days} يوم`, `${o.completion_days} days`) : '—'} · {deliveryLabel(o.delivery_method, loc)}
        {until && <> · {loc(`صالح حتى ${until}`, `valid until ${until}`)}</>}
      </p>

      {stale && (
        <div className="mt-3 rounded-xl bg-warning/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-warning" data-offer-note="superseded">
          <p className="flex items-start gap-2 font-semibold">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {loc('عدّل الزبون الطلب بعد عرضك، فلا يمكن قبوله حتى تؤكده أو تعدّله.', 'The customer changed the request after your offer; it cannot be accepted until you re-confirm or edit it.')}
          </p>
          {changes && changes.length > 0 && (
            <p className="mt-1 ps-6 text-text-secondary">{loc('ما الذي تغيّر: ', 'What changed: ')}{changes.join('، ')}</p>
          )}
        </div>
      )}

      {o.state === 'accepted' && o.order_id ? (
        <div className="mt-3"><OrderContactCard orderId={o.order_id} /></div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {stale && takingOffers && (
            <Button variant="primary" size="sm" onClick={reconfirm} data-offer-reconfirm={o.id}>{loc('أؤكد عرضي كما هو', 'Re-confirm as is')}</Button>
          )}
          {(o.state === 'pending' || o.state === 'superseded') && takingOffers && (
            <Button size="sm" variant={stale ? 'secondary' : 'primary'} onClick={() => setComposing('edit')} data-offer-edit={o.id}>
              {loc('عدّل العرض', 'Edit offer')}
            </Button>
          )}
          {(o.state === 'pending' || o.state === 'superseded') && (
            <>
              <Button size="sm" variant="secondary" onClick={chat} icon={<MessageCircle aria-hidden="true" className="h-4 w-4" />}>
                {loc('راسل الزبون', 'Message')}
              </Button>
              <Button size="sm" variant="ghost" onClick={withdraw} data-offer-withdraw={o.id}>{loc('اسحب', 'Withdraw')}</Button>
            </>
          )}
        </div>
      )}
      {composer}
      {confirmDialog}
    </div>
  );
}
