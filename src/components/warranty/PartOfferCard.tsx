import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Gift, ShoppingCart } from 'lucide-react';
import type { Language } from '../../translations';
import { api } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { formatMoney } from '../../lib/money';
import SafeImage from '../ui/SafeImage';
import { StatusChip, type Tone } from '../ui/Badge';
import type { PartGrantPublic } from './types';
import { fmtCount, fmtDate, grantProductName } from './types';
import type { CareStrings } from './strings';
import { BTN_PRIMARY, BTN_SECONDARY, ERROR_BOX, FOCUS } from './ui';

/**
 * A PART THE TEAM SENT AT A LEVO CARE DISCOUNT (DECISIONS row 358, D7): drawn
 * in the conversation like a product — picture, name, the price struck and the
 * price after the discount, «خصم ليفو كير N%», until when — with the one action
 * that fits its state:
 *
 *   live, no choices → «أضف إلى السلة» (the cart's own door, POST /api/cart/items;
 *                      the bottom bar's count follows by itself), then «اذهب إلى السلة»;
 *   live, choices    → «اختر الخيارات», the product's page;
 *   used / revoked / expired → what happened, in a sentence.
 *
 * The customer orders it like any part: nothing is typed, the discount applies
 * by itself in the cart, once, on one unit, on this account only — and the card
 * says so. Every figure is the server's; nothing is priced here.
 */

const TONE: Record<string, Tone> = { live: 'info', used: 'success', revoked: 'neutral', expired: 'neutral' };

export function PartOfferCard({ grant, lang, c }: { grant: PartGrantPublic; lang: Language; c: CareStrings }) {
  const [state, setState] = useState<'idle' | 'adding' | 'added' | 'failed'>('idle');
  const [said, setSaid] = useState('');
  const money = (v: number) => formatMoney(v, lang);
  const p = grant.product;
  const live = grant.state === 'live';
  const known = grant.state in c.offerState;
  const name = p ? grantProductName(p, lang) : c.productGone;
  const struck = live && grant.price_iqd != null && grant.after_iqd != null && grant.after_iqd < grant.price_iqd;
  // The ceiling bit: the discount is less than the percentage of the price.
  const capped =
    live && grant.max_discount_iqd != null && grant.price_iqd != null && grant.discount_iqd != null && grant.discount_iqd < Math.floor((grant.price_iqd * grant.discount_pct) / 100);

  const add = async () => {
    if (!p || state === 'adding' || state === 'added') return;
    setState('adding');
    setSaid('');
    try {
      await api.post('/api/cart/items', { productId: p.id, qty: 1 });
      setState('added');
    } catch (e) {
      setState('failed');
      setSaid(apiRefusal(e, refusalLang(lang), c.addFailed));
    }
  };

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-raised p-3" data-part-grant={grant.id} data-part-grant-state={grant.state}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h3 className="inline-flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
          <Gift aria-hidden="true" className="w-4 h-4 shrink-0" style={{ color: 'var(--color-info)' }} />
          {c.offerTitle}
        </h3>
        <StatusChip tone={TONE[grant.state] ?? 'neutral'}>{known ? c.offerState[grant.state as keyof CareStrings['offerState']] : grant.state}</StatusChip>
      </div>

      <div className="mt-2.5 flex gap-3">
        {p?.image ? (
          <SafeImage sizes="64px" src={p.image} alt="" aspect="auto" className="w-16 h-16 rounded-lg border border-border-subtle shrink-0" bgClassName="bg-white" />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-bold leading-snug text-text-primary line-clamp-2" dir="auto">
            {name}
          </p>
          <p className="mt-1 text-[12.5px] font-bold tabular-nums" style={{ color: 'var(--color-info)' }}>
            {c.offerPct(fmtCount(grant.discount_pct))}
          </p>
          {live && grant.after_iqd != null && (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums">
              {struck && (
                <span className="text-[12.5px] text-text-muted line-through">
                  <span className="sr-only">{c.priceBefore}: </span>
                  {money(grant.price_iqd!)}
                </span>
              )}
              <span className="text-[16px] font-bold text-text-primary">
                <span className="sr-only">{c.priceAfter}: </span>
                {money(grant.after_iqd)}
              </span>
            </p>
          )}
        </div>
      </div>

      {live && (
        <p className="mt-2 text-[12px] text-text-secondary tabular-nums">
          {c.offerUntil(fmtDate(grant.expires_at, lang))}
          {capped ? ` · ${c.capNote(money(grant.max_discount_iqd!))}` : ''}
        </p>
      )}

      {live && p && !p.available && <p className="mt-2 text-[12.5px] text-text-secondary">{c.unavailable}</p>}
      {live && p && p.available && (
        <div className="mt-3 space-y-2">
          {p.needs_choices ? (
            <Link to={`/product/${encodeURIComponent(p.slug)}`} className={`${BTN_PRIMARY} w-full`} data-part-grant-choose>
              {c.chooseOptions}
            </Link>
          ) : state === 'added' ? (
            <>
              <p role="status" className="flex items-center gap-1.5 text-[13px] font-bold text-success">
                <Check aria-hidden="true" className="w-4 h-4 shrink-0" />
                {c.added}
              </p>
              <Link to="/cart" className={`${BTN_PRIMARY} w-full`} data-part-grant-cart>
                <ShoppingCart aria-hidden="true" className="w-4 h-4" />
                {c.goCart}
              </Link>
            </>
          ) : (
            <button type="button" onClick={() => void add()} disabled={state === 'adding'} aria-busy={state === 'adding' || undefined} className={`${BTN_PRIMARY} w-full`} data-part-grant-add>
              <ShoppingCart aria-hidden="true" className="w-4 h-4" />
              {state === 'adding' ? c.adding : c.addToCart}
            </button>
          )}
          {state === 'failed' && (
            <>
              <div role="alert" className={ERROR_BOX}>
                {said || c.addFailed}
              </div>
              <Link to={`/product/${encodeURIComponent(p.slug)}`} className={`${BTN_SECONDARY} w-full`}>
                {c.chooseOptions}
              </Link>
            </>
          )}
          <p className="text-[11.5px] leading-relaxed text-text-muted" data-part-grant-auto>
            {c.autoNote}
          </p>
        </div>
      )}

      {grant.state === 'used' && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-text-secondary tabular-nums">
          {grant.discount_given_iqd != null ? c.usedNote(money(grant.discount_given_iqd)) : c.offerState.used}
          {grant.used_order_id && (
            <>
              {' '}
              <Link to={`/orders/${encodeURIComponent(grant.used_order_id)}`} className={`inline-flex min-h-[44px] items-center rounded font-bold text-text-primary underline underline-offset-2 ${FOCUS}`}>
                {c.viewOrder}
              </Link>
            </>
          )}
        </p>
      )}
      {grant.state === 'revoked' && <p className="mt-2 text-[12.5px] leading-relaxed text-text-secondary">{c.revokedNote}</p>}
      {grant.state === 'expired' && <p className="mt-2 text-[12.5px] leading-relaxed text-text-secondary">{c.expiredNote(fmtDate(grant.expires_at, lang))}</p>}
    </section>
  );
}
