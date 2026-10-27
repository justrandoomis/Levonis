/**
 * «مقاسات أخرى» and the composition switches — every one a re-layout the
 * shared package computes from the design’s template (`layout.rebuild`),
 * keeping its words, bindings and chosen pictures. A new SIZE is a linked
 * design (`parent_id`), never a stretched copy (spec §24); a variant,
 * priority or density switch is one undo step on this design.
 */
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Field, Input } from '../../ui/Field';
import { CUSTOM_FORMAT_LIMITS, formatOf, type FormatId } from '../../../../packages/creativeDoc/src/schema';
import { TEMPLATES, VARIANT_LABELS, type TemplateId, type VariantId } from '../../../../packages/creativeDoc/src/templates';
import type { EditorApi } from '../editorApi';
import { DENSITY_TEXT, FORMAT_TEXT, PRIORITY_TEXT, S, fill } from '../strings';
import { useText } from '../shared';

export default function FormatsPanel({ api }: { api: EditorApi }) {
  const { lang, w } = useText();
  const { doc } = api;
  const [busy, setBusy] = useState(false);
  const [cw, setCw] = useState('1200');
  const [ch, setCh] = useState('628');
  const tpl = doc.template && doc.template.id in TEMPLATES ? TEMPLATES[doc.template.id as TemplateId] : null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  if (!tpl) return <p className="text-sm text-text-muted">{w(S.rebuildUnavailable)}</p>;
  const variants = Object.keys(tpl.variants) as VariantId[];
  const priorities = [...new Set(variants.map((v) => tpl.variants[v]!.priority))];
  const custom = formatOf('custom', Number(cw), Number(ch));
  const L = CUSTOM_FORMAT_LIMITS;
  return (
    <div className="flex flex-col gap-5" data-formats-panel>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{w(S.variantSwitch)}</h3>
        <div className="flex flex-wrap gap-2">
          {variants.map((v) => (
            <Button key={v} size="sm" variant={doc.template?.variant === v ? 'primary' : 'secondary'} aria-pressed={doc.template?.variant === v} disabled={busy} onClick={() => run(() => api.rebuildTo({ kind: 'variant', variant: v }))}>
              {VARIANT_LABELS[v][lang]}
            </Button>
          ))}
        </div>
      </section>
      {priorities.length > 1 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-text-primary">{w(S.priorityPick)}</h3>
          <div className="flex flex-wrap gap-2">
            {priorities.map((p) => <Button key={p} size="sm" variant={doc.priority === p ? 'primary' : 'secondary'} disabled={busy} onClick={() => run(() => api.rebuildTo({ kind: 'priority', priority: p }))}>{w(PRIORITY_TEXT[p])}</Button>)}
          </div>
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{w(S.newDensity)}</h3>
        <div className="flex flex-wrap gap-2">
          {(['brief', 'detailed'] as const).map((d) => <Button key={d} size="sm" variant={doc.density === d ? 'primary' : 'secondary'} disabled={busy} onClick={() => run(() => api.rebuildTo({ kind: 'density', density: d }))}>{w(DENSITY_TEXT[d])}</Button>)}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{w(S.panelFormats)}</h3>
        <p className="text-xs text-text-muted">{w(S.formatsIntro)}</p>
        <div className="flex flex-wrap gap-2">
          {(['square', 'portrait', 'story'] as const).filter((f) => f !== doc.format.id).map((f: FormatId) => (
            <Button key={f} size="sm" disabled={busy} onClick={() => run(() => api.rebuildTo({ kind: 'format', format: formatOf(f)! }))}>{fill(w(S.formatsMake), { name: w(FORMAT_TEXT[f]) })}</Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={w(S.propW)}><Input type="number" inputMode="numeric" ltr value={cw} onChange={(e) => setCw(e.target.value)} /></Field>
          <Field label={w(S.propH)}><Input type="number" inputMode="numeric" ltr value={ch} onChange={(e) => setCh(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-text-muted">{fill(w(S.formatsLimits), { min: L.min, max: L.max, aspect: L.maxAspect })}</p>
        <Button size="sm" disabled={busy || !custom} onClick={() => custom && run(() => api.rebuildTo({ kind: 'format', format: custom }))}>{fill(w(S.formatsMake), { name: w(S.formatsCustom) })}</Button>
      </section>
    </div>
  );
}
