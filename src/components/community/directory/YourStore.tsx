/**
 * The viewer own place in the directory: their store, one tap from its
 * workspace, or the way to one. A member with no approval yet is shown the
 * MERCHANT APPLICATION whatever their plan: applying needs no PLUS (owner
 * decision C3). An approved member opens their store when their plan lets
 * them; an older server (no `approved` in its answer) keeps the plan gate.
 * Nothing for anyone else: a button to a door that will not open is the dead
 * control the mandate forbids (src/components/merchant/StoreCta.tsx).
 *
 * Moved here from hub/StoresPanel.tsx (community UI plan C5): the stores page
 * draws it under the filter chips while no search or filter is on, and the
 * home tab of today draws the same row.
 */
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { MerchantMe } from '../../../lib/merchant';
import { merchantHref } from '../../../lib/merchantRoutes';
import { applicationCta, approvalReason } from '../../merchantApplication/approvalWords';
import { StoreMark } from '../hub/parts';
import { useHubStrings } from '../hub/strings';

export default function YourStore({ me, className = 'mb-4' }: { me: MerchantMe | null; className?: string }) {
  const { dir, loc } = useLanguage();
  const s = useHubStrings();
  if (!me) return null;
  const applying = !me.store && me.approved === false;
  if (!me.store && !applying && !me.eligible) return null;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const to = me.store ? merchantHref.home() : '/merchant/start';
  return (
    <Link
      to={to}
      data-community-your-store={me.store ? 'manage' : applying ? 'apply' : 'create'}
      className={`lv-surface flex items-center gap-3 px-4 py-3 active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
    >
      {me.store ? (
        <StoreMark src={me.store.logoUrl} />
      ) : (
        <span aria-hidden="true" className="lv-well flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
          <Plus className="h-5 w-5 text-text-secondary" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-text-primary">
          {me.store ? s.yourStore : applying ? applicationCta(me.application, loc) : s.createStore}
        </span>
        <span dir={me.store ? 'auto' : undefined} className="block truncate text-start text-[12px] text-text-secondary">
          {me.store ? me.store.name : applying ? approvalReason(me.application, loc) : s.yourStoreHint}
        </span>
      </span>
      <Chevron aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
    </Link>
  );
}
