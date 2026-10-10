/**
 * «استبدل جهازك» — trade a device bought from LEVONIS against a new one.
 *
 * THIS REPLACES THE SUPPORT-TICKET FORM THAT STOOD HERE, and keeps its rules.
 * That form filed a ticket because there was no trade-in endpoint, and it said
 * so: a prettier form posting to nothing, with a «تم الإرسال» toast, was the
 * one outcome the page must not have. The endpoint now exists
 * (worker/routes/tradeIn.ts, migration 0143) with a valuation state machine,
 * photographs of the unit and a value the customer accepts — exactly the
 * «proper next step» the old header named — so the page is the real thing.
 *
 * THE HONEST-UX PRINCIPLES IT KEEPS:
 *
 *   ONLY WHAT IS TRUE IS PROMISED. The estimate is labelled «تقدير أولي —
 *   القيمة النهائية بعد الفحص» wherever it appears, because it is: the shop
 *   inspects the machine and may change the value, and the customer then
 *   accepts or declines. The credit is a credit against the new device, never
 *   cash, and a value above the new device's price is said to be capped
 *   BEFORE the customer sends the request.
 *
 *   ONLY LEVONIS DEVICES. The first step lists the customer's own delivered
 *   LEVONIS device lines, from the server — there is no field to type a model
 *   the shop never sold. «لا نقبل أي جهاز من خارج LEVONIS» is a list, not a
 *   warning.
 *
 *   THE SERVER DECIDES EVERY FIGURE. The price paid, the dates, the warranty
 *   left, the new device's direct-sale price and the estimate all come from
 *   the Worker; the live preview runs the same engine over the same rules.
 *
 *   SIGNING IN IS ASKED FOR AT THE DOOR OF THE FORM, NOT OF THE PAGE. How a
 *   trade-in works is what someone came to read, so it is visible to everyone;
 *   the device list needs an account because it IS the account's orders.
 *
 * Reachable at /trade-in; `?request=<id>` opens one request (the notification
 * links), `?item=<order item>&unit=<n>` starts the wizard on that device (the
 * order page's «استبدل هذا الجهاز»), `?new=1` starts it on the device list.
 *
 * OWNER: Sorani to be written by hand (every loc() in this file without a
 * third argument).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Camera, ClipboardCheck, PackageSearch, Repeat, ShieldCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { api, failureText } from '../lib/api';
import { Button, IconButton } from '../components/ui/Button';
import { Money } from '../components/ui/Money';
import Note from '../components/ui/Note';
import SafeImage from '../components/ui/SafeImage';
import Spinner from '../components/ui/Spinner';
import TradeInWizard from '../components/tradeIn/TradeInWizard';
import TradeInRequest from '../components/tradeIn/TradeInRequest';
import type { RequestSummary, RequestView } from '../components/tradeIn/model';
import { dateText } from '../components/tradeIn/model';

type Mode = { kind: 'home' } | { kind: 'wizard'; unitKey: string | null; resume: RequestView | null } | { kind: 'request'; id: string };

const REQ_ID = /^tin_[0-9a-f]{20}$/;

function modeFromParams(p: URLSearchParams): Mode {
  const id = p.get('request') ?? '';
  if (REQ_ID.test(id)) return { kind: 'request', id };
  const item = p.get('item');
  if (item) return { kind: 'wizard', unitKey: `${item}:${Number(p.get('unit')) || 1}`, resume: null };
  if (p.get('new') === '1') return { kind: 'wizard', unitKey: null, resume: null };
  return { kind: 'home' };
}

export default function TradeIn() {
  const { loc, lang, dir } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>(() => modeFromParams(params));
  const [mine, setMine] = useState<RequestSummary[] | null>(null);
  const [mineError, setMineError] = useState('');

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  // The URL is the source of truth for which screen is open (a notification
  // link, the back button), and the screen writes it back when it moves.
  useEffect(() => {
    setMode((cur) => {
      const next = modeFromParams(params);
      if (cur.kind === 'wizard' && cur.resume && next.kind === 'request' && next.id === cur.resume.id) return cur;
      return next;
    });
  }, [params]);

  const loadMine = useCallback(async () => {
    setMineError('');
    try {
      const d = await api.get<{ requests: RequestSummary[] }>('/api/trade-in/requests');
      setMine(d.requests);
    } catch (e) {
      setMineError(failureText(e, loc('تعذّر تحميل طلباتك.', 'Could not load your requests.')));
    }
  }, [loc]);

  useEffect(() => {
    if (isAuthenticated && mode.kind === 'home') void loadMine();
  }, [isAuthenticated, mode.kind, loadMine]);

  // Both the URL and the screen: a resumed draft is already at ?request=<id>,
  // and setting the same params again would leave the wizard on screen.
  const openRequest = (id: string) => {
    setMode({ kind: 'request', id });
    setParams({ request: id });
  };
  const goHome = () => {
    setMode({ kind: 'home' });
    setParams({});
  };
  const start = () => (isAuthenticated ? setParams({ new: '1' }) : signIn());

  const goBack = () => {
    if (mode.kind !== 'home') {
      goHome();
      return;
    }
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  return (
    <div className="w-full min-h-screen text-text-secondary font-sans pb-28" data-trade-in-page>
      <header className="sticky top-0 z-40 material material-thin px-4 py-3 flex items-center gap-3">
        <IconButton variant="secondary" onClick={goBack} label={L('رجوع', 'Back')} icon={<Back aria-hidden="true" className="w-5 h-5" />} />
        <h1 className="text-text-primary font-bold text-lg leading-6 flex-1 min-w-0 truncate">
          {mode.kind === 'request' ? L('طلب الاستبدال', 'Trade-in request') : L('استبدل جهازك بجديد', 'Trade in your device')}
        </h1>
      </header>

      <div className="px-4 pt-4 max-w-2xl lg:max-w-[1120px] mx-auto">
        {mode.kind === 'wizard' && isAuthenticated ? (
          <TradeInWizard
            key={mode.resume?.id ?? mode.unitKey ?? 'new'}
            initialUnitKey={mode.unitKey}
            resume={mode.resume}
            onDone={(id) => openRequest(id)}
            onExit={goHome}
          />
        ) : mode.kind === 'request' && isAuthenticated ? (
          <TradeInRequest id={mode.id} onBack={goHome} onResume={(r) => setMode({ kind: 'wizard', unitKey: null, resume: r })} />
        ) : (
          <div className="space-y-5 lg:max-w-2xl lg:mx-auto">
            {/* WHAT THIS IS, in four steps a customer can hold in their head. */}
            <section className="lv-surface p-5" data-trade-in-intro>
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-full lv-well text-gold">
                <Repeat className="w-5 h-5" aria-hidden />
              </span>
              <h2 className="text-text-primary text-[22px] font-black leading-8 mt-3">{L('جهازك من LEVONIS يصبح رصيداً لجهاز جديد', 'Your LEVONIS device becomes credit for a new one')}</h2>
              <p className="text-[13.5px] leading-6 text-text-secondary mt-1">
                {L(
                  'للطابعات (FDM و Resin) وأجهزة الليزر وأنظمة الكومبو ووحدات AMS المشتراة من LEVONIS فقط. لا نقبل أجهزة من خارج المتجر.',
                  'For printers (FDM and Resin), lasers, Combo systems and AMS units bought from LEVONIS only. We do not accept devices bought elsewhere.'
                )}
              </p>
              <ol className="mt-4 space-y-3">
                {[
                  { icon: PackageSearch, t: L('اختر الجهاز من طلباتك السابقة', 'Pick the device from your past orders'), d: L('نملأ السعر والتاريخ والضمان تلقائياً.', 'We fill in the price, dates and warranty.') },
                  { icon: Camera, t: L('صف حالته وصوّره', 'Describe and photograph it'), d: L('كل جزء بمفرده — الطابعة والـ AMS.', 'Each part on its own — the printer and the AMS.') },
                  { icon: ClipboardCheck, t: L('اختر الجهاز الجديد وشاهد التقدير', 'Choose the new device and see the estimate'), d: L('بقواعد تقييم معلنة وشفافة.', 'With published, transparent rules.') },
                  { icon: ShieldCheck, t: L('نفحصه ونثبّت القيمة، وتدفع الفرق', 'We inspect, fix the value, you pay the difference'), d: L('إن تغيّرت القيمة نطلب موافقتك أولاً.', 'If the value changes, we ask you first.') },
                ].map((s, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="h-9 w-9 shrink-0 rounded-sm lv-well text-text-primary flex items-center justify-center">
                      <s.icon className="w-4 h-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-text-primary text-[14px] font-bold leading-5">{s.t}</span>
                      <span className="block text-[12.5px] text-text-muted leading-5">{s.d}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <Button variant="primary" block className="mt-5" onClick={start} data-trade-in-start>
                {isAuthenticated ? L('ابدأ الاستبدال', 'Start a trade-in') : L('سجّل الدخول للبدء', 'Sign in to start')}
              </Button>
            </section>

            {isAuthenticated ? (
              <section aria-labelledby="ti-mine">
                <h2 id="ti-mine" className="text-text-primary text-[17px] font-bold mb-2">
                  {L('طلباتي للاستبدال', 'My trade-ins')}
                </h2>
                {mineError ? (
                  <div className="rounded-2xl border border-border-subtle p-4">
                    <p className="text-[13px] text-rose-300">{mineError}</p>
                    <Button variant="secondary" className="mt-2" onClick={loadMine}>
                      {L('إعادة المحاولة', 'Try again')}
                    </Button>
                  </div>
                ) : mine === null ? (
                  <div className="flex justify-center py-6">
                    <Spinner />
                  </div>
                ) : mine.length === 0 ? (
                  <p className="text-[13px] text-text-muted rounded-2xl border border-dashed border-border-subtle p-4">
                    {L('لا توجد طلبات استبدال بعد.', 'No trade-in requests yet.')}
                  </p>
                ) : (
                  <ul className="lv-surface overflow-hidden divide-y divide-border-subtle">
                    {mine.map((r) => {
                      const value = r.final_value_iqd ?? r.admin_value_iqd ?? r.estimated_iqd;
                      const waiting = r.status === 'value_changed' || r.status === 'awaiting_payment' || r.status === 'draft';
                      return (
                        <li key={r.id}>
                          <button
                            type="button"
                            onClick={() => openRequest(r.id)}
                            data-request={r.id}
                            className="w-full text-start flex items-center gap-3 p-3 transition-colors hover:bg-white/[0.04] active:bg-[var(--clay-well-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                          >
                            <SafeImage src={r.image} alt="" aspect="square" className="w-12 h-12 rounded-md shrink-0" bgClassName="bg-surface" />
                            <span className="min-w-0 flex-1">
                              <span className="block text-text-primary text-[14px] font-bold leading-5 truncate">{r.name}</span>
                              <span className={`block text-[12px] font-semibold ${waiting ? 'text-gold' : 'text-text-muted'}`}>
                                {loc(r.status_label.ar, r.status_label.en)}
                              </span>
                              <span className="block text-[11.5px] text-text-muted">{dateText(r.created_at, lang)}</span>
                            </span>
                            {value !== null ? (
                              <span className="text-[13px] font-bold text-text-primary shrink-0">
                                <Money iqd={value} />
                              </span>
                            ) : null}
                            <Chevron className="w-4 h-4 text-text-muted shrink-0" aria-hidden />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ) : null}

            <Note tone="zinc" compact animate={false}>
              {L(
                'قيمة الاستبدال رصيد يُخصم من سعر الجهاز الجديد عند الطلب، وليست مبلغاً نقدياً. إذا زادت قيمة جهازك عن سعر الجهاز الجديد يُحتسب منها سعر الجهاز الجديد فقط.',
                'The trade-in value is credit taken off the new device’s price at checkout, not cash. If your device is worth more than the new one, only the new device’s price is credited.'
              )}
            </Note>
          </div>
        )}
      </div>
    </div>
  );
}
