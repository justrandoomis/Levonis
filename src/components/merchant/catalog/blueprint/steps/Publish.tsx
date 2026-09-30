/**
 * STEP 7 · «المعاينة والنشر» — how the product sells (cart, request or both),
 * the colour pricing, the warranty, the licence and the merchant's own notes;
 * then the customer's studio itself on the draft (lane L8's `Studio`, in its
 * builder-preview mode: the merchant's own full model, nothing is sent), with
 * what its default design comes to — the engine's verdict and price, the
 * server's figures in the studio's own words. The look card was captured
 * from the model on the way in (../Builder.tsx); the builder's footer
 * publishes. A publish the server refuses as not ready names what is
 * missing, each a way to its step.
 */
import { Suspense, lazy, useCallback, useState } from 'react';
import type { EngineIssue } from '../../../../../../packages/catalog/src/personalize/types';
import { FAMILIES, FAMILY_WORDS, LICENCES, LICENCE_WORDS, word } from '../../../../../../packages/catalog/src/personalize/vocab';
import type { LoadedMesh } from '../../../../../lib/viewer/mesh';
import { useMediaQuery } from '../../../../../lib/useMediaQuery';
import { Field, Select, Textarea } from '../../../../ui/Field';
import { Money } from '../../../../ui/Money';
import { NumberInput } from '../../../../ui/NumberInput';
import { Segmented } from '../../../../ui/Segmented';
import { StatusChip } from '../../../../ui/Badge';
import { stepOf, type StepId } from '../model';
import type { BuilderStrings } from '../strings';
import type { Kit } from '../kit';

const Studio = lazy(() => import('../../../../personalize/Studio'));

export type Prep = 'idle' | 'working' | 'ready' | 'failed' | 'invalid';

const VERDICT_TONE = { ready: 'success', adjusted: 'success', review: 'info', blocked: 'neutral' } as const;

export default function Publish({ k, prep, missing, mesh, others }: { k: Kit; prep: Prep; missing: string[]; mesh: LoadedMesh | null; others: EngineIssue[] }) {
  const { t, spec, st, lang } = k;
  const [health, setHealth] = useState<{ verdict: string; unit: number | null } | null>(null);
  const wide = useMediaQuery('(min-width: 1024px)');
  // Stable: the studio reports from an effect that depends on it.
  const onChange = useCallback((_c: unknown, out: { verdict: string; unit_iqd: number | null }) => setHealth((h) => (h && h.verdict === out.verdict && h.unit === out.unit_iqd ? h : { verdict: out.verdict, unit: out.unit_iqd })), []);
  const photo = k.kind === 'photos';
  const sell = spec.sell.cart && spec.sell.request ? 'both' : spec.sell.request ? 'request' : 'cart';
  const colours = (patch: Partial<typeof spec.colors>) => k.edit((s) => ({ ...s, colors: { ...s.colors, ...patch } }));
  const broken = [...new Set(others.map((i) => stepOf(i.path, photo)))];
  const [a, b] = t.from.split('{price}');
  const bytes = mesh?.mesh.position.buffer as ArrayBuffer | undefined;
  const words: Record<StepId, keyof BuilderStrings> = { source: 'stepSource', parts: 'stepParts', areas: 'stepAreas', sizes: 'stepSizes', addons: 'stepAddons', rules: 'stepRules', publish: 'stepPublish' };

  return (
    <div className="space-y-5" data-step-publish={prep}>
      {(missing.length > 0 || (prep === 'invalid' && broken.length > 0)) && (
        <div role="alert" className="space-y-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-[12.5px] leading-relaxed text-text-primary" data-not-ready>
          <p className="font-semibold">{missing.length ? t.missing : t.toFix}</p>
          <div className="flex flex-wrap gap-2">
            {missing.map((m) => (
              <button key={m} type="button" className="lv-choice px-3 text-[12.5px]" onClick={() => m !== 'look' && k.go(m === 'mesh' ? 'source' : broken[0] ?? (photo ? 'source' : 'parts'))} data-missing={m}>
                {m === 'mesh' ? t.m_mesh : m === 'look' ? t.m_look : t.m_spec}
              </button>
            ))}
            {!missing.length &&
              broken.map((s) => (
                <button key={s} type="button" className="lv-choice px-3 text-[12.5px]" onClick={() => k.go(s)} data-broken={s}>
                  {t[words[s]]}
                </button>
              ))}
          </div>
        </div>
      )}

      <section className="space-y-2">
        <p className="text-[13.5px] font-semibold text-text-primary">{t.previewTitle}</p>
        {prep === 'working' && <p className="text-[13px] text-text-muted" role="status">{t.preparing}</p>}
        {prep === 'failed' && <p className="text-[13px] leading-relaxed text-warning" role="alert">{t.captureFailed}</p>}
        {prep === 'ready' && !st.preview && <p className="text-[13px] text-text-muted">{t.previewAfterSave}</p>}
        {prep === 'ready' && st.preview && (
          // The studio's own frame: from `lg` it sits side by side and fits the sheet's body (≈ 88vh less its header and
          // footer); on a phone its stage is 52% of the screen (as the customer's page), with its words and door below.
          <div className="overflow-hidden rounded-2xl border border-border-subtle" style={{ height: wide ? 'min(58dvh, 540px)' : 'calc(52dvh + 270px)' }} data-preview>
            <Suspense fallback={<p className="p-4 text-[13px] text-text-muted" role="status">{t.preparing}</p>}>
              <Studio
                blueprint={st.preview}
                preview
                mesh={!photo && bytes ? { bytes } : undefined}
                onChange={onChange}
              />
            </Suspense>
          </div>
        )}
        {prep === 'ready' && health && (
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary" data-health={health.verdict}>
            <StatusChip tone={VERDICT_TONE[health.verdict as keyof typeof VERDICT_TONE] ?? 'neutral'}>{t[`v_${health.verdict}` as keyof BuilderStrings] ?? health.verdict}</StatusChip>
            {health.unit !== null && (
              <span className="tabular-nums">
                {a}
                <Money iqd={health.unit} />
                {b}
              </span>
            )}
          </p>
        )}
      </section>
      <section className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-6 lg:space-y-0">
        <div className="space-y-3">
          <p className="text-[13.5px] font-semibold text-text-primary">{t.sellTitle}</p>
          <Segmented
            items={[
              { id: 'cart', label: t.sellCart },
              { id: 'request', label: t.sellRequest },
              { id: 'both', label: t.sellBoth },
            ]}
            value={sell}
            onChange={(id) => k.edit((s) => ({ ...s, sell: { cart: id !== 'request', request: id !== 'cart' } }))}
            label={t.sellTitle}
            group="sell"
            size="sm"
          />
          <p className="text-[12px] leading-relaxed text-text-muted">{sell === 'cart' ? t.sellHintCart : sell === 'request' ? t.sellHintRequest : t.sellHintBoth}</p>
          <p className="pt-1 text-[13.5px] font-semibold text-text-primary">{t.coloursTitle}</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t.included}>
              <NumberInput kind="quantity" min={0} max={16} value={spec.colors.included} onValueChange={(v) => v !== null && colours({ included: Math.min(16, Math.max(0, v)) })} />
            </Field>
            <Field label={t.maxColours}>
              <NumberInput kind="quantity" min={1} max={16} value={spec.colors.max} onValueChange={(v) => v && colours({ max: Math.min(16, Math.max(1, v)) })} />
            </Field>
          </div>
          <Field label={t.perExtra}>
            <NumberInput kind="money" value={spec.colors.per_extra_iqd} onValueChange={(v) => colours({ per_extra_iqd: Math.max(0, Math.trunc(v ?? 0)) })} />
          </Field>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t.family}>
              <Select value={spec.family} onChange={(e) => k.edit((s) => ({ ...s, family: e.target.value as typeof s.family }))}>
                {FAMILIES.map((f) => (
                  <option key={f} value={f}>{word(FAMILY_WORDS, FAMILIES, f, lang)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t.warranty}>
              <NumberInput kind="quantity" min={0} max={3650} value={spec.warranty_days} onValueChange={(v) => k.edit((s) => ({ ...s, warranty_days: Math.min(3650, Math.max(0, v ?? 0)) }))} />
            </Field>
          </div>
          <Field label={t.licence}>
            <Select value={spec.licence} onChange={(e) => k.edit((s) => ({ ...s, licence: e.target.value as typeof s.licence }))}>
              {LICENCES.map((x) => (
                <option key={x} value={x}>{word(LICENCE_WORDS, LICENCES, x, lang)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t.notes} optional>
            <Textarea
              rows={2}
              maxLength={500}
              value={spec.private.notes ?? ''}
              onChange={(e) =>
                k.edit((s) => {
                  const { notes: _was, ...rest } = s.private;
                  return { ...s, private: e.target.value.trim() ? { ...rest, notes: e.target.value } : rest };
                })
              }
            />
          </Field>
        </div>
      </section>

    </div>
  );
}
