import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Percent as PercentIcon, Search, Tag, Trash2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { ErrorState } from '../ui/AsyncStates';
import Spinner from '../ui/Spinner';
import {
  Banner,
  Field,
  Grid,
  Money,
  Percent,
  Qty,
  SectionCard,
  Select,
  TextInput,
  Toggle,
  btnGhost,
  btnPrimary,
} from '../adminProducts/form/formUi';
import ProductPicker from '../adminProducts/form/ProductPicker';

/**
 * SPECIAL OFFERS — one panel for the ONE promotion model
 * (docs/BUNDLES_MYSTERY.md §9, §11.1 tab 4).
 *
 * THE POINT OF THIS SCREEN IS HOW LITTLE IT IS. A scheduled, tier-gated,
 * limited, DISCOUNTED offer on an ORDINARY product is the same
 * `offer_windows` + `offer_limits` pair a bundle and a mystery offer already
 * use, on the same subject key. So the owner gets a countdown, a membership
 * gate, a purchase limit and a price on any product in the catalogue with no
 * new table and no second discount code path.
 *
 * NOTHING HERE COMPUTES A PRICE. The rows the server would apply are shown as
 * the admin typed them, and the server refuses the two combinations that are
 * not honest — an offer price beside a derived bundle price mode
 * (`OFFER_PRICE_CONFLICT`) and an end before a start (`SCHEDULE_INVERTED`) —
 * verbatim, in three languages, and the panel repairs neither.
 *
 * `required_tiers` IS A SET, NOT A MINIMUM. That is why the tiers are
 * check-cards rather than a dropdown: `plus + pro but not prime` is a real
 * configuration (PRIME is a delivery tier for buyers and does not inherit
 * PLUS), and a "minimum tier" control cannot express it.
 */

const STRINGS = {
  ar: {
    title: 'العروض الخاصة',
    subtitle: 'جدولة وتقييد وخصم لأي منتج — بنفس نموذج الترويج الواحد',
    search: 'ابحث بالاسم أو الرابط',
    none: 'لا توجد عروض بعد',
    subject: 'المنتج',
    schedule: 'الجدولة',
    gate: 'الاشتراك المطلوب',
    price: 'سعر العرض',
    limits: 'الحدود',
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    saved: 'تم الحفظ',
    remove: 'إزالة العرض',
    removed: 'أُزيل العرض',
    active: 'مفعّل',
    lockedPreview: 'إظهار بطاقة مقفلة لغير المؤهّلين',
    startsAt: 'يبدأ في',
    endsAt: 'ينتهي في',
    mode: 'طريقة السعر',
    modeNone: 'بلا تغيير سعر',
    modeFixed: 'سعر ثابت',
    modePercent: 'خصم بالنسبة',
    modeIqd: 'خصم بالدينار',
    priceIqd: 'السعر',
    percent: 'النسبة',
    discountIqd: 'قيمة الخصم',
    plusIqd: 'سعر PLUS',
    maxPerUser: 'حد لكل عميل',
    maxGlobal: 'حد إجمالي',
    redeemed: 'استُخدم',
    released: 'أُعيد',
    productId: 'معرّف المنتج',
    add: 'عرض جديد',
    kindAll: 'الكل',
    kindProduct: 'منتجات عادية',
    kindBundle: 'باقات',
    kindMystery: 'عروض غامضة',
    state: { upcoming: 'لم يبدأ', live: 'يعمل الآن', ended: 'انتهى' },
  },
  en: {
    title: 'Special offers',
    subtitle: 'Schedule, gate, limit and discount any product — one promotion model',
    search: 'Search by name or slug',
    none: 'No offers yet',
    subject: 'Product',
    schedule: 'Schedule',
    gate: 'Membership gate',
    price: 'Offer price',
    limits: 'Limits',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    remove: 'Remove offer',
    removed: 'Offer removed',
    active: 'Active',
    lockedPreview: 'Show a locked card to viewers who are not eligible',
    startsAt: 'Starts at',
    endsAt: 'Ends at',
    mode: 'Price mode',
    modeNone: 'No price change',
    modeFixed: 'Fixed price',
    modePercent: 'Percent off',
    modeIqd: 'Amount off',
    priceIqd: 'Price',
    percent: 'Percent',
    discountIqd: 'Amount off',
    plusIqd: 'PLUS price',
    maxPerUser: 'Per customer',
    maxGlobal: 'Total',
    redeemed: 'Redeemed',
    released: 'Released',
    productId: 'Product id',
    add: 'New offer',
    kindAll: 'All',
    kindProduct: 'Ordinary products',
    kindBundle: 'Bundles',
    kindMystery: 'Mystery offers',
    state: { upcoming: 'Not started', live: 'Live now', ended: 'Ended' },
  },
  ckb: {
    title: 'ئۆفەرە تایبەتەکان',
    subtitle: 'کاتبەندی و مەرج و سنوور و داشکاندن بۆ هەر بەرهەمێک',
    search: 'گەڕان بە ناو یان بەستەر',
    none: 'هێشتا هیچ ئۆفەرێک نییە',
    subject: 'بەرهەم',
    schedule: 'کاتبەندی',
    gate: 'ئەندامێتی پێویست',
    price: 'نرخی ئۆفەر',
    limits: 'سنوورەکان',
    save: 'پاشەکەوت',
    saving: 'پاشەکەوت دەکرێت…',
    saved: 'پاشەکەوت کرا',
    remove: 'لابردنی ئۆفەر',
    removed: 'ئۆفەرەکە لابرا',
    active: 'چالاک',
    lockedPreview: 'کارتی داخراو پیشان بدە بۆ ئەوانەی شیاو نین',
    startsAt: 'دەست پێدەکات لە',
    endsAt: 'کۆتایی دێت لە',
    mode: 'شێوازی نرخ',
    modeNone: 'گۆڕانی نرخ نییە',
    modeFixed: 'نرخی جێگیر',
    modePercent: 'داشکاندن بە ڕێژە',
    modeIqd: 'داشکاندن بە دینار',
    priceIqd: 'نرخ',
    percent: 'ڕێژە',
    discountIqd: 'بڕی داشکاندن',
    plusIqd: 'نرخی PLUS',
    maxPerUser: 'بۆ هەر کڕیارێک',
    maxGlobal: 'کۆی گشتی',
    redeemed: 'بەکارهێنراوە',
    released: 'گەڕێندراوەتەوە',
    productId: 'ناسنامەی بەرهەم',
    add: 'ئۆفەری نوێ',
    kindAll: 'هەموو',
    kindProduct: 'بەرهەمە ئاساییەکان',
    kindBundle: 'پاکێجەکان',
    kindMystery: 'ئۆفەرە نهێنییەکان',
    state: { upcoming: 'دەستی پێنەکردووە', live: 'ئێستا کار دەکات', ended: 'کۆتایی هات' },
  },
} as const;

const TIERS = ['plus', 'prime', 'pro'] as const;

interface OfferRow {
  subject_id: string;
  offer_id: string;
  starts_at: string | null;
  ends_at: string | null;
  required_tiers: string[];
  offer_price_mode: string;
  offer_price_iqd: number | null;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  locked_preview: boolean;
  active: boolean;
  max_per_user: number | null;
  max_global: number | null;
  updated_at: string | null;
  product: { id: string; name: string; slug: string; composition: string; status: string };
  redeemed: number;
  /** Slots given back by a genuine cancellation (§17 decision 4). They no
   *  longer count against the limit, so they are shown apart rather than
   *  folded into `redeemed` — which is what made an offer read as sold out
   *  while it was still selling. */
  released?: number;
  schedule_state: 'upcoming' | 'live' | 'ended';
}

interface Issue {
  code: string;
  message?: string;
  ar?: string;
  en?: string;
  ckb?: string;
}

const blank = (subjectId: string): OfferRow => ({
  subject_id: subjectId,
  offer_id: '',
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
  updated_at: null,
  product: { id: subjectId, name: '', slug: '', composition: '', status: '' },
  redeemed: 0,
  released: 0,
  schedule_state: 'live',
});

/** `datetime-local` wants `YYYY-MM-DDTHH:mm`; the server speaks ISO with an
 *  explicit Z. Converted at the boundary, never stored half-converted. */
const toLocalInput = (iso: string | null): string => (iso ? iso.slice(0, 16) : '');
const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null);

export default function AdminOffers() {
  const { lang, dir, loc } = useLanguage();
  const s = STRINGS[lang];
  const [rows, setRows] = useState<OfferRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [editing, setEditing] = useState<OfferRow | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [warnings, setWarnings] = useState<Issue[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newId, setNewId] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    try {
      const q = new URLSearchParams();
      if (search) q.set('search', search);
      if (kind) q.set('kind', kind);
      const res = await api.get<{ offers: OfferRow[] }>(`/api/admin/offers${q.size ? `?${q}` : ''}`);
      if (mine !== seq.current) return; // a slower earlier reload must not win
      setRows(res.offers ?? []);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [search, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const text = (i: Issue) => (lang === 'ar' ? i.ar : lang === 'ckb' ? i.ckb : i.en) || i.message || i.code;

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setIssues([]);
    setWarnings([]);
    setNote(null);
    try {
      const res = await api.put<{ offer: OfferRow | null; warnings?: Issue[] }>(
        `/api/admin/offers/${editing.subject_id}`,
        {
          starts_at: editing.starts_at,
          ends_at: editing.ends_at,
          required_tiers: editing.required_tiers,
          offer_price_mode: editing.offer_price_mode,
          offer_price_iqd: editing.offer_price_iqd,
          discount_percent: editing.discount_percent,
          discount_iqd: editing.discount_iqd,
          plus_price_iqd: editing.plus_price_iqd,
          locked_preview: editing.locked_preview,
          active: editing.active,
          max_per_user: editing.max_per_user,
          max_global: editing.max_global,
        }
      );
      // Warnings stay visible AFTER a successful save (§11.3): the sentence
      // that matters most is the one about a configuration that worked and is
      // still not what the owner meant.
      setWarnings(res.warnings ?? []);
      setNote(s.saved);
      await load();
    } catch (e) {
      const body = (e as { details?: { errors?: Issue[] }; message?: string }) ?? {};
      setIssues(body.details?.errors ?? [{ code: 'ERROR', message: body.message ?? String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (subjectId: string) => {
    setBusy(true);
    try {
      await api.delete(`/api/admin/offers/${subjectId}`);
      setNote(s.removed);
      setEditing(null);
      await load();
    } catch (e) {
      setIssues([{ code: 'ERROR', message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  const stateChip = (state: OfferRow['schedule_state']) => {
    const tone =
      state === 'live'
        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
        : state === 'upcoming'
          ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
          : 'bg-zinc-700/40 text-zinc-400 border-zinc-700';
    return (
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}>{s.state[state]}</span>
    );
  };

  const list = useMemo(() => rows ?? [], [rows]);

  return (
    <div className="min-w-0" dir={dir} data-panel="offers">
      <header className="mb-3 min-w-0">
        <h2 className="text-[15px] font-black text-white truncate">{s.title}</h2>
        <p className="text-[12px] text-zinc-400">{s.subtitle}</p>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-2.5 h-4 w-4 text-zinc-500" aria-hidden />
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={s.search}
            className="ps-8"
            aria-label={s.search}
          />
        </div>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={s.kindAll}>
          <option value="">{s.kindAll}</option>
          <option value="product">{s.kindProduct}</option>
          <option value="bundle">{s.kindBundle}</option>
          <option value="mystery">{s.kindMystery}</option>
        </Select>
      </div>

      {/* CHOOSING THE SUBJECT IS A SEARCH, NOT A PASTE.
          The only way to open a new offer used to be a text field asking for a
          raw `prd_…`, and the search box above it filters EXISTING offers only
          — so an owner had no way to discover a product id from this screen at
          all, and slice 10's gate was reachable only by copying ids out of
          another panel. The picker resolves a bundle or a mystery offer as
          happily as an ordinary product, because all three share one subject
          key (§9). The raw-id field stays as the power-user fallback. */}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field ar="المنتج" en="Product" hint={loc('ابحث عن منتج أو باقة لفتح عرض جديد', 'Search a product or bundle to open a new offer', 'گەڕان بۆ بەرهەم یان پاکێج')}>
            <ProductPicker
              value={newId}
              excludeComposition={false}
              ariaLabel={loc('اختر منتجًا', 'Choose a product', 'بەرهەمێک هەڵبژێرە')}
              onChange={(id) => setNewId(id)}
            />
          </Field>
        </div>
        <div className="min-w-0 w-40">
          <Field ar="أو معرّف المنتج" en={STRINGS.en.productId} hint={loc('بديل للمتقدّمين', 'power-user fallback', 'ڕێگەی جێگرەوە')}>
            <TextInput value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="prd_…" />
          </Field>
        </div>
        <button
          type="button"
          className={`${btnGhost} h-9 px-3 text-[12px]`}
          disabled={!newId.trim()}
          onClick={() => {
            setEditing(blank(newId.trim()));
            setIssues([]);
            setWarnings([]);
            setNote(null);
          }}
        >
          + {s.add}
        </button>
      </div>

      {error && <ErrorState error={error} onRetry={() => void load()} />}
      {rows === null && !error && (
        <div className="py-8 grid place-items-center">
          <Spinner />
        </div>
      )}
      {rows !== null && list.length === 0 && !error && <p className="py-6 text-[12px] text-zinc-500">{s.none}</p>}

      <ul className="space-y-2">
        {list.map((o) => (
          <li key={o.subject_id}>
            <button
              type="button"
              onClick={() => {
                setEditing(o);
                setIssues([]);
                setWarnings([]);
                setNote(null);
              }}
              className="w-full min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-start hover:border-zinc-600 transition-colors"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Tag className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-white" dir="ltr">
                  {o.product.name || o.subject_id}
                </span>
                {stateChip(o.schedule_state)}
                {!o.active && (
                  <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-bold text-zinc-400">
                    {loc('موقوف', 'off', 'ناچالاک')}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                {o.required_tiers.length > 0 && (
                  <span className="text-gold">{o.required_tiers.join(' · ').toUpperCase()}</span>
                )}
                {o.offer_price_mode && (
                  <span className="inline-flex items-center gap-1">
                    <PercentIcon className="h-3 w-3" aria-hidden />
                    {o.offer_price_mode === 'discount_percent'
                      ? `${o.discount_percent ?? 0}%`
                      : o.offer_price_mode === 'fixed'
                        ? `${o.offer_price_iqd ?? 0}`
                        : `-${o.discount_iqd ?? 0}`}
                  </span>
                )}
                {(o.starts_at || o.ends_at) && (
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock className="h-3 w-3" aria-hidden />
                    <bdi dir="ltr" className="tabular-nums">
                      {(o.starts_at ?? '—').slice(0, 10)} → {(o.ends_at ?? '—').slice(0, 10)}
                    </bdi>
                  </span>
                )}
                <span>
                  {s.redeemed}: <bdi dir="ltr" className="tabular-nums">{o.redeemed}</bdi>
                  {(o.released ?? 0) > 0 && (
                    <span className="text-zinc-500">
                      {' '}· {s.released}: <bdi dir="ltr" className="tabular-nums">{o.released}</bdi>
                    </span>
                  )}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
            <h3 className="min-w-0 truncate text-[13px] font-black text-white" dir="ltr">
              {editing.product.name || editing.subject_id}
            </h3>
            <button type="button" className={`${btnGhost} h-8 px-2.5 text-[12px]`} onClick={() => setEditing(null)}>
              ✕
            </button>
          </div>

          {/* Refusals and warnings, verbatim and in the admin's own language —
              never repaired, never summarised (§11.3). */}
          {issues.map((i, n) => (
            <Banner kind="error" key={`${i.code}-${n}`}>
              {text(i)}
            </Banner>
          ))}
          {warnings.map((i, n) => (
            <Banner kind="warn" key={`${i.code}-${n}`}>
              {text(i)}
            </Banner>
          ))}
          {note && <Banner kind="ok">{note}</Banner>}

          <SectionCard n={1} ar="الجدولة" en={STRINGS.en.schedule} open onToggle={() => {}}>
            <Grid cols={2}>
              <Field ar="يبدأ في" en={STRINGS.en.startsAt}>
                <TextInput
                  type="datetime-local"
                  value={toLocalInput(editing.starts_at)}
                  onChange={(e) => setEditing({ ...editing, starts_at: toIso(e.target.value) })}
                />
              </Field>
              <Field ar="ينتهي في" en={STRINGS.en.endsAt}>
                <TextInput
                  type="datetime-local"
                  value={toLocalInput(editing.ends_at)}
                  onChange={(e) => setEditing({ ...editing, ends_at: toIso(e.target.value) })}
                />
              </Field>
            </Grid>
            <div className="mt-2 space-y-2">
              <Toggle
                label={s.active}
                sub={STRINGS.en.active}
                checked={editing.active}
                onChange={(v) => setEditing({ ...editing, active: v })}
              />
              <Toggle
                label={s.lockedPreview}
                checked={editing.locked_preview}
                onChange={(v) => setEditing({ ...editing, locked_preview: v })}
              />
            </div>
          </SectionCard>

          <SectionCard n={2} ar="الاشتراك المطلوب" en={STRINGS.en.gate} open onToggle={() => {}}>
            {/* A SET, not a minimum: PRO inherits PLUS, PRIME does not, and
                "plus + pro but not prime" is a real configuration a dropdown
                could not express (§9). */}
            <div className="flex flex-wrap gap-2">
              {TIERS.map((t) => {
                const on = editing.required_tiers.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        required_tiers: on
                          ? editing.required_tiers.filter((x) => x !== t)
                          : [...editing.required_tiers, t],
                      })
                    }
                    className={`min-h-[36px] rounded-full border px-3 text-[12px] font-bold transition-colors ${
                      on ? 'border-gold bg-gold/15 text-gold' : 'border-zinc-700 bg-zinc-900/60 text-zinc-300'
                    }`}
                  >
                    {t.toUpperCase()}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">
              {loc(
                'اتركها فارغة ليكون العرض عامًا — للزوار والحسابات المجانية أيضًا.',
                'Leave empty for a public offer — guests and free accounts included.',
                'بەتاڵی بهێڵەوە بۆ ئۆفەرێکی گشتی — میوان و هەژماری بێبەرامبەریش.'
              )}
            </p>
          </SectionCard>

          <SectionCard n={3} ar="سعر العرض" en={STRINGS.en.price} open onToggle={() => {}}>
            <Grid cols={2}>
              <Field ar="طريقة السعر" en={STRINGS.en.mode}>
                <Select
                  value={editing.offer_price_mode}
                  onChange={(e) => setEditing({ ...editing, offer_price_mode: e.target.value })}
                >
                  <option value="">{s.modeNone}</option>
                  <option value="fixed">{s.modeFixed}</option>
                  <option value="discount_percent">{s.modePercent}</option>
                  <option value="discount_iqd">{s.modeIqd}</option>
                </Select>
              </Field>
              {editing.offer_price_mode === 'fixed' && (
                <Field ar="السعر" en={STRINGS.en.priceIqd}>
                  <Money
                    value={editing.offer_price_iqd}
                    onChange={(v) => setEditing({ ...editing, offer_price_iqd: v })}
                  />
                </Field>
              )}
              {editing.offer_price_mode === 'discount_percent' && (
                <Field ar="النسبة" en={STRINGS.en.percent}>
                  <Percent
                    value={editing.discount_percent}
                    onChange={(v) => setEditing({ ...editing, discount_percent: v })}
                  />
                </Field>
              )}
              {editing.offer_price_mode === 'discount_iqd' && (
                <Field ar="قيمة الخصم" en={STRINGS.en.discountIqd}>
                  <Money value={editing.discount_iqd} onChange={(v) => setEditing({ ...editing, discount_iqd: v })} />
                </Field>
              )}
              <Field ar="سعر PLUS" en={STRINGS.en.plusIqd} hint={loc('اختياري', 'Optional', 'ئارەزوومەندانە')}>
                <Money value={editing.plus_price_iqd} onChange={(v) => setEditing({ ...editing, plus_price_iqd: v })} />
              </Field>
            </Grid>
          </SectionCard>

          <SectionCard n={4} ar="الحدود" en={STRINGS.en.limits} open onToggle={() => {}}>
            <Grid cols={2}>
              <Field ar="حد لكل عميل" en={STRINGS.en.maxPerUser}>
                <Qty value={editing.max_per_user} onChange={(v) => setEditing({ ...editing, max_per_user: v })} />
              </Field>
              <Field ar="حد إجمالي" en={STRINGS.en.maxGlobal}>
                <Qty value={editing.max_global} onChange={(v) => setEditing({ ...editing, max_global: v })} />
              </Field>
            </Grid>
          </SectionCard>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={`${btnPrimary} h-9 px-4 text-[12px]`} disabled={busy} onClick={() => void save()}>
              {busy ? s.saving : s.save}
            </button>
            {editing.offer_id && (
              <button
                type="button"
                className={`${btnGhost} h-9 px-3 text-[12px] text-red-300`}
                disabled={busy}
                onClick={() => void remove(editing.subject_id)}
              >
                <Trash2 className="me-1 inline h-3.5 w-3.5" aria-hidden />
                {s.remove}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
