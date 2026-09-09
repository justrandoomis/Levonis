/**
 * مجموعات الفتيل العشوائي — mystery POOLS and their entries
 * (docs/BUNDLES_MYSTERY.md §11.1 tab 3, §10, plan slice 8).
 *
 * A pool is the set of real catalogue rows a mystery offer may draw from, with
 * a weight each. Three rules shape this screen, and all three are about not
 * lying to the owner about a randomised money mechanism:
 *
 *   NOTHING IS COMPUTED HERE. Availability, the computed probability per
 *   entry, the exclusion reason, the distinct-choice count and every warning
 *   come from `GET /pools/:id/eligible` — the SAME `eligibleStockPreview` the
 *   storefront's availability and the draw itself use. A probability this
 *   panel calculated could disagree with the wheel that actually spins.
 *
 *   THE ENTRIES LIST IS PAGINATED AND FILTERABLE, and rows are added with the
 *   SERVER-SIDE bulk generator. A filament pool is product × option values ×
 *   colour, so a realistic one is hundreds of rows; a `Repeater` over all of
 *   them is unusable and inventing the expansion in the browser would put a
 *   combination the catalogue does not have into the wheel.
 *
 *   THE WHOLE-SET SAVE SENDS `expected_updated_at`, AND A 409 IS SHOWN
 *   VERBATIM. Without it the second of two admins editing one pool silently
 *   destroys the first's work. Entries that leave the set are DEACTIVATED,
 *   never deleted (`POOL_ENTRY_DEACTIVATED`), because deleting one that has
 *   ever been drawn would violate `mystery_allocations.pool_entry_id` and lock
 *   the pool out of editing for ever.
 *
 * The two warnings the mandate quotes word for word — `POOL_ZERO_WEIGHT` and
 * `POOL_TOO_SMALL_FOR_FORBID` — are computed in `worker/lib/mystery/pools.ts`
 * and reach a human HERE, through the same `Banner kind="warn"` + `say(w)` path
 * the bundles panel uses. Before this screen existed they could not.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dice5, Loader2, Plus, RefreshCw, Search, Trash2, Wand2 } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Banner, Field, Grid, Qty, SectionCard, Select, TextInput, Toggle, btnGhost, btnPrimary } from '../adminProducts/form/formUi';
import ProductPicker from '../adminProducts/form/ProductPicker';

// ------------------------------------------------------------------- types

/** One admin-facing line, exactly as the server sends it (§11.3). `message` is
 *  load-bearing: an issue without one renders as the literal "undefined". */
export interface MysteryIssue {
  code: string;
  message: string;
  key?: string;
  ar: string;
  en: string;
  ckb: string;
  entry_id?: string;
}

interface PoolRow {
  id: string;
  name: string;
  kind: 'direct' | 'preorder';
  active: boolean;
  require_catalog_ids: string[];
  require_facet_ids: string[];
  min_available: number;
  updated_at: string;
  entry_count?: number;
  active_entry_count?: number;
}

interface EntryRow {
  id: string;
  product_id: string;
  product_name: string;
  product_status: string;
  option_value_ids: string[];
  color_id: string;
  family_id: string;
  weight: number;
  active: boolean;
}

interface EligibleEntry {
  entry_id: string;
  product_id: string;
  name: string;
  variant: string;
  weight: number;
  available: number | null;
  probability: number;
}

interface Preview {
  pool_id: string;
  kind: string;
  eligible: EligibleEntry[];
  excluded: Array<{ entry_id: string; product_id: string; reason: string }>;
  distinct_choices: number;
  total_available: number | null;
  warnings: MysteryIssue[];
}

// ----------------------------------------------------------------- helpers

function issuesOf(e: unknown): MysteryIssue[] {
  if (e instanceof ApiError) {
    const raw = (e.details?.errors ?? []) as unknown[];
    const list = raw.filter((x): x is MysteryIssue => !!x && typeof x === 'object' && 'code' in (x as object));
    if (list.length) return list;
    return [{ code: e.code ?? 'ERROR', message: e.message, ar: e.message, en: e.message, ckb: e.message }];
  }
  const message = e instanceof Error ? e.message : String(e);
  return [{ code: 'ERROR', message, ar: message, en: message, ckb: message }];
}

const blankPool = (): PoolRow => ({
  id: '',
  name: '',
  kind: 'direct',
  active: true,
  require_catalog_ids: [],
  require_facet_ids: [],
  min_available: 1,
  updated_at: '',
});

export default function AdminMysteryPools() {
  const { lang, dir } = useLanguage();
  const loc = useCallback(
    (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar),
    [lang]
  );
  const say = useCallback((i: MysteryIssue) => (lang === 'en' ? i.en : lang === 'ckb' ? i.ckb : i.ar), [lang]);

  const [pools, setPools] = useState<PoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [issues, setIssues] = useState<MysteryIssue[]>([]);
  const [warnings, setWarnings] = useState<MysteryIssue[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const [staleNote, setStaleNote] = useState<string | null>(null);

  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await api.get<{ pools: PoolRow[] }>('/api/admin/mystery/pools');
      if (mine !== seq.current) return;
      setPools(res.pools ?? []);
    } catch (e) {
      if (mine === seq.current) setIssues(issuesOf(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ------------------------------------------------------------ editor state
  const [editing, setEditing] = useState<PoolRow | null>(null);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [entrySearch, setEntrySearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [genProduct, setGenProduct] = useState('');
  const [genWeight, setGenWeight] = useState(1);
  const [genFamily, setGenFamily] = useState('');
  /** The preview is a WHAT-IF, so the spool count and the duplicate policy it
   *  is computed under are the owner's to change without touching an offer. */
  const [previewSpools, setPreviewSpools] = useState(1);
  const [previewPolicy, setPreviewPolicy] = useState<'allow' | 'discourage' | 'forbid'>('allow');
  const [section, setSection] = useState(1);

  const PAGE = 50;

  const loadEntries = useCallback(
    async (poolId: string, toPage = 1) => {
      const q = new URLSearchParams({ page: String(toPage), limit: String(PAGE) });
      if (entrySearch.trim()) q.set('search', entrySearch.trim());
      if (activeFilter) q.set('active', activeFilter);
      const res = await api.get<{ entries: EntryRow[]; total: number; page: number }>(
        `/api/admin/mystery/pools/${poolId}/entries?${q}`
      );
      setEntries(res.entries ?? []);
      setTotal(res.total ?? 0);
      setPage(res.page ?? toPage);
    },
    [entrySearch, activeFilter]
  );

  const loadPreview = useCallback(
    async (poolId: string) => {
      const q = new URLSearchParams({ spools: String(previewSpools), duplicate_policy: previewPolicy });
      const res = await api.get<Preview & { warning_details?: MysteryIssue[] }>(
        `/api/admin/mystery/pools/${poolId}/eligible?${q}`
      );
      setPreview(res);
      setWarnings(res.warning_details ?? res.warnings ?? []);
    },
    [previewSpools, previewPolicy]
  );

  const openPool = async (id: string) => {
    setIssues([]);
    setOk(null);
    setStaleNote(null);
    try {
      const res = await api.get<{ pool: PoolRow }>(`/api/admin/mystery/pools/${id}`);
      setEditing(res.pool);
      await loadEntries(id, 1);
      await loadPreview(id);
    } catch (e) {
      setIssues(issuesOf(e));
    }
  };

  // Re-read whenever the filter, the page size inputs or the what-if change.
  useEffect(() => {
    if (!editing?.id) return;
    void loadEntries(editing.id, 1).catch((e) => setIssues(issuesOf(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entrySearch, activeFilter, editing?.id]);
  useEffect(() => {
    if (!editing?.id) return;
    void loadPreview(editing.id).catch((e) => setIssues(issuesOf(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSpools, previewPolicy, editing?.id]);

  const savePool = async () => {
    if (!editing) return;
    setSaving(true);
    setIssues([]);
    setOk(null);
    try {
      const body = {
        name: editing.name,
        kind: editing.kind,
        active: editing.active,
        require_catalog_ids: editing.require_catalog_ids,
        require_facet_ids: editing.require_facet_ids,
        min_available: editing.min_available,
      };
      const res = editing.id
        ? await api.put<{ pool: PoolRow }>(`/api/admin/mystery/pools/${editing.id}`, body)
        : await api.post<{ pool: PoolRow }>('/api/admin/mystery/pools', body);
      setEditing(res.pool);
      setOk(loc('حُفظت المجموعة', 'Pool saved', 'کۆمەڵەکە پاشەکەوت کرا'));
      await reload();
      if (res.pool?.id) {
        await loadEntries(res.pool.id, 1);
        await loadPreview(res.pool.id);
      }
    } catch (e) {
      setIssues(issuesOf(e));
    } finally {
      setSaving(false);
    }
  };

  /** The SERVER expands the chosen products into one entry per real stock row.
   *  Nothing is invented in the browser (§10). */
  const generate = async () => {
    if (!editing?.id || !genProduct) return;
    setSaving(true);
    setIssues([]);
    setOk(null);
    try {
      const res = await api.post<{ generated: number; inserted: number; warning_details?: MysteryIssue[] }>(
        `/api/admin/mystery/pools/${editing.id}/entries/generate`,
        { product_ids: [genProduct], weight: genWeight, family_id: genFamily }
      );
      setWarnings(res.warning_details ?? []);
      setOk(
        loc(
          `أُضيفت ${res.inserted} من ${res.generated} صفًا`,
          `${res.inserted} of ${res.generated} rows added`,
          `${res.inserted} لە ${res.generated} ڕیز زیادکرا`
        )
      );
      setGenProduct('');
      await openPool(editing.id);
    } catch (e) {
      setIssues(issuesOf(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * THE WHOLE-SET SAVE. `expected_updated_at` is required by the route, and a
   * 409 `STALE_EDIT` is shown VERBATIM with the current timestamp rather than
   * overwriting the other admin's work.
   *
   * Only the rows on this PAGE were edited, so the full set is sent as
   * "everything the server currently holds, with this page's edits applied" —
   * the route deactivates what leaves the set, so sending a partial page would
   * silently deactivate every row the owner never looked at.
   */
  const saveEntries = async () => {
    if (!editing?.id) return;
    setSaving(true);
    setIssues([]);
    setOk(null);
    setStaleNote(null);
    try {
      const all: EntryRow[] = [];
      for (let p = 1; ; p += 1) {
        const res = await api.get<{ entries: EntryRow[]; total: number }>(
          `/api/admin/mystery/pools/${editing.id}/entries?page=${p}&limit=200`
        );
        all.push(...(res.entries ?? []));
        if (all.length >= (res.total ?? 0) || (res.entries ?? []).length === 0) break;
      }
      const edited = new Map(entries.map((e) => [e.id, e]));
      const merged = all.map((e) => edited.get(e.id) ?? e);
      const res = await api.put<{
        deactivated: number;
        updated_at: string;
        warning_details?: MysteryIssue[];
      }>(`/api/admin/mystery/pools/${editing.id}/entries`, {
        expected_updated_at: editing.updated_at,
        entries: merged.map((e) => ({
          id: e.id,
          product_id: e.product_id,
          option_value_ids: e.option_value_ids,
          color_id: e.color_id,
          family_id: e.family_id,
          weight: e.weight,
          active: e.active,
        })),
      });
      setEditing((prev) => (prev ? { ...prev, updated_at: res.updated_at } : prev));
      setWarnings(res.warning_details ?? []);
      setOk(loc('حُفظت المدخلات', 'Entries saved', 'تۆمارەکان پاشەکەوت کران'));
      await loadEntries(editing.id, page);
      await loadPreview(editing.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_EDIT') {
        // Shown VERBATIM, with the server's own `current`, so the owner sees
        // exactly what the server saw rather than a generic failure.
        const current = String((e.details as { current?: unknown } | undefined)?.current ?? '');
        setStaleNote(`${e.message}${current ? ` — ${current}` : ''}`);
      } else {
        setIssues(issuesOf(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const excludedById = useMemo(
    () => new Map((preview?.excluded ?? []).map((x) => [x.entry_id, x.reason])),
    [preview]
  );
  const probabilityById = useMemo(
    () => new Map((preview?.eligible ?? []).map((x) => [x.entry_id, x])),
    [preview]
  );

  // ==================================================================== list

  if (!editing) {
    return (
      <div className={`${T.AP} space-y-4`} dir={dir} data-panel="mystery_pools">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold leading-tight flex items-center gap-2 text-[var(--ap-text-1)]">
              <Dice5 className="w-5 h-5 text-[var(--ap-accent,#6B46FF)]" aria-hidden />
              {loc('مجموعات السحب', 'Mystery pools', 'کۆمەڵەکانی هەڵبژاردن')}
            </h1>
            <p className="mt-1 text-[12.5px] text-[var(--ap-text-3)] max-w-[70ch]">
              {loc(
                'المجموعة هي صفوف المخزون الحقيقية التي يسحب منها العرض العشوائي، ولكل صف وزن. التوفّر والاحتمالات وأسباب الاستبعاد يحسبها الخادم بنفس الدالة التي يسحب بها.',
                'A pool is the real stock rows a mystery offer draws from, each with a weight. Availability, probabilities and exclusion reasons are computed by the server with the same function the draw uses.',
                'کۆمەڵە ئەو ڕیزە ڕاستەقینانەی کۆگایە کە ئۆفەری نهێنی لێی هەڵدەبژێرێت، هەریەکە بە کێشێکەوە. بەردەستی و ئەگەرەکان لەلایەن سێرڤەرەوە دەژمێردرێن.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={T.btnIconLg} onClick={() => void reload()} aria-label={loc('تحديث', 'Refresh', 'نوێکردنەوە')}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
            <button type="button" className={btnPrimary} onClick={() => setEditing(blankPool())} data-mystery-pool-new>
              <Plus className="w-4 h-4" aria-hidden /> {loc('مجموعة جديدة', 'New pool', 'کۆمەڵەی نوێ')}
            </button>
          </div>
        </header>

        {issues.length > 0 && (
          <Banner kind="error">
            <ul className="space-y-0.5">
              {issues.map((i, k) => (
                <li key={k}>• {say(i)}</li>
              ))}
            </ul>
          </Banner>
        )}
        {ok && <Banner kind="ok">{ok}</Banner>}

        {loading ? (
          <p className="text-[13px] text-[var(--ap-text-3)] flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> {loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}
          </p>
        ) : pools.length === 0 ? (
          <p className="text-[13px] text-[var(--ap-text-3)]">
            {loc('لا توجد مجموعات بعد.', 'No pools yet.', 'هێشتا هیچ کۆمەڵەیەک نییە.')}
          </p>
        ) : (
          <div className="space-y-2">
            {pools.map((p) => (
              <article key={p.id} className={T.surface}>
                <div className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-[var(--ap-text-1)] truncate">{p.name}</p>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--ap-text-3)]">
                      <span>{p.kind === 'preorder' ? loc('طلب مسبق', 'Pre-order', 'پێش-داواکاری') : loc('مباشر', 'Direct', 'ڕاستەوخۆ')}</span>
                      <span>
                        {loc('المدخلات', 'Entries', 'تۆمارەکان')}: {p.entry_count ?? 0}
                      </span>
                      <span>
                        {loc('قابلة للسحب', 'Drawable', 'شیاوی هەڵبژاردن')}: {p.active_entry_count ?? 0}
                      </span>
                      {!p.active && <span className="text-amber-300">{loc('موقوفة', 'Inactive', 'ناچالاک')}</span>}
                    </p>
                  </div>
                  <button type="button" className={btnGhost} onClick={() => void openPool(p.id)}>
                    {loc('تحرير', 'Edit', 'دەستکاری')}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ================================================================== editor

  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="mystery_pools">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={btnGhost} onClick={() => setEditing(null)}>
          {loc('رجوع', 'Back', 'گەڕانەوە')}
        </button>
        <div className="flex items-center gap-2">
          <button type="button" className={btnPrimary} onClick={() => void savePool()} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
            {loc('حفظ المجموعة', 'Save pool', 'پاشەکەوتی کۆمەڵە')}
          </button>
        </div>
      </header>

      {issues.length > 0 && (
        <Banner kind="error">
          <ul className="space-y-0.5">
            {issues.map((i, k) => (
              <li key={k}>• {say(i)}</li>
            ))}
          </ul>
        </Banner>
      )}
      {/* The 409 body, VERBATIM (§10, §11.1). */}
      {staleNote && <Banner kind="error">{staleNote}</Banner>}
      {ok && <Banner kind="ok">{ok}</Banner>}
      {/* The two warnings the mandate quotes word for word arrive here:
          POOL_ZERO_WEIGHT and POOL_TOO_SMALL_FOR_FORBID. They are kept on the
          screen after a successful save (§11.3). */}
      {warnings.length > 0 && (
        <Banner kind="warn">
          <ul className="space-y-0.5">
            {warnings.map((w, k) => (
              <li key={k}>• {say(w)}</li>
            ))}
          </ul>
        </Banner>
      )}

      <SectionCard n={1} ar="المجموعة" en="The pool" open={section === 1} onToggle={() => setSection(section === 1 ? 0 : 1)}>
        <Grid cols={2}>
          <Field ar="الاسم" en="Name">
            <TextInput value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field
            ar="النوع"
            en="Kind"
            hint={loc(
              'مجموعتان منفصلتان: شراء مباشر يحجز مخزونًا حقيقيًا، وطلب مسبق لا يختبر المخزون. لا تُخلطان أبدًا.',
              'Two separate pools: a direct sale reserves real stock, a pre-order does not test stock. They are never mixed.',
              'دوو کۆمەڵەی جیاواز: کڕینی ڕاستەوخۆ کۆگای ڕاستەقینە دەگرێت، پێش-داواکاری کۆگا تاقی ناکاتەوە.'
            )}
          >
            <Select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as PoolRow['kind'] })}>
              <option value="direct">{loc('مباشر', 'Direct', 'ڕاستەوخۆ')}</option>
              <option value="preorder">{loc('طلب مسبق', 'Pre-order', 'پێش-داواکاری')}</option>
            </Select>
          </Field>
          <Field
            ar="أدنى مخزون للمرشّح"
            en="Minimum available per entry"
            hint={loc(
              'الصف الذي يقلّ متاحه عن هذا الرقم لا يدخل العجلة إطلاقًا.',
              'A row whose free stock is below this never enters the wheel at all.',
              'ئەو ڕیزەی کۆگای بەردەستی لەم ژمارەیە کەمترە هەرگیز ناچێتە ناو چەرخەکە.'
            )}
          >
            <Qty value={editing.min_available} onChange={(v) => setEditing({ ...editing, min_available: Math.max(0, v ?? 0) })} placeholder="1" />
          </Field>
          <Field ar="مفعّلة" en="Active">
            <Toggle checked={editing.active} onChange={(v) => setEditing({ ...editing, active: v })} label={loc('مفعّلة', 'Active', 'چالاک')} />
          </Field>
        </Grid>
      </SectionCard>

      {editing.id && (
        <>
          <SectionCard n={2} ar="توليد المدخلات" en="Generate entries" open={section === 2} onToggle={() => setSection(section === 2 ? 0 : 2)}>
            <p className="text-[12px] text-[var(--ap-text-3)] mb-2">
              {loc(
                'اختر منتجًا ووزنًا: الخادم يوسّع خياراته وألوانه الفعّالة إلى صف لكل مخزون حقيقي. لا شيء يُخترع في المتصفح، والتوليد إضافي لا يحذف شيئًا.',
                'Choose a product and a weight: the SERVER expands its active options and colours into one entry per real stock row. Nothing is invented in the browser, and the generator is additive — it removes nothing.',
                'بەرهەمێک و کێشێک هەڵبژێرە: سێرڤەرەکە هەڵبژاردە و ڕەنگە چالاکەکانی دەکاتەوە بە تۆمارێک بۆ هەر ڕیزێکی کۆگای ڕاستەقینە.'
              )}
            </p>
            <Grid cols={3}>
              <Field ar="المنتج" en="Product">
                <ProductPicker value={genProduct} onChange={(id) => setGenProduct(id)} />
              </Field>
              <Field ar="الوزن" en="Weight">
                <Qty value={genWeight} onChange={(v) => setGenWeight(Math.max(0, v ?? 0))} placeholder="1" />
              </Field>
              <Field
                ar="العائلة"
                en="Family"
                hint={loc('معرّف تصنيف أو خاصية — لا اسم منتج أبدًا.', 'A catalog or facet id — never a product name.', 'ناسنامەی پۆلێن یان تایبەتمەندی — هەرگیز ناوی بەرهەم نا.')}
              >
                <TextInput value={genFamily} onChange={(e) => setGenFamily(e.target.value)} placeholder="cat_… / fct_…" />
              </Field>
            </Grid>
            <button type="button" className={`${btnPrimary} mt-3`} onClick={() => void generate()} disabled={!genProduct || saving}>
              <Wand2 className="w-4 h-4" aria-hidden /> {loc('توليد', 'Generate', 'دروستکردن')}
            </button>
          </SectionCard>

          <SectionCard
            n={3}
            ar="المدخلات"
            en="Entries"
            count={total}
            open={section === 3}
            onToggle={() => setSection(section === 3 ? 0 : 3)}
          >
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="relative min-w-0 flex-1 max-w-sm">
                <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-[var(--ap-text-3)]" aria-hidden />
                <input
                  className={`${T.input} ps-8`}
                  value={entrySearch}
                  onChange={(e) => setEntrySearch(e.target.value)}
                  placeholder={loc('بحث بالاسم', 'Search by name', 'گەڕان بە ناو')}
                  aria-label={loc('بحث في المدخلات', 'Search entries', 'گەڕان لە تۆمارەکان')}
                />
              </div>
              <Select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)} aria-label={loc('الحالة', 'State', 'دۆخ')}>
                <option value="">{loc('الكل', 'All', 'هەموو')}</option>
                <option value="1">{loc('مفعّلة', 'Active', 'چالاک')}</option>
                <option value="0">{loc('موقوفة', 'Inactive', 'ناچالاک')}</option>
              </Select>
              <button type="button" className={btnPrimary} onClick={() => void saveEntries()} disabled={saving}>
                {loc('حفظ المدخلات', 'Save entries', 'پاشەکەوتی تۆمارەکان')}
              </button>
            </div>

            <div className="space-y-1.5">
              {entries.map((e, i) => {
                const el = probabilityById.get(e.id);
                const excluded = excludedById.get(e.id);
                return (
                  <div key={e.id} className="rounded-lg border border-[var(--ap-border)] p-2 flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ap-text-1)]" dir="ltr">
                      {e.product_name}
                      {e.color_id ? <span className="text-[var(--ap-text-3)]"> · {e.color_id}</span> : null}
                    </span>
                    <label className="flex items-center gap-1.5 text-[12px] text-[var(--ap-text-3)]">
                      {loc('الوزن', 'Weight', 'کێش')}
                      <input
                        type="number"
                        className={`${T.input} w-20`}
                        min={0}
                        max={1000}
                        value={e.weight}
                        onChange={(ev) =>
                          setEntries((prev) => {
                            const next = [...prev];
                            next[i] = { ...next[i], weight: Math.max(0, Math.trunc(Number(ev.target.value) || 0)) };
                            return next;
                          })
                        }
                        aria-label={`${loc('الوزن', 'Weight', 'کێش')} — ${e.product_name}`}
                      />
                    </label>
                    <Toggle
                      checked={e.active}
                      onChange={(v) =>
                        setEntries((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], active: v };
                          return next;
                        })
                      }
                      label={loc('مفعّل', 'Active', 'چالاک')}
                    />
                    {/* The SERVER's numbers: the computed probability and the
                        live availability, never a browser calculation. */}
                    <span className="text-[11.5px] text-[var(--ap-text-3)] tabular-nums">
                      {el
                        ? `${Math.round(el.probability * 1000) / 10}% · ${el.available === null ? '—' : el.available}`
                        : excluded
                          ? loc('مستبعد', 'Excluded', 'دەرکراو') + `: ${excluded}`
                          : '—'}
                    </span>
                  </div>
                );
              })}
              {entries.length === 0 && (
                <p className="text-[12.5px] text-[var(--ap-text-3)]">
                  {loc('لا مدخلات في هذه الصفحة.', 'No entries on this page.', 'هیچ تۆمارێک لەم لاپەڕەیەدا نییە.')}
                </p>
              )}
            </div>

            {pages > 1 && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className={btnGhost}
                  disabled={page <= 1}
                  onClick={() => void loadEntries(editing.id, page - 1)}
                >
                  {loc('السابق', 'Previous', 'پێشوو')}
                </button>
                <span className="text-[12px] text-[var(--ap-text-3)] tabular-nums">
                  {page} / {pages}
                </span>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={page >= pages}
                  onClick={() => void loadEntries(editing.id, page + 1)}
                >
                  {loc('التالي', 'Next', 'دواتر')}
                </button>
              </div>
            )}
          </SectionCard>

          <SectionCard n={4} ar="معاينة المخزون المؤهَّل" en="Eligible stock preview" open={section === 4} onToggle={() => setSection(section === 4 ? 0 : 4)}>
            <Grid cols={2}>
              <Field ar="عدد القطع (افتراض)" en="Spools (what-if)">
                <Qty value={previewSpools} onChange={(v) => setPreviewSpools(Math.min(20, Math.max(1, v ?? 1)))} placeholder="1" />
              </Field>
              <Field ar="سياسة التكرار (افتراض)" en="Duplicate policy (what-if)">
                <Select
                  value={previewPolicy}
                  onChange={(e) => setPreviewPolicy(e.target.value as 'allow' | 'discourage' | 'forbid')}
                >
                  <option value="allow">{loc('مسموح', 'Allow', 'ڕێپێدراو')}</option>
                  <option value="discourage">{loc('مثبَّط', 'Discourage', 'کەمکراوە')}</option>
                  <option value="forbid">{loc('ممنوع', 'Forbid', 'قەدەغە')}</option>
                </Select>
              </Field>
            </Grid>
            {preview && (
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-[var(--ap-text-3)]">
                <span>
                  {loc('خيارات مميّزة', 'Distinct choices', 'هەڵبژاردەی جیاواز')}:{' '}
                  <span className="tabular-nums text-[var(--ap-text-1)]">{preview.distinct_choices}</span>
                </span>
                <span>
                  {loc('إجمالي المتاح', 'Total available', 'کۆی بەردەست')}:{' '}
                  <span className="tabular-nums text-[var(--ap-text-1)]">
                    {preview.total_available === null ? '—' : preview.total_available}
                  </span>
                </span>
                <span>
                  {loc('مستبعدة', 'Excluded', 'دەرکراو')}:{' '}
                  <span className="tabular-nums text-[var(--ap-text-1)]">{preview.excluded.length}</span>
                </span>
              </p>
            )}
            {preview && preview.excluded.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11.5px] text-[var(--ap-text-3)]">
                {preview.excluded.slice(0, 20).map((x) => (
                  <li key={x.entry_id}>
                    • {x.product_id} — {x.reason}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <button
            type="button"
            className={T.btnIconDanger}
            onClick={() => {
              if (!window.confirm(loc('تعطيل هذه المجموعة؟', 'Deactivate this pool?', 'ئەم کۆمەڵەیە ناچالاک بکرێت؟'))) return;
              void api
                .delete(`/api/admin/mystery/pools/${editing.id}`)
                .then(() => {
                  setEditing(null);
                  return reload();
                })
                .catch((e) => setIssues(issuesOf(e)));
            }}
            aria-label={loc('تعطيل', 'Deactivate', 'ناچالاککردن')}
          >
            <Trash2 className="w-4 h-4" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
