import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wrench, LifeBuoy, Receipt, Printer, Package, MoreHorizontal, Unlink, ArrowLeftRight, Repeat, ExternalLink, ShieldPlus, Cog,
} from 'lucide-react';
import type { Language } from '../../translations';
import SafeImage from '../ui/SafeImage';
import { Anchored } from '../ui/Overlay';
import { IconButton } from '../ui/Button';
import { StatusChip } from '../ui/Badge';
import { CoverageBar } from './CoverageBar';
import type { Device } from './types';
import { productName, fmtInt, fmtDate } from './types';
import type { WarrantyStrings } from './strings';
import { BTN_SECONDARY, CARD, FOCUS, LINK_QUIET } from './ui';

/**
 * One registered printer. The card is deliberately quiet: the only colour on
 * it is the gold of the coverage timeline (and of an open-claims badge, which
 * is the same fact from the other side). Destructive "remove from my account"
 * lives behind the overflow menu so it is one deliberate step away, and the
 * page confirms it in a sheet before anything is sent.
 */

function Badge({ icon: Icon, tone = 'zinc', children }: { icon: React.ElementType; tone?: 'zinc' | 'gold'; children: React.ReactNode }) {
  return (
    // Information is flat clay: the house status chip, its icon in place of the dot.
    <StatusChip tone={tone === 'gold' ? 'accent' : 'neutral'} icon={<Icon aria-hidden="true" className="w-3 h-3 shrink-0" />} className="whitespace-nowrap">
      {children}
    </StatusChip>
  );
}

export function DeviceCard({
  device,
  lang,
  s,
  onOpenClaim,
  onRemove,
  maintenancePath = null,
}: {
  device: Device;
  lang: Language;
  s: WarrantyStrings;
  /** 0148 — the maintenance listing the parts link opens, filtered to this printer. */
  maintenancePath?: string | null;
  onOpenClaim: (device: Device, trigger: HTMLElement) => void;
  onRemove: (device: Device) => void;
}) {
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

  return (
    <article className={`${CARD} p-4`} data-unit-id={device.unit_id}>
      <div className="flex gap-3">
        <SafeImage
          src={device.product.image}
          alt=""
          aspect="auto"
          className="w-16 h-16 rounded-lg border border-border-subtle shrink-0"
          bgClassName="bg-surface-raised"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-text-primary font-bold text-[15px] leading-tight truncate pt-0.5">{name}</h3>
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
          <p className="text-text-muted text-[12px] mt-0.5 flex items-center gap-1.5 min-w-0">
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
          {(extended || device.transferred || replaced || device.open_claims > 0) && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {extended && (
                <Badge icon={ShieldPlus} tone="gold">
                  {s.extendedBadge}
                </Badge>
              )}
              {device.transferred && <Badge icon={ArrowLeftRight}>{s.transferredBadge}</Badge>}
              {replaced && <Badge icon={Repeat}>{s.replacedBadge}</Badge>}
              {device.open_claims > 0 && (
                <Badge icon={Wrench} tone="gold">
                  {s.openClaimsBadge(device.open_claims, fmtInt(device.open_claims, lang))}
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>

      <CoverageBar warranty={device.warranty} deliveredAt={device.delivered_at} lang={lang} s={s} className="mt-5" />

      {/* THE DEVICE'S CUSTODY (owner decision 3) — dates only, never who:
          first delivered, traded in or returned to Levonis, resold. Shown
          once there is more than the one delivery to tell. */}
      {(device.history?.length ?? 0) > 1 && (
        <div className="mt-3" data-device-history>
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

      <div className="mt-4 grid grid-cols-2 gap-2">
        {!replaced && (
          <button type="button" onClick={(e) => onOpenClaim(device, e.currentTarget)} className={BTN_SECONDARY}>
            <Wrench aria-hidden="true" className="w-4 h-4" />
            {s.openClaim}
          </button>
        )}
        <Link
          to="/support"
          state={{ unitId: device.unit_id, ...(device.order_id ? { orderId: device.order_id } : {}), subject: supportSubject }}
          className={`${BTN_SECONDARY} ${replaced ? 'col-span-2' : ''}`}
        >
          <LifeBuoy aria-hidden="true" className="w-4 h-4" />
          {s.contactSupport}
        </Link>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {/* «تفيد في صيانة الطابعة» (0148): what the shop stocks for THIS
            printer — a nozzle or a plate is often the repair itself. */}
        {device.maintenance && maintenancePath && (
          <Link
            to={`${maintenancePath}?fits=${encodeURIComponent(device.maintenance.printer_slug)}`}
            className={LINK_QUIET}
            data-device-parts={device.maintenance.printer_slug}
          >
            <Cog aria-hidden="true" className="w-3.5 h-3.5" />
            {s.maintenanceParts(device.maintenance.count, fmtInt(device.maintenance.count, lang))}
          </Link>
        )}
        {device.order_id && (
          <Link to={`/orders/${encodeURIComponent(device.order_id)}`} className={LINK_QUIET}>
            <Package aria-hidden="true" className="w-3.5 h-3.5" />
            {s.viewOrder}
          </Link>
        )}
        {receiptNo && (
          <>
            <Link to={`/warranty/${encodeURIComponent(receiptNo)}`} className={LINK_QUIET}>
              <Receipt aria-hidden="true" className="w-3.5 h-3.5" />
              {s.verifyReceipt}
            </Link>
            <a
              href={`/api/warranty/receipts/${encodeURIComponent(receiptNo)}/document?lang=${docLang}&print=1`}
              target="_blank"
              rel="noopener"
              className={LINK_QUIET}
            >
              <Printer aria-hidden="true" className="w-3.5 h-3.5" />
              {s.printReceipt}
              <ExternalLink aria-hidden="true" className="w-3 h-3 opacity-60" />
            </a>
          </>
        )}
      </div>
    </article>
  );
}
