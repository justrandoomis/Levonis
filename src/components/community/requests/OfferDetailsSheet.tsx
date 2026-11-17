/**
 * EVERY FACT OF ONE OFFER (community UI plan C3): what the offer card leaves
 * out, in a sheet opened by its «التفاصيل». Each offer answers the same
 * questions in the same rows (the facts the side-by-side columns of
 * CompareSheet show too): the total and its fee, the time, the handover, the
 * quantity, the colour, the materials, the parts it covers and what it leaves
 * out, the substitutes, what is included, the warranty, the terms and until
 * when it stands; then the message, the files, «سجل التعديلات», «زيارة
 * المتجر», «مراسلة» and «اعتذر».
 *
 * A lazy chunk: the request page loads it on the first tap, so the page
 * itself does not grow (plan R6).
 */
import { useId, type ReactNode } from 'react';
import { AlertTriangle, BadgeCheck, History, MessageCircle, Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { StatusChip } from '../../ui/Badge';
import { CommunityStoreLink } from '../../../pages/community/access';
import type { CatalogMaterial, OfferHistoryEntryV2, OfferV2 } from './api';
import { Breakdown, OfferFiles } from './OfferCompare';
import { localMaterial } from './mirrors';
import { coverageOf, listSep, partName, partialLabel, readerDir, substitutionPieces, type PartRef } from './offerParts';
import { SubstitutionText } from './SubstitutionText';
import { daysLabel, fill, fillNodes, handoverLabel, jobsLabel, offerStateWords, requestLang, shortDay, useRequestStrings, type RequestLang, type RequestStrings } from './strings';

/**
 * A fact of the offer. `dir="auto"` is for what the merchant typed; a line the
 * screen writes itself (a substitution) passes the direction of the reader, so a
 * Latin material name at its start does not turn the sentence around.
 */
function Row({ k, children, dir = 'auto' }: { k: string; children: ReactNode; dir?: 'auto' | 'ltr' | 'rtl' }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="shrink-0 text-[12px] text-text-muted">{k}</dt>
      <dd className="min-w-0 break-words text-end text-[12.5px] text-text-primary" dir={dir}>
        {children}
      </dd>
    </div>
  );
}

/** The rows every offer answers, in the same order, so two offers read across. */
export function OfferFacts({ o, s, lang, materials, parts }: { o: OfferV2; s: RequestStrings; lang: RequestLang; materials: CatalogMaterial[]; parts: PartRef[] }) {
  const partial = partialLabel(o, parts.length, s);
  const { covered, uncovered } = coverageOf(o, parts);
  const subs = substitutionPieces(o, parts, s, lang, materials);
  const until = shortDay(o.valid_until ?? o.expires_at, lang);
  const sep = listSep(lang);
  const matName = (id: string) => localMaterial(id, lang, materials) || id;
  return (
    <dl className="divide-y divide-border-subtle/60" data-offer-facts={o.id}>
      <Row k={s.completion}>{o.completion_days ? daysLabel(o.completion_days, lang) : '—'}</Row>
      <Row k={s.handover}>{handoverLabel(o.delivery_method, s)}</Row>
      {o.quantity != null && <Row k={s.quantity}>{`×${o.quantity}`}</Row>}
      {o.color && <Row k={s.colour}>{o.color}</Row>}
      <Row k={s.materials}>{o.material_ids?.length ? o.material_ids.map(matName).join(sep) : o.materials || '—'}</Row>
      {parts.length > 1 && (
        <Row k={s.partsLabel} dir={readerDir(lang)}>
          <span data-offer-parts>{partial ? covered.map((p) => partName(p, s)).join(sep) : s.allParts}</span>
          {uncovered.length > 0 && (
            <span className="block text-[11.5px] text-warning" data-offer-uncovered>
              {`${s.notIncluded}: ${uncovered.map((p) => partName(p, s)).join(sep)}`}
            </span>
          )}
        </Row>
      )}
      {subs.length > 0 && (
        <Row k={s.substitutesLabel} dir={readerDir(lang)}>
          {subs.map((x) => (
            <span key={x.line} className="block" data-offer-substitution>
              <SubstitutionText x={x} s={s} dir={readerDir(lang)} />
            </span>
          ))}
        </Row>
      )}
      <Row k={s.included}>{o.included || '—'}</Row>
      <Row k={s.warranty}>{o.warranty_terms || '—'}</Row>
      {o.terms && <Row k={s.terms}>{o.terms}</Row>}
      <Row k={s.validUntil}>{until || s.openEnded}</Row>
    </dl>
  );
}

/** «كان ٥٠٬٠٠٠»: every version of one offer, newest first. The history rows carry the price; the fee travels with the offer. */
function HistoryList({ offer, s, lang }: { offer: OfferV2; s: RequestStrings; lang: RequestLang }) {
  const rows: OfferHistoryEntryV2[] = [...(offer.history ?? [])].reverse();
  return (
    <ol className="divide-y divide-border-subtle/60" data-offer-history-list>
      {rows.map((h) => (
        <li key={h.revision} className="flex items-center justify-between gap-3 py-2.5 text-[13px]" data-offer-history-row={h.revision}>
          <span className="min-w-0">
            <span className="block font-semibold text-text-primary">{fill(s.version, { n: h.revision })}</span>
            <span className="block text-[11.5px] text-text-muted">
              {[h.completion_days ? daysLabel(h.completion_days, lang) : '', handoverLabel(h.delivery_method, s), shortDay(h.created_at, lang)].filter((x) => x && x !== '—').join(' · ')}
            </span>
          </span>
          <span className={`shrink-0 font-semibold tabular-nums ${h.revision === offer.revision ? 'text-text-primary' : 'text-text-muted line-through'}`}>
            <Money iqd={h.price_iqd} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export interface OfferDetailsSheetProps {
  offer: OfferV2 | null;
  /** «سجل التعديلات» open inside the sheet. */
  showHistory?: boolean;
  materials: CatalogMaterial[];
  parts: PartRef[];
  /** The offer can still be declined (the request takes offers and it is live). */
  canAct: boolean;
  onClose: () => void;
  onChat: (o: OfferV2) => void;
  onDecline: (o: OfferV2) => void;
  onHistory: (o: OfferV2) => void;
}

export default function OfferDetailsSheet({ offer, showHistory = false, materials, parts, canAct, onClose, onChat, onDecline, onHistory }: OfferDetailsSheetProps) {
  const { lang } = useLanguage();
  const s = useRequestStrings();
  const L = requestLang(lang);
  const titleId = useId();
  const o = offer;
  const m = o?.merchant;
  const history = o?.history ?? [];
  const prev = history.length > 1 ? history[history.length - 2] : null;
  const st = o ? offerStateWords(o, s) : null;
  const partial = o ? partialLabel(o, parts.length, s) : '';
  return (
    <Sheet
      open={!!o}
      onClose={onClose}
      labelledBy={titleId}
      detents={['medium', 'large']}
      dragHandle
      panelClassName="w-full sm:max-w-md"
      testId="offer-details"
      header={
        <div className="px-5 pb-1 pt-1">
          <h2 id={titleId} className="flex items-center gap-1.5 text-[16px] font-bold text-text-primary">
            <bdi className="truncate">{showHistory ? s.history : m?.name ?? s.theMerchant}</bdi>
            {!showHistory && m?.verified && <BadgeCheck aria-label={s.verified} className="h-4 w-4 shrink-0 text-gold" />}
          </h2>
          {showHistory && m?.name && (
            <p className="mt-0.5 text-[12px] text-text-muted">
              <bdi>{m.name}</bdi>
            </p>
          )}
        </div>
      }
    >
      {o && showHistory && (
        <div className="px-5 pb-4">
          <HistoryList offer={o} s={s} lang={L} />
        </div>
      )}
      {o && !showHistory && (
        <div className="px-5 pb-4" data-offer-details-sheet={o.id}>
          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-text-muted">
            {m?.rating != null && (
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <Star aria-hidden="true" className="h-3 w-3 fill-gold text-gold" />
                {m.rating.toFixed(1)} ({m.rating_count})
              </span>
            )}
            {!!m?.completed_orders && <span>{jobsLabel(m.completed_orders, L)}</span>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {st && <StatusChip tone={st.tone}>{st.text}</StatusChip>}
            {partial && <StatusChip tone="warning">{partial}</StatusChip>}
          </div>
          <p className="mt-3 text-[22px] font-bold text-text-primary" data-offer-total={o.total_iqd ?? ''}>
            <Money iqd={o.total_iqd} />
          </p>
          <Breakdown o={o} s={s} />
          {o.revised && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px]">
              <StatusChip tone="info">{s.revised}</StatusChip>
              {prev && prev.price_iqd !== o.price_iqd && <span className="text-text-muted">{fillNodes(s.was, { price: <Money iqd={prev.price_iqd} className="line-through" /> })}</span>}
            </p>
          )}
          {history.length > 1 && (
            <button
              type="button"
              onClick={() => onHistory(o)}
              className="inline-flex min-h-11 items-center gap-1 rounded-full text-[12.5px] font-semibold text-text-secondary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              data-offer-history={o.id}
            >
              <History aria-hidden="true" className="h-3.5 w-3.5" />
              {s.history}
            </button>
          )}
          <div className="mt-2">
            <OfferFacts o={o} s={s} lang={L} materials={materials} parts={parts} />
          </div>
          {o.message && (
            <p className="mt-2 whitespace-pre-line rounded-lg bg-surface-raised px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary" dir="auto">
              {o.message}
            </p>
          )}
          <OfferFiles files={o.files ?? []} label={s.offerFiles} />
          {o.stale && o.state !== 'accepted' && (
            <p className="mt-2 flex items-start gap-2 text-[12px] leading-relaxed text-warning">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {s.staleNote}
            </p>
          )}
          {o.workshop_unable && o.state === 'pending' && (
            <p className="mt-2 flex items-start gap-2 text-[12px] leading-relaxed text-warning">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {s.unableNote}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-1">
            {(o.state === 'pending' || o.state === 'superseded') && (
              <Button variant="ghost" size="sm" onClick={() => onChat(o)} icon={<MessageCircle aria-hidden="true" className="h-4 w-4" />}>
                {s.messageMerchant}
              </Button>
            )}
            {m?.store_slug && (
              // A merchant (or store) id: the link resolves ids, and a slug here answered «no store».
              <CommunityStoreLink id={o.merchant_id} className="lv-button lv-button-ghost lv-button-sm">
                {s.viewStore}
              </CommunityStoreLink>
            )}
            {canAct && (
              <Button variant="ghost" size="sm" onClick={() => onDecline(o)} data-offer-decline={o.id}>
                {s.decline}
              </Button>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
