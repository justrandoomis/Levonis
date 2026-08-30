/**
 * The print-price calculator — "احسب سعر طباعتك".
 *
 * IT USED TO BE A PAGE THAT SAID "قريباً". What made a calculator hard to
 * ship honestly is not the arithmetic, it is the numbers: a tool seeded with
 * invented material prices is worse than no tool, because a customer plans
 * around a figure they then do not meet at checkout.
 *
 * So every material price here is DERIVED FROM A REAL PRODUCT: the shop's own
 * filament, its own price, divided by the net weight on its own spec sheet.
 * A spool with no weight recorded is not offered rather than guessed at.
 *
 * The service side — machine time, setup, margin — is the owner's business
 * decision and starts unpublished. When it is unset the page shows the
 * material cost and says plainly that the rest is not published yet, instead
 * of presenting material-only as if it were the whole price.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, Calculator, AlertCircle, Loader2 } from 'lucide-react';
import { api, formatIqd } from '../lib/api';

interface Filament {
  id: string;
  slug: string;
  name: string;
  name_ar: string | null;
  name_ku: string | null;
  price_iqd: number;
  net_weight_g: number;
  iqd_per_gram: number;
  material_type: string;
}

interface Rates {
  machine_iqd_per_hour: number | null;
  setup_fee_iqd: number | null;
  margin_percent: number | null;
  configured: boolean;
}

const STRINGS = {
  ar: {
    title: 'احسب سعر طباعتك',
    intro: 'الأسعار محسوبة من أسعار الفيلامنت الحقيقية في المتجر.',
    filament: 'الفيلامنت',
    weight: 'وزن القطعة (غرام)',
    hours: 'زمن الطباعة (ساعات)',
    qty: 'عدد القطع',
    material: 'كلفة المادة',
    machine: 'وقت الطباعة',
    setup: 'أجور التهيئة',
    margin: 'هامش الخدمة',
    total: 'التقدير الإجمالي',
    perGram: 'لكل غرام',
    noFilaments: 'لا توجد مواد مسجّلة بوزن صافٍ بعد، لذلك لا يمكن حساب كلفة المادة.',
    ratesMissing: 'لم تُنشر أجور وقت الطباعة بعد، لذلك هذا الرقم يشمل كلفة المادة فقط.',
    estimate: 'هذا تقدير للاسترشاد وليس عرض سعر نهائيًا.',
    loadError: 'تعذّر تحميل الأسعار.',
    back: 'رجوع',
  },
  en: {
    title: 'Print price calculator',
    intro: 'Prices are worked out from the real filament prices in the shop.',
    filament: 'Filament',
    weight: 'Part weight (grams)',
    hours: 'Print time (hours)',
    qty: 'Number of parts',
    material: 'Material cost',
    machine: 'Print time',
    setup: 'Setup',
    margin: 'Service margin',
    total: 'Estimated total',
    perGram: 'per gram',
    noFilaments: 'No material has a net weight recorded yet, so material cost cannot be calculated.',
    ratesMissing: 'Print-time rates are not published yet, so this figure is material cost only.',
    estimate: 'This is a guide estimate, not a final quote.',
    loadError: 'Prices could not be loaded.',
    back: 'Back',
  },
  ckb: {
    title: 'ژمێرەری نرخی چاپ',
    intro: 'نرخەکان لە نرخی ڕاستەقینەی فیلامێنتی فرۆشگا دەردەهێنرێن.',
    filament: 'فیلامێنت',
    weight: 'کێشی پارچە (گرام)',
    hours: 'کاتی چاپ (کاتژمێر)',
    qty: 'ژمارەی پارچە',
    material: 'تێچووی ماددە',
    machine: 'کاتی چاپ',
    setup: 'ئامادەکاری',
    margin: 'مارجینی خزمەتگوزاری',
    total: 'کۆی خەمڵێنراو',
    perGram: 'بۆ هەر گرامێک',
    noFilaments: 'هیچ ماددەیەک کێشی ڕوونی تۆمار نەکراوە، بۆیە تێچووی ماددە ناژمێردرێت.',
    ratesMissing: 'نرخی کاتی چاپ هێشتا بڵاو نەکراوەتەوە، بۆیە ئەمە تەنها تێچووی ماددەیە.',
    estimate: 'ئەمە خەمڵاندنێکی ڕێنماییە، نەک نرخی کۆتایی.',
    loadError: 'نرخەکان بار نەکران.',
    back: 'گەڕانەوە',
  },
} as const;

const inputClass =
  'w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-3 text-white text-sm focus:outline-none focus:border-[#BAA369] transition-colors';

export default function Tools() {
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const s = STRINGS[(lang as keyof typeof STRINGS) in STRINGS ? (lang as keyof typeof STRINGS) : 'ar'];

  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [rates, setRates] = useState<Rates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filamentId, setFilamentId] = useState('');
  const [grams, setGrams] = useState('50');
  const [hours, setHours] = useState('4');
  const [qty, setQty] = useState('1');

  useEffect(() => {
    let alive = true;
    api
      .get<{ filaments: Filament[]; rates: Rates }>('/api/products/print-calculator')
      .then((d) => {
        if (!alive) return;
        setFilaments(d.filaments ?? []);
        setRates(d.rates ?? null);
        if (d.filaments?.length) setFilamentId(d.filaments[0].id);
      })
      .catch(() => alive && setError(s.loadError))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [s.loadError]);

  const chosen = filaments.find((f) => f.id === filamentId) ?? null;

  const money = useMemo(() => {
    const g = Math.max(0, Number(grams) || 0);
    const h = Math.max(0, Number(hours) || 0);
    const n = Math.max(1, Math.floor(Number(qty) || 1));
    const material = chosen ? Math.round(chosen.iqd_per_gram * g) * n : 0;
    // Every service component is null-checked separately: an owner may
    // publish an hourly rate and no setup fee, and the tool must add exactly
    // what was published rather than treating a missing value as zero and
    // presenting the sum as complete.
    const machine = rates?.machine_iqd_per_hour != null ? Math.round(rates.machine_iqd_per_hour * h) * n : null;
    const setup = rates?.setup_fee_iqd != null ? rates.setup_fee_iqd : null;
    const base = material + (machine ?? 0) + (setup ?? 0);
    const margin = rates?.margin_percent != null ? Math.round((base * rates.margin_percent) / 100) : null;
    return { material, machine, setup, margin, total: base + (margin ?? 0), parts: n };
  }, [chosen, grams, hours, qty, rates]);

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div className="w-full pb-24 text-zinc-300 bg-black" dir={dir}>
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} aria-label={s.back} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          <Back className="w-5 h-5" />
        </button>
        <h1 className="text-white font-bold text-lg">{s.title}</h1>
      </div>

      <div className="p-4 max-w-2xl mx-auto space-y-4">
        <div className="flex items-start gap-2.5 text-zinc-400 text-xs">
          <Calculator className="w-4 h-4 shrink-0 mt-0.5 text-[#BAA369]" aria-hidden />
          <p className="leading-relaxed">{s.intro}</p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-zinc-400 text-sm py-10 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> …
          </div>
        ) : error ? (
          <p role="alert" className="text-[#e4899a] text-sm bg-[#B03142]/10 border border-[#B03142]/40 rounded-2xl p-4">{error}</p>
        ) : filaments.length === 0 ? (
          // No invented filament. An empty catalog says so.
          <p className="text-zinc-300 text-sm bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" aria-hidden />
            {s.noFilaments}
          </p>
        ) : (
          <>
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 space-y-4" data-print-calculator>
              <div>
                <label className="block text-zinc-400 text-[10px] font-bold mb-1.5 uppercase tracking-wider" htmlFor="calc-filament">
                  {s.filament}
                </label>
                <select id="calc-filament" value={filamentId} onChange={(e) => setFilamentId(e.target.value)} className={inputClass}>
                  {filaments.map((f) => (
                    <option key={f.id} value={f.id}>
                      {(lang === 'ar' ? f.name_ar : lang === 'ckb' ? f.name_ku : f.name) || f.name}
                      {' — '}
                      {formatIqd(f.price_iqd)} / {f.net_weight_g}g
                    </option>
                  ))}
                </select>
                {chosen && (
                  <p className="text-zinc-500 text-[11px] mt-1.5" dir="ltr">
                    {formatIqd(chosen.iqd_per_gram)} {s.perGram}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-zinc-400 text-[10px] font-bold mb-1.5 uppercase tracking-wider" htmlFor="calc-grams">{s.weight}</label>
                  <input id="calc-grams" dir="ltr" inputMode="decimal" value={grams} onChange={(e) => setGrams(e.target.value.replace(/[^0-9.]/g, ''))} className={inputClass} />
                </div>
                <div>
                  <label className="block text-zinc-400 text-[10px] font-bold mb-1.5 uppercase tracking-wider" htmlFor="calc-hours">{s.hours}</label>
                  <input id="calc-hours" dir="ltr" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9.]/g, ''))} className={inputClass} />
                </div>
                <div>
                  <label className="block text-zinc-400 text-[10px] font-bold mb-1.5 uppercase tracking-wider" htmlFor="calc-qty">{s.qty}</label>
                  <input id="calc-qty" dir="ltr" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ''))} className={inputClass} />
                </div>
              </div>
            </div>

            <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 space-y-2.5 text-sm">
              <Row label={s.material} value={formatIqd(money.material)} />
              {money.machine !== null && <Row label={s.machine} value={formatIqd(money.machine)} />}
              {money.setup !== null && <Row label={s.setup} value={formatIqd(money.setup)} />}
              {money.margin !== null && <Row label={s.margin} value={formatIqd(money.margin)} />}
              <div className="flex justify-between items-center pt-2.5 border-t border-zinc-800">
                <span className="text-white font-bold">{s.total}</span>
                <span dir="ltr" data-calc-total className="text-[#BAA369] font-black text-lg">{formatIqd(money.total)}</span>
              </div>
            </div>

            {/* An unpublished rate is stated, never silently treated as zero. */}
            {!rates?.configured && (
              <p className="text-amber-300/90 text-[11px] leading-relaxed bg-amber-500/10 border border-amber-500/25 rounded-2xl p-3 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                {s.ratesMissing}
              </p>
            )}
            <p className="text-zinc-500 text-[11px] text-center">{s.estimate}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-zinc-400">
      <span>{label}</span>
      <span dir="ltr" className="text-white font-medium">{value}</span>
    </div>
  );
}
