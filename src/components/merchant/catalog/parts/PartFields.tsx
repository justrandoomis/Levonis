/**
 * THE PART'S FACTS — kind, shape, size, volts and watts, how it is fitted,
 * what it fits and what it is used as, and the size of each option
 * (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.3 row «Metadata»).
 *
 * Its own chunk, fetched when «يُستخدم داخل منتجات مطبوعة» is switched on.
 *
 * IT EDITS THE FLAT MAP THE SERVER STORES — the same keys the Levonis
 * `printed_part` spec group has — and nothing is invented: an empty field is
 * an absent fact, a zero is no size at all. The per-option rows are the
 * product's SAVED option values still in the editor's draft (a line names a
 * value by its id, which a new value does not have until it is saved), and
 * every edit re-derives those lines through the engine, so a value removed in
 * the same edit never travels with the save. The words line under the form is
 * the engine's own (`partSpecWords`) — what a merchant reads is what the
 * builder and the customer's add-ons will say.
 *
 * «من ليفونيس» parts carry their source: «حدّث من ليفونيس» re-reads the facts
 * and the pictures and says the Levonis price beside the merchant's, which it
 * never changes.
 */
import { useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { Field, Input, Select } from '../../../ui/Field';
import { NumberInput } from '../../../ui/NumberInput';
import { Button } from '../../../ui/Button';
import { useToast } from '../../../ui/Toast';
import { formatMoney } from '../../../../lib/money';
import { apiRefusal } from '../../../../lib/refusalStrings';
import {
  PART_KINDS,
  PART_SHAPES,
  partKindWord,
  partShapeWord,
  partSpecToMap,
  partSpecWords,
  readPartSpec,
  type PartDims,
} from '../../../../../packages/catalog/src/personalize/parts';
import type { CatalogProductDetail } from '../catalogApi';
import type { VariantDraft } from '../VariantEditor';
import { partsApi } from './api';
import { fill, partFieldStrings, type PartsLang } from './strings';

type Facts = Record<string, string>;
type NumKey = 'diameter_mm' | 'length_mm' | 'width_mm' | 'height_mm' | 'voltage' | 'power_w' | 'install_minutes';

/** The server's caps (readPartSpec): a value past one would be refused, so it is never sent. */
const CAP: Record<NumKey, number> = { diameter_mm: 1e4, length_mm: 1e4, width_mm: 1e4, height_mm: 1e4, voltage: 400, power_w: 5000, install_minutes: 1440 };

export interface PartFieldsProps {
  value: Facts | null;
  onChange: (value: Facts | null) => void;
  product: CatalogProductDetail | null;
  variants: VariantDraft;
  errors: Record<string, string>;
  dirty: boolean;
  onReload: () => void;
}

export default function PartFields({ value, onChange, product, variants, errors, dirty, onReload }: PartFieldsProps) {
  const { lang } = useLanguage();
  const l = lang as PartsLang;
  const t = partFieldStrings(lang);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const map: Facts = value ?? { printed_use: 'Yes', part_kind: 'other' };

  // The saved option values still in the draft — the only ones a line may name.
  const saved = new Set((product?.option_groups ?? []).flatMap((g) => g.values.map((v) => v.id)));
  const rows = variants.groups.flatMap((g) =>
    g.values.filter((v) => saved.has(v.ref)).map((v) => ({ id: v.ref, name: (l === 'en' ? v.name : v.name_ar) || v.name }))
  );
  const hasNewValues = variants.groups.some((g) => g.values.some((v) => !saved.has(v.ref)));
  const ids = rows.map((r) => r.id);
  const spec = readPartSpec(map, ids);
  const lines = spec?.variants ?? {};

  /** Every change re-derives the lines from the current values, so a stale one never leaves. */
  function commit(next: Facts, nextLines: Record<string, PartDims> = lines) {
    const out: Facts = { ...next };
    const formatted = partSpecToMap({ kind: 'other', variants: nextLines }).variant_specs;
    if (formatted) out.variant_specs = formatted;
    else delete out.variant_specs;
    onChange(out);
  }
  const setKey = (k: string, v: string) => {
    const next = { ...map };
    if (v.trim()) next[k] = v;
    else delete next[k];
    commit(next);
  };
  const num = (k: NumKey) => {
    const n = Number(map[k]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const setNum = (k: NumKey, v: number | null) => setKey(k, v && v > 0 ? String(Math.min(v, CAP[k])) : '');
  const setLine = (id: string, k: 'diameter_mm' | 'height_mm', v: number | null) => {
    const line: PartDims = { ...lines[id] };
    if (v && v > 0) line[k] = Math.min(v, CAP[k]);
    else delete line[k];
    const next = { ...lines };
    if (Object.keys(line).length) next[id] = line;
    else delete next[id];
    commit(map, next);
  };
  const err = (k: string) => errors[`part_spec.${k}`];

  async function refresh() {
    if (!product || busy) return;
    setBusy(true);
    try {
      const r = await partsApi.refresh(product.id);
      toast.success(t.refreshed, {
        description: fill(t.levonisPrice, { price: formatMoney(r.levonis.price_iqd, lang), yours: formatMoney(r.product.price_iqd, lang) }),
      });
      onReload();
    } catch (e) {
      toast.error(apiRefusal(e, l, t.refreshFailed));
    } finally {
      setBusy(false);
    }
  }

  const words = spec ? partSpecWords(spec, l) : '';
  const numberField = (k: NumKey, label: string, unit: string, decimals: number) => (
    <Field label={label} error={err(k)}>
      <NumberInput kind="number" decimals={decimals} min={0} max={CAP[k]} unit={unit} value={num(k)} onValueChange={(v) => setNum(k, v)} name={`part-${k}`} />
    </Field>
  );

  return (
    <div className="space-y-4" data-part-fields>
      {spec?.source && product && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-surface p-3" data-part-source>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-text-primary">{t.fromLevonis}</p>
            <p className="text-[12px] leading-relaxed text-text-muted">{dirty ? t.saveFirst : t.refreshHint}</p>
          </div>
          <Button size="sm" variant="secondary" icon={<RefreshCcw className="h-4 w-4" />} onClick={refresh} loading={busy} disabled={dirty} data-part-refresh>
            {t.refresh}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label={t.kind} error={err('part_kind')}>
          <Select value={spec?.kind ?? 'other'} onChange={(e) => setKey('part_kind', e.target.value)} name="part-kind">
            {PART_KINDS.map((k) => (
              <option key={k} value={k}>{partKindWord(k, l)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t.shape} error={err('part_shape')}>
          <Select value={spec?.shape && spec.shape !== 'other' ? spec.shape : ''} onChange={(e) => setKey('part_shape', e.target.value)} name="part-shape">
            <option value="">{t.notStated}</option>
            {PART_SHAPES.filter((s) => s !== 'other').map((s) => (
              <option key={s} value={s}>{partShapeWord(s, l)}</option>
            ))}
          </Select>
        </Field>
        {numberField('diameter_mm', t.diameter, t.mm, 2)}
        {numberField('height_mm', t.height, t.mm, 2)}
        {numberField('length_mm', t.length, t.mm, 2)}
        {numberField('width_mm', t.width, t.mm, 2)}
        {numberField('voltage', t.voltage, t.volt, 1)}
        {numberField('power_w', t.power, t.watt, 1)}
        <Field label={t.install} error={err('install_type')}>
          <Input value={map.install_type ?? ''} maxLength={60} placeholder={t.installPlaceholder} onChange={(e) => setKey('install_type', e.target.value)} name="part-install" />
        </Field>
        {numberField('install_minutes', t.minutes, t.min, 0)}
      </div>

      <Field label={t.fits} hint={t.fitsHint} error={err('fits_family')}>
        <Input value={map.fits_family ?? ''} maxLength={300} onChange={(e) => setKey('fits_family', e.target.value)} name="part-fits" />
      </Field>
      <Field label={t.uses} hint={t.usesHint} error={err('uses')}>
        <Input value={map.uses ?? ''} maxLength={300} onChange={(e) => setKey('uses', e.target.value)} name="part-uses" />
      </Field>

      {(rows.length > 0 || hasNewValues) && (
        <fieldset className="space-y-2" data-part-lines>
          <legend className="mb-1 text-[12.5px] font-semibold text-text-secondary">{t.perOption}</legend>
          <p className="text-[12px] leading-relaxed text-text-muted">{rows.length ? t.perOptionHint : t.newValuesLater}</p>
          {rows.map((r) => (
            <div key={r.id} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-3">
              <span className="col-span-2 min-w-0 truncate text-[13px] font-medium text-text-primary sm:col-span-1 sm:pb-3">{r.name}</span>
              <Field label={t.diameter}>
                <NumberInput kind="number" decimals={2} min={0} max={CAP.diameter_mm} unit={t.mm} value={lines[r.id]?.diameter_mm ?? null} onValueChange={(v) => setLine(r.id, 'diameter_mm', v)} />
              </Field>
              <Field label={t.height}>
                <NumberInput kind="number" decimals={2} min={0} max={CAP.height_mm} unit={t.mm} value={lines[r.id]?.height_mm ?? null} onValueChange={(v) => setLine(r.id, 'height_mm', v)} />
              </Field>
            </div>
          ))}
          {err('variant_specs') && <p className="lv-field-error">{err('variant_specs')}</p>}
        </fieldset>
      )}

      {words && (
        <p className="text-[12.5px] text-text-muted" data-part-words>
          {t.preview}: <span className="font-semibold text-text-primary">{words}</span>
        </p>
      )}
    </div>
  );
}
