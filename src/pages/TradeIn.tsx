/**
 * «استبدل القديمة بجديدة» — trade an old printer in against a new one.
 *
 * THIS IS A REQUEST, NOT A CATALOGUE. Nothing here has a price, because the
 * price is the answer: the customer describes the machine they own, the shop
 * looks at it and says what it is worth against a new one. Modelling it as a
 * listing would mean inventing a valuation the shop has not made.
 *
 * ─── WHERE THE REQUEST ACTUALLY GOES, AND WHY THAT MATTERS MOST ───
 *
 * There is no trade-in endpoint. `worker/routes/printRequests.ts` is the
 * closest existing shape — a customer describes a job, the shop answers — but
 * a print request is a JOB FOR A MERCHANT: it has a model file, a material, a
 * quantity, a budget and a marketplace of offers, and filing a trade-in as one
 * would put a customer's old printer on a public board for merchants to bid
 * on. That is a different transaction with different money in it, so it is not
 * reused.
 *
 * What this page submits instead is a SUPPORT TICKET — the shop's own inbox,
 * `POST /api/support/tickets`, which already exists, already belongs to the
 * customer's account, already notifies the shop's «‼️ Support» topic the
 * moment it is filed, and already gives the customer a thread at /support
 * where the answer arrives and can be replied to. Every field below is
 * composed into that ticket's first message as plain labelled lines.
 *
 * THE ALTERNATIVE WAS WORSE. A prettier form posting to an endpoint that does
 * not exist — or to nothing at all, with a «تم الإرسال» toast — is the one
 * outcome this page must not have: the customer believes the shop has their
 * request, the shop never hears of it, and nobody finds out until the customer
 * gives up. A real ticket in a real inbox is worth more than a bespoke form.
 * A dedicated trade-in route (with a valuation state machine, photos of the
 * unit, and an offer the customer can accept) is the proper next step and
 * needs a Worker change this page deliberately does not fake.
 *
 * THE CONFIRMATION STEP IS THE SERVER'S RULE, NOT DECORATION. `POST
 * /api/support/tickets` refuses anything without `confirm: true` precisely so
 * an accidental tap cannot open a ticket, so the customer reads back exactly
 * what will be sent before it is sent. The server also rate-limits ticket
 * creation to five an hour; that refusal is surfaced in the customer's own
 * language rather than swallowed.
 *
 * SIGNING IN IS REQUIRED TO SEND, AND ONLY TO SEND. The ticket has to belong
 * to an account or there is nowhere to put the answer. But the explanation of
 * how a trade-in works is what someone came here to read, so it is visible to
 * everyone and the sign-in is asked for at the form, not at the door.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, LifeBuoy, Repeat } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { api, failureText } from '../lib/api';
import { GOVERNORATES } from '../lib/governorates';
import Note from '../components/ui/Note';
import Spinner from '../components/ui/Spinner';

/** What the customer says about the machine they own. Plain words, not the
 *  catalogue's grades: `ConditionKind` describes a unit the SHOP has inspected
 *  and priced, and borrowing its vocabulary here would imply the shop has
 *  already graded a printer it has not seen. */
type Working = 'working' | 'partly' | 'not_working';

const WORKING: readonly Working[] = ['working', 'partly', 'not_working'];

/** Mirrors the server's own bounds so a refusal is prevented, not translated:
 *  `body` is validated at 5..4000 characters and `subject` at 3..200. */
const MAX_BODY = 4000;

export default function TradeIn() {
  const { loc, lang, dir } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const navigate = useNavigate();

  const [model, setModel] = useState('');
  const [working, setWorking] = useState<Working>('working');
  const [hours, setHours] = useState('');
  const [governorate, setGovernorate] = useState('');
  const [wanted, setWanted] = useState('');
  const [notes, setNotes] = useState('');

  const [step, setStep] = useState<'form' | 'review'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modelError, setModelError] = useState('');
  const [sentId, setSentId] = useState('');

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  const workingLabel = (w: Working): string =>
    w === 'working'
      ? loc('تعمل بشكل طبيعي', 'Works normally', 'بە ئاسایی کار دەکات')
      : w === 'partly'
        ? loc('تعمل مع مشاكل', 'Works with problems', 'کار دەکات بەڵام کێشەی هەیە')
        : loc('لا تعمل', 'Does not work', 'کار ناکات');

  const govLabel = (id: string): string => {
    const g = GOVERNORATES.find((x) => x.id === id);
    if (!g) return '';
    return lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar;
  };

  /**
   * THE TICKET'S FIRST MESSAGE, composed once and shown to the customer
   * verbatim on the review step. Labels are bilingual because the person
   * reading it in the admin console is the shop, while the person confirming
   * it is the customer — and a body that only one of them can read is a body
   * that gets misunderstood by the other.
   */
  const body = useMemo(() => {
    const lines = [
      'طلب استبدال طابعة قديمة بجديدة / Trade-in request',
      `الطابعة الحالية / Current printer: ${model.trim()}`,
      `الحالة / State: ${workingLabel(working)}`,
    ];
    if (hours.trim()) lines.push(`ساعات التشغيل / Hours: ${hours.trim()}`);
    if (governorate) lines.push(`المحافظة / Governorate: ${govLabel(governorate)}`);
    if (wanted.trim()) lines.push(`المطلوب / Wanted: ${wanted.trim()}`);
    if (notes.trim()) lines.push(`ملاحظات / Notes: ${notes.trim()}`);
    return lines.join('\n').slice(0, MAX_BODY);
    // `workingLabel` and `govLabel` close over `lang`, which is in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, working, hours, governorate, wanted, notes, lang]);

  const subject = useMemo(
    () => `استبدال طابعة / Trade-in — ${model.trim()}`.slice(0, 200),
    [model]
  );

  const toReview = () => {
    const name = model.trim();
    if (name.length < 2) {
      setModelError(
        loc(
          'اكتب اسم أو موديل الطابعة التي لديك.',
          'Write the name or model of the printer you have.',
          'ناو یان مۆدێلی ئەو پرینتەرەی هەتە بنووسە.'
        )
      );
      return;
    }
    setModelError('');
    setError('');
    if (!isAuthenticated) {
      signIn();
      return;
    }
    setStep('review');
  };

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await api.post<{ ticket: { id: string } }>('/api/support/tickets', {
        // The server refuses without this. It is set HERE, on the send that
        // follows the review screen, and never on the first tap.
        confirm: true,
        subject,
        body,
        // 'manual' and not 'assistant': a person filled this in, no assistant
        // handed it over. The admin console shows that column.
        source: 'manual',
      });
      setSentId(data.ticket?.id || '');
    } catch (e) {
      // The server's own sentence — the rate-limit refusal («خمسة في الساعة»)
      // and every validation refusal say something the customer can act on,
      // and replacing them with a generic failure removes the only useful
      // part.
      setError(
        failureText(
          e,
          loc('تعذّر الإرسال. حاول مرة أخرى.', 'Could not send. Try again.', 'نەنێردرا. دووبارە هەوڵ بدە.')
        )
      );
    } finally {
      setBusy(false);
    }
  };

  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  return (
    <div className="w-full min-h-screen bg-canvas text-zinc-300 font-sans pb-24" data-trade-in-page>
      <header className="sticky top-0 z-40 material material-thin px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-surface-raised text-white hover:bg-surface-selected active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus transition-colors"
        >
          <Back aria-hidden="true" className="w-5 h-5" />
        </button>
        <h1 className="text-white font-bold text-lg leading-6 flex-1 min-w-0 truncate">
          {loc('استبدل القديمة بجديدة', 'Trade in your old printer', 'کۆنەکەت بگۆڕەوە بە نوێ')}
        </h1>
      </header>

      <div className="p-4 max-w-2xl mx-auto space-y-5">
        {/* THE PROMISE IS SIZED TO THE PLUMBING BEHIND IT.
            «يقيّمها فريق ليفو ويخبرك بقيمتها» is an SLA sentence, and the only
            thing standing behind it today is somebody noticing a Telegram
            «‼️ Support» message: this form files a support TICKET, which has no
            valuation record, no state machine, no queue and no admin surface,
            so nothing in the system can say how many valuations are
            outstanding or how old the oldest is. What IS true is that a reply
            comes back in the support thread, and that is what the sentence now
            says. When the trade-in route exists — submitted / valued / offered
            / accepted / declined, with photos and a quoted figure — the
            stronger sentence can come back with it. */}
        <p className="text-[12px] leading-5 text-zinc-500">
          {loc(
            'أرسل وصف طابعتك الحالية ونرد عليك في محادثة الدعم بتقدير لقيمتها عند شراء جهاز جديد. لا يكلفك شيئاً ولا يلزمك بالشراء.',
            'Describe the printer you own and we will come back to you in the support thread with an estimate of what it is worth against a new machine. It costs you nothing and commits you to nothing.',
            'باسی ئەو پرینتەرە بکە کە هەتە و لە گفتوگۆی پشتگیریدا خەمڵاندنێکت بۆ دەگەڕێنینەوە لەسەر ئەوەی چەندە دەبێت بەرامبەر ئامێرێکی نوێ. هیچ تێچوونێکی نییە و ناچارت ناکات بە کڕین.'
          )}
        </p>

        {/* WHERE THIS GOES, said before it is sent and not after. A customer
            who does not know their request became a support thread will not
            think to look for the answer in one. */}
        <Note tone="zinc" compact animate={false}>
          {loc(
            'يُفتح طلبك كمحادثة في «الدعم»، ويصلك الرد هناك.',
            'Your request opens as a thread in Support, and the reply arrives there.',
            'داواکارییەکەت وەک گفتوگۆیەک لە «پشتگیری» دەکرێتەوە و وەڵامەکە لەوێ دێت.'
          )}
        </Note>

        {sentId ? (
          /* SENT — the ticket id is shown because it is the customer's handle
             on this request, and the way to the thread is a link and not a
             sentence telling them to go and find it. */
          <div className="lv-surface p-4 space-y-3 text-center" data-trade-in-sent>
            <CheckCircle2 aria-hidden="true" className="mx-auto h-8 w-8 text-success" />
            <h2 className="text-white font-bold text-base leading-6">
              {loc('وصلنا طلبك', 'We have your request', 'داواکارییەکەت پێگەیشت')}
            </h2>
            <p className="text-[13px] leading-5 text-text-secondary">
              {loc(
                'سيراجعه فريق ليفو ويرد عليك في محادثة الدعم.',
                'The LEVONIS team will review it and reply in your support thread.',
                'تیمی لیڤۆنیس پێداچوونەوەی بۆ دەکات و لە گفتوگۆی پشتگیری وەڵامت دەداتەوە.'
              )}
            </p>
            <p className="text-[12px] leading-5 text-zinc-500">
              <span className="me-1">{loc('رقم الطلب', 'Request number', 'ژمارەی داواکاری')}</span>
              <span dir="ltr" className="tabular-nums text-zinc-300">
                {sentId}
              </span>
            </p>
            <Link to="/support" className="lv-button lv-button-primary px-4 inline-flex">
              <LifeBuoy aria-hidden="true" className="w-4 h-4 me-1.5" />
              {loc('افتح المحادثة', 'Open the thread', 'گفتوگۆکە بکەرەوە')}
            </Link>
          </div>
        ) : step === 'review' ? (
          <div className="lv-surface p-4 space-y-4" data-trade-in-review>
            <h2 className="text-white font-bold text-sm leading-5">
              {loc('راجع ما سيُرسل', 'Review what will be sent', 'پێداچوونەوە بەوەی دەنێردرێت')}
            </h2>
            {/* The exact text, not a summary of it. */}
            <pre
              dir="auto"
              className="whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-3 text-[13px] leading-6 text-zinc-300"
            >
              {body}
            </pre>
            {error ? (
              <p role="alert" className="text-[13px] leading-5 text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={send}
                disabled={busy}
                className="lv-button lv-button-primary px-4 inline-flex items-center gap-2"
              >
                {busy ? <Spinner size="xs" delayMs={0} /> : <Repeat aria-hidden="true" className="w-4 h-4" />}
                {loc('أرسل الطلب', 'Send the request', 'داواکارییەکە بنێرە')}
              </button>
              <button
                type="button"
                onClick={() => setStep('form')}
                disabled={busy}
                className="lv-button lv-button-secondary px-4"
              >
                {loc('تعديل', 'Edit', 'دەستکاری')}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="lv-surface p-4 space-y-4"
            data-trade-in-form
            onSubmit={(e) => {
              e.preventDefault();
              toReview();
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor="trade-in-model" className="block text-[13px] leading-5 font-medium text-white">
                {loc('الطابعة التي لديك', 'The printer you have', 'ئەو پرینتەرەی هەتە')}
              </label>
              <input
                id="trade-in-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                dir="auto"
                autoComplete="off"
                placeholder={loc('مثال: Ender 3 V2', 'e.g. Ender 3 V2', 'نموونە: Ender 3 V2')}
                aria-invalid={modelError ? true : undefined}
                aria-describedby={modelError ? 'trade-in-model-error' : undefined}
                className="lv-input w-full"
              />
              {modelError ? (
                <p id="trade-in-model-error" role="alert" className="text-[12px] leading-4 text-danger">
                  {modelError}
                </p>
              ) : null}
            </div>

            <fieldset className="space-y-1.5">
              <legend className="block text-[13px] leading-5 font-medium text-white mb-1.5">
                {loc('حالة الطابعة', 'Its state', 'حاڵەتی ئامێرەکە')}
              </legend>
              <div className="flex flex-wrap gap-2">
                {WORKING.map((w) => (
                  <button
                    key={w}
                    type="button"
                    aria-pressed={working === w}
                    onClick={() => setWorking(w)}
                    className="lv-choice px-3 py-2 text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {workingLabel(w)}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <label htmlFor="trade-in-hours" className="block text-[13px] leading-5 font-medium text-white">
                {loc('ساعات التشغيل (اختياري)', 'Hours on the clock (optional)', 'کاتژمێری کارکردن (ئارەزوومەندانە)')}
              </label>
              <input
                id="trade-in-hours"
                value={hours}
                onChange={(e) => setHours(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                inputMode="numeric"
                dir="ltr"
                autoComplete="off"
                className="lv-input w-full tabular-nums"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="trade-in-governorate" className="block text-[13px] leading-5 font-medium text-white">
                {loc('المحافظة (اختياري)', 'Governorate (optional)', 'پارێزگا (ئارەزوومەندانە)')}
              </label>
              <select
                id="trade-in-governorate"
                value={governorate}
                onChange={(e) => setGovernorate(e.target.value)}
                className="lv-input w-full"
              >
                <option value="">{loc('— اختر —', '— Choose —', '— هەڵبژێرە —')}</option>
                {GOVERNORATES.map((g) => (
                  <option key={g.id} value={g.id}>
                    {govLabel(g.id)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="trade-in-wanted" className="block text-[13px] leading-5 font-medium text-white">
                {loc('الطابعة التي تريدها (اختياري)', 'The printer you want (optional)', 'ئەو پرینتەرەی دەتەوێت (ئارەزوومەندانە)')}
              </label>
              <input
                id="trade-in-wanted"
                value={wanted}
                onChange={(e) => setWanted(e.target.value)}
                dir="auto"
                autoComplete="off"
                className="lv-input w-full"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="trade-in-notes" className="block text-[13px] leading-5 font-medium text-white">
                {loc('ملاحظات (اختياري)', 'Notes (optional)', 'تێبینی (ئارەزوومەندانە)')}
              </label>
              <textarea
                id="trade-in-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value.slice(0, 1500))}
                dir="auto"
                rows={4}
                placeholder={loc(
                  'الأعطال، القطع المرفقة، أي تعديلات…',
                  'Faults, what is included, any modifications…',
                  'کێشەکان، ئەو شتانەی لەگەڵدایە، هەر گۆڕانکارییەک…'
                )}
                className="lv-input w-full"
              />
            </div>

            {/* The sign-in is named on the button itself for a guest, so the
                tap does not turn into an unexplained redirect. */}
            <button type="submit" className="lv-button lv-button-primary px-4 w-full sm:w-auto">
              {isAuthenticated
                ? loc('راجع وأرسل', 'Review and send', 'پێداچوونەوە و ناردن')
                : loc('سجّل الدخول للمتابعة', 'Sign in to continue', 'بۆ بەردەوامبوون بچۆ ژوورەوە')}
            </button>

            <p className="text-[12px] leading-5 text-zinc-500">
              {loc('تفضّل السؤال مباشرة؟', 'Would you rather just ask?', 'دەتەوێت ڕاستەوخۆ بپرسیت؟')}{' '}
              <Link to="/support" className="text-gold underline underline-offset-2 hover:text-gold-light">
                {loc('تواصل مع الدعم', 'Contact support', 'پەیوەندی بە پشتگیرییەوە بکە')}
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
