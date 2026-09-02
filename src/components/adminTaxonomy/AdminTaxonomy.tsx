/**
 * التصنيفات — the admin page for everything the product form's first section
 * ("التصنيف: القسم والعلامة والهاشتاقات") chooses from:
 *
 *   الأقسام          the tree — main sections and their sub-sections, with the
 *                    template family that decides the spec fields and the
 *                    import columns;
 *   العلامات التجارية the brands;
 *   الفلاتر          the facets, grouped by kind;
 *   الهاشتاقات       the managed hashtag vocabulary.
 *
 * Everything here is add / edit / deactivate / delete, and every change is
 * immediately what the product form offers and what the import template
 * lists as an accepted value — the same rows, read from the same tables.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, FolderTree, Award, SlidersHorizontal, Hash } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { SectionsTab } from './SectionsTab';
import { BrandsTab } from './BrandsTab';
import { FacetsTab } from './FacetsTab';
import { HashtagsTab } from './HashtagsTab';
import { Notice, errMsg, fmtN, loadTaxonomy, useLoc, type NoticeState, type TaxonomyData } from './shared';

type Tab = 'sections' | 'brands' | 'facets' | 'hashtags';

export default function AdminTaxonomy() {
  const { dir, loc } = useLoc();
  const [tab, setTab] = useState<Tab>('sections');
  const [data, setData] = useState<TaxonomyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  // Two guards on one small function: a sequence number so a slow reload
  // cannot overwrite a newer one, and a re-throw so a caller that reloads
  // after a write ("deleted — refreshing") does not go on to report success
  // on a page that still shows the old rows.
  const seq = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const fresh = await loadTaxonomy();
      if (mine !== seq.current) return;
      setData(fresh);
      setErr(null);
    } catch (e) {
      if (mine === seq.current) setErr(errMsg(e));
      throw e;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    reload().catch(() => {
      /* the error is already on the page */
    });
  }, [reload]);

  const notify = useCallback((tone: NoticeState['tone'], text: string) => setNotice({ tone, text }), []);

  // The admin shell keeps a slot in its topbar for the page's own strip
  // (DashboardLayout `topbarSlot`); the breadcrumb goes there when it exists.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById('dash-topbar-slot'));
  }, []);
  const crumb = (
    <nav className={`${T.AP} hidden sm:flex items-center gap-1.5 text-[12.5px] text-[var(--ap-text-3)] min-w-0`} aria-label="breadcrumb" dir={dir}>
      <span>{loc('الإدارة', 'Admin')}</span>
      <span aria-hidden>/</span>
      <span className="text-[var(--ap-text-1)] font-semibold truncate">{loc('التصنيفات', 'Taxonomy', 'پۆلێنکردن')}</span>
    </nav>
  );

  const tabs: Array<{ id: Tab; ar: string; en: string; ckb: string; Icon: typeof FolderTree; count: number }> = [
    { id: 'sections', ar: 'الأقسام', en: 'Sections', ckb: 'بەشەکان', Icon: FolderTree, count: data?.catalogs.length ?? 0 },
    { id: 'brands', ar: 'العلامات التجارية', en: 'Brands', ckb: 'براندەکان', Icon: Award, count: data?.brands.length ?? 0 },
    { id: 'facets', ar: 'الفلاتر', en: 'Filters', ckb: 'فلتەرەکان', Icon: SlidersHorizontal, count: data?.facets.length ?? 0 },
    { id: 'hashtags', ar: 'الهاشتاقات', en: 'Hashtags', ckb: 'هاشتاگەکان', Icon: Hash, count: data?.hashtags.length ?? 0 },
  ];

  // A real tablist, not four toggle buttons wearing tab roles: one tab stop
  // for the whole strip, arrows move between tabs (mirrored in RTL), Home and
  // End jump to the ends, and each tab names the panel it controls.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const order = tabs.map((x) => x.id);
    const i = order.indexOf(tab);
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const fwd = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    let next: Tab | null = null;
    if (e.key === fwd) next = order[(i + 1) % order.length];
    else if (e.key === back) next = order[(i - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="taxonomy">
      {slot && createPortal(crumb, slot)}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold leading-tight text-[var(--ap-text-1)]">{loc('التصنيفات', 'Taxonomy', 'پۆلێنکردن')}</h1>
          <p className="mt-1 text-[12.5px] text-[var(--ap-text-3)] max-w-[60ch]">
            {loc(
              'الأقسام والعلامات والفلاتر والهاشتاقات التي يختار منها نموذج المنتج، والتي يعرضها قالب الاستيراد كقيم متاحة. أي تعديل هنا يظهر فورًا في النموذج وفي القالب التالي.',
              'The sections, brands, filters and hashtags the product form picks from, and the values the import template lists as accepted. Any change here shows up in the form and in the next template download.'
            )}
          </p>
        </div>
        <button type="button" className={T.btnIconLg} onClick={() => void reload().catch(() => {})} aria-label={loc('تحديث', 'Refresh', 'نوێکردنەوە')} title={loc('تحديث', 'Refresh', 'نوێکردنەوە')} data-tax-refresh>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      </header>

      <div
        role="tablist"
        aria-label={loc('أقسام صفحة التصنيفات', 'Taxonomy areas', 'بەشەکانی پەڕەی پۆلێنکردن')}
        className="flex flex-wrap gap-1.5"
        onKeyDown={onTabKeyDown}
      >
        {tabs.map(({ id, ar, en, ckb, Icon, count }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tax-tab-${id}`}
            aria-controls={`tax-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            onClick={() => setTab(id)}
            className={`${T.chip} h-9 px-3.5 aria-selected:text-[var(--ap-accent-text)] aria-selected:bg-[var(--ap-accent-soft)] aria-selected:border-[var(--ap-accent-border)]`}
            data-tax-tab={id}
          >
            <Icon className="w-3.5 h-3.5" aria-hidden />
            <span>{loc(ar, en, ckb)}</span>
            <span className={`${T.kbd} ms-0.5`}>{fmtN(count)}</span>
            <span className="sr-only">{loc(`${fmtN(count)} عنصر`, `${fmtN(count)} items`, `${fmtN(count)} دانە`)}</span>
          </button>
        ))}
      </div>

      {err && <Notice notice={{ tone: 'bad', text: err }} onClose={() => setErr(null)} />}
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {!data && loading ? (
        <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>{loc('جارٍ التحميل…', 'Loading…')}</div>
      ) : data ? (
        <div role="tabpanel" id={`tax-panel-${tab}`} aria-labelledby={`tax-tab-${tab}`} tabIndex={-1} data-tax-panel={tab}>
          {tab === 'sections' && <SectionsTab catalogs={data.catalogs} reload={reload} notify={notify} />}
          {tab === 'brands' && <BrandsTab brands={data.brands} reload={reload} notify={notify} />}
          {tab === 'facets' && <FacetsTab facets={data.facets} reload={reload} notify={notify} />}
          {tab === 'hashtags' && <HashtagsTab hashtags={data.hashtags} reload={reload} notify={notify} />}
        </div>
      ) : null}
    </div>
  );
}
