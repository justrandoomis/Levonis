/**
 * THE COMMAND CENTER — `/merchant`: «ما الذي يحتاج انتباهي الآن».
 *
 * One list of the things that are waiting on the merchant, each a door to
 * the screen where it is done, from ONE read (GET /api/merchant/attention,
 * shared with the shell's badges). Then this week in four figures from the
 * analytics report.
 *
 * WHAT IT WILL NOT DO:
 *   · show a row whose source did not answer — the server leaves the field
 *     out and so does this screen; a «0» here always means zero;
 *   · show a row for zero — the list is what needs attention, and «nothing
 *     waiting» is said once, in words, when every source answered and all
 *     of them are zero;
 *   · invent a trend — the figures, their week-on-week change and the
 *     fortnight line are the report's own rows (./kpis.ts says how);
 *   · stop a lapsed merchant — the analytics are PLUS, and without it the
 *     figures say so in one line instead of standing where the list is
 *     (audit 01 B17: the old Overview put an error on the landing screen).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ChevronRight, CircleCheck, ClipboardList, Hourglass, Inbox, MessageCircle, Package, PackageX,
  ShoppingBag, Star, Tag, Truck, Wallet,
} from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { api, ApiError } from '../../../../lib/api';
import { formatFigure } from '../../../../lib/localeNumber';
import { KpiTile, Sparkline } from '../../../ui/KpiTile';
import { Money } from '../../../ui/Money';
import { ErrorState } from '../../../ui/AsyncStates';
import { KpiRowSkeleton, ListRowsSkeleton } from '../../../ui/DashboardSkeletons';
import { merchantHref } from '../../../../lib/merchantRoutes';
import { useWorkspace } from '../context';
import type { Attention, StoreProblem } from '../attention';
import { commandKpis, type ReportLike } from '../kpis';
import { sellingReason, type Loc } from '../strings';

interface Row {
  id: string;
  icon: ReactNode;
  text: string;
  detail?: ReactNode;
  value: ReactNode;
  link: string;
  tone?: 'warning' | 'neutral';
}

const ic = (Icon: typeof ShoppingBag) => <Icon aria-hidden="true" className="h-5 w-5" />;

/** The rows, in the order a merchant should act on them. Zero and absent make no row. */
export function attentionRows(a: Attention, loc: Loc): Row[] {
  const rows: Row[] = [];
  const add = (cond: unknown, row: Row) => {
    if (cond) rows.push(row);
  };
  const o = a.orders;
  // OWNER: Sorani to be written by hand (every sentence of this list).
  add(o?.by_stage.pending, { id: 'orders-pending', icon: ic(ShoppingBag), text: loc('طلبات جديدة تنتظر تأكيدك', 'New orders waiting for you to confirm'), value: o?.by_stage.pending, link: o?.links.pending ?? '', tone: 'warning' });
  add(o?.by_stage.confirmed, { id: 'orders-confirmed', icon: ic(Package), text: loc('طلبات مؤكدة تنتظر التجهيز', 'Confirmed orders to prepare'), value: o?.by_stage.confirmed, link: o?.links.confirmed ?? '' });
  add(o?.by_stage.processing, { id: 'orders-processing', icon: ic(Truck), text: loc('طلبات قيد التجهيز تنتظر الشحن', 'Orders being prepared, waiting to ship'), value: o?.by_stage.processing, link: o?.links.processing ?? '' });
  const co = a.custom_orders;
  add(co?.to_start, { id: 'custom-start', icon: ic(ClipboardList), text: loc('طلبات مخصصة مدفوعة تنتظر أن تبدأ', 'Paid custom orders waiting for you to start'), value: co?.to_start, link: co?.link ?? '', tone: 'warning' });
  add(co?.in_progress, { id: 'custom-progress', icon: ic(Hourglass), text: loc('طلبات مخصصة قيد التنفيذ', 'Custom orders in progress'), value: co?.in_progress, link: co?.link ?? '' });
  const inbox = a.inbox;
  add(inbox?.threads, {
    id: 'inbox',
    icon: ic(MessageCircle),
    text: loc('محادثات فيها رسائل لم تقرأها', 'Conversations with messages you have not read'),
    detail: inbox && inbox.messages > inbox.threads ? loc(`${inbox.messages} رسالة`, `${inbox.messages} messages`) : undefined,
    value: inbox?.threads,
    link: inbox?.link ?? '',
  });
  add(a.requests?.matching, { id: 'requests', icon: ic(Inbox), text: loc('طلبات زبائن تطابق ورشتك ولم تقدّم عليها عرضًا', 'Customer requests that match your workshop, not yet answered'), value: a.requests?.matching, link: a.requests?.link ?? '' });
  const st = a.stock;
  add(st?.out, { id: 'stock-out', icon: ic(PackageX), text: loc('منتجات معروضة نفد مخزونها', 'Listed products that are sold out'), value: st?.out, link: st?.link_out ?? '', tone: 'warning' });
  add(st?.low, { id: 'stock-low', icon: ic(Package), text: loc('منتجات قارب مخزونها على النفاد', 'Products running low'), value: st?.low, link: st?.link_low ?? '' });
  const rv = a.reviews;
  add(rv?.new, { id: 'reviews-new', icon: ic(Star), text: loc('تقييمات جديدة لم تطّلع عليها', 'New reviews you have not seen'), value: rv?.new, link: rv?.link ?? '' });
  add(rv?.unanswered, { id: 'reviews-unanswered', icon: ic(Star), text: loc('تقييمات بلا رد منك', 'Reviews you have not replied to'), value: rv?.unanswered, link: rv?.link ?? '' });
  add(a.money && a.money.available_iqd > 0, { id: 'money', icon: ic(Wallet), text: loc('أرباح متاحة يمكنك طلب تحويلها', 'Earnings available to request'), value: <Money iqd={a.money?.available_iqd} />, link: a.money?.link ?? '' });
  const po = a.payouts;
  add(po?.in_flight, { id: 'payouts', icon: ic(Wallet), text: loc('طلبات تحويل أرباح قيد المعالجة', 'Payout requests being processed'), detail: po ? <Money iqd={po.amount_iqd} /> : undefined, value: po?.in_flight, link: po?.link ?? '' });
  const cp = a.coupons;
  add(cp?.ending_soon, { id: 'coupons', icon: ic(Tag), text: loc(`كوبونات تنتهي خلال ${cp?.within_days ?? 7} أيام`, `Coupons ending within ${cp?.within_days ?? 7} days`), value: cp?.ending_soon, link: cp?.link ?? '' });
  return rows.filter((r) => r.link);
}

/** The store problem, in words, and the verb that fixes it. */
function problemText(code: StoreProblem, loc: Loc): { text: string; action: string } {
  switch (code) {
    case 'layout_unpublished':
      // OWNER: Sorani to be written by hand.
      return { text: loc('في صفحة متجرك تعديلات محفوظة لم تُنشر بعد — الزبائن يرون النسخة السابقة.', 'Your store page has saved changes that are not published — customers see the previous version.'), action: loc('راجع وانشر', 'Review and publish') };
    case 'subscription_inactive':
      // OWNER: Sorani to be written by hand.
      return { text: sellingReason(code, loc), action: loc('جدّد الاشتراك', 'Renew') };
    case 'benefit_restricted':
    case 'store_suspended':
    case 'merchant_suspended':
    case 'merchant_restricted':
      // OWNER: Sorani to be written by hand.
      return { text: sellingReason(code, loc), action: code === 'benefit_restricted' ? loc('تواصل مع الدعم', 'Contact support') : loc('إعداد المتجر', 'Store setup', 'ڕێکخستنی فرۆشگا') };
    case 'store_paused':
    default:
      return { text: sellingReason(code, loc), action: loc('إعداد المتجر', 'Store setup', 'ڕێکخستنی فرۆشگا') };
  }
}

function Door({ to, className, children }: { to: string; className: string; children: ReactNode }) {
  const ws = useWorkspace();
  const target = ws.resolveLink(to);
  return target.internal ? (
    <Link to={target.to} className={className}>
      {children}
    </Link>
  ) : (
    <a href={target.to} className={className}>
      {children}
    </a>
  );
}

export default function CommandCenter() {
  const { loc, lang } = useLanguage();
  const ws = useWorkspace();
  const { data, error, loading, refresh } = ws.attention;

  const problems = data?.store?.problems ?? [];
  const rows = data ? attentionRows(data, loc) : [];
  // «Nothing waiting» is a claim about every source; one that did not answer forbids it.
  const everySource = !!data && ['orders', 'custom_orders', 'inbox', 'stock', 'reviews'].every((k) => k in data);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-[22px] font-bold leading-tight text-text-primary [text-wrap:balance]">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('ما الذي يحتاج انتباهك الآن', 'What needs your attention now')}
        </h1>
        <p className="text-[13px] text-text-muted">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('كل رقم هنا من سجلات متجرك الآن، وكل سطر يفتح المكان الذي تُنجزه فيه.', 'Every number here is counted from your store right now; every line opens where you act on it.')}
        </p>
      </header>

      {problems.length > 0 && (
        <section aria-labelledby="cc-problems" className="space-y-2">
          <h2 id="cc-problems" className="sr-only">
            {/* OWNER: Sorani to be written by hand. */}
            {loc('ما يمنع متجرك الآن', 'What is holding your store back')}
          </h2>
          <ul className="space-y-2">
            {problems.map((p) => {
              const t = problemText(p.code, loc);
              return (
                <li key={p.code} data-store-problem={p.code} className="flex flex-col gap-3 rounded-e-2xl border-s-2 border-s-warning/70 bg-warning/[0.06] py-3 pe-3 ps-3.5 sm:flex-row sm:items-center">
                  <AlertTriangle aria-hidden="true" className="hidden h-5 w-5 shrink-0 text-warning sm:block" />
                  <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-text-primary">{t.text}</p>
                  <Door to={p.link} className="lv-button lv-button-secondary lv-button-sm shrink-0 self-start sm:self-auto">
                    {t.action}
                  </Door>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="cc-waiting" className="space-y-3">
        <h2 id="cc-waiting" className="text-[15px] font-bold text-text-primary">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('بانتظارك', 'Waiting for you')}
        </h2>
        {loading && !data ? (
          <div className="lv-surface overflow-hidden">
            <ListRowsSkeleton rows={4} />
          </div>
        ) : !data ? (
          <ErrorState error={error} onRetry={() => refresh(true)} compact />
        ) : rows.length === 0 ? (
          <div className="lv-surface flex items-center gap-3 p-4" data-attention-clear={everySource || undefined}>
            <CircleCheck aria-hidden="true" className="h-5 w-5 shrink-0 text-success" />
            <p className="text-[13.5px] text-text-secondary">
              {everySource
                ? // OWNER: Sorani to be written by hand.
                  loc('لا شيء ينتظرك الآن. الطلبات والرسائل والمخزون كلها في حالها.', 'Nothing is waiting for you right now. Orders, messages and stock are all in hand.')
                : // OWNER: Sorani to be written by hand.
                  loc('لا شيء مما أمكن عدّه ينتظرك الآن.', 'Nothing that could be counted is waiting for you right now.')}
            </p>
          </div>
        ) : (
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden" data-attention-list>
            {rows.map((r) => (
              <li key={r.id} data-attention={r.id}>
                <Door
                  to={r.link}
                  className="group flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                >
                  <span aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] ${r.tone === 'warning' ? 'text-warning' : 'text-text-secondary'}`}>
                    {r.icon}
                  </span>
                  {/* The figure leads the sentence it counts — «3 طلبات جديدة…» —
                      so on a wide screen it is not a table's width away from its words. */}
                  <span className={`shrink-0 font-bold tabular-nums text-text-primary ${typeof r.value === 'number' ? 'min-w-7 text-[17px]' : 'text-[15px]'}`}>
                    {typeof r.value === 'number' ? <bdi>{formatFigure(r.value, lang)}</bdi> : r.value}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium leading-snug text-text-primary">{r.text}</span>
                    {r.detail && <span className="mt-0.5 block text-[12.5px] text-text-muted">{r.detail}</span>}
                  </span>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
                </Door>
              </li>
            ))}
          </ul>
        )}
      </section>

      <WeekFigures />
    </div>
  );
}

// ------------------------------------------------------------------ figures

function WeekFigures() {
  const { loc, lang } = useLanguage();
  const ws = useWorkspace();
  const [report, setReport] = useState<ReportLike | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [locked, setLocked] = useState(false);

  const load = () => {
    setError(null);
    api
      .get<{ success: true } & ReportLike>('/api/merchant/analytics/report')
      .then(setReport)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'ANALYTICS_NOT_INCLUDED') setLocked(true);
        else setError(e);
      });
  };
  useEffect(load, []);

  const k = report ? commandKpis(report) : null;
  const analytics = ws.href(merchantHref.analytics());
  const orders = ws.href(merchantHref.orders());
  // OWNER: Sorani to be written by hand (the week's labels).
  const vsLastWeek = loc('مقارنة بالأسبوع السابق', 'vs the week before');

  return (
    <section aria-labelledby="cc-week" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="cc-week" className="text-[15px] font-bold text-text-primary">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('اليوم وآخر 7 أيام', 'Today and the last 7 days')}
        </h2>
        {!locked && (
          <Link to={analytics} className="rounded-md text-[13px] font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {/* OWNER: Sorani to be written by hand. */}
            {loc('كل التحليلات', 'All analytics')}
          </Link>
        )}
      </div>
      {locked ? (
        <p className="text-[13px] leading-relaxed text-text-muted" data-analytics-locked>
          {/* OWNER: Sorani to be written by hand. */}
          {loc('الأرقام جزء من LEVO PLUS. طلباتك وأرباحك كلها محفوظة وتراها في صفحاتها — جدّد الاشتراك لتعود الأرقام.', 'The figures are part of LEVO PLUS. Your orders and earnings are all kept and visible on their screens — renew to see the figures again.')}
        </p>
      ) : error ? (
        <ErrorState error={error} onRetry={load} compact />
      ) : !k ? (
        <KpiRowSkeleton count={4} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-command-kpis>
          <KpiTile label={loc('طلبات اليوم', 'Orders today')} value={<bdi>{formatFigure(k.today.orders, lang)}</bdi>} to={orders} />
          <KpiTile label={loc('مبيعات اليوم', 'Sales today')} value={<Money iqd={k.today.gross_iqd} />} to={analytics} />
          <KpiTile
            label={loc('طلبات آخر 7 أيام', 'Orders, last 7 days')}
            value={<bdi>{formatFigure(k.week.orders, lang)}</bdi>}
            delta={k.week.previous ? { value: k.week.orders - k.week.previous.orders, format: 'number', label: vsLastWeek } : null}
            trend={k.week.trend ? <Sparkline series={k.week.trend} /> : undefined}
            to={analytics}
          />
          <KpiTile
            label={loc('مبيعات آخر 7 أيام', 'Sales, last 7 days')}
            value={<Money iqd={k.week.gross_iqd} />}
            delta={k.week.previous ? { value: k.week.gross_iqd - k.week.previous.gross_iqd, format: 'money', label: vsLastWeek } : null}
            hint={k.visitors7 !== undefined ? loc(`${formatFigure(k.visitors7, lang)} زائر`, `${formatFigure(k.visitors7, lang)} visitors`) : undefined}
            to={analytics}
          />
        </div>
      )}
    </section>
  );
}
