import { useState } from 'react';
import type { Language } from '../../translations';
import { formatMoney } from '../../lib/money';
import type { CarePublic } from './types';
import { careText, fmtDate, fmtInt } from './types';
import type { CareStrings } from './strings';
import { LINK_QUIET } from './ui';

/**
 * «ليفو كير» on a device (printer phase 3): whether it runs and until when, how
 * many claims and how much discount the device has left, and — folded — the
 * terms it was bought under (the discount, the covered parts, what it excludes).
 * Only what the server sends is said; a field an older server leaves out is not.
 */
export function CareLine({ care, lang, c }: { care: CarePublic; lang: Language; c: CareStrings }) {
  const [open, setOpen] = useState(false);
  const known = care.state in c.state;
  const status = care.state === 'active' && care.end_at
    ? c.activeUntil(fmtDate(care.end_at, lang))
    : care.state === 'expired' && care.end_at
      ? c.expiredOn(fmtDate(care.end_at, lang))
      : known ? c.state[care.state as keyof CareStrings['state']] : care.state;
  const facts: string[] = [];
  if (care.state === 'active') {
    if (care.claims_left != null) facts.push(c.claimsLeft(fmtInt(care.claims_left, lang)));
    if (care.benefit_left_iqd != null) facts.push(c.benefitLeft(formatMoney(care.benefit_left_iqd, lang)));
    else if (care.discount_pct != null) facts.push(c.noMoneyCap);
  }
  const parts = (care.eligible_parts ?? []).map((p) => careText(p.label, lang)).filter(Boolean);
  const exclusions = (care.exclusions ?? []).map((x) => careText(x, lang)).filter(Boolean);
  const hasTerms = care.discount_pct != null || parts.length > 0 || exclusions.length > 0;

  return (
    <div className="mt-3 rounded-lg border border-border-subtle px-3 py-2" data-device-care={care.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[13px] text-text-primary">
          <span className="font-bold">{c.title}</span>
          <span className="text-text-secondary"> · {status}</span>
        </p>
        {hasTerms && (
          <button type="button" className={LINK_QUIET} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-device-care-terms>
            {open ? c.hideTerms : c.showTerms}
          </button>
        )}
      </div>
      {facts.length > 0 && <p className="text-[12px] text-text-secondary tabular-nums mt-0.5">{facts.join(' · ')}</p>}
      {open && hasTerms && (
        <div className="mt-2 space-y-1.5 text-[12px] text-text-secondary leading-relaxed">
          {care.discount_pct != null && (
            <p>
              {c.discount(fmtInt(care.discount_pct, lang))}
              {care.labor === 'discounted' ? ` · ${c.laborCovered}` : ''}
              {care.shipping === 'discounted' ? ` · ${c.shippingCovered}` : ''}
            </p>
          )}
          {parts.length > 0 && <p><span className="font-bold text-text-primary">{c.parts}:</span> {parts.join(lang === 'en' ? ', ' : '، ')}</p>}
          {exclusions.length > 0 && (
            <div>
              <p className="font-bold text-text-primary">{c.exclusions}:</p>
              <ul className="list-disc ps-5">{exclusions.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
