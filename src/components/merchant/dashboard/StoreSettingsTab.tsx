/**
 * Store identity and setup — the «ابنِ متجرك» screen.
 *
 * Everything a merchant may legitimately shape about their shop, in one
 * place: images, words, colours (presets only, §12), coverage, delivery
 * pricing, hours, policies, links, and the address. Every field maps 1:1 to
 * a column the server validates; nothing here is decorative.
 */

import { lazy, Suspense, useState } from 'react';
import { Check, Loader2, Globe, AlertTriangle, ArrowUp, ArrowDown, Trash2, Eye, EyeOff, Plus, Truck, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { merchantApi, slugMessage, type MerchantMe, type SlugRejection, type ProfileWidget } from '../../../lib/merchant';
import { GOVERNORATES } from '../../../lib/governorates';
import { ImagePicker } from '../../media/ImagePicker';
import { WIDGET_ICONS, WidgetIcon } from '../profileIcons';
import { Btn, Card, Chip, ChipListEditor, Input, Notice, TextArea, Toggle } from './ui';
import ShareStore from '../share/ShareStore';
import { Skeleton } from '../../ui/Skeleton';
import { useConfirm } from '../../ui/ConfirmDialog';
import { merchantRefusal } from '../shell/refusal';
import { Link } from 'react-router-dom';

/** Delivery by governorate (W2-A): its own editor, its own save, its own chunk. */
const DeliverySettingsEditor = lazy(() => import('../delivery/DeliverySettingsEditor'));

/** The accent presets, with an honest swatch for each. Classes only — the
 *  merchant picks a NAME; no colour value they type can reach a style rule. */
const ACCENT_SWATCHES: Array<{ id: string; cls: string; ar: string; en: string }> = [
  { id: 'default', cls: 'bg-[#BAA369]', ar: 'Levonis', en: 'Levonis' },
  { id: 'olive', cls: 'bg-[#6b7d43]', ar: 'زيتوني', en: 'Olive' },
  { id: 'gold', cls: 'bg-yellow-500', ar: 'ذهبي', en: 'Gold' },
  { id: 'slate', cls: 'bg-slate-400', ar: 'رمادي', en: 'Slate' },
  { id: 'plum', cls: 'bg-purple-400', ar: 'بنفسجي', en: 'Plum' },
  { id: 'teal', cls: 'bg-teal-400', ar: 'فيروزي', en: 'Teal' },
  { id: 'blue', cls: 'bg-sky-400', ar: 'أزرق', en: 'Blue' },
];

const POLICY_PRESETS: Array<[string, string, string]> = [
  ['الشحن والتوصيل', 'Shipping & delivery', 'گەیاندن'],
  ['الاسترجاع والاستبدال', 'Returns & exchange', 'گەڕاندنەوە'],
  ['الضمان', 'Warranty', 'گەرەنتی'],
  ['الدفع', 'Payment', 'پارەدان'],
];

const DAY_PRESETS: Array<[string, string]> = [
  ['السبت - الخميس', 'Sat – Thu'],
  ['كل الأيام', 'Every day'],
  ['السبت', 'Saturday'],
  ['الأحد', 'Sunday'],
  ['الاثنين', 'Monday'],
  ['الثلاثاء', 'Tuesday'],
  ['الأربعاء', 'Wednesday'],
  ['الخميس', 'Thursday'],
  ['الجمعة', 'Friday'],
];

/**
 * The save's refusals as this screen's own sentences — the server's codes,
 * never its English text (the codes are pinned in worker/routes/merchant.ts).
 */
function settingsRefusal(e: unknown, loc: (ar: string, en: string, ckb?: string) => string): string {
  const code = e instanceof ApiError ? e.code : '';
  switch (code) {
    case 'STORE_SUSPENDED':
      return loc('المتجر موقوف من Levonis، ولا يُعاد فتحه من هنا. بقية الإعدادات تُحفظ كالمعتاد.', 'Levonis has suspended this store; it cannot be re-opened from here. Your other settings still save.'); // OWNER: Sorani to be written by hand.
    case 'MERCHANT_SUSPENDED':
      return loc('حساب التاجر موقوف، فلا يمكن فتح المتجر. تواصل مع الدعم.', 'Your merchant account is suspended, so the store cannot be opened. Contact support.'); // OWNER: Sorani to be written by hand.
    case 'SUBSCRIPTION_INACTIVE':
      return loc('اشتراكك غير فعّال. جدّده لإعادة فتح المتجر.', 'Your subscription is not active. Renew it to re-open the store.'); // OWNER: Sorani to be written by hand.
    case 'GOVERNORATE_INVALID':
      return loc('اختر المحافظة من القائمة.', 'Choose a governorate from the list.'); // OWNER: Sorani to be written by hand.
    case 'DELIVERY_NO_COVERAGE':
      return loc('لا يُفتح المتجر قبل أن توصل إلى محافظة واحدة على الأقل أو تفعّل الاستلام من المتجر — من «التوصيل حسب المحافظة».', 'The store cannot open until it delivers to at least one governorate or offers pickup — see «Delivery by governorate».'); // OWNER: Sorani to be written by hand.
    default:
      return loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت');
  }
}

export function StoreSettingsTab({
  me,
  onSaved,
  deliveryHref,
}: {
  me: MerchantMe;
  onSaved: () => void;
  /**
   * The workspace's own delivery screen (`/merchant/store/delivery`, W3-A).
   * Given, this screen links to it instead of embedding a second copy of the
   * same editor; absent, the editor is embedded as before.
   */
  deliveryHref?: string;
}) {
  const { loc, lang } = useLanguage();
  const store = me.store!;

  const [f, setF] = useState({
    name: store.name,
    tagline: store.tagline,
    description: store.description,
    logo_key: store.logoUrl,
    banner_key: store.bannerUrl,
    accent: store.accent,
    governorate: store.governorate ?? '',
    contact_phone: store.contact_phone ?? '',
    contact_phone_public: !!store.contact_phone_public,
    accepts_custom_requests: store.accepts_custom_requests,
    sells_direct_products: store.sells_direct_products,
    categories: store.categories ?? [],
    service_areas: store.service_areas ?? [],
    business_hours: (store.business_hours ?? []).map((h) =>
      typeof h === 'string' ? { day: h, open: '', close: '' } : h
    ),
    profile_links: (store.profile_links ?? []) as ProfileWidget[],
    profile_facts: (store.profile_facts ?? []) as ProfileWidget[],
    policies: Object.entries(store.policies ?? {}),
    social_links: Object.entries(store.social_links ?? {}),
    open: store.status === 'active',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const suspended = store.status === 'suspended';

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    // The server drops title-less widgets outright; failing loudly here beats
    // a silent disappearance after a successful-looking save.
    const halfFilled = [...f.profile_links, ...f.profile_facts].some(
      (w) => !w.title.trim() && ((w.url ?? '').trim() || (w.subtitle ?? '').trim())
    );
    if (halfFilled) {
      setError(
        loc(
          'كل رابط أو بطاقة تحتاج إلى عنوان قبل الحفظ.',
          'Each link or info card needs a title before saving.',
          'هەر بەستەرێک یان کارتێک پێویستی بە ناونیشانە پێش پاشەکەوتکردن.'
        )
      );
      setSaving(false);
      return;
    }
    try {
      await merchantApi.updateStore({
        name: f.name,
        tagline: f.tagline,
        description: f.description,
        logo_key: f.logo_key ?? '',
        banner_key: f.banner_key ?? '',
        accent: f.accent,
        governorate: f.governorate,
        contact_phone: f.contact_phone,
        contact_phone_public: f.contact_phone_public,
        accepts_custom_requests: f.accepts_custom_requests,
        sells_direct_products: f.sells_direct_products,
        categories: f.categories,
        service_areas: f.service_areas,
        // Rows the merchant left half-empty are simply not sent.
        business_hours: f.business_hours.filter((h) => h.day.trim()),
        policies: Object.fromEntries(f.policies.filter(([k, v]) => k.trim() && v.trim())),
        social_links: Object.fromEntries(f.social_links.filter(([k, v]) => k.trim() && v.trim())),
        // Rows the merchant never titled are simply not sent.
        profile_links: f.profile_links.filter((w) => w.title.trim()),
        profile_facts: f.profile_facts.filter((w) => w.title.trim()),
        // No `delivery_settings`: delivery is its own editor below (W2-A).
        // Open/closed goes up ONLY when the merchant changed it (audit 01 B4):
        // it used to ride along on every save, so a store Levonis had
        // suspended could not save a thing — not even the banner it was
        // suspended for. On a suspended store it is never sent at all.
        ...(!suspended && f.open !== (store.status === 'active') ? { open: f.open } : {}),
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(settingsRefusal(e, loc));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <Card title={loc('هوية المتجر', 'Store identity', 'ناسنامەی فرۆشگا')}>
        <div className="space-y-4">
          <ImagePicker
            label={loc('الشعار', 'Logo', 'لۆگۆ')}
            hint={loc('مربّع — يظهر بجانب اسمك في كل مكان.', 'Square — appears beside your name everywhere.', 'چوارگۆشە.')}
            shape="square"
            value={f.logo_key}
            onChange={(v) => setF({ ...f, logo_key: v })}
          />
          <ImagePicker
            label={loc('الغلاف', 'Banner', 'بەرگ')}
            hint={loc('عريض — أعلى صفحة متجرك.', 'Wide — the top of your shop page.', 'پان.')}
            shape="wide"
            value={f.banner_key}
            onChange={(v) => setF({ ...f, banner_key: v })}
          />
          <div>
            <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
              {loc('لون المتجر', 'Store colour', 'ڕەنگی فرۆشگا')}
            </label>
            <div className="flex gap-x-1.5 gap-y-2 flex-wrap">
              {ACCENT_SWATCHES.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={f.accent === a.id}
                  onClick={() => setF({ ...f, accent: a.id })}
                  className={`relative lv-hit h-9 ps-2 pe-3 rounded-xl border text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                    f.accent === a.id ? 'border-gold/60 bg-white/[0.06] text-white' : 'border-white/10 bg-white/[0.02] text-zinc-400'
                  }`}
                >
                  <span className={`w-4 h-4 rounded-full ${a.cls}`} />
                  {loc(a.ar, a.en)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card title={loc('واجهة المتجر — الروابط والبطاقات', 'Profile — links & info cards', 'ڕووکاری فرۆشگا')}>
        <p className="text-text-muted text-[10.5px] mb-3">
          {loc(
            'ستة عناصر تظهر أعلى صفحة متجرك: ثلاثة روابط (موقعك، إنستغرام…) وثلاث بطاقات معلومات (الموقع، وقت التجهيز، الشحن…). لكل عنصر أيقونة وعنوان وقيمة، ويمكنك إخفاؤه أو إعادة ترتيبه.',
            'Six items at the top of your shop page: three links (your site, Instagram…) and three info cards (location, prep time, shipping…). Each has an icon, a title and a value, and can be hidden or reordered.',
            'شەش دانە لە سەرەوەی پەڕەی فرۆشگاکەت: سێ بەستەر و سێ کارتی زانیاری.'
          )}
        </p>
        <WidgetGroupEditor
          kind="link"
          label={loc('الروابط الثلاثة', 'The three links', 'سێ بەستەرەکە')}
          items={f.profile_links}
          onChange={(profile_links) => setF({ ...f, profile_links })}
        />
        <div className="h-3" />
        <WidgetGroupEditor
          kind="fact"
          label={loc('بطاقات المعلومات الثلاث', 'The three info cards', 'سێ کارتی زانیاری')}
          items={f.profile_facts}
          onChange={(profile_facts) => setF({ ...f, profile_facts })}
        />
      </Card>

      <Card title={loc('معلومات المتجر', 'Store information', 'زانیاری فرۆشگا')}>
        <div className="space-y-3">
          <Input label={loc('الاسم', 'Name', 'ناو')} value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <Input
            label={loc('وصف مختصر', 'Tagline', 'وەسفی کورت')}
            value={f.tagline}
            onChange={(v) => setF({ ...f, tagline: v })}
            hint={loc('سطر واحد تحت اسم متجرك.', 'One line under your shop name.', 'یەک دێڕ.')}
          />
          <TextArea
            label={loc('عن المتجر', 'About', 'دەربارە')}
            value={f.description}
            onChange={(v) => setF({ ...f, description: v })}
            rows={4}
          />
          <div>
            <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
              {loc('المحافظة', 'Governorate', 'پارێزگا')}
            </label>
            <select
              aria-label={loc('المحافظة', 'Governorate', 'پارێزگا')}
              value={f.governorate}
              onChange={(e) => setF({ ...f, governorate: e.target.value })}
              className="w-full h-10 rounded-xl bg-black/40 border border-white/10 px-3 text-white text-[13px] outline-none focus:border-gold/40"
            >
              <option value="">{loc('— اختر —', '— choose —', '—')}</option>
              {/* A store saved before the closed list (audit 02 B27) holds free
                  text: it stays readable here, and saving it back leaves it
                  exactly as it is until a governorate is chosen. */}
              {f.governorate && !GOVERNORATES.some((g) => g.id === f.governorate) && (
                <option value={f.governorate}>{f.governorate}</option>
              )}
              {GOVERNORATES.map((g) => (
                <option key={g.id} value={g.id}>
                  {lang === 'ckb' ? g.ckb : lang === 'en' ? g.en : g.ar}
                </option>
              ))}
            </select>
          </div>
          <Input
            label={loc('رقم التواصل', 'Contact phone', 'ژمارەی پەیوەندی')}
            value={f.contact_phone}
            onChange={(v) => setF({ ...f, contact_phone: v })}
            ltr
          />
          <Toggle
            label={loc('إظهار الرقم للزبائن', 'Show the number publicly', 'ژمارە بە گشتی')}
            on={f.contact_phone_public}
            onChange={(v) => setF({ ...f, contact_phone_public: v })}
          />
          <ChipListEditor
            label={loc('تخصصات المتجر', 'Store categories', 'پۆلەکان')}
            values={f.categories}
            onChange={(categories) => setF({ ...f, categories })}
            placeholder={loc('طباعة FDM، ريزن، تصميم… ثم Enter', 'FDM printing, resin, design… then Enter', '…')}
          />
          <ChipListEditor
            label={loc('مناطق التغطية', 'Service areas', 'ناوچەکانی گەیاندن')}
            values={f.service_areas}
            onChange={(service_areas) => setF({ ...f, service_areas })}
            placeholder={loc('بغداد، أربيل، كل العراق… ثم Enter', 'Baghdad, Erbil, all of Iraq… then Enter', '…')}
          />
        </div>
      </Card>

      {/* DELIVERY BY GOVERNORATE (W2-A) — where the flat fee used to be, now
          its own editor with its own save (the workspace mounts the same
          component at /store/delivery). */}
      {deliveryHref ? (
        <Link
          to={deliveryHref}
          data-delivery-link
          className="lv-surface flex min-h-14 items-center gap-3 px-4 py-3 text-[14px] font-medium text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Truck aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
          {/* OWNER: Sorani to be written by hand. */}
          <span className="min-w-0 flex-1">{loc('التوصيل حسب المحافظة', 'Delivery by governorate')}</span>
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted rtl:-scale-x-100" />
        </Link>
      ) : (
        <Suspense
          fallback={
            <div className="lv-surface p-4 space-y-2" role="status" aria-label={loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          }
        >
          <DeliverySettingsEditor storeGovernorate={store.governorate ?? ''} />
        </Suspense>
      )}

      <Card title={loc('ساعات العمل', 'Business hours', 'کاتژمێرەکانی کار')}>
        <div className="space-y-2">
          {f.business_hours.map((h, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <input
                list="day-presets"
                value={h.day}
                onChange={(e) => {
                  const next = [...f.business_hours];
                  next[i] = { ...h, day: e.target.value };
                  setF({ ...f, business_hours: next });
                }}
                placeholder={loc('اليوم', 'Day', 'ڕۆژ')}
                className="flex-1 min-w-0 h-10 rounded-xl bg-black/40 border border-white/10 px-3 text-white text-[12.5px] outline-none focus:border-gold/40"
              />
              <input
                type="time"
                value={h.open}
                onChange={(e) => {
                  const next = [...f.business_hours];
                  next[i] = { ...h, open: e.target.value };
                  setF({ ...f, business_hours: next });
                }}
                dir="ltr"
                className="w-24 h-10 rounded-xl bg-black/40 border border-white/10 px-2 text-white text-[12px] outline-none focus:border-gold/40"
              />
              <input
                type="time"
                value={h.close}
                onChange={(e) => {
                  const next = [...f.business_hours];
                  next[i] = { ...h, close: e.target.value };
                  setF({ ...f, business_hours: next });
                }}
                dir="ltr"
                className="w-24 h-10 rounded-xl bg-black/40 border border-white/10 px-2 text-white text-[12px] outline-none focus:border-gold/40"
              />
              <button
                type="button"
                onClick={() => setF({ ...f, business_hours: f.business_hours.filter((_, j) => j !== i) })}
                className="w-8 h-8 rounded-lg text-text-muted hover:text-red-300 shrink-0"
              >
                ×
              </button>
            </div>
          ))}
          <datalist id="day-presets">
            {DAY_PRESETS.map(([ar, en]) => (
              <option key={en} value={lang === 'en' ? en : ar} />
            ))}
          </datalist>
          <Btn
            kind="ghost"
            small
            onClick={() => setF({ ...f, business_hours: [...f.business_hours, { day: '', open: '09:00', close: '18:00' }] })}
          >
            + {loc('إضافة سطر', 'Add row', 'دێڕ زیاد بکە')}
          </Btn>
        </div>
      </Card>

      <Card title={loc('سياسات المتجر', 'Store policies', 'سیاسەتەکان')}>
        <div className="space-y-2.5">
          <div className="flex gap-1.5 flex-wrap">
            {POLICY_PRESETS.map(([ar, en, ckb]) => {
              const key = loc(ar, en, ckb);
              const exists = f.policies.some(([k]) => k === key);
              return (
                <Chip
                  key={en}
                  label={`+ ${key}`}
                  active={false}
                  disabled={exists}
                  onClick={() => setF({ ...f, policies: [...f.policies, [key, '']] })}
                />
              );
            })}
          </div>
          {f.policies.map(([k, v], i) => (
            <div key={i} className="rounded-xl bg-black/30 border border-white/5 p-2.5 space-y-1.5">
              <div className="flex gap-1.5 items-center">
                <input
                  value={k}
                  onChange={(e) => {
                    const next = [...f.policies];
                    next[i] = [e.target.value, v];
                    setF({ ...f, policies: next });
                  }}
                  placeholder={loc('عنوان السياسة', 'Policy title', 'ناونیشان')}
                  className="flex-1 min-w-0 h-9 rounded-lg bg-black/40 border border-white/10 px-2.5 text-white text-[12.5px] font-semibold outline-none focus:border-gold/40"
                />
                <button
                  type="button"
                  onClick={() => setF({ ...f, policies: f.policies.filter((_, j) => j !== i) })}
                  className="w-8 h-8 rounded-lg text-text-muted hover:text-red-300 shrink-0"
                >
                  ×
                </button>
              </div>
              <textarea
                value={v}
                rows={2}
                onChange={(e) => {
                  const next = [...f.policies];
                  next[i] = [k, e.target.value];
                  setF({ ...f, policies: next });
                }}
                placeholder={loc('نص السياسة كما يقرؤه الزبون', 'The policy as customers read it', 'دەق')}
                className="w-full rounded-lg bg-black/40 border border-white/10 px-2.5 py-2 text-white text-[12.5px] outline-none focus:border-gold/40 resize-none"
              />
            </div>
          ))}
        </div>
      </Card>

      <Card title={loc('روابط التواصل', 'Social links', 'بەستەرەکان')}>
        <div className="space-y-2">
          {f.social_links.map(([k, v], i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <input
                value={k}
                onChange={(e) => {
                  const next = [...f.social_links];
                  next[i] = [e.target.value, v];
                  setF({ ...f, social_links: next });
                }}
                placeholder={loc('المنصة', 'Platform', 'پلاتفۆرم')}
                className="w-28 h-10 rounded-xl bg-black/40 border border-white/10 px-2.5 text-white text-[12.5px] outline-none focus:border-gold/40 shrink-0"
              />
              <input
                value={v}
                dir="ltr"
                onChange={(e) => {
                  const next = [...f.social_links];
                  next[i] = [k, e.target.value];
                  setF({ ...f, social_links: next });
                }}
                placeholder="https://…"
                className="flex-1 min-w-0 h-10 rounded-xl bg-black/40 border border-white/10 px-2.5 text-white text-[12.5px] outline-none focus:border-gold/40"
              />
              <button
                type="button"
                onClick={() => setF({ ...f, social_links: f.social_links.filter((_, j) => j !== i) })}
                className="w-8 h-8 rounded-lg text-text-muted hover:text-red-300 shrink-0"
              >
                ×
              </button>
            </div>
          ))}
          <Btn kind="ghost" small onClick={() => setF({ ...f, social_links: [...f.social_links, ['Instagram', '']] })}>
            + {loc('إضافة رابط', 'Add link', 'بەستەر زیاد بکە')}
          </Btn>
          <p className="text-text-muted text-[10.5px]">
            {loc('روابط http/https فقط — أي شيء آخر يُهمل.', 'http/https links only — anything else is dropped.', 'تەنها http/https.')}
          </p>
        </div>
      </Card>

      <Card title={loc('ما يقدّمه متجرك', 'What your store offers', 'ئەوەی فرۆشگاکەت پێشکەشی دەکات')}>
        <div className="space-y-2.5">
          <Toggle
            label={loc('منتجات جاهزة للبيع', 'Ready-made products', 'بەرهەمی ئامادە')}
            on={f.sells_direct_products}
            onChange={(v) => setF({ ...f, sells_direct_products: v })}
          />
          <Toggle
            label={loc('طلبات مخصصة (طباعة حسب الطلب)', 'Custom requests (print on demand)', 'داواکاری تایبەت')}
            on={f.accepts_custom_requests}
            onChange={(v) => setF({ ...f, accepts_custom_requests: v })}
          />
        </div>
      </Card>

      <Card title={loc('حالة المتجر', 'Store status', 'دۆخی فرۆشگا')}>
        {suspended ? (
          <Notice
            text={loc(
              'المتجر موقوف من إدارة Levonis ولا يمكن إعادة فتحه من هنا. تواصل مع الدعم.',
              'This store is suspended by Levonis and cannot be re-opened from here. Contact support.',
              'فرۆشگاکە لەلایەن LEVONIS ڕاگیراوە.'
            )}
          />
        ) : (
          <Toggle
            label={
              f.open
                ? loc('المتجر مفتوح ويستقبل الطلبات', 'Open and taking orders', 'کراوەیە')
                : loc('المتجر متوقّف مؤقتًا', 'Temporarily paused', 'ڕاگیراوە')
            }
            on={f.open}
            onChange={(v) => setF({ ...f, open: v })}
          />
        )}
      </Card>

      {error && <p className="text-red-400 text-[12px]">{error}</p>}

      <Btn onClick={save} disabled={saving} full>
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
        {saved ? loc('تم الحفظ', 'Saved', 'پاشەکەوت کرا') : loc('حفظ التغييرات', 'Save changes', 'پاشەکەوتکردن')}
      </Btn>

      {/* The store's link, its QR code, the card it unfurls as and the app a
          customer installs (W2-D) — its own actions, outside the form's save. */}
      <ShareStore />

      <SlugCard currentSlug={store.slug} url={store.url} onChanged={onSaved} />
    </div>
  );
}

/**
 * One group of three profile widgets — the reusable editor behind both the
 * links row and the info-cards row. Per item: icon (from the fixed set),
 * title, the value (URL for links, secondary text for cards), show/hide,
 * and order within the group. Array order IS the display order.
 */
function WidgetGroupEditor({
  kind,
  label,
  items,
  onChange,
}: {
  kind: 'link' | 'fact';
  label: string;
  items: ProfileWidget[];
  onChange: (items: ProfileWidget[]) => void;
}) {
  const { loc, lang } = useLanguage();

  const set = (i: number, patch: Partial<ProfileWidget>) => {
    const next = [...items];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div>
      <p className="text-zinc-400 text-[12px] font-semibold mb-2">{label}</p>
      <div className="space-y-2">
        {items.map((w, i) => (
          <div key={i} className={`rounded-xl border p-2 space-y-1.5 ${w.visible === false ? 'border-white/5 opacity-60' : 'border-white/10'} bg-black/25`}>
            <div className="flex items-center gap-1.5">
              <div className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/10 flex items-center justify-center shrink-0">
                <WidgetIcon name={w.icon} className="w-4 h-4 text-zinc-300" />
              </div>
              <select
                value={w.icon}
                onChange={(e) => set(i, { icon: e.target.value })}
                className="w-24 h-8 rounded-lg bg-black/40 border border-white/10 px-1.5 text-zinc-300 text-[11px] outline-none focus:border-gold/40 shrink-0"
                aria-label={loc('الأيقونة', 'Icon', 'ئایکۆن')}
              >
                {WIDGET_ICONS.map((ic) => (
                  <option key={ic.id} value={ic.id}>
                    {lang === 'en' ? ic.en : ic.ar}
                  </option>
                ))}
              </select>
              <input
                value={w.title}
                onChange={(e) => set(i, { title: e.target.value })}
                placeholder={loc('العنوان', 'Title', 'ناونیشان')}
                maxLength={30}
                className="flex-1 min-w-0 h-8 rounded-lg bg-black/40 border border-white/10 px-2 text-white text-[12px] outline-none focus:border-gold/40"
              />
            </div>
            {kind === 'link' ? (
              <input
                value={w.url ?? ''}
                onChange={(e) => set(i, { url: e.target.value })}
                dir="ltr"
                placeholder="https://…"
                className="w-full h-8 rounded-lg bg-black/40 border border-white/10 px-2 text-white text-[12px] outline-none focus:border-gold/40"
              />
            ) : (
              <input
                value={w.subtitle ?? ''}
                onChange={(e) => set(i, { subtitle: e.target.value })}
                placeholder={loc('النص الثانوي', 'Secondary text', 'دەقی لاوەکی')}
                maxLength={40}
                className="w-full h-8 rounded-lg bg-black/40 border border-white/10 px-2 text-white text-[12px] outline-none focus:border-gold/40"
              />
            )}
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="w-7 h-7 rounded-lg border border-white/10 text-zinc-400 disabled:opacity-30 flex items-center justify-center">
                <ArrowUp className="w-3 h-3" />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} className="w-7 h-7 rounded-lg border border-white/10 text-zinc-400 disabled:opacity-30 flex items-center justify-center">
                <ArrowDown className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => set(i, { visible: w.visible === false })}
                className={`h-7 px-2 rounded-lg border text-[10.5px] font-semibold inline-flex items-center gap-1 ${
                  w.visible === false ? 'border-amber-500/30 text-amber-400' : 'border-white/10 text-zinc-400'
                }`}
              >
                {w.visible === false ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {w.visible === false ? loc('مخفي', 'Hidden', 'شاراوە') : loc('ظاهر', 'Visible', 'دیارە')}
              </button>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="w-7 h-7 rounded-lg border border-red-500/30 text-red-300 flex items-center justify-center ms-auto"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {items.length < 3 && (
        <button
          type="button"
          onClick={() =>
            onChange([
              ...items,
              kind === 'link'
                ? { icon: items.length === 0 ? 'globe' : items.length === 1 ? 'instagram' : 'tiktok', title: '', url: '', visible: true }
                : { icon: items.length === 0 ? 'map-pin' : items.length === 1 ? 'clock' : 'truck', title: '', subtitle: '', visible: true },
            ])
          }
          className="relative lv-hit mt-2 h-8 px-3 rounded-lg border border-dashed border-white/15 text-zinc-400 text-[11.5px] font-semibold inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Plus className="w-3 h-3" />
          {loc('إضافة عنصر', 'Add item', 'زیادکردن')} ({items.length}/3)
        </button>
      )}
    </div>
  );
}

/** Changing the store address — controlled, checked live, parked-not-released. */
function SlugCard({ currentSlug, url, onChanged }: { currentSlug: string; url: string; onChanged: () => void }) {
  const { loc, lang } = useLanguage();
  const [confirm, confirmDialog] = useConfirm();
  const [slug, setSlug] = useState(currentSlug);
  const [check, setCheck] = useState<{ ok: boolean; reason: SlugRejection | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function verify(v: string) {
    setSlug(v);
    setCheck(null);
    setError('');
    const clean = v.trim().toLowerCase();
    if (!clean || clean === currentSlug) return;
    try {
      const r = await merchantApi.checkSlug(clean);
      setCheck({ ok: r.ok, reason: r.reason });
    } catch {
      /* typing continues */
    }
  }

  async function apply() {
    const ok = await confirm({
      title: loc('تغيير عنوان المتجر؟', 'Change the store address?', 'ناونیشان بگۆڕدرێت؟'),
      // OWNER: Sorani to be written by hand.
      consequence: loc(
        'العنوان القديم يبقى محجوزًا لك فترة ثم يتحرر — حدّث روابطك المطبوعة.',
        'The old one stays parked for a while, then frees up — update your printed links.'
      ),
      confirmLabel: loc('تغيير', 'Change', 'گۆڕین'),
      cancelLabel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await merchantApi.changeSlug(slug.trim().toLowerCase());
      onChanged();
    } catch (e) {
      setError(merchantRefusal(e, lang, loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت')));
    } finally {
      setBusy(false);
    }
  }

  const changed = slug.trim().toLowerCase() !== currentSlug;

  return (
    <Card title={loc('عنوان المتجر', 'Store address', 'ناونیشانی فرۆشگا')}>
      <p className="text-text-muted text-[11.5px] mb-2 flex items-center gap-1.5" dir="ltr">
        <Globe className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{url.replace(/^https?:\/\//, '')}</span>
      </p>
      <div className="flex gap-2">
        <Input value={slug} onChange={verify} ltr placeholder="my-store" />
        <Btn onClick={apply} disabled={busy || !changed || (check !== null && !check.ok)}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : loc('تغيير', 'Change', 'گۆڕین')}
        </Btn>
      </div>
      {check && !check.ok && (
        <p className="text-amber-400 text-[11px] mt-1.5 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          {slugMessage(check.reason, loc)}
        </p>
      )}
      {check?.ok && changed && (
        <p className="text-emerald-400 text-[11px] mt-1.5">{loc('العنوان متاح', 'Available', 'بەردەستە')}</p>
      )}
      {error && <p className="text-red-400 text-[11px] mt-1.5">{error}</p>}
      {confirmDialog}
    </Card>
  );
}
