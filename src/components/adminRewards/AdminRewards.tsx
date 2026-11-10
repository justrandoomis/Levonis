/**
 * ADMIN → المكافآت (migration 0220; docs/DECISIONS.md row 286).
 *
 * Five screens over /api/admin/rewards:
 *   نظرة عامة   what the programme does now and what it has given (./RewardsOverview).
 *   الطابعات    every printer unit, earning or why not, and its coupons (./RewardsPrinters).
 *   الكوبونات   every reward coupon issued, its customer and its state, with «منح كوبون»,
 *               «سحب» and «تمديد» (./RewardsCoupons).
 *   المسابقات   drafts, publishing (the owner), entries, winners and cancels.
 *   الإعدادات   the programme's terms: what a delivered printer earns, and for
 *               how many months of its warranty, every week (the free-delivery
 *               coupon — its amount and the order it needs — and the filament
 *               coupon — its percentage, its ceiling, how many pieces and the
 *               filaments it covers), how long a coupon lasts, and what the
 *               points shop charges and sells (./RewardsShopProducts). The owner's
 *               to save: the server refuses everyone else (OWNER_REQUIRED).
 *   الإعلانات   the video ads of «شاهد إعلانًا» (AdminAds.tsx, migration 0227).
 *
 * Nothing here decides money: each figure is validated and applied by the
 * server, and a refusal is shown in the server's own words.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Gift, Settings2, Loader2, Check, Info } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { countText } from '../rewards/copy';
import { Segmented } from '../ui/Segmented';
import AdminCompetitions from './AdminCompetitions';
import AdminAds from './AdminAds';
import RewardsCoupons, { useRewardsRefusal, type CustomerFilter } from './RewardsCoupons';
import RewardsOverview, { type RewardsView } from './RewardsOverview';
import RewardsPrinters from './RewardsPrinters';
import { shopProductRefusal, type ShopProductRow, type ShopProductView } from './shopProductWords';

const RewardsShopProducts = lazy(() => import('./RewardsShopProducts'));

type Tri = { ar: string; en: string; ckb: string };
type Kind = 'free_shipping' | 'filament_discount';

interface Config {
  enabled: boolean;
  valid_days: number;
  weekly: { enabled: boolean; months: number };
  free_shipping: { enabled: boolean; amount_iqd: number; min_order_iqd: number };
  filament: { enabled: boolean; percent: number; max_discount_iqd: number | null; product_ids: string[]; max_pieces: number; on_offer?: boolean };
  shop: Record<Kind, { enabled: boolean; points: number | null }> & { items?: ShopProductRow[] };
}

interface Filament { id: string; slug: string; name: Tri; status: string; on_offer?: boolean }

const label = 'block text-text-secondary text-[11px] font-bold mb-1.5';

export default function AdminRewards() {
  const { loc } = useLanguage();
  const [view, setView] = useState<RewardsView>('overview');
  // «كل كوبونات هذا الزبون» from a printer: the coupons tab, narrowed to them.
  const [customer, setCustomer] = useState<CustomerFilter | null>(null);
  return (
    <div className="space-y-6" data-admin-rewards>
      <div>
        <h2 className="text-text-primary font-bold text-lg flex items-center gap-2">
          <Gift className="w-5 h-5 text-gold" aria-hidden />
          {loc('المكافآت', 'Rewards', 'خەڵاتەکان')}
        </h2>
        <p className="text-text-secondary text-xs mt-1">
          {loc(
            'تصدر كل أسبوع لكل طابعة تحت الضمان، والزبون يراها في صفحة المكافآت ويطبّقها من سلته.',
            'Issued every week for each printer under warranty; the customer sees them on the Rewards page and applies them from the cart.',
            'هەموو هەفتەیەک بۆ هەر چاپکەرێکی ژێر گەرەنتی دەردەچن، و کڕیار لە پەڕەی خەڵاتەکان دەیانبینێت و لە سەبەتەکەیەوە جێبەجێیان دەکات.'
          )}
        </p>
      </div>
      {/* Six names: two rows of three on a phone, one row from about 700 px. Nothing is cut or scrolled away, and every tab is 44 px. Inline: the stylesheet pays nothing. */}
      <Segmented
        value={view}
        onChange={(v) => setView(v as typeof view)}
        group="admin-rewards"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(6.5rem, 1fr))', borderRadius: '1.5rem' }}
        items={[
          { id: 'overview', label: loc('نظرة عامة', 'Overview', 'پوختە') },
          { id: 'printers', label: loc('الطابعات', 'Printers', 'چاپکەران') },
          { id: 'coupons', label: loc('الكوبونات', 'Coupons', 'کۆپۆنەکان') },
          { id: 'competitions', label: loc('المسابقات', 'Contests', 'پێشبڕکێ') },
          { id: 'ads', label: loc('الإعلانات', 'Ads', 'ڕیکلامەکان') },
          { id: 'settings', label: loc('الإعدادات', 'Settings', 'ڕێکخستن') },
        ]}
        label={loc('أقسام المكافآت', 'Rewards sections', 'بەشەکانی خەڵات')}
      />
      {view === 'overview' && <RewardsOverview onGo={setView} />}
      {view === 'printers' && (
        <RewardsPrinters
          onCustomerCoupons={(c) => {
            setCustomer(c);
            setView('coupons');
          }}
        />
      )}
      {view === 'coupons' && <RewardsCoupons customer={customer} onClearCustomer={() => setCustomer(null)} />}
      {view === 'competitions' && <AdminCompetitions />}
      {view === 'ads' && <AdminAds />}
      {view === 'settings' && <SettingsPanel />}
    </div>
  );
}

// -------------------------------------------------------------- settings

/**
 * What one printer earns in a week, from the fields on screen, before anything is
 * saved: the owner reads the sum of the form in one line. Pure, so a test reads it.
 */
export function weeklyEarnSummary(
  cfg: Pick<Config, 'enabled' | 'weekly' | 'free_shipping' | 'filament' | 'valid_days'>,
  lang: keyof Tri,
  money: (iqd: number) => string
): string {
  const say = (ar: string, en: string, ckb: string) => ({ ar, en, ckb })[lang];
  const parts: string[] = [];
  if (cfg.free_shipping.enabled) {
    const amount = money(cfg.free_shipping.amount_iqd);
    const min = money(cfg.free_shipping.min_order_iqd);
    parts.push(
      cfg.free_shipping.min_order_iqd > 0
        ? say(`كوبون توصيل بقيمة ${amount} للطلبات من ${min} فأكثر`, `a ${amount} delivery coupon on orders of ${min} or more`, `کۆپۆنێکی گەیاندن بە بەهای ${amount} بۆ داواکارییەکانی ${min} و زیاتر`)
        : say(`كوبون توصيل بقيمة ${amount}`, `a ${amount} delivery coupon`, `کۆپۆنێکی گەیاندن بە بەهای ${amount}`)
    );
  }
  if (cfg.filament.enabled) {
    const pieces = countText('pieces', cfg.filament.max_pieces, lang);
    const cap = cfg.filament.max_discount_iqd ? say(` حتى ${money(cfg.filament.max_discount_iqd)}`, ` up to ${money(cfg.filament.max_discount_iqd)}`, ` تا ${money(cfg.filament.max_discount_iqd)}`) : '';
    parts.push(say(`كوبون خصم ${cfg.filament.percent}% على ${pieces}${cap}`, `a ${cfg.filament.percent}% coupon on ${pieces}${cap}`, `کۆپۆنێکی ${cfg.filament.percent}% داشکاندن لەسەر ${pieces}${cap}`));
  }
  if (!cfg.enabled || parts.length === 0) return say('لا تصدر كوبونات بهذه الإعدادات.', 'No coupons are issued on these settings.', 'بەم ڕێکخستنانە هیچ کۆپۆنێک دەرناچێت.');
  const what = parts.join(say(' و', ' and ', ' و '));
  const days = countText('days', cfg.valid_days, lang);
  if (!cfg.weekly.enabled) return say(`كل طابعة تكسب عند تسليمها فقط: ${what}، صالحة ${days}.`, `Each printer earns on delivery only: ${what}, valid ${days}.`, `هەر چاپکەرێک تەنها لە کاتی گەیاندن بەدەستی دەهێنێت: ${what}، ${days} بەکاردێت.`);
  const months = countText('months', cfg.weekly.months, lang);
  return say(
    `كل طابعة تكسب كل أسبوع: ${what}، طوال ${months} من ضمانها، صالحة ${days}.`,
    `Each printer earns every week: ${what}, for ${months} of its warranty, valid ${days}.`,
    `هەر چاپکەرێک هەموو هەفتەیەک بەدەستی دەهێنێت: ${what}، بۆ ماوەی ${months} لە گەرەنتییەکەی، ${days} بەکاردێت.`
  );
}

function SettingsPanel() {
  const { loc, lang } = useLanguage();
  const { money } = useMoney();
  const refusal = useRewardsRefusal();
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as keyof Tri;
  const [cfg, setCfg] = useState<Config | null>(null);
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [summary, setSummary] = useState<Array<{ kind: string; source: string; used: number; issued: number; points_spent: number }>>([]);
  const [installed, setInstalled] = useState(true);
  const [shopViews, setShopViews] = useState<ShopProductView[]>([]);
  const [badRow, setBadRow] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ config: Config; filaments: Filament[]; summary: typeof summary; installed: boolean; shop_products?: ShopProductView[] }>('/api/admin/rewards/config');
      setCfg(res.config);
      setShopViews(res.shop_products ?? []);
      setFilaments(res.filaments);
      setSummary(res.summary);
      setInstalled(res.installed);
    } catch (err) {
      setError(err instanceof Error ? err.message : '');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? filaments.filter((f) => [f.name.ar, f.name.en, f.name.ckb, f.slug].some((s) => s.toLowerCase().includes(q))) : filaments;
  }, [filaments, search]);

  if (!cfg) return <p className="text-text-secondary text-sm">{error || loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>;

  const set = (patch: (c: Config) => Config) => setCfg((c) => (c ? patch(structuredClone(c)) : c));
  const toggleFilament = (id: string) =>
    set((c) => {
      c.filament.product_ids = c.filament.product_ids.includes(id) ? c.filament.product_ids.filter((x) => x !== id) : [...c.filament.product_ids, id];
      return c;
    });
  const num = (v: string): number | null => (v.trim() === '' ? null : Math.max(0, Math.trunc(Number(v) || 0)));

  const save = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    setBadRow(null);
    try {
      const res = await api.put<{ config: Config; shop_products?: ShopProductView[] }>('/api/admin/rewards/config', cfg);
      setCfg(res.config);
      setShopViews(res.shop_products ?? []);
      setNotice(loc('حُفظت الإعدادات. الكوبونات الجديدة تصدر بها، والقديمة تبقى على شروطها.', 'Saved. New coupons are issued on these terms; coupons already issued keep theirs.', 'پاشەکەوت کرا. کۆپۆنە نوێیەکان بەم مەرجانە دەردەچن، و کۆنەکان مەرجەکانی خۆیان دەپارێزن.'));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      // A refusal of one product names its row (DECISIONS row 299).
      const at = err instanceof ApiError ? err.details?.item_index : undefined;
      const row = typeof at === 'number' ? at : null;
      setBadRow(row);
      const words = shopProductRefusal(code, loc);
      setError(
        code === 'OWNER_REQUIRED'
          ? loc('حفظ شروط المكافآت للمالك وحده.', 'Only the owner can save the reward terms.', 'تەنها خاوەنەکە دەتوانێت مەرجەکانی خەڵات پاشەکەوت بکات.')
          : words
            ? row === null ? words : loc(`المنتج ${row + 1}: ${words}`, `Product ${row + 1}: ${words}`, `بەرهەمی ${row + 1}: ${words}`)
            : refusal(err)
      );
    } finally {
      setSaving(false);
    }
  };

  const issued = (kind: string, source: string) => summary.find((s) => s.kind === kind && s.source === source);
  // The ticked filaments a live offer keeps this coupon off, while it is told not to join an offer.
  const heldByOffer = cfg.filament.on_offer ? [] : filaments.filter((f) => f.on_offer && cfg.filament.product_ids.includes(f.id));

  return (
    <div className="space-y-4">
      {!installed && (
        <div className="lv-alert lv-alert-danger text-xs text-text-primary">
          {loc('جداول المكافآت غير مثبّتة على هذه القاعدة بعد (الترحيل 0220).', 'The rewards tables are not on this database yet (migration 0220).', 'خشتەکانی خەڵات هێشتا لەم داتابەیسەدا نین (کۆچی 0220).')}
        </div>
      )}

      <p data-rewards-weekly-summary className="lv-surface flex items-start gap-2 p-3 text-[13px] leading-6 text-text-primary">
        <Info className="mt-1 w-4 h-4 shrink-0 text-text-secondary" aria-hidden />
        <span className="min-w-0">{weeklyEarnSummary(cfg, l, money)}</span>
      </p>

      <div className="lv-surface p-4 grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-text-primary sm:col-span-2">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set((c) => ((c.enabled = e.target.checked), c))} />
          {loc('إصدار كوبونات الطابعة عند التسليم', 'Issue printer coupons on delivery', 'دەرکردنی کۆپۆنی چاپکەر لە کاتی گەیاندن')}
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary self-end">
          <input type="checkbox" checked={cfg.weekly.enabled} onChange={(e) => set((c) => ((c.weekly.enabled = e.target.checked), c))} />
          {loc('كوبونات جديدة كل أسبوع طوال ضمان الطابعة', 'New coupons every week through the printer’s warranty', 'کۆپۆنی نوێ هەموو هەفتەیەک بە درێژایی گەرەنتی چاپکەر')}
        </label>
        <div>
          <label className={label} htmlFor="rw-months">{loc('أقصى مدة من ضمانها (أشهر)', 'At most, of its warranty (months)', 'زۆرترین ماوە لە گەرەنتییەکەی (مانگ)')}</label>
          <input id="rw-months" className="lv-input text-sm" dir="ltr" type="number" min={1} max={60} value={cfg.weekly.months}
            onChange={(e) => set((c) => ((c.weekly.months = Math.min(60, Math.max(1, Math.trunc(Number(e.target.value) || 1)))), c))} />
        </div>
        <div>
          <label className={label} htmlFor="rw-days">{loc('مدة صلاحية الكوبون (أيام)', 'Coupon validity (days)', 'ماوەی کۆپۆن (ڕۆژ)')}</label>
          <input id="rw-days" className="lv-input text-sm" dir="ltr" type="number" min={1} max={90} value={cfg.valid_days}
            onChange={(e) => set((c) => ((c.valid_days = Math.max(1, Math.trunc(Number(e.target.value) || 1))), c))} />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-primary self-end">
          <input type="checkbox" checked={cfg.free_shipping.enabled} onChange={(e) => set((c) => ((c.free_shipping.enabled = e.target.checked), c))} />
          {loc('كوبون توصيل مجاني لكل طابعة', 'A free-delivery coupon per printer', 'کۆپۆنێکی گەیاندنی بەخۆڕایی بۆ هەر چاپکەرێک')}
        </label>
        <div>
          <label className={label} htmlFor="rw-ship-amount">{loc('قيمة كوبون التوصيل (د.ع)', 'Delivery coupon worth (IQD)', 'بەهای کۆپۆنی گەیاندن (د.ع)')}</label>
          <input id="rw-ship-amount" className="lv-input text-sm" dir="ltr" type="number" min={1} value={cfg.free_shipping.amount_iqd}
            onChange={(e) => set((c) => ((c.free_shipping.amount_iqd = Math.max(1, Math.trunc(Number(e.target.value) || 1))), c))} />
        </div>
        <div>
          <label className={label} htmlFor="rw-ship-min">{loc('للطلبات من هذا المبلغ فأكثر (د.ع، بعد كل الخصومات)', 'On orders of this amount or more (IQD, after every discount)', 'بۆ داواکارییەکانی ئەم بڕە و زیاتر (د.ع، دوای هەموو داشکاندنەکان)')}</label>
          <input id="rw-ship-min" className="lv-input text-sm" dir="ltr" type="number" min={0} value={cfg.free_shipping.min_order_iqd}
            onChange={(e) => set((c) => ((c.free_shipping.min_order_iqd = Math.max(0, Math.trunc(Number(e.target.value) || 0))), c))} />
        </div>
        {(issued('free_shipping', 'printer') || issued('filament_discount', 'printer')) && (
          <p className="text-text-muted text-[11px] sm:col-span-2" dir="auto">
            {loc('صدر حتى الآن', 'Issued so far', 'تا ئێستا دەرچووە')}:{' '}
            {(['free_shipping', 'filament_discount'] as const).map((k) => {
              const s = issued(k, 'printer');
              return s ? `${k === 'free_shipping' ? loc('توصيل', 'delivery', 'گەیاندن') : loc('فلامنت', 'filament', 'فیلامێنت')} ${s.issued} (${loc('استُخدم', 'used', 'بەکارهات')} ${s.used})  ` : '';
            })}
          </p>
        )}
      </div>

      <div className="lv-surface p-4 grid gap-4 sm:grid-cols-3">
        <label className="flex items-center gap-2 text-sm text-text-primary sm:col-span-3">
          <input type="checkbox" checked={cfg.filament.enabled} onChange={(e) => set((c) => ((c.filament.enabled = e.target.checked), c))} />
          {loc('كوبون خصم على الفلامنت لكل طابعة', 'A filament coupon per printer', 'کۆپۆنێکی داشکاندنی فیلامێنت بۆ هەر چاپکەرێک')}
        </label>
        <div>
          <label className={label} htmlFor="rw-pct">{loc('نسبة الخصم %', 'Discount %', 'ڕێژەی داشکاندن %')}</label>
          <input id="rw-pct" className="lv-input text-sm" dir="ltr" type="number" min={1} max={100} value={cfg.filament.percent}
            onChange={(e) => set((c) => ((c.filament.percent = Math.min(100, Math.max(1, Math.trunc(Number(e.target.value) || 1)))), c))} />
        </div>
        <div>
          <label className={label} htmlFor="rw-cap">{loc('أقصى خصم للكوبون (د.ع)', 'Most one coupon takes (IQD)', 'زۆرترین داشکاندنی کۆپۆنێک (د.ع)')}</label>
          <input id="rw-cap" className="lv-input text-sm" dir="ltr" type="number" min={1} placeholder={loc('بلا حد', 'No ceiling', 'بێ سنوور')}
            value={cfg.filament.max_discount_iqd ?? ''} onChange={(e) => set((c) => ((c.filament.max_discount_iqd = num(e.target.value)), c))} />
        </div>
        <div>
          <label className={label} htmlFor="rw-pieces">{loc('عدد القطع لكل كوبون', 'Pieces per coupon', 'ژمارەی پارچە بۆ هەر کۆپۆنێک')}</label>
          <input id="rw-pieces" className="lv-input text-sm" dir="ltr" type="number" min={1} max={100} value={cfg.filament.max_pieces}
            onChange={(e) => set((c) => ((c.filament.max_pieces = Math.min(100, Math.max(1, Math.trunc(Number(e.target.value) || 1)))), c))} />
        </div>
        <label className="flex items-start gap-2 text-sm text-text-primary sm:col-span-3">
          <input type="checkbox" className="mt-1" checked={cfg.filament.on_offer === true} onChange={(e) => set((c) => ((c.filament.on_offer = e.target.checked), c))} data-rewards-filament-on-offer />
          <span className="min-w-0">
            {loc('يعمل أيضًا على القطع التي عليها عرض', 'Also works on items with an offer', 'لەسەر ئەو پارچانەش کار دەکات کە ئۆفەریان لەسەرە')}
            <span className="block text-text-secondary text-[12px] leading-5">
              {loc(
                'مطفأ: لا يأخذ الكوبون شيئًا من قطعة عليها عرض أو خصم آخر. يسري على الكوبونات الجديدة، والقديمة تبقى على شروطها.',
                'Off: the coupon takes nothing from an item with an offer or another discount. It applies to new coupons; coupons already issued keep their terms.',
                'کوژاوە: کۆپۆنەکە هیچ لەو پارچەیە کەم ناکاتەوە کە ئۆفەر یان داشکاندنێکی تری لەسەرە. بۆ کۆپۆنە نوێیەکانە، و کۆنەکان مەرجەکانی خۆیان دەپارێزن.'
              )}
            </span>
          </span>
        </label>
        {heldByOffer.length > 0 && (
          <p role="status" className="lv-alert lv-alert-warning text-xs text-text-primary sm:col-span-3" data-rewards-filament-offer-warning>
            {loc(
              'الفلامنت المختار عليه عرض الآن، فلا يأخذ منه الكوبون شيئًا: ',
              'A selected filament has an offer now, so the coupon takes nothing from it: ',
              'فیلامێنتی هەڵبژێردراو ئێستا ئۆفەری لەسەرە، بۆیە کۆپۆنەکە هیچی لێ کەم ناکاتەوە: '
            )}
            <bdi>{heldByOffer.map((f) => f.name[l] || f.name.ar).join(l === 'en' ? ', ' : '، ')}</bdi>
          </p>
        )}
        <div className="sm:col-span-3">
          <p className={label}>
            {loc('الفلامنت المشمول', 'Filaments covered', 'ئەو فیلامێنتانەی دەگرێتەوە')}{' '}
            <span className="font-normal">
              {cfg.filament.product_ids.length
                ? loc(`(${cfg.filament.product_ids.length} مختار)`, `(${cfg.filament.product_ids.length} selected)`, `(${cfg.filament.product_ids.length} هەڵبژێردراو)`)
                : loc('(لا شيء مختار = كل فلامنت FDM)', '(none selected = every FDM filament)', '(هیچ هەڵنەبژێردراوە = هەموو فیلامێنتی FDM)')}
            </span>
          </p>
          <input className="lv-input text-sm mb-2" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={loc('ابحث عن فلامنت…', 'Search filaments…', 'بگەڕێ بۆ فیلامێنت…')} />
          <div className="max-h-64 overflow-y-auto lv-well rounded-lg p-2 grid sm:grid-cols-2 gap-1">
            {shown.length === 0 && <p className="text-text-secondary text-xs p-2">{loc('لا منتجات في قسم فلامنت FDM.', 'No products in the FDM filament section.', 'هیچ بەرهەمێک لە بەشی فیلامێنتی FDM نییە.')}</p>}
            {shown.map((f) => (
              <label key={f.id} className="flex items-center gap-2 text-xs text-text-primary px-2 py-1.5 rounded hover:bg-surface-raised">
                <input type="checkbox" checked={cfg.filament.product_ids.includes(f.id)} onChange={() => toggleFilament(f.id)} />
                <span className="truncate">{f.name[l] || f.name.ar}</span>
                {f.on_offer && <span className="shrink-0 text-text-muted">({loc('عليه عرض', 'has an offer', 'ئۆفەری لەسەرە')})</span>}
                {f.status !== 'active' && <span className="text-text-muted">({loc('مخفي', 'hidden', 'شاراوە')})</span>}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="lv-surface p-4 grid gap-4 sm:grid-cols-2">
        <p className="text-text-primary text-sm font-bold sm:col-span-2">{loc('متجر النقاط', 'Points shop', 'فرۆشگای خاڵ')}</p>
        <p className="text-text-secondary text-xs sm:col-span-2">
          {loc('عند الدفع كل نقطة = 1 د.ع. ضع سعرًا بالنقاط لكل ما تريد بيعه: ما لا سعر له لا يصل إلى الزبون.', 'At checkout 1 point = 1 IQD. Set a price in points for everything you want to sell: what has no price does not reach the customer.', 'لە کاتی پارەدان هەر خاڵێک = 1 د.ع. بۆ هەر شتێک کە دەتەوێت بیفرۆشیت نرخێک بە خاڵ دابنێ: ئەوەی نرخی نەبێت ناگاتە کڕیار.')}
        </p>
        {(['free_shipping', 'filament_discount'] as const).map((k) => (
          <div key={k} className="lv-well rounded-lg p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={cfg.shop[k].enabled} onChange={(e) => set((c) => ((c.shop[k].enabled = e.target.checked), c))} />
              {k === 'free_shipping' ? loc('كوبون توصيل مجاني', 'Free-delivery coupon', 'کۆپۆنی گەیاندنی بەخۆڕایی') : loc('كوبون الفلامنت', 'Filament coupon', 'کۆپۆنی فیلامێنت')}
            </label>
            <input className="lv-input text-sm" dir="ltr" type="number" min={1} placeholder={loc('السعر بالنقاط', 'Price in points', 'نرخ بە خاڵ')}
              value={cfg.shop[k].points ?? ''} onChange={(e) => set((c) => ((c.shop[k].points = num(e.target.value)), c))} />
          </div>
        ))}
        <div className="sm:col-span-2 border-t border-border-subtle pt-4">
          <Suspense fallback={<p className="text-text-secondary text-xs">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>}>
            <RewardsShopProducts
              items={cfg.shop.items ?? []}
              views={shopViews}
              badIndex={badRow}
              onChange={(items) => set((c) => ((c.shop.items = items), c))}
            />
          </Suspense>
        </div>
      </div>

      {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}
      {notice && (
        <div role="status" className="lv-alert lv-alert-success text-xs text-text-primary flex items-center gap-2">
          <Check className="w-4 h-4" aria-hidden /> {notice}
        </div>
      )}

      <div className="flex justify-end">
        <button type="button" onClick={() => void save()} disabled={saving} className="lv-button lv-button-primary">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Settings2 className="w-4 h-4" aria-hidden />}
          {loc('حفظ الإعدادات', 'Save settings', 'ڕێکخستنەکان پاشەکەوت بکە')}
        </button>
      </div>
    </div>
  );
}
