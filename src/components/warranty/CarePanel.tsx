import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, BadgePercent } from 'lucide-react';
import type { Language } from '../../translations';
import { formatMoney } from '../../lib/money';
import type { CarePerks, CarePublic } from './types';
import { careText, fmtCount, fmtDate } from './types';
import type { CareStrings } from './strings';
import { StatusChip } from '../ui/Badge';
import { FOCUS, LINK_QUIET } from './ui';

/** A link inside the perks list: a 44 px target, like every link of the card. */
const PERK_LINK = LINK_QUIET.replace('min-h-[32px]', 'min-h-[44px]');

/**
 * «ليفو كير» on a printer: what it IS (a discount on the part you need, never
 * a free replacement), whether it runs and until when, what the device has left
 * (the discount, the requests, the money), and — folded — the terms it was
 * bought under. Only what the server sends is said; a field an older server
 * leaves out is not.
 *
 * «ما يشمله ليفو كير» (DECISIONS row 359) — while Care runs: the discount on parts,
 * the weekly coupons with the day they end for THIS device (delivery + 12 months,
 * the server's date) and the monthly draw, said as a chance. The confirmed winner
 * of the month reads one clear line with the way to his gift.
 */
export function CarePanel({
  care,
  warrantyActive,
  lang,
  c,
  perks = null,
  couponsUntil = null,
}: {
  /** What else Care includes for this customer (GET /api/devices/mine `care_perks`); null from an older server. */
  perks?: CarePerks | null;
  /** The day this device's weekly coupons end, or null when the programme issues none. */
  couponsUntil?: string | null;
  care: CarePublic;
  /** The warranty still runs: Care then serves damage from use only. */
  warrantyActive: boolean;
  lang: Language;
  c: CareStrings;
}) {
  const [open, setOpen] = useState(false);
  const termsId = useId();
  const active = care.state === 'active';
  const known = care.state in c.state;
  const status =
    active && care.end_at
      ? c.activeUntil(fmtDate(care.end_at, lang))
      : care.state === 'expired' && care.end_at
        ? c.expiredOn(fmtDate(care.end_at, lang))
        : known
          ? c.state[care.state as keyof CareStrings['state']]
          : care.state;
  const facts: string[] = [];
  if (active) {
    if (care.discount_pct != null) facts.push(c.discountUpTo(fmtCount(care.discount_pct)));
    if (care.claims_left != null) facts.push(c.claimsLeft(care.claims_left, fmtCount(care.claims_left)));
    if (care.benefit_left_iqd != null) facts.push(c.benefitLeft(formatMoney(care.benefit_left_iqd, lang)));
    else if (care.discount_pct != null) facts.push(c.noMoneyCap);
  }
  const parts = (care.eligible_parts ?? []).map((p) => careText(p.label, lang)).filter(Boolean);
  const exclusions = (care.exclusions ?? []).map((x) => careText(x, lang)).filter(Boolean);
  const hasTerms = care.discount_pct != null || parts.length > 0 || exclusions.length > 0;
  const inForce = active || care.state === 'terms_missing';
  const couponsRun = !!couponsUntil && Date.parse(couponsUntil) > Date.now();
  const prize = perks?.draw?.won && perks.draw.prize ? perks.draw.prize : null;
  const prizeName = prize ? (lang === 'en' ? prize.name || prize.name_ar : lang === 'ckb' ? prize.name_ku || prize.name_ar || prize.name : prize.name_ar || prize.name) : '';

  return (
    <section className="rounded-xl border border-border-subtle p-3" data-device-care={care.state}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h4 className="inline-flex items-center gap-1.5 text-[14px] font-bold text-text-primary">
          <BadgePercent aria-hidden="true" className="w-4 h-4 shrink-0" style={{ color: 'var(--color-info)' }} />
          {c.title}
        </h4>
        <StatusChip tone={active ? 'info' : 'neutral'}>{status}</StatusChip>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-secondary">{c.what}</p>
      {facts.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" data-device-care-facts>
          {facts.map((f) => (
            <li key={f} className="rounded-full border border-border-subtle px-2.5 py-1 text-[12px] font-semibold leading-tight text-text-primary tabular-nums">
              {f}
            </li>
          ))}
        </ul>
      )}
      {active && <p className="mt-2 text-[12px] leading-relaxed text-text-muted">{warrantyActive ? c.duringWarranty : c.afterWarranty}</p>}
      {perks && inForce && (
        <div className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-text-secondary" data-device-care-perks>
          <p className="font-bold text-text-primary">{c.includesTitle}:</p>
          <ul className="list-disc ps-5">
            <li>{c.perkParts}</li>
            {couponsUntil && (
              <li data-device-care-coupons={couponsRun ? 'running' : 'ended'}>
                {couponsRun ? c.perkCouponsUntil(fmtDate(couponsUntil, lang)) : c.perkCouponsEnded(fmtDate(couponsUntil, lang))}
                {couponsRun && (
                  <>
                    {' · '}
                    <Link to="/rewards/coupons" className={PERK_LINK}>
                      {c.couponsLink}
                    </Link>
                  </>
                )}
              </li>
            )}
            {perks.draw && <li>{c.perkDraw}</li>}
          </ul>
          {prize && (
            <p className="font-bold text-text-primary" data-device-care-draw-won>
              {c.drawWon(`${prizeName} × ${fmtCount(prize.qty)}`)}
              {' · '}
              <Link to="/gifts" className={PERK_LINK}>
                {c.drawClaim}
              </Link>
            </p>
          )}
        </div>
      )}
      {hasTerms && (
        <>
          <button
            type="button"
            className={`mt-1 inline-flex min-h-[44px] items-center gap-1 rounded text-[12.5px] font-semibold text-text-secondary hover:text-text-primary ${FOCUS}`}
            aria-expanded={open}
            aria-controls={termsId}
            onClick={() => setOpen((o) => !o)}
            data-device-care-terms
          >
            {open ? c.hideTerms : c.showTerms}
            <ChevronDown aria-hidden="true" className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <div id={termsId} className="space-y-1.5 text-[12px] leading-relaxed text-text-secondary">
              {care.discount_pct != null && (
                <p>
                  {c.discount(fmtCount(care.discount_pct))}
                  {care.labor === 'discounted' ? ` · ${c.laborCovered}` : ''}
                  {care.shipping === 'discounted' ? ` · ${c.shippingCovered}` : ''}
                </p>
              )}
              {parts.length > 0 && (
                <p>
                  <span className="font-bold text-text-primary">{c.parts}:</span> {parts.join(lang === 'en' ? ', ' : '، ')}
                </p>
              )}
              {exclusions.length > 0 && (
                <div>
                  <p className="font-bold text-text-primary">{c.exclusions}:</p>
                  <ul className="list-disc ps-5">
                    {exclusions.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
