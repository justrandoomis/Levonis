import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { MerchantMe } from '../../lib/merchant';
import { applicationCta, applicationStateWord, approvalReason } from './approvalWords';

/**
 * «ليس لديك متجر بعد» — WHERE THE APPROVAL STANDS (Community V3 push 1.2,
 * DECISIONS row 257). The store dashboard's no-store answer, loaded lazily so
 * the workspace frame keeps its byte budget (tests/bundleBudget.test.ts).
 *
 * A store opens only after a reviewer approves the merchant application, and
 * applying needs no PLUS (owner decision C3), so this never points at
 * /subscription: an unapproved account reads its application's state and the
 * reviewer's public reason, with the one step that moves it forward; an
 * approved one creates its store at /merchant/start, which says what selling
 * still needs.
 */
export default function NoStoreApplication({ me }: { me: Pick<MerchantMe, 'approved' | 'application'> }) {
  const { loc } = useLanguage();
  const approved = me.approved === true;
  return (
    <>
      {!approved && (
        <div className="text-[13px] leading-relaxed text-text-secondary" data-application-summary>
          {me.application && (
            <p className="mb-1 font-semibold text-text-primary">
              {loc('طلب اعتماد التاجر', 'Merchant application', 'داواکاریی پەسەندکردنی بازرگان')}: {applicationStateWord(me.application.state, loc)}
            </p>
          )}
          <p>{approvalReason(me.application, loc)}</p>
        </div>
      )}
      <Link to="/merchant/start" className="lv-button lv-button-primary mt-4">
        {approved ? loc('أنشئ متجرك', 'Create your store', 'فرۆشگاکەت دروست بکە') : applicationCta(me.application, loc)}
        <ArrowRight aria-hidden="true" className="h-4 w-4 rtl:rotate-180" />
      </Link>
    </>
  );
}
