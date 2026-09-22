/**
 * Local fixture for the checkout summary's «علامة تعجب».
 *
 * The PRODUCTION <SummaryInfo> is mounted — this file supplies only the rows
 * around it, so what the browser measures is the shipped component and not a
 * copy of it. The rows above and below are deliberately ordinary money rows:
 * the property under test is that the answer pushes the NEXT FIGURE DOWN
 * instead of covering it, and that cannot be measured without a next figure.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/LanguageContext';
import SummaryInfo from '../../src/components/ui/SummaryInfo';
import '../../src/index.css';

function Row({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div data-row={id} className="flex justify-between items-center text-zinc-400">
      <span className="font-light">{label}</span>
      <span className="text-white font-normal tabular-nums">{value}</span>
    </div>
  );
}

function Fixture() {
  return (
    <div style={{ background: '#000', minHeight: '100vh' }}>
      <div className="mx-auto max-w-md px-4 py-6">
        <div className="space-y-4 text-sm">
          <Row id="subtotal" label="المجموع الفرعي" value="٥٤٠٬٠٠٠ د.ع" />

          <SummaryInfo
            testId="delivery"
            label="تكلفة التوصيل إلى البيت"
            question="كيف حُسبت تكلفة التوصيل؟"
            value={<span className="text-white font-normal tabular-nums">١٢٬٠٠٠ د.ع</span>}
          >
            <p>التوصيل يُحسب حسب كل منتج وعدد قطعه، لا مبلغاً واحداً للطلب.</p>
            <div className="space-y-1.5 border-t border-white/5 pt-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-zinc-500">توصيل حسب المنتج × 2</span>
                <span className="tabular-nums text-zinc-300">٨٬٠٠٠ د.ع</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-zinc-500">كرتونة كمية إضافية</span>
                <span className="tabular-nums text-zinc-300">٤٬٠٠٠ د.ع</span>
              </div>
            </div>
          </SummaryInfo>

          <SummaryInfo
            testId="cod-tax"
            label="ضريبة شركة التوصيل"
            question="لماذا توجد ضريبة على التوصيل؟"
            value={<span className="text-white font-normal tabular-nums">٦٬٠٠٠ د.ع</span>}
          >
            <p>شركة التوصيل تأخذ ضريبة على الطلبات ذات المبلغ العالي المدفوع عند الاستلام.</p>
            <p className="tabular-nums">وقدرها ٦٬٠٠٠ د.ع عن كل ٥٠٠٬٠٠٠ د.ع من المبلغ المدفوع عند الاستلام.</p>
          </SummaryInfo>

          {/* A long label with no room for it: the row must stay one line and
              the «!» must stay reachable, which is why the label truncates and
              the button does not shrink. */}
          <SummaryInfo
            testId="cod-commission"
            tone="quiet"
            label="عمولة الدفع عند الاستلام للطلب المسبق بالشحن البحري"
            question="ما هي عمولة الدفع عند الاستلام؟"
            value={<span className="tabular-nums">+٤٥٬٠٠٠ د.ع</span>}
          >
            <p>المبلغ محسوب أصلاً داخل أسعار المنتجات في المجموع الفرعي أعلاه.</p>
          </SummaryInfo>

          <Row id="after" label="إجمالي الطلب" value="٥٥٨٬٠٠٠ د.ع" />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <Fixture />
    </LanguageProvider>
  </React.StrictMode>
);
