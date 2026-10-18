/**
 * «ضريبة شركة التوصيل» — THE DELIVERY COMPANY'S TAX, the owner's to set
 * (2026-10-18: «اجعل بالامكان التعديل على رسوم ضريبه شركه التوصيل مثلا تكون
 * 5 الف لكل 500 الف»). It charges a fixed amount for every COMPLETE block of
 * the money collected at the door, on cash-on-delivery orders sent to an
 * address only — never store pickup, wallet or advance payment.
 *
 * The write path is the one the rate always had: WalletContext
 * `setCodTaxRate`, i.e. PUT /api/admin/settings/codTaxBlockIqd then
 * …/codTaxPerBlockIqd. The server holds both to the owner and to the limits in
 * packages/shipping/src/codTax.ts (`acceptedCodTaxField`), and audits each
 * value; this form checks the same limits first so the owner reads the reason
 * in their own language. A charge of 0 is allowed and switches the tax off.
 *
 * NOT RETROACTIVE: every order stores the figure it was charged in
 * `orders.cod_tax_iqd` at placement, so a change here touches new orders only.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Check, Save, Truck } from 'lucide-react';
import { useWallet } from '../../WalletContext';
import { useLanguage } from '../../LanguageContext';
import { useOptionalAuth } from '../../AuthContext';
import { ApiError, formatIqd } from '../../lib/api';
import { acceptedCodTaxField, calculateCodTaxIqd } from '../../../packages/shipping/src/codTax';

/** The worked example under the fields: an order collecting this much at the door. */
export const COURIER_TAX_EXAMPLE_IQD = 1_200_000;

type State = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** Both halves as they will be stored, or which one is refused (per < 0 or not whole; block < 1,000). */
export function readCourierTax(perInput: string, blockInput: string):
  { ok: true; perBlockIqd: number; blockIqd: number } | { ok: false; field: 'perBlockIqd' | 'blockIqd' } {
  const perBlockIqd = acceptedCodTaxField('perBlockIqd', perInput);
  if (perBlockIqd === null) return { ok: false, field: 'perBlockIqd' };
  const blockIqd = acceptedCodTaxField('blockIqd', blockInput);
  if (blockIqd === null) return { ok: false, field: 'blockIqd' };
  return { ok: true, perBlockIqd, blockIqd };
}

export default function CourierTaxPanel() {
  const { codTaxPerBlockIqd, codTaxBlockIqd, setCodTaxRate, isLoaded } = useWallet();
  const { loc } = useLanguage();
  // A HINT, NEVER THE GATE: the settings route refuses anyone but the owner.
  const owner = useOptionalAuth()?.user?.is_owner === true;

  const [perInput, setPerInput] = useState('');
  const [blockInput, setBlockInput] = useState('');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);

  // Seed once settings have loaded, then follow the context only while the
  // owner has nothing unsaved here.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!isLoaded) return;
    if (hydrated.current && state !== 'idle' && state !== 'saved') return;
    hydrated.current = true;
    setPerInput(String(codTaxPerBlockIqd));
    setBlockInput(String(codTaxBlockIqd));
  }, [isLoaded, codTaxPerBlockIqd, codTaxBlockIqd]); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = readCourierTax(perInput, blockInput);
  const edit = (set: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setState('dirty');
    setError(null);
  };

  const save = async () => {
    if ('field' in typed) {
      setState('error');
      setError(typed.field === 'perBlockIqd'
        ? loc('اكتب الضريبة عددًا صحيحًا من الدنانير، صفرًا أو أكثر.', 'Enter the tax as a whole number of IQD, 0 or more.', 'باجەکە وەک ژمارەیەکی تەواوی دینار بنووسە، سفر یان زیاتر.')
        : loc('الشريحة عدد صحيح من الدنانير لا يقل عن 1,000.', 'The block must be a whole number of IQD, at least 1,000.', 'بەشەکە دەبێت ژمارەیەکی تەواوی دینار بێت، لانیکەم 1,000.'));
      return;
    }
    setState('saving');
    setError(null);
    try {
      await setCodTaxRate({ perBlockIqd: typed.perBlockIqd, blockIqd: typed.blockIqd });
      setState('saved');
    } catch (e) {
      setState('error');
      setError(e instanceof ApiError ? e.message : loc('تعذّر الحفظ', 'Save failed', 'پاشەکەوتکردن سەرکەوتوو نەبوو'));
    }
  };

  const disabled = !isLoaded || !owner;
  const blocks = typed.ok ? Math.floor(COURIER_TAX_EXAMPLE_IQD / typed.blockIqd) : 0;
  const exampleTax = typed.ok ? calculateCodTaxIqd(COURIER_TAX_EXAMPLE_IQD, typed) : 0;

  return (
    <div className="lv-surface p-6" data-courier-tax>
      <div className="flex items-center gap-3 mb-2">
        <Truck className="w-5 h-5 shrink-0 text-text-secondary" aria-hidden="true" />
        <h3 className="text-lg font-bold text-text-primary">{loc('ضريبة شركة التوصيل', 'Delivery company tax', 'باجی کۆمپانیای گەیاندن')}</h3>
      </div>
      <p className="text-sm text-text-secondary mb-5">
        {loc(
          'تُحسب على طلبات الدفع عند الاستلام المرسلة إلى عنوان فقط: مبلغ ثابت عن كل شريحة كاملة من المبلغ المدفوع عند الاستلام.',
          'Charged only on cash-on-delivery orders sent to an address: a fixed amount for every complete block collected at the door.',
          'تەنها لەسەر داواکارییەکانی پارەدان لە کاتی وەرگرتن کە بۆ ناونیشانێک دەنێردرێن وەردەگیرێت: بڕێکی جێگیر بۆ هەر بەشێکی تەواو لەو پارەیەی لە کاتی وەرگرتن دەدرێت.'
        )}
      </p>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-2">
            <span className="block text-sm font-bold text-text-secondary">{loc('الضريبة (د.ع)', 'Tax (IQD)', 'باج (دینار)')}</span>
            <input className="lv-input font-bold tabular-nums disabled:opacity-50" type="number" inputMode="numeric" min={0} step={250} dir="ltr"
              value={perInput} onChange={edit(setPerInput)} disabled={disabled} data-courier-tax-per />
          </label>
          <label className="space-y-2">
            <span className="block text-sm font-bold text-text-secondary">{loc('لكل (د.ع)', 'For every (IQD)', 'بۆ هەر (دینار)')}</span>
            <input className="lv-input font-bold tabular-nums disabled:opacity-50" type="number" inputMode="numeric" min={1000} step={1000} dir="ltr"
              value={blockInput} onChange={edit(setBlockInput)} disabled={disabled} data-courier-tax-block />
          </label>
        </div>
        {typed.ok && (
          <p className="text-[12px] text-text-muted tabular-nums" data-courier-tax-example>
            {typed.perBlockIqd === 0
              ? loc('الضريبة متوقفة (صفر).', 'The tax is switched off (0).', 'باجەکە ناچالاکە (سفر).')
              : loc(
                `مثال: طلب يُدفع منه ${formatIqd(COURIER_TAX_EXAMPLE_IQD)} عند الاستلام = ${blocks} × ${formatIqd(typed.perBlockIqd)} = ${formatIqd(exampleTax)}`,
                `Example: an order collecting ${formatIqd(COURIER_TAX_EXAMPLE_IQD)} at the door = ${blocks} × ${formatIqd(typed.perBlockIqd)} = ${formatIqd(exampleTax)}`,
                `نموونە: داواکارییەک کە ${formatIqd(COURIER_TAX_EXAMPLE_IQD)} لە کاتی وەرگرتن دەدات = ${blocks} × ${formatIqd(typed.perBlockIqd)} = ${formatIqd(exampleTax)}`
              )}
          </p>
        )}
        {owner ? (
          <button type="button" onClick={save} disabled={state === 'saving' || !isLoaded} className="lv-button lv-button-primary w-full">
            <Save className="w-4 h-4" aria-hidden="true" /> {loc('حفظ', 'Save', 'پاشەکەوتکردن')}
          </button>
        ) : (
          <p className="text-[12px] font-semibold text-text-secondary" data-courier-tax-owner-only>
            {loc('يعدّلها المالك فقط.', 'Only the owner can change this.', 'تەنها خاوەن دەتوانێت ئەمە بگۆڕێت.')}
          </p>
        )}
        <p className="text-[11px] text-text-muted">
          {loc(
            'الطلبات المؤكدة تحتفظ بالضريبة التي حُسبت لها؛ التغيير يخص الطلبات الجديدة فقط. اكتب 0 لإيقاف الضريبة.',
            'Orders already placed keep the charge they were quoted; changing this affects new orders only. Set the charge to 0 to switch it off.',
            'ئەو داواکارییانەی پێشتر تۆمارکراون باجی خۆیان دەپارێزن؛ گۆڕانکاری تەنها داواکارییە نوێیەکان دەگرێتەوە. بۆ ناچالاککردنی باجەکە 0 بنووسە.'
          )}
        </p>
        {state === 'saving' && <p className="text-xs font-semibold text-text-secondary">{loc('جارٍ الحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…')}</p>}
        {state === 'saved' && (
          <p className="text-xs font-semibold text-text-muted flex items-center gap-1">
            <Check className="w-3 h-3 text-success" aria-hidden="true" /> {loc('تم الحفظ', 'Saved', 'پاشەکەوت کرا')}
          </p>
        )}
        {state === 'error' && error && <p className="text-xs font-semibold text-danger" role="alert">{error}</p>}
      </div>
    </div>
  );
}
