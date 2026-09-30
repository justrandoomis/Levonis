/**
 * STEP 6 · «القواعد» — what the engine does by itself, said as facts (Smart
 * Fit shrinks a long name and then suggests a bigger size; sizes above the
 * shop's printer are not offered; a colour off the shelf becomes its nearest
 * stocked one), and the merchant's own rules from the closed list
 * (BlueprintSpec v1 `rules`: when a text is longer than n letters, an add-on
 * option is picked, a QR code is added or an option value is chosen → a
 * size of at least, another add-on required or excluded, only some colours,
 * at most n colours). Only what this blueprint has is offered
 * (../model.ts `ifKinds` / `thenKinds`); the explanation the customer reads
 * follows from the rule (`sayFor`). An automatic fix never changes the price
 * (P15) — the engine turns a priced one into a suggestion.
 */
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { PaletteKey, Rule, RuleIf, RuleThen } from '../../../../../../packages/catalog/src/personalize/types';
import { CONTENT_KINDS, KIND_WORDS, PAINT_KEYS, REGION_ROLES, ROLE_WORDS, colorWord, word } from '../../../../../../packages/catalog/src/personalize/vocab';
import { partKindWord } from '../../../../../../packages/catalog/src/personalize/parts';
import { Button, IconButton } from '../../../../ui/Button';
import { Select } from '../../../../ui/Field';
import { NumberInput } from '../../../../ui/NumberInput';
import { Segmented } from '../../../../ui/Segmented';
import { fill, freeId, ifKinds, sayFor, takenIds, thenKinds, type IfKind, type ThenKind } from '../model';
import { Swatches } from './Parts';
import { usePartNames } from './Addons';
import type { Kit } from '../kit';

interface Draft {
  w: IfKind;
  a: string;
  b: string;
  n: number;
  th: ThenKind;
  c: string;
  d: string;
  keys: PaletteKey[];
  m: number;
  fix: 'auto' | 'suggest';
}

/** Build the rule a finished form describes, or null while something is missing. */
export function ruleOf(f: Draft, id: string): Rule | null {
  if (!f.a || (f.w === 'slot' && !f.b)) return null;
  if ((f.th === 'size_at_least' || f.th === 'only_colors') && !f.c) return null;
  if ((f.th === 'requires' || f.th === 'excludes') && (!f.c || !f.d)) return null;
  if (f.th === 'only_colors' && !f.keys.length) return null;
  const when: RuleIf = f.w === 'text' ? { text: f.a, longer_than: f.n } : f.w === 'slot' ? { slot: f.a, is: f.b } : f.w === 'qr' ? { qr: f.a } : { value: f.a };
  const then: RuleThen =
    f.th === 'size_at_least' ? { size_at_least: f.c }
      : f.th === 'requires' ? { requires: { slot: f.c, is: f.d } }
        : f.th === 'excludes' ? { excludes: { slot: f.c, is: f.d } }
          : f.th === 'only_colors' ? { only_colors: { target: f.c, keys: f.keys } }
            : { max_colors: f.m };
  return { id, if: when, then, fix: f.fix, say: sayFor(when, then) };
}

export default function Rules({ k }: { k: Kit }) {
  usePartNames(k);
  const { t, spec, lang, product } = k;
  const [f, setF] = useState<Draft | null>(null);
  const en = lang === 'en';
  const ifs = ifKinds(spec);
  const thens = thenKinds(spec);

  // The merchant's own words for everything a rule can name.
  const valueName = (id: string) => {
    for (const g of product.option_groups) for (const v of g.values) if (v.id === id) return (en ? v.name : v.name_ar) || v.name;
    return id;
  };
  const areaName = (id: string) => {
    const i = spec.areas.findIndex((a) => a.id === id);
    const a = spec.areas[i];
    return a ? `${word(KIND_WORDS, CONTENT_KINDS, a.kind, lang)} ${i + 1}` : id;
  };
  const slotName = (id: string) => {
    const s = spec.slots.find((x) => x.id === id);
    return s ? partKindWord(s.kind, lang) : id;
  };
  const optionName = (slot: string, key: string) => {
    const o = spec.slots.find((x) => x.id === slot)?.options.find((x) => x.key === key);
    return o ? k.names[`${o.part.p}|${o.part.v ?? ''}`] ?? key : key;
  };
  const targetName = (id: string) => {
    const r = spec.regions.find((x) => x.id === id);
    return r ? word(ROLE_WORDS, REGION_ROLES, r.role, lang) : areaName(id);
  };
  const values = [spec.axes.size, spec.axes.look, spec.axes.tier].flatMap((ax) => (ax ? Object.keys(ax.values) : []));
  const sizes = Object.keys(spec.axes.size?.values ?? {});
  const targets = [...spec.regions.map((r) => r.id), ...spec.areas.filter((a) => a.kind === 'text').map((a) => a.id)];

  function sentence(r: Rule): string {
    const w = r.if;
    const th = r.then;
    const a = 'text' in w ? `${t.if_text} ${fill(t.letters, { n: w.longer_than })}` : 'slot' in w ? `${t.if_slot} ${optionName(w.slot, w.is)}` : 'qr' in w ? t.if_qr : `${t.if_value} ${valueName(w.value)}`;
    const b = 'size_at_least' in th
      ? `${t.then_size_at_least} ${valueName(th.size_at_least)}`
      : 'requires' in th
        ? `${t.then_requires} ${optionName(th.requires.slot, th.requires.is)}`
        : 'excludes' in th
          ? `${t.then_excludes} ${optionName(th.excludes.slot, th.excludes.is)}`
          : 'only_colors' in th
            ? `${t.then_only_colors} ${targetName(th.only_colors.target)}: ${th.only_colors.keys.map((c) => colorWord(c, lang)).join('، ')}`
            : `${t.then_max_colors} ${th.max_colors}`;
    return `${t.when} ${a} ${t.then} ${b}`;
  }

  const start = (): Draft => ({ w: ifs[0], a: '', b: '', n: 10, th: thens[0], c: '', d: '', keys: [], m: 2, fix: 'suggest' });
  const set = (patch: Partial<Draft>) => setF((x) => (x ? { ...x, ...patch } : x));
  const built = f ? ruleOf(f, freeId(`r${spec.rules.length + 1}`, takenIds(spec))) : null;
  const slotSelect = (slot: string, key: string, on: (slot: string, key: string) => void) => (
    <>
      <Select value={slot} aria-label={t.stepAddons} onChange={(e) => on(e.target.value, '')}>
        <option value="">…</option>
        {spec.slots.map((s) => (
          <option key={s.id} value={s.id}>{slotName(s.id)}</option>
        ))}
      </Select>
      <Select value={key} aria-label={t.stepAddons} disabled={!slot} onChange={(e) => on(slot, e.target.value)}>
        <option value="">…</option>
        {(spec.slots.find((s) => s.id === slot)?.options ?? []).map((o) => (
          <option key={o.key} value={o.key}>{optionName(slot, o.key)}</option>
        ))}
      </Select>
    </>
  );

  return (
    <div className="space-y-4" data-step-rules>
      <p className="text-[13.5px] font-semibold text-text-primary">{t.rulesLead}</p>
      <ul className="space-y-1.5">
        {[t.auto1, t.auto2, t.auto3].map((x) => (
          <li key={x} className="flex gap-2 text-[12.5px] leading-relaxed text-text-secondary">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            <span>{x}</span>
          </li>
        ))}
      </ul>

      <section className="space-y-2">
        <p className="text-[12.5px] font-semibold text-text-secondary">{t.yours}</p>
        {!spec.rules.length && <p className="text-[12.5px] text-text-muted">{t.noRules}</p>}
        <ul className="divide-y divide-border-subtle">
          {spec.rules.map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-1.5" data-rule={r.id}>
              <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-text-primary">{sentence(r)}</span>
              <span className="shrink-0 text-[11.5px] text-text-muted">{r.fix === 'auto' ? t.fixAuto : t.fixSuggest}</span>
              <IconButton label={t.remove} variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => k.edit((s) => ({ ...s, rules: s.rules.filter((x) => x.id !== r.id) }))} />
            </li>
          ))}
        </ul>
      </section>

      {f ? (
        <section className="space-y-3 rounded-2xl border border-border-subtle p-3" data-rule-form>
          <p className="text-[12.5px] font-semibold text-text-secondary">{t.when}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={f.w} aria-label={t.when} onChange={(e) => set({ w: e.target.value as IfKind, a: '', b: '' })}>
              {ifs.map((w) => (
                <option key={w} value={w}>{t[`if_${w}`]}</option>
              ))}
            </Select>
            {f.w === 'slot' ? (
              slotSelect(f.a, f.b, (a, b) => set({ a, b }))
            ) : (
              <Select value={f.a} aria-label={t.when} onChange={(e) => set({ a: e.target.value })}>
                <option value="">…</option>
                {f.w === 'value'
                  ? values.map((v) => <option key={v} value={v}>{valueName(v)}</option>)
                  : spec.areas.filter((a) => a.kind === f.w).map((a) => <option key={a.id} value={a.id}>{areaName(a.id)}</option>)}
              </Select>
            )}
            {f.w === 'text' && (
              <NumberInput kind="quantity" min={1} max={40} aria-label={fill(t.letters, { n: f.n })} value={f.n} onValueChange={(v) => v && set({ n: Math.min(40, Math.max(1, v)) })} />
            )}
          </div>
          <p className="text-[12.5px] font-semibold text-text-secondary">{t.then}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={f.th} aria-label={t.then} onChange={(e) => set({ th: e.target.value as ThenKind, c: '', d: '', keys: [] })}>
              {thens.map((x) => (
                <option key={x} value={x}>{t[`then_${x}`]}</option>
              ))}
            </Select>
            {f.th === 'size_at_least' && (
              <Select value={f.c} aria-label={t.then} onChange={(e) => set({ c: e.target.value })}>
                <option value="">…</option>
                {sizes.map((v) => <option key={v} value={v}>{valueName(v)}</option>)}
              </Select>
            )}
            {(f.th === 'requires' || f.th === 'excludes') && slotSelect(f.c, f.d, (c, d) => set({ c, d }))}
            {f.th === 'only_colors' && (
              <Select value={f.c} aria-label={t.then} onChange={(e) => set({ c: e.target.value })}>
                <option value="">…</option>
                {targets.map((x) => <option key={x} value={x}>{targetName(x)}</option>)}
              </Select>
            )}
            {f.th === 'max_colors' && (
              <NumberInput kind="quantity" min={1} max={16} aria-label={t.then_max_colors} value={f.m} onValueChange={(v) => v && set({ m: Math.min(16, Math.max(1, v)) })} />
            )}
          </div>
          {f.th === 'only_colors' && (
            <Swatches keys={PAINT_KEYS} values={f.keys} label={t.onlyKeys} name={(c) => colorWord(c, lang)} onPick={(c) => set({ keys: f.keys.includes(c) ? f.keys.filter((x) => x !== c) : [...f.keys, c] })} />
          )}
          <Segmented
            items={[{ id: 'suggest', label: t.fixSuggest }, { id: 'auto', label: t.fixAuto }]}
            value={f.fix}
            onChange={(id) => set({ fix: id as Draft['fix'] })}
            label={t.fixSuggest}
            group="rule-fix"
            size="sm"
          />
          <p className="text-[12px] leading-relaxed text-text-muted">{t.autoNote}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!built}
              onClick={() => {
                if (!built) return;
                k.edit((s) => ({ ...s, rules: [...s.rules, built] }));
                setF(null);
              }}
              data-rule-add
            >
              {t.add}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setF(null)}>{t.cancel}</Button>
          </div>
        </section>
      ) : (
        ifs.length > 0 && spec.rules.length < 24 && <Button variant="secondary" onClick={() => setF(start())} data-rule-new>{t.addRule}</Button>
      )}
    </div>
  );
}
