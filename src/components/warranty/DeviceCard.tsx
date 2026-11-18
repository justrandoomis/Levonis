import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wrench, LifeBuoy, Receipt, Printer, Package, MoreHorizontal, Unlink, ArrowLeftRight, Repeat, ExternalLink, ShieldPlus, Cog, Gift, BadgePercent, MessageSquare,
} from 'lucide-react';
import type { Language } from '../../translations';
import SafeImage from '../ui/SafeImage';
import { Anchored } from '../ui/Overlay';
import { IconButton } from '../ui/Button';
import { StatusChip } from '../ui/Badge';
import { CoverTimeline } from './CoverTimeline';
import { CarePanel } from './CarePanel';
import { ClaimRow } from './ClaimCard';
import type { CarePerks, Claim, Device } from './types';
import { claimOpen, productName, fmtCount, fmtInt, fmtDate } from './types';
import type { WarrantyStrings } from './strings';
import { CARE_STRINGS } from './strings';
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FOCUS, LINK_QUIET } from './ui';

/**
 * ONE PRINTER, AS A COVER CARD. Top to bottom it answers the customer's
 * questions in the order they have them:
 *
 *   which printer            — picture, name, serial, order;
 *   is it covered, until when — the cover in words and as one line: the
 *                               warranty, then Levo Care after it;
 *   what does Care give me   — a discount on parts, what is left of it;
 *   what is happening now    — an offer waiting, the requests open on it;
 *   what can I do            — «افتح طلب ضمان» and, with Care in force,
 *                               «اطلب خصم ليفو كير»;
 *   the rest                 — support, parts, order, receipt.
 *
 * Destructive «إزالة من حسابي» lives behind the overflow menu, one deliberate
 * step away, and the page confirms it in a sheet before anything is sent.
 */

export type ClaimKind = 'warranty' | 'care';

function Badge({ icon: Icon, tone = 'zinc', children }: { icon: React.ElementType; tone?: 'zinc' | 'gold'; children: React.ReactNode }) {
  return (
    // Information is flat clay: the house status chip, its icon in place of the dot.
    <StatusChip tone={tone === 'gold' ? 'accent' : 'neutral'} icon={<Icon aria-hidden="true" className="w-3 h-3 shrink-0" />} className="whitespace-nowrap">
      {children}
    </StatusChip>
  );
}

const LINK = LINK_QUIET.replace('min-h-[32px]', 'min-h-[44px]');

export function DeviceCard({
  device,
  claims = [],
  lang,
  s,
  onOpenClaim,
  onOpenThread,
  onRemove,
  maintenancePath = null,
  carePerks = null,
}: {
  /** Phase 5b: what else Levo Care includes for this customer (the page's `care_perks`). */
  carePerks?: CarePerks | null;
  device: Device;
  /** Every request of the customer's own on this device (open and closed), newest first. */
  claims?: Claim[];
  lang: Language;
  s: WarrantyStrings;
  /** 0148 — the maintenance listing the parts link opens, filtered to this printer. */
  maintenancePath?: string | null;
  onOpenClaim: (device: Device, kind: ClaimKind, trigger: HTMLElement) => void;
  onOpenThread: (claim: Claim, trigger: HTMLElement) => void;
  onRemove: (device: Device) => void;
}) {
  const c = CARE_STRINGS[lang];
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);

  const name = productName(device.product, lang);
  const replaced = !!device.replaced_by_unit_id;
  const serialLabel = device.serial ?? s.unitN(device.unit_index);
  const supportSubject = `${name} — ${serialLabel}`;
  const docLang = lang === 'en' ? 'en' : 'ar';
  const receiptNo = device.receipt?.receipt_no;
  // The +12 / +24 bought with the printer, as the device record states it.
  const extended = (Number(device.warranty.ext_months) || 0) > 0;

  const care = device.care ?? null;
  const careActive = care?.state === 'active';
  const warrantyActive = device.warranty.state === 'active' && care?.warranty_months !== 0;
  // With the warranty over, the Care discount is the request that fits.
  const careFirst = careActive && !warrantyActive;

  const open = claims.filter((cl) => claimOpen(cl));
  // An offer outlives nothing but its own date: a closed request may still carry one.
  const offering = claims.find((cl) => (Number(cl.part_offers_live) || 0) > 0 && !open.includes(cl)) ?? null;
  const offeringCount = offering ? Number(offering.part_offers_live) || 0 : 0;

  return (
    <article className={`${CARD} p-4`} data-unit-id={device.unit_id}>
      {/* ------------------------------------------------------ which printer */}
      <div className="flex gap-3">
        <SafeImage sizes="64px"
          src={device.product.image}
          alt=""
          aspect="auto"
          className="w-16 h-16 rounded-lg border border-border-subtle shrink-0"
          bgClassName="bg-surface-raised"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-text-primary font-bold text-[16px] leading-tight line-clamp-2 pt-0.5">{name}</h3>
            <div className="relative shrink-0 -mt-1 -me-1">
              <IconButton
                ref={menuAnchor}
                label={s.more}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
                icon={<MoreHorizontal aria-hidden="true" className="w-4 h-4" />}
                className="-my-1.5"
              />
              <Anchored open={menuOpen} onClose={() => setMenuOpen(false)} anchor={menuAnchor} label={s.more} className="min-w-[230px] p-1.5" z={40}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove(device);
                  }}
                  className={`w-full text-start flex items-center gap-2 px-3 min-h-[44px] rounded-sm text-[13px] font-bold text-danger hover:bg-danger/10 transition-colors ${FOCUS}`}
                >
                  <Unlink aria-hidden="true" className="w-4 h-4" />
                  {s.removeFromAccount}
                </button>
              </Anchored>
            </div>
          </div>
          <p className="text-text-muted text-[12px] mt-1 flex items-center gap-1.5 min-w-0">
            <span dir="ltr" className="font-mono tracking-wider shrink-0">{serialLabel}</span>
            {device.order_id && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">
                  {s.orderRef} <span dir="ltr" className="font-mono">{device.order_id}</span>
                </span>
              </>
            )}
          </p>
          {(extended || device.transferred || replaced) && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {extended && (
                <Badge icon={ShieldPlus} tone="gold">
                  {s.extendedBadge}
                </Badge>
              )}
              {device.transferred && <Badge icon={ArrowLeftRight}>{s.transferredBadge}</Badge>}
              {replaced && <Badge icon={Repeat}>{s.replacedBadge}</Badge>}
            </div>
          )}
        </div>
      </div>

      {/* -------------------------------------------- covered? until when? */}
      <CoverTimeline device={device} lang={lang} s={s} c={c} className="mt-4 border-t border-border-subtle pt-4" />

      {/* ---------------------------------------------- what Care gives */}
      {care && (
        <div className="mt-4">
          <CarePanel care={care} warrantyActive={warrantyActive} lang={lang} c={c} perks={carePerks} couponsUntil={carePerks?.weekly_coupons_by_unit?.[device.unit_id] ?? null} />
        </div>
      )}

      {/* ---------------------------------------------- what is happening */}
      {offering && (
        <button
          type="button"
          onClick={(e) => onOpenThread(offering, e.currentTarget)}
          className={`mt-3 flex w-full min-h-[44px] items-center gap-2.5 text-start lv-alert lv-alert-info ${FOCUS}`}
          data-device-offer={offering.id}
        >
          <Gift aria-hidden="true" className="w-4 h-4 shrink-0" style={{ color: 'var(--color-info)' }} />
          <span className="min-w-0 flex-1 text-[13px] font-bold leading-snug text-text-primary">{c.offerWaiting(offeringCount, fmtCount(offeringCount))}</span>
          <span className="shrink-0 text-[12.5px] font-bold underline underline-offset-2 text-text-primary">{c.seeOffer}</span>
        </button>
      )}
      {open.length > 0 && (
        <div className="mt-4" data-device-requests={device.unit_id}>
          <h4 className="text-[12px] font-bold text-text-muted">{s.requestsOnDevice}</h4>
          <div className="mt-1.5 space-y-2">
            {open.map((cl) => (
              <ClaimRow key={cl.id} claim={cl} lang={lang} s={s} onOpen={onOpenThread} />
            ))}
          </div>
        </div>
      )}
      {open.length === 0 && device.open_claims > 0 && (
        <div className="mt-3">
          <Badge icon={Wrench} tone="gold">
            {s.openClaimsBadge(device.open_claims, fmtInt(device.open_claims, lang))}
          </Badge>
        </div>
      )}

      {/* ---------------------------------------------------- what can I do */}
      {!replaced && (
        <div className="mt-4" data-device-actions>
          {open.length > 0 ? (
            <>
              <button type="button" onClick={(e) => onOpenThread(open[0], e.currentTarget)} className={`${BTN_PRIMARY} w-full`} data-device-follow>
                <MessageSquare aria-hidden="true" className="w-4 h-4" />
                {s.followOpen}
              </button>
              <p className="mt-2 text-[11.5px] leading-relaxed text-text-muted">{s.oneOpenNote}</p>
            </>
          ) : (
            <div className={`grid gap-2 ${careActive ? 'sm:grid-cols-2' : ''}`}>
              <button
                type="button"
                onClick={(e) => onOpenClaim(device, 'warranty', e.currentTarget)}
                className={`${careFirst ? BTN_SECONDARY : BTN_PRIMARY} w-full`}
                style={careFirst ? { order: 2 } : undefined}
                data-device-claim="warranty"
              >
                <Wrench aria-hidden="true" className="w-4 h-4" />
                {s.openClaim}
              </button>
              {careActive && (
                <button
                  type="button"
                  onClick={(e) => onOpenClaim(device, 'care', e.currentTarget)}
                  className={`${careFirst ? BTN_PRIMARY : BTN_SECONDARY} w-full`}
                  data-device-claim="care"
                >
                  <BadgePercent aria-hidden="true" className="w-4 h-4" />
                  {s.askCare}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* --------------------------------------------------------- the rest */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4">
        <Link
          to="/support"
          state={{ unitId: device.unit_id, ...(device.order_id ? { orderId: device.order_id } : {}), subject: supportSubject }}
          className={LINK}
        >
          <LifeBuoy aria-hidden="true" className="w-3.5 h-3.5" />
          {s.contactSupport}
        </Link>
        {/* «تفيد في صيانة الطابعة» (0148): what the shop stocks for THIS
            printer — a nozzle or a plate is often the repair itself. */}
        {device.maintenance && maintenancePath && (
          <Link
            to={`${maintenancePath}?fits=${encodeURIComponent(device.maintenance.printer_slug)}`}
            className={LINK}
            data-device-parts={device.maintenance.printer_slug}
          >
            <Cog aria-hidden="true" className="w-3.5 h-3.5" />
            {s.maintenanceParts(device.maintenance.count, fmtInt(device.maintenance.count, lang))}
          </Link>
        )}
        {device.order_id && (
          <Link to={`/orders/${encodeURIComponent(device.order_id)}`} className={LINK}>
            <Package aria-hidden="true" className="w-3.5 h-3.5" />
            {s.viewOrder}
          </Link>
        )}
        {receiptNo && (
          <>
            <Link to={`/warranty/${encodeURIComponent(receiptNo)}`} className={LINK}>
              <Receipt aria-hidden="true" className="w-3.5 h-3.5" />
              {s.verifyReceipt}
            </Link>
            <a
              href={`/api/warranty/receipts/${encodeURIComponent(receiptNo)}/document?lang=${docLang}&print=1`}
              target="_blank"
              rel="noopener"
              className={LINK}
            >
              <Printer aria-hidden="true" className="w-3.5 h-3.5" />
              {s.printReceipt}
              <ExternalLink aria-hidden="true" className="w-3 h-3 opacity-60" />
            </a>
          </>
        )}
      </div>

      {/* THE DEVICE'S CUSTODY (owner decision 3) — dates only, never who:
          first delivered, traded in or returned to Levonis, resold. Shown
          once there is more than the one delivery to tell. */}
      {(device.history?.length ?? 0) > 1 && (
        <div className="mt-2 border-t border-border-subtle pt-3" data-device-history>
          <p className="text-[11px] font-bold text-text-muted">{s.historyTitle}</p>
          <ol className="mt-1 flex flex-col gap-0.5">
            {device.history!.map((h, i) => (
              <li key={`${h.kind}-${i}`} className="flex items-baseline justify-between gap-3 text-[11px] text-text-secondary tabular-nums" data-history-kind={h.kind}>
                <span className="truncate">
                  {h.kind === 'first' ? s.hFirst : h.kind === 'traded_in' ? s.hTradedIn : h.kind === 'returned' ? s.hReturned : s.hResold}
                </span>
                <span className="shrink-0 text-text-muted">{fmtDate(h.at, lang)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}
