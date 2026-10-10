/**
 * Store identity and setup — the «ابنِ متجرك» screen.
 *
 * Everything a merchant may legitimately shape about their shop, in one
 * place: words, images, colours (presets only, §12), the header's links and
 * cards, contact and location, hours, policies, social links, what the store
 * offers, its status — then, with their own actions, delivery, the share kit
 * and the address. Every field maps 1:1 to a column the server validates;
 * nothing here is decorative.
 *
 * WHAT «SAVED» MEANS (review of this screen, 2026-09-28). The form's rules
 * live in storeSettingsModel.ts and are the server's own: the limits are
 * drawn on the fields, links go through the same `profileHref` the server
 * applies, and a problem is shown on the field it is about — before sending
 * when the form can see it, from the refusal's code when only the server can.
 * After a save the form is rebuilt from the store the server RETURNED, so it
 * shows what was kept. «تم الحفظ» shows only while nothing has changed since,
 * and leaving with unsaved changes asks first.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { AccentSample } from '../AccentSample';
import { Link } from 'react-router-dom';
// «ملف الورشة» (Phase 5d): the workshop's own section, its own save.
import { useContext } from 'react';
import { Card as SurfaceCard } from '../../ui/Card';
import { Field, Textarea } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Button, IconButton } from '../../ui/Button';
import { ErrorState } from '../../ui/AsyncStates';
import { refusalText } from '../../../lib/refusalStrings';
import { merchantHref } from '../../../lib/merchantRoutes';
import { WorkspaceContext } from '../shell/context';
import { offersV2Api, type RequestPrefsV2 } from '../../community/requests/api';
import { fillWorkshop, useWorkshopStrings, workshopLang, type WorkshopStrings } from './strings';
import {
  LIMITS,
  fieldErrorFromRefusal,
  formFromStore,
  formSignature,
  nextNetwork,
  patchFromForm,
  socialRowForKey,
  validateForm,
  widgetRowForSentIndex,
  type FieldError,
  type SettingsForm,
} from './storeSettingsModel';

/** Delivery by governorate (W2-A): its own editor, its own save, its own chunk. */
const DeliverySettingsEditor = lazy(() => import('../delivery/DeliverySettingsEditor'));

type Loc = (ar: string, en: string, ckb?: string) => string;

/** The seven store colours' names; each is drawn by `AccentSample` (../AccentSample.tsx). */
const ACCENT_NAMES: Array<{ id: string; ar: string; en: string }> = [
  { id: 'default', ar: 'Levonis', en: 'Levonis' },
  { id: 'olive', ar: 'زيتوني', en: 'Olive' },
  { id: 'gold', ar: 'ذهبي', en: 'Gold' },
  { id: 'slate', ar: 'رمادي', en: 'Slate' },
  { id: 'plum', ar: 'بنفسجي', en: 'Plum' },
  { id: 'teal', ar: 'فيروزي', en: 'Teal' },
  { id: 'blue', ar: 'أزرق', en: 'Blue' },
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

const FIELD_NAMES: Record<string, [string, string]> = {
  name: ['اسم المتجر', 'The store name'],
  tagline: ['الوصف المختصر', 'The tagline'],
  description: ['«عن المتجر»', '«About»'],
  contact_phone: ['رقم التواصل', 'The contact phone'],
  logo_key: ['الشعار', 'The logo'],
  banner_key: ['الغلاف', 'The banner'],
  accent: ['لون المتجر', 'The store colour'],
};

/** One sentence per problem, in the merchant's language. */
export function fieldErrorText(e: FieldError, loc: Loc): string {
  const [ar, en] = FIELD_NAMES[e.field] ?? ['', ''];
  switch (e.kind) {
    case 'short':
      // OWNER: Sorani to be written by hand.
      return loc(`${ar || 'الحقل'} يجب أن يكون ${e.min ?? 1} أحرف على الأقل.`, `${en || 'This field'} needs at least ${e.min ?? 1} characters.`);
    case 'long':
      // OWNER: Sorani to be written by hand.
      return loc(`أطول من المسموح (${e.max ?? ''} حرفًا).`, `Longer than allowed (${e.max ?? ''} characters).`);
    case 'invalid_url':
      // OWNER: Sorani to be written by hand.
      return loc('هذا ليس رابط موقع. اكتبه مثل instagram.com/اسمك', 'That is not a web address. Write it like instagram.com/yourname');
    case 'duplicate':
      // OWNER: Sorani to be written by hand.
      return loc('مكرر — لكل اسم سطر واحد.', 'Repeated — one row per name.');
    case 'untitled':
      // OWNER: Sorani to be written by hand.
      return loc('يحتاج هذا السطر إلى عنوان.', 'This row needs a title.');
    case 'too_many':
      // OWNER: Sorani to be written by hand.
      return loc(`الحد الأقصى ${e.max ?? ''}.`, `At most ${e.max ?? ''}.`);
    case 'not_owned':
      // OWNER: Sorani to be written by hand.
      return loc(`${ar || 'الصورة'}: اختر صورة رفعتها أنت من هنا.`, `${en || 'The picture'}: choose a picture you uploaded here.`);
    default:
      // OWNER: Sorani to be written by hand.
      return loc(`${ar || 'القيمة'} غير صالحة.`, `${en || 'The value'} is not valid.`);
  }
}

/**
 * The save's refusals as this screen's own sentences — the server's codes,
 * never its English text (the codes are pinned in worker/routes/merchant.ts).
 * The four re-open refusals refuse the WHOLE save: nothing was written, and
 * the sentence says so and says how to save the rest.
 */
function settingsRefusal(e: unknown, loc: Loc): string {
  const code = e instanceof ApiError ? e.code : '';
  switch (code) {
    case 'STORE_SUSPENDED':
      return loc('لم يُحفظ شيء: المتجر موقوف من Levonis ولا يُعاد فتحه من هنا. أطفئ «مفتوح» ثم احفظ بقية التغييرات.', 'Nothing was saved: Levonis has suspended this store and it cannot be re-opened from here. Switch «Open» off, then save the rest.'); // OWNER: Sorani to be written by hand.
    case 'MERCHANT_SUSPENDED':
      return loc('لم يُحفظ شيء: حساب التاجر موقوف، فلا يُفتح المتجر. أطفئ «مفتوح» ثم احفظ، وتواصل مع الدعم.', 'Nothing was saved: your merchant account is suspended, so the store cannot open. Switch «Open» off, save, and contact support.'); // OWNER: Sorani to be written by hand.
    case 'SUBSCRIPTION_INACTIVE':
      return loc('لم يُحفظ شيء: اشتراكك غير فعّال فلا يُعاد فتح المتجر. جدّده، أو أطفئ «مفتوح» واحفظ بقية التغييرات.', 'Nothing was saved: your subscription is not active, so the store cannot re-open. Renew it, or switch «Open» off and save the rest.'); // OWNER: Sorani to be written by hand.
    case 'GOVERNORATE_INVALID':
      return loc('اختر المحافظة من القائمة.', 'Choose a governorate from the list.'); // OWNER: Sorani to be written by hand.
    case 'DELIVERY_NO_COVERAGE':
      return loc('لم يُحفظ شيء: لا يُفتح المتجر قبل أن توصل إلى محافظة واحدة على الأقل أو تفعّل الاستلام — من «التوصيل حسب المحافظة». أو أطفئ «مفتوح» واحفظ بقية التغييرات.', 'Nothing was saved: the store cannot open until it delivers to at least one governorate or offers pickup — see «Delivery by governorate». Or switch «Open» off and save the rest.'); // OWNER: Sorani to be written by hand.
    case 'RATE_LIMITED':
      return loc('حفظت كثيرًا في وقت قصير — انتظر دقيقة ثم احفظ.', 'You saved many times in a short while — wait a minute, then save.'); // OWNER: Sorani to be written by hand.
    default:
      return loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت');
  }
}

/** A 44px icon button with a spoken name — the rows' ×, ↑ and ↓ (the shared IconButton). */
function RowButton({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return <IconButton label={label} icon={children} onClick={onClick} disabled={disabled} variant={danger ? 'danger' : 'ghost'} />;
}

const rowError = (errors: FieldError[], field: string, index: number) => errors.find((e) => e.field === field && e.index === index);
const listError = (errors: FieldError[], field: string) => errors.find((e) => e.field === field && e.index === undefined);
const fieldError = (errors: FieldError[], field: string) => errors.find((e) => e.field === field && e.index === undefined);

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

  const [f, setF] = useState<SettingsForm>(() => formFromStore(store));
  const [baseline, setBaseline] = useState(() => formSignature(formFromStore(store)));
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [tried, setTried] = useState(false);
  const formRef = useRef<HTMLDivElement | null>(null);

  const suspended = store.status === 'suspended';
  const dirty = formSignature(f) !== baseline;
  const edit = useCallback((patch: Partial<SettingsForm>) => setF((cur) => ({ ...cur, ...patch })), []);

  // After a first failed save, the problems follow the typing: a fixed field
  // stops being red at once, without another press of «حفظ».
  const live = useMemo(() => (tried ? validateForm(f) : []), [tried, f]);
  const shown = tried ? [...live, ...errors.filter((e) => !live.some((l) => l.field === e.field && l.index === e.index))] : errors;

  // Leaving with unsaved changes asks the browser's own question.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function focusFirstProblem() {
    requestAnimationFrame(() => {
      const el = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      el?.focus();
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  async function save() {
    setError('');
    setTried(true);
    const problems = validateForm(f);
    setErrors([]);
    if (problems.length) {
      // OWNER: Sorani to be written by hand.
      setError(loc('صحّح الحقول المعلّمة ثم احفظ.', 'Fix the marked fields, then save.'));
      focusFirstProblem();
      return;
    }
    setSaving(true);
    try {
      const res = await merchantApi.updateStore(patchFromForm(f, store));
      // What the SERVER kept, not what was typed.
      const next = formFromStore(res.store);
      setF(next);
      setBaseline(formSignature(next));
      setSavedOnce(true);
      setTried(false);
      onSaved();
    } catch (e) {
      const fe = e instanceof ApiError ? fieldErrorFromRefusal(e.code ?? '', e.details) : null;
      if (fe) {
        if (fe.field === 'social_links' && fe.index === undefined && e instanceof ApiError) {
          fe.index = socialRowForKey(f.social_links, e.details?.key);
        }
        if (fe.field === 'profile_links') fe.index = widgetRowForSentIndex(f.profile_links, fe.index);
        setErrors([fe]);
        // OWNER: Sorani to be written by hand.
        setError(loc('صحّح الحقل المعلّم ثم احفظ.', 'Fix the marked field, then save.'));
        focusFirstProblem();
      } else {
        setError(settingsRefusal(e, loc));
      }
    } finally {
      setSaving(false);
    }
  }

  const err = (field: string) => {
    const e = fieldError(shown, field);
    return e ? fieldErrorText(e, loc) : undefined;
  };

  // The share kit is keyed on what it is built from, so a saved logo, name,
  // tagline or a new address shows at once — it used to keep the old address
  // (and its QR) until the page was reloaded.
  const shareKey = `${store.slug}|${store.name}|${store.tagline}|${store.logoUrl ?? ''}|${store.accent}`;

  return (
    <div className="space-y-3" ref={formRef} data-store-settings>
      <Card title={loc('هوية المتجر', 'Store identity', 'ناسنامەی فرۆشگا')}>
        <div className="space-y-4">
          <Input
            label={loc('اسم المتجر', 'Store name', 'ناو')}
            value={f.name}
            onChange={(v) => edit({ name: v })}
            maxLength={LIMITS.name.max}
            error={err('name')}
          />
          <Input
            label={loc('وصف مختصر', 'Tagline', 'وەسفی کورت')}
            value={f.tagline}
            onChange={(v) => edit({ tagline: v })}
            maxLength={LIMITS.tagline.max}
            error={err('tagline')}
            // OWNER: Sorani to be written by hand.
            hint={loc('سطر واحد عن متجرك — يظهر تحت الاسم حين يخلو «عن المتجر»، وفي بطاقة المشاركة.', 'One line about your shop — shown under the name when «About» is empty, and on the share card.')}
          />
          <TextArea
            label={loc('عن المتجر', 'About', 'دەربارە')}
            value={f.description}
            onChange={(v) => edit({ description: v })}
            rows={4}
            maxLength={LIMITS.description.max}
            error={err('description')}
          />
          <ImagePicker
            label={loc('الشعار', 'Logo', 'لۆگۆ')}
            // OWNER: Sorani to be written by hand.
            hint={loc('مربّع، 512×512 بكسل أو أكبر — يظهر بجانب اسمك وأيقونةً لتطبيق متجرك.', 'Square, 512×512 px or larger — shown beside your name and as your store app’s icon.')}
            shape="square"
            value={f.logo_key}
            onChange={(v) => edit({ logo_key: v })}
            error={err('logo_key')}
          />
          <ImagePicker
            label={loc('الغلاف', 'Banner', 'بەرگ')}
            // OWNER: Sorani to be written by hand.
            hint={loc('عريض (3:1)، 1500×500 بكسل مثلًا — أعلى صفحة متجرك.', 'Wide (3:1), e.g. 1500×500 px — the top of your shop page.')}
            shape="wide"
            value={f.banner_key}
            onChange={(v) => edit({ banner_key: v })}
            error={err('banner_key')}
          />
          <div role="radiogroup" aria-label={loc('لون المتجر', 'Store colour', 'ڕەنگی فرۆشگا')}>
            <p className="block text-text-secondary text-[12px] font-semibold mb-1.5">{loc('لون المتجر', 'Store colour', 'ڕەنگی فرۆشگا')}</p>
            <div className="flex gap-x-1.5 gap-y-2 flex-wrap">
              {ACCENT_NAMES.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={f.accent === a.id}
                  data-accent={a.id}
                  onClick={() => edit({ accent: a.id })}
                  // A choice (lv-choice): chosen is a press plus the gold start bar.
                  className="lv-choice lv-hit ps-1.5 pe-3 text-[12px] font-semibold inline-flex items-center gap-2"
                >
                  <AccentSample accent={a.id} />
                  {loc(a.ar, a.en)}
                  {f.accent === a.id && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card title={loc('واجهة المتجر — الروابط والبطاقات', 'Profile — links & info cards', 'ڕووکاری فرۆشگا')}>
        <p className="text-text-muted text-[11.5px] leading-relaxed mb-3">
          {loc(
            'ستة عناصر أعلى صفحة متجرك: ثلاثة روابط (موقعك، إنستغرام…) وثلاث بطاقات معلومات (الموقع، وقت التجهيز، الشحن…). لكل عنصر أيقونة وعنوان وقيمة، ويمكنك إخفاؤه أو إعادة ترتيبه. حين تحذف كل البطاقات تعود البطاقات التلقائية (الموقع والتوصيل).',
            'Six items at the top of your shop page: three links (your site, Instagram…) and three info cards (location, prep time, shipping…). Each has an icon, a title and a value, and can be hidden or reordered. Delete every card and the automatic ones (location, delivery) come back.'
          )}
          {/* OWNER: Sorani to be written by hand. */}
        </p>
        <WidgetGroupEditor
          kind="link"
          label={loc('الروابط الثلاثة', 'The three links', 'سێ بەستەرەکە')}
          items={f.profile_links}
          errors={shown.filter((e) => e.field === 'profile_links')}
          onChange={(profile_links) => edit({ profile_links })}
        />
        <div className="h-3" />
        <WidgetGroupEditor
          kind="fact"
          label={loc('بطاقات المعلومات الثلاث', 'The three info cards', 'سێ کارتی زانیاری')}
          items={f.profile_facts}
          errors={shown.filter((e) => e.field === 'profile_facts')}
          onChange={(profile_facts) => edit({ profile_facts })}
        />
      </Card>

      <Card title={loc('التواصل والموقع', 'Contact & location')}>
        {/* OWNER: Sorani to be written by hand. */}
        <div className="space-y-3">
          <div>
            <label htmlFor="store-governorate" className="block text-text-secondary text-[12px] font-semibold mb-1.5">
              {loc('المحافظة', 'Governorate', 'پارێزگا')}
            </label>
            <select
              className="lv-input text-[13px]"
              id="store-governorate"
              value={f.governorate}
              onChange={(e) => edit({ governorate: e.target.value })}
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
            onChange={(v) => edit({ contact_phone: v })}
            ltr
            type="tel"
            inputMode="tel"
            maxLength={LIMITS.phone.max}
            error={err('contact_phone')}
          />
          <Toggle
            label={loc('إظهار الرقم للزبائن', 'Show the number publicly', 'ژمارە بە گشتی')}
            on={f.contact_phone_public}
            onChange={(v) => edit({ contact_phone_public: v })}
            // OWNER: Sorani to be written by hand.
            hint={loc('مطفأ: لا يُعرض الرقم في صفحة متجرك، ولا يُعطى لزبون قبلت عرضه — تتواصلان بالرسائل.', 'Off: the number is not shown on your page, nor given to a customer whose offer you won — you talk by message.')}
          />
          <ChipListEditor
            label={loc('مناطق التغطية', 'Service areas', 'ناوچەکانی گەیاندن')}
            values={f.service_areas}
            onChange={(service_areas) => edit({ service_areas })}
            placeholder={loc('بغداد، أربيل، كل العراق… ثم Enter', 'Baghdad, Erbil, all of Iraq… then Enter', '…')}
            // OWNER: Sorani to be written by hand.
            hint={loc('كلمات تُعرض للزبون. أجرة التوصيل وأين توصل فعلًا تحدّدها في «التوصيل حسب المحافظة».', 'Words customers read. What you actually deliver, and for how much, is set in «Delivery by governorate».')}
          />
          <ChipListEditor
            label={loc('تخصصات المتجر', 'Store categories', 'پۆلەکان')}
            values={f.categories}
            onChange={(categories) => edit({ categories })}
            placeholder={loc('طباعة FDM، ريزن، تصميم… ثم Enter', 'FDM printing, resin, design… then Enter', '…')}
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
          {f.business_hours.map((h, i) => {
            const rowErr = rowError(shown, 'business_hours', i);
            const setRow = (patch: Partial<typeof h>) => {
              const next = [...f.business_hours];
              next[i] = { ...h, ...patch };
              edit({ business_hours: next });
            };
            return (
              <div key={i} className="rounded-lg border border-border-subtle bg-surface-raised p-2 space-y-2" data-hours-row>
                {/* The day, whether it is open, and its ×, on one line; its
                    hours on the next — two time fields beside the switch did
                    not fit a phone and wrapped one of them alone. */}
                <div className="flex gap-1.5 items-center">
                  <input
                    className="lv-input flex-1 min-w-0 text-[13px]"
                    list="day-presets"
                    value={h.day}
                    maxLength={LIMITS.day}
                    onChange={(e) => setRow({ day: e.target.value })}
                    aria-label={loc('اليوم', 'Day', 'ڕۆژ')}
                    aria-invalid={rowErr ? true : undefined}
                    placeholder={loc('اليوم', 'Day', 'ڕۆژ')}
                  />
                  <button
                    type="button"
                    role="switch"
                    aria-checked={h.closed}
                    aria-label={loc(`مغلق — ${h.day || 'اليوم'}`, `Closed — ${h.day || 'this day'}`)}
                    onClick={() => setRow({ closed: !h.closed })}
                    data-hours-closed={h.closed ? 'true' : 'false'}
                    // Closed is the switch ON: pressed in (the well and the press), its word in the warning ink.
                    className={`shrink-0 min-h-11 px-3 rounded-md border text-[12.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                      h.closed ? 'border-transparent bg-[var(--clay-well-bg)] shadow-press text-warning' : 'border-border-subtle bg-surface-raised shadow-xs text-text-secondary'
                    }`}
                  >
                    {/* OWNER: Sorani to be written by hand. */}
                    {h.closed ? loc('مغلق', 'Closed') : loc('مفتوح', 'Open')}
                  </button>
                  <RowButton
                    label={loc('حذف هذا اليوم', 'Remove this day')}
                    danger
                    onClick={() => edit({ business_hours: f.business_hours.filter((_, j) => j !== i) })}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </RowButton>
                </div>
                {!h.closed && (
                  <div className="flex gap-1.5 items-center" dir="ltr">
                    <input
                      className="lv-input min-w-0 flex-1 px-2 text-[13px]"
                      type="time"
                      value={h.open}
                      onChange={(e) => setRow({ open: e.target.value })}
                      aria-label={loc('يفتح', 'Opens')}
                    />
                    <span aria-hidden="true" className="text-text-muted">–</span>
                    <input
                      className="lv-input min-w-0 flex-1 px-2 text-[13px]"
                      type="time"
                      value={h.close}
                      onChange={(e) => setRow({ close: e.target.value })}
                      aria-label={loc('يغلق', 'Closes')}
                    />
                  </div>
                )}
                {rowErr && <p className="text-red-400 text-[11.5px]" role="alert">{fieldErrorText(rowErr, loc)}</p>}
              </div>
            );
          })}
          <datalist id="day-presets">
            {DAY_PRESETS.map(([ar, en]) => (
              <option key={en} value={lang === 'en' ? en : ar} />
            ))}
          </datalist>
          {listError(shown, 'business_hours') && (
            <p className="text-red-400 text-[11.5px]" role="alert">{fieldErrorText(listError(shown, 'business_hours')!, loc)}</p>
          )}
          <Btn
            kind="ghost"
            small
            disabled={f.business_hours.length >= LIMITS.hours}
            onClick={() => edit({ business_hours: [...f.business_hours, { day: '', open: '09:00', close: '18:00', closed: false }] })}
          >
            + {loc('إضافة يوم', 'Add a day')} ({f.business_hours.length}/{LIMITS.hours})
            {/* OWNER: Sorani to be written by hand. */}
          </Btn>
        </div>
      </Card>

      <Card title={loc('سياسات المتجر', 'Store policies', 'سیاسەتەکان')}>
        <div className="space-y-2.5">
          <div className="flex gap-1.5 flex-wrap">
            {POLICY_PRESETS.map(([ar, en, ckb]) => {
              const key = loc(ar, en, ckb);
              const exists = f.policies.some(([k]) => k.trim() === key);
              return (
                <Chip
                  key={en}
                  label={`+ ${key}`}
                  active={false}
                  disabled={exists || f.policies.length >= LIMITS.policies}
                  onClick={() => edit({ policies: [...f.policies, [key, '']] })}
                />
              );
            })}
          </div>
          {f.policies.map(([k, v], i) => {
            const rowErr = rowError(shown, 'policies', i);
            return (
              <div key={i} className="rounded-lg bg-surface-raised border border-border-subtle p-2.5 space-y-1.5" data-policy-row>
                <div className="flex gap-1.5 items-center">
                  <input
                    className="lv-input flex-1 min-w-0 px-2.5 text-[13px] font-semibold"
                    value={k}
                    maxLength={LIMITS.policyTitle}
                    onChange={(e) => {
                      const next = [...f.policies];
                      next[i] = [e.target.value, v];
                      edit({ policies: next });
                    }}
                    aria-label={loc('عنوان السياسة', 'Policy title', 'ناونیشان')}
                    aria-invalid={rowErr ? true : undefined}
                    placeholder={loc('عنوان السياسة', 'Policy title', 'ناونیشان')}
                  />
                  <RowButton label={loc('حذف هذه السياسة', 'Remove this policy')} danger onClick={() => edit({ policies: f.policies.filter((_, j) => j !== i) })}>
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </RowButton>
                </div>
                <textarea
                  className="lv-input px-2.5 py-2 text-[13px] leading-relaxed resize-y"
                  value={v}
                  rows={3}
                  maxLength={LIMITS.policyText}
                  onChange={(e) => {
                    const next = [...f.policies];
                    next[i] = [k, e.target.value];
                    edit({ policies: next });
                  }}
                  aria-label={loc('نص السياسة', 'Policy text')}
                  placeholder={loc('نص السياسة كما يقرؤه الزبون', 'The policy as customers read it', 'دەق')}
                />
                {rowErr && <p className="text-red-400 text-[11.5px]" role="alert">{fieldErrorText(rowErr, loc)}</p>}
              </div>
            );
          })}
          {listError(shown, 'policies') && <p className="text-red-400 text-[11.5px]" role="alert">{fieldErrorText(listError(shown, 'policies')!, loc)}</p>}
          <Btn kind="ghost" small disabled={f.policies.length >= LIMITS.policies} onClick={() => edit({ policies: [...f.policies, ['', '']] })}>
            + {loc('سياسة أخرى', 'Another policy')} ({f.policies.length}/{LIMITS.policies})
            {/* OWNER: Sorani to be written by hand. */}
          </Btn>
        </div>
      </Card>

      <Card title={loc('روابط التواصل الاجتماعي', 'Social links')}>
        {/* OWNER: Sorani to be written by hand. */}
        <div className="space-y-2">
          <p className="text-text-muted text-[11.5px] leading-relaxed">
            {loc(
              'تظهر في «عن المتجر». اكتب العنوان كما هو — instagram.com/اسمك — ونضيف https:// بأنفسنا.',
              'Shown under «About». Type the address as it is — instagram.com/yourname — and we add https:// ourselves.'
            )}
            {/* OWNER: Sorani to be written by hand. */}
          </p>
          {f.social_links.map(([k, v], i) => {
            const rowErr = rowError(shown, 'social_links', i);
            return (
              <div key={i} className="space-y-1" data-social-row>
                <div className="flex gap-1.5 items-center">
                  <input
                    className="lv-input w-28 shrink-0 px-2.5 text-[13px]"
                    value={k}
                    maxLength={LIMITS.socialKey}
                    onChange={(e) => {
                      const next = [...f.social_links];
                      next[i] = [e.target.value, v];
                      edit({ social_links: next });
                    }}
                    aria-label={loc('المنصة', 'Platform', 'پلاتفۆرم')}
                    placeholder={loc('المنصة', 'Platform', 'پلاتفۆرم')}
                  />
                  <input
                    className="lv-input flex-1 min-w-0 px-2.5 text-[13px]"
                    value={v}
                    dir="ltr"
                    inputMode="url"
                    onChange={(e) => {
                      const next = [...f.social_links];
                      next[i] = [k, e.target.value];
                      edit({ social_links: next });
                    }}
                    aria-label={loc('رابط', 'Link') + (k ? ` — ${k}` : '')}
                    aria-invalid={rowErr ? true : undefined}
                    placeholder="instagram.com/…"
                  />
                  <RowButton label={loc('حذف هذا الرابط', 'Remove this link')} danger onClick={() => edit({ social_links: f.social_links.filter((_, j) => j !== i) })}>
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </RowButton>
                </div>
                {rowErr && <p className="text-red-400 text-[11.5px]" role="alert">{fieldErrorText(rowErr, loc)}</p>}
              </div>
            );
          })}
          {listError(shown, 'social_links') && <p className="text-red-400 text-[11.5px]" role="alert">{fieldErrorText(listError(shown, 'social_links')!, loc)}</p>}
          <Btn
            kind="ghost"
            small
            disabled={f.social_links.length >= LIMITS.social}
            onClick={() => edit({ social_links: [...f.social_links, [nextNetwork(f.social_links), '']] })}
          >
            + {loc('إضافة رابط', 'Add link', 'بەستەر زیاد بکە')} ({f.social_links.length}/{LIMITS.social})
          </Btn>
        </div>
      </Card>

      <Card title={loc('ما يقدّمه متجرك', 'What your store offers', 'ئەوەی فرۆشگاکەت پێشکەشی دەکات')}>
        <div className="space-y-2.5">
          <Toggle
            label={loc('منتجات جاهزة للبيع', 'Ready-made products', 'بەرهەمی ئامادە')}
            on={f.sells_direct_products}
            onChange={(v) => edit({ sells_direct_products: v })}
          />
          <Toggle
            label={loc('طلبات مخصصة (طباعة حسب الطلب)', 'Custom requests (print on demand)', 'داواکاری تایبەت')}
            on={f.accepts_custom_requests}
            onChange={(v) => edit({ accepts_custom_requests: v })}
            // OWNER: Sorani to be written by hand.
            hint={loc('مطفأ: لا تُعرض عليك طلبات الطباعة الجديدة، ويختفي زر «اطلب عرض سعر» من صفحتك.', 'Off: you are not shown new print requests, and the «Request a quote» button leaves your page.')}
          />
        </div>
      </Card>

      <Card title={loc('حالة المتجر', 'Store status', 'دۆخی فرۆشگا')}>
        {suspended ? (
          <div className="space-y-2">
            <Notice
              text={loc(
                'المتجر موقوف من إدارة Levonis ولا يمكن إعادة فتحه من هنا. تواصل مع الدعم.',
                'This store is suspended by Levonis and cannot be re-opened from here. Contact support.',
                'فرۆشگاکە لەلایەن LEVONIS ڕاگیراوە.'
              )}
            />
            {store.status_reason ? (
              <p className="text-[12.5px] leading-relaxed text-text-secondary" data-suspension-reason>
                {/* OWNER: Sorani to be written by hand. */}
                <span className="font-semibold">{loc('السبب: ', 'Reason: ')}</span>
                <span dir="auto">{store.status_reason}</span>
              </p>
            ) : null}
          </div>
        ) : (
          <Toggle
            label={
              f.open
                ? loc('المتجر مفتوح ويستقبل الطلبات', 'Open and taking orders', 'کراوەیە')
                : loc('المتجر متوقّف مؤقتًا', 'Temporarily paused', 'ڕاگیراوە')
            }
            on={f.open}
            onChange={(v) => edit({ open: v })}
          />
        )}
      </Card>

      {/* THE SAVE BAR — sticks to the bottom of the screen only while there
          is something to save or to say; a clean form keeps it at the end,
          so it does not sit over a phone's last 90px for nothing. */}
      <div
        // Stuck, it is a dock (opaque, the dock cast); at rest it sits flat on the canvas.
        className={`${dirty || saving || error ? 'sticky bottom-0 z-10 bg-surface-raised shadow-dock' : ''} -mx-1 rounded-2xl border border-border-subtle p-2.5`}
        data-settings-savebar
        data-dirty={dirty ? 'true' : 'false'}
      >
        <div aria-live="polite" className={`px-1 text-[12px] ${error || dirty || savedOnce ? 'mb-2' : ''}`}>
          {error ? (
            <p className="text-red-400" role="alert">{error}</p>
          ) : dirty ? (
            // OWNER: Sorani to be written by hand.
            <p className="text-amber-300">{loc('تغييرات غير محفوظة', 'Unsaved changes')}</p>
          ) : savedOnce ? (
            <p className="flex items-center gap-1 text-emerald-400">
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
              {loc('تم الحفظ', 'Saved', 'پاشەکەوت کرا')}
            </p>
          ) : null}
        </div>
        <Btn onClick={save} disabled={saving || !dirty} full data-settings-save>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {loc('حفظ التغييرات', 'Save changes', 'پاشەکەوتکردن')}
        </Btn>
      </div>

      {/* «ملف الورشة» (Phase 5d, §9.5): the workshop's intro and usual
          turnaround, with the facts its printers decide — its own save,
          outside the form's, like everything below. */}
      <WorkshopProfileCard />

      {/* The store's link, its QR code, the card it unfurls as and the app a
          customer installs (W2-D) — its own actions, outside the form's save. */}
      <ShareStore key={shareKey} />

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
  errors,
  onChange,
}: {
  kind: 'link' | 'fact';
  label: string;
  items: ProfileWidget[];
  errors: FieldError[];
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
      <p className="text-text-secondary text-[12px] font-semibold mb-2">{label}</p>
      <div className="space-y-2">
        {items.map((w, i) => {
          const rowErr = errors.find((e) => e.index === i);
          return (
            <div key={i} className={`rounded-lg border border-border-subtle bg-surface-raised p-2 space-y-1.5 ${w.visible === false ? 'opacity-70' : ''}`} data-widget-row={kind}>
              <div className="flex items-center gap-1.5">
                <div className="w-9 h-9 rounded-sm lv-well flex items-center justify-center shrink-0" aria-hidden="true">
                  <WidgetIcon name={w.icon} className="w-4 h-4 text-text-secondary" />
                </div>
                <select
                  className="lv-input w-28 shrink-0 px-1.5 text-[12px]"
                  value={w.icon}
                  onChange={(e) => set(i, { icon: e.target.value })}
                  aria-label={loc('الأيقونة', 'Icon', 'ئایکۆن')}
                >
                  {WIDGET_ICONS.map((ic) => (
                    <option key={ic.id} value={ic.id}>
                      {lang === 'en' ? ic.en : ic.ar}
                    </option>
                  ))}
                </select>
                <input
                  className="lv-input flex-1 min-w-0 px-2 text-[13px]"
                  value={w.title}
                  onChange={(e) => set(i, { title: e.target.value })}
                  aria-label={loc('العنوان', 'Title', 'ناونیشان')}
                  aria-invalid={rowErr?.kind === 'untitled' || rowErr?.kind === 'long' ? true : undefined}
                  placeholder={loc('العنوان', 'Title', 'ناونیشان')}
                  maxLength={LIMITS.widgetTitle}
                />
              </div>
              {kind === 'link' ? (
                <input
                  className="lv-input px-2 text-[13px]"
                  value={w.url ?? ''}
                  onChange={(e) => set(i, { url: e.target.value })}
                  dir="ltr"
                  inputMode="url"
                  aria-label={loc('الرابط', 'Link')}
                  aria-invalid={rowErr?.kind === 'invalid_url' ? true : undefined}
                  placeholder="instagram.com/…"
                />
              ) : (
                <input
                  className="lv-input px-2 text-[13px]"
                  value={w.subtitle ?? ''}
                  onChange={(e) => set(i, { subtitle: e.target.value })}
                  aria-label={loc('النص الثانوي', 'Secondary text', 'دەقی لاوەکی')}
                  placeholder={loc('النص الثانوي', 'Secondary text', 'دەقی لاوەکی')}
                  maxLength={LIMITS.widgetSubtitle}
                />
              )}
              {rowErr && <p className="text-red-400 text-[11.5px]" role="alert">{fieldErrorText(rowErr, loc)}</p>}
              <div className="flex items-center gap-1">
                <RowButton label={loc('نقل للأعلى', 'Move up')} onClick={() => move(i, -1)} disabled={i === 0}>
                  <ArrowUp aria-hidden="true" className="h-4 w-4" />
                </RowButton>
                <RowButton label={loc('نقل للأسفل', 'Move down')} onClick={() => move(i, 1)} disabled={i === items.length - 1}>
                  <ArrowDown aria-hidden="true" className="h-4 w-4" />
                </RowButton>
                <button
                  type="button"
                  role="switch"
                  aria-checked={w.visible !== false}
                  onClick={() => set(i, { visible: w.visible === false })}
                  // Shown is the switch ON: pressed in. Hidden sits flush, its word in the warning ink.
                  className={`h-9 px-2.5 rounded-md border text-[12px] font-semibold inline-flex items-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                    w.visible === false ? 'border-border-subtle bg-surface-raised shadow-xs text-warning' : 'border-transparent bg-[var(--clay-well-bg)] shadow-press text-text-secondary'
                  }`}
                >
                  {w.visible === false ? <EyeOff aria-hidden="true" className="h-3.5 w-3.5" /> : <Eye aria-hidden="true" className="h-3.5 w-3.5" />}
                  {w.visible === false ? loc('مخفي', 'Hidden', 'شاراوە') : loc('ظاهر', 'Visible', 'دیارە')}
                </button>
                <span className="ms-auto" />
                <RowButton label={loc('حذف', 'Remove', 'سڕینەوە')} danger onClick={() => onChange(items.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </RowButton>
              </div>
            </div>
          );
        })}
      </div>
      {items.length < LIMITS.widgets && (
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
          className="relative lv-hit mt-2 min-h-11 px-3 rounded-md border border-dashed border-border-subtle text-text-secondary text-[12.5px] font-semibold inline-flex items-center gap-1 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          {loc('إضافة عنصر', 'Add item', 'زیادکردن')} ({items.length}/{LIMITS.widgets})
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
  const [check, setCheck] = useState<{ ok: boolean; reason: SlugRejection | null; slug: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = useRef(0);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /**
   * A PAUSE IS A QUESTION; A KEYSTROKE IS NOT — and only the latest answer
   * counts. Every keystroke used to ask the server, and an answer for an
   * earlier spelling could land after the current one: «متاح» shown for an
   * address the field no longer held, with «تغيير» live beside it.
   */
  function verify(v: string) {
    setSlug(v);
    setCheck(null);
    setError('');
    setDone('');
    if (timer.current) clearTimeout(timer.current);
    const ticket = ++asked.current;
    const clean = v.trim().toLowerCase();
    if (!clean || clean === currentSlug) {
      setChecking(false);
      return;
    }
    setChecking(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await merchantApi.checkSlug(clean);
        if (ticket !== asked.current) return;
        setCheck({ ok: r.ok, reason: r.reason, slug: r.slug });
      } catch {
        /* typing continues; the button stays off until an answer arrives */
      } finally {
        if (ticket === asked.current) setChecking(false);
      }
    }, 400);
  }

  async function apply() {
    if (!check?.ok) return;
    const target = check.slug;
    const ok = await confirm({
      title: loc('تغيير عنوان المتجر؟', 'Change the store address?', 'ناونیشان بگۆڕدرێت؟'),
      // OWNER: Sorani to be written by hand.
      consequence: loc(
        `يصبح متجرك على ${target}. الروابط والرموز المطبوعة على العنوان القديم تنقل زبائنك إلى الجديد لمدة 180 يومًا، ثم يتحرّر العنوان القديم. يمكنك تغيير العنوان 3 مرات في اليوم.`,
        `Your store moves to ${target}. Printed links and QR codes on the old address take customers to the new one for 180 days; then the old address frees up. You can change the address 3 times a day.`
      ),
      confirmLabel: loc('تغيير', 'Change', 'گۆڕین'),
      cancelLabel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await merchantApi.changeSlug(target);
      // OWNER: Sorani to be written by hand.
      setDone(loc(`تغيّر العنوان إلى ${target}. رمز QR والرابط أدناه صارا على العنوان الجديد.`, `The address is now ${target}. The QR code and link below point to it.`));
      setCheck(null);
      onChanged();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'SLUG_UNAVAILABLE') {
        const reason = ((e as ApiError).details?.reason as SlugRejection | undefined) ?? 'taken';
        setCheck({ ok: false, reason, slug: target });
      } else if (code === 'RATE_LIMITED') {
        // OWNER: Sorani to be written by hand.
        setError(loc('غيّرت العنوان 3 مرات اليوم — جرّب غدًا.', 'You have changed the address 3 times today — try again tomorrow.'));
      } else {
        // OWNER: Sorani to be written by hand.
        setError(merchantRefusal(e, lang, loc('تعذّر تغيير العنوان', 'Could not change the address')));
      }
    } finally {
      setBusy(false);
    }
  }

  const changed = slug.trim().toLowerCase() !== currentSlug;
  const ready = changed && !checking && !!check?.ok && !busy;

  return (
    <Card title={loc('عنوان المتجر', 'Store address', 'ناونیشانی فرۆشگا')}>
      <p className="text-text-muted text-[11.5px] mb-2 flex items-center gap-1.5" dir="ltr">
        <Globe aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{url.replace(/^https?:\/\//, '')}</span>
      </p>
      <div className="flex gap-2">
        {/* OWNER: Sorani to be written by hand. */}
        <Input value={slug} onChange={verify} ltr placeholder="my-store" ariaLabel={loc('العنوان الجديد', 'New address')} maxLength={32} />
        <Btn onClick={apply} disabled={!ready} data-slug-apply>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : loc('تغيير', 'Change', 'گۆڕین')}
        </Btn>
      </div>
      <div aria-live="polite" className="min-h-[1.25rem]">
        {/* OWNER: Sorani to be written by hand. */}
        {checking && <p className="text-text-muted text-[11.5px] mt-1.5">{loc('نتحقق من العنوان…', 'Checking the address…')}</p>}
        {!checking && check && !check.ok && (
          <p className="text-amber-400 text-[11.5px] mt-1.5 flex items-center gap-1" data-slug-refused>
            <AlertTriangle aria-hidden="true" className="w-3 h-3 shrink-0" />
            {slugMessage(check.reason, loc)}
          </p>
        )}
        {!checking && check?.ok && changed && (
          <p className="text-emerald-400 text-[11.5px] mt-1.5" data-slug-available>
            {/* OWNER: Sorani to be written by hand. */}
            {loc(`${check.slug} متاح`, `${check.slug} is available`)}
          </p>
        )}
        {error && <p className="text-red-400 text-[11.5px] mt-1.5" role="alert">{error}</p>}
        {done && <p className="text-emerald-400 text-[11.5px] mt-1.5" data-slug-changed>{done}</p>}
      </div>
      {confirmDialog}
    </Card>
  );
}

// ------------------------------------------------------ «ملف الورشة» (Phase 5d)

/**
 * «ملف الورشة» (docs/COMMUNITY_ECOSYSTEM.md §9.5): the workshop's own words
 * and figure beside the store's — `workshop_intro` (≤ 300 characters, shown on
 * the store page) and `turnaround_days` (1–60, or unstated: a ranking signal,
 * never a filter), written through PUT /api/merchant/request-prefs. The
 * technologies and the largest build are the SERVER's, derived from the
 * active printers on every printer, stock and prefs write; they are shown
 * read-only, with the doors to where they do change.
 *
 * THAT PUT KEEPS WHAT IT IS NOT TOLD (worker/routes/merchantPrinters.ts,
 * review 2026-09-30): a key the body does not name keeps its stored value,
 * for every column. So `workshopPayload` sends the two fields this section
 * owns and NOTHING else — sending the filters back «as read» rewrote the
 * whole row from a read that could be stale (the printers screen saving in
 * another tab), and could lift the owner's pause — and never the derived
 * pair, which the server recomputes and no client may set.
 */
export const WORKSHOP_INTRO_MAX = 300;
export const TURNAROUND_MIN = 1;
export const TURNAROUND_MAX = 60;

export interface WorkshopForm {
  intro: string;
  turnaround: number | null;
}

/** The PUT body: the two workshop fields as edited — and only them (the server keeps every key it is not sent). */
export function workshopPayload(_prefs: RequestPrefsV2, form: WorkshopForm) {
  return {
    turnaround_days: form.turnaround,
    // The server keeps it whitespace-collapsed; the form compares what will be kept.
    workshop_intro: form.intro.replace(/\s+/g, ' ').trim(),
  };
}

/** «FDM · ريزن» — the printers' technologies, in the reader's words. */
export function technologyLine(list: readonly string[], s: WorkshopStrings): string {
  return list.map((t) => (t === 'fdm' ? 'FDM' : t === 'resin' ? s.resin : t)).join(' · ');
}

/**
 * «256 × 256 × 300 مم», or '' while no printer states all three sides. The
 * figure is a left-to-right island (LRI … PDI) inside the sentence: in Arabic
 * «x × y × z» would otherwise run backwards, and the unit stays the
 * sentence's own.
 */
export function buildLine(b: RequestPrefsV2['max_build_mm'] | null | undefined, s: WorkshopStrings): string {
  const x = Math.round(Number(b?.x) || 0);
  const y = Math.round(Number(b?.y) || 0);
  const z = Math.round(Number(b?.z) || 0);
  return x > 0 && y > 0 && z > 0 ? fillWorkshop(s.buildValue, { size: `\u2066${x} × ${y} × ${z}\u2069` }) : '';
}

/** The three doors to where the derived facts change: the printers, the stock, the request preferences. */
export function workshopDoors(): Array<{ id: 'printers' | 'stock' | 'prefs'; to: string }> {
  return [
    { id: 'printers', to: merchantHref.printers() },
    { id: 'stock', to: `${merchantHref.printers()}#stock` },
    { id: 'prefs', to: `${merchantHref.printers()}#preferences` },
  ];
}

export function WorkshopProfileForm({
  prefs,
  hrefFor = (path) => path,
  saved = false,
  onSaved,
}: {
  prefs: RequestPrefsV2;
  /** A workspace path as this host serves it (`/admin/…` on the store's own subdomain). */
  hrefFor?: (path: string) => string;
  /** The last save landed (the parent re-read the prefs and remounted this form). */
  saved?: boolean;
  onSaved?: () => void;
}) {
  const { lang } = useLanguage();
  const s = useWorkshopStrings();
  const base: WorkshopForm = { intro: prefs.workshop_intro ?? '', turnaround: prefs.turnaround_days ?? null };
  const [form, setForm] = useState<WorkshopForm>(base);
  const [turnaroundOk, setTurnaroundOk] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: 'intro' | 'turnaround' | null; text: string } | null>(null);
  const dirty = form.intro.replace(/\s+/g, ' ').trim() !== base.intro || form.turnaround !== base.turnaround;
  const tech = technologyLine(prefs.technologies ?? [], s);
  const build = buildLine(prefs.max_build_mm, s);
  const doorWord = { printers: s.doorPrinters, stock: s.doorStock, prefs: s.doorPrefs };

  const save = async () => {
    if (!dirty || !turnaroundOk || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await offersV2Api.saveRequestPrefs(workshopPayload(prefs, form));
      onSaved?.();
    } catch (e) {
      const code = e instanceof ApiError ? e.code ?? '' : '';
      setProblem({
        field: code === 'PREFS_TURNAROUND_INVALID' ? 'turnaround' : code === 'PREFS_INTRO_TOO_LONG' ? 'intro' : null,
        text: refusalText(code, workshopLang(lang), s.failed),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-workshop-profile>
      <div>
        <Field label={s.intro} hint={s.introHint} optional error={problem?.field === 'intro' ? problem.text : undefined}>
          <Textarea
            rows={3}
            maxLength={WORKSHOP_INTRO_MAX}
            value={form.intro}
            onChange={(e) => setForm((f) => ({ ...f, intro: e.target.value }))}
            placeholder={s.introPlaceholder}
            dir="auto"
            data-workshop-intro
          />
        </Field>
        <p className="mt-1 text-end text-[11px] tabular-nums text-text-muted" data-workshop-intro-count>
          {fillWorkshop(s.count, { n: form.intro.length, max: WORKSHOP_INTRO_MAX })}
        </p>
      </div>

      <Field label={s.turnaround} hint={s.turnaroundHint} optional error={problem?.field === 'turnaround' ? problem.text : undefined}>
        <NumberInput
          kind="number"
          decimals={0}
          min={TURNAROUND_MIN}
          max={TURNAROUND_MAX}
          unit={s.days}
          value={form.turnaround}
          onValueChange={(v, ok) => {
            setTurnaroundOk(ok);
            setForm((f) => ({ ...f, turnaround: ok ? v : f.turnaround }));
          }}
          data-workshop-turnaround
        />
      </Field>

      {/* WHAT THE PRINTERS SAY — read-only: no field, no control, only the doors. */}
      <div className="rounded-lg border border-border-subtle bg-surface-raised p-3" data-workshop-derived>
        <p className="text-[13px] font-semibold text-text-primary">{s.fromPrinters}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">{s.fromPrintersHint}</p>
        <dl className="mt-2 space-y-1.5 text-[12.5px]">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-muted">{s.technologies}</dt>
            <dd className="font-semibold text-text-primary" data-workshop-technologies>
              {tech || s.noPrinters}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-muted">{s.build}</dt>
            <dd className="font-semibold tabular-nums text-text-primary" data-workshop-build>
              {build || '—'}
            </dd>
          </div>
        </dl>
        {/* The row, not each link, pulls back by the links' own padding — per link, each
            one overlapped the one before it (review 2026-09-30). */}
        <div className="-ms-2 mt-2 flex flex-wrap gap-x-1 gap-y-0.5">
          {workshopDoors().map((d) => (
            <Link
              key={d.id}
              to={hrefFor(d.to)}
              data-workshop-door={d.id}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {doorWord[d.id]}
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 rtl:-scale-x-100" />
            </Link>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={saving} loadingLabel={s.saving} disabled={!dirty || !turnaroundOk} onClick={save} data-workshop-save>
          {s.save}
        </Button>
        <p aria-live="polite" className="text-[12px]">
          {problem && !problem.field ? (
            <span role="alert" className="text-danger">
              {problem.text}
            </span>
          ) : dirty ? (
            <span className="text-warning">{s.unsaved}</span>
          ) : saved ? (
            <span className="inline-flex items-center gap-1 text-success" data-workshop-saved>
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
              {s.saved}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/** Reads the prefs, draws the form, and reads them again after a save — the form then shows what was kept. */
export function WorkshopProfileCard() {
  const s = useWorkshopStrings();
  const ws = useContext(WorkspaceContext);
  const [prefs, setPrefs] = useState<RequestPrefsV2 | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(() => {
    setFailed(null);
    return offersV2Api
      .requestPrefs()
      .then((d) => setPrefs(d.prefs))
      .catch((e: unknown) => setFailed(e));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SurfaceCard id="workshop-profile" title={s.title} description={s.description}>
      {prefs ? (
        <WorkshopProfileForm
          key={`${prefs.workshop_intro}|${prefs.turnaround_days ?? ''}`}
          prefs={prefs}
          hrefFor={ws ? ws.href : undefined}
          saved={saved}
          onSaved={() => {
            setSaved(true);
            void load();
          }}
        />
      ) : failed ? (
        <ErrorState compact error={failed} onRetry={() => void load()} />
      ) : (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-11 w-1/2 rounded-xl" />
        </div>
      )}
    </SurfaceCard>
  );
}
