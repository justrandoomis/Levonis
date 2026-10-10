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
import { ShieldCheck, ShieldX, ShieldAlert, Search } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/ui/Button';
import { monthsWords } from '../../packages/pricing/src/warrantyTime';

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
  /** Warranty policy v4: a used-listing resale's own period, apart from the original window (absent from an older server). */
  used_sale?: { months: number; end_at: string } | null;
  /** Which cover `status` and `days_remaining` are about (absent from an older server). */
  covered_via?: 'original' | 'used_sale';
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
    months: (n: number) => (n === 12 ? 'سنة واحدة' : n === 24 ? 'سنتان' : monthsWords(n, 'ar')),
    retailer: 'البائع المعتمد',
    privacy: 'هذه الصفحة تعرض حالة الضمان فقط. بيانات الزبون لا تُنشر هنا.',
    error: 'تعذّر التحقق الآن. حاول مرة أخرى بعد قليل.',
    usedSale: 'مدة بيع المستعمل',
    usedSaleValue: (n: number, d: string) => `${monthsWords(n, 'ar')} — حتى ${d}`,
    viaUsedSale: 'ساري بمدة بيع المستعمل بعد انتهاء الضمان الأصلي',
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
    months: (n: number) => (n === 12 ? '1 year' : n === 24 ? '2 years' : monthsWords(n, 'en')),
    retailer: 'Authorized retailer',
    privacy: 'This page shows warranty status only. No customer details are published here.',
    error: 'Verification is unavailable right now. Please try again shortly.',
    usedSale: 'Used-sale period',
    usedSaleValue: (n: number, d: string) => `${monthsWords(n, 'en')} — until ${d}`,
    viaUsedSale: 'Active through the used-sale period after the original warranty ended',
  },
  ckb: {
    title: 'پشتڕاستکردنەوەی گەرەنتی',
    lead: 'ژمارەی پسووڵەی گەرەنتی یان ژمارە زنجیرەیی ئامێرەکە بنووسە.',
    placeholder: 'WR-2026-0902-001 یان ژمارە زنجیرەیی',
    check: 'پشتڕاستکردنەوە',
    checking: 'پشتڕاست دەکرێتەوە…',
    covered: 'گەرەنتی کارایە',
    expired: 'ماوەی گەرەنتی تەواو بووە',
    voided: 'ئەم پسووڵەیە هەڵوەشێنراوەتەوە',
    replaced: 'ئامێرەکە گۆڕدرا — گەرەنتییەکە گوازرایەوە بۆ پسووڵە نوێیەکە',
    notFound: 'هیچ پسووڵەیەکی گەرەنتی بەم ژمارەیە نییە.',
    notFoundHint: 'ژمارەکە لەگەڵ پسووڵە چاپکراوەکە بەراورد بکە، یان پەیوەندی بە پشتگیری بکە.',
    receiptNo: 'ژمارەی پسووڵە',
    product: 'بەرهەم',
    model: 'مۆدێل',
    serial: 'ژمارەی زنجیرەیی',
    type: 'جۆری گەرەنتی',
    period: 'ماوە',
    start: 'دەستپێکی گەرەنتی',
    end: 'کۆتایی گەرەنتی',
    purchase: 'ڕێکەوتی کڕین',
    daysLeft: (n: number) => `${n} ڕۆژ ماوە`,
    months: (n: number) => (n === 12 ? 'یەک ساڵ' : n === 24 ? 'دوو ساڵ' : monthsWords(n, 'ckb')),
    retailer: 'فرۆشیاری فەرمی',
    privacy: 'ئەم پەڕەیە تەنها دۆخی گەرەنتی پیشان دەدات. زانیاریی کڕیار لێرە بڵاو ناکرێتەوە.',
    error: 'ئێستا پشتڕاستکردنەوە بەردەست نییە. تکایە دوای کەمێک دووبارە هەوڵ بدەرەوە.',
    usedSale: 'ماوەی فرۆشتنی بەکارهاتوو',
    usedSaleValue: (n: number, d: string) => `${monthsWords(n, 'ckb')} — تا ${d}`,
    viaUsedSale: 'دوای تەواوبوونی گەرەنتیی ڕەسەن، بە ماوەی فرۆشتنی بەکارهاتوو کارایە',
  },
};

const shortDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export default function WarrantyVerify() {
  const { receiptNo } = useParams<{ receiptNo: string }>();
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  // Sorani readers get Sorani (the page used to fall back to Arabic for them).
  const t = lang === 'en' ? STR.en : lang === 'ckb' ? STR.ckb : STR.ar;

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
        <h1 className="text-2xl font-black text-text-primary mb-1 flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-olive-light" aria-hidden />
          {t.title}
        </h1>
        <p className="text-text-secondary text-sm mb-5">{t.lead}</p>

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
            className="lv-input flex-1 min-w-0 min-h-12 px-3 font-mono text-[15px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.placeholder}
            aria-label={t.placeholder}
            dir="ltr"
            data-warranty-input
          />
          <Button
            type="submit"
            variant="primary"
            loading={loading}
            loadingLabel={t.checking}
            icon={<Search className="w-4 h-4" aria-hidden />}
            data-warranty-verify
            className="min-h-12 px-5"
          >
            {t.check}
          </Button>
        </form>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-300 text-sm" role="alert">
            {error}
          </div>
        )}

        {notFound && (
          <div className="lv-surface p-5" data-warranty-notfound>
            <p className="text-text-primary font-bold flex items-center gap-2">
              <ShieldX className="w-5 h-5 text-text-secondary" aria-hidden />
              {t.notFound}
            </p>
            <p className="text-text-secondary text-sm mt-1">{t.notFoundHint}</p>
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
                {result.status === 'active' && result.covered_via === 'used_sale' && (
                  <p className="text-[12.5px] opacity-80" data-warranty-via="used_sale">{t.viaUsedSale}</p>
                )}
              </div>
            </div>

            <dl className="lv-surface overflow-hidden divide-y divide-border-subtle">
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
                // Policy v4: the used-sale period on its own line, never merged into the window above.
                [t.usedSale, result.used_sale ? t.usedSaleValue(result.used_sale.months, shortDate(result.used_sale.end_at)) : '', false],
              ] as const)
                .filter(([, value]) => value && value !== '—')
                .map(([label, value, ltr]) => (
                  <div key={label} className="flex gap-3 px-4 py-2.5">
                    <dt className="w-32 shrink-0 text-[13px] font-bold text-text-secondary">{label}</dt>
                    <dd className="min-w-0 break-words text-[14px] text-text-primary" dir={ltr ? 'ltr' : undefined}>
                      {value}
                    </dd>
                  </div>
                ))}
            </dl>

            <div className="lv-surface p-4">
              <p className="text-[13px] font-bold text-text-secondary mb-1">{t.retailer}</p>
              <p className="text-text-primary font-black tracking-wide">{result.retailer.name}</p>
              <p className="text-text-secondary text-sm" dir="ltr">
                {result.retailer.website} · {result.retailer.instagram} · {result.retailer.phone}
              </p>
            </div>

            <p className="text-[12px] text-text-muted">{t.privacy}</p>
          </div>
        )}
      </div>
    </div>
  );
}
