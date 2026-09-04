/**
 * PRINTERS, AND WHICH JOBS THIS SHOP WANTS TO HEAR ABOUT.
 *
 * Two screens in one tab because they answer the same question from opposite
 * sides. PRINTERS are FACTS — technology, build volume, materials, nozzle,
 * enclosure — and they decide ELIGIBILITY: no machine can be talked into a job
 * it cannot physically do. PREFERENCES are WISHES — of the jobs this shop
 * COULD take, which ones it wants to be told about. A wish only ever NARROWS a
 * fact; it can never widen one, which is why an empty filter group means
 * "everything my printers can do" rather than "nothing".
 *
 * Hence the third panel. «لماذا لم يصلني طلب؟» is the question a merchant asks
 * the day they lose a job, and the matcher already records a machine-readable
 * reason for every decision it makes — so this screen reads it back instead of
 * leaving them to suspect the platform is ignoring them.
 *
 * The master on/off switch is deliberately NOT here: it is
 * `request_opportunities` in the notifications tab. Two switches with one
 * meaning is one disagreement away from nobody knowing which one is real.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Loader2, Palette, Pencil, Plus, Trash2 } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api, ApiError } from '../../../lib/api';
import { iqd } from '../../../lib/merchant';
import { GOVERNORATES } from '../../../lib/governorates';
import { Btn, Card, Chip, Empty, Input, Notice, Spinner, Toggle, type Loc } from './ui';

// ------------------------------------------------------------- the vocabulary

type Technology = 'fdm' | 'resin';
type Quality = 'draft' | 'standard' | 'fine' | 'ultra';
type Availability = 'available' | 'busy' | 'offline';
type Workload = 'light' | 'normal' | 'busy' | 'full';

interface MaterialOption {
  id: string;
  process: string;
  name_en: string;
  name_ar: string;
  needs_enclosure?: boolean;
  abrasive?: boolean;
}

interface Printer {
  id: string;
  name: string;
  technology: Technology;
  brand: string;
  model: string;
  build_x_mm: number;
  build_y_mm: number;
  build_z_mm: number;
  nozzle_mm: number;
  materials: string[];
  colors: string[];
  multicolor: boolean;
  enclosed: boolean;
  hardened_nozzle: boolean;
  quality_max: Quality;
  machine_hour_iqd: number | null;
  availability: Availability;
  active: boolean;
  sort_order: number;
}

/** The endpoint echoes the vocabulary it validates against, so typing these as
 *  the unions is a statement of fact rather than a cast. */
interface PrintersResponse {
  printers: Printer[];
  materials: MaterialOption[];
  technologies: Technology[];
  qualities: Quality[];
}

interface PrefsResponse {
  prefs: {
    processes: string[];
    materials: string[];
    colors: string[];
    capabilities: string[];
    governorates: string[];
    delivery: string[];
    min_job_iqd: number;
    max_job_iqd: number | null;
    min_size_mm: number;
    max_size_mm: number | null;
    workload: Workload;
    paused: boolean;
    paused_until: string | null;
  };
  vocabulary: {
    processes: Technology[];
    capabilities: string[];
    delivery: string[];
    workloads: Workload[];
    materials: MaterialOption[];
  };
}

interface MatchRow {
  request_id: string;
  title: string;
  state: string;
  eligible: boolean;
  reject_reason: string;
  notified: boolean;
  created_at: string;
}

/**
 * The customer's palette, mirrored.
 *
 * The matcher compares a job's `color_hex` to this shop's list as exact
 * strings, so a merchant picking from a different set of swatches than the
 * wizard offers would filter themselves out of every request without ever
 * seeing why. These eight are the wizard's eight (PrintRequestWizard).
 */
const SWATCHES: Array<{ hex: string; ar: string; en: string }> = [
  { hex: '#1a1a1a', ar: 'أسود', en: 'Black' },
  { hex: '#f2f2f2', ar: 'أبيض', en: 'White' },
  { hex: '#808080', ar: 'رمادي', en: 'Grey' },
  { hex: '#d32f2f', ar: 'أحمر', en: 'Red' },
  { hex: '#1976d2', ar: 'أزرق', en: 'Blue' },
  { hex: '#388e3c', ar: 'أخضر', en: 'Green' },
  { hex: '#fbc02d', ar: 'أصفر', en: 'Yellow' },
  { hex: '#f57c00', ar: 'برتقالي', en: 'Orange' },
];

const AVAILABILITIES: Availability[] = ['available', 'busy', 'offline'];

function techLabel(t: string, loc: Loc): string {
  return t === 'resin' ? loc('راتنج', 'Resin', 'ڕەزین') : loc('FDM — فتيل', 'FDM — filament', 'FDM');
}

function qualityLabel(q: string, loc: Loc): string {
  switch (q) {
    case 'draft': return loc('مسوّدة', 'Draft', 'خێرا');
    case 'standard': return loc('قياسي', 'Standard', 'ئاسایی');
    case 'fine': return loc('دقيق', 'Fine', 'ورد');
    case 'ultra': return loc('فائق الدقة', 'Ultra', 'زۆر ورد');
    default: return q;
  }
}

function availabilityLabel(a: string, loc: Loc): string {
  switch (a) {
    case 'available': return loc('متاحة', 'Available', 'بەردەست');
    case 'busy': return loc('مشغولة', 'Busy', 'سەرقاڵ');
    case 'offline': return loc('متوقفة', 'Offline', 'ڕاگیراو');
    default: return a;
  }
}

function workloadLabel(w: string, loc: Loc): string {
  switch (w) {
    case 'light': return loc('خفيف', 'Light', 'سووک');
    case 'normal': return loc('عادي', 'Normal', 'ئاسایی');
    case 'busy': return loc('مشغول', 'Busy', 'سەرقاڵ');
    case 'full': return loc('ممتلئ', 'Full', 'پڕ');
    default: return w;
  }
}

function deliveryLabel(d: string, loc: Loc): string {
  return d === 'pickup'
    ? loc('استلام من المتجر', 'Pickup', 'وەرگرتن لە فرۆشگا')
    : loc('توصيل', 'Delivery', 'گەیاندن');
}

function capabilityLabel(c: string, loc: Loc): string {
  switch (c) {
    case 'multicolor': return loc('متعدد الألوان', 'Multicolour', 'فرەڕەنگ');
    case 'large_format': return loc('مقاسات كبيرة', 'Large format', 'قەبارە گەورە');
    case 'high_detail': return loc('تفاصيل دقيقة', 'High detail', 'وردەکاری');
    case 'functional': return loc('قطع وظيفية', 'Functional parts', 'پارچەی کارا');
    case 'flexible': return loc('خامات مرنة', 'Flexible materials', 'کەرەستەی نەرم');
    case 'cf': return loc('مقوّاة بالكربون', 'Carbon-filled', 'کاربۆن');
    default: return c;
  }
}

/**
 * One friendly sentence per rejection code.
 *
 * Every one of these names a thing the merchant can act on — a toggle, a
 * filter, a missing machine — because a diagnostic that says "NOT_ELIGIBLE"
 * and stops is the reason merchants stop believing the matcher.
 */
function reasonText(code: string, loc: Loc): string {
  switch (code) {
    case 'MERCHANT_INACTIVE':
      return loc(
        'حساب التاجر لم يكن مفعّلًا وقت وصول الطلب.',
        'Your merchant account was not active when the request arrived.'
      );
    case 'STORE_UNAVAILABLE':
      return loc(
        'متجرك كان متوقفًا وقت وصول الطلب — افتحه من «إعداد المتجر».',
        'Your store was paused when the request arrived — reopen it in Store setup.'
      );
    case 'NOT_TAKING_REQUESTS':
      return loc(
        'متجرك لا يستقبل الطلبات المخصصة. فعّل الخيار من «إعداد المتجر».',
        'Your store is not accepting custom requests. Turn that on in Store setup.'
      );
    case 'NOTIFICATIONS_OFF':
      return loc(
        'مفتاح «فرص طلبات العملاء» كان مغلقًا في تبويب الإشعارات.',
        '“Customer request opportunities” was switched off in the Notifications tab.'
      );
    case 'PAUSED':
      return loc(
        'كنت موقفًا استقبال إشعارات الطلبات مؤقتًا في هذه الشاشة.',
        'You had paused request notifications on this screen.'
      );
    case 'NO_PRINTER':
      return loc(
        'لم تكن لديك طابعة مُضافة ومفعّلة وغير متوقفة وقت وصول الطلب.',
        'You had no printer that was added, active and not offline at the time.'
      );
    case 'PROCESS':
      return loc(
        'التقنية المطلوبة (FDM أو راتنج) لا تطابق طابعاتك أو تخالف الفلتر الذي اخترته.',
        'The requested technology (FDM or resin) matches none of your printers, or your own filter excluded it.'
      );
    case 'MATERIAL':
      return loc(
        'الخامة المطلوبة ليست ضمن خاماتك — أو تحتاج حجرة مغلقة أو فوهة مقوّاة لا تملكها طابعتك.',
        'The material is not one you listed — or it needs an enclosure or a hardened nozzle your printer does not have.'
      );
    case 'BUILD_VOLUME':
      return loc(
        'القطعة أكبر من مساحة الطباعة في كل طابعاتك، بأي اتجاه توضع به.',
        'The part is larger than every one of your build volumes, in any orientation.'
      );
    case 'QUALITY':
      return loc(
        'الطلب يحتاج دقة أعلى من أقصى دقة سجّلتها لطابعاتك.',
        'The job needs finer quality than the maximum you recorded for your printers.'
      );
    case 'CAPABILITY':
      return loc(
        'الطلب يحتاج قدرة لا تملكها أو استبعدتها — مثل الطباعة بأكثر من لون.',
        'The job needs a capability you do not have or filtered out — printing in more than one colour, for example.'
      );
    case 'COLOR':
      return loc(
        'اللون المطلوب خارج قائمة الألوان التي حدّدتها. اترك الألوان فارغة لتصلك كل الألوان.',
        'The requested colour is outside the list you picked. Leave colours empty to hear about all of them.'
      );
    case 'GOVERNORATE':
      return loc(
        'محافظة العميل خارج المحافظات التي اخترتها.',
        'The customer’s governorate is outside the ones you selected.'
      );
    case 'DELIVERY':
      return loc(
        'طريقة الاستلام التي طلبها العميل خارج ما اخترته.',
        'The customer’s delivery method is outside what you selected.'
      );
    case 'JOB_TOO_SMALL':
      return loc(
        'قيمة الطلب التقديرية أقل من الحد الأدنى الذي وضعته.',
        'The estimated job value is below the minimum you set.'
      );
    case 'JOB_TOO_LARGE':
      return loc(
        'قيمة الطلب التقديرية أعلى من الحد الأعلى الذي وضعته.',
        'The estimated job value is above the maximum you set.'
      );
    case 'SIZE_PREFERENCE':
      return loc(
        'أطول ضلع في القطعة خارج نطاق المقاسات الذي وضعته.',
        'The part’s longest edge is outside the size range you set.'
      );
    default:
      return loc('لم يُسجَّل سبب لهذا القرار.', 'No reason was recorded for this decision.');
  }
}

/**
 * A button with a `data-*` hook. The shared `Btn` forwards no DOM attributes,
 * and the three controls a probe drives this screen by need one — so those
 * three carry their own button with `Btn`'s exact shape and nothing else.
 */
function HookBtn({
  children,
  onClick,
  attrs,
  kind = 'primary',
  disabled,
  full,
  small,
}: {
  children: React.ReactNode;
  onClick: () => void;
  attrs: Record<string, string>;
  kind?: 'primary' | 'gold' | 'ghost';
  disabled?: boolean;
  full?: boolean;
  small?: boolean;
}) {
  const style =
    kind === 'primary'
      ? 'bg-olive text-white border-olive'
      : kind === 'gold'
        ? 'bg-gold/15 text-gold border-gold/30'
        : 'bg-white/[0.03] text-zinc-300 border-white/10';
  return (
    <button
      type="button"
      {...attrs}
      onClick={onClick}
      disabled={disabled}
      className={`${full ? 'w-full' : ''} ${small ? 'h-8 px-2.5 text-[11.5px]' : 'h-9 px-3.5 text-[12.5px]'} rounded-xl border font-bold inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 active:scale-[0.98] ${style}`}
    >
      {children}
    </button>
  );
}

/** A titled group of multi-select chips, with the hint that keeps merchants
 *  from over-filtering themselves into silence. */
function Group({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      <p className="text-zinc-600 text-[10.5px] mt-1.5">{hint}</p>
    </div>
  );
}

/** Toggle one id in a list — the only edit any chip group ever performs. */
function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

// -------------------------------------------------------------------- the tab

export function PrintersTab({ canSell = true }: { canSell?: boolean }) {
  return (
    <div className="space-y-3">
      <PrintersSection />
      <RequestPrefsSection canSell={canSell} />
      <MatchesPanel />
    </div>
  );
}

// ---------------------------------------------------------------- my printers

/** Form state keeps numbers as strings so a half-typed field is not silently
 *  read as 0 — the build volume in particular must be typed, not defaulted. */
interface Draft {
  id: string;
  name: string;
  technology: Technology;
  brand: string;
  model: string;
  x: string;
  y: string;
  z: string;
  nozzle: string;
  materials: string[];
  colors: string[];
  multicolor: boolean;
  enclosed: boolean;
  hardened_nozzle: boolean;
  quality_max: Quality;
  machine_hour_iqd: string;
  availability: Availability;
  active: boolean;
  sort_order: number;
}

const NEW_DRAFT: Draft = {
  id: '',
  name: '',
  technology: 'fdm',
  brand: '',
  model: '',
  x: '',
  y: '',
  z: '',
  nozzle: '0.4',
  materials: [],
  colors: [],
  multicolor: false,
  enclosed: false,
  hardened_nozzle: false,
  quality_max: 'fine',
  machine_hour_iqd: '',
  availability: 'available',
  active: true,
  sort_order: 0,
};

function toDraft(p: Printer): Draft {
  return {
    id: p.id,
    name: p.name,
    technology: p.technology,
    brand: p.brand,
    model: p.model,
    x: String(p.build_x_mm || ''),
    y: String(p.build_y_mm || ''),
    z: String(p.build_z_mm || ''),
    nozzle: String(p.nozzle_mm || 0.4),
    materials: p.materials,
    colors: p.colors,
    multicolor: p.multicolor,
    enclosed: p.enclosed,
    hardened_nozzle: p.hardened_nozzle,
    quality_max: p.quality_max,
    machine_hour_iqd: p.machine_hour_iqd === null ? '' : String(p.machine_hour_iqd),
    availability: p.availability,
    active: p.active,
    sort_order: p.sort_order,
  };
}

function PrintersSection() {
  const { loc } = useLanguage();
  const [data, setData] = useState<PrintersResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .get<PrintersResponse>('/api/merchant/printers')
      .then(setData)
      .catch(() =>
        setData({ printers: [], materials: [], technologies: ['fdm', 'resin'], qualities: ['draft', 'standard', 'fine', 'ultra'] })
      );
  }, []);
  useEffect(load, [load]);

  async function remove(id: string) {
    if (
      !confirm(
        loc(
          'حذف هذه الطابعة؟ لن تُطابَق بها أي طلبات بعد الآن.',
          'Delete this printer? No request will be matched to it any more.',
          'ئەم چاپکەرە بسڕدرێتەوە؟'
        )
      )
    ) {
      return;
    }
    setBusy(id);
    setError('');
    try {
      await api.delete(`/api/merchant/printers/${id}`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر الحذف', 'Could not delete', 'نەسڕایەوە'));
    } finally {
      setBusy('');
    }
  }

  async function save(d: Draft) {
    setBusy('save');
    setError('');
    const body = {
      name: d.name.trim(),
      technology: d.technology,
      brand: d.brand.trim(),
      model: d.model.trim(),
      build_x_mm: Number(d.x) || 0,
      build_y_mm: Number(d.y) || 0,
      build_z_mm: Number(d.z) || 0,
      nozzle_mm: Number(d.nozzle) || 0.4,
      materials: d.materials,
      colors: d.colors,
      multicolor: d.multicolor,
      enclosed: d.enclosed,
      hardened_nozzle: d.hardened_nozzle,
      quality_max: d.quality_max,
      machine_hour_iqd: d.machine_hour_iqd === '' ? null : Number(d.machine_hour_iqd) || 0,
      availability: d.availability,
      active: d.active,
      sort_order: d.sort_order,
    };
    try {
      if (d.id) await api.put(`/api/merchant/printers/${d.id}`, body);
      else await api.post('/api/merchant/printers', body);
      setDraft(null);
      load();
    } catch (e) {
      // The one refusal worth translating rather than echoing: it names a
      // field the merchant is looking at, and the reason is not obvious.
      if (e instanceof ApiError && e.code === 'BUILD_VOLUME_REQUIRED') {
        setError(
          loc(
            'أدخل مساحة الطباعة (الطول والعرض والارتفاع) — بدونها لا تستطيع المطابقة معرفة ما إذا كانت القطعة تدخل في طابعتك.',
            'Enter the build volume (X, Y and Z) — without it matching cannot tell whether a part fits your machine.'
          )
        );
      } else {
        setError(e instanceof ApiError ? e.message : loc('تعذّر الحفظ', 'Could not save', 'پاشەکەوت نەکرا'));
      }
    } finally {
      setBusy('');
    }
  }

  return (
    <Card
      title={loc('طابعاتي', 'My printers', 'چاپکەرەکانم')}
      action={
        data && !draft ? (
          <HookBtn
            attrs={{ 'data-printers': 'add' }}
            kind="gold"
            small
            onClick={() => {
              setError('');
              setDraft({ ...NEW_DRAFT, sort_order: data.printers.length });
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            {loc('أضف طابعة', 'Add printer', 'زیادکردن')}
          </HookBtn>
        ) : undefined
      }
    >
      {data === null ? (
        <Spinner />
      ) : draft ? (
        <PrinterForm
          value={draft}
          onChange={setDraft}
          materials={data.materials}
          technologies={data.technologies}
          qualities={data.qualities}
          saving={busy === 'save'}
          error={error}
          onSave={() => save(draft)}
          onCancel={() => {
            setDraft(null);
            setError('');
          }}
        />
      ) : !data.printers.length ? (
        <Empty
          text={loc('لم تُضِف أي طابعة بعد', 'No printers added yet', 'هێشتا چاپکەر زیاد نەکراوە')}
          hint={loc(
            'بدون طابعة واحدة على الأقل لن يُطابَق متجرك مع أي طلب طباعة — المطابقة تقرأ مقاسات طابعاتك وخاماتها الحقيقية، لا وصفًا نصيًا.',
            'Without at least one printer your shop is never matched to a print request — matching reads your machines’ real dimensions and materials, not a description.',
            'بەبێ چاپکەر هیچ داواکارییەک ناگاتە فرۆشگاکەت.'
          )}
        />
      ) : (
        <div data-printers="list" className="space-y-2">
          {data.printers.map((p) => (
            <PrinterRow
              key={p.id}
              printer={p}
              materials={data.materials}
              busy={busy === p.id}
              onEdit={() => {
                setError('');
                setDraft(toDraft(p));
              }}
              onDelete={() => remove(p.id)}
            />
          ))}
        </div>
      )}

      {error && !draft && <p className="text-red-400 text-[11.5px] mt-2">{error}</p>}
    </Card>
  );
}

const AVAILABILITY_STYLE: Record<string, string> = {
  available: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  busy: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  offline: 'bg-white/[0.05] text-zinc-500 border-white/10',
};

function PrinterRow({
  printer: p,
  materials,
  busy,
  onEdit,
  onDelete,
}: {
  printer: Printer;
  materials: MaterialOption[];
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { loc } = useLanguage();
  const name = (id: string) => {
    const m = materials.find((x) => x.id === id);
    return m ? loc(m.name_ar, m.name_en) : id;
  };

  return (
    <div data-printer={p.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0">
          <p className="text-white text-[13px] font-semibold truncate">{p.name}</p>
          <p className="text-zinc-500 text-[11px] truncate">
            {techLabel(p.technology, loc)}
            {(p.brand || p.model) && ` · ${[p.brand, p.model].filter(Boolean).join(' ')}`}
            {` · ${qualityLabel(p.quality_max, loc)}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${AVAILABILITY_STYLE[p.availability] ?? AVAILABILITY_STYLE.offline}`}
          >
            {availabilityLabel(p.availability, loc)}
          </span>
          <button
            onClick={onEdit}
            className="w-8 h-8 rounded-lg border border-white/10 text-zinc-400 flex items-center justify-center"
            aria-label={loc('تعديل', 'Edit', 'دەستکاری')}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="w-8 h-8 rounded-lg border border-red-500/30 text-red-300 disabled:opacity-40 flex items-center justify-center"
            aria-label={loc('حذف', 'Delete', 'سڕینەوە')}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <p className="text-zinc-400 text-[11.5px]">
        {loc('مساحة الطباعة', 'Build volume', 'قەبارەی چاپ')}:{' '}
        <span className="text-white font-semibold" dir="ltr">
          {p.build_x_mm} × {p.build_y_mm} × {p.build_z_mm}
        </span>{' '}
        {loc('مم', 'mm', 'مم')}
        {' · '}
        {loc('الفوهة', 'Nozzle', 'لوولە')}{' '}
        <span dir="ltr">{p.nozzle_mm}</span> {loc('مم', 'mm', 'مم')}
        {p.machine_hour_iqd !== null && (
          <>
            {' · '}
            <span className="text-gold" dir="ltr">{iqd(p.machine_hour_iqd)}</span>
            {loc('/ساعة', '/hour', '/کاتژمێر')}
          </>
        )}
      </p>

      {p.materials.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {p.materials.map((id) => (
            <span
              key={id}
              className="h-6 px-2 inline-flex items-center rounded-lg bg-white/[0.05] border border-white/10 text-zinc-300 text-[11px]"
            >
              {name(id)}
            </span>
          ))}
        </div>
      )}

      {(p.colors.length > 0 || p.multicolor || p.enclosed || p.hardened_nozzle || !p.active) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {p.colors.map((hex) => (
            <span
              key={hex}
              title={hex}
              className="w-5 h-5 rounded-full border border-white/15"
              style={{ backgroundColor: hex }}
            />
          ))}
          {p.multicolor && <Tagline text={loc('متعدد الألوان', 'Multicolour', 'فرەڕەنگ')} />}
          {p.enclosed && <Tagline text={loc('حجرة مغلقة', 'Enclosed', 'داخراو')} />}
          {p.hardened_nozzle && <Tagline text={loc('فوهة مقوّاة', 'Hardened nozzle', 'لوولەی بەهێز')} />}
          {!p.active && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-500/10 text-amber-400 border-amber-500/20">
              {loc('غير مفعّلة', 'Inactive', 'ناچالاک')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Tagline({ text }: { text: string }) {
  return (
    <span className="text-[10px] text-zinc-500 px-2 py-0.5 rounded-full border border-white/10">{text}</span>
  );
}

// --------------------------------------------------------------- printer form

function PrinterForm({
  value: d,
  onChange,
  materials,
  technologies,
  qualities,
  saving,
  error,
  onSave,
  onCancel,
}: {
  value: Draft;
  onChange: (d: Draft) => void;
  materials: MaterialOption[];
  technologies: Technology[];
  qualities: Quality[];
  saving: boolean;
  error: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { loc } = useLanguage();
  const forProcess = materials.filter((m) => m.process === d.technology);

  // Materials this machine is claimed to run but the matcher will always
  // refuse, because the hardware toggles below say otherwise. Naming them here
  // beats a request that silently never arrives.
  const blocked = d.materials
    .map((id) => materials.find((m) => m.id === id))
    .filter(
      (m): m is MaterialOption =>
        !!m && ((!!m.needs_enclosure && !d.enclosed) || (!!m.abrasive && !d.hardened_nozzle))
    );

  return (
    <div data-printer-form className="space-y-3.5">
      <Input
        label={loc('اسم الطابعة', 'Printer name', 'ناوی چاپکەر')}
        value={d.name}
        onChange={(name) => onChange({ ...d, name })}
        placeholder={loc('مثال: Bambu Lab P1S', 'e.g. Bambu Lab P1S', 'Bambu Lab P1S')}
      />

      <div>
        <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
          {loc('التقنية', 'Technology', 'تەکنەلۆژیا')}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {technologies.map((t) => (
            <Chip
              key={t}
              label={techLabel(t, loc)}
              active={d.technology === t}
              onClick={() =>
                // Materials belong to a process. Keeping a PETG id on a resin
                // machine would look selected and match nothing, so they go.
                onChange({
                  ...d,
                  technology: t,
                  materials: d.materials.filter((id) => materials.find((m) => m.id === id)?.process === t),
                })
              }
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Input
          label={loc('الماركة', 'Brand', 'براند')}
          value={d.brand}
          onChange={(brand) => onChange({ ...d, brand })}
          ltr
        />
        <Input
          label={loc('الموديل', 'Model', 'مۆدێل')}
          value={d.model}
          onChange={(model) => onChange({ ...d, model })}
          ltr
        />
      </div>

      <div>
        <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
          {loc('مساحة الطباعة (مم)', 'Build volume (mm)', 'قەبارەی چاپ (مم)')}
        </label>
        <div className="grid grid-cols-3 gap-2">
          <Input value={d.x} onChange={(x) => onChange({ ...d, x })} type="number" placeholder="X" ltr />
          <Input value={d.y} onChange={(y) => onChange({ ...d, y })} type="number" placeholder="Y" ltr />
          <Input value={d.z} onChange={(z) => onChange({ ...d, z })} type="number" placeholder="Z" ltr />
        </div>
        <p className="text-zinc-600 text-[10.5px] mt-1">
          {loc(
            'مطلوب. المطابقة تُجرّب قلب القطعة على كل الاتجاهات لترى إن كانت تدخل — بدون هذه الأرقام لا تستطيع أن تقرّر شيئًا، ولهذا يرفض الخادم حفظ طابعة بلا مساحة طباعة.',
            'Required. Matching tries every orientation to see whether a part fits — without these numbers it cannot decide anything, which is why the server refuses to save a printer with no build volume.',
            'پێویستە — بەبێ ئەم ژمارانە مامەڵەکردن ناکرێت.'
          )}
        </p>
      </div>

      <Input
        label={loc('قطر الفوهة (مم)', 'Nozzle diameter (mm)', 'تیرەی لوولە (مم)')}
        value={d.nozzle}
        onChange={(nozzle) => onChange({ ...d, nozzle })}
        type="number"
        ltr
      />

      <Group
        label={loc('الخامات المتوفرة لديك', 'Materials you stock', 'کەرەستەکانت')}
        hint={loc(
          'اتركها فارغة إن كنت تطبع بكل خامات هذه التقنية — الفارغ يعني «كل شيء»، لا «لا شيء».',
          'Leave it empty if you print every material this technology supports — empty means “everything”, not “nothing”.',
          'بەتاڵ = هەموو کەرەستەکان.'
        )}
      >
        {forProcess.length === 0 ? (
          <p className="text-zinc-600 text-[11px]">
            {loc('لا توجد خامات في الكتالوج لهذه التقنية.', 'No catalogue materials for this technology.')}
          </p>
        ) : (
          forProcess.map((m) => (
            <Chip
              key={m.id}
              label={loc(m.name_ar, m.name_en)}
              active={d.materials.includes(m.id)}
              onClick={() => onChange({ ...d, materials: toggleIn(d.materials, m.id) })}
            />
          ))
        )}
      </Group>

      {blocked.length > 0 && (
        <Notice
          text={loc(
            `اخترت ${blocked.map((m) => m.name_en).join('، ')} — هذه الخامات تحتاج حجرة مغلقة أو فوهة مقوّاة، وبدون تفعيلها أدناه لن تصلك طلباتها.`,
            `You picked ${blocked.map((m) => m.name_en).join(', ')} — these need an enclosure or a hardened nozzle, and without the switches below their requests will never reach you.`
          )}
        />
      )}

      <div>
        <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
          {loc('الألوان المتوفرة', 'Colours you stock', 'ڕەنگە بەردەستەکان')}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {SWATCHES.map((c) => (
            <button
              key={c.hex}
              type="button"
              onClick={() => onChange({ ...d, colors: toggleIn(d.colors, c.hex) })}
              title={loc(c.ar, c.en)}
              aria-label={loc(c.ar, c.en)}
              aria-pressed={d.colors.includes(c.hex)}
              className={`w-9 h-9 rounded-full border-2 transition-transform ${
                d.colors.includes(c.hex) ? 'border-gold scale-110' : 'border-white/15'
              }`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
          {/* A native colour well, because a hex field is a keyboard task and
              this is a phone. */}
          <label className="w-9 h-9 rounded-full border-2 border-dashed border-white/25 flex items-center justify-center cursor-pointer relative overflow-hidden">
            <Palette className="w-4 h-4 text-zinc-400" />
            <input
              type="color"
              value="#808080"
              onChange={(e) => onChange({ ...d, colors: toggleIn(d.colors, e.target.value.toLowerCase()) })}
              aria-label={loc('لون مخصص', 'Custom colour', 'ڕەنگی تایبەت')}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
        </div>
        {d.colors.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {d.colors.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => onChange({ ...d, colors: d.colors.filter((x) => x !== hex) })}
                className="inline-flex items-center gap-1.5 h-7 ps-2 pe-2 rounded-lg bg-white/[0.05] border border-white/10 text-zinc-300 text-[11px]"
              >
                <span className="w-3 h-3 rounded-full border border-white/20" style={{ backgroundColor: hex }} />
                <span dir="ltr">{hex}</span>
                <span className="text-zinc-500">×</span>
              </button>
            ))}
          </div>
        )}
        <p className="text-zinc-600 text-[10.5px] mt-1.5">
          {loc(
            'اتركها فارغة لتصلك الطلبات بكل الألوان — اللون شيء يُشترى، لا حدّ للطابعة.',
            'Leave empty to hear about every colour — a colour is something you buy, not a limit of the machine.',
            'بەتاڵ = هەموو ڕەنگەکان.'
          )}
        </p>
      </div>

      <div className="space-y-2.5">
        <Toggle
          label={loc('طباعة متعددة الألوان', 'Multicolour printing', 'چاپی فرەڕەنگ')}
          on={d.multicolor}
          onChange={(multicolor) => onChange({ ...d, multicolor })}
          hint={loc(
            'يفتح الطلبات التي تحتاج أكثر من لون داخل القطعة الواحدة.',
            'Unlocks jobs that need more than one colour inside a single part.',
            'داواکاری فرەڕەنگ دەکاتەوە.'
          )}
        />
        <Toggle
          label={loc('حجرة مغلقة', 'Enclosed chamber', 'ژووری داخراو')}
          on={d.enclosed}
          onChange={(enclosed) => onChange({ ...d, enclosed })}
          hint={loc(
            'يفتح ABS و ASA و PC و PA — بدونها تُستبعد هذه الخامات من طابعتك.',
            'Unlocks ABS, ASA, PC and PA — without it those materials are refused for this printer.',
            'ABS و ASA و PC و PA دەکاتەوە.'
          )}
        />
        <Toggle
          label={loc('فوهة مقوّاة', 'Hardened nozzle', 'لوولەی بەهێزکراو')}
          on={d.hardened_nozzle}
          onChange={(hardened_nozzle) => onChange({ ...d, hardened_nozzle })}
          hint={loc(
            'يفتح الخامات الكاشطة والمقوّاة بالكربون (CF).',
            'Unlocks abrasive and carbon-filled (CF) materials.',
            'کەرەستەی کاربۆن دەکاتەوە.'
          )}
        />
      </div>

      <div>
        <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
          {loc('أعلى دقة تستطيعها', 'Best quality you can do', 'باشترین وردی')}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {qualities.map((q) => (
            <Chip
              key={q}
              label={qualityLabel(q, loc)}
              active={d.quality_max === q}
              onClick={() => onChange({ ...d, quality_max: q })}
            />
          ))}
        </div>
      </div>

      <Input
        label={loc('سعر ساعة التشغيل (د.ع)', 'Machine hour price (IQD)', 'نرخی کاتژمێر (IQD)')}
        value={d.machine_hour_iqd}
        onChange={(machine_hour_iqd) => onChange({ ...d, machine_hour_iqd })}
        type="number"
        ltr
        hint={loc(
          'اختياري — اتركه فارغًا لاستخدام السعر الافتراضي للمنصة.',
          'Optional — leave empty to use the platform default.',
          'ئارەزوومەندانە — بەتاڵ = نرخی بنەڕەتی.'
        )}
      />

      <div>
        <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
          {loc('حالة الطابعة الآن', 'Availability right now', 'دۆخی ئێستا')}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {AVAILABILITIES.map((a) => (
            <Chip
              key={a}
              label={availabilityLabel(a, loc)}
              active={d.availability === a}
              onClick={() => onChange({ ...d, availability: a })}
            />
          ))}
        </div>
      </div>

      <Toggle
        label={loc('مفعّلة ضمن المطابقة', 'Active in matching', 'چالاک لە مامەڵەکردن')}
        on={d.active}
        onChange={(active) => onChange({ ...d, active })}
        hint={loc(
          'طابعة غير مفعّلة تُتجاهل تمامًا — استخدمها للطابعات المُعارة أو المعطّلة بدل حذفها.',
          'An inactive printer is ignored entirely — use it for a lent-out or broken machine instead of deleting it.',
          'چاپکەری ناچالاک پشتگوێ دەخرێت.'
        )}
      />

      {error && <p className="text-red-400 text-[11.5px]">{error}</p>}

      <div className="flex gap-2">
        <HookBtn
          attrs={{ 'data-printer': 'save' }}
          onClick={onSave}
          disabled={saving || d.name.trim().length < 1}
          full
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {loc('حفظ الطابعة', 'Save printer', 'پاشەکەوتکردن')}
        </HookBtn>
        <Btn kind="ghost" onClick={onCancel}>
          {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
        </Btn>
      </div>
    </div>
  );
}

// ------------------------------------------------- request notification prefs

interface PrefsForm {
  processes: string[];
  materials: string[];
  colors: string[];
  capabilities: string[];
  governorates: string[];
  delivery: string[];
  min_job_iqd: string;
  max_job_iqd: string;
  min_size_mm: string;
  max_size_mm: string;
  workload: Workload;
  paused: boolean;
  paused_until: string;
}

function RequestPrefsSection({ canSell }: { canSell: boolean }) {
  const { loc, lang } = useLanguage();
  const [vocab, setVocab] = useState<PrefsResponse['vocabulary'] | null>(null);
  const [f, setF] = useState<PrefsForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    // No `loc` in here, and so none in the dependency list: the context binds a
    // NEW `loc` on every provider render, and an effect that depends on it
    // would re-fetch preferences for the rest of the session.
    api
      .get<PrefsResponse>('/api/merchant/request-prefs')
      .then((d) => {
        setVocab(d.vocabulary);
        setF({
          processes: d.prefs.processes,
          materials: d.prefs.materials,
          colors: d.prefs.colors,
          capabilities: d.prefs.capabilities,
          governorates: d.prefs.governorates,
          delivery: d.prefs.delivery,
          min_job_iqd: d.prefs.min_job_iqd ? String(d.prefs.min_job_iqd) : '',
          max_job_iqd: d.prefs.max_job_iqd === null ? '' : String(d.prefs.max_job_iqd),
          min_size_mm: d.prefs.min_size_mm ? String(d.prefs.min_size_mm) : '',
          max_size_mm: d.prefs.max_size_mm === null ? '' : String(d.prefs.max_size_mm),
          workload: d.prefs.workload,
          paused: d.prefs.paused,
          // The server stores a full timestamp; a date input speaks days.
          paused_until: d.prefs.paused_until ? d.prefs.paused_until.slice(0, 10) : '',
        });
      })
      .catch(() => setLoadFailed(true));
  }, []);

  async function save() {
    if (!f) return;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await api.put('/api/merchant/request-prefs', {
        processes: f.processes,
        materials: f.materials,
        colors: f.colors,
        capabilities: f.capabilities,
        governorates: f.governorates,
        delivery: f.delivery,
        min_job_iqd: f.min_job_iqd === '' ? 0 : Number(f.min_job_iqd) || 0,
        max_job_iqd: f.max_job_iqd === '' ? null : Number(f.max_job_iqd) || 0,
        min_size_mm: f.min_size_mm === '' ? 0 : Number(f.min_size_mm) || 0,
        max_size_mm: f.max_size_mm === '' ? null : Number(f.max_size_mm) || 0,
        workload: f.workload,
        paused: f.paused,
        // Only meaningful while paused, and an empty string clears it server-side.
        paused_until: f.paused && f.paused_until ? f.paused_until : '',
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر الحفظ', 'Could not save', 'پاشەکەوت نەکرا'));
    } finally {
      setSaving(false);
    }
  }

  if (!f || !vocab) {
    return (
      <Card title={loc('إشعارات طلبات الطباعة', 'Print request notifications', 'ئاگادارکردنەوەی داواکاری')}>
        {loadFailed ? (
          <Notice
            text={loc(
              'تعذّر تحميل تفضيلاتك. حدّث الصفحة وحاول مرة أخرى.',
              'Could not load your preferences. Refresh the page and try again.',
              'نەتوانرا باربکرێت.'
            )}
          />
        ) : (
          <Spinner />
        )}
      </Card>
    );
  }

  const emptyHint = loc(
    'فارغ = كل ما تستطيع طابعاتك عمله. هذا هو الوضع الافتراضي، وهو الأنسب لمعظم الورش.',
    'Empty = everything your printers can do. That is the default, and the right choice for most workshops.',
    'بەتاڵ = هەموو ئەوەی چاپکەرەکانت دەیکەن.'
  );
  const set = (patch: Partial<PrefsForm>) => {
    setF({ ...f, ...patch });
    setSaved(false);
  };

  return (
    <Card title={loc('إشعارات طلبات الطباعة', 'Print request notifications', 'ئاگادارکردنەوەی داواکاری')}>
      <div data-prefs="form" className="space-y-3.5">
        <p className="text-zinc-500 text-[11.5px] leading-relaxed">
          {loc(
            'المفتاح الرئيسي «فرص طلبات العملاء» يعيش في تبويب الإشعارات. هذه الشاشة تُضيّق ما يصلك فقط — لا تستطيع أن توسّعه، ولا أن تجعل طابعتك تقبل عملًا لا تستطيعه.',
            'The master switch, “Customer request opportunities”, lives in the Notifications tab. This screen only narrows what reaches you — it can never widen it, and never make a printer accept work it cannot do.',
            'کلیلی سەرەکی لە تابی ئاگادارکردنەوەدایە؛ ئەم شاشەیە تەنها کەمی دەکاتەوە.'
          )}
        </p>

        {!canSell && (
          <Notice
            text={loc(
              'البيع متوقّف حاليًا، وبينما هو كذلك تُستبعد ورشتك من المطابقة مهما كانت هذه الإعدادات.',
              'Selling is paused, and while it is your workshop is excluded from matching whatever these settings say.',
              'فرۆشتن ڕاگیراوە، بۆیە مامەڵەکردن ناتگاتێ.'
            )}
          />
        )}

        {/* The pause switch, deliberately the largest control on the screen:
            it is the one a busy merchant reaches for at 2am. */}
        <button
          type="button"
          data-prefs="paused"
          aria-pressed={f.paused}
          onClick={() => set({ paused: !f.paused })}
          className={`w-full flex items-center gap-3 rounded-2xl border p-3 text-start transition-colors ${
            f.paused ? 'border-amber-500/40 bg-amber-500/10' : 'border-white/10 bg-white/[0.03]'
          }`}
        >
          <span
            className={`w-11 h-[26px] rounded-full shrink-0 relative transition-colors ${f.paused ? 'bg-amber-500' : 'bg-white/10'}`}
          >
            <span
              className={`absolute top-[3px] w-5 h-5 rounded-full bg-white transition-all ${f.paused ? 'start-[23px]' : 'start-[3px]'}`}
            />
          </span>
          <span className="min-w-0">
            <span className={`block text-[13px] font-bold ${f.paused ? 'text-amber-300' : 'text-white'}`}>
              {f.paused
                ? loc('استقبال الطلبات موقوف', 'Request notifications paused', 'ڕاگیراوە')
                : loc('أوقِف استقبال الطلبات مؤقتًا', 'Pause request notifications', 'ڕایبگرە')}
            </span>
            <span className="block text-zinc-500 text-[11px] mt-0.5">
              {loc(
                'إيقاف مؤقت لا يمسّ متجرك ولا طلباتك الجارية — يمنع وصول طلبات جديدة فقط.',
                'A pause touches neither your store nor your live orders — it only stops new requests reaching you.',
                'تەنها داواکاری نوێ ڕادەگرێت.'
              )}
            </span>
          </span>
        </button>

        {f.paused && (
          <Input
            label={loc('حتى تاريخ (اختياري)', 'Until (optional)', 'تا بەروار')}
            value={f.paused_until}
            onChange={(paused_until) => set({ paused_until })}
            type="date"
            ltr
            hint={loc(
              'اتركه فارغًا ليبقى الإيقاف حتى تُلغيه بنفسك؛ أو ضع تاريخًا لتعود الطلبات تلقائيًا بعده.',
              'Leave it empty to stay paused until you switch it back; or set a date and requests resume by themselves.',
              'بەتاڵ = تا خۆت دەیگۆڕیت.'
            )}
          />
        )}

        <Group label={loc('التقنيات', 'Technologies', 'تەکنەلۆژیا')} hint={emptyHint}>
          {vocab.processes.map((p) => (
            <Chip
              key={p}
              label={techLabel(p, loc)}
              active={f.processes.includes(p)}
              onClick={() => set({ processes: toggleIn(f.processes, p) })}
            />
          ))}
        </Group>

        <Group label={loc('الخامات', 'Materials', 'کەرەستەکان')} hint={emptyHint}>
          {vocab.materials.map((m) => (
            <Chip
              key={m.id}
              label={loc(m.name_ar, m.name_en)}
              active={f.materials.includes(m.id)}
              onClick={() => set({ materials: toggleIn(f.materials, m.id) })}
            />
          ))}
        </Group>

        <Group
          label={loc('نوع العمل', 'Kind of work', 'جۆری کار')}
          hint={loc(
            'فارغ = كل نوع تستطيعه طابعاتك. إن اخترت هنا فلن تصلك الطلبات التي تحتاج نوعًا لم تخترْه.',
            'Empty = every kind your printers can do. Pick here and a job needing a kind you left out will not reach you.',
            'بەتاڵ = هەموو جۆرەکان.'
          )}
        >
          {vocab.capabilities.map((c) => (
            <Chip
              key={c}
              label={capabilityLabel(c, loc)}
              active={f.capabilities.includes(c)}
              onClick={() => set({ capabilities: toggleIn(f.capabilities, c) })}
            />
          ))}
        </Group>

        <div>
          <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
            {loc('الألوان', 'Colours', 'ڕەنگەکان')}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {SWATCHES.map((c) => (
              <button
                key={c.hex}
                type="button"
                onClick={() => set({ colors: toggleIn(f.colors, c.hex) })}
                title={loc(c.ar, c.en)}
                aria-label={loc(c.ar, c.en)}
                aria-pressed={f.colors.includes(c.hex)}
                className={`w-9 h-9 rounded-full border-2 transition-transform ${
                  f.colors.includes(c.hex) ? 'border-gold scale-110' : 'border-white/15'
                }`}
                style={{ backgroundColor: c.hex }}
              />
            ))}
          </div>
          <p className="text-zinc-600 text-[10.5px] mt-1.5">{emptyHint}</p>
        </div>

        <Group
          label={loc('المحافظات', 'Governorates', 'پارێزگاکان')}
          hint={loc(
            'فارغ = كل العراق. اختر محافظات فقط إن كنت لا تخدم خارجها.',
            'Empty = all of Iraq. Pick governorates only if you truly do not serve beyond them.',
            'بەتاڵ = هەموو عێراق.'
          )}
        >
          {GOVERNORATES.map((g) => (
            <Chip
              key={g.id}
              label={lang === 'ckb' ? g.ckb : lang === 'en' ? g.en : g.ar}
              active={f.governorates.includes(g.id)}
              onClick={() => set({ governorates: toggleIn(f.governorates, g.id) })}
            />
          ))}
        </Group>

        <Group label={loc('طريقة الاستلام', 'How it is handed over', 'شێوازی وەرگرتن')} hint={emptyHint}>
          {vocab.delivery.map((dl) => (
            <Chip
              key={dl}
              label={deliveryLabel(dl, loc)}
              active={f.delivery.includes(dl)}
              onClick={() => set({ delivery: toggleIn(f.delivery, dl) })}
            />
          ))}
        </Group>

        <div>
          <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
            {loc('قيمة الطلب (د.ع)', 'Job value (IQD)', 'نرخی کار (IQD)')}
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={f.min_job_iqd}
              onChange={(min_job_iqd) => set({ min_job_iqd })}
              type="number"
              ltr
              placeholder={loc('الأدنى', 'Minimum', 'کەمترین')}
            />
            <Input
              value={f.max_job_iqd}
              onChange={(max_job_iqd) => set({ max_job_iqd })}
              type="number"
              ltr
              placeholder={loc('الأعلى', 'Maximum', 'زۆرترین')}
            />
          </div>
          <p className="text-zinc-600 text-[10.5px] mt-1">
            {loc(
              'يُقارَن بتقدير المنصة لقيمة العمل. اتركه فارغًا لعدم وجود حد.',
              'Compared against the platform’s estimate of the job. Leave empty for no limit.',
              'بەتاڵ = بێ سنوور.'
            )}
          </p>
        </div>

        <div>
          <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
            {loc('مقاس القطعة — أطول ضلع (مم)', 'Part size — longest edge (mm)', 'قەبارە — درێژترین لا (مم)')}
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={f.min_size_mm}
              onChange={(min_size_mm) => set({ min_size_mm })}
              type="number"
              ltr
              placeholder={loc('الأدنى', 'Minimum', 'کەمترین')}
            />
            <Input
              value={f.max_size_mm}
              onChange={(max_size_mm) => set({ max_size_mm })}
              type="number"
              ltr
              placeholder={loc('الأعلى', 'Maximum', 'زۆرترین')}
            />
          </div>
          <p className="text-zinc-600 text-[10.5px] mt-1">
            {loc(
              'حدٌّ تختاره أنت، فوق حدود طابعاتك الفعلية. اتركه فارغًا لعدم وجود حد.',
              'A limit you choose, on top of what your printers physically allow. Leave empty for no limit.',
              'بەتاڵ = بێ سنوور.'
            )}
          </p>
        </div>

        <div>
          <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
            {loc('ضغط العمل عندك الآن', 'How busy you are now', 'قەبارەی کار')}
          </label>
          <div className="grid grid-cols-4 gap-1.5">
            {vocab.workloads.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => set({ workload: w })}
                className={`h-9 rounded-xl text-[11.5px] font-semibold border transition-colors ${
                  f.workload === w ? 'bg-olive text-white border-olive' : 'bg-white/[0.03] text-zinc-400 border-white/10'
                }`}
              >
                {workloadLabel(w, loc)}
              </button>
            ))}
          </div>
          <p className="text-zinc-600 text-[10.5px] mt-1.5">
            {loc(
              'لا يمنع وصول الطلبات — يُرتّبك أدنى في القائمة حين تكون مشغولًا، ليصل العمل لمن يستطيع البدء فورًا.',
              'It blocks nothing — it just ranks you lower while you are busy, so work reaches whoever can start now.',
              'ڕیزبەندیت دەگۆڕێت، نەک ئەوەی داواکاری ڕابگرێت.'
            )}
          </p>
        </div>

        {error && <p className="text-red-400 text-[11.5px]">{error}</p>}

        <HookBtn attrs={{ 'data-prefs': 'save' }} onClick={save} disabled={saving} full>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : null}
          {saved
            ? loc('تم الحفظ', 'Saved', 'پاشەکەوت کرا')
            : loc('حفظ التفضيلات', 'Save preferences', 'پاشەکەوتکردن')}
        </HookBtn>
      </div>
    </Card>
  );
}

// -------------------------------------------------------- why no request came

function MatchesPanel() {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MatchRow[] | null>(null);

  useEffect(() => {
    // Fetched on the first open only. It is a diagnostic most merchants never
    // need, and spending a request on every visit to this tab to answer a
    // question nobody asked is the wrong trade.
    if (!open || rows !== null) return;
    api
      .get<{ matches: MatchRow[] }>('/api/merchant/request-matches?limit=30')
      .then((d) => setRows(d.matches))
      .catch(() => setRows([]));
  }, [open, rows]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 p-3.5 text-start"
      >
        <span className="min-w-0">
          <span className="block text-gold font-bold text-[12.5px]">
            {loc('لماذا لم يصلني طلب؟', 'Why didn’t I get a request?', 'بۆچی داواکاریم بۆ نەهات؟')}
          </span>
          <span className="block text-zinc-500 text-[11px] mt-0.5">
            {loc(
              'آخر قرارات المطابقة الخاصة بورشتك، وسببها بالحرف.',
              'The matcher’s most recent decisions about your workshop, and the reason for each.',
              'دوایین بڕیارەکانی مامەڵەکردن.'
            )}
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-zinc-600 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-3.5 pb-3.5">
          {rows === null ? (
            <Spinner />
          ) : !rows.length ? (
            <Empty
              text={loc('لا توجد قرارات بعد', 'No decisions yet', 'هێشتا بڕیار نییە')}
              hint={loc(
                'يظهر هنا كل طلب مرّ على المطابقة منذ أن أضفت طابعتك.',
                'Every request the matcher weighed you for since you added a printer shows up here.',
                'هەموو داواکارییەک لێرە دەردەکەوێت.'
              )}
            />
          ) : (
            <div data-matches="list" className="space-y-2">
              {rows.map((m) => (
                <div
                  key={`${m.request_id}-${m.created_at}`}
                  className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="text-zinc-200 text-[12px] font-semibold truncate">{m.title}</p>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${
                        m.notified
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : 'bg-white/[0.05] text-zinc-500 border-white/10'
                      }`}
                    >
                      {m.notified
                        ? loc('وصلك إشعار', 'Notified', 'ئاگادارکرایت')
                        : loc('لم يصلك', 'Not notified', 'ئاگادار نەکرایت')}
                    </span>
                  </div>
                  <p className="text-zinc-500 text-[11px] leading-relaxed">
                    {m.eligible
                      ? loc(
                          'كنت مؤهلًا لهذا الطلب.',
                          'You qualified for this request.',
                          'شایستەی ئەم داواکارییە بوویت.'
                        )
                      : reasonText(m.reject_reason, loc)}
                  </p>
                  <p className="text-zinc-700 text-[10px] mt-1" dir="ltr">
                    {new Date(m.created_at).toLocaleDateString('en-GB')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
