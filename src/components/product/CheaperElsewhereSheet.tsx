/**
 * «وجدتها بمكان أرخص» — the customer tells us where.
 *
 * WHAT THIS PROMISES, AND WHAT IT DOES NOT. The shop will LOOK at the price.
 * It does not promise to match it, because nobody agreed to match anything —
 * worker/routes/priceReports.ts makes the same point at length, and the two
 * must not drift: a confirmation that promises a match creates an obligation
 * the owner never made, on a screen the owner never sees, and the customer
 * discovers it is untrue at the till. The second sentence gives the honest
 * reason two figures can differ, so «we will look» does not read as a brush-off.
 *
 * THE FORM IS ONE REQUIRED FIELD. Only the price is mandatory. The owner asked
 * for the place and the link «إن أمكن», and a form that refuses to submit
 * without a link is a form most people abandon — the number alone is already
 * the signal the owner wants ranked.
 *
 * ON FAILURE THE SHEET STAYS OPEN WITH WHAT WAS TYPED. A sheet that closes on
 * a refusal has thrown the customer's work away and shown the refusal on the
 * page behind it; `REPORT_ALREADY_OPEN` in particular is a message about
 * something they already did, so closing would leave them re-typing a report
 * we are telling them we already have.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { asLang } from '../orders/format';
import { apiRefusal } from '../../lib/refusalStrings';

/** The server's own bounds (worker/routes/priceReports.ts), so the field stops
 *  what the route would refuse rather than sending a round trip to learn it. */
const MAX_PRICE_IQD = 1_000_000_000;
const MAX_SELLER = 120;
const MAX_URL = 500;

const STRINGS = {
  ar: {
    title: 'وجدتها بمكان أرخص؟',
    intro: 'اكتب السعر اللي شفته وراح نطّلع عليه.',
    price: 'السعر اللي شفته (دينار)',
    pricePlaceholder: 'مثلاً 450000',
    seller: 'المحل أو المكان (اختياري)',
    sellerPlaceholder: 'اسم المحل أو الصفحة',
    url: 'الرابط (اختياري)',
    submit: 'إرسال',
    sending: 'جارٍ الإرسال…',
    close: 'إغلاق',
    done: 'إغلاق',
    priceRequired: 'اكتب السعر اللي شفته.',
    priceRange: 'اكتب سعرًا صحيحًا بالدينار.',
    failed: 'تعذر إرسال البلاغ. حاول مرة ثانية.',
    thanksTitle: 'وصلنا، شكرًا',
    /* Honest: we look. We do not match. */
    thanksBody: 'راح نطّلع على السعر ونقارنه. انتبه أن أسعارنا تشمل الضمان والدعم المحلي عدنا.',
  },
  en: {
    title: 'Found it cheaper somewhere else?',
    intro: 'Tell us the price you saw and the shop will look at it.',
    price: 'The price you saw (IQD)',
    pricePlaceholder: 'e.g. 450000',
    seller: 'Shop or place (optional)',
    sellerPlaceholder: 'Shop or page name',
    url: 'Link (optional)',
    submit: 'Send',
    sending: 'Sending…',
    close: 'Close',
    done: 'Close',
    priceRequired: 'Enter the price you saw.',
    priceRange: 'Enter a valid price in IQD.',
    failed: 'The report could not be sent. Please try again.',
    thanksTitle: 'Thank you — we have it',
    thanksBody:
      'The shop will look at this price and compare it. Note that our prices include our own warranty and local support.',
  },
  ckb: {
    title: 'لە شوێنێکی هەرزانتر دۆزیتەوە؟',
    intro: 'ئەو نرخە بنووسە کە بینیوتە و فرۆشگا سەیری دەکات.',
    price: 'ئەو نرخەی بینیوتە (دینار)',
    pricePlaceholder: 'بۆ نموونە ٤٥٠٠٠٠',
    seller: 'فرۆشگا یان شوێن (ئارەزوومەندانە)',
    sellerPlaceholder: 'ناوی فرۆشگا یان پەڕە',
    url: 'بەستەر (ئارەزوومەندانە)',
    submit: 'ناردن',
    sending: 'ناردن…',
    close: 'داخستن',
    done: 'داخستن',
    priceRequired: 'ئەو نرخە بنووسە کە بینیوتە.',
    priceRange: 'نرخێکی دروست بە دینار بنووسە.',
    failed: 'ڕاپۆرتەکە نەنێردرا. تکایە دووبارە هەوڵ بدەرەوە.',
    thanksTitle: 'گەیشت، سوپاس',
    thanksBody:
      'فرۆشگا سەیری ئەم نرخە دەکات و بەراوردی دەکات. سەرنج بدە کە نرخەکانمان گەرەنتی و پشتگیری ناوخۆیی لەخۆدەگرن.',
  },
} as const;

const LABEL = 'block text-[12.5px] font-bold text-zinc-300 mb-1.5';
/* `text-[16px]` on purpose, and never smaller: Mobile Safari zooms the viewport
   whenever a focused control computes under 16px and does not zoom back out.
   src/index.css carries the coarse-pointer floor that enforces this globally;
   stating it here keeps the field honest at every pointer type. */
const FIELD = 'lv-input text-[16px] w-full';

export default function CheaperElsewhereSheet({
  open,
  productId,
  onClose,
}: {
  open: boolean;
  productId: string;
  onClose: () => void;
}) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const [price, setPrice] = useState('');
  const [seller, setSeller] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  // A fresh open is a fresh report. Without this, re-opening after a success
  // shows the thank-you for a report the customer has not filed yet.
  useEffect(() => {
    if (open) {
      setPrice('');
      setSeller('');
      setUrl('');
      setError('');
      setBusy(false);
      setSent(false);
    }
  }, [open, productId]);

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (busy) return;
    const trimmed = price.trim();
    if (!trimmed) {
      setError(s.priceRequired);
      return;
    }
    // Integer dinars. The route takes an int, and a decimal or a stray letter
    // would come back as a generic validation refusal that says nothing about
    // which field was wrong.
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 1 || value > MAX_PRICE_IQD) {
      setError(s.priceRange);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/price-reports', {
        productId,
        priceIqd: value,
        sellerName: seller.trim(),
        url: url.trim(),
      });
      setSent(true);
    } catch (e) {
      // The sheet STAYS OPEN and every field keeps what was typed.
      setError(apiRefusal(e, asLang(lang), s.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      label={s.title}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      panelClassName="w-full sm:max-w-md"
      testId="cheaper-elsewhere"
    >
      <div className="px-5 pb-6 pt-2">
        {sent ? (
          <>
            <h2 className="text-white font-bold text-[16px]">{s.thanksTitle}</h2>
            <p className="text-zinc-400 text-[13px] mt-2 leading-relaxed">{s.thanksBody}</p>
            <div className="mt-4">
              <button type="button" onClick={close} className="lv-button lv-button-primary press-scale w-full">
                {s.done}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-white font-bold text-[16px]">{s.title}</h2>
            <p className="text-zinc-400 text-[13px] mt-2 leading-relaxed">{s.intro}</p>

            <div className="mt-4 space-y-3">
              <div>
                <label className={LABEL} htmlFor="cheaper-price">
                  {s.price}
                </label>
                {/*
                  `inputMode="numeric"` brings up the digits pad without the
                  spinner and scroll-to-change that `type="number"` adds, and
                  keeps a typed Arabic-Indic digit visible instead of silently
                  clearing the field the way a number input does.
                */}
                <input
                  id="cheaper-price"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder={s.pricePlaceholder}
                  disabled={busy}
                  className={FIELD}
                />
              </div>

              <div>
                <label className={LABEL} htmlFor="cheaper-seller">
                  {s.seller}
                </label>
                <input
                  id="cheaper-seller"
                  type="text"
                  value={seller}
                  onChange={(e) => setSeller(e.target.value)}
                  placeholder={s.sellerPlaceholder}
                  maxLength={MAX_SELLER}
                  disabled={busy}
                  className={FIELD}
                />
              </div>

              <div>
                <label className={LABEL} htmlFor="cheaper-url">
                  {s.url}
                </label>
                {/* `dir="ltr"` on the value only: a URL is Latin text and reads
                    backwards inside an RTL paragraph. The label stays in the
                    page's own direction. */}
                <input
                  id="cheaper-url"
                  type="url"
                  dir="ltr"
                  inputMode="url"
                  autoComplete="off"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://"
                  maxLength={MAX_URL}
                  disabled={busy}
                  className={FIELD}
                />
              </div>
            </div>

            {/* Always present with a reserved height, so a refusal does not
                shove the two buttons down under the thumb already reaching
                for them. */}
            <p role="alert" aria-live="assertive" className="text-red-400 text-[12.5px] mt-3 min-h-[1.25em]">
              {error}
            </p>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="lv-button lv-button-secondary press-scale flex-1"
              >
                {s.close}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                data-confirm-report
                className="lv-button lv-button-primary press-scale flex-1"
              >
                {busy && <Spinner size="sm" delayMs={0} decorative />}
                {busy ? s.sending : s.submit}
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
