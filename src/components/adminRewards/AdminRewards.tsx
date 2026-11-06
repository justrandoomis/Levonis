/**
 * ADMIN → المكافآت (migration 0220; docs/DECISIONS.md row 286).
 *
 * Three screens over /api/admin/rewards:
 *   الإعدادات   the programme's terms: what a delivered printer earns, and for
 *               how many months of its warranty, every week (the free-delivery
 *               coupon — its amount and the order it needs — and the filament
 *               coupon — its percentage, its ceiling, how many pieces and the
 *               filaments it covers), how long a coupon lasts, and what the
 *               points shop charges. The owner's to save:
 *               the server refuses everyone else (OWNER_REQUIRED).
 *   الكوبونات   every reward coupon issued, its customer and its state, with
 *               «سحب» (any admin) and «تمديد» (the financial scope).
 *   المسابقات   drafts, publishing (the owner), entries, winners and cancels.
 *
 * Nothing here decides money: each figure is validated and applied by the
 * server, and a refusal is shown in the server's own words.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gift, Ticket, Trophy, Settings2, Loader2, Check } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Segmented } from '../ui/Segmented';
import AdminCompetitions from './AdminCompetitions';

type Tri = { ar: string; en: string; ckb: string };
type Kind = 'free_shipping' | 'filament_discount';

interface Config {
  enabled: boolean;
  valid_days: number;
  weekly: { enabled: boolean; months: number };
  free_shipping: { enabled: boolean; amount_iqd: number; min_order_iqd: number };
  filament: { enabled: boolean; percent: number; max_discount_iqd: number | null; product_ids: string[]; max_pieces: number; on_sale: boolean };
  shop: Record<Kind, { enabled: boolean; points: number | null }>;
}

interface Filament { id: string; slug: string; name: Tri; status: string }

interface Grant {
  id: string;
  kind: Kind;
  source: 'printer' | 'points_shop' | 'admin';
  state: 'active' | 'used' | 'expired' | 'revoked';
  code: string;
  percent: number;
  issued_at: string;
  expires_at: string;
  order_id: string | null;
  points_spent: number;
  used_on_order_id: string | null;
  revoke_reason: string;
  user: { id: string; name: string; username: string; email: string };
}

const label = 'block text-text-secondary text-[11px] font-bold mb-1.5';
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export default function AdminRewards() {
  const { loc } = useLanguage();
  const [view, setView] = useState<'settings' | 'coupons' | 'competitions'>('settings');
  return (
    <div className="space-y-6" data-admin-rewards>
      <div>
        <h2 className="text-text-primary font-bold text-lg flex items-center gap-2">
          <Gift className="w-5 h-5 text-gold" aria-hidden />
          {loc('المكافآت', 'Rewards', 'خەڵاتەکان')}
        </h2>
        <p className="text-text-secondary text-xs mt-1">
          {loc(
            'كوبونات الطابعة تصدر تلقائيًا عند تسليم كل طابعة، والزبون يراها ويستخدمها من صفحة المكافآت.',
            'Printer coupons are issued automatically when each printer is delivered; the customer sees and uses them on the Rewards page.',
            'کۆپۆنەکانی چاپکەر بە شێوەی خۆکار لە کاتی گەیاندنی هەر چاپکەرێک دەردەچن، و کڕیار لە پەڕەی خەڵاتەکان دەیانبینێت و بەکاریان دەهێنێت.'
          )}
        </p>
      </div>
      <Segmented
        value={view}
        onChange={(v) => setView(v as typeof view)}
        group="admin-rewards"
        items={[
          { id: 'settings', label: loc('الإعدادات', 'Settings', 'ڕێکخستنەکان') },
          { id: 'coupons', label: loc('الكوبونات', 'Coupons', 'کۆپۆنەکان') },
          { id: 'competitions', label: loc('المسابقات', 'Competitions', 'پێشبڕکێکان') },
        ]}
        label={loc('أقسام المكافآت', 'Rewards sections', 'بەشەکانی خەڵات')}
      />
      {view === 'settings' && <SettingsPanel />}
      {view === 'coupons' && <CouponsPanel />}
      {view === 'competitions' && <AdminCompetitions />}
    </div>
  );
}

// -------------------------------------------------------------- settings

function SettingsPanel() {
  const { loc, lang } = useLanguage();
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as keyof Tri;
  const [cfg, setCfg] = useState<Config | null>(null);
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [summary, setSummary] = useState<Array<{ kind: string; source: string; used: number; issued: number; points_spent: number }>>([]);
  const [installed, setInstalled] = useState(true);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ config: Config; filaments: Filament[]; summary: typeof summary; installed: boolean }>('/api/admin/rewards/config');
      setCfg(res.config);
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
    try {
      const res = await api.put<{ config: Config }>('/api/admin/rewards/config', cfg);
      setCfg(res.config);
      setNotice(loc('حُفظت الإعدادات. الكوبونات الجديدة تصدر بها، والقديمة تبقى على شروطها.', 'Saved. New coupons are issued on these terms; coupons already issued keep theirs.', 'پاشەکەوت کرا. کۆپۆنە نوێیەکان بەم مەرجانە دەردەچن، و کۆنەکان مەرجەکانی خۆیان دەپارێزن.'));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(
        code === 'OWNER_REQUIRED'
          ? loc('حفظ شروط المكافآت للمالك وحده.', 'Only the owner can save the reward terms.', 'تەنها خاوەنەکە دەتوانێت مەرجەکانی خەڵات پاشەکەوت بکات.')
          : err instanceof Error ? err.message : ''
      );
    } finally {
      setSaving(false);
    }
  };

  const issued = (kind: string, source: string) => summary.find((s) => s.kind === kind && s.source === source);

  return (
    <div className="space-y-4">
      {!installed && (
        <div className="lv-alert lv-alert-danger text-xs text-text-primary">
          {loc('جداول المكافآت غير مثبّتة على هذه القاعدة بعد (الترحيل 0220).', 'The rewards tables are not on this database yet (migration 0220).', 'خشتەکانی خەڵات هێشتا لەم داتابەیسەدا نین (کۆچی 0220).')}
        </div>
      )}
      {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}
      {notice && (
        <div role="status" className="lv-alert lv-alert-success text-xs text-text-primary flex items-center gap-2">
          <Check className="w-4 h-4" aria-hidden /> {notice}
        </div>
      )}

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
          <label className={label} htmlFor="rw-ship-min">{loc('للطلبات فوق (د.ع، بعد كل الخصومات)', 'On orders over (IQD, after every discount)', 'بۆ داواکارییەکانی سەرووی (د.ع، دوای هەموو داشکاندنەکان)')}</label>
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
        <label className="flex items-center gap-2 text-sm text-text-primary sm:col-span-3">
          <input type="checkbox" checked={cfg.filament.on_sale} onChange={(e) => set((c) => ((c.filament.on_sale = e.target.checked), c))} />
          {loc('يعمل أيضًا على الفلامنت المخفَّض (الخصم من سعر العرض)', 'Also works on filament already on sale (off the sale price)', 'لەسەر فیلامێنتی داشکێنراویش کار دەکات (لە نرخی ئۆفەرەکەوە)')}
        </label>
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
                {f.status !== 'active' && <span className="text-text-muted">({loc('مخفي', 'hidden', 'شاراوە')})</span>}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="lv-surface p-4 grid gap-4 sm:grid-cols-2">
        <p className="text-text-primary text-sm font-bold sm:col-span-2">{loc('متجر النقاط', 'Points shop', 'فرۆشگای خاڵ')}</p>
        <p className="text-text-secondary text-xs sm:col-span-2">
          {loc('عند الدفع كل نقطة = 1 د.ع. ضع سعرًا بالنقاط لكل كوبون تريد بيعه، وإلا لا يظهر المتجر.', 'At checkout 1 point = 1 IQD. Set a price in points for each coupon you want to sell; without one, the shop stays hidden.', 'لە کاتی پارەدان هەر خاڵێک = 1 د.ع. بۆ هەر کۆپۆنێک کە دەتەوێت بیفرۆشیت نرخێک بە خاڵ دابنێ، ئەگینا فرۆشگاکە دەرناکەوێت.')}
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
      </div>

      <div className="flex justify-end">
        <button type="button" onClick={() => void save()} disabled={saving} className="lv-button lv-button-primary">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Settings2 className="w-4 h-4" aria-hidden />}
          {loc('حفظ الإعدادات', 'Save settings', 'ڕێکخستنەکان پاشەکەوت بکە')}
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- coupons

function CouponsPanel() {
  const { loc } = useLanguage();
  const [rows, setRows] = useState<Grant[] | null>(null);
  const [state, setState] = useState('active');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const p = new URLSearchParams();
      if (state) p.set('state', state);
      if (kind) p.set('kind', kind);
      if (q.trim()) p.set('q', q.trim());
      setRows((await api.get<{ grants: Grant[] }>(`/api/admin/rewards/grants?${p.toString()}`)).grants);
    } catch (err) {
      setError(err instanceof Error ? err.message : '');
      setRows([]);
    }
  }, [state, kind, q]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (g: Grant, what: 'revoke' | 'extend') => {
    const reason = window.prompt(loc('السبب (يُحفظ في السجل):', 'Reason (kept in the audit log):', 'هۆکار (لە تۆماردا دەمێنێتەوە):'))?.trim();
    if (!reason) return;
    let days = 0;
    if (what === 'extend') {
      days = Math.trunc(Number(window.prompt(loc('كم يومًا؟ (1–30)', 'How many days? (1–30)', 'چەند ڕۆژ؟ (1–30)')) || 0));
      if (!days) return;
    }
    setBusy(g.id);
    setError('');
    try {
      await api.post(`/api/admin/rewards/grants/${encodeURIComponent(g.id)}/${what}`, what === 'extend' ? { days, reason } : { reason });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '');
    } finally {
      setBusy('');
    }
  };

  const stateText = (s: Grant['state']) =>
    s === 'active' ? loc('صالح', 'Active', 'چالاک') : s === 'used' ? loc('مستخدم', 'Used', 'بەکارهاتوو') : s === 'expired' ? loc('منتهٍ', 'Expired', 'بەسەرچوو') : loc('مسحوب', 'Withdrawn', 'کشاوەتەوە');

  return (
    <div className="space-y-3">
      <div className="lv-surface p-3 grid gap-2 sm:grid-cols-4">
        <select className="lv-input text-sm" value={state} onChange={(e) => setState(e.target.value)} aria-label={loc('الحالة', 'State', 'دۆخ')}>
          <option value="">{loc('كل الحالات', 'All states', 'هەموو دۆخەکان')}</option>
          <option value="active">{stateText('active')}</option>
          <option value="used">{stateText('used')}</option>
          <option value="expired">{stateText('expired')}</option>
          <option value="revoked">{stateText('revoked')}</option>
        </select>
        <select className="lv-input text-sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={loc('النوع', 'Kind', 'جۆر')}>
          <option value="">{loc('كل الأنواع', 'All kinds', 'هەموو جۆرەکان')}</option>
          <option value="free_shipping">{loc('توصيل مجاني', 'Free delivery', 'گەیاندنی بەخۆڕایی')}</option>
          <option value="filament_discount">{loc('خصم الفلامنت', 'Filament discount', 'داشکاندنی فیلامێنت')}</option>
        </select>
        <input className="lv-input text-sm sm:col-span-2" value={q} onChange={(e) => setQ(e.target.value)} placeholder={loc('ابحث بالكود أو الزبون أو الطلب…', 'Search by code, customer or order…', 'بگەڕێ بە کۆد، کڕیار یان داواکاری…')} />
      </div>
      {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}
      {rows === null ? (
        <p className="text-text-secondary text-sm">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>
      ) : rows.length === 0 ? (
        <p className="text-text-secondary text-sm rounded-xl border border-dashed border-border-subtle p-6 text-center">{loc('لا كوبونات هنا.', 'No coupons here.', 'هیچ کۆپۆنێک لێرە نییە.')}</p>
      ) : (
        <div className="overflow-x-auto lv-surface">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="bg-surface-raised text-text-secondary text-[11px]">
              <tr>
                <th className="text-start p-3">{loc('الزبون', 'Customer', 'کڕیار')}</th>
                <th className="text-start p-3">{loc('الكوبون', 'Coupon', 'کۆپۆن')}</th>
                <th className="text-start p-3">{loc('المصدر', 'Source', 'سەرچاوە')}</th>
                <th className="text-start p-3">{loc('الصلاحية', 'Valid', 'ماوە')}</th>
                <th className="text-start p-3">{loc('الحالة', 'State', 'دۆخ')}</th>
                <th className="text-end p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((g) => (
                <tr key={g.id} className="text-text-secondary">
                  <td className="p-3">
                    <div className="text-text-primary">{g.user.name || g.user.username}</div>
                    <div className="text-[11px]" dir="ltr">{g.user.email}</div>
                  </td>
                  <td className="p-3">
                    <div className="text-text-primary flex items-center gap-1.5">
                      <Ticket className="w-3.5 h-3.5 text-gold" aria-hidden />
                      {g.kind === 'free_shipping' ? loc('توصيل مجاني', 'Free delivery', 'گەیاندنی بەخۆڕایی') : loc(`خصم ${g.percent}% فلامنت`, `${g.percent}% filament`, `${g.percent}% فیلامێنت`)}
                    </div>
                    <div className="font-mono text-[11px]" dir="ltr">{g.code}</div>
                  </td>
                  <td className="p-3 text-[12px]">
                    {g.source === 'printer'
                      ? loc(`طابعة · ${g.order_id ?? ''}`, `Printer · ${g.order_id ?? ''}`, `چاپکەر · ${g.order_id ?? ''}`)
                      : g.source === 'points_shop'
                        ? loc(`متجر النقاط · ${g.points_spent}`, `Points shop · ${g.points_spent}`, `فرۆشگای خاڵ · ${g.points_spent}`)
                        : loc('إدارة', 'Admin', 'بەڕێوەبەر')}
                  </td>
                  <td className="p-3 text-[12px]" dir="ltr">{day(g.issued_at)} → {day(g.expires_at)}</td>
                  <td className="p-3 text-[12px]">
                    {stateText(g.state)}
                    {g.used_on_order_id ? <div className="text-[11px]" dir="ltr">{g.used_on_order_id}</div> : null}
                  </td>
                  <td className="p-3 text-end whitespace-nowrap">
                    {g.state !== 'used' && g.state !== 'revoked' && (
                      <>
                        <button type="button" disabled={busy === g.id} onClick={() => void act(g, 'extend')} className="lv-button lv-button-secondary lv-button-sm me-1">
                          {loc('تمديد', 'Extend', 'درێژکردنەوە')}
                        </button>
                        <button type="button" disabled={busy === g.id} onClick={() => void act(g, 'revoke')} className="lv-button lv-button-ghost lv-button-sm text-danger">
                          {loc('سحب', 'Withdraw', 'کشاندنەوە')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-text-muted text-[11px] flex items-center gap-1.5">
        <Trophy className="w-3.5 h-3.5" aria-hidden />
        {loc('كوبون استُخدم في طلب لا يُسحب منه أبدًا؛ إلغاء الطلب الأصلي أو إرجاع الطابعة يسحب الكوبونات غير المستخدمة تلقائيًا.', 'A coupon spent on an order is never taken back from it; cancelling the printer’s order or returning the printer withdraws the unused coupons by itself.', 'کۆپۆنێک کە لە داواکارییەکدا بەکارهاتبێت هەرگیز لێی ناسەندرێتەوە؛ هەڵوەشاندنەوەی داواکاریی چاپکەرەکە یان گەڕاندنەوەی چاپکەرەکە کۆپۆنە بەکارنەهاتووەکان خۆکارانە دەکشێنێتەوە.')}
      </p>
    </div>
  );
}
