/**
 * DELIVERY SETTINGS — the merchant sets their store's delivery by governorate
 * (merchant platform W2-A, docs/MERCHANT_PLATFORM.md §2 decision 3, §4.2).
 *
 * SELF-CONTAINED: it loads its own configuration (GET /api/merchant/delivery),
 * keeps its own draft and saves on its own (PUT, the whole configuration with
 * the version it loaded). The current dashboard mounts it in the store
 * settings tab; the wave-3 workspace mounts it unchanged at /store/delivery.
 *
 * WHAT IT SAYS, top to bottom — the common path first, the detail one level
 * deeper (apple-design §4, simplicity):
 *   1. everywhere by default: a fee, free, or not delivered — and the fee;
 *   2. free delivery over an amount (judged after the store's coupon);
 *   3. the eighteen governorates as one compact list: each row says what a
 *      customer there pays; tapping it opens that row's own choice (the
 *      default, its own fee, free, or not delivered) and, under «More», its
 *      preparation days, delivery-time line, threshold and note;
 *   4. pickup from the store: where, and what to tell the customer;
 *   5. preparation days and a note for every order.
 * The same validator the server runs checks the draft as the merchant types,
 * so a field says what is wrong beside itself and Save stays off until it is
 * right. An open store that would deliver nowhere is told so before saving.
 *
 * Every figure the customer is charged is computed by the SERVER from their
 * saved address; nothing here is a price a client can send.
 *
 * OWNER: Sorani to be written by hand — every two-argument `loc()` in this
 * file is new copy; the Arabic stands in for Sorani until then (DECISIONS row 11).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MapPin, Store, Truck } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { GOVERNORATES } from '../../../lib/governorates';
import { merchantApi, iqd, type MerchantDeliveryConfig } from '../../../lib/merchant';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import { Field, Input, Select } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Segmented } from '../../ui/Segmented';
import { Switch } from '../../ui/Switch';
import { StatusChip } from '../../ui/Badge';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import {
  draftCoverage,
  draftFromConfig,
  draftIssues,
  draftKey,
  emptyRule,
  payloadFromDraft,
  rowAnswer,
  type DeliveryDraft,
  type RowMode,
  type RuleDraft,
} from './deliveryEditorModel';
import { DELIVERY_LIMITS, type DeliveryIssue } from '../../../../packages/shipping/src/merchantDelivery';

type Loc = (ar: string, en: string, ckb?: string) => string;

/** A field's problem, in the merchant's language — the validator's code, never its path. */
function issueText(code: DeliveryIssue['code'], loc: Loc): string {
  switch (code) {
    case 'fee_required':
      // OWNER: Sorani to be written by hand.
      return loc('اكتب أجرة التوصيل.', 'Enter the delivery fee.');
    case 'fee_range':
      // OWNER: Sorani to be written by hand.
      return loc('بين 0 و1,000,000 د.ع.', 'Between 0 and 1,000,000 IQD.');
    case 'free_over_range':
      // OWNER: Sorani to be written by hand.
      return loc('اكتب مبلغًا أكبر من صفر.', 'Enter an amount above zero.');
    case 'prep_days_range':
      // OWNER: Sorani to be written by hand.
      return loc('بين 0 و60 يومًا.', 'Between 0 and 60 days.');
    case 'pickup_governorate_required':
      // OWNER: Sorani to be written by hand.
      return loc('اختر محافظة الاستلام.', 'Choose where pickup happens.');
    case 'too_long':
      // OWNER: Sorani to be written by hand.
      return loc('النص أطول من المسموح.', 'This is too long.');
    default:
      // OWNER: Sorani to be written by hand.
      return loc('قيمة غير مقبولة.', 'This value is not accepted.');
  }
}

const govName = (id: string, lang: string) => {
  const g = GOVERNORATES.find((x) => x.id === id);
  return g ? (lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar) : id;
};

export interface DeliverySettingsEditorProps {
  /** The store's own governorate — the first suggestion for the pickup place. */
  storeGovernorate?: string;
  /** Told after every successful save. */
  onSaved?: (config: MerchantDeliveryConfig) => void;
}

export default function DeliverySettingsEditor({ storeGovernorate = '', onSaved }: DeliverySettingsEditorProps) {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const [loaded, setLoaded] = useState<MerchantDeliveryConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<DeliveryDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<MerchantDeliveryConfig | null>(null);
  const [saveError, setSaveError] = useState('');
  /** Fields whose typed text does not parse (NumberInput reports it). */
  const [unreadable, setUnreadable] = useState<Set<string>>(new Set());

  const adopt = useCallback(
    (cfg: MerchantDeliveryConfig) => {
      const d = draftFromConfig(cfg, storeGovernorate);
      setLoaded(cfg);
      setDraft(d);
      setBaseline(draftKey(d));
      setConflict(null);
      setSaveError('');
      setUnreadable(new Set());
    },
    [storeGovernorate]
  );

  const load = useCallback(() => {
    setLoadError(false);
    merchantApi
      .delivery()
      .then((cfg) => adopt(cfg))
      .catch(() => setLoadError(true));
  }, [adopt]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = !!draft && draftKey(draft) !== baseline;
  const issues = useMemo(() => (draft ? draftIssues(draft) : []), [draft]);
  const coverage = useMemo(() => (draft ? draftCoverage(draft) : null), [draft]);
  const noCoverage = !!loaded?.store_open && !!coverage && !coverage.serviceable;
  const issueAt = (path: string) => issues.find((i) => i.path === path);
  const errorAt = (path: string) => {
    const i = issueAt(path);
    return i ? issueText(i.code, loc) : undefined;
  };
  const canSave = dirty && !saving && issues.length === 0 && unreadable.size === 0 && !noCoverage;

  // Unsaved changes are not lost to a closed tab without a question.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const set = (patch: Partial<DeliveryDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setRule = (id: string, patch: Partial<RuleDraft>) =>
    setDraft((d) => (d ? { ...d, rules: { ...d.rules, [id]: { ...(d.rules[id] ?? emptyRule()), ...patch } } } : d));
  const readable = (key: string, valid: boolean) =>
    setUnreadable((prev) => {
      if (valid === !prev.has(key)) return prev;
      const next = new Set(prev);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });

  async function save() {
    if (!draft || !loaded || !canSave) return;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await merchantApi.saveDelivery({ version: loaded.profile.version, ...payloadFromDraft(draft) });
      adopt(saved);
      onSaved?.(saved);
      // OWNER: Sorani to be written by hand.
      toast.success(loc('حُفظت إعدادات التوصيل', 'Delivery settings saved'));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'DELIVERY_VERSION_CONFLICT') {
        const fresh = (e as ApiError).details?.config as MerchantDeliveryConfig | undefined;
        setConflict(fresh ?? null);
      } else if (code === 'DELIVERY_NO_COVERAGE') {
        // OWNER: Sorani to be written by hand.
        setSaveError(loc('المتجر مفتوح: اختر محافظة واحدة على الأقل للتوصيل، أو فعّل الاستلام من المتجر.', 'Your store is open: deliver to at least one governorate, or offer pickup.'));
      } else if (code === 'DELIVERY_INVALID') {
        // OWNER: Sorani to be written by hand.
        setSaveError(loc('بعض القيم غير مقبولة. راجع الحقول المعلَّمة.', 'Some values are not accepted. Check the marked fields.'));
      } else {
        // OWNER: Sorani to be written by hand.
        setSaveError(loc('تعذّر حفظ إعدادات التوصيل. حاول مرة أخرى.', 'The delivery settings could not be saved. Try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  // OWNER: Sorani to be written by hand.
  const title = loc('التوصيل حسب المحافظة', 'Delivery by governorate');

  if (loadError) {
    return (
      <Card title={title}>
        <div role="alert" className="lv-alert lv-alert-danger">
          <p className="text-text-secondary text-[12.5px]">
            {/* OWNER: Sorani to be written by hand. */}
            {loc('تعذّر تحميل إعدادات التوصيل.', 'The delivery settings could not be loaded.')}
          </p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={load}>
            {loc('إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە')}
          </Button>
        </div>
      </Card>
    );
  }

  if (!draft || !loaded) {
    return (
      <Card title={title}>
        <div role="status" aria-label={loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')} className="space-y-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </Card>
    );
  }

  const customCount = GOVERNORATES.filter((g) => (draft.rules[g.id]?.mode ?? 'default') !== 'default').length;
  const modeItems = [
    // OWNER: Sorani to be written by hand.
    { id: 'fee', label: loc('برسوم', 'Fee') },
    { id: 'free', label: loc('مجاني', 'Free', 'بەخۆڕایی') },
    // OWNER: Sorani to be written by hand.
    { id: 'disabled', label: loc('لا توصيل', 'Off') },
  ];

  return (
    <Card
      title={title}
      description={loc(
        'حدّد أين توصل وبكم. يُحسب التوصيل لكل زبون من محافظة عنوانه المحفوظ، وتُحفظ هذه الإعدادات وحدها.',
        'Choose where you deliver and for how much. Each customer is charged from their saved address’s governorate. These settings save on their own.'
      )}
      action={
        !loaded.configured ? (
          <StatusChip tone="info">{loc('لم تُضبط بعد', 'Not set up yet')}</StatusChip>
        ) : undefined
      }
    >
      <div data-delivery-editor className="space-y-5">
        {!loaded.configured && (
          <p className="text-text-muted text-[12px] leading-relaxed">
            {/* OWNER: Sorani to be written by hand. */}
            {loc(
              'حتى تحفظ إعداداتك، يُحسب التوصيل من أجرتك السابقة (أو مجانًا إن لم تحدّد أجرة).',
              'Until you save, delivery is priced from your previous flat fee (or free if you never set one).'
            )}
          </p>
        )}

        {/* 1 — everywhere, by default */}
        <section aria-labelledby="dlv-default" className="space-y-2.5">
          <h3 id="dlv-default" className="text-text-primary text-[13.5px] font-semibold">
            {/* OWNER: Sorani to be written by hand. */}
            {loc('كل المحافظات افتراضيًا', 'Every governorate, by default')}
          </h3>
          <Segmented
            group="delivery-default-mode"
            label={loc('طريقة التوصيل الافتراضية', 'Default delivery')}
            value={draft.default_mode}
            onChange={(v) => set({ default_mode: v as DeliveryDraft['default_mode'] })}
            items={modeItems}
          />
          {draft.default_mode === 'fee' && (
            <Field label={loc('أجرة التوصيل', 'Delivery fee', 'کرێی گەیاندن')} error={errorAt('profile.default_fee_iqd')} required>
              <NumberInput
                kind="money"
                max={DELIVERY_LIMITS.fee_iqd}
                value={draft.default_fee_iqd}
                onValueChange={(v, ok) => {
                  readable('default_fee', ok);
                  if (ok) set({ default_fee_iqd: v });
                }}
              />
            </Field>
          )}
          {draft.default_mode === 'disabled' && (
            <p className="text-text-muted text-[12px] leading-relaxed">
              {/* OWNER: Sorani to be written by hand. */}
              {loc('لن توصل إلا إلى المحافظات التي تفتحها في القائمة أدناه.', 'You deliver only to the governorates you open in the list below.')}
            </p>
          )}
        </section>

        {/* 2 — free over an amount */}
        {draft.default_mode !== 'disabled' || customCount > 0 ? (
          <section className="space-y-2">
            <Switch
              checked={draft.free_over_on}
              onChange={(v) => set({ free_over_on: v })}
              label={loc('توصيل مجاني فوق مبلغ', 'Free delivery over an amount')}
              description={loc('يُقاس على قيمة المنتجات بعد كوبون متجرك.', 'Judged on the goods after your store coupon.')}
            />
            {draft.free_over_on && (
              <Field label={loc('مجاني عندما تبلغ المنتجات', 'Free when the goods reach')} error={errorAt('profile.free_over_iqd')} required>
                <NumberInput
                  kind="money"
                  min={1}
                  max={DELIVERY_LIMITS.free_over_iqd}
                  value={draft.free_over_iqd}
                  onValueChange={(v, ok) => {
                    readable('free_over', ok);
                    if (ok) set({ free_over_iqd: v });
                  }}
                />
              </Field>
            )}
          </section>
        ) : null}

        {/* 3 — the eighteen governorates */}
        <section aria-labelledby="dlv-govs" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 id="dlv-govs" className="text-text-primary text-[13.5px] font-semibold">
              {/* OWNER: Sorani to be written by hand. */}
              {loc('حسب المحافظة', 'By governorate')}
            </h3>
            {customCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  const rules: Record<string, RuleDraft> = {};
                  for (const g of GOVERNORATES) rules[g.id] = emptyRule();
                  set({ rules });
                  setOpen(null);
                }}
                className="lv-button lv-button-ghost min-h-11 px-2 text-[12px]"
              >
                {/* OWNER: Sorani to be written by hand. */}
                {loc('إرجاع الكل إلى الافتراضي', 'Reset all to default')}
              </button>
            )}
          </div>
          <ul className="rounded-[var(--radius-md)] border border-border-subtle/70 divide-y divide-border-subtle/60 overflow-hidden">
            {GOVERNORATES.map((g) => {
              const answer = rowAnswer(draft, g.id);
              const expanded = open === g.id;
              const rule = draft.rules[g.id] ?? emptyRule();
              const rowError = issues.some((i) => i.path.startsWith(`rules.${g.id}.`));
              return (
                <li key={g.id} data-gov-row={g.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`dlv-row-${g.id}`}
                    onClick={() => setOpen(expanded ? null : g.id)}
                    className="w-full min-h-12 px-3 py-2 flex items-center gap-2 text-start hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                  >
                    <span className="min-w-0 flex-1 truncate text-text-primary text-[13px]">{govName(g.id, lang)}</span>
                    {rowError && <StatusChip tone="danger">{loc('راجع', 'Check')}</StatusChip>}
                    <span
                      className={`shrink-0 text-[12.5px] tabular-nums ${
                        answer.mode === 'disabled' ? 'text-text-muted' : answer.mode === 'free' ? 'text-success' : 'text-text-secondary'
                      }`}
                    >
                      {answer.mode === 'disabled'
                        ? loc('لا توصيل', 'Not delivered')
                        : answer.mode === 'free'
                          ? loc('مجاني', 'Free', 'بەخۆڕایی')
                          : answer.fee === null
                            ? '—'
                            : <bdi dir="ltr">{iqd(answer.fee)}</bdi>}
                    </span>
                    {answer.custom && (
                      <span className="shrink-0 text-[10.5px] text-gold" aria-label={loc('إعداد خاص', 'Own setting')}>
                        ●
                      </span>
                    )}
                    <ChevronDown aria-hidden="true" className={`w-4 h-4 shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                  {expanded && (
                    <div id={`dlv-row-${g.id}`} className="px-3 pb-3 pt-1 space-y-2.5 bg-white/[0.02]">
                      <Segmented
                        group={`delivery-row-${g.id}`}
                        label={loc(`التوصيل إلى ${govName(g.id, 'ar')}`, `Delivery to ${govName(g.id, 'en')}`)}
                        value={rule.mode}
                        size="sm"
                        onChange={(v) => setRule(g.id, { mode: v as RowMode })}
                        items={[
                          { id: 'default', label: loc('افتراضي', 'Default') },
                          { id: 'fee', label: loc('أجرة', 'Fee') },
                          { id: 'free', label: loc('مجاني', 'Free', 'بەخۆڕایی') },
                          { id: 'disabled', label: loc('لا', 'Off') },
                        ]}
                      />
                      {rule.mode === 'fee' && (
                        <Field label={loc('أجرة هذه المحافظة', 'Fee for this governorate')} error={errorAt(`rules.${g.id}.fee_iqd`)} required>
                          <NumberInput
                            kind="money"
                            max={DELIVERY_LIMITS.fee_iqd}
                            value={rule.fee_iqd}
                            onValueChange={(v, ok) => {
                              readable(`fee:${g.id}`, ok);
                              if (ok) setRule(g.id, { fee_iqd: v });
                            }}
                          />
                        </Field>
                      )}
                      {rule.mode !== 'default' && rule.mode !== 'disabled' && (
                        <details className="group">
                          <summary className="min-h-11 flex items-center gap-1 cursor-pointer text-text-secondary text-[12.5px] font-semibold">
                            <ChevronDown aria-hidden="true" className="w-4 h-4 transition-transform group-open:rotate-180" />
                            {loc('المزيد لهذه المحافظة', 'More for this governorate')}
                          </summary>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                            <Field label={loc('أيام التجهيز', 'Preparation days')} optional error={errorAt(`rules.${g.id}.prep_days`)}>
                              <NumberInput
                                kind="number"
                                decimals={0}
                                min={0}
                                max={DELIVERY_LIMITS.prep_days}
                                value={rule.prep_days}
                                placeholder={String(draft.prep_days ?? 0)}
                                onValueChange={(v, ok) => {
                                  readable(`prep:${g.id}`, ok);
                                  if (ok) setRule(g.id, { prep_days: v });
                                }}
                              />
                            </Field>
                            {rule.mode === 'fee' && (
                              <Field label={loc('مجاني فوق (لهذه المحافظة)', 'Free over (here)')} optional error={errorAt(`rules.${g.id}.free_over_iqd`)}>
                                <NumberInput
                                  kind="money"
                                  min={1}
                                  max={DELIVERY_LIMITS.free_over_iqd}
                                  value={rule.free_over_iqd}
                                  onValueChange={(v, ok) => {
                                    readable(`fo:${g.id}`, ok);
                                    if (ok) setRule(g.id, { free_over_iqd: v });
                                  }}
                                />
                              </Field>
                            )}
                            <Field label={loc('مدة الوصول', 'Delivery time')} optional error={errorAt(`rules.${g.id}.eta_note`)}>
                              <Input
                                value={rule.eta_note}
                                maxLength={DELIVERY_LIMITS.eta_note}
                                autoComplete="off"
                                placeholder={loc('مثال: ٢–٣ أيام', 'e.g. 2–3 days')}
                                onChange={(e) => setRule(g.id, { eta_note: e.target.value })}
                              />
                            </Field>
                            <Field label={loc('ملاحظة', 'Note')} optional error={errorAt(`rules.${g.id}.note`)}>
                              <Input
                                value={rule.note}
                                maxLength={DELIVERY_LIMITS.rule_note}
                                autoComplete="off"
                                onChange={(e) => setRule(g.id, { note: e.target.value })}
                              />
                            </Field>
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {coverage && (
            <p className="text-text-muted text-[12px]">
              {/* OWNER: Sorani to be written by hand. */}
              {loc(`توصل إلى ${coverage.served.length} من 18 محافظة`, `You deliver to ${coverage.served.length} of 18 governorates`)}
            </p>
          )}
        </section>

        {/* 4 — pickup */}
        <section className="space-y-2.5">
          <Switch
            checked={draft.pickup_enabled}
            onChange={(v) => set({ pickup_enabled: v })}
            label={
              <span className="inline-flex items-center gap-1.5">
                <Store aria-hidden="true" className="w-4 h-4 text-text-muted" />
                {loc('الاستلام من المتجر', 'Pickup from your store')}
              </span>
            }
            description={loc('بلا أجرة توصيل. الدفع من المحفظة كالعادة.', 'No delivery fee. Paid from the wallet as usual.')}
          />
          {draft.pickup_enabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <Field label={loc('محافظة الاستلام', 'Pickup governorate')} error={errorAt('profile.pickup_governorate')} required>
                <Select value={draft.pickup_governorate} onChange={(e) => set({ pickup_governorate: e.target.value })}>
                  <option value="">{loc('— اختر —', '— choose —', '—')}</option>
                  {GOVERNORATES.map((g) => (
                    <option key={g.id} value={g.id}>
                      {govName(g.id, lang)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={loc('تعليمات الاستلام', 'Pickup instructions')} optional error={errorAt('profile.pickup_note')}>
                <Input
                  value={draft.pickup_note}
                  maxLength={DELIVERY_LIMITS.pickup_note}
                  autoComplete="off"
                  placeholder={loc('مثال: الكرادة، اتصل قبل المجيء', 'e.g. Karrada — call before you come')}
                  onChange={(e) => set({ pickup_note: e.target.value })}
                />
              </Field>
            </div>
          )}
        </section>

        {/* 5 — every order */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <Field label={loc('أيام التجهيز قبل الإرسال', 'Days to prepare before sending')} error={errorAt('profile.prep_days')}>
            <NumberInput
              kind="quantity"
              max={DELIVERY_LIMITS.prep_days}
              value={draft.prep_days}
              onValueChange={(v, ok) => {
                readable('prep', ok);
                if (ok) set({ prep_days: v });
              }}
            />
          </Field>
          <Field label={loc('ملاحظة التوصيل للزبائن', 'Delivery note for customers')} optional error={errorAt('profile.note')}>
            <Input
              value={draft.note}
              maxLength={DELIVERY_LIMITS.note}
              autoComplete="off"
              placeholder={loc('مثال: نوصل عبر مندوبنا', 'e.g. Delivered by our own courier')}
              onChange={(e) => set({ note: e.target.value })}
            />
          </Field>
        </section>

        {noCoverage && (
          <div role="alert" className="lv-alert lv-alert-danger">
            <p className="flex items-start gap-1.5 text-text-primary text-[12.5px] leading-relaxed">
              <MapPin aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0" />
              {/* OWNER: Sorani to be written by hand. */}
              {loc(
                'متجرك مفتوح ولن يستطيع أحد استلام طلبه: افتح التوصيل إلى محافظة واحدة على الأقل، أو فعّل الاستلام من المتجر.',
                'Your store is open, but nobody could receive an order: deliver to at least one governorate, or offer pickup.'
              )}
            </p>
          </div>
        )}

        {conflict && (
          <div role="alert" className="lv-alert lv-alert-warning">
            <p className="text-text-primary text-[12.5px] leading-relaxed">
              {/* OWNER: Sorani to be written by hand. */}
              {loc('غُيّرت هذه الإعدادات من مكان آخر منذ فتحتها. حمّل آخر نسخة ثم عدّل.', 'These settings were changed elsewhere since you opened them. Load the latest, then edit.')}
            </p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => adopt(conflict)}>
              {loc('تحميل آخر نسخة', 'Load the latest')}
            </Button>
          </div>
        )}
        {saveError && (
          <p role="alert" className="lv-field-error">
            {saveError}
          </p>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle/60 pt-3">
          <p aria-live="polite" className="min-w-0 text-[12px] text-text-muted">
            {dirty
              ? loc('تغييرات غير محفوظة', 'Unsaved changes')
              : loaded.configured
                ? loc('محفوظ', 'Saved', 'پاشەکەوت کرا')
                : ''}
          </p>
          <Button
            variant="primary"
            icon={<Truck aria-hidden="true" className="w-4 h-4" />}
            disabled={!canSave}
            loading={saving}
            loadingLabel={loc('جارٍ الحفظ…', 'Saving…')}
            onClick={save}
          >
            {loc('حفظ التوصيل', 'Save delivery')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
