/**
 * مزايا العضوية — what a PREMIUM or a PRO membership is worth, as the owner
 * edits it.
 *
 * Every commercial value PRO and PREMIUM shopping benefits are made of is a row
 * in `membership_benefit_rules`: a percentage, a fixed amount, a ceiling, how
 * many units qualify, the sections it covers, the delivery methods a waiver
 * reaches, whether the cash-on-delivery tax is waived, the dates it runs
 * between. This screen is the only place they are written, and NONE of them is
 * a constant in this application — the owner changes a number and the next
 * order follows, with no deploy (docs/MEMBERSHIP_BENEFITS.md).
 *
 * Three panels: the rules, the simulator that prices a basket through the same
 * functions the checkout uses, and the version history that says who changed
 * what and what it was before.
 *
 * The visual language is «التصنيفات»' — the same `.ap` tokens, the same table,
 * dialog and notice primitives — because this is another admin vocabulary
 * screen and it should not look like a different product.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BadgePercent, FlaskConical, History, RefreshCw } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { Notice, errMsg, fmtN, useLoc, type CatalogNode, type NoticeState } from '../adminTaxonomy/shared';
import RulesTab from './RulesTab';
import SimulatorTab from './SimulatorTab';
import VersionsTab from './VersionsTab';
import {
  loadBenefits,
  loadCatalogs,
  loadVersions,
  notesFromVersions,
  resolveProductNames,
  type BenefitsPayload,
  type VersionRow,
} from './shared';

type Tab = 'rules' | 'simulator' | 'versions';

export default function AdminBenefits() {
  const { dir, lang, loc } = useLoc();
  const [tab, setTab] = useState<Tab>('rules');
  const [data, setData] = useState<BenefitsPayload | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogNode[]>([]);
  const [productNames, setProductNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  // A sequence number so a slow reload cannot overwrite a newer one, and a
  // re-throw so a caller that reloads after a write does not report success on
  // a page that still shows the old rules.
  const seq = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const [benefits, history, taxonomy] = await Promise.all([loadBenefits(), loadVersions(), loadCatalogs()]);
      if (mine !== seq.current) return;
      setData(benefits);
      setVersions(history.versions ?? []);
      setCatalogs(taxonomy.catalogs ?? []);
      setErr(null);
      // The product-scoped rules name a product by id; the list resolves the
      // names afterwards so a slow catalogue never delays the rules.
      const ids = (benefits.rules ?? []).filter((r) => r.scope === 'product' && r.product_id).map((r) => r.product_id!);
      if (ids.length) {
        const names = await resolveProductNames(ids, lang);
        if (mine === seq.current) setProductNames(names);
      }
    } catch (e) {
      if (mine === seq.current) setErr(errMsg(e));
      throw e;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [lang]);

  useEffect(() => {
    reload().catch(() => {
      /* the error is already on the page */
    });
  }, [reload]);

  const notify = useCallback((tone: NoticeState['tone'], text: string) => setNotice({ tone, text }), []);
  const notes = useMemo(() => notesFromVersions(versions), [versions]);

  // The admin shell keeps a slot in its topbar for the page's own strip.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById('dash-topbar-slot'));
  }, []);
  const crumb = (
    <nav
      className={`${T.AP} hidden sm:flex items-center gap-1.5 text-[12.5px] text-[var(--ap-text-3)] min-w-0`}
      aria-label="breadcrumb"
      dir={dir}
    >
      <span>{loc('الإدارة', 'Admin')}</span>
      <span aria-hidden>/</span>
      <span className="text-[var(--ap-text-1)] font-semibold truncate">{loc('مزايا العضوية', 'Membership benefits')}</span>
    </nav>
  );

  const tabs: Array<{ id: Tab; ar: string; en: string; Icon: typeof BadgePercent; count: number | null }> = [
    { id: 'rules', ar: 'القواعد', en: 'Rules', Icon: BadgePercent, count: data?.rules.length ?? 0 },
    { id: 'simulator', ar: 'المحاكاة', en: 'Simulator', Icon: FlaskConical, count: null },
    { id: 'versions', ar: 'سجل التغييرات', en: 'History', Icon: History, count: versions.length },
  ];

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
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="membership-benefits">
      {slot && createPortal(crumb, slot)}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold leading-tight text-[var(--ap-text-1)]">
            {loc('مزايا العضوية', 'Membership benefits')}
          </h1>
          <p className="mt-1 text-[12.5px] text-[var(--ap-text-3)] max-w-[60ch]">
            {loc(
              'كل قيمة تجارية تمنحها عضوية PREMIUM أو PRO تُكتب هنا: الخصم على المنتجات، التوصيل المجاني وطرقه، والإعفاء من ضريبة الدفع عند الاستلام. التعديل يسري على الطلب التالي بلا نشر، ولا يمسّ أي طلب سابق.',
              'Every commercial value a PREMIUM or PRO membership grants is written here: the discount on goods, free delivery and the methods it covers, and the exemption from the cash-on-delivery tax. A change applies to the next order with no deploy, and touches no order already placed.'
            )}
          </p>
          {data?.version_id != null && (
            <p className="mt-1 font-mono text-[11px] text-[var(--ap-text-3)]" dir="ltr">
              {loc('نسخة الإعدادات', 'Configuration version')} #{data.version_id}
            </p>
          )}
        </div>
        <button
          type="button"
          className={T.btnIconLg}
          onClick={() => void reload().catch(() => {})}
          aria-label={loc('تحديث', 'Refresh', 'نوێکردنەوە')}
          title={loc('تحديث', 'Refresh', 'نوێکردنەوە')}
          data-mb-refresh
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      </header>

      <div
        role="tablist"
        aria-label={loc('أقسام صفحة مزايا العضوية', 'Membership benefit areas')}
        className="flex flex-wrap gap-1.5"
        onKeyDown={onTabKeyDown}
      >
        {tabs.map(({ id, ar, en, Icon, count }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`mb-tab-${id}`}
            aria-controls={`mb-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            onClick={() => setTab(id)}
            className={`${T.chip} h-9 px-3.5 aria-selected:text-[var(--ap-accent-text)] aria-selected:bg-[var(--ap-accent-soft)] aria-selected:border-[var(--ap-accent-border)]`}
            data-mb-tab={id}
          >
            <Icon className="w-3.5 h-3.5" aria-hidden />
            <span>{loc(ar, en)}</span>
            {count !== null && <span className={`${T.kbd} ms-0.5`}>{fmtN(count)}</span>}
          </button>
        ))}
      </div>

      {err && <Notice notice={{ tone: 'bad', text: err }} onClose={() => setErr(null)} />}
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {!data && loading ? (
        <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>
          {loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')}
        </div>
      ) : data ? (
        <div role="tabpanel" id={`mb-panel-${tab}`} aria-labelledby={`mb-tab-${tab}`} tabIndex={-1}>
          {tab === 'rules' && (
            <RulesTab
              rules={data.rules}
              schema={data.schema}
              catalogs={catalogs}
              productNames={productNames}
              notes={notes}
              reload={reload}
              notify={notify}
            />
          )}
          {tab === 'simulator' && <SimulatorTab schema={data.schema} />}
          {tab === 'versions' && (
            <VersionsTab versions={versions} schema={data.schema} catalogs={catalogs} productNames={productNames} />
          )}
        </div>
      ) : null}
    </div>
  );
}
