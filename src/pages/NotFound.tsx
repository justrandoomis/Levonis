import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

/**
 * THE PAGE FOR AN ADDRESS THE APP DOES NOT KNOW.
 *
 * It replaced a bare English «Under Construction» line: a dead end that
 * blamed the site and offered no way on. This is the house empty state
 * (the `StateShell` recipe of src/components/ui/AsyncStates.tsx, class for
 * class, so it costs no CSS) with its title as the page's one `h1` and one
 * primary action home. It is written out here rather than imported because
 * AsyncStates sits in the merchant workspace shell's closure, which has no
 * room for a heading option. It renders inside the main shell, so the header
 * and the bottom bar stay.
 */
export default function NotFound() {
  const { loc } = useLanguage();
  return (
    <div className="w-full max-w-lg mx-auto px-4 py-10" data-not-found>
      <div role="status" className="lv-surface flex flex-col items-center justify-center text-center gap-3 px-6 py-12">
        <div className="w-12 h-12 rounded-full lv-well flex items-center justify-center text-text-muted">
          <Compass aria-hidden="true" className="w-6 h-6" />
        </div>
        <h1 className="text-text-primary font-bold text-[15px]">
          {loc('الصفحة غير موجودة', 'Page not found', 'ئەم پەڕەیە نەدۆزرایەوە')}
        </h1>
        <p className="text-text-muted text-sm max-w-xs leading-relaxed">
          {loc('ربما تغيّر الرابط أو حُذفت الصفحة.', 'The link may have changed, or the page was removed.', 'لەوانەیە بەستەرەکە گۆڕابێت یان پەڕەکە سڕابێتەوە.')}
        </p>
        <Link to="/" className="lv-button lv-button-primary mt-1">
          {loc('العودة إلى الرئيسية', 'Back to home', 'گەڕانەوە بۆ پەڕەی سەرەکی')}
        </Link>
      </div>
    </div>
  );
}
