/**
 * عروض الفتيل العشوائي — the MYSTERY OFFER editor
 * (docs/BUNDLES_MYSTERY.md §11.1 tab 2, §7, §8, §10; plan slice 8).
 *
 * A mystery offer is a real `products` row carrying `composition = 'mystery'`:
 * it inherits its ar/en/ckb title, slug, cover, status, display order and
 * price ladder from the product model, and everything that makes it a lottery
 * — the pools, the spool count, the duplicate policy, the reveal milestone,
 * family narrowing and odds disclosure — lives on `mystery_offers` and
 * `bundle_config`. This is the only screen that can create one:
 * `worker/routes/adminBundles.ts` pins `kind` to `'bundle'` on create, so the
 * bundles panel cannot.
 *
 * FOUR RULES, all of them about a randomised money mechanism being honest:
 *
 *   NOTHING IS COMPUTED HERE. The eligible-stock preview, the per-entry
 *   probability, the distinct-choice count and every warning come from the
 *   server, from `eligibleStockPreview` — the same function the draw and the
 *   storefront availability use.
 *
 *   NOTHING IS SILENTLY REPAIRED. `MYSTERY_NO_MODE_ENABLED`,
 *   `MYSTERY_POOL_KIND_MISMATCH`, `POOL_ZERO_WEIGHT` and
 *   `POOL_TOO_SMALL_FOR_FORBID` are rendered verbatim in the admin's own
 *   language, and a refusal is a refusal.
 *
 *   THE SECRET IS NEVER SHOWN. The offer's draw secret lives in its own table
 *   that exactly one server module reads and no read route joins — a rule
 *   `tests/compositionSchema.test.ts` enforces by name, which is why this file
 *   does not spell that table. This screen can only ROTATE the secret, and
 *   rotating says plainly that every FUTURE draw changes while past ones do
 *   not.
 *
 *   THE REVEAL MILESTONE IS SNAPSHOTTED PER ORDER (§8.1), so editing it here
 *   changes what FUTURE orders are sold under and moves no existing order's
 *   milestone in either direction. The screen says so, because an owner who
 *   believed otherwise would use this control to hide a pick a customer has
 *   already been shown.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Dice5, KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react';
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
  SectionCard,
  Select,
  TextArea,
  TextInput,
  Toggle,
  btnGhost,
  btnPrimary,
} from '../adminProducts/form/formUi';
import { TriText } from '../adminProducts/ui';
import type { MysteryIssue } from './AdminMysteryPools';

// ------------------------------------------------------------------- types

interface OfferCard {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ku: string;
  status: string;
  price_iqd: number;
  spool_qty: number;
  direct_pool_id: string | null;
  preorder_pool_id: string | null;
  allow_direct: boolean;
  allow_preorder: boolean;
  customer_picks_family: boolean;
  duplicate_policy: string;
  reveal_stage: string;
  show_odds: boolean;
  max_qty_per_order: number;
}

interface MysteryConfig {
  direct_pool_id: string | null;
  preorder_pool_id: string | null;
  spool_qty: number;
  allow_direct: boolean;
  allow_preorder: boolean;
  customer_picks_family: boolean;
  duplicate_policy: 'allow' | 'discourage' | 'forbid';
  reveal_stage: 'paid' | 'confirmed' | 'preparing' | 'shipped' | 'delivered';
  show_odds: boolean;
  max_qty_per_order: number;
}

interface OfferWindowInput {
  starts_at: string | null;
  ends_at: string | null;
  required_tiers: string[];
  locked_preview: boolean;
  active: boolean;
  max_per_user: number | null;
  max_global: number | null;
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
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  display_order: number;
  is_featured: boolean;
  images: string[];
  updated_at: string;
}

interface PoolOption {
  id: string;
  name: string;
  kind: 'direct' | 'preorder';
  active_entry_count?: number;
}

interface Preview {
  distinct_choices: number;
  total_available: number | null;
  eligible: Array<{ entry_id: string; name: string; variant: string; weight: number; available: number | null; probability: number }>;
  excluded: Array<{ entry_id: string; product_id: string; reason: string }>;
}

// ----------------------------------------------------------------- helpers

const TIERS = ['plus', 'prime', 'pro'] as const;
const REVEAL_STAGES = ['paid', 'confirmed', 'preparing', 'shipped', 'delivered'] as const;

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

/** An ISO instant as a `datetime-local` value in Baghdad time (UTC+3), the
 *  zone the store runs in; the server normalises back to explicit UTC. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 3 * 3600_000).toISOString().slice(0, 16);
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const ms = Date.parse(`${v}:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 3 * 3600_000).toISOString();
}

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
  prime_price_iqd: null,
  pro_price_iqd: null,
  display_order: 0,
  is_featured: false,
  images: [],
  updated_at: '',
});

const blankConfig = (): MysteryConfig => ({
  direct_pool_id: null,
  preorder_pool_id: null,
  spool_qty: 1,
  allow_direct: true,
  allow_preorder: false,
  customer_picks_family: false,
  duplicate_policy: 'allow',
  // §17 decision 10: 'paid' is the milestone that is honestly deliverable
  // whatever the owner decides about coarse public counts, so it is the safe
  // default a new offer starts on rather than the most generous one.
  reveal_stage: 'delivered',
  show_odds: false,
  max_qty_per_order: 5,
});

export default function AdminMystery() {
  const { lang, dir } = useLanguage();
  const loc = useCallback(
    (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar),
    [lang]
  );
  const say = useCallback((i: MysteryIssue) => (lang === 'en' ? i.en : lang === 'ckb' ? i.ckb : i.ar), [lang]);

  const [rows, setRows] = useState<OfferCard[]>([]);
  const [pools, setPools] = useState<PoolOption[]>([]);
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
      const [offers, poolRes] = await Promise.all([
        api.get<{ offers: OfferCard[] }>('/api/admin/mystery/offers'),
        api.get<{ pools: PoolOption[] }>('/api/admin/mystery/pools'),
      ]);
      if (mine !== seq.current) return;
      setRows(offers.offers ?? []);
      setPools(poolRes.pools ?? []);
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
  const [editing, setEditing] = useState<null | { doc: EditorDoc; config: MysteryConfig; offer: OfferWindowInput | null }>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState(1);

  const openNew = () => {
    setEditing({ doc: blankDoc(), config: blankConfig(), offer: null });
    setPreviews({});
    setIssues([]);
    setWarnings([]);
    setStaleNote(null);
    setSection(1);
  };

  const openExisting = async (id: string) => {
    setIssues([]);
    setOk(null);
    setStaleNote(null);
    try {
      const res = await api.get<{
        product: Record<string, unknown>;
        updated_at: string;
        mystery: Record<string, unknown>;
        offer: OfferWindowInput | null;
        previews: Record<string, Preview>;
        warning_details?: MysteryIssue[];
      }>(`/api/admin/mystery/offers/${id}`);
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
          prime_price_iqd: p.prime_price_iqd === null || p.prime_price_iqd === undefined ? null : Number(p.prime_price_iqd),
          pro_price_iqd: p.pro_price_iqd === null || p.pro_price_iqd === undefined ? null : Number(p.pro_price_iqd),
          display_order: Number(p.display_order ?? 0),
          is_featured: !!p.is_featured,
          images: (Array.isArray(p.media) ? (p.media as Array<{ url?: string }>) : [])
            .map((m) => String(m.url ?? ''))
            .filter(Boolean),
          updated_at: res.updated_at ?? '',
        },
        config: {
          direct_pool_id: (res.mystery.direct_pool_id as string | null) ?? null,
          preorder_pool_id: (res.mystery.preorder_pool_id as string | null) ?? null,
          spool_qty: Number(res.mystery.spool_qty ?? 1),
          allow_direct: !!res.mystery.allow_direct,
          allow_preorder: !!res.mystery.allow_preorder,
          customer_picks_family: !!res.mystery.customer_picks_family,
          duplicate_policy: (res.mystery.duplicate_policy as MysteryConfig['duplicate_policy']) || 'allow',
          reveal_stage: (res.mystery.reveal_stage as MysteryConfig['reveal_stage']) || 'delivered',
          show_odds: !!res.mystery.show_odds,
          max_qty_per_order: Number(res.mystery.max_qty_per_order ?? 5),
        },
        offer: res.offer,
      });
      setPreviews(res.previews ?? {});
      setWarnings(res.warning_details ?? []);
      setSection(1);
    } catch (e) {
      setIssues(issuesOf(e));
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setIssues([]);
    setOk(null);
    setStaleNote(null);
    try {
      const body = {
        ...editing.doc,
        images: editing.doc.images.map((url) => ({ url })),
        media: editing.doc.images.map((url, i) => ({ id: `img_${i}`, url, primary: i === 0 })),
        ...editing.config,
        offer: editing.offer,
        ...(editing.doc.id ? { expected_updated_at: editing.doc.updated_at } : {}),
      };
      const res = editing.doc.id
        ? await api.put<{ product: Record<string, unknown>; warning_details?: MysteryIssue[] }>(
            `/api/admin/mystery/offers/${editing.doc.id}`,
            body
          )
        : await api.post<{ product: Record<string, unknown>; warning_details?: MysteryIssue[] }>('/api/admin/mystery/offers', body);
      // Warnings STAY on the screen after the green line (§11.3).
      setWarnings(res.warning_details ?? []);
      setOk(loc('حُفظ العرض', 'Offer saved', 'ئۆفەرەکە پاشەکەوت کرا'));
      await reload();
      const id = String((res.product as { id?: unknown }).id ?? '');
      if (id) await openExisting(id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_EDIT') {
        const current = String((e.details as { current?: unknown } | undefined)?.current ?? '');
        setStaleNote(`${e.message}${current ? ` — ${current}` : ''}`);
      } else {
        setIssues(issuesOf(e));
      }
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

  const poolsOfKind = (kind: 'direct' | 'preorder') => pools.filter((p) => p.kind === kind);

  // ==================================================================== list

  if (!editing) {
    return (
      <div className={`${T.AP} space-y-4`} dir={dir} data-panel="mystery">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold leading-tight flex items-center gap-2 text-[var(--ap-text-1)]">
              <Dice5 className="w-5 h-5 text-[var(--ap-accent,#6B46FF)]" aria-hidden />
              {loc('العروض العشوائية', 'Mystery offers', 'ئۆفەرە نهێنییەکان')}
            </h1>
            <p className="mt-1 text-[12.5px] text-[var(--ap-text-3)] max-w-[70ch]">
              {loc(
                'العرض العشوائي منتج حقيقي محتواه يُسحب في الخادم من مجموعة أوزان. لا مخزون له: التوفّر يُحسب من المخزون المؤهَّل في المجموعة، والسحب والبذرة والسرّ كلها في الخادم ولا تصل المتصفح أبدًا.',
                'A mystery offer is a real product whose contents are drawn ON THE SERVER from a weighted pool. It has no stock of its own: availability comes from the pool’s eligible stock, and the draw, the seed and the secret never reach a browser.',
                'ئۆفەری نهێنی بەرهەمێکی ڕاستەقینەیە کە ناوەڕۆکی لە سێرڤەردا لە کۆمەڵەیەکی کێشدار هەڵدەبژێردرێت.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={T.btnIconLg} onClick={() => void reload()} aria-label={loc('تحديث', 'Refresh', 'نوێکردنەوە')}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
            <button type="button" className={btnPrimary} onClick={openNew} data-mystery-new>
              <Plus className="w-4 h-4" aria-hidden /> {loc('عرض جديد', 'New offer', 'ئۆفەری نوێ')}
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
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-[var(--ap-text-3)]">
            {loc('لا عروض عشوائية بعد.', 'No mystery offers yet.', 'هێشتا هیچ ئۆفەرێکی نهێنی نییە.')}
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((o) => (
              <article key={o.id} className={T.surface}>
                <div className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-[var(--ap-text-1)] truncate" dir="ltr">
                      {o.name}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--ap-text-3)]">
                      <span className={T.badge[o.status === 'active' ? 'active' : 'draft']}>{o.status}</span>
                      <span>
                        {loc('السعر', 'Price', 'نرخ')}: {formatIqd(o.price_iqd)}
                      </span>
                      <span>
                        {loc('عدد القطع', 'Spools', 'پارچە')}: {o.spool_qty}
                      </span>
                      <span>
                        {loc('الكشف عند', 'Reveal at', 'ئاشکراکردن لە')}: {o.reveal_stage || '—'}
                      </span>
                      {!o.direct_pool_id && !o.preorder_pool_id && (
                        <span className="text-amber-300">{loc('بلا مجموعة', 'No pool', 'بێ کۆمەڵە')}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      className={T.btnIcon}
                      onClick={() =>
                        void act(
                          () => api.post(`/api/admin/mystery/offers/${o.id}/duplicate`, {}),
                          loc('نُسخ بسرّ جديد', 'Duplicated with a new secret', 'لەبەرگیرایەوە بە نهێنییەکی نوێ')
                        )
                      }
                      aria-label={loc('نسخ', 'Duplicate', 'لەبەرگرتنەوە')}
                    >
                      <Copy className="w-4 h-4" aria-hidden />
                    </button>
                    <button type="button" className={btnGhost} onClick={() => void openExisting(o.id)}>
                      {loc('تحرير', 'Edit', 'دەستکاری')}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ================================================================== editor

  const { doc, config, offer } = editing;
  const setDoc = (patch: Partial<EditorDoc>) => setEditing({ ...editing, doc: { ...doc, ...patch } });
  const setConfig = (patch: Partial<MysteryConfig>) => setEditing({ ...editing, config: { ...config, ...patch } });
  const setOffer = (patch: Partial<OfferWindowInput>) =>
    setEditing({
      ...editing,
      offer: {
        starts_at: null,
        ends_at: null,
        required_tiers: [],
        locked_preview: true,
        active: true,
        max_per_user: null,
        max_global: null,
        ...(offer ?? {}),
        ...patch,
      },
    });

  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="mystery">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={btnGhost} onClick={() => setEditing(null)}>
          {loc('رجوع', 'Back', 'گەڕانەوە')}
        </button>
        <div className="flex items-center gap-2">
          {doc.id && (
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                if (
                  !window.confirm(
                    loc(
                      'تدوير السرّ يغيّر كل سحب مستقبلي لهذا العرض. السحوبات السابقة تبقى كما هي. متابعة؟',
                      'Rotating the secret changes every FUTURE draw of this offer. Past draws are unchanged. Continue?',
                      'گۆڕینی نهێنییەکە هەموو هەڵبژاردنێکی داهاتوو دەگۆڕێت. هەڵبژاردنە پێشووەکان وەک خۆیان دەمێننەوە.'
                    )
                  )
                )
                  return;
                void act(
                  () => api.post(`/api/admin/mystery/offers/${doc.id}/rotate-secret`, {}),
                  loc('دُوّر السرّ', 'Secret rotated', 'نهێنییەکە گۆڕدرا')
                );
              }}
            >
              <KeyRound className="w-4 h-4" aria-hidden /> {loc('تدوير السرّ', 'Rotate secret', 'گۆڕینی نهێنی')}
            </button>
          )}
          <button type="button" className={btnPrimary} onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
            {loc('حفظ', 'Save', 'پاشەکەوت')}
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
      {staleNote && <Banner kind="error">{staleNote}</Banner>}
      {ok && <Banner kind="ok">{ok}</Banner>}
      {warnings.length > 0 && (
        <Banner kind="warn">
          <ul className="space-y-0.5">
            {warnings.map((w, k) => (
              <li key={k}>• {say(w)}</li>
            ))}
          </ul>
        </Banner>
      )}

      <SectionCard n={1} ar="الهوية" en="Identity" open={section === 1} onToggle={() => setSection(section === 1 ? 0 : 1)}>
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
        <Grid cols={3}>
          <Field ar="الحالة" en="Status">
            <Select value={doc.status} onChange={(e) => setDoc({ status: e.target.value as EditorDoc['status'] })}>
              <option value="draft">{loc('مسودة', 'Draft', 'ڕەشنووس')}</option>
              <option value="active">{loc('منشور', 'Published', 'بڵاوکراوە')}</option>
              <option value="hidden">{loc('مخفي', 'Hidden', 'شاراوە')}</option>
            </Select>
          </Field>
          <Field ar="الترتيب" en="Display order">
            <Qty value={doc.display_order} onChange={(v) => setDoc({ display_order: v ?? 0 })} placeholder="0" />
          </Field>
          <Field ar="مميّز" en="Featured">
            <Toggle
              checked={doc.is_featured}
              onChange={(v) => setDoc({ is_featured: v })}
              label={loc('يظهر في الواجهة', 'Featured rail', 'لە ڕیزی سەرەکی')}
            />
          </Field>
        </Grid>
        <Field ar="الصور" en="Images" hint={loc('أول صورة هي الغلاف', 'the first image is the cover', 'یەکەم وێنە بەرگەکەیە')} span>
          <TextArea
            value={doc.images.join('\n')}
            onChange={(e) => setDoc({ images: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}
            rows={3}
          />
        </Field>
      </SectionCard>

      <SectionCard n={2} ar="السحب" en="The draw" open={section === 2} onToggle={() => setSection(section === 2 ? 0 : 2)}>
        <Grid cols={2}>
          <Field
            ar="مجموعة الشراء المباشر"
            en="Direct pool"
            hint={loc(
              'مجموعتان منفصلتان بحكم البناء، فلا يتحوّل شراء مباشر إلى طلب مسبق أبدًا.',
              'Separate pools by construction, so a direct purchase can never silently become a pre-order.',
              'دوو کۆمەڵەی جیاواز، بۆیە کڕینی ڕاستەوخۆ هەرگیز نابێتە پێش-داواکاری.'
            )}
          >
            <Select
              value={config.direct_pool_id ?? ''}
              onChange={(e) => setConfig({ direct_pool_id: e.target.value || null })}
            >
              <option value="">{loc('بلا مجموعة', 'No pool', 'بێ کۆمەڵە')}</option>
              {poolsOfKind('direct').map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field ar="مجموعة الطلب المسبق" en="Pre-order pool">
            <Select
              value={config.preorder_pool_id ?? ''}
              onChange={(e) => setConfig({ preorder_pool_id: e.target.value || null })}
            >
              <option value="">{loc('بلا مجموعة', 'No pool', 'بێ کۆمەڵە')}</option>
              {poolsOfKind('preorder').map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field ar="الشراء المباشر مسموح" en="Direct enabled">
            <Toggle
              checked={config.allow_direct}
              onChange={(v) => setConfig({ allow_direct: v })}
              label={loc('مباشر', 'Direct', 'ڕاستەوخۆ')}
            />
          </Field>
          <Field ar="الطلب المسبق مسموح" en="Pre-order enabled">
            <Toggle
              checked={config.allow_preorder}
              onChange={(v) => setConfig({ allow_preorder: v })}
              label={loc('طلب مسبق', 'Pre-order', 'پێش-داواکاری')}
            />
          </Field>
          <Field
            ar="عدد القطع لكل عرض"
            en="Spools per offer"
            hint={loc(
              'كل قطعة تُسحب على حدة. حاصل ضرب هذا العدد في أقصى كمية للطلب مرفوض فوق حدّ الأسطر المادية.',
              'Each spool is drawn independently. Its product with the per-order cap is refused above the physical-line ceiling.',
              'هەر پارچەیەک بە جیا هەڵدەبژێردرێت.'
            )}
          >
            <Qty value={config.spool_qty} onChange={(v) => setConfig({ spool_qty: Math.min(20, Math.max(1, v ?? 1)) })} placeholder="1" />
          </Field>
          <Field ar="أقصى كمية للطلب" en="Max per order">
            <Qty
              value={config.max_qty_per_order}
              onChange={(v) => setConfig({ max_qty_per_order: Math.min(99, Math.max(1, v ?? 1)) })}
              placeholder="5"
            />
          </Field>
          <Field
            ar="سياسة التكرار"
            en="Duplicate policy"
            hint={loc(
              'ممنوع: المرشّح المسحوب يخرج من العجلة، وإذا فرغت قبل اكتمال القطع يُرفض الشراء ولا يُخفَّض الشرط صامتًا.',
              'Forbid: a drawn candidate leaves the wheel, and if it empties before every spool the checkout is REFUSED — never silently downgraded to allow.',
              'قەدەغە: هەڵبژێردراوەکە لە چەرخەکە دەردەچێت.'
            )}
          >
            <Select
              value={config.duplicate_policy}
              onChange={(e) => setConfig({ duplicate_policy: e.target.value as MysteryConfig['duplicate_policy'] })}
            >
              <option value="allow">{loc('مسموح', 'Allow', 'ڕێپێدراو')}</option>
              <option value="discourage">{loc('مثبَّط (يُنصَّف الوزن)', 'Discourage (weight halved)', 'کەمکراوە')}</option>
              <option value="forbid">{loc('ممنوع', 'Forbid', 'قەدەغە')}</option>
            </Select>
          </Field>
          <Field
            ar="العميل يختار العائلة"
            en="Customer picks family"
            hint={loc(
              'العائلة معرّف تصنيف أو خاصية — لا اسم منتج أبدًا.',
              'A family is a catalog or facet id — never a product name.',
              'خێزان ناسنامەی پۆلێنە — هەرگیز ناوی بەرهەم نا.'
            )}
          >
            <Toggle
              checked={config.customer_picks_family}
              onChange={(v) => setConfig({ customer_picks_family: v })}
              label={loc('مسموح', 'Allowed', 'ڕێپێدراو')}
            />
          </Field>
        </Grid>
      </SectionCard>

      <SectionCard n={3} ar="الكشف والإفصاح" en="Reveal and disclosure" open={section === 3} onToggle={() => setSection(section === 3 ? 0 : 3)}>
        <Grid cols={2}>
          <Field
            ar="مرحلة الكشف"
            en="Reveal milestone"
            hint={loc(
              'تُجمَّد على كل طلب لحظة السحب: تغييرها هنا يسري على الطلبات الجديدة فقط، ولا يُخفي محتوى رآه عميل ولا يكشف الطلبات الجارية دفعةً واحدة.',
              'Frozen onto every order at draw time: changing it here applies to FUTURE orders only. It never hides a pick a customer has already seen, and never reveals every in-flight order at once.',
              'لە کاتی هەڵبژاردندا لەسەر هەر داواکارییەک دەبەسترێت: گۆڕینی تەنها بۆ داواکاریە نوێیەکان کار دەکات.'
            )}
          >
            <Select
              value={config.reveal_stage}
              onChange={(e) => setConfig({ reveal_stage: e.target.value as MysteryConfig['reveal_stage'] })}
            >
              {REVEAL_STAGES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            ar="إظهار الاحتمالات"
            en="Show odds"
            hint={loc(
              'تُجمَّع بحسب العائلة، فلا تسمّي منتجًا ولا لونًا ولا مدخلًا.',
              'Aggregated by family, so they name no product, no colour and no entry.',
              'بەپێی خێزان کۆدەکرێنەوە.'
            )}
          >
            <Toggle
              checked={config.show_odds}
              onChange={(v) => setConfig({ show_odds: v })}
              label={loc('تظهر للعميل', 'Shown to the customer', 'بۆ کڕیار پیشان دەدرێت')}
            />
          </Field>
        </Grid>
      </SectionCard>

      <SectionCard n={4} ar="الأهلية والجدولة" en="Eligibility and schedule" open={section === 4} onToggle={() => setSection(section === 4 ? 0 : 4)}>
        <Grid cols={2}>
          <Field ar="يبدأ" en="Starts" hint={loc('بتوقيت بغداد', 'Baghdad time', 'کاتی بەغدا')}>
            <TextInput
              type="datetime-local"
              value={toLocalInput(offer?.starts_at ?? null)}
              onChange={(e) => setOffer({ starts_at: fromLocalInput(e.target.value) })}
            />
          </Field>
          <Field ar="ينتهي" en="Ends" hint={loc('بتوقيت بغداد', 'Baghdad time', 'کاتی بەغدا')}>
            <TextInput
              type="datetime-local"
              value={toLocalInput(offer?.ends_at ?? null)}
              onChange={(e) => setOffer({ ends_at: fromLocalInput(e.target.value) })}
            />
          </Field>
        </Grid>
        <Field
          ar="الطبقات المسموح لها"
          en="Allowed tiers"
          hint={loc(
            'مجموعة صريحة لا حدًّا أدنى: PRO يرث PLUS، أما PRIME فطبقة مستقلة. الفراغ يعني عامًّا للجميع بمن فيهم الزائر.',
            'An explicit SET, not a minimum: PRO inherits PLUS, PRIME stands alone. Empty means public, including a signed-out visitor.',
            'کۆمەڵەیەکی ڕوون نەک کەمترین ئاست.'
          )}
          span
        >
          <div className="flex flex-wrap gap-2">
            {TIERS.map((t) => {
              const on = (offer?.required_tiers ?? []).includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  className={on ? T.btnFilter.replace('bg-transparent', 'bg-[var(--ap-surface-2)]') : T.btnFilter}
                  aria-pressed={on}
                  onClick={() =>
                    setOffer({
                      required_tiers: on
                        ? (offer?.required_tiers ?? []).filter((x) => x !== t)
                        : [...(offer?.required_tiers ?? []), t],
                    })
                  }
                >
                  {t}
                </button>
              );
            })}
          </div>
        </Field>
        <Grid cols={3}>
          <Field
            ar="أقصى عدد لكل عميل"
            en="Max per user"
            hint={loc(
              'يُنصح بعدد محدود لكل عرض عشوائي: الإلغاء لا يحرّر الحصّة، وهذا ما يمنع إعادة السحب.',
              'A finite number is recommended for every mystery offer: cancelling does NOT free the slot, which is what closes the re-roll.',
              'ژمارەیەکی سنووردار پێشنیار دەکرێت.'
            )}
          >
            <Money value={offer?.max_per_user ?? null} onChange={(v) => setOffer({ max_per_user: v })} placeholder="∞" />
          </Field>
          <Field ar="أقصى عدد إجمالي" en="Max global">
            <Money value={offer?.max_global ?? null} onChange={(v) => setOffer({ max_global: v })} placeholder="∞" />
          </Field>
          <Field ar="مفعّل" en="Active">
            <Toggle
              checked={offer?.active ?? true}
              onChange={(v) => setOffer({ active: v })}
              label={loc('نافذة العرض مفعّلة', 'Offer window active', 'پەنجەرەی ئۆفەر چالاکە')}
            />
          </Field>
        </Grid>
      </SectionCard>

      {Object.keys(previews).length > 0 && (
        <SectionCard n={5} ar="معاينة المخزون المؤهَّل" en="Eligible stock preview" open={section === 5} onToggle={() => setSection(section === 5 ? 0 : 5)}>
          {Object.entries(previews).map(([key, pv]) => (
            <div key={key} className="mb-3">
              <p className="text-[13px] font-bold text-[var(--ap-text-1)] mb-1">{key}</p>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-[var(--ap-text-3)]">
                <span>
                  {loc('خيارات مميّزة', 'Distinct choices', 'هەڵبژاردەی جیاواز')}:{' '}
                  <span className="tabular-nums text-[var(--ap-text-1)]">{pv.distinct_choices}</span>
                </span>
                <span>
                  {loc('إجمالي المتاح', 'Total available', 'کۆی بەردەست')}:{' '}
                  <span className="tabular-nums text-[var(--ap-text-1)]">
                    {pv.total_available === null ? '—' : pv.total_available}
                  </span>
                </span>
              </p>
              <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-[var(--ap-text-3)]">
                {pv.eligible.slice(0, 25).map((e) => (
                  <li key={e.entry_id} dir="ltr" className="text-start">
                    • {e.name}
                    {e.variant ? ` · ${e.variant}` : ''} — {loc('وزن', 'weight', 'کێش')} {e.weight} ·{' '}
                    <span className="tabular-nums">{Math.round(e.probability * 1000) / 10}%</span> ·{' '}
                    {e.available === null ? '—' : e.available}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </SectionCard>
      )}
    </div>
  );
}
