/**
 * Create or edit one catalogue row — a form GENERATED from the client field
 * description (catalogFields.ts), which mirrors the server's `ENTITIES`.
 *
 *   - an immutable field is read-only on edit (it may be set on create only);
 *   - a price field (money) is drawn disabled, with the reason, for an admin
 *     without money scope; a cost field is not drawn at all for a reader who
 *     may not see cost, and is disabled for one who may not write it;
 *   - what the server would refuse is said beside the field before the
 *     request (form.ts `validateForm`), and a refusal it still sends is shown
 *     in the reader's language with the field named.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Sheet } from '../../../ui/Sheet';
import { Switch } from '../../../ui/Switch';
import { toast } from '../../../../lib/toastStore';
import { pc, type Row } from '../../api';
import type { PcAccess } from '../../access';
import { type ClientEntity, type ClientField } from '../../catalogFields';
import { REASON, pick, tri, labelOf, type Tri } from '../../i18n';
import { bps, num } from '../../format';
import { pcRefusal } from '../../refusal';
import { invalidateRefs, type RefLists } from '../../refs';
import { Act, IntField, Note, SelectField, T, TextArea, TextField, W, usePcLang } from '../../ui';
import { BundleInput, ChipsInput, ColorInput, DurationInput, I18nInput, JsonInput, ModesInput, NumberList, ProjectTypeInput, ScopeInput, type BundleLine } from './fieldInputs';
import { formDefaults, formToBody, rowToForm, validateForm, visible, writable, type FormValue, type FormValues } from './form';

const S = {
  newTitle: tri('إضافة', 'New', 'نوێ'),
  editTitle: tri('تعديل', 'Edit', 'دەستکاری'),
  moneyLocked: tri('سعر أو شرط سعر: يغيّره المالك أو المدير المالي.', 'A price or a term of one: the owner or a full admin changes it.', 'نرخ یان مەرجێکی نرخ: خاوەن یان بەڕێوەبەری دارایی دەیگۆڕێت.'),
  costLocked: tri('تكلفة: للمالك وحده.', 'A cost: the owner’s alone.', 'تێچوو: تەنها هی خاوەن.'),
  immutable: tri('لا يتغيّر بعد الإنشاء', 'Fixed after creation', 'دوای دروستکردن ناگۆڕدرێت'),
  range: tri('المسموح', 'Allowed', 'ڕێگەپێدراو'),
  created: tri('أُنشئ.', 'Created.', 'دروستکرا.'),
  updated: tri('حُفظت التغييرات.', 'Changes saved.', 'گۆڕانکارییەکان پاشەکەوت کران.'),
  nothing: tri('لا تغيير لحفظه.', 'Nothing changed to save.', 'هیچ گۆڕانکارییەک نییە بۆ پاشەکەوت.'),
  fix: tri('صحّح الحقول المعلَّمة.', 'Correct the marked fields.', 'خانە نیشانەکراوەکان ڕاست بکەرەوە.'),
  priceLog: tri('كل تغيير سعر يُسجَّل في سجل الأسعار، وما بيع سابقاً يبقى بسعره.', 'Every price change is recorded in the price log; what was already sold keeps its price.', 'هەر گۆڕینێکی نرخ لە تۆماری نرخەکاندا تۆمار دەکرێت؛ ئەوەی پێشتر فرۆشراوە نرخی خۆی دەمێنێتەوە.'),
  emptyDefault: tri('فارغ = القيمة الافتراضية', 'Empty = the default', 'بەتاڵ = بەهای بنەڕەت'),
} satisfies Record<string, Tri>;

export function EntitySheet({
  entity,
  row,
  open,
  onClose,
  onSaved,
  access,
  refs,
}: {
  entity: ClientEntity;
  /** The row to edit; null for a new one. */
  row: Row | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  access: PcAccess;
  refs: RefLists;
}) {
  const { t, lang } = usePcLang();
  const original = useMemo(() => (row ? rowToForm(entity, row) : null), [entity, row]);
  const [values, setValues] = useState<FormValues>(() => original ?? formDefaults(entity));
  const [failure, setFailure] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const errors = useMemo(() => validateForm(entity, values, original, access), [entity, values, original, access]);
  const body = useMemo(() => formToBody(entity, values, original, access), [entity, values, original, access]);
  const dirty = Object.keys(body).length > 0;
  const titleId = `pc-entity-${entity.key}`;

  const labelOfField = (name: string) => {
    const f = entity.fields.find((x) => x.name === name);
    return f ? pick(f.label, lang) : null;
  };

  const submit = async () => {
    setFailure(null);
    if (Object.keys(errors).length) {
      setShowErrors(true);
      setFailure(t(S.fix));
      return;
    }
    if (!dirty) {
      setFailure(t(S.nothing));
      return;
    }
    try {
      if (row) await pc.patch(`/catalog/${entity.key}/${encodeURIComponent(String(row.id))}`, body);
      else await pc.post(`/catalog/${entity.key}`, body);
      toast.success(t(row ? S.updated : S.created));
      // The names other sections print may have changed.
      const own = (['tiers', 'packages', 'printer_models', 'products', 'variants'] as const).find((k) => k === entity.key);
      if (own) invalidateRefs(own);
      onSaved();
      onClose();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed), labelOfField));
    }
  };

  const set = (name: string, v: FormValue) => {
    setFailure(null);
    setValues((cur) => ({ ...cur, [name]: v }));
  };

  const title = `${t(row ? S.editTitle : S.newTitle)} — ${pick(entity.label, lang)}`;
  const anyMoney = entity.fields.some((f) => f.money);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      dirty={dirty}
      panelClassName="ap w-full sm:max-w-2xl"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
            {title}
          </h2>
          <p className={`mt-0.5 text-[12px] ${T.text3}`}>{pick(entity.help, lang)}</p>
          {row && (
            <p className={`mt-0.5 text-[11px] ${T.text3}`}>
              <bdi dir="ltr" className="font-mono">{String(row.id)}</bdi>
            </p>
          )}
        </div>
      }
      footer={
        <div className="space-y-2">
          {failure && <p className="lv-field-error">{failure}</p>}
          <div className="flex flex-wrap gap-2">
            <Act kind="primary" onClick={submit}>
              {t(row ? W.save : W.create)}
            </Act>
            <Act kind="ghost" onClick={onClose}>
              {t(W.cancel)}
            </Act>
          </div>
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-5">
        {anyMoney && <Note tone="info">{t(S.priceLog)}</Note>}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {entity.fields
            .filter((f) => visible(f, access))
            .map((f) => (
              <FieldControl
                key={f.name}
                field={f}
                value={values[f.name]}
                onChange={(v) => set(f.name, v)}
                locked={!writable(f, access) || (!!row && !!f.immutable)}
                lockReason={!!row && f.immutable ? t(S.immutable) : f.cost && !access.costWrite ? t(S.costLocked) : f.money && !access.money ? t(S.moneyLocked) : undefined}
                error={showErrors || (row !== null && f.name in body) ? (errors[f.name] ? labelOf(REASON, errors[f.name], lang) : null) : null}
                refs={refs}
                isNew={!row}
              />
            ))}
        </div>
      </div>
    </Sheet>
  );
}

/** One field, drawn from its kind and its editor. */
function FieldControl({
  field: f,
  value,
  onChange,
  locked,
  lockReason,
  error,
  refs,
  isNew,
}: {
  field: ClientField;
  value: FormValue;
  onChange: (v: FormValue) => void;
  locked: boolean;
  lockReason?: string;
  error: string | null;
  refs: RefLists;
  isNew: boolean;
}) {
  const { t, lang } = usePcLang();
  const label = pick(f.label, lang);
  const unit = f.unit ? pick(f.unit, lang) : undefined;
  const bits: string[] = [];
  if (f.help) bits.push(pick(f.help, lang));
  if (f.kind === 'int' && (f.min !== undefined || f.max !== undefined)) bits.push(`${t(S.range)}: ${num(f.min)}–${num(f.max)}`);
  if (f.bps && typeof value === 'number') bits.push(`= ${bps(value)}`);
  if (isNew && !f.required && (f.kind === 'int' || f.kind === 'iso') && f.nullable) bits.push(t(S.emptyDefault));
  if (lockReason) bits.push(lockReason);
  const hint = bits.join(' · ') || undefined;
  const wide = f.kind === 'text' || f.kind === 'json_object' || f.editor === 'bundle' || f.editor === 'chips' || f.editor === 'materials' || f.editor === 'scope';
  const cell = wide ? 'md:col-span-2' : '';
  let control: ReactNode;
  if (f.kind === 'bool') {
    control = <Switch checked={value === true} onChange={onChange} label={label} description={hint} disabled={locked} />;
  } else if (f.editor === 'duration') {
    control = <DurationInput label={label} value={value as number | null} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.editor === 'microns') {
    control = <NumberList label={label} unit={unit} value={(value as number[]) ?? []} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.editor === 'materials' || f.editor === 'chips') {
    control = <ChipsInput label={label} materials={f.editor === 'materials'} value={(value as string[]) ?? []} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.editor === 'modes') {
    control = <ModesInput label={label} value={(value as string[]) ?? []} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.editor === 'bundle') {
    control = <BundleInput label={label} value={(value as BundleLine[]) ?? []} onChange={onChange} disabled={locked} error={error} hint={hint} refs={refs} />;
  } else if (f.editor === 'i18n') {
    control = <I18nInput label={label} value={(value as Row) ?? {}} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.editor === 'json') {
    control = <JsonInput label={label} value={String(value ?? '{}')} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.editor === 'scope') {
    control = <ScopeInput label={label} value={String(value ?? '')} onChange={onChange} disabled={locked} error={error} hint={hint} refs={refs} />;
  } else if (f.editor === 'color') {
    control = <ColorInput label={label} value={String(value ?? '')} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.editor === 'project_type') {
    control = <ProjectTypeInput label={label} value={String(value ?? '')} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.kind === 'int') {
    control = <IntField label={label} unit={unit} value={value as number | null} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.kind === 'enum') {
    control = (
      <SelectField
        label={label}
        value={String(value ?? '')}
        placeholder={f.required ? undefined : '—'}
        options={(f.values ?? []).map((v) => ({ value: v, label: f.valueLabels?.[v] ? pick(f.valueLabels[v], lang) : v }))}
        onChange={onChange}
        disabled={locked}
        error={error}
        hint={hint}
      />
    );
  } else if (f.kind === 'ref' && f.ref) {
    const opts = refs.options(f.ref);
    const current = String(value ?? '');
    // A stored id the list does not hold (an inactive row, a list still loading) stays selectable as itself.
    const withCurrent = current && !opts.some((o) => o.value === current) ? [{ value: current, label: current }, ...opts] : opts;
    control = <SelectField label={label} value={current} placeholder="—" options={withCurrent} onChange={onChange} disabled={locked} error={error} hint={hint} />;
  } else if (f.kind === 'iso') {
    control = <TextField type="datetime-local" label={label} value={String(value ?? '')} onChange={onChange} disabled={locked} error={error} hint={hint} ltr />;
  } else if (f.kind === 'text') {
    control = <TextArea label={label} value={String(value ?? '')} onChange={onChange} disabled={locked} error={error} hint={hint} maxLength={f.max} rows={3} ltr={f.name.endsWith('_en')} />;
  } else {
    const ltr = f.kind === 'code' || f.name.endsWith('_en') || f.name.includes('serial') || f.name.includes('code') || f.name.endsWith('_id') || f.name.endsWith('_ref');
    control = <TextField label={label} value={String(value ?? '')} onChange={onChange} disabled={locked} error={error} hint={hint} maxLength={f.max ?? (f.kind === 'code' ? 64 : 200)} ltr={ltr} />;
  }
  return (
    <div className={`min-w-0 ${cell}`} data-pc-field={f.name}>
      {control}
    </div>
  );
}
