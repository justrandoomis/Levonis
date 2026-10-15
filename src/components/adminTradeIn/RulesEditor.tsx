/**
 * «القواعد والنسب» — the trade-in valuation rules, per family, editable
 * without touching code: «القواعد والنسب قابلة للتعديل من لوحة الإدارة بدون
 * تغيير الكود، مع اختلاف القواعد بين FDM وResin وLaser وAMS والملحقات».
 *
 * EVERY SAVE IS A NEW VERSION. The server never edits a rule set in place
 * (worker/lib/tradeIn.ts `saveRuleSet`), so a request priced last month can
 * always say which numbers priced it, and the seeded defaults stay in the
 * history as version 1 — labelled «قيم افتراضية» until someone saves their own.
 *
 * ONE VALIDATOR, ONE ENGINE. The form checks itself with the same
 * `validateRuleSet` the server runs before it stores anything, and «جرّب
 * القواعد» prices a sample device with the same `valuateComponent` the
 * customer's wizard and the server use — so what the owner sees here is what
 * a customer will be told.
 *
 * Percentages are typed as percentages and stored as integer basis points
 * (12.5% → 1,250): the engine never sees a float.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, Calculator as CalcIcon, History } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api, ApiError, failureText } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import {
  FACTOR_IDS,
  FACTOR_LABELS,
  FAMILY_LABELS,
  TRADE_IN_FAMILIES,
  blankInputs,
  checklistOf,
  familyCountsHours,
  tradeInSettlement,
  validateRuleSet,
  valuateComponent,
  type ComponentInputs,
  type FactorConfig,
  type FactorRule,
  type TradeInFamily,
  type TradeInRuleSet,
} from '../../../packages/pricing/src/tradeIn';

/** The owner's offer parameters (0192), per family: NULL = the code default the server sends beside them. */
const PARAM_KEYS = ['resale_bp', 'handling_iqd', 'warranty_reserve_bp', 'margin_bp', 'margin_min_iqd', 'max_offer_bp', 'offer_rounding_iqd', 'min_offer_iqd'] as const;
type ParamKey = (typeof PARAM_KEYS)[number];
type OfferParams = Partial<Record<ParamKey, number | null>>;
type Stored = TradeInRuleSet & { id: string; note: string; created_at: string; offer_params?: OfferParams };
interface RulesResponse {
  rules: Record<TradeInFamily, Stored>;
  /** The code defaults and the CHECK ranges (owner-only read; never shipped in a bundle). */
  offer_defaults?: Record<TradeInFamily, Record<ParamKey, number>>;
  offer_ranges?: Record<ParamKey, [number, number]>;
  history: Record<TradeInFamily, Array<{ id: string; version: number; is_default: number; note: string; created_at: string; created_by_name: string | null }>>;
  financial_scope: boolean;
  /**
   * The verified main admin. The rules decide every estimate a financial admin
   * may approve, so editing them is the owner's act alone (owner decision 3).
   */
  owner_scope?: boolean;
}

const clone = <X,>(x: X): X => JSON.parse(JSON.stringify(x)) as X;

function Pct({ bp, onChange, label, invalid }: { bp: number; onChange: (bp: number) => void; label: string; invalid?: boolean }) {
  const [text, setText] = useState(String(bp / 100));
  useEffect(() => setText(String(bp / 100)), [bp]);
  return (
    <label className="block min-w-0">
      <span className={`block text-[11.5px] ${T.text3} mb-1 truncate`}>{label}</span>
      <span className="relative block">
        <input
          className={`${T.input} w-full tabular-nums pr-7 ${invalid ? 'border-[var(--ap-danger)]' : ''}`}
          dir="ltr"
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value.replace(',', '.'));
            if (Number.isFinite(n)) onChange(Math.round(n * 100));
          }}
        />
        <span className={`pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[12px] ${T.text3}`}>%</span>
      </span>
    </label>
  );
}

function Num({ value, onChange, label, suffix, invalid }: { value: number | null; onChange: (n: number | null) => void; label: string; suffix?: string; invalid?: boolean }) {
  return (
    <label className="block min-w-0">
      <span className={`block text-[11.5px] ${T.text3} mb-1 truncate`}>{label}</span>
      <span className="relative block">
        <input
          className={`${T.input} w-full tabular-nums ${suffix ? 'pr-10' : ''} ${invalid ? 'border-[var(--ap-danger)]' : ''}`}
          dir="ltr"
          inputMode="numeric"
          value={value === null ? '' : String(value)}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9]/g, '');
            onChange(v === '' ? null : Number(v));
          }}
        />
        {suffix ? <span className={`pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] ${T.text3}`}>{suffix}</span> : null}
      </span>
    </label>
  );
}

export default function RulesEditor() {
  const { loc } = useLanguage();
  const L = (ar: string, en: string, ckb: string) => loc(ar, en, ckb);
  const [family, setFamily] = useState<TradeInFamily>('fdm');
  const [data, setData] = useState<RulesResponse | null>(null);
  const [draft, setDraft] = useState<TradeInRuleSet | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await api.get<RulesResponse>('/api/admin/trade-in/rules');
      setData(d);
    } catch (e) {
      setError(failureText(e, loc('تعذّر التحميل', 'Could not load', 'بار نەکرا')));
    }
  }, [loc]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (data) {
      setDraft(clone(data.rules[family]));
      setServerErrors([]);
      setSaved('');
    }
  }, [data, family]);

  const check = useMemo(() => (draft ? validateRuleSet(draft, family) : null), [draft, family]);
  const errors = check !== null && check.ok === false ? check.errors : serverErrors;
  const dirty = !!draft && !!data && JSON.stringify(draft) !== JSON.stringify(data.rules[family]);
  const bad = (prefix: string) => errors.some((e) => e === prefix || e.startsWith(`${prefix}.`) || e.startsWith(`${prefix}[`));

  const setFactor = (id: string, patch: Partial<FactorRule>) => setDraft((d) => (d ? { ...d, factors: d.factors.map((f) => (f.factor === id ? { ...f, ...patch } : f)) } : d));
  const setConfig = (id: string, config: FactorConfig) => setFactor(id, { config });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const { offer_params: params, ...rules } = draft as Stored;
      await api.put(`/api/admin/trade-in/rules/${family}`, {
        rules: { ...rules, ...Object.fromEntries(PARAM_KEYS.map((k) => [k, params?.[k] ?? null])) },
        note: note.trim(),
      });
      setNote('');
      await load();
      setSaved(L('حُفظت نسخة جديدة من القواعد.', 'A new version of the rules was saved.', 'وەشانێکی نوێی یاساکان پاشەکەوت کرا.'));
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details?.errors)) setServerErrors(e.details.errors as string[]);
      setError(failureText(e, L('تعذّر الحفظ', 'Could not save', 'پاشەکەوت نەکرا')));
    } finally {
      setBusy(false);
    }
  };

  if (!data || !draft) return <p className={`py-12 text-center text-[13px] ${T.text3}`}>{error || L('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>;
  const current = data.rules[family];

  return (
    <div className="space-y-4" data-rules-editor={family}>
      <div className="flex flex-wrap items-center gap-2">
        {TRADE_IN_FAMILIES.map((f) => (
          <button key={f} type="button" aria-pressed={family === f} className={T.chip} onClick={() => setFamily(f)} data-family={f}>
            {loc(FAMILY_LABELS[f].ar, FAMILY_LABELS[f].en, FAMILY_LABELS[f].ckb)}
          </button>
        ))}
      </div>

      <section className={`${T.surface} p-4`}>
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div>
            <h2 className="text-[16px] font-bold">
              {loc(FAMILY_LABELS[family].ar, FAMILY_LABELS[family].en, FAMILY_LABELS[family].ckb)} · v{current.version}
            </h2>
            <p className={`text-[12.5px] ${T.text3}`}>
              {L(
                'كل حفظ يُنشئ نسخة جديدة؛ الطلبات القديمة تحتفظ بنسختها.',
                'Every save creates a new version; older requests keep theirs.',
                'هەر پاشەکەوتێک وەشانێکی نوێ دروست دەکات؛ داواکارییە کۆنەکان وەشانی خۆیان دەهێڵنەوە.'
              )}
            </p>
          </div>
          {current.is_default ? (
            <span className={`${T.badgeBase} ${T.badge.draft}`} data-default-badge>
              {L('قيم افتراضية — عدّلها لتناسب متجرك', 'Default values — tune them for your shop', 'بەهای بنەڕەتی — بۆ فرۆشگاکەت ڕێکیان بخە')}
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 mt-4 sm:grid-cols-3 lg:grid-cols-5">
          <Pct
            label={L('الحد الأدنى للقيمة', 'Floor', 'کەمترین سنووری بەها')}
            bp={draft.floor_bp}
            onChange={(v) => setDraft({ ...draft, floor_bp: v })}
            invalid={bad('floor_bp') || bad('floor_above_cap')}
          />
          <Pct
            label={L('الحد الأعلى للقيمة', 'Ceiling', 'بەرزترین سنووری بەها')}
            bp={draft.cap_bp}
            onChange={(v) => setDraft({ ...draft, cap_bp: v })}
            invalid={bad('cap_bp') || bad('floor_above_cap')}
          />
          <Num
            label={L('التقريب (للأسفل)', 'Round down to', 'خڕکردنەوە (بۆ خوارەوە)')}
            suffix="د.ع"
            value={draft.rounding_iqd}
            onChange={(v) => setDraft({ ...draft, rounding_iqd: v ?? 0 })}
            invalid={bad('rounding_iqd')}
          />
          <Num
            label={L('أقل سعر مؤهل', 'Minimum base', 'کەمترین نرخی شیاو')}
            suffix="د.ع"
            value={draft.min_base_iqd}
            onChange={(v) => setDraft({ ...draft, min_base_iqd: v ?? 0 })}
            invalid={bad('min_base_iqd')}
          />
          {family === 'ams' ? (
            <Num
              label={L('قيمة AMS المرجعية', 'AMS reference', 'بەهای سەرچاوەی AMS')}
              suffix="د.ع"
              value={draft.ams_reference_iqd}
              onChange={(v) => setDraft({ ...draft, ams_reference_iqd: v ?? 0 })}
              invalid={bad('ams_reference_iqd')}
            />
          ) : null}
        </div>
        {family === 'ams' ? (
          <p className={`mt-2 text-[12px] ${T.text3}`}>
            {L(
              'قيمة AMS داخل الكومبو تُحسب من فرق سعر خيار الكومبو عن الخيار العادي. القيمة المرجعية تُستخدم فقط إذا لم يوجد الخيار العادي، ولا تتجاوز نصف السعر المدفوع. صفر = لا يُعرض «AMS فقط» في تلك الحالة.',
              'A Combo’s AMS is priced from the gap between the Combo option and the plain one. The reference is used only when the plain option is gone, and never above half the paid price. Zero = «AMS only» is not offered then.',
              'بەهای AMS لەناو Combo لە جیاوازیی نێوان نرخی هەڵبژاردەی Combo و هەڵبژاردە ئاساییەکە حیساب دەکرێت. بەهای سەرچاوە تەنها کاتێک بەکاردێت کە هەڵبژاردە ئاساییەکە نەمابێت، و لە نیوەی نرخی دراو زیاتر نابێت. سفر = لەو کاتەدا «تەنها AMS» پیشان نادرێت.'
            )}
          </p>
        ) : null}
      </section>

      {data.offer_defaults ? (
        <OfferParamsPanel
          params={(draft as Stored).offer_params ?? {}}
          defaults={data.offer_defaults[family]}
          ranges={data.offer_ranges}
          onChange={(next) => setDraft({ ...(draft as Stored), offer_params: next } as TradeInRuleSet)}
        />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <div className="space-y-3 min-w-0">
          {FACTOR_IDS.map((id) => {
            const f = draft.factors.find((x) => x.factor === id);
            if (!f) return null;
            return (
              <section key={id} className={`${T.surface} p-3 ${bad(id) ? 'border-[var(--ap-danger-border)]' : ''}`} data-factor={id}>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={f.enabled} onChange={(e) => setFactor(id, { enabled: e.target.checked })} className="h-4 w-4 accent-[var(--ap-accent)]" />
                    <span className="text-[14px] font-semibold">{loc(FACTOR_LABELS[id].ar, FACTOR_LABELS[id].en, FACTOR_LABELS[id].ckb)}</span>
                  </label>
                  <div className="ms-auto w-36">
                    <Pct
                      label={L('نسبة التأثير', 'Impact weight', 'ڕێژەی کاریگەری')}
                      bp={f.weight_bp}
                      onChange={(v) => setFactor(id, { weight_bp: v })}
                      invalid={bad(`${id}.weight_bp`)}
                    />
                  </div>
                </div>
                {f.enabled ? <ConfigEditor factor={id} config={f.config} onChange={(c) => setConfig(id, c)} bad={bad} /> : null}
              </section>
            );
          })}
        </div>

        <div className="space-y-3 xl:sticky xl:top-20">
          <section className={`${T.surface} p-3 space-y-2`}>
            {errors.length ? (
              <div className="text-[12px] text-[var(--ap-danger)]" role="alert">
                <p className="font-semibold">{L('قيم غير صحيحة:', 'Invalid values:', 'بەهای نادروست:')}</p>
                <p dir="ltr" className="break-words">
                  {errors.slice(0, 8).join(', ')}
                </p>
              </div>
            ) : null}
            {data.owner_scope !== true ? (
              <p className="text-[12px] text-[var(--ap-warning)]">
                {loc('حفظ القواعد للأدمن الرئيسي فقط.', 'Only the main admin can save the rules.', 'تەنها بەڕێوەبەری سەرەکی دەتوانێت یاساکان پاشەکەوت بکات.')}
              </p>
            ) : null}
            <input
              className={`${T.input} w-full`}
              placeholder={L('ملاحظة للنسخة (اختياري)', 'Version note (optional)', 'تێبینی بۆ وەشانەکە (ئارەزوومەندانە)')}
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className={`${T.btnPrimary} flex-1`}
                disabled={!dirty || busy || data.owner_scope !== true || (check !== null && !check.ok)}
                onClick={save}
                data-save-rules
              >
                <Save className="w-4 h-4" aria-hidden />
                {L('حفظ كنسخة جديدة', 'Save as a new version', 'وەک وەشانێکی نوێ پاشەکەوت بکە')}
              </button>
              <button type="button" className={T.btnGhost} disabled={!dirty} onClick={() => setDraft(clone(current))}>
                {L('تراجع', 'Revert', 'پاشگەزبوونەوە')}
              </button>
            </div>
            {saved ? <p className="text-[12.5px] text-[var(--ap-success)]">{saved}</p> : null}
            {error && !errors.length ? <p className="text-[12.5px] text-[var(--ap-danger)]">{error}</p> : null}
          </section>
          <Calculator family={family} rules={draft} />
          <section className={`${T.surface} p-3`}>
            <h3 className="text-[13px] font-bold flex items-center gap-1.5 mb-2">
              <History className="w-4 h-4" aria-hidden />
              {L('النسخ', 'Versions', 'وەشانەکان')}
            </h3>
            <ol className="space-y-1.5 text-[12.5px]">
              {(data.history[family] ?? []).map((h) => (
                <li key={h.id} className="flex items-baseline justify-between gap-2">
                  <span>
                    v{h.version}
                    {h.is_default ? <span className={T.text3}> · {L('افتراضية', 'default', 'بنەڕەتی')}</span> : null}
                    {h.note ? <span className={T.text3}> · {h.note}</span> : null}
                  </span>
                  <span className={`${T.text3} tabular-nums shrink-0`}>
                    {h.created_by_name ?? ''} {h.created_at.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * «معاملات العرض» — the store-safe offer's parameters for this family (spec §4.4): resale share,
 * handling, warranty reserve per month left, margin and its minimum, the highest share of the new
 * price, the rounding and the minimum offer. Empty = the default shown under each field.
 */
function OfferParamsPanel({
  params,
  defaults,
  ranges,
  onChange,
}: {
  params: OfferParams;
  defaults: Record<ParamKey, number>;
  ranges?: Record<ParamKey, [number, number]>;
  onChange: (p: OfferParams) => void;
}) {
  const { loc } = useLanguage();
  const L = (ar: string, en: string, ckb: string) => loc(ar, en, ckb);
  const fields: Array<[ParamKey, string, 'pct' | 'iqd']> = [
    ['resale_bp', L('نسبة إعادة البيع المتوقعة', 'Expected resale share', 'ڕێژەی چاوەڕوانکراوی دووبارە فرۆشتنەوە'), 'pct'],
    ['handling_iqd', L('كلفة التجهيز', 'Handling cost', 'تێچووی ئامادەکردن'), 'iqd'],
    ['warranty_reserve_bp', L('احتياطي الضمان لكل شهر', 'Warranty reserve per month', 'پاشەکەوتی گەرەنتی بۆ هەر مانگێک'), 'pct'],
    ['margin_bp', L('هامش المتجر', 'Store margin', 'پەراوێزی فرۆشگا'), 'pct'],
    ['margin_min_iqd', L('أدنى هامش', 'Minimum margin', 'کەمترین پەراوێز'), 'iqd'],
    ['max_offer_bp', L('أعلى نسبة من سعر الجديد', 'Highest share of the new price', 'بەرزترین ڕێژە لە نرخی نوێ'), 'pct'],
    ['offer_rounding_iqd', L('التقريب للأسفل إلى', 'Round down to', 'خڕکردنەوە بۆ خوارەوە بۆ'), 'iqd'],
    ['min_offer_iqd', L('أدنى عرض', 'Minimum offer', 'کەمترین پێشنیار'), 'iqd'],
  ];
  const show = (k: ParamKey, kind: 'pct' | 'iqd', v: number) => (kind === 'pct' ? `${v / 100}%` : v.toLocaleString('en-US'));
  return (
    <section className={`${T.surface} p-4`} data-offer-params>
      <h3 className="text-[15px] font-bold">{L('معاملات العرض لهذا النوع', 'Offer parameters for this family', 'پارامەترەکانی پێشنیار بۆ ئەم جۆرە')}</h3>
      <p className={`text-[12.5px] ${T.text3}`}>
        {L(
          'فارغ = القيمة الافتراضية. تُحفظ مع القواعد كنسخة جديدة.',
          'Empty = the default. Saved with the rules as a new version.',
          'بەتاڵ = بنەڕەتی. لەگەڵ یاساکان وەک وەشانێکی نوێ پاشەکەوت دەکرێت.'
        )}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {fields.map(([k, label, kind]) => {
          const v = params[k];
          const range = ranges?.[k];
          const bad = v !== null && v !== undefined && range ? v < range[0] || v > range[1] : false;
          return (
            <label key={k} className="block min-w-0">
              <span className={`mb-1 block truncate text-[11.5px] ${T.text3}`}>{label}</span>
              <span className="relative block">
                <input
                  className={`${T.input} w-full tabular-nums ${kind === 'pct' ? 'pe-7' : ''} ${bad ? 'border-[var(--ap-danger)]' : ''}`}
                  dir="ltr"
                  inputMode={kind === 'pct' ? 'decimal' : 'numeric'}
                  placeholder={show(k, kind, defaults[k])}
                  value={v === null || v === undefined ? '' : kind === 'pct' ? String(v / 100) : String(v)}
                  onChange={(e) => {
                    const raw = e.target.value.replace(',', '.').trim();
                    if (raw === '') return onChange({ ...params, [k]: null });
                    const n = Number(raw);
                    if (!Number.isFinite(n)) return;
                    onChange({ ...params, [k]: kind === 'pct' ? Math.round(n * 100) : Math.round(n) });
                  }}
                  data-offer-param={k}
                />
                {kind === 'pct' ? <span className={`pointer-events-none absolute inset-y-0 end-2.5 flex items-center text-[12px] ${T.text3}`}>%</span> : null}
              </span>
              <span className={`mt-0.5 block text-[11px] ${T.text3}`}>
                {L('الافتراضي', 'Default', 'بنەڕەتی')}: {show(k, kind, defaults[k])}
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function ConfigEditor({ factor, config, onChange, bad }: { factor: string; config: FactorConfig; onChange: (c: FactorConfig) => void; bad: (p: string) => boolean }) {
  const { loc } = useLanguage();
  const L = (ar: string, en: string, ckb: string) => loc(ar, en, ckb);
  const grid = 'grid grid-cols-2 gap-2 mt-3 sm:grid-cols-4';
  switch (config.kind) {
    case 'age':
      return (
        <div className={grid}>
          <Pct
            label={L('خصم لكل شهر', 'Per month', 'داشکاندن بۆ هەر مانگێک')}
            bp={-config.per_month_bp}
            onChange={(v) => onChange({ ...config, per_month_bp: Math.abs(v) })}
            invalid={bad(`${factor}.per_month_bp`)}
          />
          <Pct
            label={L('أقصى خصم', 'Maximum', 'زۆرترین داشکاندن')}
            bp={-config.max_bp}
            onChange={(v) => onChange({ ...config, max_bp: Math.abs(v) })}
            invalid={bad(`${factor}.max_bp`)}
          />
          <Num
            label={L('أشهر بلا خصم', 'Grace months', 'مانگەکانی بێ داشکاندن')}
            value={config.grace_months}
            onChange={(v) => onChange({ ...config, grace_months: v ?? 0 })}
            invalid={bad(`${factor}.grace_months`)}
          />
        </div>
      );
    case 'warranty':
      return (
        <div className={grid}>
          <Pct
            label={L('إضافة لكل شهر متبقٍ', 'Per month left', 'زیادکردن بۆ هەر مانگێکی ماوە')}
            bp={config.per_month_bp}
            onChange={(v) => onChange({ ...config, per_month_bp: Math.abs(v) })}
            invalid={bad(`${factor}.per_month_bp`)}
          />
          <Pct
            label={L('أقصى إضافة', 'Maximum', 'زۆرترین زیادکردن')}
            bp={config.max_bp}
            onChange={(v) => onChange({ ...config, max_bp: Math.abs(v) })}
            invalid={bad(`${factor}.max_bp`)}
          />
        </div>
      );
    case 'hours':
      return (
        <div className="mt-3 space-y-2">
          {config.bands.map((b, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
              {i === config.bands.length - 1 ? (
                <p className={`text-[12.5px] ${T.text3} pb-2.5`}>{L('وما فوق', 'and above', 'و سەرووتر')}</p>
              ) : (
                <Num
                  label={L('حتى (ساعة)', 'Up to (hours)', 'تا (کاتژمێر)')}
                  value={b.up_to}
                  onChange={(v) => onChange({ ...config, bands: config.bands.map((x, j) => (j === i ? { ...x, up_to: v ?? 0 } : x)) })}
                  invalid={bad(`${factor}.bands[${i}]`)}
                />
              )}
              <Pct
                label={L('التأثير', 'Effect', 'کاریگەری')}
                bp={b.effect_bp}
                onChange={(v) => onChange({ ...config, bands: config.bands.map((x, j) => (j === i ? { ...x, effect_bp: v } : x)) })}
              />
              <button
                type="button"
                className={T.btnIconDanger}
                disabled={config.bands.length <= 1 || i === config.bands.length - 1}
                onClick={() => onChange({ ...config, bands: config.bands.filter((_, j) => j !== i) })}
                aria-label={L('حذف', 'Remove', 'سڕینەوە')}
              >
                <Trash2 className="w-4 h-4" aria-hidden />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={T.btnGhostSm}
            onClick={() => {
              const bands = [...config.bands];
              const last = bands.pop()!;
              const prev = bands.length ? (bands[bands.length - 1].up_to ?? 0) : 0;
              onChange({ ...config, bands: [...bands, { up_to: prev + 500, effect_bp: last.effect_bp }, last] });
            }}
          >
            <Plus className="w-3.5 h-3.5" aria-hidden />
            {L('شريحة', 'Band', 'پلە')}
          </button>
        </div>
      );
    case 'scale':
      return (
        <div className="grid grid-cols-5 gap-2 mt-3">
          {config.effects_bp.map((e, i) => (
            <Pct
              key={i}
              label={`${i + 1}/5`}
              bp={e}
              onChange={(v) => onChange({ ...config, effects_bp: config.effects_bp.map((x, j) => (j === i ? v : x)) as typeof config.effects_bp })}
              invalid={bad(`${factor}.effects_bp`)}
            />
          ))}
        </div>
      );
    case 'checklist':
      return (
        <div className="mt-3 space-y-2">
          {config.items.map((it, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.2fr_1.2fr_110px_auto] items-end">
              <label className="block min-w-0">
                <span className={`block text-[11.5px] ${T.text3} mb-1`}>id</span>
                <input
                  className={`${T.input} w-full ${bad(`${factor}.items[${i}]`) ? 'border-[var(--ap-danger)]' : ''}`}
                  dir="ltr"
                  value={it.id}
                  onChange={(e) =>
                    onChange({ ...config, items: config.items.map((x, j) => (j === i ? { ...x, id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') } : x)) })
                  }
                />
              </label>
              <label className="block min-w-0">
                <span className={`block text-[11.5px] ${T.text3} mb-1`}>{L('بالعربية', 'Arabic', 'بە عەرەبی')}</span>
                <input
                  className={`${T.input} w-full`}
                  value={it.label_ar}
                  onChange={(e) => onChange({ ...config, items: config.items.map((x, j) => (j === i ? { ...x, label_ar: e.target.value } : x)) })}
                />
              </label>
              <label className="block min-w-0">
                <span className={`block text-[11.5px] ${T.text3} mb-1`}>English</span>
                <input
                  className={`${T.input} w-full`}
                  dir="ltr"
                  value={it.label_en}
                  onChange={(e) => onChange({ ...config, items: config.items.map((x, j) => (j === i ? { ...x, label_en: e.target.value } : x)) })}
                />
              </label>
              <Pct
                label={L('التأثير', 'Effect', 'کاریگەری')}
                bp={it.effect_bp}
                onChange={(v) => onChange({ ...config, items: config.items.map((x, j) => (j === i ? { ...x, effect_bp: v } : x)) })}
              />
              <button
                type="button"
                className={T.btnIconDanger}
                onClick={() => onChange({ ...config, items: config.items.filter((_, j) => j !== i) })}
                aria-label={L('حذف', 'Remove', 'سڕینەوە')}
              >
                <Trash2 className="w-4 h-4" aria-hidden />
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-3">
            <button
              type="button"
              className={T.btnGhostSm}
              onClick={() => onChange({ ...config, items: [...config.items, { id: `item_${config.items.length + 1}`, label_ar: '', label_en: '', effect_bp: -100 }] })}
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              {L('بند', 'Item', 'بڕگە')}
            </button>
            <div className="w-40">
              <Pct
                label={L('أقصى مجموع', 'Total cap', 'زۆرترین کۆی گشتی')}
                bp={config.max_total_bp}
                onChange={(v) => onChange({ ...config, max_total_bp: -Math.abs(v) })}
                invalid={bad(`${factor}.max_total_bp`)}
              />
            </div>
          </div>
        </div>
      );
    case 'count':
      return (
        <div className={grid}>
          <Pct label={L('خصم لكل مرة', 'Per repair', 'داشکاندن بۆ هەر جارێک')} bp={-config.per_item_bp} onChange={(v) => onChange({ ...config, per_item_bp: Math.abs(v) })} />
          <Pct label={L('أقصى خصم', 'Maximum', 'زۆرترین داشکاندن')} bp={-config.max_bp} onChange={(v) => onChange({ ...config, max_bp: Math.abs(v) })} />
        </div>
      );
    case 'choice':
      return (
        <div className={grid}>
          {config.options.map((o, i) => (
            <Pct
              key={o.id}
              label={o.id === 'all' ? L('كاملة', 'All', 'هەموویان') : o.id === 'partial' ? L('بعضها', 'Some', 'هەندێکیان') : L('لا شيء', 'None', 'هیچ')}
              bp={o.effect_bp}
              onChange={(v) => onChange({ ...config, options: config.options.map((x, j) => (j === i ? { ...x, effect_bp: v } : x)) })}
            />
          ))}
        </div>
      );
    case 'market':
      return (
        <div className="mt-3 space-y-2">
          <div className="w-48">
            <Pct
              label={L('نسبة السوق للنوع', 'Family resale view', 'ڕێژەی بازاڕ بۆ جۆرەکە')}
              bp={config.resale_bp}
              onChange={(v) => onChange({ ...config, resale_bp: v })}
              invalid={bad(`${factor}.resale_bp`)}
            />
          </div>
          {config.product_overrides.map((o, i) => (
            <div key={i} className="grid grid-cols-[1fr_140px_auto] gap-2 items-end">
              <label className="block min-w-0">
                <span className={`block text-[11.5px] ${T.text3} mb-1`}>{L('معرّف المنتج', 'Product id', 'ناسنامەی بەرهەم')}</span>
                <input
                  className={`${T.input} w-full ${bad(`${factor}.product_overrides[${i}]`) ? 'border-[var(--ap-danger)]' : ''}`}
                  dir="ltr"
                  value={o.product_id}
                  onChange={(e) => onChange({ ...config, product_overrides: config.product_overrides.map((x, j) => (j === i ? { ...x, product_id: e.target.value.trim() } : x)) })}
                />
              </label>
              <Pct
                label={L('نسبة المنتج', 'Product view', 'ڕێژەی بەرهەم')}
                bp={o.effect_bp}
                onChange={(v) => onChange({ ...config, product_overrides: config.product_overrides.map((x, j) => (j === i ? { ...x, effect_bp: v } : x)) })}
              />
              <button
                type="button"
                className={T.btnIconDanger}
                onClick={() => onChange({ ...config, product_overrides: config.product_overrides.filter((_, j) => j !== i) })}
                aria-label={L('حذف', 'Remove', 'سڕینەوە')}
              >
                <Trash2 className="w-4 h-4" aria-hidden />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={T.btnGhostSm}
            onClick={() => onChange({ ...config, product_overrides: [...config.product_overrides, { product_id: '', effect_bp: config.resale_bp }] })}
          >
            <Plus className="w-3.5 h-3.5" aria-hidden />
            {L('نسبة لمنتج محدد', 'Per-product value', 'ڕێژە بۆ بەرهەمێکی دیاریکراو')}
          </button>
        </div>
      );
    case 'flat':
      return (
        <div className={grid}>
          <Pct label={L('التأثير', 'Effect', 'کاریگەری')} bp={config.effect_bp} onChange={(v) => onChange({ ...config, effect_bp: v })} />
        </div>
      );
  }
}

/** «جرّب القواعد» — a sample device through the draft rules, live. */
function Calculator({ family, rules }: { family: TradeInFamily; rules: TradeInRuleSet }) {
  const { loc } = useLanguage();
  const L = (ar: string, en: string, ckb: string) => loc(ar, en, ckb);
  const [base, setBase] = useState<number | null>(1_000_000);
  const [months, setMonths] = useState<number | null>(12);
  const [left, setLeft] = useState<number | null>(0);
  const [target, setTarget] = useState<number | null>(1_500_000);
  const [inputs, setInputs] = useState<ComponentInputs>(() => blankInputs(family));
  useEffect(() => setInputs(blankInputs(family)), [family]);
  const out = useMemo(() => {
    try {
      const v = valuateComponent(rules, { base_iqd: base ?? 0, usage_months: months ?? 0, warranty_remaining_months: left ?? 0, product_id: '' }, inputs);
      return { v, s: target ? tradeInSettlement(target, v.value_iqd) : null };
    } catch {
      return null;
    }
  }, [rules, base, months, left, target, inputs]);
  const faults = checklistOf(rules, 'faults');
  const score = (k: 'cleanliness' | 'exterior' | 'scratches') => (
    <label className="block">
      <span className={`block text-[11.5px] ${T.text3} mb-1`}>
        {loc({ cleanliness: 'النظافة', exterior: 'الخارجية', scratches: 'الخدوش' }[k], k, { cleanliness: 'پاکوخاوێنی', exterior: 'دەرەوە', scratches: 'ڕووشان' }[k])}
      </span>
      <select className={`${T.selectSm} w-full`} value={inputs[k]} onChange={(e) => setInputs({ ...inputs, [k]: Number(e.target.value) as 1 })}>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className={`${T.surface} p-3 space-y-2`} data-rules-calculator>
      <h3 className="text-[13px] font-bold flex items-center gap-1.5">
        <CalcIcon className="w-4 h-4" aria-hidden />
        {L('جرّب القواعد', 'Test the rules', 'یاساکان تاقی بکەرەوە')}
      </h3>
      <div className="grid grid-cols-2 gap-2">
        <Num label={L('السعر المدفوع', 'Price paid', 'نرخی دراو')} suffix="د.ع" value={base} onChange={setBase} />
        <Num label={L('سعر الجهاز الجديد', 'New device price', 'نرخی ئامێرە نوێیەکە')} suffix="د.ع" value={target} onChange={setTarget} />
        <Num label={L('أشهر الاستخدام', 'Months used', 'مانگەکانی بەکارهێنان')} value={months} onChange={setMonths} />
        <Num label={L('أشهر ضمان متبقية', 'Warranty months left', 'مانگەکانی گەرەنتیی ماوە')} value={left} onChange={setLeft} />
        {familyCountsHours(family) ? (
          <Num label={L('ساعات التشغيل', 'Hours', 'کاتژمێرەکانی کارکردن')} value={inputs.hours} onChange={(v) => setInputs({ ...inputs, hours: v ?? 0 })} />
        ) : null}
        <Num label={L('إصلاحات', 'Repairs', 'چاککردنەوەکان')} value={inputs.repairs_count} onChange={(v) => setInputs({ ...inputs, repairs_count: Math.min(20, v ?? 0) })} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {score('cleanliness')}
        {score('exterior')}
        {score('scratches')}
      </div>
      {faults.length ? (
        <div className="flex flex-wrap gap-1.5">
          {faults.map((f) => (
            <button
              key={f.id}
              type="button"
              className={T.chip}
              aria-pressed={inputs.faults.includes(f.id)}
              onClick={() => setInputs({ ...inputs, faults: inputs.faults.includes(f.id) ? inputs.faults.filter((x) => x !== f.id) : [...inputs.faults, f.id] })}
            >
              {loc(f.label_ar, f.label_en, f.label_en)}
            </button>
          ))}
        </div>
      ) : null}
      {out ? (
        <div className="rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] p-2.5">
          <table className="w-full text-[12px]">
            <tbody>
              {out.v.lines.map((l, i) => (
                <tr key={i}>
                  <td className="py-0.5">{loc(l.label_ar, l.label_en, (l as { label_ckb?: string }).label_ckb ?? l.label_en)}</td>
                  <td className={`py-0.5 text-end tabular-nums ${T.text3}`} dir="ltr">
                    {l.effect_bp ? `${(l.effect_bp / 100).toFixed(1)}%` : ''}
                  </td>
                  <td className="py-0.5 text-end tabular-nums" dir="ltr">
                    {l.amount_iqd.toLocaleString('en-US')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 flex items-baseline justify-between text-[13px] font-bold">
            <span>{L('القيمة', 'Value', 'بەها')}</span>
            <span className="tabular-nums" dir="ltr">
              {out.v.value_iqd.toLocaleString('en-US')} IQD
            </span>
          </p>
          {out.s ? (
            <p className={`flex items-baseline justify-between text-[12.5px] ${T.text2}`}>
              <span>{L('الفرق المطلوب', 'Difference', 'جیاوازیی داواکراو')}</span>
              <span className="tabular-nums" dir="ltr">
                {out.s.difference_iqd.toLocaleString('en-US')} IQD
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
      <p className={`text-[11.5px] ${T.text3}`}>
        {L('المحرّك نفسه الذي يرى به الزبون تقديره.', 'The same engine the customer’s estimate uses.', 'هەمان ئەو بزوێنەرەی کڕیار خەمڵاندنەکەی پێ دەبینێت.')}
      </p>
    </section>
  );
}
