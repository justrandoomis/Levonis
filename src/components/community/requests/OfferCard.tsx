/**
 * ONE OFFER AS A CARD (community UI plan C3, IMG_8472, IMG_8479): what a
 * customer weighs at a glance, and the door to the rest.
 *
 *   row 1  the workshop (its logo, else its first letter), its name and the
 *          verified mark, «governorate · ★ rating (n) · jobs done», and at the
 *          end the TOTAL the customer agrees to, over «السعر الإجمالي»
 *   chips  every honesty mark of P1-05, kept: the state, «جزئي k/n», the
 *          substitutes, «عرض معدّل · كان …», and the stale and the
 *          no-longer-possible notes
 *   row 2  three cells: the expected time, the materials, the handover
 *          («يشمل التوصيل» when the fee is nothing and the workshop brings
 *          it, «+ fee توصيل» when there is a fee, «استلام من الورشة» with the
 *          governorate, never a district: plan R3)
 *   row 3  «التفاصيل» (every fact, in OfferDetailsSheet) and «مراسلة» (a live
 *          offer only)
 *
 * A CHOICE, NOT A PAYMENT (plan R8). The card is a radio of the group
 * «العروض» only when it can be chosen (the request still takes offers and
 * this offer is live); nothing is chosen until the customer chooses, and the
 * choice only arms the one gold button under the list, which opens the
 * accept sheet. The chosen card wears the gold edge and the check badge, and
 * says «محدد» in its name: never colour alone. The radio holds only words;
 * the two buttons sit beside it in the card, never inside it.
 */
import type React from 'react';
import { AlertTriangle, BadgeCheck, Check, Clock, FileText, Layers, MapPin, MessageCircle, Star, Store, Truck } from 'lucide-react';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { iqdNumber, iqdUnit } from '../../../lib/money';
import { Money } from '../../ui/Money';
import { StatusChip } from '../../ui/Badge';
import { KitButton } from '../kit/buttons';
import { KitAvatar } from '../kit/display';
import type { CatalogMaterial, OfferV2 } from './api';
import { localMaterial } from './mirrors';
import { listSep, partialLabel, substitutesSomething, type PartRef } from './offerParts';
import { daysLabel, fill, fillNodes, handoverLabel, jobsLabel, offerStateWords, type RequestLang, type RequestStrings } from './strings';

export interface OfferCardProps {
  o: OfferV2;
  s: RequestStrings;
  lang: RequestLang;
  parts: PartRef[];
  materials: CatalogMaterial[];
  /** A radio of the group: the request takes offers and this offer is live. */
  selectable: boolean;
  selected: boolean;
  /** The one radio of the group that Tab reaches. */
  tabStop?: boolean;
  onSelect?: () => void;
  onDetails: () => void;
  /** «مراسلة»: a live offer only. */
  onChat?: () => void;
  radioRef?: (el: HTMLElement | null) => void;
  onRadioKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
}

/** «42,000 د.ع» as words for the name of the radio. */
export function offerTotalWords(total: number | null, lang: RequestLang): string {
  return total == null || !Number.isFinite(total) ? '—' : `${iqdNumber(total, lang)} ${iqdUnit(lang)}`;
}

export default function OfferCard({ o, s, lang, parts, materials, selectable, selected, tabStop = false, onSelect, onDetails, onChat, radioRef, onRadioKeyDown }: OfferCardProps) {
  const m = o.merchant;
  const name = m?.name ?? s.theMerchant;
  const gov = m?.governorate ? GOVERNORATE_LABELS[m.governorate]?.[lang] ?? '' : '';
  const partial = partialLabel(o, parts.length, s);
  const st = offerStateWords(o, s);
  const history = o.history ?? [];
  const prev = history.length > 1 ? history[history.length - 2] : null;
  const live = o.state === 'pending' || o.state === 'superseded';
  const mats = o.material_ids?.length ? o.material_ids.map((id) => localMaterial(id, lang, materials) || id).join(listSep(lang)) : o.materials || '—';
  const pickup = o.delivery_method === 'pickup';
  const fee = Number(o.delivery_fee_iqd ?? 0);
  const sr = fill(s.offerSr, { name, total: offerTotalWords(o.total_iqd, lang), state: selected ? s.offerChosen : s.offerNotChosen });
  const icon = 'h-5 w-5 shrink-0 text-text-secondary';

  const body = (
    <>
      {selectable && (
        // The badge the scope sheet shows on a chosen radio (`[aria-checked='true'] > .cm-check`), at the end corner.
        <span aria-hidden="true" className="cm-check absolute size-6 items-center justify-center rounded-full" style={{ insetInlineStart: 'auto', insetInlineEnd: 0, insetBlockStart: 0 }}>
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
      )}
      <div className="flex items-start gap-3">
        <KitAvatar src={m?.logo_url ?? null} name={name} size={48} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[17px] font-bold leading-snug text-text-primary">
            <bdi className="truncate">{name}</bdi>
            {m?.verified && <BadgeCheck aria-label={s.verified} className="h-4 w-4 shrink-0 text-gold" />}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-text-secondary">
            {gov && (
              <span className="inline-flex items-center gap-1" data-offer-gov>
                <MapPin aria-hidden="true" className="h-3.5 w-3.5" />
                {gov}
              </span>
            )}
            {m?.rating != null && (
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <Star aria-hidden="true" className="h-3 w-3 fill-gold text-gold" />
                {m.rating.toFixed(1)} ({m.rating_count})
              </span>
            )}
            {!!m?.completed_orders && <span>{jobsLabel(m.completed_orders, lang)}</span>}
          </p>
        </div>
        <div className="shrink-0 pe-6 text-end">
          <p className="text-[20px] font-bold leading-tight text-text-primary" data-offer-total={o.total_iqd ?? ''}>
            <Money iqd={o.total_iqd} />
          </p>
          <p className="text-[12px] text-text-muted">{s.totalPrice}</p>
        </div>
      </div>

      {/* The honesty marks of P1-05: never dropped for the look. */}
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]" data-offer-chips>
        <StatusChip tone={st.tone}>{st.text}</StatusChip>
        {partial && (
          <span data-offer-partial-chip>
            <StatusChip tone="warning">{partial}</StatusChip>
          </span>
        )}
        {substitutesSomething(o) && (
          <span data-offer-substitution-chip>
            <StatusChip tone="warning">{s.substitutesLabel}</StatusChip>
          </span>
        )}
        {o.revised && (
          <span className="inline-flex flex-wrap items-center gap-1.5" data-offer-edited>
            <StatusChip tone="info">{s.revised}</StatusChip>
            {prev && prev.price_iqd !== o.price_iqd && (
              <span className="text-text-muted" data-offer-was>
                {fillNodes(s.was, { price: <Money iqd={prev.price_iqd} className="line-through" /> })}
              </span>
            )}
          </span>
        )}
      </p>
      {o.stale && o.state !== 'accepted' && (
        <p className="mt-2 flex items-start gap-2 text-[12px] leading-relaxed text-warning" data-offer-note="stale">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {s.staleNote}
        </p>
      )}
      {o.workshop_unable && o.state === 'pending' && (
        <p className="mt-2 flex items-start gap-2 text-[12px] leading-relaxed text-warning" data-offer-unable>
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {s.unableNote}
        </p>
      )}

      {/* The three cells (IMG_8472): the time, the materials, the handover. */}
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border-subtle pt-3" data-offer-stats>
        <div className="flex min-w-0 items-start gap-1.5">
          <Clock aria-hidden="true" className={icon} />
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold leading-snug text-text-primary" data-offer-days={o.completion_days ?? ''}>
              {o.completion_days ? daysLabel(o.completion_days, lang) : '—'}
            </span>
            <span className="block text-[12px] leading-snug text-text-muted">{s.expectedTime}</span>
          </span>
        </div>
        <div className="flex min-w-0 items-start gap-1.5 border-s border-border-subtle ps-2">
          <Layers aria-hidden="true" className={icon} />
          <span className="min-w-0">
            <span className="block break-words text-[14px] font-semibold leading-snug text-text-primary">
              <bdi>{mats}</bdi>
            </span>
            <span className="block text-[12px] leading-snug text-text-muted">{s.materials}</span>
          </span>
        </div>
        <div className="flex min-w-0 items-start gap-1.5 border-s border-border-subtle ps-2" data-offer-handover={o.delivery_method}>
          {pickup ? <Store aria-hidden="true" className={icon} /> : <Truck aria-hidden="true" className={icon} />}
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold leading-snug text-text-primary">
              {pickup ? s.handoverPickup : fee > 0 ? fillNodes(s.plusDelivery, { fee: <Money iqd={fee} /> }) : s.deliveryIncluded}
            </span>
            <span className="block text-[12px] leading-snug text-text-muted">{pickup ? gov || s.handover : gov ? fill(s.withinGov, { gov }) : handoverLabel(o.delivery_method, s)}</span>
          </span>
        </div>
      </div>
    </>
  );

  return (
    <article
      className={`cm-card rounded-xl border-2 p-3 shadow-sm ${selected ? 'border-gold' : 'border-transparent'}`}
      data-offer={o.id}
      data-offer-state={o.state}
      data-offer-stale={o.stale ? 'true' : undefined}
      data-offer-revised={o.revised ? 'true' : undefined}
      data-offer-partial={partial ? 'true' : undefined}
      data-offer-selected={selected ? 'true' : undefined}
      aria-label={selectable ? undefined : name}
    >
      {selectable ? (
        <div
          ref={radioRef}
          role="radio"
          aria-checked={selected}
          aria-label={sr}
          tabIndex={tabStop ? 0 : -1}
          onClick={onSelect}
          onKeyDown={onRadioKeyDown}
          data-offer-accept={o.id}
          className="relative cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {body}
        </div>
      ) : (
        <div className="relative">{body}</div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <KitButton size="sm" icon={<FileText aria-hidden="true" className="h-4 w-4" />} onClick={onDetails} data-offer-details={o.id}>
          {s.offerDetails}
        </KitButton>
        {live && onChat && (
          <KitButton size="sm" icon={<MessageCircle aria-hidden="true" className="h-4 w-4" />} onClick={onChat} data-offer-chat={o.id}>
            {s.messageMerchant}
          </KitButton>
        )}
      </div>
    </article>
  );
}
