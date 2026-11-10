/**
 * ADMIN → المكافآت → نظرة عامة (owner, 2026-11-05: «every thing to admin side»;
 * docs/DECISIONS.md row 298). One read: the printers earning, what is due, how the
 * coupons went, what they took off orders, and what needs the shop's attention. Tiles
 * in the clay vocabulary and no chart library. No cost: «value spent» is what the
 * coupons took off orders, and the weekly figure is a ceiling, named as one.
 */
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Coins, Printer, ShieldCheck, Ticket, TimerReset } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { formatFigure, formatPercent } from '../../lib/localeNumber';
import { formatDateTime } from '../orders/format';
import { StatusChip } from '../ui/Badge';
import { KpiTile } from '../ui/KpiTile';
import { useRewardsRefusal } from './RewardsCoupons';

type Kind = 'free_shipping' | 'filament_discount';

interface Tally {
  issued: number;
  live: number;
  spent: number;
  expired: number;
  withdrawn: number;
  use_rate: number;
}

interface Value {
  goods_iqd: number;
  delivery_iqd: number;
  total_iqd: number;
}

export interface OverviewData {
  installed: boolean;
  server_time: string;
  printers: { earning: number; customers: number; due_now: number };
  coupons: Record<Kind, Tally> & { all: Tally };
  value_spent: { last_7_days: Value; last_30_days: Value; all_time: Value };
  points_taken_by_shop: number;
  weekly_exposure: { printers: number; per_printer_iqd: number; ceiling_iqd: number; filament_uncapped: boolean };
  last_issued_at: string | null;
  switches: { enabled: boolean; weekly: boolean; free_shipping: boolean; filament: boolean; shop_free_shipping: boolean; shop_filament: boolean; shop_products?: number; weekly_started: boolean };
  attention: { shop_without_price: Kind[]; filament_on_offer?: Array<{ id: string; name: { ar: string; en: string; ckb: string } }>; reviews_waiting: number; competitions_open: number; competitions_awaiting_verdict: number };
}

export type RewardsView = 'overview' | 'printers' | 'coupons' | 'competitions' | 'ads' | 'settings';

export default function RewardsOverview({ onGo }: { onGo: (view: RewardsView) => void }) {
  const { loc } = useLanguage();
  const refusal = useRewardsRefusal();
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .get<OverviewData>('/api/admin/rewards/overview')
      .then((r) => alive && setData(r))
      .catch((err) => alive && setError(refusal(err)));
    return () => {
      alive = false;
    };
  }, [refusal]);

  if (!data) {
    return error ? (
      <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>
    ) : (
      <p className="text-sm text-text-secondary">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>
    );
  }
  return <OverviewScreen data={data} onGo={onGo} />;
}

export function OverviewScreen({ data, onGo }: { data: OverviewData; onGo: (view: RewardsView) => void }) {
  const { loc, lang } = useLanguage();
  const { money } = useMoney();
  const { printers, coupons, value_spent: value, weekly_exposure: weekly, switches, attention } = data;
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  const fig = (n: number) => formatFigure(n, l);
  const liveHint = loc(
    `توصيل ${fig(coupons.free_shipping.live)} · فلامنت ${fig(coupons.filament_discount.live)}`,
    `Delivery ${fig(coupons.free_shipping.live)} · filament ${fig(coupons.filament_discount.live)}`,
    `گەیاندن ${fig(coupons.free_shipping.live)} · فیلامێنت ${fig(coupons.filament_discount.live)}`
  );
  return (
    <div className="space-y-3" data-admin-rewards-overview>
      {!data.installed && (
        <div className="lv-alert lv-alert-danger text-xs text-text-primary">
          {loc('جداول المكافآت غير مثبّتة على هذه القاعدة بعد.', 'The rewards tables are not on this database yet.', 'خشتەکانی خەڵات هێشتا لەم داتابەیسەدا نین.')}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiTile
          icon={<Printer className="w-4 h-4" />}
          label={loc('طابعات تكسب الآن', 'Printers earning now', 'چاپکەری چالاک')}
          value={fig(printers.earning)}
          hint={loc(`الزبائن: ${fig(printers.customers)}`, `Customers: ${fig(printers.customers)}`, `کڕیارەکان: ${fig(printers.customers)}`)}
        />
        <KpiTile
          icon={<TimerReset className="w-4 h-4" />}
          label={loc('مستحقة الآن', 'Due now', 'ئێستا پێویستە')}
          value={fig(printers.due_now)}
          hint={loc('تصدرها الدفعات القادمة', 'The next runs issue them', 'خولەکانی داهاتوو دەریاندەکەن')}
        />
        <KpiTile icon={<Ticket className="w-4 h-4" />} label={loc('كوبونات صالحة', 'Coupons live', 'کۆپۆنی چالاک')} value={fig(coupons.all.live)} hint={liveHint} />
        <KpiTile
          icon={<Coins className="w-4 h-4" />}
          label={loc('نقاط أخذها المتجر', 'Points redeemed', 'خاڵی خەرجکراو')}
          value={fig(data.points_taken_by_shop)}
          hint={loc('ثمن كوبونات ومنتجات متجر النقاط', 'The price of points-shop coupons and products', 'نرخی کۆپۆن و بەرهەمەکانی فرۆشگای خاڵ')}
        />
      </div>

      <section className="lv-surface p-4" data-overview-coupons>
        <h3 className="text-[14px] font-bold text-text-primary">{loc('الكوبونات', 'Coupons', 'کۆپۆنەکان')}</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[320px] text-[12.5px] tabular-nums">
            <thead className="text-text-muted">
              <tr>
                <th scope="col" className="py-1 text-start font-medium" />
                <th scope="col" className="px-1 py-1 text-end font-medium">{loc('صدر', 'Issued', 'دەرچوو')}</th>
                <th scope="col" className="px-1 py-1 text-end font-medium">{loc('صُرف', 'Spent', 'خەرجکرا')}</th>
                <th scope="col" className="px-1 py-1 text-end font-medium">{loc('انتهى', 'Expired', 'بەسەرچوو')}</th>
                <th scope="col" className="px-1 py-1 text-end font-medium">{loc('سُحب', 'Withdrawn', 'کشێنرایەوە')}</th>
                <th scope="col" className="ps-1 py-1 text-end font-medium">{loc('الاستخدام', 'Use', 'بەکارهێنان')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle text-text-primary">
              {(
                [
                  ['free_shipping', loc('توصيل', 'Delivery', 'گەیاندن')],
                  ['filament_discount', loc('فلامنت', 'Filament', 'فیلامێنت')],
                  ['all', loc('الكل', 'All', 'هەموو')],
                ] as const
              ).map(([k, name]) => (
                <tr key={k} className={k === 'all' ? 'font-bold' : ''}>
                  <th scope="row" className="py-1.5 text-start font-medium text-text-secondary">{name}</th>
                  <td className="px-1 py-1.5 text-end">{fig(coupons[k].issued)}</td>
                  <td className="px-1 py-1.5 text-end">{fig(coupons[k].spent)}</td>
                  <td className="px-1 py-1.5 text-end">{fig(coupons[k].expired)}</td>
                  <td className="px-1 py-1.5 text-end">{fig(coupons[k].withdrawn)}</td>
                  <td className="ps-1 py-1.5 text-end">{formatPercent(coupons[k].use_rate, l, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="lv-surface p-4" data-overview-value>
        <h3 className="text-[14px] font-bold text-text-primary">{loc('ما خصمته الكوبونات', 'What the coupons took off', 'ئەوەی کۆپۆنەکان کەمیان کردەوە')}</h3>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(
            [
              [loc('آخر 7 أيام', 'Last 7 days', '7 ڕۆژی ڕابردوو'), value.last_7_days],
              [loc('آخر 30 يومًا', 'Last 30 days', '30 ڕۆژی ڕابردوو'), value.last_30_days],
              [loc('منذ البداية', 'All time', 'لە سەرەتاوە'), value.all_time],
            ] as const
          ).map(([name, v]) => (
            <div key={name} className="lv-well rounded-md p-3">
              <p className="text-[12px] font-semibold text-text-muted">{name}</p>
              <p className="mt-1 text-[16px] font-bold tabular-nums text-text-primary">{money(v.total_iqd)}</p>
              <p className="mt-1 text-[12px] leading-5 tabular-nums text-text-secondary">
                {loc('منتجات', 'Goods', 'بەرهەم')} {money(v.goods_iqd)}
                <br />
                {loc('توصيل', 'Delivery', 'گەیاندن')} {money(v.delivery_iqd)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="lv-surface p-4" data-overview-exposure>
        <h3 className="text-[14px] font-bold text-text-primary">{loc('سقف هذا الأسبوع', 'This week’s ceiling', 'سنووری ئەم هەفتەیە')}</h3>
        <p className="mt-1 text-[20px] font-bold tabular-nums text-text-primary">{money(weekly.ceiling_iqd)}</p>
        <p className="mt-1 text-[12px] leading-5 text-text-secondary">
          {loc(
            `الطابعات (${fig(weekly.printers)}) × ${money(weekly.per_printer_iqd)}: سقف الإعدادات (كوبون التوصيل + أعلى خصم مسموح لكوبون الفلامنت)، لا ما سيُصرف فعلًا. خصم الفلامنت الحقيقي نسبة من سعر القطعة، وغالبًا أقل من هذا السقف بكثير.`,
            `Printers (${fig(weekly.printers)}) × ${money(weekly.per_printer_iqd)}: the ceiling of the settings (the delivery coupon + the largest discount the filament coupon may take), not what will be spent. The real filament discount is a percentage of the piece’s price, usually far below this ceiling.`,
            `چاپکەرەکان (${fig(weekly.printers)}) × ${money(weekly.per_printer_iqd)}: سنووری ڕێکخستنەکان (کۆپۆنی گەیاندن + زۆرترین داشکاندنی ڕێگەپێدراوی کۆپۆنی فیلامێنت)، نەک ئەوەی بەڕاستی خەرج دەکرێت. داشکاندنی ڕاستەقینەی فیلامێنت ڕێژەیەکە لە نرخی پارچەکە و زۆربەی جار زۆر لەم سنوورە کەمترە.`
          )}
          {weekly.filament_uncapped &&
            ` ${loc('كوبون الفلامنت بلا سقف، فهو خارج هذا الرقم.', 'The filament coupon has no ceiling, so it is left out of this figure.', 'کۆپۆنی فیلامێنت سنووری نییە، بۆیە لەم ژمارەیەدا نییە.')}`}
        </p>
      </section>

      <section className="lv-surface p-4 space-y-2" data-overview-switches>
        <h3 className="flex items-center gap-2 text-[14px] font-bold text-text-primary">
          <ShieldCheck className="w-4 h-4 text-text-secondary" aria-hidden />
          {loc('حالة البرنامج', 'The programme', 'دۆخی بەرنامەکە')}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              [loc('البرنامج', 'Programme', 'بەرنامە'), switches.enabled],
              [loc('كل أسبوع', 'Every week', 'هەموو هەفتەیەک'), switches.weekly && switches.weekly_started],
              [loc('كوبون التوصيل', 'Delivery coupon', 'کۆپۆنی گەیاندن'), switches.free_shipping],
              [loc('كوبون الفلامنت', 'Filament coupon', 'کۆپۆنی فیلامێنت'), switches.filament],
              [loc('توصيل بالنقاط', 'Delivery for points', 'گەیاندن بە خاڵ'), switches.shop_free_shipping],
              [loc('فلامنت بالنقاط', 'Filament for points', 'فیلامێنت بە خاڵ'), switches.shop_filament],
              [loc(`منتجات بالنقاط: ${fig(switches.shop_products ?? 0)}`, `Products for points: ${fig(switches.shop_products ?? 0)}`, `بەرهەم بە خاڵ: ${fig(switches.shop_products ?? 0)}`), (switches.shop_products ?? 0) > 0],
            ] as const
          ).map(([name, on]) => (
            <StatusChip key={name} tone={on ? 'success' : 'neutral'}>{name}</StatusChip>
          ))}
        </div>
        <p className="text-[12px] leading-5 text-text-muted">
          {loc('آخر إصدار', 'Last issued', 'دوایین دەرچوون')}: {data.last_issued_at ? formatDateTime(data.last_issued_at, lang) : '—'}
        </p>
      </section>

      <AttentionList attention={attention} onGo={onGo} />
    </div>
  );
}

function AttentionList({ attention, onGo }: { attention: OverviewData['attention']; onGo: (view: RewardsView) => void }) {
  const { loc, dir, lang } = useLanguage();
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  const Forward = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const row = 'flex min-h-12 w-full items-center justify-between gap-3 px-1 py-2 text-start text-[13px] leading-5 text-text-primary hover:bg-surface-raised transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const unpriced = attention.shop_without_price.length;
  const onOffer = attention.filament_on_offer ?? [];
  const nothing = unpriced === 0 && onOffer.length === 0 && attention.reviews_waiting === 0 && attention.competitions_open === 0 && attention.competitions_awaiting_verdict === 0;
  return (
    <section className="lv-surface p-4" data-overview-attention>
      <h3 className="text-[14px] font-bold text-text-primary">{loc('تحتاج انتباهك', 'Needs your attention', 'پێویستی بە سەرنجی تۆیە')}</h3>
      {nothing && <p className="mt-1 text-[12.5px] text-text-muted">{loc('لا شيء الآن.', 'Nothing right now.', 'ئێستا هیچ نییە.')}</p>}
      <div className="mt-1 divide-y divide-border-subtle">
        {onOffer.length > 0 && (
          <button type="button" className={row} onClick={() => onGo('settings')} data-attention="filament-offer">
            <span className="min-w-0">
              {loc('كوبون الفلامنت لا يأخذ شيئًا من منتج عليه عرض: ', 'The filament coupon takes nothing from a product with an offer: ', 'کۆپۆنی فیلامێنت هیچ لەو بەرهەمە کەم ناکاتەوە کە ئۆفەری لەسەرە: ')}
              <bdi>{onOffer.map((p) => p.name[l] || p.name.ar).join(l === 'en' ? ', ' : '، ')}</bdi>
            </span>
            <Forward className="w-4 h-4 shrink-0 text-text-muted" aria-hidden />
          </button>
        )}
        {unpriced > 0 && (
          <button type="button" className={row} onClick={() => onGo('settings')} data-attention="shop">
            <span>
              {unpriced > 1
                ? loc('كوبونا متجر النقاط بلا سعر', 'Both points-shop coupons have no price', 'هەردوو کۆپۆنی فرۆشگای خاڵ نرخیان نییە')
                : loc('كوبون في متجر النقاط بلا سعر', 'A points-shop coupon has no price', 'کۆپۆنێکی فرۆشگای خاڵ نرخی نییە')}
            </span>
            <Forward className="w-4 h-4 shrink-0 text-text-muted" aria-hidden />
          </button>
        )}
        {attention.reviews_waiting > 0 && (
          <a className={row} href="/admin?tab=reviews" data-attention="reviews">
            <span>{loc(`هدايا مراجعات بانتظار القرار: ${attention.reviews_waiting}`, `Review gifts waiting for a decision: ${attention.reviews_waiting}`, `دیارییەکانی هەڵسەنگاندن چاوەڕێی بڕیارن: ${attention.reviews_waiting}`)}</span>
            <Forward className="w-4 h-4 shrink-0 text-text-muted" aria-hidden />
          </a>
        )}
        {attention.competitions_awaiting_verdict > 0 && (
          <button type="button" className={row} onClick={() => onGo('competitions')} data-attention="verdict">
            <span>{loc(`مسابقات انتهت بانتظار الفائزين: ${attention.competitions_awaiting_verdict}`, `Competitions ended, waiting for winners: ${attention.competitions_awaiting_verdict}`, `پێشبڕکێی کۆتاییهاتوو چاوەڕێی براوەکانن: ${attention.competitions_awaiting_verdict}`)}</span>
            <Forward className="w-4 h-4 shrink-0 text-text-muted" aria-hidden />
          </button>
        )}
        {attention.competitions_open > 0 && (
          <button type="button" className={row} onClick={() => onGo('competitions')} data-attention="open">
            <span>{loc(`مسابقات مفتوحة الآن: ${attention.competitions_open}`, `Competitions open now: ${attention.competitions_open}`, `پێشبڕکێی ئێستا کراوە: ${attention.competitions_open}`)}</span>
            <Forward className="w-4 h-4 shrink-0 text-text-muted" aria-hidden />
          </button>
        )}
      </div>
      {/* Those screens are their own: this only points at them. */}
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] leading-5" data-overview-pointers>
        <a className="text-text-secondary underline underline-offset-2 hover:text-text-primary" href="/admin?tab=reviews">{loc('المراجعات', 'Reviews', 'هەڵسەنگاندنەکان')}</a>
        <a className="text-text-secondary underline underline-offset-2 hover:text-text-primary" href="/admin?tab=gifts">{loc('الهدايا', 'Gifts', 'دیارییەکان')}</a>
      </p>
    </section>
  );
}
