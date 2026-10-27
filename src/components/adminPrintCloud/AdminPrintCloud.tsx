/**
 * «الطباعة السحابية» — the Levonis Print Cloud console (Admin → Services).
 *
 * Every screen the backend's administration API serves
 * (worker/routes/printCloudAdmin.ts, docs/PRINT_CLOUD.md §10.2): the service
 * switch and settings, the catalogue and its prices, the workshop's stock, the
 * printers and their agents, the jobs and the queue, orders and payments,
 * customers' balances, shipments, buybacks, reports, reconciliation, tasks
 * and the audit trail.
 *
 * ONE CHUNK PER SECTION. This file is the frame — a title, the service's
 * open/closed state, and the section chips; each section is its own lazy
 * chunk, fetched the first time its chip is pressed, so opening the console
 * downloads the overview and nothing else.
 *
 * WHAT A READER CANNOT DO IS NOT OFFERED (access.ts). An assistant admin — the
 * workshop operator — sees no order, customer or buyback section (every one
 * of those routes needs money scope) and no cost anywhere; the owner alone
 * sees costs and profit and opens the service. The server refuses regardless.
 *
 * HONEST BY CONSTRUCTION: every figure is the server's; an empty list is said
 * to be empty (the live database starts empty); a state the server reports
 * as stale, not connected or awaiting an estimate is shown as exactly that.
 */
import React, { Suspense, lazy, useCallback, useState } from 'react';
import { Printer } from 'lucide-react';
import '../adminProducts/theme.css';
import { usePcAccess } from './access';
import { pc, type ServiceStatus } from './api';
import { tri } from './i18n';
import { Chips, RefreshButton, T, W, useLoad, usePcLang } from './ui';
import { StatusChip } from '../ui/Badge';

const OverviewSection = lazy(() => import('./sections/OverviewSection'));
const SettingsSection = lazy(() => import('./sections/SettingsSection'));
const CatalogSection = lazy(() => import('./sections/CatalogSection'));
const StockSection = lazy(() => import('./sections/StockSection'));
const PrintersSection = lazy(() => import('./sections/PrintersSection'));
const JobsSection = lazy(() => import('./sections/JobsSection'));
const OrdersSection = lazy(() => import('./sections/OrdersSection'));
const CustomersSection = lazy(() => import('./sections/CustomersSection'));
const ShipmentsSection = lazy(() => import('./sections/ShipmentsSection'));
const BuybacksSection = lazy(() => import('./sections/BuybacksSection'));
const ReportsSection = lazy(() => import('./sections/ReportsSection'));
const SystemSection = lazy(() => import('./sections/SystemSection'));

export type SectionId =
  | 'overview'
  | 'settings'
  | 'catalog'
  | 'stock'
  | 'printers'
  | 'jobs'
  | 'orders'
  | 'customers'
  | 'shipments'
  | 'buybacks'
  | 'reports'
  | 'system';

/** Where a section may send the reader: another section, with what to open there. */
export type Go = (section: SectionId, params?: Record<string, string>) => void;

export interface SectionProps {
  params: Record<string, string>;
  go: Go;
}

const S = {
  title: tri('الطباعة السحابية', 'Print Cloud', 'چاپی هەوری'),
  subtitle: tri(
    'تأجير ساعات طابعات الورشة عن بُعد: الكتالوج والأسعار والمخزون والطابعات والمهام والطلبات — كل رقم هنا من الخادم.',
    'Remote rental of the workshop’s printers: catalogue, prices, stock, printers, jobs and orders — every figure here is the server’s.',
    'بەکرێدانی چاپکەرەکانی کارگە لە دوورەوە: کاتالۆگ و نرخ و کۆگا و چاپکەر و کار و داواکاری — هەموو ژمارەیەک لێرە هی ڕاژەکارە.'
  ),
  sections: tri('أقسام الطباعة السحابية', 'Print Cloud sections', 'بەشەکانی چاپی هەوری'),
  open: tri('مفتوحة للعملاء', 'Open to customers', 'بۆ کڕیاران کراوەیە'),
  closed: tri('مغلقة للعملاء', 'Closed to customers', 'بۆ کڕیاران داخراوە'),
  notInstalled: tri('غير مثبتة على قاعدة البيانات', 'Not installed on the database', 'لەسەر بنکەدراوە دانەمەزراوە'),
  roleOperator: tri('صلاحيتك: مشغّل الورشة — الأسعار والمدفوعات والتكاليف مخفية.', 'Your access: workshop operator — prices, payments and costs are hidden.', 'دەسەڵاتت: کارپێکەری کارگە — نرخ و پارەدان و تێچوو شاردراونەتەوە.'),
  roleMoney: tri('صلاحيتك: مدير مالي — التكاليف للمالك وحده.', 'Your access: full admin — costs are the owner’s alone.', 'دەسەڵاتت: بەڕێوەبەری دارایی — تێچوو تەنها هی خاوەنە.'),
  roleOwner: tri('صلاحيتك: المالك — كل شيء، بما فيه التكاليف.', 'Your access: the owner — everything, costs included.', 'دەسەڵاتت: خاوەن — هەموو شتێک، تێچووش.'),
};

const LABELS: Record<SectionId, ReturnType<typeof tri>> = {
  overview: tri('نظرة عامة', 'Overview', 'تێڕوانینی گشتی'),
  settings: tri('الإعدادات', 'Settings', 'ڕێکخستنەکان'),
  catalog: tri('الكتالوج والأسعار', 'Catalogue & prices', 'کاتالۆگ و نرخەکان'),
  stock: tri('مخزون الورشة', 'Workshop stock', 'کۆگای کارگە'),
  printers: tri('الطابعات والوكلاء', 'Printers & agents', 'چاپکەر و بریکارەکان'),
  jobs: tri('المهام والطابور', 'Jobs & queue', 'کار و ڕیز'),
  orders: tri('الطلبات والمدفوعات', 'Orders & payments', 'داواکاری و پارەدان'),
  customers: tri('العملاء', 'Customers', 'کڕیاران'),
  shipments: tri('الشحنات', 'Shipments', 'ناردنەکان'),
  buybacks: tri('إعادة الشراء', 'Buybacks', 'کڕینەوە'),
  reports: tri('التقارير', 'Reports', 'ڕاپۆرتەکان'),
  system: tri('المطابقة والمهام والتدقيق', 'Reconcile, tasks & audit', 'هاوتاکردن و ئەرک و وردبینی'),
};

/** The sections that are money routes end to end: hidden from an assistant admin. */
const MONEY_SECTIONS: ReadonlySet<SectionId> = new Set(['orders', 'customers', 'buybacks']);

export default function AdminPrintCloud() {
  const { t, dir } = usePcLang();
  const access = usePcAccess();
  const [nav, setNav] = useState<{ section: SectionId; params: Record<string, string>; key: number }>({ section: 'overview', params: {}, key: 0 });
  const status = useLoad(() => pc.public<ServiceStatus>('/status'), []);

  const go = useCallback<Go>((section, params = {}) => setNav((cur) => ({ section, params, key: cur.key + 1 })), []);
  const order: SectionId[] = ['overview', 'jobs', 'printers', 'stock', 'shipments', 'catalog', 'orders', 'customers', 'buybacks', 'reports', 'system', 'settings'];
  const visible = order.filter((id) => access.money || !MONEY_SECTIONS.has(id));
  const section = visible.includes(nav.section) ? nav.section : 'overview';
  const props: SectionProps = { params: nav.params, go };

  const s = status.data;
  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-print-cloud-admin>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className={`flex items-center gap-2 text-[19px] font-bold ${T.text1}`}>
            <Printer className="h-5 w-5 text-gold" aria-hidden />
            {t(S.title)}
          </h1>
          <p className={`mt-1 max-w-3xl text-[12.5px] leading-relaxed ${T.text3}`}>{t(S.subtitle)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {s && !s.installed && <StatusChip tone="danger">{t(S.notInstalled)}</StatusChip>}
            {s && s.installed && <StatusChip tone={s.enabled ? 'success' : 'warning'}>{t(s.enabled ? S.open : S.closed)}</StatusChip>}
            <span className={`text-[11.5px] ${T.text3}`}>{t(access.costRead ? S.roleOwner : access.money ? S.roleMoney : S.roleOperator)}</span>
          </div>
        </div>
        <RefreshButton onClick={() => status.reload()} loading={status.loading} />
      </div>

      <Chips<SectionId> label={t(S.sections)} value={section} onChange={(id) => go(id)} items={visible.map((id) => ({ id, label: t(LABELS[id]) }))} />

      <Suspense
        fallback={
          <p role="status" className={`py-10 text-center text-[13px] ${T.text3}`}>
            {t(W.loading)}
          </p>
        }
      >
        <div key={nav.key} className="min-w-0">
          {section === 'overview' && <OverviewSection {...props} status={status} />}
          {section === 'settings' && <SettingsSection {...props} onSaved={() => void status.reload()} />}
          {section === 'catalog' && <CatalogSection {...props} />}
          {section === 'stock' && <StockSection {...props} />}
          {section === 'printers' && <PrintersSection {...props} />}
          {section === 'jobs' && <JobsSection {...props} />}
          {section === 'orders' && access.money && <OrdersSection {...props} />}
          {section === 'customers' && access.money && <CustomersSection {...props} />}
          {section === 'shipments' && <ShipmentsSection {...props} />}
          {section === 'buybacks' && access.money && <BuybacksSection {...props} />}
          {section === 'reports' && <ReportsSection {...props} />}
          {section === 'system' && <SystemSection {...props} />}
        </div>
      </Suspense>
    </div>
  );
}
