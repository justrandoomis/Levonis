/**
 * THE MERCHANT'S OFFER, V2 (docs/COMMUNITY_ECOSYSTEM.md §9.5, Client 5c) —
 * the sheet that composes it and the card on the request page that opens it.
 *
 * What a customer agrees to is the TOTAL: the price plus the delivery fee,
 * computed on the server (`total_iqd`) and previewed here only so the
 * merchant sees what the customer will see. Beside them the offer says how
 * long, how it is handed over, how many, in what (catalogue ids) and what
 * colour, what is included, the warranty, the terms and how long it stands —
 * and carries up to six private files (upload purpose `offer`, keys handed
 * back to this merchant only, re-checked as theirs on every save).
 *
 * TWO EXITS. «احفظ مسودة» keeps the offer where the customer cannot see it
 * (community_offer_drafts; the card says so and offers «أرسل العرض»);
 * «أرسل العرض» makes it live through the eligibility-fenced INSERT. An edit
 * of a sent offer is a new revision the customer sees as «عرض معدّل», the
 * old price in its history. Nothing here computes a figure the server will
 * believe: every body goes through `readOfferTerms` / `readOfferExtras`.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Box, FileText, Image as ImageIcon, Paperclip, Send, Trash2 } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { UploadTile } from '../../upload/UploadTile';
import { formatBytes } from '../../media/RequestAttachments';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Field, Input, Textarea, focusFirstInvalid } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Segmented } from '../../ui/Segmented';
import { Money } from '../../ui/Money';
import { StatusChip } from '../../ui/Badge';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { offersApi } from '../offers/types';
import type { OfferPrefill } from '../../merchant/workshop/api';
import { offersV2Api, requestsApi, type CatalogMaterial, type OfferDeliveryMethod, type OfferFileKind, type OfferInputV2, type OfferV2 } from './api';
import { composerHandover, daysLabel, fill, handoverLabel, offerStateWords, requestLang, shortDay, useRequestStrings, type RequestLang, type RequestStrings } from './strings';

/** How long an offer stands, in days (the server takes 1–60). */
export const VALIDITY = [3, 7, 14, 30] as const;
/** The most files one offer carries (worker/routes/marketplace.ts OFFER_FILES_MAX). */
export const OFFER_FILES_MAX = 6;
/** The most catalogue materials one offer names (worker/lib/requestRevisions.ts OFFER_MAX_MATERIALS). */
export const OFFER_MATERIALS_MAX = 5;
export const OFFER_FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.stl,.3mf,.obj';
const HANDOVERS: OfferDeliveryMethod[] = ['merchant_delivery', 'courier', 'pickup'];

/** A file the composer holds: one already on the offer (with its key) or one just uploaded. */
export interface ComposerFile {
  key: string;
  name: string;
  bytes: number;
  kind: OfferFileKind;
  content_type: string;
}

/** What a picked file is to the offer — the worker refuses anything else (UPLOAD_KIND_NOT_ALLOWED). */
export function offerFileKind(name: string, mime: string): OfferFileKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (['stl', '3mf', 'obj'].includes(ext)) return 'model';
  return null;
}

/** The total the customer will see: price plus the fee, none for a pickup. A PREVIEW — the server computes the real one. */
export function previewTotal(price: number | null, fee: number | null, delivery: string): number {
  return Math.max(0, price ?? 0) + (delivery === 'pickup' ? 0 : Math.max(0, fee ?? 0));
}

/** The handover a new offer starts on: what the customer asked for, else the merchant brings it. */
export function defaultHandover(deliveryPref: string | null | undefined): OfferDeliveryMethod {
  return deliveryPref === 'pickup' ? 'pickup' : 'merchant_delivery';
}

/** The state the composer edits, as one comparable value (the sheet asks before throwing it away). */
interface Terms {
  price: number | null;
  fee: number | null;
  days: number | null;
  delivery: OfferDeliveryMethod;
  quantity: number | null;
  picked: string[];
  color: string;
  message: string;
  included: string;
  warranty: string;
  terms: string;
  valid: number;
  files: ComposerFile[];
}

/** An offer (or the draft) as the composer's starting terms. */
export function termsFrom(offer: OfferV2 | null | undefined, prefill: OfferPrefill | null, opts: { quantity?: number; delivery?: OfferDeliveryMethod }): Terms {
  const method = (HANDOVERS as string[]).includes(offer?.delivery_method ?? '') ? (offer!.delivery_method as OfferDeliveryMethod) : opts.delivery ?? 'merchant_delivery';
  return {
    price: prefill?.price_iqd ?? offer?.price_iqd ?? null,
    fee: offer && offer.delivery_fee_iqd > 0 ? offer.delivery_fee_iqd : null,
    days: offer?.completion_days || null,
    delivery: method,
    quantity: offer?.quantity ?? opts.quantity ?? null,
    picked: offer?.material_ids ?? [],
    color: offer?.color ?? '',
    message: offer?.message ?? '',
    included: offer?.included ?? '',
    warranty: offer?.warranty_terms ?? '',
    terms: offer?.terms ?? '',
    valid: offer?.valid_days && (VALIDITY as readonly number[]).includes(offer.valid_days) ? offer.valid_days : 7,
    // Only the uploader gets keys back, so a file without one cannot be kept on an edit.
    files: (offer?.files ?? [])
      .filter((f): f is typeof f & { key: string } => typeof f.key === 'string' && f.key.length > 0)
      .map((f) => ({ key: f.key, name: f.name, bytes: f.bytes, kind: f.kind, content_type: f.content_type })),
  };
}

/**
 * The body a save sends. The validity is sent for a new offer and a draft;
 * on an edit of a SENT offer only when the merchant touched it — the stored
 * validity is not the composer's default, and silently moving it would
 * change the promise.
 */
export function offerBody(t: Terms, opts: { draft: boolean; editingSent: boolean; validTouched: boolean; quoteId?: string | null }): OfferInputV2 {
  const b: OfferInputV2 = {
    delivery_fee_iqd: t.delivery === 'pickup' ? 0 : Math.max(0, t.fee ?? 0),
    delivery_method: t.delivery,
    quantity: t.quantity ?? null,
    material_ids: t.picked.slice(0, OFFER_MATERIALS_MAX),
    color: t.color.trim(),
    message: t.message.trim(),
    included: t.included.trim(),
    warranty_terms: t.warranty.trim(),
    terms: t.terms.trim(),
    files: t.files.map((f) => ({ key: f.key })),
  };
  if (!opts.editingSent || opts.validTouched) b.valid_days = t.valid;
  if (t.price !== null && t.price >= 1) b.price_iqd = t.price;
  if (t.days !== null && t.days >= 1) b.completion_days = t.days;
  if (opts.quoteId && !opts.editingSent) b.quote_id = opts.quoteId;
  if (opts.draft) b.draft = true;
  return b;
}

export interface OfferComposerProps {
  open: boolean;
  requestId: string;
  /** A sent offer to edit (a new revision) or the merchant's saved draft (`offer.draft`). */
  offer?: OfferV2 | null;
  /** The catalogue the job can be made in. */
  materials: CatalogMaterial[];
  /** The request's own quantity — the composer's default. */
  defaultQuantity?: number;
  /** The request's `delivery_pref` — a pickup request starts on pickup. */
  deliveryPref?: string;
  /** «استخدم هذا كعرضي» (W5-B): a private costing's price and quote id; nothing is sent until the merchant sends it. */
  prefill?: OfferPrefill | null;
  onClose: () => void;
  onSaved: (offer: OfferV2, how: 'sent' | 'updated' | 'draft') => void;
}

export default function OfferComposer({ open, requestId, offer, materials, defaultQuantity, deliveryPref, prefill = null, onClose, onSaved }: OfferComposerProps) {
  const { lang } = useLanguage();
  const s = useRequestStrings();
  const L = requestLang(lang);
  const titleId = useId();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const isDraft = !!offer?.draft;
  const editingSent = !!offer && !offer.draft;

  const [t, setT] = useState<Terms>(() => termsFrom(offer, prefill, { quantity: defaultQuantity, delivery: defaultHandover(deliveryPref) }));
  const initial = useRef('');
  const [validTouched, setValidTouched] = useState(false);
  const [pending, setPending] = useState<Array<{ id: string; file: File }>>([]);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState<{ price?: string; days?: string }>({});
  const [busy, setBusy] = useState<'' | 'send' | 'draft'>('');

  useEffect(() => {
    if (!open) return;
    const start = termsFrom(offer, prefill, { quantity: defaultQuantity, delivery: defaultHandover(deliveryPref) });
    setT(start);
    initial.current = JSON.stringify(start);
    setValidTouched(false);
    setError('');
    setInvalid({});
    setBusy('');
    setPending([]);
  }, [open, offer, prefill, defaultQuantity, deliveryPref]);

  const set = <K extends keyof Terms>(k: K, v: Terms[K]) => setT((x) => ({ ...x, [k]: v }));
  // No price, no total: «—», never «0 IQD» as if the customer would pay nothing.
  const total = t.price && t.price >= 1 ? previewTotal(t.price, t.fee, t.delivery) : null;
  const fileCount = t.files.length + pending.length;
  const dirty = pending.length > 0 || (initial.current !== '' && JSON.stringify(t) !== initial.current);

  function pickFiles(list: FileList | null) {
    if (!list?.length) return;
    setError('');
    const room = OFFER_FILES_MAX - fileCount;
    if (room <= 0) {
      setError(s.fileTooMany);
      return;
    }
    const chosen = Array.from(list).slice(0, room);
    if (chosen.some((f) => !offerFileKind(f.name, f.type))) {
      setError(s.fileKindBad);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setPending((p) => [...p, ...chosen.map((file) => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file }))]);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function submit(how: 'send' | 'draft') {
    if (busy || pending.length) return; // «أرسل» waits for the uploads; the tiles say so.
    if (how === 'send') {
      const bad: typeof invalid = {};
      if (!t.price || t.price < 1) bad.price = s.priceRequired;
      if (!t.days || t.days < 1) bad.days = s.daysRequired;
      setInvalid(bad);
      if (Object.keys(bad).length) {
        // The refused field may be far above the footer's button (review 2026-09-30):
        // focus it — which scrolls it into view — so the refusal is seen and heard.
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        return;
      }
    }
    setError('');
    setBusy(how);
    const quoteId = prefill?.quote_id ?? null;
    try {
      let saved: OfferV2;
      let kind: 'sent' | 'updated' | 'draft';
      if (how === 'draft') {
        const b = offerBody(t, { draft: true, editingSent: false, validTouched, quoteId });
        saved = isDraft ? (await offersV2Api.updateOffer(offer!.id, b)).offer : (await offersV2Api.createOffer(requestId, b)).offer;
        kind = 'draft';
      } else if (isDraft) {
        // The draft's terms as they are on screen, then the send — one promise, validated whole by the server.
        await offersV2Api.updateOffer(offer!.id, offerBody(t, { draft: false, editingSent: false, validTouched, quoteId }));
        saved = (await offersV2Api.sendOffer(offer!.id)).offer;
        kind = 'sent';
      } else if (editingSent) {
        saved = (await offersV2Api.updateOffer(offer!.id, offerBody(t, { draft: false, editingSent: true, validTouched, quoteId }))).offer;
        kind = 'updated';
      } else {
        saved = (await offersV2Api.createOffer(requestId, offerBody(t, { draft: false, editingSent: false, validTouched, quoteId }))).offer;
        kind = 'sent';
      }
      onSaved(saved, kind);
    } catch (e) {
      setError(e instanceof ApiError ? apiRefusal(e, L, how === 'draft' ? s.couldNotSave : s.couldNotSend) : how === 'draft' ? s.couldNotSave : s.couldNotSend);
    } finally {
      setBusy('');
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      dirty={dirty}
      panelClassName="w-full sm:max-w-lg"
      testId="offer-composer"
      header={
        <div className="px-5 pb-2 pt-1 sm:pt-5">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">
            {editingSent ? s.editTitle : isDraft ? s.draftComposeTitle : s.composeTitle}
          </h2>
          {editingSent && <p className="mt-0.5 text-[12px] text-text-muted">{s.editHint}</p>}
          {isDraft && <p className="mt-0.5 text-[12px] text-text-muted">{s.draftHint}</p>}
        </div>
      }
      footer={
        // The Sheet's footer pads itself (px-4 pt-3); px-1 lines this up with the body's px-5.
        <div className="px-1">
          <div className="mb-2 flex items-center justify-between gap-3 text-[13px]" data-offer-total-preview={total ?? ''}>
            <span className="text-text-muted">{s.totalLine}</span>
            <span className="text-[16px] font-bold text-text-primary">
              <Money iqd={total} />
            </span>
          </div>
          {error && (
            <p className="lv-field-error mb-2" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            {!editingSent && (
              <Button
                variant="secondary"
                block
                onClick={() => submit('draft')}
                loading={busy === 'draft'}
                disabled={busy === 'send' || pending.length > 0}
                loadingLabel={s.saving}
                data-offer-save-draft
              >
                {s.saveDraft}
              </Button>
            )}
            <Button
              variant="primary"
              block
              onClick={() => submit('send')}
              loading={busy === 'send'}
              disabled={busy === 'draft' || pending.length > 0}
              loadingLabel={s.sending}
              data-offer-send
            >
              {editingSent ? s.saveNewVersion : s.sendOffer}
            </Button>
          </div>
        </div>
      }
    >
      <div ref={formRef} className="space-y-4 px-5 pb-4 pt-1" data-offer-composer={editingSent ? 'edit' : isDraft ? 'draft' : 'new'}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={s.price} required error={invalid.price}>
            <NumberInput kind="money" value={t.price} onValueChange={(v) => set('price', v)} data-offer-price />
          </Field>
          <Field label={s.completion} required error={invalid.days}>
            <NumberInput min={1} max={365} decimals={0} unit={s.daysUnit} value={t.days} onValueChange={(v) => set('days', v)} data-offer-days />
          </Field>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold text-text-secondary">{s.handover}</p>
          <Segmented
            group="offer-delivery"
            size="sm"
            label={s.handover}
            value={t.delivery}
            onChange={(id) => set('delivery', id as OfferDeliveryMethod)}
            dataAttr="data-offer-delivery"
            items={HANDOVERS.map((id) => ({ id, label: composerHandover(id, s) }))}
          />
        </div>
        {t.delivery !== 'pickup' && (
          <Field label={s.feeLabel} optional hint={s.feeHint}>
            <NumberInput kind="money" value={t.fee} onValueChange={(v) => set('fee', v)} data-offer-fee />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={s.quantityLabel} optional hint={s.quantityHint}>
            <NumberInput kind="quantity" min={1} max={100000} value={t.quantity} onValueChange={(v) => set('quantity', v)} data-offer-quantity />
          </Field>
          <Field label={s.colourLabel} optional>
            <Input value={t.color} maxLength={40} placeholder={s.colourPh} onChange={(e) => set('color', e.target.value)} dir="auto" data-offer-color />
          </Field>
        </div>
        {materials.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold text-text-secondary">
              {s.materials} <span className="font-normal text-text-muted">{s.upToFive}</span>
            </legend>
            <div className="flex flex-wrap gap-2">
              {materials.map((m) => {
                const on = t.picked.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={on}
                    disabled={!on && t.picked.length >= OFFER_MATERIALS_MAX}
                    onClick={() => set('picked', on ? t.picked.filter((x) => x !== m.id) : [...t.picked, m.id])}
                    className="lv-choice px-3 text-[12.5px] font-medium disabled:opacity-40"
                    data-offer-material={m.id}
                  >
                    <bdi>{L === 'en' ? m.name_en : m.name_ar || m.name_en}</bdi>
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
        <Field label={s.notesLabel} optional>
          <Textarea value={t.message} rows={3} maxLength={2000} onChange={(e) => set('message', e.target.value)} dir="auto" data-offer-message />
        </Field>
        <Field label={s.includedLabel} optional hint={s.includedHint}>
          <Input value={t.included} maxLength={500} onChange={(e) => set('included', e.target.value)} dir="auto" data-offer-included />
        </Field>
        <Field label={s.warrantyLabel} optional hint={s.warrantyHint}>
          <Input value={t.warranty} maxLength={500} onChange={(e) => set('warranty', e.target.value)} dir="auto" data-offer-warranty />
        </Field>
        <Field label={s.termsLabel} optional hint={s.termsHint}>
          <Textarea value={t.terms} rows={2} maxLength={500} onChange={(e) => set('terms', e.target.value)} dir="auto" data-offer-terms />
        </Field>
        <div>
          <p className="mb-2 text-[13px] font-semibold text-text-secondary">{s.validityLabel}</p>
          <Segmented
            group="offer-validity"
            size="sm"
            label={s.validityLabel}
            value={String(t.valid)}
            onChange={(id) => {
              set('valid', Number(id));
              setValidTouched(true);
            }}
            dataAttr="data-offer-validity"
            items={VALIDITY.map((d) => ({ id: String(d), label: daysLabel(d, L) }))}
          />
          {editingSent && !validTouched && offer?.valid_until && (
            <p className="mt-1.5 text-[12px] text-text-muted">
              {s.validUntil} {shortDay(offer.valid_until, L)}
            </p>
          )}
        </div>

        {/* The files (§9.4 platform, purpose `offer`): a picture, a PDF or a
            model, each a session upload whose key comes back to this merchant
            only. «أرسل» waits until every tile is done or given up. */}
        <div data-offer-files>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[13px] font-semibold text-text-secondary">
              {s.filesLabel}{' '}
              <span className="font-normal text-text-muted" dir="ltr">
                {fileCount}/{OFFER_FILES_MAX}
              </span>
            </p>
            <input ref={fileInput} type="file" accept={OFFER_FILE_ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => pickFiles(e.target.files)} data-offer-file-input />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={fileCount >= OFFER_FILES_MAX}
              onClick={() => fileInput.current?.click()}
              icon={<Paperclip aria-hidden="true" className="h-4 w-4" />}
              data-offer-add-file
            >
              {s.addFile}
            </Button>
          </div>
          <p className="mb-2 text-[12px] leading-relaxed text-text-muted">{s.filesHint}</p>
          {fileCount > 0 && (
            <ul className="space-y-2">
              {t.files.map((f) => (
                <li key={f.key} className="flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface p-3" data-offer-file={f.kind}>
                  <FileGlyph kind={f.kind} />
                  <span className="min-w-0 flex-1">
                    <bdi className="block truncate text-[13px] font-medium text-text-primary">{f.name}</bdi>
                    <span className="block text-[11.5px] tabular-nums text-text-muted" dir="ltr">
                      {formatBytes(f.bytes)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => set('files', t.files.filter((x) => x.key !== f.key))}
                    aria-label={fill(s.removeFile, { name: f.name })}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    data-offer-file-remove
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {pending.map((p) => (
                <li key={p.id} data-offer-upload-tile>
                  <UploadTile
                    file={p.file}
                    purpose="offer"
                    entityId={requestId}
                    onDone={(r) => {
                      setPending((list) => list.filter((x) => x.id !== p.id));
                      const kind = offerFileKind(p.file.name, r.mime || p.file.type);
                      if (!r.key || !kind) {
                        setError(s.fileKindBad);
                        return;
                      }
                      const key = r.key;
                      setT((x) => (x.files.some((f) => f.key === key) ? x : { ...x, files: [...x.files, { key, name: p.file.name, bytes: r.bytes, kind, content_type: r.mime }] }));
                    }}
                    onCancel={() => setPending((list) => list.filter((x) => x.id !== p.id))}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-[12px] leading-relaxed text-text-muted">{s.fixedNote}</p>
      </div>
    </Sheet>
  );
}

export function FileGlyph({ kind }: { kind: OfferFileKind }) {
  const Icon = kind === 'image' ? ImageIcon : kind === 'pdf' ? FileText : Box;
  return (
    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-text-secondary">
      <Icon className="h-4 w-4" strokeWidth={1.6} />
    </span>
  );
}

// ---------------------------------------------------------------------------
//  THE MERCHANT'S SIDE OF ONE REQUEST: their own offer — or the draft, or the
//  button to make one — and what they can do with it.
//
//    draft       the saved terms the customer cannot see: send · continue
//    pending     edit (a new version the customer sees) · withdraw
//    superseded  the customer changed the job: WHAT changed, then
//                re-confirm as is · edit · withdraw
//    accepted    said plainly; the page's accepted / delivery sections carry
//                the order and the contact
//    expired / rejected / withdrawn   said; a new offer while the request
//                takes offers
//
//  A merchant only ever sees their own offers; the server filters
//  competitors' prices in SQL.
// ---------------------------------------------------------------------------

export interface MerchantOfferSectionProps {
  requestId: string;
  /** This merchant's offers on the request (the server sends only theirs). */
  offers: OfferV2[];
  /** The merchant's own saved draft on this request, if any. */
  draft: OfferV2 | null;
  /** The account may make offers (plan, store and merchant state). */
  canOffer: boolean;
  takingOffers: boolean;
  materials: CatalogMaterial[];
  defaultQuantity?: number;
  deliveryPref?: string;
  onChanged: () => void;
  prefill?: OfferPrefill | null;
  onPrefillDone?: () => void;
}

export function MerchantOfferSection({
  requestId,
  offers,
  draft,
  canOffer,
  takingOffers,
  materials,
  defaultQuantity,
  deliveryPref,
  onChanged,
  prefill = null,
  onPrefillDone,
}: MerchantOfferSectionProps) {
  const { lang } = useLanguage();
  const s = useRequestStrings();
  const L = requestLang(lang);
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [composing, setComposing] = useState<'' | 'new' | 'edit' | 'draft'>('');
  const [changes, setChanges] = useState<string[] | null>(null);
  const live = offers.find((o) => o.state === 'pending' || o.state === 'superseded' || o.state === 'accepted') ?? null;
  const latest = live ?? offers[offers.length - 1] ?? null;
  const stale = !!live && live.state !== 'accepted' && (live.state === 'superseded' || live.stale);

  // A costing handed over as «my offer»: a new offer, a new version of the standing one, or the draft.
  useEffect(() => {
    if (!prefill || !takingOffers) return;
    if (live && (live.state === 'pending' || live.state === 'superseded')) setComposing('edit');
    else if (!live && draft) setComposing('draft');
    else if (!live && canOffer) setComposing('new');
  }, [prefill, takingOffers, canOffer, live, draft]);

  // WHAT CHANGED since the revision this offer priced, in words, not field names.
  useEffect(() => {
    if (!stale) return;
    let alive = true;
    requestsApi
      .revisions(requestId)
      .then((d) => {
        if (!alive) return;
        const since = d.revisions.filter((r) => r.revision > (live?.request_revision ?? 0)).flatMap((r) => r.changes);
        const words = s.changes as Record<string, string>;
        setChanges([...new Set(since.map((k) => words[k] ?? k))]);
      })
      .catch(() => alive && setChanges([]));
    return () => {
      alive = false;
    };
  }, [stale, requestId, live?.request_revision, s]);

  const fail = (e: unknown, fb: string) => toast.error(e instanceof ApiError ? apiRefusal(e, L, fb) : fb);

  async function withdraw() {
    if (!live) return;
    const ok = await confirm({ title: s.withdrawQ, consequence: s.withdrawBody, confirmLabel: s.withdrawLabel, destructive: true });
    if (!ok) return;
    try {
      await offersApi.withdraw(live.id);
      onChanged();
    } catch (e) {
      fail(e, s.couldNotWithdraw);
    }
  }

  async function reconfirm() {
    if (!live) return;
    try {
      await offersApi.reconfirm(live.id);
      toast.success(s.reconfirmed);
      onChanged();
    } catch (e) {
      fail(e, s.couldNotReconfirm);
    }
  }

  async function sendDraft() {
    if (!draft) return;
    // A draft without its two required figures is finished in the composer.
    if (!draft.price_iqd || !draft.completion_days) {
      setComposing('draft');
      return;
    }
    try {
      await offersV2Api.sendOffer(draft.id);
      toast.success(s.offerSent);
      onChanged();
    } catch (e) {
      fail(e, s.couldNotSend);
    }
  }

  const composer = (
    <OfferComposer
      open={!!composing}
      requestId={requestId}
      offer={composing === 'edit' ? live : composing === 'draft' ? draft : null}
      materials={materials}
      defaultQuantity={defaultQuantity}
      deliveryPref={deliveryPref}
      prefill={prefill}
      onClose={() => {
        setComposing('');
        onPrefillDone?.();
      }}
      onSaved={(_o, how) => {
        setComposing('');
        onPrefillDone?.();
        toast.success(how === 'draft' ? s.draftKept : how === 'updated' ? s.offerUpdated : s.offerSent);
        onChanged();
      }}
    />
  );

  if (!live && draft) {
    return (
      <div className="lv-surface p-4" data-merchant-offer="draft" data-offer={draft.id}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] text-text-muted">{s.yourDraft}</p>
            <p className="mt-0.5 text-[20px] font-bold text-text-primary" data-offer-total={draft.total_iqd ?? ''}>
              <Money iqd={draft.total_iqd} />
            </p>
          </div>
          <StatusChip tone="neutral">{s.draftSaved}</StatusChip>
        </div>
        <OfferBrief o={draft} s={s} lang={L} />
        <p className="mt-2 text-[12.5px] text-text-muted">{s.draftHint}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {takingOffers && canOffer && (
            <Button variant="primary" size="sm" onClick={sendDraft} loadingLabel={s.sending} icon={<Send aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />} data-offer-draft-send>
              {s.sendDraft}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setComposing('draft')} data-offer-draft-continue>
            {s.continueDraft}
          </Button>
        </div>
        {composer}
        {confirmDialog}
      </div>
    );
  }

  if (!latest || (!live && takingOffers && canOffer)) {
    return (
      <div data-merchant-offer="none">
        {latest && (
          <p className="mb-2 text-[12.5px] text-text-muted">
            {s.previousOffer} {offerStateWords(latest, s).text}
          </p>
        )}
        {takingOffers && canOffer ? (
          <Button variant="primary" block onClick={() => setComposing('new')} icon={<Send aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />} data-offer-make>
            {s.makeOffer}
          </Button>
        ) : (
          !latest && <p className="text-[12.5px] text-text-muted">{s.cannotOfferNow}</p>
        )}
        {composer}
        {confirmDialog}
      </div>
    );
  }

  const o = latest;
  const st = offerStateWords(o, s);
  return (
    <div className="lv-surface p-4" data-merchant-offer={o.state} data-offer={o.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] text-text-muted">{fill(s.yourOfferVersion, { n: o.revision })}</p>
          <p className="mt-0.5 text-[20px] font-bold text-text-primary" data-offer-total={o.total_iqd ?? ''}>
            <Money iqd={o.total_iqd} />
          </p>
        </div>
        <StatusChip tone={st.tone}>{st.text}</StatusChip>
      </div>
      <OfferBrief o={o} s={s} lang={L} />

      {stale && (
        <div className="lv-alert lv-alert-warning mt-3 text-[12.5px] leading-relaxed" data-offer-note="superseded">
          <p className="flex items-start gap-2 font-semibold text-text-primary">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            {s.staleMerchantNote}
          </p>
          {changes && changes.length > 0 && (
            <p className="mt-1 ps-6 text-text-secondary">
              {s.whatChanged}
              {changes.join(L === 'en' ? ', ' : '، ')}
            </p>
          )}
        </div>
      )}

      {o.state === 'accepted' ? (
        <p className="mt-3 text-[13px] text-success" data-offer-accepted-note>
          {s.acceptedByCustomer}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {stale && takingOffers && (
            <Button variant="primary" size="sm" onClick={reconfirm} data-offer-reconfirm={o.id}>
              {s.reconfirm}
            </Button>
          )}
          {(o.state === 'pending' || o.state === 'superseded') && takingOffers && (
            <Button size="sm" variant={stale ? 'secondary' : 'primary'} onClick={() => setComposing('edit')} data-offer-edit={o.id}>
              {s.editOffer}
            </Button>
          )}
          {(o.state === 'pending' || o.state === 'superseded') && (
            <Button size="sm" variant="ghost" onClick={withdraw} data-offer-withdraw={o.id}>
              {s.withdraw}
            </Button>
          )}
        </div>
      )}
      {composer}
      {confirmDialog}
    </div>
  );
}

/** «السعر + التوصيل · 3 أيام · أوصله · صالح حتى ٣ أكتوبر» under a merchant's own card. */
export function OfferBrief({ o, s, lang }: { o: OfferV2; s: RequestStrings; lang: RequestLang }) {
  const parts = useMemo(() => {
    const out: string[] = [];
    if (o.completion_days) out.push(daysLabel(o.completion_days, lang));
    if (o.delivery_method) out.push(handoverLabel(o.delivery_method, s));
    const until = shortDay(o.valid_until ?? o.expires_at, lang);
    if (until) out.push(`${s.validUntil} ${until}`);
    return out;
  }, [o.completion_days, o.delivery_method, o.valid_until, o.expires_at, s, lang]);
  return (
    <p className="mt-1 text-[12.5px] text-text-secondary" data-offer-brief>
      {o.delivery_fee_iqd > 0 && o.price_iqd !== null && (
        <span className="me-2 text-text-muted" data-offer-breakdown>
          <Money iqd={o.price_iqd} /> + <Money iqd={o.delivery_fee_iqd} /> {s.feeShort}
        </span>
      )}
      {parts.join(' · ')}
    </p>
  );
}
