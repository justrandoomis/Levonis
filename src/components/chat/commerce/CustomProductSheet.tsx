/**
 * «منتج خاص» — A PRODUCT THE STORE MAKES FOR THIS CUSTOMER ONLY.
 *
 * Bought through the store's own cart and checkout — prepaid from the wallet,
 * the store's share pending until receipt — and seen by nobody else. Once sent
 * it cannot be edited (the database refuses it too): a change is a
 * cancellation and a new card, so the card can never say one price while the
 * checkout charges another. From a quote, the quote is closed in the same step.
 *
 * The picture is one the store uploads here (its own media, checked by the
 * server); no link from elsewhere is accepted.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ImagePlus, ShoppingBag, X } from 'lucide-react';
import { Sheet } from '../../ui/Sheet';
import ProductPickerSheet from '../ProductPickerSheet';
import { newClientId, productName, type PickerProduct } from '../../../lib/chatCards';
import { Field, Input, Textarea, focusFirstInvalid } from '../../ui/Field';
import { Button } from '../../ui/Button';
import { useLanguage } from '../../../LanguageContext';
import { ApiError, uploadFile } from '../../../lib/api';
import { toast } from '../../../lib/toastStore';
import { chatCommerceApi } from '../../../lib/chatCommerceApi';
import type { CustomProductPrefill } from '../cards/cardContext';

interface Form {
  name: string;
  description: string;
  price: string;
  prep: string;
  valid: string;
}

export default function CustomProductSheet({
  open,
  onClose,
  chatId,
  prefill,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  prefill: CustomProductPrefill;
  onSent: () => void;
}) {
  const { lang, loc } = useLanguage();
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState<Form>({ name: '', description: '', price: '', prep: '0', valid: '7' });
  const [image, setImage] = useState<{ url: string; key: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [busy, setBusy] = useState(false);
  const [baseOpen, setBaseOpen] = useState(false);
  // One name per opening of the sheet: a retry is the same product (a replay).
  const sendId = useRef(newClientId());

  /**
   * «ابدأ من منتج في متجرك» (docs/COMMUNITY_COMMERCE_CHAT.md §14): one of the
   * store's own products as the base — its name, price and picture filled in
   * to be changed for this customer. The picture is the store's own media, so
   * the server accepts it like an upload; nothing of the original product
   * changes, and the private product stands on its own from here.
   */
  const startFrom = (p: PickerProduct) => {
    setF((prev) => ({ ...prev, name: productName(p, lang), price: String(p.price_iqd) }));
    if (p.image) setImage({ url: p.image, key: p.image });
  };

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setImage(null);
    sendId.current = newClientId();
    setF({
      name: prefill.name ?? '',
      description: prefill.description ?? '',
      price: prefill.price_iqd ? String(prefill.price_iqd) : '',
      prep: String(prefill.prep_days ?? 0),
      valid: '7',
    });
  }, [open, prefill]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  async function pick(file: File) {
    setUploading(true);
    try {
      // The store's own public media (merchants/<owner>/public/…), which the
      // server checks is this store's before it accepts the product.
      const up = await uploadFile(file, 'community');
      setImage({ url: up.url, key: up.key });
    } catch {
      toast.error(loc('تعذّر رفع الصورة', 'The picture could not be uploaded'));
    } finally {
      setUploading(false);
    }
  }

  function validate(): boolean {
    const next: Partial<Record<keyof Form, string>> = {};
    if (f.name.trim().length < 2) next.name = loc('اكتب اسم المنتج', 'Name the product');
    const price = Number(f.price);
    if (!Number.isInteger(price) || price < 1) next.price = loc('اكتب السعر بالدينار', 'Enter the price in dinars');
    const prep = Number(f.prep);
    if (!Number.isInteger(prep) || prep < 0 || prep > 365) next.prep = loc('من 0 إلى 365 يومًا', 'From 0 to 365 days');
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
    try {
      await chatCommerceApi.customProduct(chatId, {
        name: f.name.trim(),
        description: f.description.trim(),
        price_iqd: Number(f.price),
        prep_days: Number(f.prep),
        valid_days: Number(f.valid),
        image: image?.key ?? null,
        quote_id: prefill.quoteId ?? null,
        client_id: sendId.current,
      });
      toast.success(loc('أُرسل المنتج الخاص', 'The private product was sent'));
      onSent();
      onClose();
    } catch (err) {
      const fallback = loc('تعذّر إرسال المنتج', 'The product could not be sent');
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
      testId="chat-custom-product-sheet"
      dirty={!busy && (f.name !== (prefill.name ?? '') || f.price !== (prefill.price_iqd ? String(prefill.price_iqd) : '') || !!image)}
      header={
        <div className="border-b border-border-subtle px-4 pb-3 pt-1">
          <h2 id={titleId} className="text-center text-[16px] font-extrabold text-text-primary">{loc('منتج خاص للزبون', 'Private product')}</h2>
          <p className="mt-1 text-center text-[12px] text-text-muted">
            {prefill.quoteId
              ? loc('يحلّ محل عرض السعر: يُغلق العرض ويشتري الزبون المنتج من سلة متجرك.', 'Replaces the quote: the quote closes and the customer buys this through your store cart.')
              : loc('يراه هذا الزبون وحده ويشتريه من سلة متجرك. لا يُعدَّل بعد إرساله.', 'Only this customer sees it and buys it through your store cart. It cannot be edited once sent.')}
          </p>
          {/* OWNER: Sorani to be written by hand (this sheet). */}
        </div>
      }
      footer={
        <div className="flex gap-2 px-4 py-3">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{loc('إلغاء', 'Cancel')}</Button>
          <Button variant="primary" block loading={busy} disabled={uploading} onClick={() => formRef.current?.requestSubmit()} data-custom-product-submit>
            {loc('أرسل المنتج', 'Send the product')}
          </Button>
        </div>
      }
    >
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4 px-4 py-4">
        {!prefill.quoteId && (
          <Button variant="secondary" size="sm" icon={<ShoppingBag className="w-4 h-4" aria-hidden="true" />} onClick={() => setBaseOpen(true)} data-custom-product-base>
            {loc('ابدأ من منتج في متجرك', 'Start from one of your products')}
          </Button>
        )}
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void pick(file);
            }}
          />
          <div className="w-20 h-20 rounded-xl overflow-hidden bg-surface-raised flex items-center justify-center shrink-0">
            {image ? <img src={image.url} alt="" className="w-full h-full object-cover" /> : <ImagePlus className="w-6 h-6 text-text-muted" aria-hidden="true" />}
          </div>
          <div className="flex flex-col gap-1.5">
            <Button variant="secondary" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
              {image ? loc('تغيير الصورة', 'Change the picture') : loc('أضف صورة', 'Add a picture')}
            </Button>
            {image && (
              <Button variant="ghost" size="sm" icon={<X className="w-4 h-4" aria-hidden="true" />} onClick={() => setImage(null)}>
                {loc('إزالة', 'Remove')}
              </Button>
            )}
          </div>
        </div>
        <Field label={loc('اسم المنتج', 'Product name')} error={errors.name} required>
          <Input value={f.name} onChange={set('name')} maxLength={140} />
        </Field>
        <Field label={loc('الوصف', 'Description')} optional>
          <Textarea value={f.description} onChange={set('description')} rows={3} maxLength={2000} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={loc('السعر (د.ع)', 'Price (IQD)')} error={errors.price} required>
            <Input value={f.price} onChange={set('price')} inputMode="numeric" ltr data-custom-product-price />
          </Field>
          <Field label={loc('التجهيز (أيام)', 'Preparation (days)')} error={errors.prep}>
            <Input value={f.prep} onChange={set('prep')} inputMode="numeric" ltr />
          </Field>
        </div>
        <Field label={loc('متاح للشراء لمدة (أيام)', 'Available to buy for (days)')} error={errors.valid}>
          <Input value={f.valid} onChange={set('valid')} inputMode="numeric" ltr />
        </Field>
        <p className="rounded-lg bg-surface-raised px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
          {loc(
            'قطعة واحدة. يدفع الزبون من محفظته عند الشراء، ويصبح مستحقك متاحًا بعد تأكيده الاستلام أو بعد 3 أيام من التسليم.',
            'One piece. The customer pays from their wallet at checkout; your share becomes available after they confirm receipt or 3 days after delivery.'
          )}
        </p>
      </form>
      {baseOpen && (
        <ProductPickerSheet
          open={baseOpen}
          onClose={() => setBaseOpen(false)}
          chatId={chatId}
          title={loc('ابدأ من منتج', 'Start from a product')}
          onPick={(_id, p) => startFrom(p)}
        />
      )}
    </Sheet>
  );
}
