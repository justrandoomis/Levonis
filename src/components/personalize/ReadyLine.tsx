/**
 * THE ONE LINE UNDER THE MODEL — «✓ جاهز للطباعة · Ready to print», or the one
 * thing to know now (docs/LEVO_PROJECT_PROGRAMME.md §B.1 P15; survey S1
 * «Contextual lines appear one at a time»):
 *
 *   blocked   the most serious issue (check.ts `blockingCode`) in one
 *             sentence, and its fix: a priced one-tap change showing its
 *             ±IQD («Use Medium +3,000» — never applied by itself), or the
 *             editor to open (a name to type, a colour to pick)
 *   review    what the shop will look at first (never blocks)
 *   ready     ✓, and — after an automatic fix — what was done, lightly
 *
 * ONE contextual chip at most: the fix, else Undo right after a one-tap
 * change, else «Make it better» when it has something to offer and the
 * customer has changed something. `data-verdict`, `role=status`, aria-live.
 */
import { useId } from 'react';
import { AlertTriangle, CircleCheck, Sparkles, Undo2 } from 'lucide-react';
import type { CheckFinding } from '../../../packages/catalog/src/personalize/check';
import type { DesignConfig, PublicBlueprint, Verdict } from '../../../packages/catalog/src/personalize/types';
import { checkGroup, colorWord } from '../../../packages/catalog/src/personalize/vocab';
import { partKindWord } from '../../../packages/catalog/src/personalize/parts';
import { Money } from '../ui/Money';
import { fill, type StudioLang, type StudioWords } from './strings';
import { sizeRows, sizeWordIndex } from './useStudio';

type Words = StudioWords;

/** Where an issue's editor lives: a tile or a More page, by the configuration path it names. */
export interface OpenTarget { id: string; ref?: string }

export type LineAction =
  | { kind: 'apply'; label: string; config: DesignConfig; delta?: number }
  | { kind: 'open'; label: string; target: OpenTarget }
  | { kind: 'undo'; label: string }
  | { kind: 'better'; label: string };

export interface Line {
  tone: 'ok' | 'note' | 'stop';
  text: string;
  action?: LineAction;
}

/** A size value's word («Medium»), else its longest side in cm. */
export function sizeName(pub: PublicBlueprint, config: DesignConfig, value: string | undefined, t: Words): string {
  const rows = sizeRows(pub, config);
  const i = rows.findIndex((r) => r.value === value);
  const w = i < 0 ? -1 : sizeWordIndex(i, rows.length);
  const dims = value ? pub.axes.size?.values[value]?.dims_mm : undefined;
  return w >= 0 ? t.sizes[w] : dims ? fill(t.dims, { dims: Math.round(Math.max(...dims) / 10) }) : '';
}

/** The editor an issue path belongs to. */
export function targetOf(path: string | undefined): OpenTarget | null {
  const [head, id] = (path ?? '').split('.');
  if (head === 'texts' || head === 'logo' || head === 'photo' || head === 'qr' || head === 'icon') return { id: head === 'texts' ? 'text' : head, ref: id };
  if (head === 'slots') return { id: 'addons' };
  if (head === 'colors') return { id: 'look' };
  if (head === 'variant') return { id: 'size' };
  return null;
}

/** The line for this check (pure; the test renders every code through it). */
export function readyLine(
  pub: PublicBlueprint,
  made: DesignConfig,
  verdict: Verdict,
  issues: readonly CheckFinding[],
  blocking: CheckFinding | undefined,
  t: Words,
  lang: StudioLang,
  extra: { undo?: boolean; better?: string | null; said?: string | null } = {}
): Line {
  const nameOf = (i: CheckFinding, key: string | undefined): string => {
    if (!key) return '';
    if (i.code === 'COMPONENT_OUT') {
      const slot = i.path?.split('.')[1] ?? '';
      return pub.slot_options[slot]?.find((o) => o.key === key)?.name ?? key;
    }
    if (i.code === 'SIZE_OUT') return sizeName(pub, made, pub.variants.find((v) => v.id === key)?.values[pub.axes.size?.group ?? ''], t);
    if (/^SIZE_UP|QR_ENLARGED|TEXT_FITTED|TOO_BIG/.test(i.code)) return sizeName(pub, made, key, t);
    return colorWord(key, lang) || key;
  };
  const sentence = (i: CheckFinding): string => {
    const asked = i.fix?.kind === 'suggest' && checkGroup(i.code) === 'fixed';
    if (i.code === 'CONTENT_MISSING') {
      const [head, id] = (i.path ?? '').split('.');
      const area = pub.areas.find((a) => a.id === id);
      const slot = pub.slots.find((s) => s.id === id);
      const what =
        head === 'texts' ? (area?.role === 'name' ? t.tiles.name : t.tiles.text)
        : head === 'slots' && slot ? slot.label?.[lang] || partKindWord(slot.kind, lang)
        : '';
      const words = t.missing[head as keyof Words['missing']] ?? t.check.CONTENT_MISSING;
      return fill(words, { what: lang === 'en' ? `the ${what.toLowerCase()}` : what });
    }
    if ((i.code === 'RULE_UNMET' || i.code === 'RULE_ADJUSTED' || /^SIZE_UP_FOR_ADDON/.test(i.code)) && i.say) return t.say[i.say];
    if (i.code === 'COMPONENT_OUT' && !i.from) return t.check.COMPONENT_OUT.replace('{from}', t.tiles.addons);
    const base = asked && i.code in t.checkAsk ? t.checkAsk[i.code as keyof Words['checkAsk']] : t.check[i.code];
    return fill(base, { from: nameOf(i, i.from), to: nameOf(i, i.to) });
  };
  const fixOf = (i: CheckFinding): LineAction | undefined => {
    const f = i.fix;
    if (f?.kind === 'suggest' && f.config) {
      const option = i.code === 'COMPONENT_OUT' ? i.alternatives?.[0]?.key : undefined;
      const label =
        option ? fill(t.useOption, { option: nameOf(i, option) })
        : i.to && /^SIZE|QR_ENLARGED|TEXT_FITTED|TOO_BIG/.test(i.code) ? fill(t.useSize, { size: nameOf(i, i.to) })
        : t.apply;
      return { kind: 'apply', label, config: f.config, ...(f.delta_iqd !== undefined ? { delta: f.delta_iqd } : {}) };
    }
    const target = targetOf(i.path);
    return target && checkGroup(i.code) === 'blocked' ? { kind: 'open', label: t.fixIt, target } : undefined;
  };

  if (verdict === 'blocked' && blocking) return { tone: 'stop', text: sentence(blocking), action: fixOf(blocking) };
  const r = verdict === 'review' ? issues.find((i) => checkGroup(i.code) === 'review') : undefined;
  if (r) return { tone: 'note', text: sentence(r), action: fixOf(r) ?? (extra.undo ? { kind: 'undo', label: t.undo } : undefined) };
  const auto = issues.find((i) => i.fix?.kind === 'auto');
  const text = extra.said ? `${t.ready} · ${extra.said}` : auto ? `${t.ready} · ${sentence(auto)}` : t.ready;
  const action: LineAction | undefined = extra.undo ? { kind: 'undo', label: t.undo } : extra.better ? { kind: 'better', label: t.better } : undefined;
  return { tone: 'ok', text, ...(action ? { action } : {}) };
}

export interface ReadyLineProps {
  line: Line;
  verdict: Verdict;
  onAction: (a: LineAction) => void;
  /** The action button, so a tap on a blocked door can bring the customer to it. */
  actionRef?: React.Ref<HTMLButtonElement>;
  id?: string;
}

export function ReadyLine({ line, verdict, onAction, actionRef, id }: ReadyLineProps) {
  const auto = useId();
  const a = line.action;
  const Icon = line.tone === 'ok' ? CircleCheck : AlertTriangle;
  return (
    <div
      id={id ?? auto}
      role="status"
      aria-live="polite"
      data-verdict={verdict}
      className="flex min-h-11 items-center gap-2 rounded-2xl border border-border-subtle bg-surface/95 py-1.5 ps-3 pe-1.5 text-[13px] leading-snug text-text-primary backdrop-blur"
    >
      <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${line.tone === 'ok' ? 'text-success' : line.tone === 'stop' ? 'text-warning' : 'text-text-muted'}`} />
      <span className="min-w-0 flex-1">{line.text}</span>
      {a && (
        <button
          ref={actionRef}
          type="button"
          onClick={() => onAction(a)}
          data-line-action={a.kind}
          className="lv-button lv-button-secondary lv-button-sm shrink-0"
        >
          {a.kind === 'better' ? <Sparkles aria-hidden="true" className="h-4 w-4 text-gold" /> : a.kind === 'undo' ? <Undo2 aria-hidden="true" className="h-4 w-4" /> : null}
          <span>{a.label}</span>
          {a.kind === 'apply' && a.delta ? <Money iqd={a.delta} signed className="text-text-secondary" /> : null}
        </button>
      )}
    </div>
  );
}
