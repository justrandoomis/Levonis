/**
 * «استبدل جهازك» — trade a device bought from LEVONIS against a new one (Services V2 S-P2,
 * DECISIONS row 238; trade-in design B.2; spec §10.1).
 *
 * FIVE PHONE SCREENS, ONE PRIMARY ACTION EACH: «أجهزتك» (this page's home) → «ماذا تستبدل؟» (a
 * sheet, Combo only) → «حالة الجهاز» → «الجهاز الجديد» → «عرضك», then the request page's timeline.
 *
 * THE HONEST-UX RULES IT KEEPS:
 *   ONLY WHAT IS TRUE IS PROMISED. The customer sees ONE figure for the old device, «حتى X» — the
 *   store-safe offer the server works out (owner decision 1) — with the two promises beside it:
 *   the final value follows the in-store inspection and never exceeds it; the credit is taken off
 *   the new device and is never cash.
 *   ONLY LEVONIS DEVICES. The list is the customer's own delivered LEVONIS devices, from the server.
 *   THE DEVICE BEFORE THE MONEY (decision 2): the credit exists once the shop has received the
 *   device and matched its serial — the timeline says so at every step.
 *   THE SERVER DECIDES EVERY FIGURE; nothing on these screens prices anything.
 *   SIGNING IN IS ASKED FOR AT THE DOOR OF THE FORM: how it works is for everyone.
 *
 * URL: `?request=<id>` a request's timeline (the notifications link here); `?draft=<id>&step=
 * condition|target|offer` the screens of a draft (the phone's back gesture walks them);
 * `?item=<order item>&unit=<n>` starts on that device (the order page's «استبدل هذا الجهاز»);
 * `?target=<product id>` preselects the new device (the product page's entry); `?tab=requests`.
 *
 * Every string is in Arabic, English and Sorani (src/components/tradeIn/copy.ts; DECISIONS row 183).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, HelpCircle, Repeat } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { api } from '../lib/api';
import { Button, IconButton } from '../components/ui/Button';
import Note from '../components/ui/Note';
import { useT } from '../components/tradeIn/useT';
import { useErrText } from '../components/tradeIn/parts';
import DeviceList, { type DeviceTab } from '../components/tradeIn/DeviceList';
import ScopeSheet from '../components/tradeIn/ScopeSheet';
import HowItWorksSheet from '../components/tradeIn/HowItWorksSheet';
import TradeInFlow, { FLOW_STEPS, type FlowStep } from '../components/tradeIn/TradeInFlow';
import RequestTimeline from '../components/tradeIn/RequestTimeline';
import type { EligibleUnit, RequestSummary, RequestView, TradeInScope } from '../components/tradeIn/model';

const REQ_ID = /^tin_[0-9a-f]{20}$/;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,80}$/;

type Mode = { kind: 'home' } | { kind: 'flow'; id: string; step: FlowStep } | { kind: 'request'; id: string };

function modeOf(p: URLSearchParams): Mode {
  const request = p.get('request') ?? '';
  if (REQ_ID.test(request)) return { kind: 'request', id: request };
  const draft = p.get('draft') ?? '';
  if (REQ_ID.test(draft)) {
    const step = p.get('step') as FlowStep;
    return {
      kind: 'flow',
      id: draft,
      step: FLOW_STEPS.includes(step) ? step : 'condition',
    };
  }
  return { kind: 'home' };
}

export default function TradeIn() {
  const { t } = useT();
  const { dir } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const errText = useErrText();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const mode = modeOf(params);
  const targetHint = PRODUCT_ID.test(params.get('target') ?? '') ? params.get('target') : null;
  const from = (location.state as { from?: string } | null)?.from ?? null;

  const [units, setUnits] = useState<EligibleUnit[] | null>(null);
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<DeviceTab>(params.get('tab') === 'requests' ? 'requests' : 'devices');
  const [scopeFor, setScopeFor] = useState<EligibleUnit | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const [how, setHow] = useState(false);

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [e, r] = await Promise.all([api.get<{ units: EligibleUnit[] }>('/api/trade-in/eligible'), api.get<{ requests: RequestSummary[] }>('/api/trade-in/requests')]);
      setUnits(e.units);
      setRequests(r.requests);
    } catch (err) {
      setLoadError(errText(err, t('loadError')));
    }
  }, [errText, t]);

  useEffect(() => {
    if (isAuthenticated && mode.kind === 'home') void load();
  }, [isAuthenticated, mode.kind, load]);

  /** Keep `?target=` across the screens: the product page's device stays chosen. */
  const withTarget = useCallback(
    (next: Record<string, string>) => {
      const p = new URLSearchParams(next);
      if (targetHint) p.set('target', targetHint);
      return p;
    },
    [targetHint]
  );

  const openDraft = useCallback(
    async (unit: EligibleUnit, scope: TradeInScope) => {
      setOpening(true);
      setOpenError('');
      try {
        const d = await api.post<{ request: RequestView }>('/api/trade-in/requests', {
          order_item_id: unit.order_item_id,
          unit_index: unit.unit_index,
          scope,
        });
        setScopeFor(null);
        setParams(withTarget({ draft: d.request.id, step: 'condition' }), {
          state: { from: 'home' },
        });
      } catch (e) {
        setOpenError(errText(e));
        if (!unit.is_combo) setScopeFor(null);
      } finally {
        setOpening(false);
      }
    },
    [errText, setParams, withTarget]
  );

  const pick = useCallback(
    (u: EligibleUnit) => {
      setOpenError('');
      const open = u.scopes.filter((s) => s.available);
      // Screen 2 is for a Combo with a real choice; anything else goes straight to its condition.
      if (u.is_combo && u.scopes.length > 1) setScopeFor(u);
      else void openDraft(u, open[0]?.scope ?? 'whole');
    },
    [openDraft]
  );

  // «استبدل هذا الجهاز» on an order page: that device, picked.
  useEffect(() => {
    const item = params.get('item');
    if (!item || !units || mode.kind !== 'home') return;
    const key = `${item}:${Number(params.get('unit')) || 1}`;
    const u = units.find((x) => x.key === key);
    const next = new URLSearchParams(params);
    next.delete('item');
    next.delete('unit');
    setParams(next, { replace: true });
    if (u?.open_request_id) setParams(withTarget({ request: u.open_request_id }), { replace: true });
    else if (u?.available) pick(u);
  }, [params, units, mode.kind, pick, setParams, withTarget]);

  const openRequest = (id: string) => setParams(withTarget({ request: id }), { state: { from: 'home' } });
  const home = () => {
    if (from === 'home') navigate(-1);
    else setParams(withTarget({}), { replace: true });
  };
  const goStep = (next: FlowStep, direction: 'forward' | 'back') => {
    if (mode.kind !== 'flow') return;
    if (direction === 'back' && from === next) {
      navigate(-1);
      return;
    }
    setParams(withTarget({ draft: mode.id, step: next }), {
      state: { from: mode.step },
      replace: direction === 'back',
    });
  };
  const goBack = () => {
    if (mode.kind === 'flow') {
      if (mode.step === 'condition') home();
      else goStep(mode.step === 'offer' ? 'target' : 'condition', 'back');
      return;
    }
    if (mode.kind === 'request') {
      home();
      return;
    }
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  return (
    <div className="w-full min-h-screen pb-28 font-sans text-text-secondary" data-trade-in-page>
      <header className="material material-thin sticky top-0 z-40 flex items-center gap-3 px-4 py-3">
        <IconButton variant="secondary" onClick={goBack} label={t('back')} icon={<Back aria-hidden="true" className="h-5 w-5" />} />
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold leading-6 text-text-primary">{mode.kind === 'request' ? t('requestTitle') : t('title')}</h1>
        {mode.kind === 'home' ? (
          <IconButton variant="ghost" onClick={() => setHow(true)} label={t('howItWorks')} icon={<HelpCircle aria-hidden="true" className="h-5 w-5" />} data-trade-in-how />
        ) : null}
      </header>

      <div className="mx-auto max-w-2xl px-4 pt-4 lg:max-w-[880px]">
        {!isAuthenticated ? (
          <section className="lv-surface space-y-3 p-5" data-trade-in-intro>
            <span className="lv-well inline-flex h-11 w-11 items-center justify-center rounded-full text-gold">
              <Repeat className="h-5 w-5" aria-hidden />
            </span>
            <h2 className="text-[22px] font-black leading-8 text-text-primary">{t('intro.line')}</h2>
            <p className="text-[13.5px] leading-6 text-text-secondary">{t('intro.only')}</p>
            <p className="text-[13.5px] font-semibold text-gold">{t('promise')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="primary" block onClick={signIn} data-trade-in-start>
                {t('signIn')}
              </Button>
              <Button variant="secondary" block onClick={() => setHow(true)}>
                {t('howItWorks')}
              </Button>
            </div>
          </section>
        ) : mode.kind === 'flow' ? (
          <TradeInFlow
            key={mode.id}
            draftId={mode.id}
            step={mode.step}
            targetHint={targetHint}
            onStep={goStep}
            onSent={(id) => setParams({ request: id }, { replace: true })}
            onNotDraft={(id) => setParams({ request: id }, { replace: true })}
            onExit={home}
          />
        ) : mode.kind === 'request' ? (
          <RequestTimeline
            id={mode.id}
            onBack={home}
            onResume={(r) =>
              setParams(withTarget({ draft: r.id, step: 'condition' }), {
                state: { from: 'request' },
              })
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 px-1">
              <p className="min-w-0 text-[13px] leading-5 text-text-secondary">
                {t('intro.line')} · <span className="font-semibold text-gold">{t('promise')}</span>
              </p>
            </div>
            {openError && !scopeFor ? (
              <p role="alert" className="lv-alert lv-alert-danger text-[13px] font-medium text-text-primary">
                {openError}
              </p>
            ) : null}
            <DeviceList
              units={units}
              requests={requests}
              loadError={loadError}
              onRetry={load}
              tab={tab}
              onTab={(next) => {
                setTab(next);
                const p = new URLSearchParams(params);
                if (next === 'requests') p.set('tab', 'requests');
                else p.delete('tab');
                setParams(p, { replace: true });
              }}
              query={query}
              onQuery={setQuery}
              onPick={pick}
              onOpenRequest={openRequest}
            />
            <Note tone="zinc" compact animate={false}>
              {t('credit.note')}
            </Note>
          </div>
        )}
      </div>

      <ScopeSheet unit={scopeFor} busy={opening} error={openError} onClose={() => setScopeFor(null)} onChoose={(scope) => scopeFor && openDraft(scopeFor, scope)} />
      <HowItWorksSheet open={how} onClose={() => setHow(false)} />
    </div>
  );
}
