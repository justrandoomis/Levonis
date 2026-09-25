/**
 * الحزم — the bundles panel (docs/BUNDLES_MYSTERY.md §11.1).
 *
 * A bundle is a real `products` row carrying `composition = 'bundle'`: it has
 * its own ar/en/ckb title, slug, cover, status, display order and price
 * ladder, and its availability is COMPUTED from the members' real inventory.
 *
 * Three rules shape this screen, and all three are about not lying:
 *
 *   NOTHING IS COMPUTED HERE. The component value, the saving, `max_bundles`,
 *   the blocking component and every warning arrive from the server, from the
 *   same functions the storefront, the cart and the door use. A number this
 *   panel calculated could disagree with the one a customer is charged, and
 *   the only way to guarantee it never does is to never calculate one.
 *
 *   NOTHING IS SILENTLY REPAIRED. A refusal is shown verbatim, line by line,
 *   in the admin's own language, with the component it belongs to named. The
 *   panel never "fixes" a discount, a price or a shipping mix and saves
 *   anyway.
 *
 *   WARNINGS SURVIVE A SUCCESSFUL SAVE. They stay on the screen after the
 *   green line, the way the product form keeps its own — a warning that
 *   disappears with the save it belongs to was never read.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  ArrowUp,
  ArrowDown,
  X,
} from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { api, ApiError, formatIqd } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import {
  Banner,
  Field,
  Grid,
  Money,
  Qty,
  Repeater,
  SectionCard,
  Select,
  TextInput,
  TextArea,
  Toggle,
  btnGhost,
  btnPrimary,
  btnDanger,
  iconBtn,
} from '../adminProducts/form/formUi';
import { TriText } from '../adminProducts/ui';
import ProductPicker from '../adminProducts/form/ProductPicker';

// ------------------------------------------------------------------- types

/** One admin-facing line, exactly as the server sends it (§11.3). */
interface BundleIssue {
  code: string;
  message: string;
  key?: string;
  line?: number;
  ar: string;
  en: string;
  ckb: string;
  component_id?: string;
}

interface ComponentInput {
  id?: string;
  member_product_id: string;
  qty: number;
  optional: boolean;
  option_value_ids: string[];
  color_id: string;
  customer_picks_option: boolean;
  customer_picks_color: boolean;
  sort: number;
  choice_option_value_ids: string[];
  choice_color_ids: string[];
}

interface ConfigInput {
  price_mode: 'fixed' | 'discount_percent' | 'discount_iqd';
  discount_percent: number | null;
  discount_iqd: number | null;
  min_price_iqd: number;
  plus_price_iqd: number | null;
  max_qty_per_order: number;
}

interface OfferInput {
  starts_at: string | null;
  ends_at: string | null;
  required_tiers: string[];
  offer_price_mode: '' | 'fixed' | 'discount_percent' | 'discount_iqd';
  offer_price_iqd: number | null;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  locked_preview: boolean;
  active: boolean;
  max_per_user: number | null;
  max_global: number | null;
}

interface ComponentPreview {
  component_id: string;
  member_product_id: string;
  name: string;
  qty_per_bundle: number;
  optional: boolean;
  unit_iqd: number;
  line_value_iqd: number;
  available: number | null;
  shipping_type: string;
}

interface Preview {
  component_total_iqd: number;
  bundle_price_iqd: number;
  regular_iqd: number;
  prime_iqd: number | null;
  pro_iqd: number | null;
  plus_iqd: number | null;
  discount_iqd: number;
  saving_percent: number;
  availability: {
    state: string;
    max_bundles: number | null;
    shipping_type: string;
    modes: string[];
    blocking: Array<{ component_id: string; product_id: string; available: number; needed: number; reason: string }>;
  };
  components: ComponentPreview[];
}

interface BundleCard {
  id: string;
  slug: string;
  status: string;
  kind: string;
  name: string;
  name_ar: string;
  name_ku: string;
  image: string;
  display_order: number;
  price_iqd: number;
  component_count: number;
  component_total_iqd: number;
  bundle_price_iqd: number;
  saving_percent: number;
  max_bundles: number | null;
  availability_state: string;
  offer: OfferInput | null;
  warnings: string[];
  warning_details: BundleIssue[];
}

interface EditorDoc {
  id: string | null;
  slug: string;
  status: 'draft' | 'active' | 'hidden';
  name_ar: string;
  name_en: string;
  name_ckb: string;
  description_ar: string;
  description_en: string;
  description_ckb: string;
  price_iqd: number;
  original_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  display_order: number;
  is_featured: boolean;
  images: string[];
  updated_at: string;
}

interface RelationsRow {
  values: Array<{ id: string; name_en: string; group_id: string; active: number | boolean }>;
  colors: Array<{ id: string; name_en: string; active: number | boolean }>;
}

// ------------------------------------------------------------------ helpers

const TIERS = ['plus', 'prime', 'pro'] as const;
const STATES: Record<string, { ar: string; en: string; ckb: string; tone: 'ok' | 'warn' | 'bad' }> = {
  in_stock: { ar: 'متوفرة', en: 'In stock', ckb: 'بەردەستە', tone: 'ok' },
  member_exclusive: { ar: 'حصرية للمشتركين', en: 'Members only', ckb: 'تەنها ئەندامان', tone: 'ok' },
  low: { ar: 'كمية قليلة', en: 'Low', ckb: 'کەمە', tone: 'warn' },
  ending_soon: { ar: 'تنتهي قريبًا', en: 'Ending soon', ckb: 'بەم زووانە کۆتایی دێت', tone: 'warn' },
  preorder: { ar: 'طلب مسبق', en: 'Pre-order', ckb: 'پێش-داواکاری', tone: 'ok' },
  upcoming: { ar: 'لم تبدأ بعد', en: 'Upcoming', ckb: 'هێشتا دەستی پێنەکردووە', tone: 'warn' },
  sold_out: { ar: 'نفدت', en: 'Sold out', ckb: 'تەواو بوو', tone: 'bad' },
  ended: { ar: 'منتهية', en: 'Ended', ckb: 'کۆتایی هات', tone: 'bad' },
  locked: { ar: 'مقفلة', en: 'Locked', ckb: 'داخراوە', tone: 'warn' },
  unconfigured: { ar: 'غير مكتملة', en: 'Not configured', ckb: 'ڕێکنەخراوە', tone: 'bad' },
};

const blankDoc = (): EditorDoc => ({
  id: null,
  slug: '',
  status: 'draft',
  name_ar: '',
  name_en: '',
  name_ckb: '',
  description_ar: '',
  description_en: '',
  description_ckb: '',
  price_iqd: 0,
  original_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  display_order: 0,
  is_featured: false,
  images: [],
  updated_at: '',
});

const blankConfig = (): ConfigInput => ({
  price_mode: 'fixed',
  discount_percent: null,
  discount_iqd: null,
  min_price_iqd: 1,
  plus_price_iqd: null,
  max_qty_per_order: 5,
});

const blankComponent = (sort: number): ComponentInput => ({
  member_product_id: '',
  qty: 1,
  optional: false,
  option_value_ids: [],
  color_id: '',
  customer_picks_option: false,
  customer_picks_color: false,
  sort,
  choice_option_value_ids: [],
  choice_color_ids: [],
});

/** A refusal's row-level lines, or its sentence when it carried none. */
function issuesOf(e: unknown): BundleIssue[] {
  if (e instanceof ApiError) {
    const raw = (e.details?.errors ?? []) as unknown[];
    const list = raw.filter((x): x is BundleIssue => !!x && typeof x === 'object' && 'code' in (x as object));
    if (list.length) return list;
    return [{ code: e.code ?? 'ERROR', message: e.message, ar: e.message, en: e.message, ckb: e.message }];
  }
  const message = e instanceof Error ? e.message : String(e);
  return [{ code: 'ERROR', message, ar: message, en: message, ckb: message }];
}

/** An ISO instant as the value a `datetime-local` input wants, in Baghdad
 *  time — the zone the store runs in. The server normalises back to UTC. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 3 * 3600_000).toISOString().slice(0, 16);
}

/**
 * WHY A BLOCKING COMPONENT IS BLOCKING, IN THE ADMIN'S OWN LANGUAGE.
 *
 * `availability.blocking[].reason` is a machine code — `OUT_OF_STOCK`,
 * `PREORDER_CAPACITY_EXHAUSTED` — and the preview used to render it verbatim,
 * so an Arabic-first admin read «<product> — المطلوب 1, المتاح 0
 * (PREORDER_CAPACITY_EXHAUSTED)». The ONE fact that distinguishes a full import
 * quota from an empty shelf — a different problem, a different fix, a different
 * screen to go and fix it on — arrived untranslated, on the screen the admin
 * opens to diagnose it. Every other refusal on this panel is a server sentence
 * in three languages (`BundleIssue.ar/en/ckb`); these codes are computed inside
 * `bundleAvailability`, carry no sentence, and this table is where they get one.
 *
 * The raw code is still shown beside the sentence, dimmed: an admin reporting a
 * problem to support quotes the code, and translating it away would take that
 * with it. A code with no entry here falls back to itself rather than to an
 * empty string, so a reason added on the server is never silently swallowed.
 *
 * ckb: THE ARABIC IS DELIBERATELY REPEATED. Kurdish Sorani here is the owner's
 * to write by hand; a generated translation on an admin's diagnostic screen is
 * worse than an honest fallback to a language they read.
 */
const BLOCKING_REASONS: Record<string, { ar: string; en: string }> = {
  OUT_OF_STOCK: { ar: 'نفد المخزون', en: 'out of stock' },
  PREORDER_CAPACITY_EXHAUSTED: { ar: 'حصة الطلب المسبق ممتلئة', en: 'pre-order quota is full' },
  PREORDER_CAPACITY_AMBIGUOUS: {
    ar: 'اختيار واحد يسمّي حصتَي طلب مسبق — اترك الحصة على موديل واحد فقط',
    en: 'one selection names two pre-order quotas — leave the quota on one model only',
  },
  SELECTION_INCOMPLETE: { ar: 'الاختيار غير مكتمل', en: 'selection incomplete' },
  VARIANT_NOT_MODELLED: { ar: 'هذه التوليفة غير معرّفة للبيع', en: 'this combination is not set up for sale' },
  COMPONENT_UNAVAILABLE: { ar: 'هذا المكوّن لم يعد معروضًا للبيع', en: 'this component is no longer on sale' },
};

export default function AdminBundles() {
  const { lang, dir } = useLanguage();
  const loc = useCallback(
    (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar),
    [lang]
  );
  const say = useCallback((i: BundleIssue) => (lang === 'en' ? i.en : lang === 'ckb' ? i.ckb : i.ar), [lang]);
  /** One blocking code, as a sentence. `ckb` falls back to the Arabic on
   *  purpose — see BLOCKING_REASONS. */
  const whyBlocked = useCallback(
    (code: string) => {
      const found = BLOCKING_REASONS[code];
      if (!found) return code;
      return lang === 'en' ? found.en : found.ar;
    },
    [lang]
  );

  const [rows, setRows] = useState<BundleCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [ok, setOk] = useState<string | null>(null);

  // A sequence guard so a slow reload cannot overwrite a newer one.
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (search.trim()) q.set('search', search.trim());
      if (statusFilter) q.set('status', statusFilter);
      const res = await api.get<{ bundles: BundleCard[] }>(`/api/admin/bundles${q.size ? `?${q}` : ''}`);
      if (mine !== seq.current) return;
      setRows(res.bundles ?? []);
      setLoadErr(null);
    } catch (e) {
      if (mine === seq.current) setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ------------------------------------------------------------- editor state
  const [editing, setEditing] = useState<null | {
    doc: EditorDoc;
    config: ConfigInput;
    components: ComponentInput[];
    offer: OfferInput | null;
  }>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [issues, setIssues] = useState<BundleIssue[]>([]);
  const [warnings, setWarnings] = useState<BundleIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [openSection, setOpenSection] = useState(1);

  const [relations, setRelations] = useState<Record<string, RelationsRow>>({});

  const loadRelations = useCallback(
    async (productId: string) => {
      if (!productId || relations[productId]) return;
      try {
        const res = await api.get<RelationsRow>(`/api/admin/products/${productId}/relations`);
        setRelations((prev) => ({ ...prev, [productId]: { values: res.values ?? [], colors: res.colors ?? [] } }));
      } catch {
        setRelations((prev) => ({ ...prev, [productId]: { values: [], colors: [] } }));
      }
    },
    [relations]
  );

  const openNew = async () => {
    setEditing({ doc: blankDoc(), config: blankConfig(), components: [blankComponent(0)], offer: null });
    setPreview(null);
    setIssues([]);
    setWarnings([]);
    setOpenSection(1);
  };

  const openExisting = async (id: string) => {
    try {
      const res = await api.get<{
        product: Record<string, unknown>;
        config: ConfigInput;
        components: ComponentInput[];
        offer: OfferInput | null;
        preview: Preview;
        updated_at: string;
        warning_details: BundleIssue[];
      }>(`/api/admin/bundles/${id}`);
      const p = res.product;
      setEditing({
        doc: {
          id: String(p.id ?? ''),
          slug: String(p.slug ?? ''),
          status: (p.status as EditorDoc['status']) ?? 'draft',
          name_ar: String(p.name_ar ?? ''),
          name_en: String(p.name_en ?? ''),
          name_ckb: String(p.name_ckb ?? ''),
          description_ar: String(p.description_ar ?? ''),
          description_en: String(p.description_en ?? ''),
          description_ckb: String(p.description_ckb ?? ''),
          price_iqd: Number(p.price_iqd ?? 0),
          original_price_iqd: p.original_price_iqd === null || p.original_price_iqd === undefined ? null : Number(p.original_price_iqd),
          prime_price_iqd: p.prime_price_iqd === null || p.prime_price_iqd === undefined ? null : Number(p.prime_price_iqd),
          pro_price_iqd: p.pro_price_iqd === null || p.pro_price_iqd === undefined ? null : Number(p.pro_price_iqd),
          display_order: Number(p.display_order ?? 0),
          is_featured: !!p.is_featured,
          images: (Array.isArray(p.media) ? (p.media as Array<{ url?: string }>) : [])
            .map((m) => String(m.url ?? ''))
            .filter(Boolean),
          updated_at: res.updated_at ?? '',
        },
        config: res.config,
        components: res.components,
        offer: res.offer,
      });
      setPreview(res.preview);
      setWarnings(res.warning_details ?? []);
      setIssues([]);
      setOpenSection(1);
      for (const c of res.components) void loadRelations(c.member_product_id);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setIssues([]);
    setOk(null);
    try {
      const body = {
        ...editing.doc,
        images: editing.doc.images.map((url) => ({ url })),
        media: editing.doc.images.map((url, i) => ({ id: `img_${i}`, url, primary: i === 0 })),
        components: editing.components,
        config: editing.config,
        offer: editing.offer,
        ...(editing.doc.id ? { expected_updated_at: editing.doc.updated_at } : {}),
      };
      const res = editing.doc.id
        ? await api.put<{ product: Record<string, unknown>; preview: Preview; warning_details: BundleIssue[] }>(
            `/api/admin/bundles/${editing.doc.id}`,
            body
          )
        : await api.post<{ product: Record<string, unknown>; preview: Preview; warning_details: BundleIssue[] }>(
            '/api/admin/bundles',
            body
          );
      setPreview(res.preview);
      // The warnings STAY on the screen after a successful save.
      setWarnings(res.warning_details ?? []);
      setOk(loc('حُفظت الحزمة', 'Bundle saved', 'پاکێجەکە پاشەکەوت کرا'));
      await reload();
      const id = String((res.product as { id?: unknown }).id ?? '');
      if (id) await openExisting(id);
    } catch (e) {
      setIssues(issuesOf(e));
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setIssues([]);
    setOk(null);
    try {
      await fn();
      setOk(done);
      await reload();
    } catch (e) {
      setIssues(issuesOf(e));
    }
  };

  const move = async (index: number, delta: number) => {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next);
    await act(
      () => api.put('/api/admin/bundles/reorder', { order: next.map((b) => b.id) }),
      loc('تم الترتيب', 'Reordered', 'ڕیزکرا')
    );
  };

  const totalWarnings = useMemo(() => rows.reduce((n, b) => n + (b.warnings?.length ?? 0), 0), [rows]);

  // ==================================================================== list

  if (!editing) {
    return (
      <div className={`${T.AP} space-y-4`} dir={dir} data-panel="bundles">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold leading-tight flex items-center gap-2 text-[var(--ap-text-1)]">
              <Boxes className="w-5 h-5 text-[var(--ap-accent,#6B46FF)]" aria-hidden />
              {loc('الحزم', 'Bundles', 'پاکێجەکان')}
            </h1>
            <p className="mt-1 text-[12.5px] text-[var(--ap-text-3)] max-w-[70ch]">
              {loc(
                'الحزمة منتج حقيقي مكوّن من منتجات الكتالوج. لا مخزون لها: توفّرها يُحسب من أندر مكوّن، وسعرها وخصمها وتوفّرها تحسبها الخوادم — لا شيء في هذه الشاشة يُحسب في المتصفح.',
                'A bundle is a real product made of catalogue products. It has no stock of its own: availability is the scarcest component, and every price, saving and count on this screen is computed by the server.',
                'پاکێج بەرهەمێکی ڕاستەقینەیە لە بەرهەمەکانی کەتەلۆگ. کۆگای خۆی نییە: بەردەستی لە کەمترین پێکهاتەوە دەژمێردرێت، و هەموو نرخ و داشکاندنێک لەلایەن سێرڤەرەوە دەژمێردرێت.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={T.btnIconLg} onClick={() => void reload()} aria-label={loc('تحديث', 'Refresh', 'نوێکردنەوە')}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
            <button type="button" className={btnPrimary} onClick={() => void openNew()} data-bundles-new>
              <Plus className="w-4 h-4" aria-hidden /> {loc('حزمة جديدة', 'New bundle', 'پاکێجی نوێ')}
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 max-w-sm">
            <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-[var(--ap-text-3)]" aria-hidden />
            <input
              className={`${T.input} ps-8`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={loc('بحث بالاسم أو الرابط', 'Search by name or slug', 'گەڕان بە ناو یان لینک')}
              aria-label={loc('بحث', 'Search', 'گەڕان')}
            />
          </div>
          <select
            className={T.select}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label={loc('الحالة', 'Status', 'دۆخ')}
          >
            <option value="">{loc('كل الحالات', 'All statuses', 'هەموو دۆخەکان')}</option>
            <option value="active">{loc('منشورة', 'Published', 'بڵاوکراوە')}</option>
            <option value="draft">{loc('مسودة', 'Draft', 'ڕەشنووس')}</option>
            <option value="hidden">{loc('مخفية', 'Hidden', 'شاراوە')}</option>
          </select>
          {totalWarnings > 0 && (
            <span className={`${T.badgeBase} bg-amber-500/10 text-amber-300 border-amber-500/30`}>
              {loc('تنبيهات', 'Warnings', 'ئاگادارییەکان')}: {totalWarnings}
            </span>
          )}
        </div>

        <div role="status" aria-live="polite" className="sr-only">
          {ok ?? loadErr ?? ''}
        </div>
        {ok && <Banner kind="ok">{ok}</Banner>}
        {loadErr && <Banner kind="error">{loadErr}</Banner>}
        {issues.length > 0 && (
          <Banner kind="error">
            <ul className="space-y-1">
              {issues.map((i, k) => (
                <li key={k}>{say(i)}</li>
              ))}
            </ul>
          </Banner>
        )}

        {loading && rows.length === 0 ? (
          <p className="text-[13px] text-[var(--ap-text-3)] py-6">{loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}</p>
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-[var(--ap-text-3)] py-6">
            {loc('لا توجد حزم بعد.', 'No bundles yet.', 'هێشتا هیچ پاکێجێک نییە.')}
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((b, i) => {
              const state = STATES[b.availability_state] ?? STATES.unconfigured;
              return (
                <article key={b.id} className={`${T.surface} p-3 min-w-0`} data-bundle={b.id}>
                  <div className="flex flex-wrap items-start gap-3 min-w-0">
                    {b.image ? (
                      <img src={b.image} alt="" className={T.thumb} loading="lazy" />
                    ) : (
                      <span className={`${T.thumb} grid place-items-center text-[var(--ap-text-3)]`} aria-hidden>
                        <Boxes className="w-4 h-4" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <h2 className="text-[14px] font-bold truncate text-[var(--ap-text-1)]">
                          {lang === 'en' ? b.name || b.name_ar : lang === 'ckb' ? b.name_ku || b.name_ar : b.name_ar || b.name}
                        </h2>
                        <span className={`${T.badgeBase} ${T.badge[(b.status as 'active' | 'draft' | 'hidden') ?? 'draft']}`}>
                          {b.status}
                        </span>
                        <span
                          className={`${T.badgeBase} ${
                            state.tone === 'ok'
                              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                              : state.tone === 'warn'
                                ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                                : 'bg-red-500/10 text-red-300 border-red-500/30'
                          }`}
                        >
                          {loc(state.ar, state.en, state.ckb)}
                        </span>
                        {b.offer && b.offer.required_tiers.length > 0 && (
                          <span className={`${T.badgeBase} bg-violet-500/10 text-violet-300 border-violet-500/30`}>
                            {b.offer.required_tiers.join(' · ').toUpperCase()}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[12px] text-[var(--ap-text-3)] flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>
                          {loc('المكوّنات', 'Components', 'پێکهاتەکان')}: {b.component_count}
                        </span>
                        <span>
                          {loc('قيمة المكوّنات', 'Parts value', 'نرخی پارچەکان')}: {formatIqd(b.component_total_iqd)}
                        </span>
                        <span>
                          {loc('سعر الحزمة', 'Bundle price', 'نرخی پاکێج')}: {formatIqd(b.bundle_price_iqd)}
                        </span>
                        {b.saving_percent > 0 && (
                          <span className="text-emerald-400">
                            {loc('توفير', 'Saving', 'پاشەکەوت')} {b.saving_percent}%
                          </span>
                        )}
                        <span>
                          {loc('أقصى عدد حزم', 'Max bundles', 'زۆرترین پاکێج')}:{' '}
                          {b.max_bundles === null ? loc('غير محدود', 'unbounded', 'بێ سنوور') : b.max_bundles}
                        </span>
                      </p>
                      {b.warnings.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {b.warning_details.map((w, k) => (
                            <li key={k} className="text-[11.5px] text-amber-300">
                              • {say(w)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() => void move(i, -1)}
                        aria-label={loc('أعلى', 'Move up', 'بۆ سەرەوە')}
                      >
                        <ArrowUp className="w-4 h-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() => void move(i, 1)}
                        aria-label={loc('أسفل', 'Move down', 'بۆ خوارەوە')}
                      >
                        <ArrowDown className="w-4 h-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() =>
                          void act(
                            () =>
                              api.patch(`/api/admin/bundles/${b.id}/status`, {
                                action: b.status === 'active' ? 'disable' : 'enable',
                              }),
                            b.status === 'active' ? loc('أُخفيت', 'Hidden', 'شاردرایەوە') : loc('نُشرت', 'Published', 'بڵاوکرایەوە')
                          )
                        }
                        aria-label={b.status === 'active' ? loc('إخفاء', 'Disable', 'شاردنەوە') : loc('نشر', 'Enable', 'بڵاوکردنەوە')}
                      >
                        {b.status === 'active' ? <EyeOff className="w-4 h-4" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
                      </button>
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() =>
                          void act(
                            () => api.post(`/api/admin/bundles/${b.id}/duplicate`, {}),
                            loc('نُسخت', 'Duplicated', 'لەبەرگیرایەوە')
                          )
                        }
                        aria-label={loc('نسخ', 'Duplicate', 'لەبەرگرتنەوە')}
                      >
                        <Copy className="w-4 h-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIconDanger}
                        onClick={() => {
                          if (!window.confirm(loc('حذف أو أرشفة هذه الحزمة؟', 'Delete or archive this bundle?', 'ئەم پاکێجە بسڕدرێتەوە؟'))) return;
                          void act(() => api.delete(`/api/admin/bundles/${b.id}`), loc('تمت الأرشفة', 'Archived', 'ئەرشیف کرا'));
                        }}
                        aria-label={loc('حذف', 'Delete', 'سڕینەوە')}
                      >
                        <Trash2 className="w-4 h-4" aria-hidden />
                      </button>
                      <button type="button" className={btnGhost} onClick={() => void openExisting(b.id)}>
                        {loc('تحرير', 'Edit', 'دەستکاری')}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ================================================================== editor

  const { doc, config, components, offer } = editing;
  const setDoc = (patch: Partial<EditorDoc>) => setEditing({ ...editing, doc: { ...doc, ...patch } });
  const setConfig = (patch: Partial<ConfigInput>) => setEditing({ ...editing, config: { ...config, ...patch } });
  const setOffer = (patch: Partial<OfferInput> | null) =>
    setEditing({
      ...editing,
      offer:
        patch === null
          ? null
          : {
              starts_at: null,
              ends_at: null,
              required_tiers: [],
              offer_price_mode: '',
              offer_price_iqd: null,
              discount_percent: null,
              discount_iqd: null,
              plus_price_iqd: null,
              locked_preview: true,
              active: true,
              max_per_user: null,
              max_global: null,
              ...(offer ?? {}),
              ...patch,
            },
    });
  const setComponent = (i: number, patch: Partial<ComponentInput>) => {
    const next = components.map((c, k) => (k === i ? { ...c, ...patch } : c));
    setEditing({ ...editing, components: next });
  };

  const issuesFor = (componentId: string | undefined, index: number) =>
    issues.filter((x) => (componentId && x.component_id === componentId) || x.line === index + 1);

  return (
    <div className={`${T.AP} space-y-3`} dir={dir} data-panel="bundles-editor">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[18px] font-bold flex items-center gap-2 text-[var(--ap-text-1)]">
          <Boxes className="w-5 h-5 text-[var(--ap-accent,#6B46FF)]" aria-hidden />
          {doc.id ? loc('تحرير حزمة', 'Edit bundle', 'دەستکاری پاکێج') : loc('حزمة جديدة', 'New bundle', 'پاکێجی نوێ')}
        </h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              setEditing(null);
              setIssues([]);
              void reload();
            }}
          >
            <X className="w-4 h-4" aria-hidden /> {loc('إغلاق', 'Close', 'داخستن')}
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={() => void save()} data-bundles-save>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
            {loc('حفظ', 'Save', 'پاشەکەوت')}
          </button>
        </div>
      </header>

      <div role="status" aria-live="polite" className="sr-only">
        {ok ?? (issues.length ? issues.map(say).join(' · ') : '')}
      </div>
      {ok && <Banner kind="ok">{ok}</Banner>}
      {issues.length > 0 && (
        <Banner kind="error">
          <p className="font-bold mb-1">{loc('لم تُحفظ الحزمة:', 'The bundle was not saved:', 'پاکێجەکە پاشەکەوت نەکرا:')}</p>
          <ul className="space-y-1">
            {issues.map((i, k) => (
              <li key={k}>
                <span className="font-mono text-[11px] opacity-70">{i.code}</span> — {say(i)}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {warnings.length > 0 && (
        <Banner kind="warn">
          <ul className="space-y-1">
            {warnings.map((w, k) => (
              <li key={k}>
                <span className="font-mono text-[11px] opacity-70">{w.code}</span> — {say(w)}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {/* 1 — identity */}
      <SectionCard
        n={1}
        ar="الهوية"
        en="Identity"
        open={openSection === 1}
        onToggle={() => setOpenSection(openSection === 1 ? 0 : 1)}
      >
        <TriText
          labelAr="الاسم"
          labelEn="Name"
          ar={doc.name_ar}
          en={doc.name_en}
          ckb={doc.name_ckb}
          onAr={(v) => setDoc({ name_ar: v })}
          onEn={(v) => setDoc({ name_en: v })}
          onCkb={(v) => setDoc({ name_ckb: v })}
        />
        <div className="h-3" />
        <TriText
          textarea
          labelAr="الوصف"
          labelEn="Description"
          ar={doc.description_ar}
          en={doc.description_en}
          ckb={doc.description_ckb}
          onAr={(v) => setDoc({ description_ar: v })}
          onEn={(v) => setDoc({ description_en: v })}
          onCkb={(v) => setDoc({ description_ckb: v })}
        />
        <div className="h-3" />
        <Grid cols={3}>
          <Field ar="الحالة" en="Status">
            <Select value={doc.status} onChange={(e) => setDoc({ status: e.target.value as EditorDoc['status'] })}>
              <option value="draft">{loc('مسودة', 'Draft', 'ڕەشنووس')}</option>
              <option value="active">{loc('منشورة', 'Published', 'بڵاوکراوە')}</option>
              <option value="hidden">{loc('مخفية', 'Hidden', 'شاراوە')}</option>
            </Select>
          </Field>
          <Field ar="الترتيب" en="Display order">
            <Qty value={doc.display_order} onChange={(v) => setDoc({ display_order: v ?? 0 })} placeholder="0" />
          </Field>
          <Field ar="مميّزة" en="Featured">
            <Toggle
              checked={doc.is_featured}
              onChange={(v) => setDoc({ is_featured: v })}
              label={loc('تظهر في الواجهة', 'Featured rail', 'لە ڕیزی سەرەکی')}
            />
          </Field>
        </Grid>
        <div className="h-3" />
        <Field ar="الصور" en="Images" hint={loc('أول صورة هي الغلاف', 'the first image is the cover', 'یەکەم وێنە بەرگەکەیە')} span>
          <TextArea
            value={doc.images.join('\n')}
            onChange={(e) => setDoc({ images: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
            placeholder="https://…"
          />
        </Field>
      </SectionCard>

      {/* 2 — components */}
      <SectionCard
        n={2}
        ar="المكوّنات"
        en="Components"
        count={components.length}
        open={openSection === 2}
        onToggle={() => setOpenSection(openSection === 2 ? 0 : 2)}
      >
        <Repeater
          title={loc('منتجات الحزمة', 'The products in this bundle', 'بەرهەمەکانی پاکێج')}
          addLabel={loc('مكوّن', 'component', 'پێکهاتە')}
          onAdd={() => setEditing({ ...editing, components: [...components, blankComponent(components.length)] })}
          empty={loc('لا مكوّنات بعد', 'no components yet', 'هێشتا پێکهاتە نییە')}
        >
          {components.map((c, i) => {
            const rel = relations[c.member_product_id];
            const rowIssues = issuesFor(c.id, i);
            return (
              <div
                key={c.id ?? `new_${i}`}
                className={`rounded-lg border p-2.5 min-w-0 ${rowIssues.length ? 'border-red-500/50 bg-red-500/[0.04]' : 'border-zinc-800 bg-zinc-900/30'}`}
              >
                <Grid cols={3}>
                  {/* A DEBOUNCED SEARCH, NOT THE FIRST 100 PRODUCTS.
                      `/api/admin/products-v2` caps `limit` at 100, so a plain
                      `<select>` over one unsearchable page could not be widened
                      and, on a real catalogue, simply did not contain the
                      product an owner wanted to put in a bundle. The route
                      already accepts `search`; this is the picker that uses
                      it, and it resolves the CURRENT value by id so an existing
                      row renders even when its product is on no result page. */}
                  <Field ar="المنتج" en="Product" required>
                    <ProductPicker
                      value={c.member_product_id}
                      ariaLabel={loc('اختر منتجًا', 'Choose a product', 'بەرهەمێک هەڵبژێرە')}
                      onChange={(id) => {
                        setComponent(i, {
                          member_product_id: id,
                          option_value_ids: [],
                          color_id: '',
                          choice_option_value_ids: [],
                          choice_color_ids: [],
                        });
                        void loadRelations(id);
                      }}
                    />
                  </Field>
                  <Field ar="الكمية في الحزمة" en="Qty per bundle" required>
                    <Qty value={c.qty} onChange={(v) => setComponent(i, { qty: Math.max(1, v ?? 1) })} placeholder="1" />
                  </Field>
                  <Field ar="اختياري" en="Optional">
                    <Toggle
                      checked={c.optional}
                      onChange={(v) => setComponent(i, { optional: v })}
                      label={loc('يمكن للمشتري استبعاده', 'the buyer may decline it', 'کڕیار دەتوانێت لایبنێت')}
                    />
                  </Field>
                </Grid>
                <div className="h-2.5" />
                <Grid cols={2}>
                  <Field
                    ar="الخيار"
                    en="Option"
                    hint={loc('اتركه للعميل أو ثبّته', 'pin one, or let the customer choose', 'دایبمەزرێنە یان بیهێڵە بۆ کڕیار')}
                  >
                    <div className="space-y-2 min-w-0">
                      <Toggle
                        checked={c.customer_picks_option}
                        onChange={(v) => setComponent(i, { customer_picks_option: v, option_value_ids: v ? [] : c.option_value_ids })}
                        label={loc('العميل يختار', 'customer picks', 'کڕیار هەڵدەبژێرێت')}
                      />
                      {!c.customer_picks_option && (
                        <Select
                          value={c.option_value_ids[0] ?? ''}
                          onChange={(e) => setComponent(i, { option_value_ids: e.target.value ? [e.target.value] : [] })}
                        >
                          <option value="">{loc('بدون تثبيت', 'not pinned', 'دیارینەکراو')}</option>
                          {(rel?.values ?? [])
                            .filter((v) => !!v.active)
                            .map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name_en}
                              </option>
                            ))}
                        </Select>
                      )}
                    </div>
                  </Field>
                  <Field ar="اللون" en="Colour">
                    <div className="space-y-2 min-w-0">
                      <Toggle
                        checked={c.customer_picks_color}
                        onChange={(v) => setComponent(i, { customer_picks_color: v, color_id: v ? '' : c.color_id })}
                        label={loc('العميل يختار', 'customer picks', 'کڕیار هەڵدەبژێرێت')}
                      />
                      {!c.customer_picks_color && (
                        <Select value={c.color_id} onChange={(e) => setComponent(i, { color_id: e.target.value })}>
                          <option value="">{loc('بدون تثبيت', 'not pinned', 'دیارینەکراو')}</option>
                          {(rel?.colors ?? [])
                            .filter((v) => !!v.active)
                            .map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name_en}
                              </option>
                            ))}
                        </Select>
                      )}
                    </div>
                  </Field>
                </Grid>
                {rowIssues.length > 0 && (
                  <ul className="mt-2 space-y-1 text-[11.5px] text-red-300">
                    {rowIssues.map((x, k) => (
                      <li key={k}>{say(x)}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex items-center justify-end">
                  <button
                    type="button"
                    className={iconBtn}
                    onClick={() => setEditing({ ...editing, components: components.filter((_, k) => k !== i) })}
                    aria-label={loc('إزالة المكوّن', 'Remove component', 'لابردنی پێکهاتە')}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden />
                  </button>
                </div>
              </div>
            );
          })}
        </Repeater>
      </SectionCard>

      {/* 3 — pricing */}
      <SectionCard
        n={3}
        ar="السعر"
        en="Price"
        open={openSection === 3}
        onToggle={() => setOpenSection(openSection === 3 ? 0 : 3)}
      >
        <Grid cols={3}>
          <Field ar="طريقة التسعير" en="Price mode">
            <Select
              value={config.price_mode}
              onChange={(e) => setConfig({ price_mode: e.target.value as ConfigInput['price_mode'] })}
            >
              <option value="fixed">{loc('سعر ثابت', 'Fixed price', 'نرخی جێگیر')}</option>
              <option value="discount_percent">{loc('خصم نسبة من قيمة المكوّنات', 'Percent off the parts', 'ڕێژە داشکاندن')}</option>
              <option value="discount_iqd">{loc('خصم مبلغ من قيمة المكوّنات', 'Dinars off the parts', 'دینار داشکاندن')}</option>
            </Select>
          </Field>
          <Field ar="السعر العادي" en="Regular price" required>
            <Money value={doc.price_iqd} onChange={(v) => setDoc({ price_iqd: v ?? 0 })} required />
          </Field>
          <Field ar="سعر المقارنة" en="Compare-at">
            <Money value={doc.original_price_iqd} onChange={(v) => setDoc({ original_price_iqd: v })} />
          </Field>
          {config.price_mode === 'discount_percent' && (
            <Field ar="نسبة الخصم %" en="Discount %" hint="1–90">
              <Qty value={config.discount_percent} onChange={(v) => setConfig({ discount_percent: v })} placeholder="10" />
            </Field>
          )}
          {config.price_mode === 'discount_iqd' && (
            <Field ar="مبلغ الخصم" en="Discount (IQD)">
              <Money value={config.discount_iqd} onChange={(v) => setConfig({ discount_iqd: v })} />
            </Field>
          )}
          <Field
            ar="الحد الأدنى للسعر"
            en="Minimum price"
            hint={loc('لا تُباع الحزمة تحته', 'below it the bundle is not sold', 'لە خوارتریدا نافرۆشرێت')}
          >
            <Money value={config.min_price_iqd} onChange={(v) => setConfig({ min_price_iqd: v ?? 1 })} required />
          </Field>
          <Field ar="سعر PLUS" en="PLUS price" hint={loc('خاص بالعروض', 'offer-scoped', 'تایبەت بە ئۆفەر')}>
            <Money value={config.plus_price_iqd} onChange={(v) => setConfig({ plus_price_iqd: v })} />
          </Field>
          <Field ar="سعر PRIME" en="PRIME price">
            <Money value={doc.prime_price_iqd} onChange={(v) => setDoc({ prime_price_iqd: v })} />
          </Field>
          <Field ar="سعر PRO" en="PRO price">
            <Money value={doc.pro_price_iqd} onChange={(v) => setDoc({ pro_price_iqd: v })} />
          </Field>
          <Field ar="أقصى كمية في الطلب" en="Max qty per order">
            <Qty value={config.max_qty_per_order} onChange={(v) => setConfig({ max_qty_per_order: v ?? 5 })} placeholder="5" />
          </Field>
        </Grid>
      </SectionCard>

      {/* 4 — the offer window */}
      <SectionCard
        n={4}
        ar="العرض والجدولة"
        en="Offer and schedule"
        open={openSection === 4}
        onToggle={() => setOpenSection(openSection === 4 ? 0 : 4)}
      >
        <Toggle
          checked={!!offer}
          onChange={(v) => setOffer(v ? {} : null)}
          label={loc('لهذه الحزمة نافذة عرض', 'this bundle has an offer window', 'ئەم پاکێجە پەنجەرەی ئۆفەری هەیە')}
          sub={loc('جدولة، عضوية، حدود', 'schedule, membership, limits', 'خشتە، ئەندامێتی، سنوور')}
        />
        {offer && (
          <>
            <div className="h-3" />
            <Grid cols={2}>
              <Field ar="يبدأ" en="Starts" hint={loc('بتوقيت بغداد', 'Baghdad time', 'کاتی بەغدا')}>
                <TextInput
                  type="datetime-local"
                  value={toLocalInput(offer.starts_at)}
                  onChange={(e) => setOffer({ starts_at: e.target.value || null })}
                />
              </Field>
              <Field ar="ينتهي" en="Ends" hint={loc('بتوقيت بغداد', 'Baghdad time', 'کاتی بەغدا')}>
                <TextInput
                  type="datetime-local"
                  value={toLocalInput(offer.ends_at)}
                  onChange={(e) => setOffer({ ends_at: e.target.value || null })}
                />
              </Field>
            </Grid>
            <div className="h-3" />
            <Field
              ar="العضويات المسموح لها"
              en="Allowed memberships"
              hint={loc(
                'اتركها فارغة ليراها الجميع. PRO يرث PLUS؛ PRIME لا.',
                'empty = public, guests included. PRO inherits PLUS; PRIME does not.',
                'بەتاڵ = گشتی. PRO لە PLUS وەردەگرێت؛ PRIME نا.'
              )}
              span
            >
              <div className="flex flex-wrap gap-2">
                {TIERS.map((t) => {
                  const on = offer.required_tiers.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      className={`${T.chip} ${on ? 'bg-iris/15 border-iris/50 text-white' : ''}`}
                      onClick={() =>
                        setOffer({
                          required_tiers: on ? offer.required_tiers.filter((x) => x !== t) : [...offer.required_tiers, t],
                        })
                      }
                    >
                      {t.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="h-3" />
            <Grid cols={3}>
              <Field ar="سعر العرض" en="Offer price mode">
                <Select
                  value={offer.offer_price_mode}
                  onChange={(e) => setOffer({ offer_price_mode: e.target.value as OfferInput['offer_price_mode'] })}
                >
                  <option value="">{loc('لا يغيّر السعر', 'changes no price', 'نرخ ناگۆڕێت')}</option>
                  <option value="fixed">{loc('سعر ثابت', 'Fixed', 'جێگیر')}</option>
                  <option value="discount_percent">{loc('نسبة', 'Percent', 'ڕێژە')}</option>
                  <option value="discount_iqd">{loc('مبلغ', 'Dinars', 'دینار')}</option>
                </Select>
              </Field>
              {offer.offer_price_mode === 'fixed' && (
                <Field ar="سعر العرض" en="Offer price">
                  <Money value={offer.offer_price_iqd} onChange={(v) => setOffer({ offer_price_iqd: v })} />
                </Field>
              )}
              {offer.offer_price_mode === 'discount_percent' && (
                <Field ar="نسبة الخصم %" en="Discount %" hint="1–90">
                  <Qty value={offer.discount_percent} onChange={(v) => setOffer({ discount_percent: v })} />
                </Field>
              )}
              {offer.offer_price_mode === 'discount_iqd' && (
                <Field ar="مبلغ الخصم" en="Discount (IQD)">
                  <Money value={offer.discount_iqd} onChange={(v) => setOffer({ discount_iqd: v })} />
                </Field>
              )}
              <Field ar="حد لكل عميل" en="Per-customer limit">
                <Qty value={offer.max_per_user} onChange={(v) => setOffer({ max_per_user: v })} />
              </Field>
              <Field ar="حد إجمالي" en="Global limit">
                <Qty value={offer.max_global} onChange={(v) => setOffer({ max_global: v })} />
              </Field>
              <Field ar="بطاقة مقفلة مزخرفة" en="Polished locked card">
                <Toggle
                  checked={offer.locked_preview}
                  onChange={(v) => setOffer({ locked_preview: v })}
                  label={loc('غير المشترك يرى البطاقة مقفلة', 'a non-member sees a locked card', 'ناوەندامان کارتی داخراو دەبینن')}
                />
              </Field>
              <Field ar="العرض فعّال" en="Offer active">
                <Toggle checked={offer.active} onChange={(v) => setOffer({ active: v })} label={loc('فعّال', 'active', 'چالاک')} />
              </Field>
            </Grid>
          </>
        )}
      </SectionCard>

      {/* 5 — the server's own preview */}
      <SectionCard
        n={5}
        ar="المعاينة من الخادم"
        en="Server preview"
        summary={loc('كل رقم هنا حسبه الخادم', 'every number here was computed by the server', 'هەموو ژمارەیەک لەلایەن سێرڤەرەوە ژمێردراوە')}
        open={openSection === 5}
        onToggle={() => setOpenSection(openSection === 5 ? 0 : 5)}
      >
        {!preview ? (
          <p className="text-[12.5px] text-[var(--ap-text-3)]">
            {loc('احفظ لرؤية المعاينة.', 'Save to see the preview.', 'پاشەکەوت بکە بۆ بینینی پێشبینین.')}
          </p>
        ) : (
          <div className="space-y-3 min-w-0">
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
              <Stat label={loc('قيمة المكوّنات', 'Parts value', 'نرخی پارچەکان')} value={formatIqd(preview.component_total_iqd)} />
              <Stat label={loc('سعر الحزمة', 'Bundle price', 'نرخی پاکێج')} value={formatIqd(preview.bundle_price_iqd)} />
              <Stat
                label={loc('التوفير', 'Saving', 'پاشەکەوت')}
                value={`${formatIqd(preview.discount_iqd)} · ${preview.saving_percent}%`}
              />
              <Stat
                label={loc('أقصى عدد حزم', 'Max bundles', 'زۆرترین پاکێج')}
                value={
                  preview.availability.max_bundles === null
                    ? loc('غير محدود', 'unbounded', 'بێ سنوور')
                    : String(preview.availability.max_bundles)
                }
              />
              <Stat label={loc('الحالة', 'State', 'دۆخ')} value={preview.availability.state} />
              <Stat label={loc('نوع الشحن', 'Shipping', 'گەیاندن')} value={preview.availability.shipping_type} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[12.5px]">
                <thead className={T.tableHead}>
                  <tr>
                    <th className="px-2 py-1.5 text-start">{loc('المكوّن', 'Component', 'پێکهاتە')}</th>
                    <th className="px-2 py-1.5 text-start">{loc('الكمية', 'Qty', 'بڕ')}</th>
                    <th className="px-2 py-1.5 text-start">{loc('سعر الوحدة', 'Unit', 'یەکە')}</th>
                    <th className="px-2 py-1.5 text-start">{loc('القيمة', 'Value', 'نرخ')}</th>
                    <th className="px-2 py-1.5 text-start">{loc('المتاح', 'Available', 'بەردەست')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.components.map((cp) => (
                    <tr key={cp.component_id || cp.member_product_id} className={T.tableRow}>
                      <td className="px-2 py-1.5">
                        {cp.name}
                        {cp.optional && (
                          <span className="ms-1.5 text-[10px] text-[var(--ap-text-3)]">{loc('اختياري', 'optional', 'ئارەزوومەندانە')}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">{cp.qty_per_bundle}</td>
                      <td className="px-2 py-1.5">{formatIqd(cp.unit_iqd)}</td>
                      <td className="px-2 py-1.5">{formatIqd(cp.line_value_iqd)}</td>
                      <td className="px-2 py-1.5">
                        {cp.available === null ? loc('غير متتبَّع', 'untracked', 'نەپشکنراو') : cp.available}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.availability.blocking.length > 0 && (
              <Banner kind="warn">
                <ul className="space-y-1">
                  {preview.availability.blocking.map((b, k) => (
                    <li key={k}>
                      {b.product_id} — {loc('المطلوب', 'needed', 'پێویست')} {b.needed}, {loc('المتاح', 'available', 'بەردەست')}{' '}
                      {b.available} — {whyBlocked(b.reason)}{' '}
                      <span className="text-[10px] text-[var(--ap-text-3)]" dir="ltr">
                        ({b.reason})
                      </span>
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
          </div>
        )}
      </SectionCard>

      <div className="flex items-center justify-end gap-2 pb-6">
        <button type="button" className={btnDanger} onClick={() => setEditing(null)}>
          {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
        </button>
        <button type="button" className={btnPrimary} disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
          {loc('حفظ', 'Save', 'پاشەکەوت')}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${T.surface} px-3 py-2 min-w-0`}>
      <p className="text-[11px] text-[var(--ap-text-3)] truncate">{label}</p>
      <p className="text-[13.5px] font-bold text-[var(--ap-text-1)] truncate">{value}</p>
    </div>
  );
}
