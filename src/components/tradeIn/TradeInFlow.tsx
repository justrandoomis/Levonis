/**
 * THE FIVE PHONE SCREENS, as one draft moves through them (trade-in design B.2, spec §10.1):
 *
 *   1 «أجهزتك»        the device list (src/pages/TradeIn.tsx) — choosing a device opens the draft
 *   2 «ماذا تستبدل؟»   a sheet, Combo only (ScopeSheet)
 *   3 «حالة الجهاز»    ConditionScreen — the answers are SAVED (PATCH) before the next screen
 *   4 «الجهاز الجديد»  this file + TargetSearchSheet — the target is saved, priced by the server
 *   5 «عرضك»           OfferScreen — the one figure, then «أرسل الطلب»
 *
 * The step is in the URL (`?draft=<id>&step=condition|target|offer`), so the phone's back gesture
 * walks back through the screens. A draft is created the moment a device and a part are chosen,
 * which is also the moment the part is claimed — two tabs cannot trade it twice. Nothing on these
 * screens computes a figure.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Money } from '../ui/Money';
import SafeImage from '../ui/SafeImage';
import Spinner from '../ui/Spinner';
import { blankInputs } from '../../../packages/pricing/src/tradeIn';
import { useT } from './useT';
import { ErrorLine, useErrText } from './parts';
import ConditionScreen, { missingFor, type Inputs } from './ConditionScreen';
import TargetSearchSheet, { firstPick, needsChoice, quoteTarget } from './TargetSearchSheet';
import OfferScreen from './OfferScreen';
import { labelOf, nameOf, type ComponentRole, type RequestView, type TargetOption, type TargetView } from './model';
import type { CopyKey } from './copy';

export type FlowStep = 'condition' | 'target' | 'offer';
export const FLOW_STEPS: readonly FlowStep[] = ['condition', 'target', 'offer'];

function inputsOf(req: RequestView | null): Inputs {
  const out: Inputs = {};
  for (const c of req?.components ?? [])
    out[c.role] = {
      ...blankInputs(c.family),
      ...(c.inputs as object),
    } as Inputs[ComponentRole];
  return out;
}

const TITLES: Record<FlowStep, CopyKey> = {
  condition: 'cond.title',
  target: 'target.q',
  offer: 'offer.title',
};

export default function TradeInFlow({
  draftId,
  step,
  targetHint,
  onStep,
  onSent,
  onNotDraft,
  onExit,
}: {
  draftId: string;
  step: FlowStep;
  /** `?target=<product_id>` — the product page's entry preselects the new device. */
  targetHint: string | null;
  onStep: (next: FlowStep, direction: 'forward' | 'back') => void;
  onSent: (id: string) => void;
  /** The request was already sent: its own page. */
  onNotDraft: (id: string) => void;
  onExit: () => void;
}) {
  const { t } = useT();
  const { loc, dir } = useLanguage();
  const errText = useErrText();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const Next = dir === 'rtl' ? ArrowLeft : ArrowRight;

  const [req, setReq] = useState<RequestView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [inputs, setInputs] = useState<Inputs>({});
  const [damage, setDamage] = useState<Partial<Record<ComponentRole, boolean>>>({});
  const [role, setRole] = useState<ComponentRole>('device');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(false);
  const [initial, setInitial] = useState<TargetOption | null>(null);
  const hinted = useRef(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const d = await api.get<{ request: RequestView }>(`/api/trade-in/requests/${encodeURIComponent(draftId)}`);
      if (d.request.status !== 'draft') {
        onNotDraft(d.request.id);
        return;
      }
      setReq(d.request);
      setInputs(inputsOf(d.request));
      setDamage(Object.fromEntries(d.request.components.map((c) => [c.role, Array.isArray(c.inputs.faults) && c.inputs.faults.length > 0])));
      setRole(d.request.components[0]?.role ?? 'device');
    } catch (e) {
      setLoadError(errText(e, t('loadRequestError')));
    }
  }, [draftId, onNotDraft, errText, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* no layout (tests) */
    }
  }, [step]);

  const saveTarget = useCallback(
    async (quote: TargetView) => {
      if (!req) return;
      const d = await api.patch<{ request: RequestView }>(`/api/trade-in/requests/${encodeURIComponent(req.id)}`, {
        target: {
          product_id: quote.product_id,
          option_value_ids: quote.option_value_ids,
          color_id: quote.color_id,
        },
      });
      setReq(d.request);
      setSheet(false);
      setInitial(null);
    },
    [req]
  );

  // The product page's entry: the device it came from, preselected — priced at once when it has
  // no model or colour to choose, else its options open in the sheet.
  useEffect(() => {
    if (step !== 'target' || !req || req.target || !targetHint || hinted.current) return;
    hinted.current = true;
    (async () => {
      try {
        const d = await api.get<{ targets: TargetOption[] }>(`/api/trade-in/targets?product_id=${encodeURIComponent(targetHint)}`);
        const o = d.targets[0];
        if (!o) return;
        if (needsChoice(o)) {
          setInitial(o);
          setSheet(true);
        } else {
          await saveTarget(await quoteTarget(o, firstPick(o)));
        }
      } catch (e) {
        setError(errText(e));
      }
    })();
  }, [step, req, targetHint, saveTarget, errText]);

  const faultLabel = useCallback(
    (family: string) => (id: string) => {
      const q = req?.questions?.[family as keyof NonNullable<RequestView['questions']>];
      const f = q?.faults.find((x) => x.id === id);
      return f ? labelOf(f, loc) : id;
    },
    [req, loc]
  );

  const missing = useMemo(() => {
    if (!req) return [] as Array<{ role: ComponentRole; items: string[] }>;
    return req.components
      .map((c) => ({
        role: c.role,
        items: missingFor(c, inputs[c.role], damage[c.role] ?? false, req.valuation_version ?? 1, t, loc, faultLabel(c.family)),
      }))
      .filter((m) => m.items.length > 0);
  }, [req, inputs, damage, t, loc, faultLabel]);

  if (loadError) {
    return (
      <div className="lv-surface space-y-3 p-4">
        <ErrorLine>{loadError}</ErrorLine>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={load}>
            {t('retry')}
          </Button>
          <Button variant="ghost" onClick={onExit}>
            {t('back')}
          </Button>
        </div>
      </div>
    );
  }
  if (!req) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const total = req.is_combo ? 5 : 4;
  const index = (req.is_combo ? 3 : 2) + FLOW_STEPS.indexOf(step);

  const saveCondition = async () => {
    setBusy(true);
    setError('');
    try {
      const d = await api.patch<{ request: RequestView }>(`/api/trade-in/requests/${encodeURIComponent(req.id)}`, { components: inputs });
      setReq(d.request);
      const b = d.request.blockers;
      const left = b ? [...Object.values(b.inputs).flat(), ...Object.values(b.photos).flat()] : [];
      if (left.length) {
        setError(t('missing.title'));
        return;
      }
      onStep('target', 'forward');
    } catch (e) {
      setError(errText(e, t('saveError')));
    } finally {
      setBusy(false);
    }
  };

  const target = req.target;
  const partName = (r: ComponentRole) => t(r === 'ams' ? 'part.ams' : 'part.device');

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-trade-in-form data-step={step}>
      {/* THE PROGRESS — a segment per screen, the current one named. */}
      <div>
        <div className="flex gap-1" aria-hidden>
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={`h-1 flex-1 rounded-full ${i < index ? 'bg-gold' : 'bg-border-subtle'}`} />
          ))}
        </div>
        <p className="mt-2 text-[12px] text-text-muted tabular-nums">{t('stepOf', { n: index, total })}</p>
        <h2 className="mt-0.5 text-[22px] font-black leading-8 text-text-primary">{t(TITLES[step])}</h2>
        <div className="mt-2 flex items-center gap-2 text-[12.5px] text-text-secondary">
          <SafeImage sizes="28px" src={req.source.image ?? ''} alt="" aspect="square" className="h-7 w-7 shrink-0 rounded-sm" bgClassName="bg-surface" />
          <span className="min-w-0 truncate">{req.source.name}</span>
        </div>
      </div>

      {step === 'condition' ? (
        <ConditionScreen
          req={req}
          role={role}
          onRole={setRole}
          inputs={inputs}
          setInputs={setInputs}
          damage={damage}
          setDamage={setDamage}
          onPhoto={(p) =>
            setReq((cur) =>
              cur
                ? {
                    ...cur,
                    components: cur.components.map((c) => (c.role === p.component ? { ...c, photos: [...c.photos, p] } : c)),
                  }
                : cur
            )
          }
          onPhotoRemoved={(id) =>
            setReq((cur) =>
              cur
                ? {
                    ...cur,
                    components: cur.components.map((c) => ({
                      ...c,
                      photos: c.photos.filter((p) => p.id !== id),
                    })),
                  }
                : cur
            )
          }
        />
      ) : null}

      {step === 'target' ? (
        <div className="space-y-3" data-trade-in-target>
          {target ? (
            <section className="lv-surface flex items-center gap-3 p-4" data-target-chosen={target.product_id}>
              <SafeImage sizes="64px" src={target.image} alt="" aspect="square" className="h-16 w-16 shrink-0 rounded-md" bgClassName="bg-surface" />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold leading-5 text-text-primary line-clamp-2">{nameOf(target, loc)}</p>
                {target.options?.length || target.color ? (
                  <p className="truncate text-[12px] text-text-muted">
                    {[...(target.options ?? []).map((o) => labelOf(o, loc)), ...(target.color ? [labelOf(target.color, loc)] : [])].join(' · ')}
                  </p>
                ) : null}
                <p className="mt-0.5 text-[14px] font-black text-text-primary">
                  <Money iqd={target.price_iqd} />
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setSheet(true)} data-target-change>
                {t('target.change')}
              </Button>
            </section>
          ) : (
            <button type="button" onClick={() => setSheet(true)} className="lv-input flex items-center gap-2 text-start text-[14px] text-text-muted" data-target-open>
              <Search className="h-4 w-4 shrink-0" aria-hidden />
              {t('target.search')}
            </button>
          )}
          <p className="text-[12.5px] text-text-muted">{t('target.only')}</p>
          <TargetSearchSheet open={sheet} onClose={() => setSheet(false)} initial={initial} onPicked={(q) => saveTarget(q)} />
        </div>
      ) : null}

      {step === 'offer' ? <OfferScreen req={req} onReq={setReq} onSent={onSent} onBackToCondition={() => onStep('condition', 'back')} /> : null}

      {step !== 'offer' ? (
        <>
          {step === 'condition' && missing.length > 0 ? (
            <div className="lv-alert lv-alert-warning text-[12.5px] text-text-primary" data-trade-in-missing>
              <p className="font-bold">{t('missing.title')}</p>
              <ul className="mt-1 list-disc space-y-0.5 ps-5">
                {missing.flatMap((m) =>
                  m.items.map((it, i) => (
                    <li key={`${m.role}-${i}`}>
                      {req.components.length > 1 ? `${partName(m.role)}: ` : ''}
                      {it}
                    </li>
                  ))
                )}
              </ul>
            </div>
          ) : null}
          <ErrorLine>{error}</ErrorLine>
          {/* THE ACTION BAR — sticky on the phone, above the tab bar. */}
          <div className="sticky bottom-[calc(var(--nav-stack,0px)+8px)] z-20 lg:static">
            <div className="flex items-center gap-2 rounded-2xl border border-border-subtle bg-surface-raised p-2 shadow-dock lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
              <Button
                variant="secondary"
                onClick={() => (step === 'condition' ? onExit() : onStep('condition', 'back'))}
                icon={<Back className="h-4 w-4" aria-hidden />}
                aria-label={t('back')}
              >
                <span className="hidden sm:inline">{t('back')}</span>
              </Button>
              <div className="flex-1" />
              <Button
                variant="primary"
                onClick={step === 'condition' ? saveCondition : () => onStep('offer', 'forward')}
                disabled={busy || (step === 'condition' ? missing.length > 0 : !target)}
                loading={busy}
                iconEnd={<Next className="h-4 w-4" aria-hidden />}
                data-trade-in-next
              >
                {t('continue')}
              </Button>
            </div>
          </div>
        </>
      ) : null}
      {step === 'offer' && !req.target ? <p className="text-[13px] text-text-secondary">{t('target.empty')}</p> : null}
    </div>
  );
}
