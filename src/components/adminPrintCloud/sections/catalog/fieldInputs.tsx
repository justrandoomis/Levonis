/**
 * The structured editors of the catalogue form — one per `FieldEditor`
 * (catalogFields.ts): a JSON column is edited as what it means (a list of
 * nozzle sizes, material chips, fulfilment boxes, bundled material lines, a
 * three-language text, a promotion's scope) and only falls back to a
 * validated JSON box where the shape is free (a specification object).
 */
import { useEffect, useId, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Checkbox } from '../../../ui/Switch';
import type { Row } from '../../api';
import { FULFILMENT_MODES, MATERIAL_RE, PROJECT_TYPES, SCOPE_TYPES } from '../../catalogFields';
import { pick, tri, type Tri } from '../../i18n';
import { duration } from '../../format';
import * as T from '../../../adminProducts/theme';
import { IntField, Labeled, SelectField, TextArea, TextField, usePcLang } from '../../ui';
import type { RefLists } from '../../refs';

const S = {
  hours: tri('ساعات', 'Hours', 'کاتژمێر'),
  minutes: tri('دقائق', 'Minutes', 'خولەک'),
  seconds: tri('ثوانٍ', 'Seconds', 'چرکە'),
  add: tri('إضافة', 'Add', 'زیادکردن'),
  remove: tri('حذف', 'Remove', 'سڕینەوە'),
  empty: tri('لا شيء بعد', 'None yet', 'هێشتا هیچ'),
  badItem: tri('قيمة غير صالحة', 'Invalid value', 'بەهایەکی نادروست'),
  variant: tri('الصنف', 'Variant', 'جۆر'),
  qty: tri('الكمية (بوحدة الصنف)', 'Quantity (in the variant’s unit)', 'بڕ (بە یەکەی جۆرەکە)'),
  value: tri('قيمتها المعلنة من سعر الباقة (د.ع)', 'Its declared share of the package price (IQD)', 'بەشی ڕاگەیەندراوی لە نرخی پاکێج (د.ع)'),
  arabic: tri('بالعربية', 'Arabic', 'عەرەبی'),
  english: tri('بالإنجليزية', 'English', 'ئینگلیزی'),
  sorani: tri('بالكردية السورانية', 'Sorani Kurdish', 'کوردیی سۆرانی'),
  badJson: tri('ليس كائن JSON صالحاً', 'Not a valid JSON object', 'ئۆبجێکتێکی دروستی JSON نییە'),
  scopeType: tri('ينطبق على', 'Applies to', 'جێبەجێ دەبێت لەسەر'),
  scopeTarget: tri('الهدف', 'Target', 'ئامانج'),
  swatch: tri('معاينة اللون', 'Colour preview', 'پێشبینینی ڕەنگ'),
} satisfies Record<string, Tri>;

/** Integer seconds typed as hours, minutes and seconds. */
export function DurationInput({ label, value, onChange, disabled, error, hint }: { label: string; value: number | null; onChange: (v: number | null) => void; disabled?: boolean; error?: string | null; hint?: string }) {
  const { t, lang } = usePcLang();
  const split = (v: number | null) => (v === null ? [null, null, null] : [Math.floor(v / 3600), Math.floor((v % 3600) / 60), v % 60]);
  const [h, m, s] = split(value);
  const emit = (nh: number | null, nm: number | null, ns: number | null) => {
    if (nh === null && nm === null && ns === null) onChange(null);
    else onChange((nh ?? 0) * 3600 + (nm ?? 0) * 60 + (ns ?? 0));
  };
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className={`text-[12px] font-semibold ${T.text2}`}>{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        <IntField label={t(S.hours)} value={h} disabled={disabled} onChange={(v) => emit(v, m, s)} />
        <IntField label={t(S.minutes)} value={m} disabled={disabled} onChange={(v) => emit(h, v, s)} />
        <IntField label={t(S.seconds)} value={s} disabled={disabled} onChange={(v) => emit(h, m, v)} />
      </div>
      {error ? (
        <p className="lv-field-error">{error}</p>
      ) : (
        <p className={`text-[11px] ${T.text3}`}>
          {value !== null && <bdi dir="ltr">= {duration(value, lang)} · {value} s</bdi>}
          {hint && <span> · {hint}</span>}
        </p>
      )}
    </fieldset>
  );
}

/** A list of whole numbers (nozzle sizes in µm). */
export function NumberList({ label, value, onChange, disabled, error, hint, unit }: { label: string; value: number[]; onChange: (v: number[]) => void; disabled?: boolean; error?: string | null; hint?: string; unit?: string }) {
  const { t } = usePcLang();
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className={`text-[12px] font-semibold ${T.text2}`}>{label}</legend>
      <div className="flex flex-wrap items-end gap-2">
        {value.length === 0 && <span className={`text-[12px] ${T.text3}`}>{t(S.empty)}</span>}
        {value.map((n, i) => (
          <div key={i} className="flex items-end gap-1">
            <IntField className="w-28" label={`#${i + 1}`} unit={unit} value={Number.isFinite(n) ? n : null} disabled={disabled} onChange={(v) => onChange(value.map((x, j) => (j === i ? (v ?? Number.NaN) : x)))} />
            {!disabled && (
              <button type="button" className={T.btnIconGhost} aria-label={`${t(S.remove)} #${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <X size={14} aria-hidden />
              </button>
            )}
          </div>
        ))}
        {!disabled && (
          <button type="button" className={T.btnGhostSm} onClick={() => onChange([...value, value.length ? value[value.length - 1] : 400])}>
            <Plus size={13} aria-hidden />
            {t(S.add)}
          </button>
        )}
      </div>
      {error ? <p className="lv-field-error">{error}</p> : hint && <p className={`text-[11px] ${T.text3}`}>{hint}</p>}
    </fieldset>
  );
}

/** Strings as chips with an add box. `materials` checks the material-code pattern. */
export function ChipsInput({ label, value, onChange, disabled, error, hint, materials }: { label: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; error?: string | null; hint?: string; materials?: boolean }) {
  const { t } = usePcLang();
  const [draft, setDraft] = useState('');
  const [bad, setBad] = useState(false);
  const add = () => {
    const k = (materials ? draft.trim().toUpperCase() : draft.trim()).slice(0, 80);
    if (!k) return;
    if (materials && !MATERIAL_RE.test(k)) {
      setBad(true);
      return;
    }
    setBad(false);
    if (!value.includes(k)) onChange([...value, k]);
    setDraft('');
  };
  return (
    <div className="min-w-0 space-y-1.5">
      <p className={`text-[12px] font-semibold ${T.text2}`}>{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 && <span className={`text-[12px] ${T.text3}`}>{t(S.empty)}</span>}
        {value.map((k) => (
          <span key={k} className="inline-flex h-7 items-center gap-1 rounded-full bg-[var(--ap-surface-2)] ps-2.5 pe-1 text-[12px]" dir="ltr">
            <span className="font-mono">{k}</span>
            {!disabled && (
              <button type="button" className={T.btnIconGhost} aria-label={`${t(S.remove)}: ${k}`} onClick={() => onChange(value.filter((x) => x !== k))}>
                <X size={12} aria-hidden />
              </button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <div className="flex items-end gap-2">
          <TextField
            className="flex-1"
            label={t(S.add)}
            value={draft}
            ltr
            error={bad ? t(S.badItem) : null}
            onChange={(v) => {
              setDraft(v);
              setBad(false);
            }}
          />
          <button type="button" className={T.btnSecondary} onClick={add}>
            <Plus size={14} aria-hidden />
            {t(S.add)}
          </button>
        </div>
      )}
      {error ? <p className="lv-field-error">{error}</p> : hint && <p className={`text-[11px] ${T.text3}`}>{hint}</p>}
    </div>
  );
}

/** The fulfilment modes a variant allows, as check boxes. */
export function ModesInput({ label, value, onChange, disabled, error, hint }: { label: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; error?: string | null; hint?: string }) {
  const { lang } = usePcLang();
  return (
    <fieldset className="min-w-0 space-y-1">
      <legend className={`text-[12px] font-semibold ${T.text2}`}>{label}</legend>
      {Object.entries(FULFILMENT_MODES).map(([mode, words]) => (
        <Checkbox
          key={mode}
          checked={value.includes(mode)}
          disabled={disabled}
          label={pick(words, lang)}
          onChange={(on) => onChange(on ? [...value.filter((m) => m !== mode), mode] : value.filter((m) => m !== mode))}
        />
      ))}
      {error ? <p className="lv-field-error">{error}</p> : hint && <p className={`text-[11px] ${T.text3}`}>{hint}</p>}
    </fieldset>
  );
}

export interface BundleLine {
  variant_id: string;
  qty: number | null;
  value_iqd: number | null;
}

/** Material lines a bundle package grants with its hours. */
export function BundleInput({ label, value, onChange, disabled, error, hint, refs }: { label: string; value: BundleLine[]; onChange: (v: BundleLine[]) => void; disabled?: boolean; error?: string | null; hint?: string; refs: RefLists }) {
  const { t } = usePcLang();
  const set = (i: number, p: Partial<BundleLine>) => onChange(value.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className={`text-[12px] font-semibold ${T.text2}`}>{label}</legend>
      {value.length === 0 && <p className={`text-[12px] ${T.text3}`}>{t(S.empty)}</p>}
      {value.map((line, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <SelectField className="min-w-[12rem] flex-1" label={t(S.variant)} value={line.variant_id} placeholder="—" disabled={disabled} options={refs.options('variants')} onChange={(v) => set(i, { variant_id: v })} />
          <div className="grid min-w-[12rem] flex-1 grid-cols-2 gap-2">
            <IntField label={t(S.qty)} value={line.qty} disabled={disabled} onChange={(v) => set(i, { qty: v })} />
            <IntField label={t(S.value)} value={line.value_iqd} disabled={disabled} onChange={(v) => set(i, { value_iqd: v })} />
          </div>
          {!disabled && (
            <button type="button" className={T.btnIconDanger} aria-label={`${t(S.remove)} #${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 size={14} aria-hidden />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button type="button" className={T.btnGhostSm} onClick={() => onChange([...value, { variant_id: '', qty: null, value_iqd: 0 }])}>
          <Plus size={13} aria-hidden />
          {t(S.add)}
        </button>
      )}
      {error ? <p className="lv-field-error">{error}</p> : hint && <p className={`text-[11px] ${T.text3}`}>{hint}</p>}
    </fieldset>
  );
}

/** A `{ ar, en, ckb }` text object; any other key the stored object carries is kept. */
export function I18nInput({ label, value, onChange, disabled, error, hint }: { label: string; value: Row; onChange: (v: Row) => void; disabled?: boolean; error?: string | null; hint?: string }) {
  const { t } = usePcLang();
  const text = (k: string) => (typeof value[k] === 'string' ? (value[k] as string) : '');
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className={`text-[12px] font-semibold ${T.text2}`}>{label}</legend>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <TextArea label={t(S.arabic)} value={text('ar')} disabled={disabled} rows={2} maxLength={2000} onChange={(v) => onChange({ ...value, ar: v })} />
        <TextArea label={t(S.english)} value={text('en')} ltr disabled={disabled} rows={2} maxLength={2000} onChange={(v) => onChange({ ...value, en: v })} />
        <TextArea label={t(S.sorani)} value={text('ckb')} disabled={disabled} rows={2} maxLength={2000} onChange={(v) => onChange({ ...value, ckb: v })} />
      </div>
      {error ? <p className="lv-field-error">{error}</p> : hint && <p className={`text-[11px] ${T.text3}`}>{hint}</p>}
    </fieldset>
  );
}

/** A free JSON object, checked as it is typed. The value upstream is the text; the form parses it on save. */
export function JsonInput({ label, value, onChange, disabled, error, hint }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; error?: string | null; hint?: string }) {
  const { t } = usePcLang();
  const parsed = (() => {
    try {
      const v = JSON.parse(value || '{}') as unknown;
      return !!v && typeof v === 'object' && !Array.isArray(v);
    } catch {
      return false;
    }
  })();
  return <TextArea label={label} value={value} ltr disabled={disabled} rows={4} error={error ?? (parsed ? null : t(S.badJson))} hint={hint} onChange={onChange} />;
}

/** A promotion's scope: a kind, and the tier, variant or category it names. */
export function ScopeInput({ label, value, onChange, disabled, error, hint, refs }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; error?: string | null; hint?: string; refs: RefLists }) {
  const { t, lang } = usePcLang();
  const [kind, target] = value.includes(':') ? [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)] : [value, ''];
  const targets = kind === 'tier' ? refs.options('tiers') : kind === 'variant' ? refs.options('variants') : kind === 'category' ? refs.options('categories') : [];
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className={`text-[12px] font-semibold ${T.text2}`}>{label}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <SelectField
          label={t(S.scopeType)}
          value={kind}
          placeholder="—"
          disabled={disabled}
          options={Object.entries(SCOPE_TYPES).map(([k, w]) => ({ value: k, label: pick(w, lang) }))}
          onChange={(k) => onChange(k === 'tier' || k === 'variant' || k === 'category' ? `${k}:` : k)}
        />
        {targets.length > 0 || kind === 'tier' || kind === 'variant' || kind === 'category' ? (
          <SelectField label={t(S.scopeTarget)} value={target} placeholder="—" disabled={disabled} options={targets} onChange={(v) => onChange(`${kind}:${v}`)} />
        ) : null}
      </div>
      {error ? <p className="lv-field-error">{error}</p> : hint && <p className={`text-[11px] ${T.text3}`}>{hint}</p>}
    </fieldset>
  );
}

/** `#RRGGBB` with a swatch beside it. */
export function ColorInput({ label, value, onChange, disabled, error, hint }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; error?: string | null; hint?: string }) {
  const { t } = usePcLang();
  const ok = /^#[0-9A-Fa-f]{6}$/.test(value);
  return (
    <div className="flex min-w-0 items-end gap-2">
      <TextField className="flex-1" label={label} value={value} ltr disabled={disabled} error={error} hint={hint} onChange={(v) => onChange(v.trim())} />
      <span role="img" aria-label={t(S.swatch)} className="mb-1 h-8 w-8 shrink-0 rounded-full border border-[var(--ap-border-strong)]" style={ok ? { backgroundColor: value } : undefined} />
    </div>
  );
}

/** Free text with the project types offered (a suggestion, never a constraint: the column is free text). */
export function ProjectTypeInput({ label, value, onChange, disabled, error, hint }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; error?: string | null; hint?: string }) {
  const { lang } = usePcLang();
  const listId = `pc-project-types-${useId()}`;
  return (
    <Labeled label={label} hint={hint} error={error}>
      {(id, describedBy) => (
        <>
          <input id={id} className={T.input} dir="ltr" list={listId} value={value} disabled={disabled} maxLength={40} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
          <datalist id={listId}>
            {Object.entries(PROJECT_TYPES).map(([k, w]) => (
              <option key={k} value={k}>
                {pick(w, lang)}
              </option>
            ))}
          </datalist>
        </>
      )}
    </Labeled>
  );
}

/** Keep a JSON text box's text in step with an outside reset. */
export function useJsonText(initial: unknown): [string, (v: string) => void] {
  const [text, setText] = useState(() => JSON.stringify(initial ?? {}, null, 2));
  useEffect(() => {
    setText(JSON.stringify(initial ?? {}, null, 2));
  }, [initial]);
  return [text, setText];
}
