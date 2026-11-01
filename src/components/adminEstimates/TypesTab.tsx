/**
 * «الأنواع والمفاتيح» — THE OWNER'S PER-TYPE TABLE AND THE TWO SWITCHES
 * (docs/SMART_PRICING.md §4.1, §7; owner decisions D2, D3; DECISIONS rows
 * 279–280).
 *
 *   - THE SWITCHES (`PUT /estimates/control`, a fresh sign-in): «apply» —
 *     refused until the published purchase policy carries the estimated-price
 *     clause — and «ordering», the emergency brake on estimated lines;
 *   - THE TYPES (`PUT /estimates/types/:key`, version-fenced, audited): the
 *     route (air only where the type allows it; filament by sea only; the EU
 *     store by land only), the US reference (EU types), the default weight and
 *     box or CBM, the extra cost in IQD, the minimum profit in USD and the
 *     staleness days. Every figure is empty until the owner types it; nothing
 *     here proposes one except «اقترح من الكتالوج», the median of the real
 *     package measures, which is never saved without his press;
 *   - A NEW TYPE (`POST /estimates/types`), its three names (the Sorani never
 *     a copy of the Arabic).
 * The warning «below one rounding step» is the server's (T × U, §4.3).
 * Decimals travel as text; nothing is computed here.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Lightbulb, Plus } from 'lucide-react';
import { Button } from '../ui/Button';
import { StatusChip } from '../ui/Badge';
import { Field, Input, Select } from '../ui/Field';
import { Checkbox, Switch } from '../ui/Switch';
import { Skeleton } from '../ui/Skeleton';
import {
  createType,
  fetchControl,
  fetchTypes,
  setControl,
  suggestType,
  updateType,
  type ControlAnswer,
  type EstimateRoute,
  type EstimateSourcing,
  type EstimateType,
  type MeasureSuggestion,
  type TypeUpdateBody,
} from './api';
import { decimalText, wholeNumber } from './input';
import { ActNote, Failure, Ltr, useAct, useUiLang } from './parts';
import { COMMON, CONTROL, ROUTE_LABELS, SOURCING_LABELS, TYPE_WARNINGS, TYPES, say, type UiLang } from './strings';
import { groupDecimal, groupWhole, iqdText } from './format';

/** The type keys filament is sold under: sea only, never air (0218's CHECK and trigger T5). */
const SEA_ONLY = new Set(['filament', 'filament_pack']);

/** The routes a type may take (the 0218 CHECKs, said before the server says them). */
export function allowedRoutes(t: Pick<EstimateType, 'key' | 'sourcing'>, allowAir: boolean): EstimateRoute[] {
  if (t.sourcing === 'EU_STORE_EUR') return ['land'];
  if (SEA_ONLY.has(t.key)) return ['sea'];
  return allowAir ? ['sea', 'air'] : ['sea'];
}

export default function TypesTab() {
  const { lang } = useUiLang();
  const [types, setTypes] = useState<EstimateType[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    fetchTypes({ signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (!ac.signal.aborted) setTypes(a.types);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [reload]);

  return (
    <section className="space-y-4" data-estimates-types>
      <ControlCard lang={lang} />
      <section className="lv-surface space-y-3 p-4">
        <h3 className="text-[15px] font-bold text-text-primary">{say(TYPES.title, lang)}</h3>
        <p className="max-w-[72ch] text-[13px] leading-relaxed text-text-secondary">{say(TYPES.intro, lang)}</p>
        {error ? (
          <Failure error={error} lang={lang} onRetry={refresh} />
        ) : !types ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <ul className="space-y-3">
            {types.map((t) => (
              <TypeCard key={t.key} type={t} lang={lang} onSaved={(next) => setTypes((list) => (list ? list.map((x) => (x.key === next.key ? next : x)) : list))} onStale={refresh} />
            ))}
          </ul>
        )}
      </section>
      {types ? <NewTypeCard lang={lang} existing={types.map((t) => t.key)} onCreated={refresh} /> : null}
    </section>
  );
}

/** The two switches: «apply» and «ordering». */
function ControlCard({ lang }: { lang: UiLang }) {
  const [answer, setAnswer] = useState<ControlAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const act = useAct(lang, () => setReload((n) => n + 1));

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    fetchControl({ signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (!ac.signal.aborted) setAnswer(a);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [reload]);

  const flip = (key: 'apply_enabled' | 'ordering_enabled', next: boolean) => {
    if (!answer) return;
    void act.run(key, () => setControl({ version: answer.control.version, [key]: next }), (a) => {
      setAnswer(a);
      return { tone: 'success', text: say(COMMON.saved, lang) };
    });
  };

  return (
    <section className="lv-surface space-y-3 p-4" data-estimates-control>
      <h3 className="text-[15px] font-bold text-text-primary">{say(CONTROL.title, lang)}</h3>
      {error ? (
        <Failure error={error} lang={lang} onRetry={() => setReload((n) => n + 1)} />
      ) : !answer ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <Switch
            checked={answer.control.apply_enabled}
            onChange={(v) => flip('apply_enabled', v)}
            busy={act.busy === 'apply_enabled'}
            disabled={!answer.control.apply_enabled && !answer.policy_ready}
            label={say(CONTROL.apply, lang)}
            description={answer.policy_ready || answer.control.apply_enabled ? say(CONTROL.applyDesc, lang) : say(CONTROL.policyMissing, lang)}
          />
          <Switch
            checked={answer.control.ordering_enabled}
            onChange={(v) => flip('ordering_enabled', v)}
            busy={act.busy === 'ordering_enabled'}
            label={say(CONTROL.ordering, lang)}
            description={say(CONTROL.orderingDesc, lang)}
          />
          <p className="text-[12px] text-text-muted">{say(CONTROL.freshSignIn, lang)}</p>
          <ActNote message={act.message} lang={lang} />
        </>
      )}
    </section>
  );
}

interface TypeDraft {
  route: EstimateRoute;
  allow_air: boolean;
  us_reference_allowed: boolean;
  weight: string;
  length: string;
  width: string;
  height: string;
  cbm: string;
  additional: string;
  minProfit: string;
  staleDays: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
}

const text = (n: number | null): string => (n === null ? '' : String(n));

function draftOf(t: EstimateType): TypeDraft {
  return {
    route: t.route,
    allow_air: t.allow_air,
    us_reference_allowed: t.us_reference_allowed,
    weight: text(t.default_weight_g),
    length: text(t.default_length_mm),
    width: text(t.default_width_mm),
    height: text(t.default_height_mm),
    cbm: t.default_cbm ?? '',
    additional: text(t.additional_cost_iqd),
    minProfit: t.min_profit_usd ?? '',
    staleDays: String(t.stale_after_days),
    name_ar: t.name_ar,
    name_en: t.name_en,
    name_ckb: t.name_ckb,
  };
}

type DraftErrors = Partial<Record<'weight' | 'box' | 'cbm' | 'additional' | 'minProfit' | 'staleDays' | 'names', string>>;

/**
 * The PUT body of a draft against its stored type: only the fields the owner
 * changed (an emptied figure is sent as null), or the errors that keep it
 * from being sent. Pure — exported for its test.
 */
export function typeUpdateOf(t: EstimateType, d: TypeDraft, lang: UiLang): { body: TypeUpdateBody | null; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const whole = (raw: string, min: number, max: number, key: keyof DraftErrors): number | null | undefined => {
    const v = wholeNumber(raw, min, max);
    if (v === null) {
      errors[key] = say(TYPES.wholeInvalid, lang);
      return undefined;
    }
    return v === '' ? null : v;
  };
  const decimal = (raw: string, maxDecimals: number, maxLength: number, key: keyof DraftErrors): string | null | undefined => {
    const v = decimalText(raw, { maxDecimals, maxLength });
    if (v === null) {
      errors[key] = say(TYPES.decimalInvalid, lang);
      return undefined;
    }
    return v === '' ? null : v;
  };
  const weight = whole(d.weight, 1, 100_000_000, 'weight');
  const axes = [d.length, d.width, d.height].map((a) => wholeNumber(a, 1, 100_000));
  const filled = axes.filter((a) => a !== '').length;
  let box: [number | null, number | null, number | null] | undefined;
  if (axes.some((a) => a === null)) errors.box = say(TYPES.wholeInvalid, lang);
  else if (filled !== 0 && filled !== 3) errors.box = say(TYPES.boxAll, lang);
  else box = filled === 0 ? [null, null, null] : (axes as [number, number, number]);
  const cbm = decimal(d.cbm, 9, 12, 'cbm');
  const additional = whole(d.additional, 0, 1_000_000_000, 'additional');
  const minProfit = decimal(d.minProfit, 6, 13, 'minProfit');
  const stale = wholeNumber(d.staleDays, 1, 365);
  if (stale === null || stale === '') errors.staleDays = say(TYPES.wholeInvalid, lang);
  const names = { name_ar: d.name_ar.trim(), name_en: d.name_en.trim(), name_ckb: d.name_ckb.trim() };
  if (Object.values(names).some((n) => n.length < 1 || n.length > 80)) errors.names = say(TYPES.nameInvalid, lang);
  else if (names.name_ckb === names.name_ar) errors.names = say(TYPES.nameCkbSame, lang);
  if (Object.keys(errors).length) return { body: null, errors };

  const body: TypeUpdateBody = { version: t.version };
  if (d.route !== t.route) body.route = d.route;
  if (d.allow_air !== t.allow_air) body.allow_air = d.allow_air;
  if (d.us_reference_allowed !== t.us_reference_allowed) body.us_reference_allowed = d.us_reference_allowed;
  if (weight !== undefined && weight !== t.default_weight_g) body.default_weight_g = weight;
  if (box && (box[0] !== t.default_length_mm || box[1] !== t.default_width_mm || box[2] !== t.default_height_mm)) {
    [body.default_length_mm, body.default_width_mm, body.default_height_mm] = box;
  }
  if (cbm !== undefined && cbm !== t.default_cbm) body.default_cbm = cbm;
  if (additional !== undefined && additional !== t.additional_cost_iqd) body.additional_cost_iqd = additional;
  if (minProfit !== undefined && minProfit !== t.min_profit_usd) body.min_profit_usd = minProfit;
  if (typeof stale === 'number' && stale !== t.stale_after_days) body.stale_after_days = stale;
  for (const k of ['name_ar', 'name_en', 'name_ckb'] as const) if (names[k] !== t[k]) body[k] = names[k];
  return { body: Object.keys(body).length > 1 ? body : null, errors };
}

function TypeCard({ type: t, lang, onSaved, onStale }: { type: EstimateType; lang: UiLang; onSaved: (t: EstimateType) => void; onStale: () => void }) {
  const act = useAct(lang, onStale);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TypeDraft>(() => draftOf(t));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [suggestion, setSuggestion] = useState<MeasureSuggestion | null>(null);
  useEffect(() => setDraft(draftOf(t)), [t]);
  const routes = allowedRoutes(t, draft.allow_air);
  const name = lang === 'en' ? t.name_en : lang === 'ckb' ? t.name_ckb : t.name_ar;
  const set = <K extends keyof TypeDraft>(k: K, v: TypeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    const { body, errors: e } = typeUpdateOf(t, draft, lang);
    setErrors(e);
    if (!body) {
      if (!Object.keys(e).length) setEditing(false);
      return;
    }
    await act.run('save', () => updateType(t.key, body), (a) => {
      onSaved(a.type);
      setEditing(false);
      return { tone: 'success', text: say(COMMON.saved, lang) };
    });
  };

  const suggest = () =>
    act.run('suggest', () => suggestType(t.key, { mascot: 'silent' }), (a) => {
      setSuggestion(a.suggestion);
      return null;
    });

  const useSuggestion = () => {
    if (!suggestion) return;
    setDraft((d) => ({
      ...d,
      weight: suggestion.weight_g !== null ? String(suggestion.weight_g) : d.weight,
      length: suggestion.box ? String(suggestion.box[0]) : d.length,
      width: suggestion.box ? String(suggestion.box[1]) : d.width,
      height: suggestion.box ? String(suggestion.box[2]) : d.height,
    }));
    setEditing(true);
  };

  const figure = (v: string) => (v === '' ? <span className="text-text-muted">{say(TYPES.empty, lang)}</span> : <Ltr className="font-semibold text-text-primary">{v}</Ltr>);
  const box = t.default_length_mm !== null ? `${groupWhole(t.default_length_mm)} × ${groupWhole(t.default_width_mm)} × ${groupWhole(t.default_height_mm)}` : '';

  return (
    <li className="min-w-0 space-y-3 rounded-xl bg-surface-raised p-3" data-estimate-type={t.key}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h4 className="min-w-0 break-words text-[14px] font-bold text-text-primary">{name}</h4>
          <Ltr className="text-[12px] text-text-muted">{t.key}</Ltr>
          {t.min_profit_usd === null ? (
            <StatusChip tone="warning" className="shrink-0">
              {say(TYPES.incomplete, lang)}
            </StatusChip>
          ) : null}
        </div>
        {!editing ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)} data-type-edit={t.key}>
            {say(TYPES.edit, lang)}
          </Button>
        ) : null}
      </div>
      <p className="text-[12px] text-text-secondary">{say(SOURCING_LABELS[t.sourcing], lang)}</p>
      {t.warnings.map((w) => (
        <p key={w} role="alert" className="lv-alert lv-alert-warning text-[12px] leading-relaxed text-text-primary" data-type-warning={w}>
          {TYPE_WARNINGS[w] ? say(TYPE_WARNINGS[w]!, lang) : w}
        </p>
      ))}

      {!editing ? (
        <dl className="grid gap-x-4 gap-y-1.5 text-[12px] [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
          <Fact label={say(TYPES.route, lang)}>{say(ROUTE_LABELS[t.route], lang)}</Fact>
          {t.sourcing === 'CHINA_CNY' && !SEA_ONLY.has(t.key) ? <Fact label={say(TYPES.allowAir, lang)}>{t.allow_air ? '✓' : '—'}</Fact> : null}
          {t.sourcing === 'EU_STORE_EUR' ? <Fact label={say(TYPES.usReference, lang)}>{t.us_reference_allowed ? '✓' : '—'}</Fact> : null}
          <Fact label={say(TYPES.defaultWeight, lang)}>{figure(t.default_weight_g === null ? '' : groupWhole(t.default_weight_g))}</Fact>
          <Fact label={say(TYPES.defaultBox, lang)}>{figure(box)}</Fact>
          <Fact label={say(TYPES.defaultCbm, lang)}>{figure(t.default_cbm ? groupDecimal(t.default_cbm) : '')}</Fact>
          <Fact label={say(TYPES.additional, lang)}>{figure(t.additional_cost_iqd === null ? '' : iqdText(t.additional_cost_iqd, lang))}</Fact>
          <Fact label={say(TYPES.minProfit, lang)}>{figure(t.min_profit_usd ? `$${groupDecimal(t.min_profit_usd)}` : '')}</Fact>
          <Fact label={say(TYPES.staleDays, lang)}>{figure(String(t.stale_after_days))}</Fact>
        </dl>
      ) : (
        <div className="space-y-3" data-type-form={t.key}>
          <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
            <Field label={say(TYPES.route, lang)}>
              <Select value={draft.route} onChange={(e) => set('route', e.target.value as EstimateRoute)} disabled={routes.length < 2} data-type-route>
                {(routes.includes(draft.route) ? routes : [draft.route, ...routes]).map((r) => (
                  <option key={r} value={r}>
                    {say(ROUTE_LABELS[r], lang)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="space-y-1 pt-6">
              {t.sourcing === 'CHINA_CNY' && !SEA_ONLY.has(t.key) ? (
                <Checkbox
                  checked={draft.allow_air}
                  onChange={(v) => setDraft((d) => ({ ...d, allow_air: v, route: !v && d.route === 'air' ? 'sea' : d.route }))}
                  label={say(TYPES.allowAir, lang)}
                />
              ) : null}
              {t.sourcing === 'EU_STORE_EUR' ? <Checkbox checked={draft.us_reference_allowed} onChange={(v) => set('us_reference_allowed', v)} label={say(TYPES.usReference, lang)} /> : null}
            </div>
            <Field label={say(TYPES.defaultWeight, lang)} error={errors.weight}>
              <Input ltr inputMode="numeric" value={draft.weight} onChange={(e) => set('weight', e.target.value)} data-type-weight />
            </Field>
            <Field label={say(TYPES.additional, lang)} error={errors.additional}>
              <Input ltr inputMode="numeric" value={draft.additional} onChange={(e) => set('additional', e.target.value)} data-type-additional />
            </Field>
          </div>
          <fieldset className="min-w-0 space-y-1.5">
            <legend className="mb-1.5 text-[13px] font-semibold text-text-secondary">{say(TYPES.defaultBox, lang)}</legend>
            <div className="grid grid-cols-3 gap-2">
              {(['length', 'width', 'height'] as const).map((k) => (
                <Input key={k} ltr inputMode="numeric" aria-label={say(TYPES[k], lang)} placeholder={say(TYPES[k], lang)} value={draft[k]} onChange={(e) => set(k, e.target.value)} data-type-box={k} />
              ))}
            </div>
            {errors.box ? <p className="lv-field-error">{errors.box}</p> : null}
          </fieldset>
          <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
            <Field label={say(TYPES.defaultCbm, lang)} error={errors.cbm}>
              <Input ltr inputMode="decimal" value={draft.cbm} onChange={(e) => set('cbm', e.target.value)} data-type-cbm />
            </Field>
            <Field label={say(TYPES.minProfit, lang)} error={errors.minProfit}>
              <Input ltr inputMode="decimal" value={draft.minProfit} onChange={(e) => set('minProfit', e.target.value)} data-type-min-profit />
            </Field>
            <Field label={say(TYPES.staleDays, lang)} error={errors.staleDays}>
              <Input ltr inputMode="numeric" value={draft.staleDays} onChange={(e) => set('staleDays', e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:repeat(3,minmax(0,1fr))]">
            <Field label={say(TYPES.nameAr, lang)}>
              <Input dir="rtl" maxLength={80} value={draft.name_ar} onChange={(e) => set('name_ar', e.target.value)} />
            </Field>
            <Field label={say(TYPES.nameEn, lang)}>
              <Input dir="ltr" maxLength={80} value={draft.name_en} onChange={(e) => set('name_en', e.target.value)} />
            </Field>
            <Field label={say(TYPES.nameCkb, lang)} error={errors.names}>
              <Input dir="rtl" maxLength={80} value={draft.name_ckb} onChange={(e) => set('name_ckb', e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={act.busy === 'save'} disabled={!!act.busy && act.busy !== 'save'} onClick={save} data-type-save={t.key}>
              {say(TYPES.save, lang)}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(draftOf(t));
                setErrors({});
                setEditing(false);
              }}
            >
              {say(COMMON.cancel, lang)}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<Lightbulb aria-hidden="true" className="h-4 w-4" />} loading={act.busy === 'suggest'} onClick={() => void suggest()} data-type-suggest={t.key}>
          {say(TYPES.suggest, lang)}
        </Button>
      </div>
      {suggestion ? (
        <div className="space-y-2 rounded-xl border border-border-subtle/60 p-3 text-[12px] text-text-secondary" data-type-suggestion={t.key}>
          {suggestion.count === 0 ? (
            <p>{say(TYPES.noSuggestion, lang)}</p>
          ) : (
            <>
              <p>
                {say(TYPES.suggestion, lang, {
                  n: suggestion.count,
                  weight: suggestion.weight_g === null ? '—' : say(TYPES.grams, lang, { n: groupWhole(suggestion.weight_g) }),
                  box: suggestion.box ? suggestion.box.map((a) => groupWhole(a)).join(' × ') : '—',
                  cbm: suggestion.cbm ? groupDecimal(suggestion.cbm) : '—',
                })}
              </p>
              <p className="text-text-muted">{say(TYPES.suggestionNote, lang)}</p>
              <Button size="sm" variant="secondary" onClick={useSuggestion}>
                {say(TYPES.useSuggestion, lang)}
              </Button>
            </>
          )}
        </div>
      ) : null}
      <ActNote message={act.message} lang={lang} />
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 border-b border-border-subtle/60 py-1">
      <dt className="text-text-muted">{label}</dt>
      <dd className="min-w-0 text-end text-text-primary">{children}</dd>
    </div>
  );
}

/** «نوع جديد»: its key, three names, sourcing and route; every figure is typed afterwards. */
function NewTypeCard({ lang, existing, onCreated }: { lang: UiLang; existing: readonly string[]; onCreated: () => void }) {
  const act = useAct(lang);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [names, setNames] = useState({ ar: '', en: '', ckb: '' });
  const [sourcing, setSourcing] = useState<EstimateSourcing>('CHINA_CNY');
  const [allowAir, setAllowAir] = useState(false);
  const [usRef, setUsRef] = useState(false);
  const [route, setRoute] = useState<EstimateRoute>('sea');
  const [errors, setErrors] = useState<{ key?: string; names?: string }>({});
  const routes = useMemo(() => allowedRoutes({ key, sourcing }, allowAir), [key, sourcing, allowAir]);
  useEffect(() => {
    if (!routes.includes(route)) setRoute(routes[0]!);
  }, [routes, route]);

  const create = async () => {
    const next: typeof errors = {};
    const k = key.trim();
    if (!/^[a-z_]{2,40}$/.test(k) || existing.includes(k)) next.key = say(TYPES.keyInvalid, lang);
    const n = { ar: names.ar.trim(), en: names.en.trim(), ckb: names.ckb.trim() };
    if (Object.values(n).some((x) => x.length < 1 || x.length > 80)) next.names = say(TYPES.nameInvalid, lang);
    else if (n.ckb === n.ar) next.names = say(TYPES.nameCkbSame, lang);
    setErrors(next);
    if (next.key || next.names) return;
    await act.run(
      'create',
      () =>
        createType({
          key: k,
          name_ar: n.ar,
          name_en: n.en,
          name_ckb: n.ckb,
          sourcing,
          route,
          ...(sourcing === 'CHINA_CNY' && !SEA_ONLY.has(k) ? { allow_air: allowAir } : {}),
          ...(sourcing === 'EU_STORE_EUR' ? { us_reference_allowed: usRef } : {}),
        }),
      () => {
        onCreated();
        setOpen(false);
        setKey('');
        setNames({ ar: '', en: '', ckb: '' });
        return { tone: 'success', text: say(TYPES.created, lang) };
      }
    );
  };

  return (
    <section className="lv-surface space-y-3 p-4" data-estimate-type-new>
      {!open ? (
        <Button variant="secondary" icon={<Plus aria-hidden="true" className="h-4 w-4" />} onClick={() => setOpen(true)}>
          {say(TYPES.newTitle, lang)}
        </Button>
      ) : (
        <>
          <h3 className="text-[15px] font-bold text-text-primary">{say(TYPES.newTitle, lang)}</h3>
          <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
            <Field label={say(TYPES.newKey, lang)} error={errors.key}>
              <Input ltr maxLength={40} autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} data-type-new-key />
            </Field>
            <Field label={say(TYPES.sourcing, lang)}>
              <Select value={sourcing} onChange={(e) => setSourcing(e.target.value as EstimateSourcing)}>
                {(['CHINA_CNY', 'EU_STORE_EUR'] as const).map((s) => (
                  <option key={s} value={s}>
                    {say(SOURCING_LABELS[s], lang)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={say(TYPES.route, lang)}>
              <Select value={route} onChange={(e) => setRoute(e.target.value as EstimateRoute)} disabled={routes.length < 2}>
                {routes.map((r) => (
                  <option key={r} value={r}>
                    {say(ROUTE_LABELS[r], lang)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="space-y-1 pt-6">
              {sourcing === 'CHINA_CNY' && !SEA_ONLY.has(key.trim()) ? <Checkbox checked={allowAir} onChange={setAllowAir} label={say(TYPES.allowAir, lang)} /> : null}
              {sourcing === 'EU_STORE_EUR' ? <Checkbox checked={usRef} onChange={setUsRef} label={say(TYPES.usReference, lang)} /> : null}
            </div>
          </div>
          <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:repeat(3,minmax(0,1fr))]">
            <Field label={say(TYPES.nameAr, lang)}>
              <Input dir="rtl" maxLength={80} value={names.ar} onChange={(e) => setNames((n) => ({ ...n, ar: e.target.value }))} />
            </Field>
            <Field label={say(TYPES.nameEn, lang)}>
              <Input dir="ltr" maxLength={80} value={names.en} onChange={(e) => setNames((n) => ({ ...n, en: e.target.value }))} />
            </Field>
            <Field label={say(TYPES.nameCkb, lang)} error={errors.names}>
              <Input dir="rtl" maxLength={80} value={names.ckb} onChange={(e) => setNames((n) => ({ ...n, ckb: e.target.value }))} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={act.busy === 'create'} onClick={create} data-type-create>
              {say(TYPES.create, lang)}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {say(COMMON.cancel, lang)}
            </Button>
          </div>
        </>
      )}
      <ActNote message={act.message} lang={lang} />
    </section>
  );
}
