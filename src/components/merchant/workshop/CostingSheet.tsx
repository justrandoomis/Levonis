/**
 * COST THIS REQUEST ON MY PRINTER — private (stream W5-B, costing v2).
 *
 * The server reads the customer's model where it is stored, measures it and
 * prices it on the chosen machine with this workshop's own economics and
 * spools (`POST /api/merchant/workshop/requests/:id/cost`). Nothing is
 * downloaded, nothing is copied, and the figures below are this workshop's
 * alone: the customer sees a price only if «استخدم هذا كعرضي» puts it in an
 * offer and the workshop sends it.
 */
import { useEffect, useId, useState } from 'react';
import { Calculator, Send } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError, api } from '../../../lib/api';
import { formatFigure } from '../../../lib/localeNumber';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Field, Select } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Segmented } from '../../ui/Segmented';
import { Money } from '../../ui/Money';
import { merchantRefusal } from '../shell/refusal';
import { workshopApi, type Costing, type CostInput, type OfferPrefill, type QuoteMaterial } from './api';

interface PrinterOption {
  id: string;
  name: string;
  technology: 'fdm' | 'resin';
  active: boolean;
}

const COMPONENT_WORDS: Record<string, [string, string]> = {
  MODEL_MATERIAL: ['خامة القطعة', 'Part material'],
  SUPPORT_MATERIAL: ['الدعامات', 'Supports'],
  SUPPORT_INTERFACE: ['واجهة الدعامات', 'Support interface'],
  PURGE: ['التنظيف بين الألوان', 'Purge'],
  PRIME_TOWER: ['برج التهيئة', 'Prime tower'],
  BRIM_RAFT: ['الحافة والقاعدة', 'Brim and raft'],
  OTHER_WASTE: ['هدر آخر', 'Other waste'],
  ELECTRICITY: ['الكهرباء', 'Electricity'],
  DEPRECIATION: ['استهلاك الطابعة', 'Machine wear'],
  MAINTENANCE: ['الصيانة', 'Maintenance'],
  LABOR: ['العمل', 'Labour'],
  POST_PROCESSING: ['التشطيب', 'Finishing'],
  PACKAGING: ['التغليف', 'Packaging'],
  OVERHEAD: ['مصاريف عامة', 'Overhead'],
  PLATFORM_FEES: ['عمولة المنصة', 'Platform fee'],
  HARDWARE: ['القطع', 'Hardware'],
  FAILURE_RESERVE: ['احتياطي الفشل', 'Failure reserve'],
};

export default function CostingSheet({
  open,
  requestId,
  onClose,
  onCosted,
  onUseAsOffer,
}: {
  open: boolean;
  requestId: string;
  onClose: () => void;
  /** A new costing was saved (refresh the list beside it). */
  onCosted?: (c: Costing) => void;
  /** «استخدم هذا كعرضي» — hand the price to the offer composer. Never sends anything. */
  onUseAsOffer?: (p: OfferPrefill) => void;
}) {
  const { loc, lang } = useLanguage();
  const L = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const titleId = useId();
  const [printers, setPrinters] = useState<PrinterOption[] | null>(null);
  const [printerId, setPrinterId] = useState('');
  const [quality, setQuality] = useState<'draft' | 'standard' | 'fine'>('standard');
  const [strength, setStrength] = useState<'light' | 'standard' | 'strong'>('standard');
  const [margin, setMargin] = useState<number | null>(35);
  const [materials, setMaterials] = useState<QuoteMaterial[] | null>(null);
  const [materialId, setMaterialId] = useState('');
  const [result, setResult] = useState<Costing | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setResult(null);
    api
      .get<{ printers: PrinterOption[] }>('/api/merchant/printers')
      .then((d) => {
        const usable = d.printers.filter((p) => p.active);
        setPrinters(usable);
        setPrinterId((cur) => cur || usable.find((p) => p.technology === 'fdm')?.id || usable[0]?.id || '');
      })
      .catch(() => setPrinters([]));
  }, [open]);

  const chosen = printers?.find((p) => p.id === printerId) ?? null;

  async function run() {
    setError('');
    const input: CostInput = {
      merchant_printer_id: printerId || undefined,
      quality_id: quality,
      strength_id: strength,
      target_margin_percent: margin && margin > 0 && margin < 95 ? margin : undefined,
      material_id: materialId || undefined,
    };
    try {
      const c = await workshopApi.cost(requestId, input);
      setResult(c);
      onCosted?.(c);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'COSTING_MATERIAL_REQUIRED') {
        const list = (e.details?.materials as QuoteMaterial[] | undefined) ?? [];
        setMaterials(list);
        setError(loc('اختر الخامة التي ستطبع بها ثم احسب.', 'Pick the material you will print it in, then cost it.'));
        return;
      }
      setError(merchantRefusal(e, L, loc('تعذّر حساب التكلفة', 'Could not cost it')));
    }
  }

  const q = result?.quote;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="w-full sm:max-w-lg"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">{loc('تكلفة هذا الطلب على طابعتك', 'What this request costs you')}</h2>
          <p className="mt-0.5 text-[12px] text-text-muted">
            {/* OWNER: Sorani to be written by hand. */}
            {loc('يُقاس ملف العميل على الخادم ولا يُنزَّل. الأرقام لك وحدك حتى ترسل عرضًا.', 'The customer’s file is measured on the server, never downloaded. These figures are yours alone until you send an offer.')}
          </p>
        </div>
      }
      footer={
        <div className="flex flex-col-reverse gap-2 px-5 py-3 sm:flex-row">
          <Button
            variant={result ? 'secondary' : 'primary'}
            block
            onClick={run}
            loadingLabel={loc('جارٍ الحساب…', 'Costing…')}
            icon={<Calculator aria-hidden="true" className="h-4 w-4" />}
            disabled={!printers?.length}
            data-costing-run
          >
            {result ? loc('احسب مجددًا', 'Cost again') : loc('احسب التكلفة', 'Cost it')}
          </Button>
          {result && onUseAsOffer && (
            <Button
              variant="primary"
              block
              icon={<Send aria-hidden="true" className="h-4 w-4" />}
              onClick={() => onUseAsOffer({ price_iqd: result.quote.price_iqd, quote_id: result.quote_id })}
              data-costing-use
            >
              {loc('استخدم هذا كعرضي', 'Use as my offer')}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-4 pt-1" data-costing-sheet>
        {printers !== null && !printers.length ? (
          <p className="text-[13px] text-text-muted">{loc('أضف طابعة في «طابعاتي» لتحسب التكلفة عليها.', 'Add a printer in “My printers” to cost on it.')}</p>
        ) : (
          <Field label={loc('الطابعة', 'Printer')}>
            <Select value={printerId} onChange={(e) => setPrinterId(e.target.value)} data-costing-printer>
              {(printers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.technology === 'resin' ? loc('ريزن', 'Resin') : 'FDM'}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {chosen?.technology === 'resin' && (
          <p className="rounded-xl bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
            {loc('حساب تكلفة الريزن من الملف غير متاح بعد — اختر طابعة FDM.', 'Costing resin from the file is not available yet — pick an FDM printer.')}
          </p>
        )}
        {materials && materials.length > 0 && (
          <Field label={loc('الخامة', 'Material')} required>
            <Select value={materialId} onChange={(e) => setMaterialId(e.target.value)} data-costing-material>
              <option value="">{loc('اختر خامة', 'Choose a material')}</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>{lang === 'en' ? m.name_en : m.name_ar || m.name_en}</option>
              ))}
            </Select>
          </Field>
        )}
        <div>
          <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('الدقة', 'Quality')}</p>
          <Segmented
            group="costing-quality"
            size="sm"
            label={loc('الدقة', 'Quality')}
            value={quality}
            onChange={(id) => setQuality(id as typeof quality)}
            items={[
              { id: 'draft', label: loc('سريعة', 'Draft') },
              { id: 'standard', label: loc('قياسية', 'Standard') },
              { id: 'fine', label: loc('دقيقة', 'Fine') },
            ]}
          />
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('المتانة', 'Strength')}</p>
          <Segmented
            group="costing-strength"
            size="sm"
            label={loc('المتانة', 'Strength')}
            value={strength}
            onChange={(id) => setStrength(id as typeof strength)}
            items={[
              { id: 'light', label: loc('خفيفة', 'Light') },
              { id: 'standard', label: loc('قياسية', 'Standard') },
              { id: 'strong', label: loc('متينة', 'Strong') },
            ]}
          />
        </div>
        <Field label={loc('هامش الربح', 'Profit margin')} hint={loc('حصة من السعر، لا زيادة على التكلفة.', 'A share of the price, not a markup on cost.')}>
          <NumberInput value={margin} min={0} max={90} unit="%" onValueChange={(v) => setMargin(v)} />
        </Field>

        {error && <p className="lv-field-error" role="alert" data-costing-error>{error}</p>}

        {q && (
          <div className="lv-surface space-y-3 p-4" data-costing-result aria-live="polite">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[12px] text-text-muted">{loc('السعر المقترح', 'Suggested price')}</p>
                <p className="text-[22px] font-bold text-text-primary"><Money iqd={q.price_iqd} /></p>
              </div>
              <p className="text-end text-[12px] text-text-muted">
                {result!.printer.name}
                <br />
                <span className="tabular-nums" dir="ltr">
                  {formatFigure(q.machine_hours, lang, 1)} {loc('ساعة', 'h')}
                </span>
              </p>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-[12px]">
              <div>
                <dt className="text-text-muted">{loc('التكلفة', 'Cost')}</dt>
                <dd className="font-semibold text-text-primary"><Money iqd={q.true_cost_iqd} /></dd>
              </div>
              <div>
                <dt className="text-text-muted">{loc('الربح', 'Profit')}</dt>
                <dd className="font-semibold text-success"><Money iqd={q.profit_iqd} /></dd>
              </div>
              <div>
                <dt className="text-text-muted">{loc('الهامش', 'Margin')}</dt>
                <dd className="font-semibold tabular-nums text-text-primary" dir="ltr">{formatFigure(q.margin_percent, lang, 1)}%</dd>
              </div>
            </dl>
            {q.lines.length > 0 && (
              <details className="group">
                <summary className="flex min-h-11 cursor-pointer items-center text-[12.5px] font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  {loc('من أين جاء الرقم', 'Where the number comes from')}
                </summary>
                <ul className="mt-1 space-y-1 text-[12px]">
                  {q.lines.filter((l) => l.iqd > 0).map((l) => (
                    <li key={l.component} className="flex justify-between gap-3">
                      <span className="text-text-secondary">{COMPONENT_WORDS[l.component] ? loc(...COMPONENT_WORDS[l.component]) : l.component}</span>
                      <span className="text-text-primary"><Money iqd={l.iqd} /></span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-[11.5px] text-text-muted">
              {loc('تقدير من قياس الملف، لا تقطيع فعلي — راجعه قبل أن تعرضه.', 'An estimate from measuring the file, not a real slice — check it before you offer it.')}
            </p>
          </div>
        )}
      </div>
    </Sheet>
  );
}
