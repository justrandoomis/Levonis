/**
 * ONE ADDRESS FORM, FOR EVERY PLACE AN ADDRESS IS WRITTEN.
 *
 * THREE FORMS EXISTED. The address book had a long one in hardcoded English
 * whose primary Save button measured 1.16:1 against its own background — a
 * near-invisible control on the screen a customer must complete to receive
 * anything. The merchant checkout had a compact one that posted a raw phone
 * with no country. And the platform checkout had none at all: its "add an
 * address" button pushed `/addresses`, which unmounted checkout entirely and
 * threw away the delivery method, the payment method, the coupon, the wallet
 * toggle and the policy tick — then, on return, re-selected the OLD default,
 * so the address just created was not even the one being shipped to.
 *
 * They agreed on nothing: which fields were required, what a phone looked like,
 * whether a governorate mattered. This is the one form, and the two checkouts
 * render it in place so nobody is ever ejected mid-purchase.
 *
 * WHAT IT REQUIRES, AND WHY EACH ONE.
 *   name, phone     the courier calls this person on this number
 *   governorate     DISPATCH ROUTES ON IT. It was optional on edit, and a
 *                   legacy value not in the closed list was silently wiped to
 *                   '' by the act of editing — which reaches Al-Waseet as an
 *                   empty governorate. Required now, on create and on edit.
 *   address         the street line
 * Label, area, landmark and courier notes are genuinely optional and are
 * presented as such rather than with an asterisk nobody enforces.
 *
 * THE PHONE IS NOT PREPENDED HERE. The old form did `'+964-' + typed`, which
 * produced `+964-0770 123 4567` — hyphen, spaces, bogus leading zero, stored
 * verbatim and copied onto the shipment — and made any address whose number was
 * not already `+964`-prefixed impossible to edit, because the prefix was
 * stripped only when it matched exactly and then re-added unconditionally. The
 * number is sent as typed and `worker/routes/addresses.ts` normalises it with
 * the platform's own libphonenumber validator, which is what every other phone
 * on this platform goes through. Nothing here guesses.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, Loader2, Check } from 'lucide-react';
import { api, ApiAddress } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import { GOVERNORATES } from '../../lib/governorates';

export interface AddressFormProps {
  /** The row being edited, or null/undefined to create a new one. */
  initial?: ApiAddress | null;
  /** The saved row's id. The caller selects it — that is the whole point. */
  onSaved: (id: string, address: ApiAddress | null) => void;
  onCancel?: () => void;
  /** Make the first address the default. Checkout passes true. */
  defaultWhenFirst?: boolean;
  /** Compact spacing for a form embedded inside a checkout column. */
  dense?: boolean;
}

type Field = 'name' | 'phone' | 'governorate' | 'address';

/**
 * A stored number, shown the way it was typed.
 *
 * An Iraqi customer entered `07701234567`; the server stores `+9647701234567`.
 * Showing the E.164 back would be correct and unfamiliar, and the old code's
 * attempt at this (`replace(/^\+964-?/, '')`) is what made non-Iraqi numbers
 * uneditable. So: an Iraqi number comes back in its national form, and
 * anything else comes back exactly as stored, because there is nothing honest
 * to strip from it.
 */
function forDisplay(stored: string): string {
  const s = (stored || '').replace(/[\s\-()]/g, '');
  if (/^\+964\d{9,10}$/.test(s)) return `0${s.slice(4)}`;
  return stored || '';
}

export default function AddressForm({
  initial,
  onSaved,
  onCancel,
  defaultWhenFirst = false,
  dense = false,
}: AddressFormProps) {
  const { loc, lang } = useLanguage();
  const editing = !!initial;

  const [label, setLabel] = useState(initial?.label ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(forDisplay(initial?.phone ?? ''));
  const [governorate, setGovernorate] = useState(initial?.governorate ?? '');
  const [area, setArea] = useState(initial?.area ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [landmark, setLandmark] = useState(initial?.landmark ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  /** Per-field messages. Submit-only validation with one banner at the bottom
   *  makes the customer hunt for which box is wrong. */
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const refs = {
    name: useRef<HTMLInputElement>(null),
    phone: useRef<HTMLInputElement>(null),
    governorate: useRef<HTMLSelectElement>(null),
    address: useRef<HTMLTextAreaElement>(null),
  };

  useEffect(() => {
    setLabel(initial?.label ?? '');
    setName(initial?.name ?? '');
    setPhone(forDisplay(initial?.phone ?? ''));
    setGovernorate(initial?.governorate ?? '');
    setArea(initial?.area ?? '');
    setAddress(initial?.address ?? '');
    setLandmark(initial?.landmark ?? '');
    setNotes(initial?.notes ?? '');
    setFieldErrors({});
    setFormError('');
  }, [initial]);

  /**
   * A LEGACY GOVERNORATE THAT IS NOT IN THE LIST IS NOT SILENTLY DISCARDED.
   *
   * A `<select>` with no matching `<option>` falls back to its placeholder, so
   * simply opening the editor on such a row and saving wrote `governorate: ''`
   * — the field dispatch routes on — without the customer touching it. The
   * stored text is shown as a disabled option, so they can see what is there
   * and are asked to pick the right one.
   */
  const legacyGovernorate = useMemo(() => {
    const g = initial?.governorate ?? '';
    return g && !GOVERNORATES.some((x) => x.id === g) ? g : '';
  }, [initial]);

  const govLabel = (g: (typeof GOVERNORATES)[number]) =>
    lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar;

  function validate(): Field | null {
    const next: Partial<Record<Field, string>> = {};
    if (name.trim().length < 2) {
      next.name = loc('اكتب اسم المستلم', 'Enter the recipient’s name', 'ناوی وەرگر بنووسە');
    }
    // Digits only, and enough of them to be a number at all. The SERVER decides
    // whether it is a real, routable number — that is libphonenumber's job, not
    // a regex here that would disagree with it.
    if (phone.replace(/\D/g, '').length < 7) {
      next.phone = loc('اكتب رقم هاتف صحيح', 'Enter a valid phone number', 'ژمارەیەکی دروست بنووسە');
    }
    if (!governorate) {
      next.governorate = loc('اختر المحافظة', 'Choose a governorate', 'پارێزگا هەڵبژێرە');
    }
    if (address.trim().length < 5) {
      next.address = loc('اكتب تفاصيل العنوان', 'Enter the street and details', 'وردەکاری ناونیشان بنووسە');
    }
    setFieldErrors(next);
    const order: Field[] = ['name', 'phone', 'governorate', 'address'];
    return order.find((f) => next[f]) ?? null;
  }

  async function save() {
    if (busy) return;
    setFormError('');
    const first = validate();
    if (first) {
      // Take the customer to the problem instead of describing it at the
      // bottom of a form they have already scrolled past.
      refs[first].current?.focus();
      refs[first].current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const body = {
      label: label.trim() || loc('عنواني', 'My address', 'ناونیشانم'),
      name: name.trim(),
      phone: phone.trim(),
      address: address.trim(),
      landmark: landmark.trim(),
      governorate,
      area: area.trim(),
      notes: notes.trim(),
      isDefault: editing ? initial!.is_default === 1 : defaultWhenFirst,
    };
    setBusy(true);
    try {
      if (editing) {
        await api.put(`/api/addresses/${initial!.id}`, body);
        onSaved(initial!.id, { ...initial!, ...body, is_default: initial!.is_default } as ApiAddress);
      } else {
        const r = await api.post<{ id: string }>('/api/addresses', body);
        onSaved(r.id, null);
      }
    } catch (err) {
      // The server's refusal, in the customer's language — INVALID_PHONE and
      // GOVERNORATE_REQUIRED are both in the shared table.
      setFormError(apiRefusal(err, lang as 'ar' | 'en' | 'ckb', loc('تعذّر حفظ العنوان', 'Could not save the address', 'نەتوانرا ناونیشان پاشەکەوت بکرێت')));
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  const gap = dense ? 'space-y-2.5' : 'space-y-3.5';
  const field =
    'w-full min-h-[46px] rounded-xl bg-zinc-900/60 border px-3 text-white text-[14px] outline-none transition-colors placeholder:text-zinc-600 focus-visible:border-gold/60';
  const ok = 'border-zinc-800 hover:border-zinc-700';
  const bad = 'border-red-500/60';
  const labelCls = 'block text-[12px] font-medium text-zinc-400 mb-1.5';
  const errCls = 'mt-1 text-[12px] text-red-400';
  const req = <span aria-hidden="true" className="text-red-400 ms-0.5">*</span>;

  return (
    <div className={gap}>
      <div>
        <label htmlFor="addr-name" className={labelCls}>
          {loc('اسم المستلم', 'Recipient’s name', 'ناوی وەرگر')}
          {req}
        </label>
        <input
          id="addr-name"
          ref={refs.name}
          name="name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!fieldErrors.name}
          aria-describedby={fieldErrors.name ? 'addr-name-err' : undefined}
          placeholder={loc('الاسم الكامل', 'Full name', 'ناوی تەواو')}
          className={`${field} ${fieldErrors.name ? bad : ok}`}
        />
        {fieldErrors.name ? (
          <p id="addr-name-err" className={errCls}>
            {fieldErrors.name}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="addr-phone" className={labelCls}>
          {loc('رقم الهاتف', 'Phone number', 'ژمارەی تەلەفۆن')}
          {req}
        </label>
        {/* `dir="ltr"` and `text-start`: a phone number is read left to right in
            every script, but it belongs on the reading edge of an RTL form. */}
        <input
          id="addr-phone"
          ref={refs.phone}
          name="tel"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-invalid={!!fieldErrors.phone}
          aria-describedby={fieldErrors.phone ? 'addr-phone-err' : 'addr-phone-hint'}
          placeholder="07701234567"
          className={`${field} text-start tabular-nums ${fieldErrors.phone ? bad : ok}`}
        />
        {fieldErrors.phone ? (
          <p id="addr-phone-err" className={errCls}>
            {fieldErrors.phone}
          </p>
        ) : (
          <p id="addr-phone-hint" className="mt-1 text-[11.5px] text-zinc-500">
            {loc('الرقم الذي سيتصل به المندوب', 'The number the courier will call', 'ئەو ژمارەیەی گەیێنەر پەیوەندی پێوە دەکات')}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label htmlFor="addr-gov" className={labelCls}>
            {loc('المحافظة', 'Governorate', 'پارێزگا')}
            {req}
          </label>
          <select
            id="addr-gov"
            ref={refs.governorate}
            name="address-level1"
            autoComplete="address-level1"
            value={governorate}
            onChange={(e) => setGovernorate(e.target.value)}
            aria-invalid={!!fieldErrors.governorate}
            className={`${field} ${fieldErrors.governorate ? bad : ok}`}
          >
            <option value="">{loc('اختر المحافظة', 'Choose a governorate', 'پارێزگا هەڵبژێرە')}</option>
            {legacyGovernorate ? (
              <option value={legacyGovernorate} disabled>
                {legacyGovernorate}
              </option>
            ) : null}
            {GOVERNORATES.map((g) => (
              <option key={g.id} value={g.id}>
                {govLabel(g)}
              </option>
            ))}
          </select>
          {fieldErrors.governorate ? <p className={errCls}>{fieldErrors.governorate}</p> : null}
        </div>
        <div>
          <label htmlFor="addr-area" className={labelCls}>
            {loc('المنطقة', 'Area', 'ناوچە')}
          </label>
          <input
            id="addr-area"
            name="address-level2"
            autoComplete="address-level2"
            value={area}
            onChange={(e) => setArea(e.target.value)}
            placeholder={loc('مثال: الكرادة', 'e.g. Karrada', 'نموونە: کەڕادە')}
            className={`${field} ${ok}`}
          />
        </div>
      </div>

      <div>
        <label htmlFor="addr-street" className={labelCls}>
          {loc('تفاصيل العنوان', 'Street and details', 'وردەکاری ناونیشان')}
          {req}
        </label>
        <textarea
          id="addr-street"
          ref={refs.address}
          name="street-address"
          autoComplete="street-address"
          rows={2}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          aria-invalid={!!fieldErrors.address}
          placeholder={loc('الحي، الشارع، رقم الدار…', 'District, street, house number…', 'گەڕەک، شەقام، ژمارەی ماڵ…')}
          className={`${field} py-2.5 resize-none ${fieldErrors.address ? bad : ok}`}
        />
        {fieldErrors.address ? <p className={errCls}>{fieldErrors.address}</p> : null}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label htmlFor="addr-landmark" className={labelCls}>
            {loc('أقرب نقطة دالة', 'Nearest landmark', 'نزیکترین نیشانە')}
          </label>
          <input
            id="addr-landmark"
            value={landmark}
            onChange={(e) => setLandmark(e.target.value)}
            placeholder={loc('اختياري', 'Optional', 'ئارەزوومەندانە')}
            className={`${field} ${ok}`}
          />
        </div>
        <div>
          <label htmlFor="addr-label" className={labelCls}>
            {loc('اسم العنوان', 'Label', 'ناونیشان')}
          </label>
          <input
            id="addr-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={loc('البيت، العمل…', 'Home, Work…', 'ماڵ، کار…')}
            className={`${field} ${ok}`}
          />
        </div>
      </div>

      <div>
        <label htmlFor="addr-notes" className={labelCls}>
          {loc('ملاحظات للمندوب', 'Notes for the courier', 'تێبینی بۆ گەیێنەر')}
        </label>
        <textarea
          id="addr-notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={loc('مثال: اتصل قبل الوصول', 'e.g. call before arriving', 'نموونە: پێش هاتن پەیوەندی بکە')}
          className={`${field} py-2.5 resize-none ${ok}`}
        />
      </div>

      {formError ? (
        <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[13px] text-red-300">
          {formError}
        </p>
      ) : null}

      <div className="flex items-center gap-2.5 pt-1">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[48px] px-5 rounded-xl border border-zinc-800 bg-zinc-900/60 text-zinc-300 font-bold text-[14px] hover:border-zinc-600 transition-colors [touch-action:manipulation]"
          >
            {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
          </button>
        ) : null}
        {/* The submit stays ENABLED until the request starts: a disabled button
            cannot tell anyone why it is disabled, and the per-field messages
            above can. */}
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="flex-1 min-h-[48px] rounded-xl bg-gold text-black font-black text-[15px] flex items-center justify-center gap-2 hover:brightness-110 disabled:opacity-45 transition-[filter,opacity] duration-150 active:scale-[0.99] [touch-action:manipulation]"
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />
          ) : editing ? (
            <Check aria-hidden="true" className="w-4 h-4" />
          ) : (
            <MapPin aria-hidden="true" className="w-4 h-4" />
          )}
          {busy
            ? loc('يُحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…')
            : editing
              ? loc('حفظ التعديلات', 'Save changes', 'پاشەکەوتی گۆڕانکاری')
              : loc('حفظ العنوان', 'Save address', 'پاشەکەوتی ناونیشان')}
        </button>
      </div>
    </div>
  );
}
