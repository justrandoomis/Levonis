import { useState } from 'react';
import type { Language } from '../../translations';
import { api, ApiError } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { formatMoney } from '../../lib/money';
import type { CareQuotePublic } from './types';
import { careText, fmtInt } from './types';
import type { CareStrings } from './strings';
import { BTN_PRIMARY, ERROR_BOX } from './ui';

/**
 * A Levo Care quote on the customer's claim (printer phase 3): what the repair
 * costs in full, the Care discount and what the customer pays — never a cost of
 * the shop — with «أوافق» while the quote waits for them. The acceptance names
 * the version shown: a quote rewritten meanwhile is refused (CARE_QUOTE_CHANGED)
 * and the thread reloads, so the customer accepts only what they have read.
 */
export function CareQuoteBox({ claimId, quote, lang, c, onChanged }: {
  claimId: string;
  quote: CareQuotePublic;
  lang: Language;
  c: CareStrings;
  /** Reload the claim (after an acceptance, or when the quote changed underneath). */
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const money = (v: number) => formatMoney(v, lang);
  const pct = fmtInt(quote.discount_pct, lang);

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/devices/claims/${encodeURIComponent(claimId)}/care-quote/accept`, { version: quote.version });
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CARE_QUOTE_CHANGED') {
        setError(c.changed);
        await Promise.resolve(onChanged()).catch(() => undefined);
      } else {
        setError(apiRefusal(e, refusalLang(lang), e instanceof ApiError ? e.message : ''));
      }
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, value: string, strong = false) => (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'font-bold text-text-primary' : 'text-text-secondary'}>{label}</dt>
      <dd dir="ltr" className={`tabular-nums shrink-0 ${strong ? 'font-bold text-text-primary text-[15px]' : 'text-text-secondary'}`}>{value}</dd>
    </div>
  );

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-raised p-3 space-y-2" data-care-quote={quote.state} data-care-quote-version={quote.version}>
      <h3 className="text-[14px] font-bold text-text-primary">{c.quoteTitle}</h3>
      {quote.state === 'quoted' && <p className="text-[12px] text-text-muted leading-relaxed">{c.quoteIntro}</p>}
      <dl className="space-y-1 text-[13px]">
        {quote.parts.map((p, i) => (
          <div key={`${p.key}-${i}`} className="flex items-baseline justify-between gap-3">
            <dt className="text-text-secondary truncate">{careText(p.label, lang) || p.key} × {fmtInt(p.qty, lang)}</dt>
            <dd dir="ltr" className="tabular-nums shrink-0 text-text-secondary">{money(p.total_iqd)}</dd>
          </div>
        ))}
        {quote.labor_iqd > 0 && row(c.labor, money(quote.labor_iqd))}
        {quote.shipping_iqd > 0 && row(c.shipping, money(quote.shipping_iqd))}
        {quote.other_iqd > 0 && row(c.other, money(quote.other_iqd))}
        <div className="border-t border-border-subtle pt-1 space-y-1">
          {row(c.list, money(quote.list_iqd))}
          {row(c.discountLine(pct), `− ${money(quote.benefit_iqd)}`)}
          {row(c.youPay, money(quote.copay_iqd), true)}
        </div>
      </dl>
      {quote.note && <p className="text-[12px] text-text-secondary whitespace-pre-wrap">{quote.note}</p>}
      {error && <div role="alert" className={ERROR_BOX}>{error}</div>}
      {quote.state === 'quoted' && (
        <button type="button" className={`${BTN_PRIMARY} w-full`} disabled={busy} onClick={() => void accept()} data-care-accept>
          {busy ? c.accepting : c.accept}
        </button>
      )}
      {quote.state === 'accepted' && <p role="status" className="text-[12px] text-text-secondary">{c.accepted}</p>}
      {quote.state === 'approved' && <p role="status" className="text-[12px] text-text-secondary">{quote.copay_collected ? c.copayPaid : c.approved}</p>}
      {quote.state === 'void' && <p role="status" className="text-[12px] text-text-secondary">{c.voided}</p>}
    </section>
  );
}
