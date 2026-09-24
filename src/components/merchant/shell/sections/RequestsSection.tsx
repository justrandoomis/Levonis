/**
 * `/merchant/requests` — the workshop's side of custom print requests.
 *
 * On top — only when there are any — how many open requests match this
 * workshop and have no offer from it yet (the attention API's count, from the
 * matcher's own decisions), as a door to the request board. Below, the custom orders those requests became —
 * the old dashboard's «طلبات مخصصة» tab, mounted unchanged.
 *
 * The board is Levo Community (DECISIONS 110): while the community is shut to
 * this merchant the door is not drawn (and the server leaves the count out),
 * so nothing here leads to a maintenance card.
 */
import { ExternalLink, Inbox } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { useCommunityAccess } from '../../../../pages/community/access';
import { formatFigure } from '../../../../lib/localeNumber';
import { CustomOrdersTab } from '../../dashboard/SalesTabs';
import { useWorkspace } from '../context';

export default function RequestsSection() {
  const { loc, lang } = useLanguage();
  const ws = useWorkspace();
  const { access: communityAccess } = useCommunityAccess();
  const mainHref = ws.mainHref;
  const matching = ws.attention.data?.requests?.matching;

  return (
    <div className="space-y-4">
      {typeof matching === 'number' && matching > 0 && (
        <>
          {communityAccess?.may_enter !== false && (
            <a
              href={mainHref('/requests')}
              data-matching-requests={matching}
              className="lv-surface flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] text-text-secondary">
                <Inbox className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-[14px] font-medium text-text-primary">
                {/* OWNER: Sorani to be written by hand. */}
                {loc(`${formatFigure(matching, lang)} طلبات مفتوحة تطابق ورشتك ولم تقدّم عليها عرضًا`, `${formatFigure(matching, lang)} open requests match your workshop and have no offer from you`)}
              </span>
              <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted rtl:-scale-x-100" />
            </a>
          )}
        </>
      )}
      <CustomOrdersTab />
    </div>
  );
}
