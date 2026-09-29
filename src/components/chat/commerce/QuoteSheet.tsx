/**
 * «عرض سعر» — THE STORE'S QUOTE, WRITTEN IN THE CONVERSATION.
 *
 * On a customer's print request (`requestId`), or — with none — for a job the
 * store describes itself, which becomes the CUSTOMER's request (nothing is
 * charged; their acceptance is the consent). Editing an existing quote sends
 * only the terms and makes a NEW revision: the customer's older card says it
 * was updated and cannot be accepted at its old price.
 *
 * Every figure here is a proposal the server validates (worker/routes/
 * marketplace.ts `readOfferTerms`); the price the customer finally pays is the
 * price on the card they accept — never a number from this form.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Sheet } from '../../ui/Sheet';
import { Field, Input, Select, Textarea, focusFirstInvalid } from '../../ui/Field';
import { Button } from '../../ui/Button';
import { useLanguage } from '../../../LanguageContext';
import { api, ApiError } from '../../../lib/api';
import { toast } from '../../../lib/toastStore';
import { DELIVERY_METHODS, chatCommerceApi } from '../../../lib/chatCommerceApi';
import { newClientId } from '../../../lib/chatCards';
import { deliveryText } from '../cards/cardWords';
import type { QuotePrefill } from '../cards/cardContext';

interface Form {
  title: string;
  description: string;
  quantity: string;
  material: string;
  color: string;
  price: string;
  days: string;
  delivery: string;
  message: string;
  included: string;
  warranty: string;
  valid: string;
}

const EMPTY: Form = {
  title: '', description: '', quantity: '1', material: '', color: '', price: '', days: '3',
  delivery: 'merchant_delivery', message: '', included: '', warranty: '', valid: '7',
};

const text = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export default function QuoteSheet({
  open,
  onClose,
  chatId,
  prefill,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  prefill: QuotePrefill;
  onSent: () => void;
}) {
  const { lang, loc } = useLanguage();
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [busy, setBusy] = useState(false);
  // One name per opening of the sheet: a retry after a lost answer is the same
  // quote (the server answers it as a replay), a fresh opening a new one.
  const sendId = useRef(newClientId());
  const editing = prefill.edit?.offerId ?? null;
  const onRequest = !!prefill.requestId;

  // An edit starts from the quote as its latest card froze it — or, from a
  // print request's «عدّل عرضك», from the store's own offer on that request.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    sendId.current = newClientId();
    const fromSnapshot = (s: Record<string, unknown>) => ({
      ...EMPTY,
      price: text(s.price_iqd),
      days: text(s.completion_days ?? '0'),
      delivery: text(s.delivery_method) || 'merchant_delivery',
      message: text(s.message),
      included: text(s.included),
      warranty: text(s.warranty_terms),
    });
    if (editing && prefill.edit && Object.keys(prefill.edit.snapshot).length) {
      setF(fromSnapshot(prefill.edit.snapshot));
      return;
    }
    setF(EMPTY);
    if (editing && prefill.requestId) {
      api
        .get<{ offers: Array<Record<string, unknown>> }>(`/api/marketplace/requests/${encodeURIComponent(prefill.requestId)}/offers`, { mascot: 'silent' })
        .then((d) => {
          const mine = (d.offers ?? []).find((o) => o.id === editing);
          if (mine) setF(fromSnapshot(mine));
        })
        .catch(() => {});
    }
  }, [open, editing, prefill]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  function validate(): boolean {
    const next: Partial<Record<keyof Form, string>> = {};
    if (!editing && !onRequest && f.title.trim().length < 4) next.title = loc('اكتب اسمًا للعمل (4 أحرف على الأقل)', 'Name the job (at least 4 characters)');
    const price = Number(f.price);
    if (!Number.isInteger(price) || price < 1) next.price = loc('اكتب السعر بالدينار', 'Enter the price in dinars');
    const days = Number(f.days);
    if (!Number.isInteger(days) || days < 0 || days > 365) next.days = loc('من 0 إلى 365 يومًا', 'From 0 to 365 days');
    const valid = Number(f.valid);
    if (!Number.isInteger(valid) || valid < 1 || valid > 60) next.valid = loc('من يوم إلى 60 يومًا', 'From 1 to 60 days');
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    const terms = {
      price_iqd: Number(f.price),
      completion_days: Number(f.days),
      delivery_method: f.delivery,
      message: f.message.trim(),
      included: f.included.trim(),
      warranty_terms: f.warranty.trim(),
      valid_days: Number(f.valid),
      client_id: sendId.current,
    };
    try {
      if (editing) {
        await chatCommerceApi.editQuote(chatId, editing, terms);
        toast.success(loc('أُرسل العرض المعدّل', 'The updated quote was sent'));
      } else {
        await chatCommerceApi.quote(chatId, {
          ...terms,
          ...(onRequest
            ? { request_id: prefill.requestId }
            : {
                title: f.title.trim(),
                description: f.description.trim(),
                quantity: Math.max(1, Number(f.quantity) || 1),
                material: f.material.trim(),
                color: f.color.trim(),
              }),
        });
        toast.success(loc('أُرسل عرض السعر', 'The quote was sent'));
      }
      onSent();
      onClose();
    } catch (err) {
      const fallback = loc('تعذّر إرسال العرض', 'The quote could not be sent');
      const { apiRefusal } = await import('../../../lib/refusalStrings');
      toast.error(err instanceof ApiError ? apiRefusal(err, lang, fallback) : fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="sm:max-w-[520px] sm:w-[92vw]"
      testId="chat-quote-sheet"
      dirty={!busy && (f.price !== '' || f.message !== '' || f.title !== '')}
      header={
        <div className="border-b border-border-subtle px-4 pb-3 pt-1">
          <h2 id={titleId} className="text-center text-[16px] font-extrabold text-text-primary">
            {editing ? loc('تعديل عرض السعر', 'Edit the quote') : loc('عرض سعر', 'Quote')}
          </h2>
          <p className="mt-1 text-center text-[12px] text-text-muted">
            {editing
              ? loc('يُرسل كعرض جديد، ولا يُقبل العرض القديم بسعره السابق.', 'Sent as a new version; the older one can no longer be accepted.')
              : onRequest
                ? loc('على طلب الطباعة الذي أرسله الزبون.', 'On the print request the customer sent.')
                : loc('لعمل تصفه أنت — يصبح طلبًا باسم الزبون، ولا يُخصم شيء قبل قبوله.', 'For a job you describe — it becomes the customer’s request; nothing is charged before they accept.')}
          </p>
          {/* OWNER: Sorani to be written by hand (this sheet). */}
        </div>
      }
      footer={
        <div className="flex gap-2 px-4 py-3">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{loc('إلغاء', 'Cancel')}</Button>
          <Button variant="primary" block loading={busy} onClick={() => formRef.current?.requestSubmit()} data-quote-submit>
            {editing ? loc('أرسل العرض المعدّل', 'Send the update') : loc('أرسل العرض', 'Send the quote')}
          </Button>
        </div>
      }
    >
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4 px-4 py-4">
        {!editing && !onRequest && (
          <>
            <Field label={loc('العمل', 'The job')} error={errors.title} required>
              <Input value={f.title} onChange={set('title')} maxLength={140} placeholder={loc('مثلًا: حامل هاتف بشعارك', 'e.g. A phone stand with your logo')} />
            </Field>
            <Field label={loc('الوصف', 'Description')} optional>
              <Textarea value={f.description} onChange={set('description')} rows={3} maxLength={6000} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={loc('الكمية', 'Quantity')}>
                <Input value={f.quantity} onChange={set('quantity')} inputMode="numeric" ltr />
              </Field>
              <Field label={loc('المادة', 'Material')} optional>
                <Input value={f.material} onChange={set('material')} maxLength={60} />
              </Field>
              <Field label={loc('اللون', 'Colour')} optional>
                <Input value={f.color} onChange={set('color')} maxLength={60} />
              </Field>
            </div>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={loc('السعر (د.ع)', 'Price (IQD)')} error={errors.price} required>
            <Input value={f.price} onChange={set('price')} inputMode="numeric" ltr data-quote-price />
          </Field>
          <Field label={loc('مدة التنفيذ (أيام)', 'Ready in (days)')} error={errors.days} required>
            <Input value={f.days} onChange={set('days')} inputMode="numeric" ltr />
          </Field>
        </div>
        <Field label={loc('طريقة التسليم', 'Handover')}>
          <Select value={f.delivery} onChange={set('delivery')}>
            {DELIVERY_METHODS.map((m) => (
              <option key={m} value={m}>{deliveryText(m, loc)}</option>
            ))}
          </Select>
        </Field>
        <Field label={loc('رسالة للزبون', 'Message to the customer')} optional>
          <Textarea value={f.message} onChange={set('message')} rows={3} maxLength={2000} />
        </Field>
        <Field label={loc('يشمل', 'Includes')} optional hint={loc('مثلًا: التغليف، ملف المعاينة', 'e.g. packaging, a preview render')}>
          <Input value={f.included} onChange={set('included')} maxLength={500} />
        </Field>
        <Field label={loc('الضمان', 'Warranty')} optional>
          <Input value={f.warranty} onChange={set('warranty')} maxLength={500} />
        </Field>
        <Field label={loc('صلاحية العرض (أيام)', 'Valid for (days)')} error={errors.valid}>
          <Input value={f.valid} onChange={set('valid')} inputMode="numeric" ltr />
        </Field>
        <p className="rounded-lg bg-surface-raised px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
          {loc(
            'عند قبول الزبون يُحجز المبلغ من محفظته في الضمان، ويُحوَّل لك بعد تأكيده الاستلام (أو تلقائيًا بعد المدة المحددة). لا يمكن تعديل العرض بعد قبوله.',
            'When the customer accepts, the amount is held from their wallet and paid to you after they confirm receipt (or automatically after the set period). An accepted quote cannot be changed.'
          )}
        </p>
      </form>
    </Sheet>
  );
}
