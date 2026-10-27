/**
 * THE PRINT SETTINGS FORM — quality, infill, supports, build plate, walls,
 * brim, nozzle, orientation, notes and copies — shared by the configure
 * screen and a job's «change settings».
 *
 * The values are the server's own (worker/lib/printCloud/projects.ts
 * `parseSettings`): micrometres, a percentage, the four support modes, the two
 * orientations. The form starts from what the server holds (the project's,
 * a saved profile's or the job's settings) and keeps any value it does not
 * list among its choices, so opening it never changes a setting by itself.
 * The nozzles offered are the printer model's own (`nozzle_options_um`).
 * Nothing here is a figure about the print: no time, no grams.
 */
import { Field, Select, Textarea } from '../../../components/ui/Field';
import { NumberInput } from '../../../components/ui/NumberInput';
import { Segmented } from '../../../components/ui/Segmented';
import { Switch } from '../../../components/ui/Switch';
import { formatFigure } from '../../../lib/localeNumber';
import { formatNozzle } from '../../format';
import { settingWords } from '../../strings/print';
import { useCloudText } from '../../text';
import type { PrintSettings } from '../../types';

/** Layer heights offered (µm); the server takes any from 40 to 600. */
const LAYER_UM = [80, 120, 160, 200, 240, 280];
/** Build plates offered (the slicer's own names); a plate the server holds that is not here is kept. */
const PLATE_TYPES = ['textured_pei', 'smooth_pei', 'cool_plate', 'engineering_plate', 'high_temp_plate'] as const;
const SUPPORTS = ['none', 'auto', 'tree', 'normal'] as const;

const withCurrent = <T,>(list: readonly T[], current: T): T[] => (list.includes(current) ? [...list] : [current, ...list]);

export interface SettingsFieldsProps {
  value: PrintSettings;
  onChange: (next: PrintSettings) => void;
  /** The chosen printer model's nozzles (µm); empty: only the current one is shown. */
  nozzles: number[];
  /** An arranged plate is chosen: the layout needs the model as uploaded. */
  plateChosen?: boolean;
  copies?: { value: number; onChange: (n: number) => void };
  /** Namespaces the radio groups when two forms could share a screen. */
  group: string;
}

export function SettingsFields({ value, onChange, nozzles, plateChosen = false, copies, group }: SettingsFieldsProps) {
  const { t, lang } = useCloudText();
  const set = <K extends keyof PrintSettings>(key: K, v: PrintSettings[K]) => onChange({ ...value, [key]: v });
  const quality = (um: number) => (um <= 120 ? settingWords.fine : um <= 200 ? settingWords.standard : settingWords.draft);
  const plateWord = (code: string) => (code in settingWords ? t(settingWords[code as (typeof PLATE_TYPES)[number]]) : code);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t(settingWords.layerHeight)}>
          <Select value={String(value.layer_height_um)} onChange={(e) => set('layer_height_um', Number(e.target.value))}>
            {withCurrent(LAYER_UM, value.layer_height_um).map((um) => (
              <option key={um} value={um}>
                {`${formatNozzle(um, lang)} · ${t(quality(um))}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t(settingWords.infill)}>
          <NumberInput
            value={value.infill_percent}
            decimals={0}
            min={0}
            max={100}
            unit="%"
            onValueChange={(n, valid) => {
              if (valid && n !== null) set('infill_percent', n);
            }}
          />
        </Field>
        <Field label={t(settingWords.plateType)}>
          <Select value={value.plate_type} onChange={(e) => set('plate_type', e.target.value)}>
            {withCurrent<string>(PLATE_TYPES, value.plate_type).map((code) => (
              <option key={code} value={code}>
                {plateWord(code)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t(settingWords.nozzle)}>
          <Select value={String(value.nozzle_um)} onChange={(e) => set('nozzle_um', Number(e.target.value))}>
            {withCurrent(nozzles, value.nozzle_um).map((um) => (
              <option key={um} value={um}>
                {formatNozzle(um, lang)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t(settingWords.walls)}>
          <NumberInput
            kind="quantity"
            value={value.walls}
            min={1}
            max={20}
            onValueChange={(n, valid) => {
              if (valid && n !== null) set('walls', n);
            }}
          />
        </Field>
        {copies ? (
          <Field label={t(settingWords.copies)}>
            <NumberInput
              kind="quantity"
              value={copies.value}
              min={1}
              max={500}
              onValueChange={(n, valid) => {
                if (valid && n !== null) copies.onChange(n);
              }}
            />
          </Field>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <p className="text-[13px] font-semibold text-text-secondary">{t(settingWords.supports)}</p>
        <Segmented
          group={`${group}-supports`}
          label={t(settingWords.supports)}
          value={value.supports}
          onChange={(id) => set('supports', id as PrintSettings['supports'])}
          items={SUPPORTS.map((s) => ({ id: s, label: t(settingWords[`supports_${s}`]) }))}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-[13px] font-semibold text-text-secondary">{t(settingWords.orientation)}</p>
        <Segmented
          group={`${group}-orientation`}
          label={t(settingWords.orientation)}
          value={plateChosen ? 'as_uploaded' : value.orientation}
          onChange={(id) => set('orientation', id as PrintSettings['orientation'])}
          items={[
            { id: 'as_uploaded', label: t(settingWords.orientation_as_uploaded) },
            { id: 'auto', label: t(settingWords.orientation_auto), disabled: plateChosen },
          ]}
        />
        {plateChosen ? <p className="text-[12px] text-text-muted">{t(settingWords.plateNeedsFixed)}</p> : null}
      </div>

      <Switch checked={value.brim} onChange={(on) => set('brim', on)} label={t(settingWords.brim)} description={t(settingWords.brimHint)} />

      {value.pause_at_layers.length ? (
        <p className="text-[12px] text-text-muted">{t(settingWords.pauseLayers, { layers: value.pause_at_layers.map((l) => formatFigure(l, lang)).join(lang === 'en' ? ', ' : '، ') })}</p>
      ) : null}

      <Field label={t(settingWords.notes)} optional>
        <Textarea rows={3} maxLength={1000} value={value.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </div>
  );
}
