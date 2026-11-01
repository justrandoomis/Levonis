/**
 * The card in «التسعير والشحن» that opens «التسعير التقديري»
 * (docs/SMART_PRICING.md §7). A chunk of its own, rendered lazily under the
 * pricing tab's own cards, so the tab's first load carries none of the
 * workspace's words; the workspace itself is another chunk, loaded on «افتح».
 */
import { Calculator } from 'lucide-react';
import { Button } from '../ui/Button';
import { useUiLang } from './parts';
import { WORKSPACE, say } from './strings';

export default function EstimatesCard({ onOpen }: { onOpen: () => void }) {
  const { lang } = useUiLang();
  return (
    <section data-pricing-estimates-card className="lv-surface space-y-3 p-4">
      <h3 className="flex items-center gap-2 text-[16px] font-bold text-text-primary">
        <Calculator aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
        {say(WORKSPACE.cardTitle, lang)}
      </h3>
      <p className="max-w-[72ch] text-[13px] leading-relaxed text-text-secondary">{say(WORKSPACE.cardBody, lang)}</p>
      <Button size="sm" variant="primary" className="w-full sm:w-auto" onClick={onOpen} data-pricing-open-estimates>
        {say(WORKSPACE.open, lang)}
      </Button>
    </section>
  );
}
