/**
 * «التسعير التقديري» — THE OWNER'S ESTIMATES WORKSPACE (docs/SMART_PRICING.md
 * §7; DECISIONS rows 278–282).
 *
 * Its own lazy chunk, opened from the card in «التسعير والشحن»
 * (src/components/adminPricing/AdminPricing.tsx), which src/pages/Admin.tsx
 * mounts only for `can_write_cost === true` — a courtesy: both owner routers
 * (/api/admin/pricing/supplier-prices and /api/admin/pricing/estimates)
 * refuse everyone but the verified owner before a query runs.
 *
 *   روابط المورّد   every linked product: Tmall ids, option and store links, prices, «تحديث السعر»
 *   المراجعة        the matches, option by option; lookup, store page, manual price, type and route
 *   جاهز للتطبيق    compute and apply, product by product, under the budget
 *   المنتجات التقديرية  confirm (the label removed), pause, resume
 *   الملاحظات        the labelled products' open flags
 *   التحديث          recomputed estimates that move a published price
 *   لقطات الأسعار    upload a capture in chunks, discard, run matching
 *   الأنواع والمفاتيح  the per-type figures and the two switches
 *
 * The tab and the product it is opened on travel in the address
 * (`?tab=pricing&view=estimates&etab=…&product=…`), so the product form's
 * banner links straight to a product's review or confirmation, and a reload
 * comes back to the same place. Nothing is kept in browser storage.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { TabPanels, TabStrip } from '../ui/Tabs';
import { WORKSPACE_TABS, isEstimateProductId, isWorkspaceTab, type WorkspaceTab } from './api';
import { useUiLang } from './parts';
import { TAB_LABELS, WORKSPACE, say } from './strings';
import LinksTab from './LinksTab';
import ReviewTab from './ReviewTab';
import EstimateListTab from './EstimateLists';
import SnapshotsTab from './SnapshotsTab';
import TypesTab from './TypesTab';

/** The tab and the product the address opens the workspace on. */
export function readWorkspaceAddress(search: string): { tab: WorkspaceTab; product: string | null } {
  try {
    const q = new URLSearchParams(search);
    const tab = q.get('etab');
    const product = q.get('product');
    return { tab: isWorkspaceTab(tab) ? tab : 'links', product: isEstimateProductId(product) ? product : null };
  } catch {
    return { tab: 'links', product: null };
  }
}

function writeAddress(tab: WorkspaceTab, product: string | null) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('etab', tab);
    if (product) url.searchParams.set('product', product);
    else url.searchParams.delete('product');
    window.history.replaceState(window.history.state, '', url);
  } catch {
    /* the address is a courtesy */
  }
}

export default function EstimateWorkspace({ onBack }: { onBack: () => void }) {
  const { lang, dir } = useUiLang();
  const [start] = useState(() => readWorkspaceAddress(typeof window === 'undefined' ? '' : window.location.search));
  const [tab, setTab] = useState<WorkspaceTab>(start.tab);
  const [product, setProduct] = useState<string | null>(start.product);

  useEffect(() => writeAddress(tab, product), [tab, product]);

  const choose = useCallback((id: string) => {
    if (!isWorkspaceTab(id)) return;
    setTab(id);
    // A product opened from its form belongs to the links and the review; another tab lists them all.
    if (id !== 'links' && id !== 'review') setProduct(null);
  }, []);
  const review = useCallback((productId: string) => {
    setProduct(productId);
    setTab('review');
  }, []);
  const clearFocus = useCallback(() => setProduct(null), []);

  const items = useMemo(() => WORKSPACE_TABS.map((id) => ({ id, label: say(TAB_LABELS[id], lang) })), [lang]);

  return (
    <div dir={dir} data-estimates-workspace className="mx-auto w-full max-w-[1120px] min-w-0 space-y-4 px-4 pb-16 sm:px-0">
      <div>
        <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-1.5 px-1 text-[13px] font-bold text-text-primary" data-estimates-back>
          <ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />
          {say(WORKSPACE.back, lang)}
        </button>
      </div>
      <header className="space-y-1">
        <h2 className="text-[22px] font-black leading-snug text-text-primary sm:text-[26px]">{say(WORKSPACE.title, lang)}</h2>
        <p className="max-w-[72ch] text-[14px] leading-relaxed text-text-secondary">{say(WORKSPACE.intro, lang)}</p>
      </header>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabStrip items={items} value={tab} onChange={choose} group="estimates-workspace" fill={false} panels label={say(WORKSPACE.tabsLabel, lang)} className="border-b border-border-subtle" />
      </div>
      <TabPanels value={tab} order={[...WORKSPACE_TABS]} group="estimates-workspace">
        {tab === 'links' ? (
          <LinksTab focusProduct={product} onClearFocus={clearFocus} />
        ) : tab === 'review' ? (
          <ReviewTab focusProduct={product} onClearFocus={clearFocus} />
        ) : tab === 'snapshots' ? (
          <SnapshotsTab />
        ) : tab === 'types' ? (
          <TypesTab />
        ) : (
          <EstimateListTab key={tab} mode={tab} onReview={review} />
        )}
      </TabPanels>
    </div>
  );
}
