import React, { useState } from 'react';
import { Calculator } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { formatIqd } from '../lib/api';

export default function Tools() {
  const { loc } = useLanguage();

  const [weightGrams, setWeightGrams] = useState(120);
  const [spoolCostIqd, setSpoolCostIqd] = useState(25000);
  const [printHours, setPrintHours] = useState(4.5);
  const [printerWatts, setPrinterWatts] = useState(150);
  const [failureRate, setFailureRate] = useState(10);
  const [markupPercent, setMarkupPercent] = useState(30);

  // Material cost: (spoolCost / 1000g) * weight
  const materialCost = (spoolCostIqd / 1000) * weightGrams;

  // Electricity cost: approx 150 IQD per kWh in Iraq commercial rate
  const kwh = (printerWatts * printHours) / 1000;
  const electricityCost = kwh * 250;

  // Machine depreciation: ~500 IQD per operating hour
  const machineDepreciation = printHours * 500;

  const baseCost = materialCost + electricityCost + machineDepreciation;
  const withFailure = baseCost * (1 + failureRate / 100);
  const finalPrice = withFailure * (1 + markupPercent / 100);

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-2xl bg-olive/20 border border-olive/40 text-olive">
            <Calculator className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {loc('حاسبة تكلفة الطباعة ثلاثية الأبعاد', '3D Print Cost Calculator', 'حاسیبەی تێچووی چاپی سێ ڕەهەندی')}
            </h1>
            <p className="text-xs text-zinc-400 mt-1">
              {loc('احسب التكلفة التشغيلية وسعر البيع المقترح بدقة بناءً على أسعار السوق العراقي', 'Calculate precise operational costs and target retail pricing', 'تێچووی کارکردن و نرخی پێشنیارکراو بپێوە')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <div className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800 space-y-4">
            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                {loc('وزن الموديل (غرام)', 'Model Weight (grams)', 'کێشی مۆدێل (گرام)')}
              </label>
              <input
                type="number"
                value={weightGrams}
                onChange={(e) => setWeightGrams(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono text-sm focus:border-olive focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                {loc('سعر بكرة الفلمنت 1 كغم (د.ع)', 'Spool Price 1kg (IQD)', 'نرخی بەکرە 1 کگم')}
              </label>
              <input
                type="number"
                step={500}
                value={spoolCostIqd}
                onChange={(e) => setSpoolCostIqd(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono text-sm focus:border-olive focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                {loc('مدة الطباعة (ساعات)', 'Print Duration (hours)', 'ماوەی چاپ (کاتژمێر)')}
              </label>
              <input
                type="number"
                step={0.5}
                value={printHours}
                onChange={(e) => setPrintHours(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono text-sm focus:border-olive focus:outline-none"
              />
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800 space-y-4">
            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                {loc('استهلاك الطاقة (واط)', 'Printer Power (Watts)', 'بەکارهێنانی وزە (وات)')}
              </label>
              <input
                type="number"
                value={printerWatts}
                onChange={(e) => setPrinterWatts(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono text-sm focus:border-olive focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                {loc('نسبة احتمالية الفشل (%)', 'Failure Margin (%)', 'ڕێژەی ئەگەری تێکچوون (%)')}
              </label>
              <input
                type="number"
                value={failureRate}
                onChange={(e) => setFailureRate(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono text-sm focus:border-olive focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                {loc('هامش الربح المطلوب (%)', 'Desired Profit Margin (%)', 'ڕێژەی قازانج (%)')}
              </label>
              <input
                type="number"
                value={markupPercent}
                onChange={(e) => setMarkupPercent(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono text-sm focus:border-olive focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Results Card */}
        <div className="p-6 rounded-3xl bg-gradient-to-br from-zinc-900 via-zinc-900/80 to-zinc-950 border border-zinc-800 shadow-xl">
          <h2 className="font-bold text-base text-zinc-300 mb-4">{loc('تفصيل التكاليف', 'Cost Breakdown', 'وردەکاری تێچوو')}</h2>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80">
              <span className="text-[11px] text-zinc-400 block">{loc('المادة الخام', 'Material', 'کەرەستە')}</span>
              <span className="font-bold text-sm text-white font-mono">{formatIqd(Math.round(materialCost))}</span>
            </div>
            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80">
              <span className="text-[11px] text-zinc-400 block">{loc('الكهرباء', 'Power', 'کارەبا')}</span>
              <span className="font-bold text-sm text-white font-mono">{formatIqd(Math.round(electricityCost))}</span>
            </div>
            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80">
              <span className="text-[11px] text-zinc-400 block">{loc('إهلاك الماكينة', 'Depreciation', 'بەکاربردن')}</span>
              <span className="font-bold text-sm text-white font-mono">{formatIqd(Math.round(machineDepreciation))}</span>
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-4 flex items-center justify-between">
            <div>
              <span className="text-xs text-zinc-400 block">{loc('سعر البيع المقترح مع الربح', 'Suggested Retail Price', 'نرخی پێشنیارکراو بۆ فرۆشتن')}</span>
              <span className="text-2xl font-black text-olive font-mono">{formatIqd(Math.round(finalPrice))}</span>
            </div>
            <div className="text-right text-xs text-zinc-500">
              <span>{loc('صافي التكلفة: ', 'Net Cost: ', 'تێچووی گشتی: ')}</span>
              <span className="font-mono text-zinc-300">{formatIqd(Math.round(withFailure))}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
