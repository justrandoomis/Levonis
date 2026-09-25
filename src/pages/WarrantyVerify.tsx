/**
 * /warranty/:receiptNo — the public verification page.
 *
 * PUBLIC ON PURPOSE, AND THIN ON PURPOSE. Whoever holds the paper (or the
 * device, via its serial) may check that the warranty is real and still runs.
 * What comes back proves coverage and nothing else: no address, no phone, no
 * price, no order — a receipt found in a bin must not become a lookup tool
 * for the person who found it. The serial is masked to its last four so the
 * holder can match it to the sticker without the page publishing it.
 *
 * The page also accepts a typed number or serial, because the most common
 * arrival is a customer at the counter reading from the device.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ShieldCheck, ShieldX, ShieldAlert, Search, Loader2 } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';

interface PublicWarranty {
  receipt_no: string;
  status: 'draft' | 'active' | 'expired' | 'void' | 'replaced';
  product: string;
  model: string;
  serial_masked: string;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  warranty_months: number;
  warranty_type: string;
  purchase_date: string | null;
  days_remaining: number | null;
  retailer: { name: string; website: string; instagram: string; phone: string };
  note: 'replaced' | 'void' | null;
}

const STR = {
  ar: {
    title: 'التحقق من الضمان',
    lead: 'أدخل رقم وصل الضمان أو الرقم التسلسلي للجهاز.',
    placeholder: 'WR-2026-0902-001 أو الرقم التسلسلي',
    check: 'تحقق',
    checking: 'جارٍ التحقق…',
    covered: 'الضمان ساري',
    expired: 'انتهت مدة الضمان',
    voided: 'هذا الوصل ملغى',
    replaced: 'استُبدل الجهاز — الضمان انتقل إلى الوصل البديل',
    notFound: 'لا يوجد وصل ضمان بهذا الرقم.',
    notFoundHint: 'تأكد من الرقم كما هو مطبوع على الوصل، أو تواصل مع الدعم.',
    receiptNo: 'رقم الوصل',
    product: 'المنتج',
    model: 'الموديل',
    serial: 'الرقم التسلسلي',
    type: 'نوع الضمان',
    period: 'المدة',
    start: 'بداية الضمان',
    end: 'نهاية الضمان',
    purchase: 'تاريخ الشراء',
    daysLeft: (n: number) => `${n} يومًا متبقية`,
    months: (n: number) => (n === 12 ? 'سنة واحدة' : n === 24 ? 'سنتان' : `${n} شهرًا`),
    retailer: 'البائع المعتمد',
    privacy: 'هذه الصفحة تعرض حالة الضمان فقط. بيانات الزبون لا تُنشر هنا.',
    error: 'تعذّر التحقق الآن. حاول مرة أخرى بعد قليل.',
  },
  en: {
    title: 'Warranty verification',
    lead: 'Enter the warranty receipt number or the device serial.',
    placeholder: 'WR-2026-0902-001 or the serial number',
    check: 'Verify',
    checking: 'Verifying…',
    covered: 'Warranty is active',
    expired: 'Warranty period has ended',
    voided: 'This receipt is void',
    replaced: 'Device replaced — coverage moved to the replacement receipt',
    notFound: 'No warranty receipt matches this number.',
    notFoundHint: 'Check it against the printed receipt, or contact support.',
    receiptNo: 'Receipt no.',
    product: 'Product',
    model: 'Model',
    serial: 'Serial number',
    type: 'Warranty type',
    period: 'Period',
    start: 'Warranty start',
    end: 'Warranty end',
    purchase: 'Date of purchase',
    daysLeft: (n: number) => `${n} days remaining`,
    months: (n: number) => (n === 12 ? '1 year' : n === 24 ? '2 years' : `${n} months`),
    retailer: 'Authorized retailer',
    privacy: 'This page shows warranty status only. No customer details are published here.',
    error: 'Verification is unavailable right now. Please try again shortly.',
  },
};

const shortDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export default function WarrantyVerify() {
  const { receiptNo } = useParams<{ receiptNo: string }>();
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const t = lang === 'en' ? STR.en : STR.ar;

  const [query, setQuery] = useState(receiptNo ?? '');
  const [result, setResult] = useState<PublicWarranty | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = useCallback(async (key: string) => {
    const value = key.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setResult(null);
    try {
      const res = await api.get<{ found: boolean; warranty?: PublicWarranty }>(
        `/api/warranty/verify/${encodeURIComponent(value)}`
      );
      if (res.found && res.warranty) setResult(res.warranty);
      else setNotFound(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.error);
    } finally {
      setLoading(false);
    }
  }, [t.error]);

  // The URL is the source of truth for what is being checked. Keeping the box
  // in step with it means back and forward show the number that produced the
  // answer on screen, instead of whatever was last typed.
  useEffect(() => {
    if (!receiptNo) return;
    setQuery(decodeURIComponent(receiptNo));
    void verify(receiptNo);
  }, [receiptNo, verify]);

  const tone =
    result?.status === 'active'
      ? { Icon: ShieldCheck, cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300', text: t.covered }
      : result?.status === 'expired'
        ? { Icon: ShieldAlert, cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300', text: t.expired }
        : result?.status === 'replaced'
          ? { Icon: ShieldAlert, cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300', text: t.replaced }
          : { Icon: ShieldX, cls: 'border-red-500/40 bg-red-500/10 text-red-300', text: t.voided };

  return (
    <div className="min-h-[70vh] px-4 py-8 flex justify-center" dir={dir} data-page="warranty-verify">
      <div className="w-full max-w-xl">
        <h1 className="text-2xl font-black text-white mb-1 flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-olive-light" aria-hidden />
          {t.title}
        </h1>
        <p className="text-zinc-400 text-sm mb-5">{t.lead}</p>

        <form
          className="flex gap-2 mb-5"
          onSubmit={(e) => {
            e.preventDefault();
            const value = query.trim();
            if (!value) return;
            // The URL is the shareable artefact, so a typed check moves there
            // and the effect above does the lookup. Verifying here as well
            // sent every check twice, against a 30-per-minute limit.
            if (decodeURIComponent(receiptNo ?? '') === value) void verify(value);
            else navigate(`/warranty/${encodeURIComponent(value)}`);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.placeholder}
            aria-label={t.placeholder}
            dir="ltr"
            data-warranty-input
            className="flex-1 min-w-0 min-h-12 rounded-xl bg-zinc-900 border border-zinc-700 px-3 text-white font-mono text-[15px] focus:border-olive focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            data-warranty-verify
            className="inline-flex items-center gap-2 min-h-12 px-5 rounded-xl bg-olive hover:bg-olive-light text-snow font-bold disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Search className="w-4 h-4" aria-hidden />}
            {loading ? t.checking : t.check}
          </button>
        </form>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-300 text-sm" role="alert">
            {error}
          </div>
        )}

        {notFound && (
          <div className="rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5" data-warranty-notfound>
            <p className="text-white font-bold flex items-center gap-2">
              <ShieldX className="w-5 h-5 text-zinc-400" aria-hidden />
              {t.notFound}
            </p>
            <p className="text-zinc-400 text-sm mt-1">{t.notFoundHint}</p>
          </div>
        )}

        {result && (
          <div className="space-y-4" data-warranty-result={result.status}>
            <div className={`rounded-2xl border p-4 flex items-center gap-3 ${tone.cls}`}>
              <tone.Icon className="w-7 h-7 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="font-black text-lg leading-tight">{tone.text}</p>
                {result.status === 'active' && result.days_remaining !== null && (
                  <p className="text-sm opacity-90">{t.daysLeft(result.days_remaining)}</p>
                )}
              </div>
            </div>

            <dl className="rounded-2xl border border-zinc-800 bg-zinc-900/60 divide-y divide-zinc-800">
              {([
                [t.receiptNo, result.receipt_no, true],
                [t.product, result.product, false],
                [t.model, result.model, true],
                [t.serial, result.serial_masked, true],
                [t.type, result.warranty_type, false],
                [t.period, t.months(result.warranty_months), false],
                [t.purchase, shortDate(result.purchase_date), true],
                [t.start, shortDate(result.warranty_start_at), true],
                [t.end, shortDate(result.warranty_end_at), true],
              ] as const)
                .filter(([, value]) => value && value !== '—')
                .map(([label, value, ltr]) => (
                  <div key={label} className="flex gap-3 px-4 py-2.5">
                    <dt className="w-32 shrink-0 text-[13px] font-bold text-zinc-400">{label}</dt>
                    <dd className="min-w-0 break-words text-[14px] text-white" dir={ltr ? 'ltr' : undefined}>
                      {value}
                    </dd>
                  </div>
                ))}
            </dl>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
              <p className="text-[13px] font-bold text-zinc-400 mb-1">{t.retailer}</p>
              <p className="text-white font-black tracking-wide">{result.retailer.name}</p>
              <p className="text-zinc-400 text-sm" dir="ltr">
                {result.retailer.website} · {result.retailer.instagram} · {result.retailer.phone}
              </p>
            </div>

            <p className="text-[12px] text-zinc-500">{t.privacy}</p>
          </div>
        )}
      </div>
    </div>
  );
}
