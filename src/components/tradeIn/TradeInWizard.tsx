/**
 * «استبدل جهازك» — THE WIZARD, one question per screen.
 *
 *   1 الجهاز      pick a device from «طلباتك السابقة» — the server's list of
 *                 this customer's delivered LEVONIS device lines, with the
 *                 reason beside every one that cannot be traded.
 *   2 التفاصيل    what the shop already knows, filled in: name, order, the day
 *                 it arrived, what was paid, the warranty's end, how long it
 *                 has been used and how much cover is left.
 *   3 النطاق      a Combo only: the whole machine, the printer alone, or the
 *                 AMS alone — each with the base price it would be valued on.
 *   4 الحالة      the condition of EACH part on its own (printer, then AMS).
 *   5 الصور       the required angles for each part's family, with progress.
 *   6 الجهاز الجديد the new device and model, priced by the server.
 *   7 التقدير     the preliminary estimate, line by line, and the difference —
 *                 «تقدير أولي — القيمة النهائية بعد الفحص» — then send.
 *
 * WHAT THE SCREEN NEVER DOES: invent a figure. The live estimate is the
 * shared engine (packages/pricing/src/tradeIn.ts) over the rule set the server
 * sent; the target price comes from the server; the estimate on the last step
 * is the server's own, computed from the answers it saved. A draft is created
 * on the server the moment a device and a scope are chosen, which is also the
 * moment that part is claimed — so two tabs cannot trade it twice.
 *
 * OWNER: Sorani to be written by hand (every loc() in this file without a
 * third argument).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, CheckCircle2, Circle, ImagePlus, Loader2, Package, Trash2, AlertTriangle, ShieldCheck, Receipt } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, failureText } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { Button } from '../ui/Button';
import { Money } from '../ui/Money';
import SafeImage from '../ui/SafeImage';
import Note from '../ui/Note';
import Spinner from '../ui/Spinner';
import {
  FAMILY_LABELS,
  MAX_HOURS,
  OPTIONAL_PHOTO,
  REQUIRED_PHOTOS,
  blankInputs,
  checklistOf,
  familyCountsHours,
  missingPhotoAngles,
} from '../../../packages/pricing/src/tradeIn';
import {
  type ComponentInputs,
  type ComponentRole,
  type EligibleUnit,
  type PhotoView,
  type RequestView,
  type TargetOption,
  type TargetView,
  type TradeInRuleSet,
  type TradeInScope,
  contextOf,
  dateText,
  durationText,
  liveEstimate,
} from './model';
import { Breakdown, Card, Checklist, ChoicePills, FactRow, ScalePicker, SectionTitle, SettlementRows, Stepper, TextArea } from './controls';

type Step = 'device' | 'summary' | 'scope' | 'condition' | 'photos' | 'target' | 'review';

interface Props {
  /** `order_item_id:unit_index` from «استبدل هذا الجهاز» on an order page. */
  initialUnitKey?: string | null;
  /** A draft to continue. */
  resume?: RequestView | null;
  onDone: (requestId: string) => void;
  onExit: () => void;
}

function useErr() {
  const { lang, loc } = useLanguage();
  return useCallback(
    (e: unknown, fallback?: string) =>
      apiRefusal(e, lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar') ||
      failureText(e, fallback ?? loc('تعذّر الحفظ. حاول مرة أخرى.', 'Could not save. Try again.')),
    [lang, loc]
  );
}

/** XHR, because a photograph on a slow line needs a progress bar and fetch has none. */
function uploadPhoto(reqId: string, role: ComponentRole, angle: string, file: File, onProgress: (f: number) => void): Promise<PhotoView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/trade-in/requests/${encodeURIComponent(reqId)}/photos`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.photo) resolve(data.photo as PhotoView);
      else reject(new ApiError(xhr.status, String(data.error || 'Upload failed'), typeof data.code === 'string' ? data.code : undefined, data.details as Record<string, unknown> | undefined));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error', 'NETWORK'));
    const fd = new FormData();
    fd.set('file', file);
    fd.set('component', role);
    fd.set('angle', angle);
    fd.set('originalName', file.name.slice(0, 200));
    xhr.send(fd);
  });
}

export default function TradeInWizard({ initialUnitKey, resume, onDone, onExit }: Props) {
  const { loc, lang, dir } = useLanguage();
  const errText = useErr();
  const L = (ar: string, en: string) => loc(ar, en);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const Next = dir === 'rtl' ? ArrowLeft : ArrowRight;

  const [step, setStep] = useState<Step>(resume ? 'condition' : 'device');
  const [units, setUnits] = useState<EligibleUnit[] | null>(null);
  const [unit, setUnit] = useState<EligibleUnit | null>(null);
  const [scope, setScope] = useState<TradeInScope>('whole');
  const [req, setReq] = useState<RequestView | null>(resume ?? null);
  const [inputs, setInputs] = useState<Partial<Record<ComponentRole, ComponentInputs>>>(() => inputsOf(resume ?? null));
  const [role, setRole] = useState<ComponentRole>('device');
  const [targets, setTargets] = useState<TargetOption[] | null>(null);
  const [picked, setPicked] = useState<{ product_id: string; values: Record<string, string>; color_id: string | null } | null>(null);
  const [quote, setQuote] = useState<TargetView | null>(resume?.target ?? null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [note, setNote] = useState(resume?.customer_note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [uploads, setUploads] = useState<Record<string, number>>({});

  // ---------------------------------------------------------- data
  const loadUnits = useCallback(async () => {
    setLoadError('');
    try {
      const data = await api.get<{ units: EligibleUnit[]; rules: Record<string, TradeInRuleSet> }>('/api/trade-in/eligible');
      setUnits(data.units);

      if (initialUnitKey) {
        const u = data.units.find((x) => x.key === initialUnitKey && x.available);
        if (u) {
          setUnit(u);
          setScope(u.scopes.find((s) => s.available)?.scope ?? 'whole');
          setStep('summary');
        }
      }
    } catch (e) {
      setLoadError(errText(e, loc('تعذّر تحميل طلباتك السابقة.', 'Could not load your past orders.')));
    }
  }, [initialUnitKey, errText, loc]);

  useEffect(() => {
    if (!resume) void loadUnits();
  }, [resume, loadUnits]);

  useEffect(() => {
    if ((step === 'target' || step === 'review') && targets === null) {
      api
        .get<{ targets: TargetOption[] }>('/api/trade-in/targets')
        .then((d) => setTargets(d.targets))
        .catch((e) => setError(errText(e)));
    }
  }, [step, targets, errText]);

  const steps: Step[] = useMemo(() => {
    const combo = resume ? resume.is_combo : !!unit?.is_combo;
    return ['device', 'summary', ...(combo ? (['scope'] as Step[]) : []), 'condition', 'photos', 'target', 'review'];
  }, [unit, resume]);
  const index = steps.indexOf(step);

  const productId = req?.source_product_id ?? unit?.product_id ?? '';
  const live = useMemo(() => (req ? liveEstimate({ ...req, target: quote ?? req.target }, inputs, productId) : null), [req, inputs, quote, productId]);

  // ---------------------------------------------------------- transitions
  const go = (s: Step) => {
    setError('');
    setStep(s);
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      /* a test runner without layout */
    }
  };

  const openDraft = async () => {
    if (!unit) return;
    // The same device and part already drafted in this session: keep it.
    if (req && req.order_item_id === unit.order_item_id && req.unit_index === unit.unit_index && req.scope === scope) {
      go('condition');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // A different choice after a draft existed: release the old one first,
      // so its claim does not block the new scope.
      if (req && req.status === 'draft') await api.post(`/api/trade-in/requests/${req.id}/cancel`, { reason: 'changed before sending' });
      const data = await api.post<{ request: RequestView }>('/api/trade-in/requests', {
        order_item_id: unit.order_item_id,
        unit_index: unit.unit_index,
        scope,
      });
      setReq(data.request);
      setInputs(inputsOf(data.request));
      setRole(data.request.components[0]?.role ?? 'device');
      go('condition');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveCondition = async () => {
    if (!req) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.patch<{ request: RequestView }>(`/api/trade-in/requests/${req.id}`, { components: inputs });
      setReq(data.request);
      go('photos');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveTarget = async () => {
    if (!req || !quote) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.patch<{ request: RequestView }>(`/api/trade-in/requests/${req.id}`, {
        target: { product_id: quote.product_id, option_value_ids: quote.option_value_ids, color_id: quote.color_id },
      });
      setReq(data.request);
      go('review');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!req) return;
    setBusy(true);
    setError('');
    try {
      if (note.trim() !== (req.customer_note ?? '')) await api.patch(`/api/trade-in/requests/${req.id}`, { customer_note: note.trim() });
      await api.post(`/api/trade-in/requests/${req.id}/submit`);
      onDone(req.id);
    } catch (e) {
      setError(errText(e, loc('تعذّر الإرسال. حاول مرة أخرى.', 'Could not send. Try again.')));
    } finally {
      setBusy(false);
    }
  };

  // Price the target the moment a complete selection exists.
  useEffect(() => {
    if (!picked || !targets) return;
    const t = targets.find((x) => x.product_id === picked.product_id);
    if (!t) return;
    const complete = t.groups.every((g) => !!picked.values[g.id]) && (t.colors.length === 0 || !!picked.color_id);
    if (!complete) {
      setQuote(null);
      return;
    }
    let alive = true;
    setQuoteBusy(true);
    setError('');
    api
      .post<{ target: TargetView }>('/api/trade-in/target-quote', {
        target: { product_id: t.product_id, option_value_ids: t.groups.map((g) => picked.values[g.id]), color_id: picked.color_id },
      })
      .then((d) => alive && setQuote(d.target))
      .catch((e) => {
        if (!alive) return;
        setQuote(null);
        setError(errText(e));
      })
      .finally(() => alive && setQuoteBusy(false));
    return () => {
      alive = false;
    };
  }, [picked, targets, errText]);

  // ---------------------------------------------------------- photos
  const onFiles = async (r: ComponentRole, angle: string, files: FileList | null) => {
    if (!req || !files || files.length === 0) return;
    for (const file of Array.from(files).slice(0, 3)) {
      const key = `${r}:${angle}:${file.name}:${file.size}`;
      setUploads((u) => ({ ...u, [key]: 0 }));
      setError('');
      try {
        const photo = await uploadPhoto(req.id, r, angle, file, (f) => setUploads((u) => ({ ...u, [key]: f })));
        setReq((cur) =>
          cur ? { ...cur, components: cur.components.map((c) => (c.role === r ? { ...c, photos: [...c.photos, photo] } : c)) } : cur
        );
      } catch (e) {
        setError(errText(e, loc('تعذّر رفع الصورة.', 'Could not upload the photo.')));
      } finally {
        setUploads((u) => {
          const next = { ...u };
          delete next[key];
          return next;
        });
      }
    }
  };

  const removePhoto = async (photo: PhotoView) => {
    if (!req) return;
    try {
      await api.delete(`/api/trade-in/requests/${req.id}/photos/${photo.id}`);
      setReq((cur) => (cur ? { ...cur, components: cur.components.map((c) => ({ ...c, photos: c.photos.filter((p) => p.id !== photo.id) })) } : cur));
    } catch (e) {
      setError(errText(e));
    }
  };

  const photosComplete = !!req && req.components.every((c) => missingPhotoAngles(c.family, c.photos.map((p) => p.angle)).length === 0);

  // ---------------------------------------------------------- render
  const titles: Record<Step, string> = {
    device: L('اختر الجهاز', 'Choose the device'),
    summary: L('تفاصيل الجهاز', 'Device details'),
    scope: L('ماذا تريد أن تستبدل؟', 'What are you trading in?'),
    condition: L('حالة الجهاز', 'Condition'),
    photos: L('صور الجهاز', 'Photos'),
    target: L('الجهاز الجديد', 'Your new device'),
    review: L('التقدير الأولي', 'Preliminary estimate'),
  };

  const source = req?.source ?? (unit ? { ...unit, order_id: unit.order_id } : null);
  const facts = unit
    ? { usage_days: unit.usage_days, warranty_remaining_months: unit.warranty_remaining_months }
    : req
      ? contextOf(req.source)
      : null;

  const canNext =
    step === 'device'
      ? !!unit
      : step === 'scope'
        ? !!unit?.scopes.find((s) => s.scope === scope && s.available)
        : step === 'photos'
          ? photosComplete && Object.keys(uploads).length === 0
          : step === 'target'
            ? !!quote && !quoteBusy
            : true;

  const onNext = () => {
    if (step === 'device') go('summary');
    else if (step === 'summary') {
      if (unit?.is_combo) go('scope');
      else void openDraft();
    } else if (step === 'scope') void openDraft();
    else if (step === 'condition') void saveCondition();
    else if (step === 'photos') go('target');
    else if (step === 'target') void saveTarget();
    else if (step === 'review') void submit();
  };

  const onPrev = () => {
    if (index <= 0 || (resume && step === 'condition')) {
      onExit();
      return;
    }
    const prev = steps[index - 1];
    // Before the draft exists every step is free; after it, the device and
    // scope are fixed (going back to change them cancels the draft on «next»).
    go(prev);
  };

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6 lg:items-start" data-trade-in-form data-step={step}>
      <div className="min-w-0 space-y-4">
        {/* THE PROGRESS — a segment per step; the current one named. */}
        <div>
          <div className="flex gap-1" aria-hidden>
            {steps.map((s, i) => (
              <span key={s} className={`h-1 flex-1 rounded-full transition-colors ${i <= index ? 'bg-gold' : 'bg-zinc-700'}`} />
            ))}
          </div>
          <p className="mt-2 text-[12px] text-zinc-500 tabular-nums">
            {loc(`الخطوة ${index + 1} من ${steps.length}`, `Step ${index + 1} of ${steps.length}`)}
          </p>
          <h2 className="text-white text-[22px] font-black leading-8 mt-0.5">{titles[step]}</h2>
        </div>

        {step === 'device' && (
          <DeviceStep units={units} loadError={loadError} onRetry={loadUnits} selected={unit} onSelect={(u) => {
            setUnit(u);
            setScope(u.scopes.find((s) => s.available)?.scope ?? 'whole');
          }} />
        )}

        {step === 'summary' && source && facts && (
          <Card data-trade-in-summary>
            <div className="flex gap-3 items-center mb-3">
              <SafeImage src={source.image} alt="" aspect="square" className="w-16 h-16 rounded-xl shrink-0" bgClassName="bg-zinc-950" />
              <div className="min-w-0">
                <p className="text-white font-bold text-[15px] leading-6 line-clamp-2">{source.name}</p>
                {source.variant ? <p className="text-[12.5px] text-zinc-500">{source.variant}</p> : null}
                {unit ? <p className="text-[12px] text-gold mt-0.5">{loc(FAMILY_LABELS[unit.family].ar, FAMILY_LABELS[unit.family].en)}</p> : null}
              </div>
            </div>
            <dl>
              <FactRow label={L('رقم الطلب', 'Order')} value={<span dir="ltr" className="font-mono text-[12.5px]">{source.order_id}</span>} />
              <FactRow label={L('تاريخ الاستلام', 'Received')} value={dateText(source.delivered_at, lang)} />
              <FactRow label={L('السعر المدفوع', 'Price paid')} value={<Money iqd={source.paid_iqd ?? 0} />} />
              <FactRow label={L('نهاية الضمان', 'Warranty ends')} value={source.warranty_end_at ? dateText(source.warranty_end_at, lang) : L('غير محدد', 'Not set')} />
              <FactRow label={L('مدة الاستخدام', 'In use for')} value={durationText(facts.usage_days ?? 0, L)} />
              <FactRow
                label={L('المتبقي من الضمان', 'Warranty left')}
                value={facts.warranty_remaining_months > 0 ? loc(`${facts.warranty_remaining_months} شهر`, `${facts.warranty_remaining_months} months`) : L('منتهٍ', 'Expired')}
                strong
              />
            </dl>
            <p className="mt-3 text-[12px] leading-5 text-zinc-500">
              {L('هذه البيانات من طلبك في LEVONIS ولا تحتاج إدخالها.', 'These come from your LEVONIS order — nothing to type.')}
            </p>
          </Card>
        )}

        {step === 'scope' && unit && (
          <ScopeStep unit={unit} scope={scope} onScope={setScope} />
        )}

        {step === 'condition' && req && (
          <ConditionStep req={req} role={role} onRole={setRole} inputs={inputs} setInputs={setInputs} />
        )}

        {step === 'photos' && req && (
          <PhotoStep req={req} role={role} onRole={setRole} uploads={uploads} onFiles={onFiles} onRemove={removePhoto} />
        )}

        {step === 'target' && (
          <TargetStep targets={targets} picked={picked} onPick={setPicked} quote={quote} busy={quoteBusy} current={req?.target ?? null} />
        )}

        {step === 'review' && req && (
          <div className="space-y-4" data-trade-in-review>
            <Note tone="gold" animate={false} icon={<AlertTriangle className="w-4 h-4" />}>
              <p className="font-bold text-white">{L('تقدير أولي — القيمة النهائية بعد الفحص', 'Preliminary estimate — the final value follows the inspection')}</p>
              <p className="text-zinc-400 text-[12.5px] mt-0.5">
                {L(
                  'نحسب هذا الرقم بقواعد التقييم المعلنة. بعد الإرسال يفحص فريق LEVONIS الجهاز، وإن تغيّرت القيمة نرسلها لك لتقبلها أو ترفضها.',
                  'We compute this with the published valuation rules. After you send it, the LEVONIS team inspects the device; if the value changes we send it to you to accept or decline.'
                )}
              </p>
            </Note>
            {req.estimate?.components.map((c) => (
              <Card key={c.role}>
                <Breakdown valuation={c.valuation} title={loc(c.label_ar, c.label_en)} />
              </Card>
            ))}
            {req.estimate?.settlement ? (
              <Card>
                <SectionTitle title={L('الفرق المطلوب', 'What you pay')} hint={L('التوصيل يُحسب عند الدفع كأي طلب.', 'Delivery is added at checkout, like any order.')} />
                <SettlementRows s={req.estimate.settlement} />
                {req.estimate.settlement.excess_iqd > 0 ? (
                  <Note tone="amber" compact animate={false} className="mt-3">
                    {loc(
                      `قيمة جهازك أعلى من سعر الجهاز الجديد. يُحتسب منها ما يغطي الجهاز الجديد فقط، ولا يُصرف الفرق (${(req.estimate.settlement.excess_iqd).toLocaleString('en-US')} د.ع) نقداً أو في المحفظة. يمكنك اختيار جهاز أغلى.`,
                      `Your device is worth more than the new one. Only the new device's price is credited; the rest (${req.estimate.settlement.excess_iqd.toLocaleString('en-US')} IQD) is not paid out in cash or to the wallet. You can choose a dearer device.`
                    )}
                  </Note>
                ) : null}
              </Card>
            ) : null}
            <Card>
              <TextArea label={L('ملاحظات للفريق (اختياري)', 'A note for the team (optional)')} value={note} onChange={setNote} name="note" />
            </Card>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-[13px] text-rose-300 leading-5" data-trade-in-error>
            {error}
          </p>
        ) : null}

        {/* THE ACTION BAR — sticky on the phone, above the tab bar. */}
        <div className="sticky bottom-[calc(var(--nav-stack,0px)+8px)] z-20 lg:static">
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-canvas/95 backdrop-blur-md p-2 shadow-2 lg:shadow-none lg:bg-transparent lg:border-0 lg:p-0">
            <Button variant="secondary" onClick={onPrev} icon={<Back className="w-4 h-4" aria-hidden />} aria-label={L('رجوع', 'Back')}>
              <span className="hidden sm:inline">{L('رجوع', 'Back')}</span>
            </Button>
            {live && step !== 'device' && step !== 'summary' && step !== 'scope' ? (
              <div className="flex-1 min-w-0 px-1 lg:hidden" aria-live="polite">
                <p className="text-[11px] text-zinc-500 leading-4">{L('تقدير أولي', 'Estimate')}</p>
                <p className="text-[15px] font-black text-white leading-5">
                  <Money iqd={live.total} />
                </p>
              </div>
            ) : (
              <div className="flex-1" />
            )}
            <Button
              variant={step === 'review' ? 'accent' : 'primary'}
              onClick={onNext}
              disabled={!canNext || busy}
              loading={busy}
              iconEnd={step === 'review' ? undefined : <Next className="w-4 h-4" aria-hidden />}
              data-trade-in-next
            >
              {step === 'review' ? L('أرسل للمراجعة', 'Send for review') : L('التالي', 'Continue')}
            </Button>
          </div>
        </div>
      </div>

      {/* THE ESTIMATE PANEL — beside the form on a wide screen. */}
      <aside className="hidden lg:block sticky top-20 space-y-3" aria-label={L('التقدير الأولي', 'Preliminary estimate')}>
        <Card>
          <p className="text-[12px] text-zinc-500">{L('تقدير أولي', 'Preliminary estimate')}</p>
          <p className="text-[28px] font-black text-white leading-9 mt-0.5">{live ? <Money iqd={live.total} /> : '—'}</p>
          <p className="text-[12px] text-zinc-500 mt-1">{L('القيمة النهائية بعد الفحص', 'Final value after inspection')}</p>
          {live?.settlement ? (
            <div className="mt-3 pt-3 border-t border-zinc-800">
              <SettlementRows s={live.settlement} />
            </div>
          ) : null}
        </Card>
        {live && live.parts.length > 0 && (step === 'condition' || step === 'photos' || step === 'target') ? (
          <Card>
            {live.parts.map((p) => {
              const c = req?.components.find((x) => x.role === p.role);
              return (
                <div key={p.role} className="mb-3 last:mb-0">
                  <Breakdown valuation={p.valuation} title={c ? (loc(c.label_ar, c.label_en)) : undefined} />
                </div>
              );
            })}
          </Card>
        ) : null}
      </aside>
    </div>
  );
}

function inputsOf(req: RequestView | null): Partial<Record<ComponentRole, ComponentInputs>> {
  const out: Partial<Record<ComponentRole, ComponentInputs>> = {};
  for (const c of req?.components ?? []) out[c.role] = { ...blankInputs(c.family), ...(c.inputs as Partial<ComponentInputs>) };
  return out;
}

// ============================================================ steps

function DeviceStep({
  units,
  loadError,
  onRetry,
  selected,
  onSelect,
}: {
  units: EligibleUnit[] | null;
  loadError: string;
  onRetry: () => void;
  selected: EligibleUnit | null;
  onSelect: (u: EligibleUnit) => void;
}) {
  const { loc, lang } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  if (loadError) {
    return (
      <Card>
        <p className="text-[13px] text-rose-300">{loadError}</p>
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          {L('إعادة المحاولة', 'Try again')}
        </Button>
      </Card>
    );
  }
  if (!units) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (units.length === 0) {
    return (
      <Card data-trade-in-empty>
        <Package className="w-6 h-6 text-zinc-500" aria-hidden />
        <p className="text-white font-bold mt-2">{L('لا توجد أجهزة مؤهلة في طلباتك', 'No eligible devices in your orders')}</p>
        <p className="text-[13px] leading-6 text-zinc-400 mt-1">
          {L(
            'الاستبدال مخصص للطابعات وأجهزة الليزر وملحقات AMS المشتراة من LEVONIS وبعد استلامها. لا نقبل أجهزة من خارج المتجر.',
            'Trade-in is for printers, lasers and AMS units bought from LEVONIS, once delivered. We do not accept devices bought elsewhere.'
          )}
        </p>
      </Card>
    );
  }
  const reasonText = (u: EligibleUnit) => {
    switch (u.reason) {
      case 'TRADE_IN_ALREADY_CLAIMED':
        return u.open_request_id
          ? loc('ضمن طلب استبدال قائم', 'In an open trade-in', 'لە داواکارییەکی کراوەی گۆڕینەوەدایە')
          : loc('استُبدل سابقاً', 'Already traded in', 'پێشتر گۆڕدراوەتەوە');
      case 'TRADE_IN_RETURN_OPEN':
        return loc('عليه طلب إرجاع', 'Has a return case', 'داواکاریی گەڕاندنەوەی لەسەرە');
      case 'TRADE_IN_BELOW_MINIMUM':
        return loc('أقل من الحد الأدنى للاستبدال', 'Below the trade-in minimum', 'لە کەمترین سنووری گۆڕینەوە کەمترە');
      case 'TRADE_IN_NOT_DELIVERED':
        return loc('لم يُستلم بعد', 'Not delivered yet', 'هێشتا نەگەیەندراوە');
      case 'TRADE_IN_GIFT':
        return loc('وصلك هدية — الاستبدال للأجهزة المشتراة', 'A gift — trade-in is for devices you bought', 'دیارییە — گۆڕینەوە بۆ ئامێرە کڕدراوەکانە');
      default:
        return loc('غير متاح للاستبدال', 'Not available', 'بۆ گۆڕینەوە بەردەست نییە');
    }
  };
  return (
    <div className="space-y-2" role="radiogroup" aria-label={L('طلباتك السابقة', 'Your past orders')}>
      <p className="text-[12.5px] text-zinc-500">{L('من طلباتك السابقة في LEVONIS فقط', 'Only from your past LEVONIS orders')}</p>
      {units.map((u) => {
        const on = selected?.key === u.key;
        return (
          <button
            key={u.key}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!u.available}
            onClick={() => onSelect(u)}
            data-unit={u.key}
            className={`w-full text-start flex gap-3 items-center rounded-2xl border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-55 ${
              on ? 'border-gold bg-gold/[0.06]' : 'border-zinc-800 bg-zinc-900/60 enabled:hover:border-zinc-700'
            }`}
          >
            <SafeImage src={u.image} alt="" aspect="square" className="w-14 h-14 rounded-xl shrink-0" bgClassName="bg-zinc-950" />
            <span className="min-w-0 flex-1">
              <span className="block text-white text-[14px] font-bold leading-5 line-clamp-2">{u.name}</span>
              <span className="block text-[12px] text-zinc-500 truncate">
                {[u.variant, loc(FAMILY_LABELS[u.family].ar, FAMILY_LABELS[u.family].en)].filter(Boolean).join(' · ')}
              </span>
              <span className="block text-[11.5px] text-zinc-500 tabular-nums">
                {u.order_id} · {dateText(u.delivered_at, lang)}
              </span>
              {!u.available ? <span className="mt-1 inline-block text-[11.5px] font-semibold text-amber-300">{reasonText(u)}</span> : null}
            </span>
            {u.available ? (
              on ? <CheckCircle2 className="w-5 h-5 text-gold shrink-0" aria-hidden /> : <Circle className="w-5 h-5 text-zinc-700 shrink-0" aria-hidden />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function ScopeStep({ unit, scope, onScope }: { unit: EligibleUnit; scope: TradeInScope; onScope: (s: TradeInScope) => void }) {
  const { loc } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  const label: Record<TradeInScope, { title: string; hint: string }> = {
    whole: { title: L('الجهاز كاملاً', 'The whole device'), hint: L('الطابعة مع وحدة AMS — يُقيَّم كل جزء على حدة.', 'The printer with its AMS — each part assessed on its own.') },
    printer_only: { title: L('الطابعة فقط', 'The printer only'), hint: L('تحتفظ بوحدة AMS.', 'You keep the AMS.') },
    ams_only: { title: L('AMS فقط', 'The AMS only'), hint: L('تحتفظ بالطابعة، ونقيّم وحدة AMS بسعرها ضمن الكومبو.', 'You keep the printer; the AMS is valued at its share of the Combo.') },
  };
  return (
    <div className="space-y-2" role="radiogroup" aria-label={L('ماذا تريد أن تستبدل؟', 'What are you trading in?')}>
      {unit.ams_split.method === 'none' ? (
        <Note tone="amber" compact animate={false}>
          {L('لم نتمكن من تحديد سعر AMS ضمن هذا الكومبو، لذا يُستبدل الجهاز كاملاً فقط.', 'We could not price the AMS inside this Combo, so only the whole device can be traded.')}
        </Note>
      ) : null}
      {unit.scopes.map((s) => {
        const on = s.scope === scope;
        const base = s.components.reduce((n, c) => n + c.base_iqd, 0);
        return (
          <button
            key={s.scope}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!s.available}
            onClick={() => onScope(s.scope)}
            data-scope={s.scope}
            className={`w-full text-start rounded-2xl border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${
              on ? 'border-gold bg-gold/[0.06]' : 'border-zinc-800 bg-zinc-900/60 enabled:hover:border-zinc-700'
            }`}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="text-white font-bold text-[15px]">{label[s.scope].title}</span>
              <span className="text-[13px] text-zinc-300">
                <Money iqd={base} />
              </span>
            </span>
            <span className="block text-[12.5px] leading-5 text-zinc-500 mt-1">{label[s.scope].hint}</span>
            {!s.available ? <span className="block text-[12px] text-amber-300 mt-1">{L('غير متاح لهذا الجهاز', 'Not available for this device')}</span> : null}
          </button>
        );
      })}
      <p className="text-[12px] leading-5 text-zinc-500 pt-1">
        {L(
          'سعر AMS يُحسب من فرق سعر خيار الكومبو عن الخيار العادي، كنسبة مما دفعته فعلاً.',
          'The AMS price is the gap between the Combo option and the plain one, as a share of what you actually paid.'
        )}
      </p>
    </div>
  );
}

const SCALES = (L: (ar: string, en: string) => string) => ({
  cleanliness: [
    L('متسخ جداً، بقايا واضحة', 'Very dirty, visible residue'),
    L('متسخ', 'Dirty'),
    L('مقبول', 'Acceptable'),
    L('نظيف', 'Clean'),
    L('نظيف كالجديد', 'Clean as new'),
  ] as [string, string, string, string, string],
  exterior: [
    L('كسور أو تشققات', 'Cracks or breaks'),
    L('تلف واضح', 'Visible damage'),
    L('آثار استخدام عادية', 'Normal signs of use'),
    L('جيدة جداً', 'Very good'),
    L('كالجديد', 'Like new'),
  ] as [string, string, string, string, string],
  scratches: [
    L('خدوش عميقة وكثيرة', 'Many deep scratches'),
    L('خدوش واضحة', 'Visible scratches'),
    L('خدوش خفيفة', 'Light scratches'),
    L('بالكاد تُرى', 'Barely visible'),
    L('بلا خدوش', 'No scratches'),
  ] as [string, string, string, string, string],
  accessory_condition: [
    L('تالفة', 'Damaged'),
    L('مستهلكة', 'Worn'),
    L('مقبولة', 'Acceptable'),
    L('جيدة', 'Good'),
    L('كالجديدة', 'Like new'),
  ] as [string, string, string, string, string],
});

function RoleTabs({ req, role, onRole }: { req: RequestView; role: ComponentRole; onRole: (r: ComponentRole) => void }) {
  const { loc } = useLanguage();
  if (req.components.length < 2) return null;
  return (
    <div role="tablist" aria-label={loc('أجزاء الجهاز', 'Parts')} className="grid grid-cols-2 gap-1 rounded-2xl bg-zinc-950/40 p-1 border border-zinc-800">
      {req.components.map((c) => (
        <button
          key={c.role}
          type="button"
          role="tab"
          aria-selected={c.role === role}
          onClick={() => onRole(c.role)}
          className={`min-h-[44px] rounded-xl px-2 text-[13px] font-bold truncate transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
            c.role === role ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {c.role === 'ams' ? 'AMS' : loc('الطابعة', 'Printer')}
        </button>
      ))}
    </div>
  );
}

function ConditionStep({
  req,
  role,
  onRole,
  inputs,
  setInputs,
}: {
  req: RequestView;
  role: ComponentRole;
  onRole: (r: ComponentRole) => void;
  inputs: Partial<Record<ComponentRole, ComponentInputs>>;
  setInputs: React.Dispatch<React.SetStateAction<Partial<Record<ComponentRole, ComponentInputs>>>>;
}) {
  const { loc } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  const comp = req.components.find((c) => c.role === role) ?? req.components[0];
  const rules = comp ? req.rules[comp.family] : undefined;
  const value = comp ? inputs[comp.role] : undefined;
  if (!comp || !rules || !value) return null;
  const set = (patch: Partial<ComponentInputs>) => setInputs((cur) => ({ ...cur, [comp.role]: { ...(cur[comp.role] as ComponentInputs), ...patch } }));
  const toggle = (key: 'faults' | 'replaced_parts', id: string) =>
    set({ [key]: value[key].includes(id) ? value[key].filter((x) => x !== id) : [...value[key], id] } as Partial<ComponentInputs>);
  const scales = SCALES(L);
  const faults = checklistOf(rules, 'faults').map((i) => ({ id: i.id, label: loc(i.label_ar, i.label_en) }));
  const parts = checklistOf(rules, 'replaced_parts').map((i) => ({ id: i.id, label: loc(i.label_ar, i.label_en) }));
  const enabled = (id: string) => rules.factors.some((f) => f.factor === id && f.enabled);
  return (
    <div className="space-y-4" data-condition={comp.role}>
      <RoleTabs req={req} role={comp.role} onRole={onRole} />
      <p className="text-[12.5px] text-zinc-500">
        {loc(comp.label_ar, comp.label_en)} · {loc(FAMILY_LABELS[comp.family].ar, FAMILY_LABELS[comp.family].en)}
      </p>
      {familyCountsHours(comp.family) && value.hours !== null ? (
        <Card>
          <Stepper
            name="hours"
            label={L('ساعات التشغيل الفعلية', 'Actual operating hours')}
            value={value.hours}
            onChange={(v) => set({ hours: v })}
            step={10}
            max={MAX_HOURS}
            unit={L('ساعة', 'h')}
            hint={L('تجدها غالباً في إعدادات الشاشة أو التطبيق («وقت الطباعة»).', 'Usually in the screen settings or the app ("print time").')}
          />
        </Card>
      ) : null}
      <Card className="space-y-5">
        <ScalePicker name="cleanliness" label={L('حالة النظافة', 'Cleanliness')} value={value.cleanliness} onChange={(v) => set({ cleanliness: v })} descriptions={scales.cleanliness} />
        <ScalePicker name="exterior" label={L('الحالة الخارجية', 'Exterior')} value={value.exterior} onChange={(v) => set({ exterior: v })} descriptions={scales.exterior} />
        <ScalePicker name="scratches" label={L('الخدوش', 'Scratches')} value={value.scratches} onChange={(v) => set({ scratches: v })} descriptions={scales.scratches} />
      </Card>
      {faults.length > 0 ? (
        <Card className="space-y-3">
          <Checklist name="faults" label={L('المشاكل أو الأعطال', 'Problems or faults')} items={faults} selected={value.faults} onToggle={(id) => toggle('faults', id)} emptyLabel={L('لا توجد مشاكل', 'No problems')} />
          <TextArea name="fault_notes" label={L('صف المشكلة (اختياري)', 'Describe the problem (optional)')} value={value.fault_notes} onChange={(v) => set({ fault_notes: v })} />
        </Card>
      ) : null}
      <Card className="space-y-4">
        <Stepper name="repairs" label={L('عدد الإصلاحات السابقة', 'Previous repairs')} value={value.repairs_count} onChange={(v) => set({ repairs_count: v })} max={20} />
        {parts.length > 0 && enabled('replaced_parts') ? (
          <Checklist name="parts" label={L('القطع المستبدلة', 'Replaced parts')} items={parts} selected={value.replaced_parts} onToggle={(id) => toggle('replaced_parts', id)} emptyLabel={L('لا شيء', 'None')} />
        ) : null}
        <TextArea name="repair_notes" label={L('تفاصيل الإصلاحات (اختياري)', 'Repair details (optional)')} value={value.repair_notes} onChange={(v) => set({ repair_notes: v })} />
      </Card>
      <Card className="space-y-5">
        {enabled('accessory_condition') ? (
          <ScalePicker name="accessory_condition" label={L('حالة الملحقات المرفقة', 'Included accessories')} value={value.accessory_condition} onChange={(v) => set({ accessory_condition: v })} descriptions={scales.accessory_condition} />
        ) : null}
        <ChoicePills
          name="original_accessories"
          label={L('الملحقات الأصلية والعلبة', 'Original accessories & box')}
          value={value.original_accessories}
          onChange={(v) => set({ original_accessories: v })}
          options={[
            { id: 'all', label: L('كاملة', 'All') },
            { id: 'partial', label: L('بعضها', 'Some') },
            { id: 'none', label: L('لا شيء', 'None') },
          ]}
        />
        <TextArea name="notes" label={L('ملاحظات إضافية (اختياري)', 'Anything else (optional)')} value={value.notes} onChange={(v) => set({ notes: v })} />
      </Card>
      {req.components.length > 1 && comp.role === req.components[0].role ? (
        <button type="button" onClick={() => onRole(req.components[1].role)} className="w-full min-h-[44px] rounded-2xl border border-dashed border-zinc-700 text-[13px] font-bold text-zinc-300 hover:text-white">
          {L('التالي: حالة AMS', 'Next: the AMS condition')}
        </button>
      ) : null}
    </div>
  );
}

function PhotoStep({
  req,
  role,
  onRole,
  uploads,
  onFiles,
  onRemove,
}: {
  req: RequestView;
  role: ComponentRole;
  onRole: (r: ComponentRole) => void;
  uploads: Record<string, number>;
  onFiles: (r: ComponentRole, angle: string, files: FileList | null) => void;
  onRemove: (p: PhotoView) => void;
}) {
  const { loc } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  const comp = req.components.find((c) => c.role === role) ?? req.components[0];
  if (!comp) return null;
  const angles = [...REQUIRED_PHOTOS[comp.family], OPTIONAL_PHOTO];
  const done = REQUIRED_PHOTOS[comp.family].filter((a) => comp.photos.some((p) => p.angle === a.id)).length;
  return (
    <div className="space-y-3" data-photos={comp.role}>
      <RoleTabs req={req} role={comp.role} onRole={onRole} />
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-zinc-400">{L('صور إلزامية من عدة زوايا', 'Required photos from several angles')}</p>
        <p className="text-[13px] font-bold text-white tabular-nums">
          {done}/{REQUIRED_PHOTOS[comp.family].length}
        </p>
      </div>
      <ul className="space-y-2">
        {angles.map((a) => {
          const mine = comp.photos.filter((p) => p.angle === a.id);
          const busy = Object.entries(uploads).filter(([k]) => k.startsWith(`${comp.role}:${a.id}:`));
          const required = a.id !== OPTIONAL_PHOTO.id;
          const ok = mine.length > 0;
          return (
            <li key={a.id} className={`rounded-2xl border p-3 ${ok ? 'border-emerald-900/60 bg-emerald-950/10' : 'border-zinc-800 bg-zinc-900/60'}`} data-angle={a.id}>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0">
                  {ok ? <CheckCircle2 className="w-5 h-5 text-emerald-400" aria-hidden /> : <Camera className={`w-5 h-5 ${required ? 'text-zinc-400' : 'text-zinc-600'}`} aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-white text-[14px] font-bold leading-5">
                    {loc(a.label_ar, a.label_en)}
                    {required ? <span className="text-rose-300 ms-1" aria-label={L('مطلوبة', 'required')}>*</span> : null}
                  </p>
                  <p className="text-[12px] leading-5 text-zinc-500">{loc(a.hint_ar, a.hint_en)}</p>
                  {mine.length > 0 || busy.length > 0 ? (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {mine.map((p) => (
                        <div key={p.id} className="relative w-16 h-16 rounded-xl overflow-hidden bg-zinc-950">
                          <img src={p.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          <button
                            type="button"
                            onClick={() => onRemove(p)}
                            aria-label={L('حذف الصورة', 'Remove photo')}
                            className="absolute top-0.5 end-0.5 h-7 w-7 rounded-full bg-black/70 text-white flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden />
                          </button>
                        </div>
                      ))}
                      {busy.map(([k, f]) => (
                        <div key={k} className="w-16 h-16 rounded-xl bg-zinc-950 border border-zinc-800 flex flex-col items-center justify-center gap-1">
                          <Loader2 className="w-4 h-4 text-gold animate-spin" aria-hidden />
                          <span className="text-[10.5px] text-zinc-400 tabular-nums">{Math.round(f * 100)}%</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <label className="shrink-0 inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-xl bg-zinc-800 text-white text-[12.5px] font-bold cursor-pointer hover:bg-zinc-700 focus-within:ring-2 focus-within:ring-focus">
                  <ImagePlus className="w-4 h-4" aria-hidden />
                  <span>{ok ? L('إضافة', 'Add') : L('تصوير', 'Photo')}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(e) => {
                      onFiles(comp.role, a.id, e.target.files);
                      e.target.value = '';
                    }}
                    data-upload={a.id}
                  />
                </label>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[12px] leading-5 text-zinc-500 flex items-start gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
        {L('الصور خاصة: تراها أنت وفريق الفحص في LEVONIS فقط.', 'Photos are private: only you and the LEVONIS inspection team can see them.')}
      </p>
    </div>
  );
}

function TargetStep({
  targets,
  picked,
  onPick,
  quote,
  busy,
  current,
}: {
  targets: TargetOption[] | null;
  picked: { product_id: string; values: Record<string, string>; color_id: string | null } | null;
  onPick: (p: { product_id: string; values: Record<string, string>; color_id: string | null }) => void;
  quote: TargetView | null;
  busy: boolean;
  current: TargetView | null;
}) {
  const { loc } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  if (!targets) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  const chosen = picked ? targets.find((t) => t.product_id === picked.product_id) ?? null : null;
  const chip = (on: boolean) =>
    `min-h-[40px] px-3.5 rounded-full border text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
      on ? 'border-gold bg-gold/10 text-gold' : 'border-zinc-800 text-zinc-300 hover:border-zinc-700'
    }`;
  return (
    <div className="space-y-3" data-targets>
      {current && !picked ? (
        <Note tone="zinc" compact animate={false}>
          {L('اخترت سابقاً:', 'You chose:')} <strong className="text-white">{loc(current.name_ar, current.name)}</strong>
        </Note>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {targets.map((t) => {
          const on = picked?.product_id === t.product_id;
          return (
            <button
              key={t.product_id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onPick({
                  product_id: t.product_id,
                  // A single-value group needs no question.
                  values: Object.fromEntries(t.groups.filter((g) => g.values.length === 1).map((g) => [g.id, g.values[0].id])),
                  color_id: t.colors.length === 1 ? t.colors[0].id : null,
                })
              }
              data-target={t.product_id}
              className={`text-start rounded-2xl border p-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                on ? 'border-gold bg-gold/[0.06]' : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
              }`}
            >
              <SafeImage src={t.image} alt="" aspect="square" className="w-full rounded-xl" bgClassName="bg-zinc-950" />
              <span className="block mt-2 text-white text-[13px] font-bold leading-5 line-clamp-2">{loc(t.name_ar, t.name)}</span>
              <span className="block text-[11.5px] text-zinc-500">{loc(FAMILY_LABELS[t.family].ar, FAMILY_LABELS[t.family].en)}</span>
            </button>
          );
        })}
      </div>
      {chosen ? (
        <Card className="space-y-4">
          {chosen.groups.filter((g) => g.values.length > 1).map((g) => (
            <fieldset key={g.id}>
              <legend className="text-[13.5px] font-semibold text-zinc-200 mb-2">{g.name || L('الموديل', 'Model')}</legend>
              <div className="flex flex-wrap gap-2">
                {g.values.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    aria-pressed={picked?.values[g.id] === v.id}
                    className={chip(picked?.values[g.id] === v.id)}
                    onClick={() => picked && onPick({ ...picked, values: { ...picked.values, [g.id]: v.id } })}
                  >
                    {loc(v.label_ar, v.label_en)}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
          {chosen.colors.length > 1 ? (
            <fieldset>
              <legend className="text-[13.5px] font-semibold text-zinc-200 mb-2">{L('اللون', 'Colour')}</legend>
              <div className="flex flex-wrap gap-2">
                {chosen.colors.map((c) => (
                  <button key={c.id} type="button" aria-pressed={picked?.color_id === c.id} className={chip(picked?.color_id === c.id)} onClick={() => picked && onPick({ ...picked, color_id: c.id })}>
                    <span className="inline-block w-3 h-3 rounded-full border border-zinc-600 me-1.5 align-middle" style={{ background: c.hex }} aria-hidden />
                    {loc(c.label_ar, c.label_en)}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="flex items-center justify-between gap-3 pt-1" aria-live="polite">
            <span className="text-[13px] text-zinc-400">{L('سعر البيع المباشر', 'Direct-sale price')}</span>
            <span className="text-[17px] font-black text-white">
              {busy ? <Spinner size="sm" /> : quote && quote.product_id === chosen.product_id ? <Money iqd={quote.price_iqd} /> : L('اختر الخيارات', 'Choose the options')}
            </span>
          </div>
        </Card>
      ) : null}
      <p className="text-[12px] leading-5 text-zinc-500 flex items-center gap-1.5">
        <Receipt className="w-3.5 h-3.5" aria-hidden />
        {L('السعر من الخادم، بسعر البيع المباشر بعد العمولة، ويُعاد التحقق منه عند الاعتماد.', 'The price comes from the server — the direct-sale price after commission — and is checked again when the value is fixed.')}
      </p>
    </div>
  );
}
