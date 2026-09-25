/**
 * THE MERCHANT'S OFFER — compose, or edit (offers v2, stream W5-A).
 *
 * Seven things a customer compares: price, completion time, how it is handed
 * over (a closed list), the materials (from the catalogue), what is included,
 * the warranty, and how long the offer stands — plus a message. An EDIT is a
 * new version: the customer sees it as one, with the old price in its
 * history, and can only accept the version they are looking at. An edit of a
 * superseded offer prices the job as it now is and puts it back in front of
 * the customer.
 */
import { useEffect, useId, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Field, Input, Textarea } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Segmented } from '../../ui/Segmented';
import { useToast } from '../../ui/Toast';
import type { CatalogMaterial, OfferDeliveryMethod } from '../requests/api';
import { offersApi, type OfferV2 } from './types';

const VALIDITY = [3, 7, 14, 30] as const;

export default function OfferComposer({
  open,
  requestId,
  offer,
  materials,
  onClose,
  onSaved,
}: {
  open: boolean;
  requestId: string;
  /** Present when editing. */
  offer?: OfferV2 | null;
  /** The catalogue, already narrowed to what the job can be made in. */
  materials: CatalogMaterial[];
  onClose: () => void;
  onSaved: (offer: OfferV2) => void;
}) {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const titleId = useId();
  const editing = !!offer;
  const [price, setPrice] = useState<number | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [delivery, setDelivery] = useState<OfferDeliveryMethod>('merchant_delivery');
  const [picked, setPicked] = useState<string[]>([]);
  const [included, setIncluded] = useState('');
  const [warranty, setWarranty] = useState('');
  const [valid, setValid] = useState<number>(7);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState<{ price?: string; days?: string }>({});

  useEffect(() => {
    if (!open) return;
    setError('');
    setInvalid({});
    setPrice(offer?.price_iqd ?? null);
    setDays(offer?.completion_days || null);
    setDelivery((['pickup', 'merchant_delivery', 'courier'].includes(offer?.delivery_method ?? '') ? offer!.delivery_method : 'merchant_delivery') as OfferDeliveryMethod);
    setPicked(offer?.material_ids ?? []);
    setIncluded(offer?.included ?? '');
    setWarranty(offer?.warranty_terms ?? '');
    setMessage(offer?.message ?? '');
    setValid(7);
  }, [open, offer]);

  async function submit() {
    const bad: typeof invalid = {};
    if (!price || price < 1) bad.price = loc('اكتب سعرك بالدينار.', 'Enter your price in dinars.');
    if (!days || days < 1) bad.days = loc('كم يومًا يحتاج التنفيذ؟', 'How many days will it take?');
    setInvalid(bad);
    if (Object.keys(bad).length) return;
    setError('');
    const terms = {
      price_iqd: price!,
      completion_days: days!,
      delivery_method: delivery,
      material_ids: picked,
      included: included.trim(),
      warranty_terms: warranty.trim(),
      valid_days: valid,
      message: message.trim(),
    };
    try {
      const d = editing ? await offersApi.edit(offer!.id, terms) : await offersApi.create(requestId, terms);
      toast.success(editing ? loc('حُدّث عرضك — يراه الزبون كنسخة جديدة.', 'Offer updated — the customer sees it as a new version.') : loc('أُرسل عرضك.', 'Your offer was sent.'));
      onSaved(d.offer);
    } catch (e) {
      setError(e instanceof ApiError ? apiRefusal(e, lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar', e.message) : loc('تعذّر الإرسال', 'Could not send'));
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      dirty={price !== (offer?.price_iqd ?? null)}
      panelClassName="w-full sm:max-w-lg"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">
            {editing ? loc('تعديل عرضك', 'Edit your offer') : loc('قدّم عرضك', 'Make your offer')}
          </h2>
          {editing && (
            <p className="mt-0.5 text-[12px] text-text-muted">
              {loc('يرى الزبون التعديل نسخةً جديدة، ويبقى السعر السابق في السجل.', 'The customer sees the edit as a new version; the old price stays in its history.')}
            </p>
          )}
        </div>
      }
      footer={
        <div className="px-5 py-3">
          {error && <p className="lv-field-error mb-2" role="alert">{error}</p>}
          <Button variant="primary" block onClick={submit} data-offer-submit>
            {editing ? loc('احفظ النسخة الجديدة', 'Save the new version') : loc('أرسل العرض', 'Send offer')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-4 pt-1" data-offer-composer>
        <div className="grid grid-cols-2 gap-3">
          <Field label={loc('السعر', 'Price')} required error={invalid.price}>
            <NumberInput kind="money" value={price} onValueChange={(v) => setPrice(v)} />
          </Field>
          <Field label={loc('مدة التنفيذ', 'Completion')} required error={invalid.days}>
            <NumberInput min={1} max={365} unit={loc('يوم', 'days')} value={days} onValueChange={(v) => setDays(v)} />
          </Field>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('التسليم', 'Handover')}</p>
          <Segmented
            group="offer-delivery"
            size="sm"
            label={loc('التسليم', 'Handover')}
            value={delivery}
            onChange={(id) => setDelivery(id as OfferDeliveryMethod)}
            items={[
              { id: 'merchant_delivery', label: loc('أوصله', 'I deliver') },
              { id: 'courier', label: loc('شركة توصيل', 'Courier') },
              { id: 'pickup', label: loc('استلام', 'Pickup') },
            ]}
          />
        </div>
        {materials.length > 0 && (
          <div>
            <p className="mb-2 text-[13px] font-semibold text-text-secondary">
              {loc('المواد', 'Materials')} <span className="font-normal text-text-muted">{loc('— حتى 5', '— up to 5')}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {materials.map((m) => {
                const on = picked.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={on}
                    disabled={!on && picked.length >= 5}
                    onClick={() => setPicked((p) => (on ? p.filter((x) => x !== m.id) : [...p, m.id]))}
                    className="lv-choice px-3 text-[12.5px] font-medium disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {lang === 'en' ? m.name_en : m.name_ar || m.name_en}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <Field label={loc('يشمل العرض', 'Included')} optional hint={loc('مثل: صنفرة، طلاء أساس، تغليف.', 'e.g. sanding, primer, packaging.')}>
          <Input value={included} maxLength={500} onChange={(e) => setIncluded(e.target.value)} dir="auto" />
        </Field>
        <Field label={loc('الضمان', 'Warranty')} optional hint={loc('مثل: إعادة الطباعة إن انكسرت خلال 30 يومًا.', 'e.g. a reprint if it cracks within 30 days.')}>
          <Input value={warranty} maxLength={500} onChange={(e) => setWarranty(e.target.value)} dir="auto" />
        </Field>
        <div>
          <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('يبقى العرض قائمًا', 'Offer stands for')}</p>
          <Segmented
            group="offer-validity"
            size="sm"
            label={loc('صلاحية العرض', 'Offer validity')}
            value={String(valid)}
            onChange={(id) => setValid(Number(id))}
            items={VALIDITY.map((d) => ({ id: String(d), label: loc(`${d} أيام`, `${d} days`) }))}
          />
        </div>
        <Field label={loc('رسالة للزبون', 'Message to the customer')} optional>
          <Textarea value={message} rows={3} maxLength={2000} onChange={(e) => setMessage(e.target.value)} dir="auto" />
        </Field>
        <p className="text-[11.5px] leading-relaxed text-text-muted">
          {loc(
            'بعد قبول الزبون لا يتغير السعر ولا المدة. يُحجز المبلغ لدى Levonis ويُحرَّر لك بعد تأكيد الاستلام.',
            'Once the customer accepts, the price and timeline are fixed. Levonis holds the money and releases it to you when delivery is confirmed.'
          )}
        </p>
      </div>
    </Sheet>
  );
}
