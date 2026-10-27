/**
 * STEP 3, «التسليم والميزانية» (community UI plan C4, §4; IMG_8477; P1-06,
 * owner answer Q2; docs/DECISIONS.md row 268): where it goes, how it is
 * handed over, by when, and the budget with its switch.
 *
 *   «المحافظة»        a select button that opens the governorates as native
 *                     radios in a sheet («لم أحدد» first); the focus comes
 *                     back to the button when the sheet closes
 *   «طريقة الاستلام»  three tiles: توصيل · استلام بنفسي · أيهما
 *   «أحتاجه قبل»      the native date field (today to a year ahead) and the
 *                     same day written out in words, so 05/11 is never read
 *                     as the eleventh of May
 *   «الميزانية»       the money field with its unit, then the Q2 switch
 *
 * THE BUDGET IS PRIVATE BY DEFAULT. «اعرض ميزانيتي للتجار» is off until the
 * customer turns it on, and the line under it says what that means now:
 * hidden from merchants and the public; or seen by the merchants who can make
 * the request (a direct request: this store alone), never by the public. The
 * hint the reference draws under the field (that the makers see it) is not
 * used: it would promise the opposite of the default. The switch appears
 * once there is a budget to show (design critique 19).
 */
import { useId, useRef, useState } from 'react';
import { ArrowLeftRight, MapPin, Store, Truck } from 'lucide-react';
import { GOVERNORATES } from '../../../../lib/governorates';
import { iqdUnit } from '../../../../lib/money';
import { formatDate } from '../../../orders/format';
import { NumberInput } from '../../../ui/NumberInput';
import { Sheet } from '../../../ui/Sheet';
import { ChoiceTiles, Toggle } from '../../kit/controls';
import { SelectButton } from '../../kit/fields';
import { SectionCard } from '../../kit/display';
import { useSheetPlacement } from './useKeyboardOpen';
import type { DeliveryFields as Delivery } from './state';
import type { EditorLang, EditorStrings } from './strings';

const isoDay = (ahead = 0) => new Date(Date.now() + ahead * 86_400_000).toISOString().slice(0, 10);

/** «5 نوفمبر 2026»: a chosen day in words (noon, so no time zone moves it a day). */
export function dayInWords(day: string, lang: EditorLang): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? formatDate(`${day}T12:00:00`, lang) : '';
}

/** The governorate in the reader language, or «لم أحدد». */
export function governorateWords(id: string, lang: EditorLang, t: EditorStrings): string {
  const g = GOVERNORATES.find((x) => x.id === id);
  return g ? g[lang] : t.notSet;
}

/** The handover in words: '' is «أيهما». */
export function handoverWords(h: string, t: EditorStrings): string {
  return h === 'delivery' ? t.handoverDelivery : h === 'pickup' ? t.handoverPickup : t.handoverEither;
}

/** The line under the budget switch: what the switch means now. */
export function budgetLine(d: Pick<Delivery, 'budgetVisible'>, direct: boolean, t: EditorStrings): string {
  return !d.budgetVisible ? t.budgetOff : direct ? t.budgetOnDirect : t.budgetOn;
}

function GovernoratePicker({ open, value, onChoose, onClose, lang, t }: { open: boolean; value: string; onChoose: (id: string) => void; onClose: () => void; lang: EditorLang; t: EditorStrings }) {
  const placement = useSheetPlacement();
  const name = useId();
  const option = (id: string, label: string) => (
    <label key={id || 'none'} className="lv-choice flex min-h-12 w-full cursor-pointer items-center gap-3 px-3 py-2 text-start" data-governorate-option={id || 'none'}>
      <input
        type="radio"
        name={name}
        value={id}
        checked={value === id}
        onChange={() => {
          onChoose(id);
          onClose();
        }}
        className="h-[18px] w-[18px] shrink-0 accent-gold"
      />
      <span className="min-w-0 flex-1 text-[15px] font-semibold text-text-primary">{label}</span>
    </label>
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={t.governoratePick}
      {...placement}
      detents={['large']}
      testId="governorate-picker"
      header={<h2 className="px-4 pb-2 pt-1 text-[15px] font-bold text-text-primary">{t.governoratePick}</h2>}
    >
      <fieldset className="space-y-2 px-4 pb-4">
        <legend className="sr-only">{t.governoratePick}</legend>
        {option('', t.notSet)}
        {GOVERNORATES.map((g) => option(g.id, g[lang]))}
      </fieldset>
    </Sheet>
  );
}

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
  const [picking, setPicking] = useState(false);
  const govButton = useRef<HTMLButtonElement | null>(null);
  const hasBudget = value.budget !== null && value.budget > 0;
  const day = dayInWords(value.deadline, lang);
  const ids = useId();
  return (
    <div className="space-y-3" data-editor="delivery">
      <SectionCard title={t.governorate} data-editor-card="governorate" id="editor-governorate">
        <SelectButton
          ref={govButton}
          icon={<MapPin className="h-5 w-5" />}
          value={value.governorate ? governorateWords(value.governorate, lang, t) : ''}
          placeholder={t.notSet}
          expanded={picking}
          aria-label={`${t.governorate}: ${governorateWords(value.governorate, lang, t)}`}
          onClick={() => setPicking(true)}
          data-editor="governorate"
        />
      </SectionCard>
      {picking && (
        <GovernoratePicker
          open
          value={value.governorate}
          onChoose={(id) => onChange({ governorate: id })}
          onClose={() => {
            setPicking(false);
            requestAnimationFrame(() => govButton.current?.focus());
          }}
          lang={lang}
          t={t}
        />
      )}

      <SectionCard title={t.handoverTitle} data-editor-card="handover">
        <ChoiceTiles
          label={t.handoverTitle}
          columns={3}
          value={value.handover || 'either'}
          onChange={(id) => onChange({ handover: id === 'either' ? '' : id })}
          items={[
            { id: 'delivery', title: t.handoverDelivery, icon: <Truck className="h-5 w-5" strokeWidth={1.75} /> },
            { id: 'pickup', title: t.handoverPickup, icon: <Store className="h-5 w-5" strokeWidth={1.75} /> },
            { id: 'either', title: t.handoverEither, icon: <ArrowLeftRight className="h-5 w-5" strokeWidth={1.75} /> },
          ]}
        />
      </SectionCard>

      <SectionCard title={t.deadline} optional data-editor-card="deadline">
        <label htmlFor={`${ids}-day`} className="sr-only">
          {t.deadline}
        </label>
        <div>
          <input
            id={`${ids}-day`}
            type="date"
            dir="ltr"
            className="lv-input min-h-12"
            min={published && value.deadline && value.deadline < isoDay() ? undefined : isoDay()}
            max={isoDay(366)}
            value={value.deadline}
            aria-describedby={`${ids}-day-words`}
            onChange={(e) => onChange({ deadline: e.target.value })}
            data-editor="deadline"
          />
        </div>
        <p id={`${ids}-day-words`} className="mt-1.5 text-ui-xs text-text-muted" data-editor-deadline-words>
          {day || t.deadlineHint}
        </p>
      </SectionCard>

      <SectionCard title={t.budgetTitle} optional data-editor-card="budget" id="editor-budget">
        <label htmlFor={`${ids}-budget`} className="sr-only">
          {t.budget}
        </label>
        <NumberInput
          id={`${ids}-budget`}
          kind="money"
          unit={iqdUnit(lang)}
          value={value.budget}
          aria-describedby={`${ids}-budget-line`}
          onValueChange={(v, ok) => ok && onChange({ budget: v && v > 0 ? v : null, ...(v && v > 0 ? {} : { budgetVisible: false }) })}
          data-editor="budget-input"
        />
        <p id={`${ids}-budget-line`} className="mt-1.5 text-ui-xs text-text-muted">
          {hasBudget ? budgetLine(value, direct, t) : t.budgetOptional}
        </p>
        {hasBudget && (
          <div className="mt-2 border-t border-border-subtle pt-2" data-editor-budget-switch={value.budgetVisible ? 'on' : 'off'}>
            <Toggle checked={value.budgetVisible} onChange={(on) => onChange({ budgetVisible: on })} label={direct ? t.budgetSwitchDirect : t.budgetSwitch} />
          </div>
        )}
      </SectionCard>
    </div>
  );
}
