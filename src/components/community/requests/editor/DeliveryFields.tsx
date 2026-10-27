/**
 * «التسليم والميزانية» — where it goes, by when, notes for the merchants, and
 * the budget with its switch (plan P1-06, owner answer Q2; docs/DECISIONS.md
 * row 268).
 *
 * THE BUDGET IS PRIVATE BY DEFAULT. «اعرض ميزانيتي للتجار» is off until the
 * customer turns it on, and the line under it says what that means now:
 * hidden from merchants and the public; or seen by the merchants who can make
 * the request (a direct request: this store alone), never by the public. The
 * switch appears once there is a budget to show (design critique 19).
 */
import { GOVERNORATES } from '../../../../lib/governorates';
import { Field, Input, Select, Textarea } from '../../../ui/Field';
import { NumberInput } from '../../../ui/NumberInput';
import { Segmented } from '../../../ui/Segmented';
import { Switch } from '../../../ui/Switch';
import type { DeliveryFields as Delivery } from './state';
import type { EditorLang, EditorStrings } from './strings';

const isoDay = (ahead = 0) => new Date(Date.now() + ahead * 86_400_000).toISOString().slice(0, 10);

export function DeliveryFields({
  value,
  direct,
  published,
  onChange,
  lang,
  t,
}: {
  value: Delivery;
  /** A request for one store: the switch and its line name the store. */
  direct: boolean;
  /** A published request: the deadline keeps a date that has passed until it is changed. */
  published: boolean;
  onChange: (patch: Partial<Delivery>) => void;
  lang: EditorLang;
  t: EditorStrings;
}) {
  const hasBudget = value.budget !== null && value.budget > 0;
  const line = !value.budgetVisible ? t.budgetOff : direct ? t.budgetOnDirect : t.budgetOn;
  return (
    <div className="space-y-4" data-editor="delivery">
      <Field label={t.governorate} optional>
        <Select value={value.governorate} onChange={(e) => onChange({ governorate: e.target.value })} data-editor="governorate">
          <option value="">{t.notSet}</option>
          {GOVERNORATES.map((g) => (
            <option key={g.id} value={g.id}>
              {g[lang]}
            </option>
          ))}
        </Select>
      </Field>
      <div>
        <p className="mb-2 text-[13px] font-semibold text-text-secondary">{t.handover}</p>
        <Segmented
          group="editor-handover"
          label={t.handover}
          value={value.handover || 'either'}
          onChange={(id) => onChange({ handover: id === 'either' ? '' : id })}
          items={[
            { id: 'delivery', label: t.handoverDelivery },
            { id: 'pickup', label: t.handoverPickup },
            { id: 'either', label: t.handoverEither },
          ]}
        />
      </div>
      <Field label={t.deadline} optional hint={t.deadlineHint}>
        <Input
          ltr
          type="date"
          min={published && value.deadline && value.deadline < isoDay() ? undefined : isoDay()}
          max={isoDay(366)}
          value={value.deadline}
          onChange={(e) => onChange({ deadline: e.target.value })}
          data-editor="deadline"
        />
      </Field>
      <Field label={t.notesForMerchants} optional hint={t.notesHint}>
        <Textarea dir="auto" rows={3} maxLength={1000} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} data-editor="notes" />
      </Field>
      <div className="lv-surface space-y-1 px-3 py-3" data-editor="budget">
        <Field label={t.budget} optional hint={t.budgetOptional}>
          <NumberInput
            kind="money"
            value={value.budget}
            onValueChange={(v, ok) => ok && onChange({ budget: v && v > 0 ? v : null })}
            data-editor="budget-input"
          />
        </Field>
        {hasBudget && (
          <div data-editor-budget-switch={value.budgetVisible ? 'on' : 'off'}>
            <Switch
              checked={value.budgetVisible}
              onChange={(on) => onChange({ budgetVisible: on })}
              label={direct ? t.budgetSwitchDirect : t.budgetSwitch}
              description={line}
            />
          </div>
        )}
      </div>
    </div>
  );
}
