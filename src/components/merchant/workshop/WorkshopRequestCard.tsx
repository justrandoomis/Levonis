/**
 * «ورشتك» — ON A REQUEST'S PAGE, FOR A MERCHANT (stream W5-B).
 *
 * The live verdict for this workshop and this request, asked of the server
 * (`GET /api/merchant/workshop/requests/:id/eligibility` — the same verdict
 * the offer route will ask): can the workshop make it, on which machine, and
 * if not, every reason with the screen that fixes it. For a workshop that can,
 * its private costings of the request and «احسب التكلفة» (CostingSheet), each
 * with «استخدم هذا كعرضي», which hands the price to the offer composer and
 * sends nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { Calculator, CheckCircle2, CircleAlert, Send } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { merchantHref } from '../../../lib/merchantRoutes';
import { formatFigure } from '../../../lib/localeNumber';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Skeleton } from '../../ui/Skeleton';
import { fixLabel, reasonFix, reasonText, type ReasonFix } from './reasons';
import { workshopApi, type CostRow, type OfferPrefill, type Verdict } from './api';
import CostingSheet from './CostingSheet';

const FIX_HREF: Record<Exclude<ReasonFix, null>, string> = {
  printers: merchantHref.printers(),
  stock: `${merchantHref.printers()}#stock`,
  preferences: `${merchantHref.printers()}#preferences`,
  delivery: merchantHref.storeDelivery(),
  store: merchantHref.storeSettings(),
  plan: '/subscription',
};

export default function WorkshopRequestCard({
  requestId,
  takingOffers,
  onUseAsOffer,
  openCosting = false,
  hrefFor = (p) => p,
}: {
  requestId: string;
  /** The request still takes offers (the only time a costing can become one). */
  takingOffers: boolean;
  onUseAsOffer: (p: OfferPrefill) => void;
  /** Open the costing sheet at once (arriving from the Costing screen). */
  openCosting?: boolean;
  /** Turns a workspace path into this host's address (a merchant's own host serves it under /admin). */
  hrefFor?: (path: string) => string;
}) {
  const { loc, lang } = useLanguage();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [failed, setFailed] = useState(false);
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [sheet, setSheet] = useState(false);

  const loadCosts = useCallback(() => {
    workshopApi.costs(requestId).then((d) => setCosts(d.costs)).catch(() => setCosts([]));
  }, [requestId]);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    workshopApi
      .verdict(requestId)
      .then((v) => {
        if (!alive) return;
        setVerdict(v);
        if (v.eligible) {
          loadCosts();
          if (openCosting) setSheet(true);
        }
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [requestId, loadCosts, openCosting]);

  if (failed) return null;
  if (!verdict) {
    return (
      <div className="lv-surface mb-4 space-y-2 p-4" aria-busy="true">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }

  const use = (p: OfferPrefill) => {
    setSheet(false);
    onUseAsOffer(p);
  };

  return (
    <section className="lv-surface mb-4 p-4" data-workshop-card={verdict.eligible ? 'eligible' : 'not-eligible'} aria-labelledby="workshop-card-title">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="workshop-card-title" className="shrink-0 text-[15px] font-bold text-text-primary">{loc('ورشتك', 'Your workshop')}</h2>
        {verdict.eligible ? (
          <StatusChip tone="success" dot={false} icon={<CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />}>
            {loc('تستطيع تنفيذه', 'Can make it')}
          </StatusChip>
        ) : (
          <StatusChip tone="warning" dot={false} icon={<CircleAlert aria-hidden="true" className="h-3.5 w-3.5" />}>
            {loc('لا تستطيع تنفيذه الآن', 'Cannot make it now')}
          </StatusChip>
        )}
      </div>

      {verdict.eligible ? (
        <>
          <p className="mt-1 text-[13px] text-text-secondary">
            {verdict.printer?.name
              ? loc(`يُطبع على «${verdict.printer.name}».`, `It would run on “${verdict.printer.name}”.`)
              : loc('طابعاتك ومخزونك وتوصيلك تناسبه.', 'Your printers, stock and delivery fit it.')}
            {verdict.notify_block === 'NOTIFICATIONS_OFF' && (
              <span className="block text-[12px] text-text-muted">
                {loc('إشعارات فرص الطلبات مغلقة عندك — تستطيع التقديم لكن لن تُبلَّغ بطلبات مثله.', 'Request-opportunity notices are off — you can still offer, you just will not be told about jobs like this.')}
              </span>
            )}
          </p>

          <div className="mt-3 border-t border-white/5 pt-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold text-text-secondary">{loc('تكلفتك الخاصة', 'Your private costing')}</p>
              <Button size="sm" variant="secondary" icon={<Calculator aria-hidden="true" className="h-4 w-4" />} onClick={() => setSheet(true)} data-workshop-cost>
                {loc('احسب التكلفة', 'Cost it')}
              </Button>
            </div>
            {costs.length > 0 ? (
              <ul className="mt-2 space-y-2" data-workshop-costs>
                {costs.slice(0, 3).map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl bg-white/[0.03] px-3 py-2.5">
                    <span className="min-w-0 flex-1 basis-48">
                      <span className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                        <span className="text-[14px] font-semibold text-text-primary"><Money iqd={c.price_iqd} /></span>
                        <span className="text-text-muted">
                          {loc('ربح', 'profit')} <Money iqd={c.profit_iqd} /> · <span className="tabular-nums" dir="ltr">{formatFigure(c.margin_percent, lang, 0)}%</span>
                        </span>
                      </span>
                      {c.printer.name && <span className="block truncate text-[12px] text-text-muted">{c.printer.name}</span>}
                      {c.stale && <span className="block text-[11.5px] text-warning">{loc('حُسبت قبل أن يعدّل العميل الطلب — أعد الحساب.', 'Costed before the customer changed the request — cost it again.')}</span>}
                      {c.state === 'offered' && <span className="block text-[11.5px] text-text-muted">{loc('أرسلته عرضًا', 'Sent as an offer')}</span>}
                    </span>
                    {takingOffers && !c.stale && c.state === 'draft' && (
                      <Button size="sm" variant="secondary" icon={<Send aria-hidden="true" className="h-4 w-4" />} onClick={() => use({ price_iqd: c.price_iqd, quote_id: c.id })} data-workshop-use={c.id}>
                        {loc('استخدم هذا كعرضي', 'Use as my offer')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[12px] text-text-muted">
                {loc('احسب تكلفة الطلب على طابعتك من ملف العميل — دون تنزيله. السعر لك وحدك حتى ترسل عرضًا.', 'Cost the request on your printer from the customer’s file — without downloading it. The price is yours alone until you send an offer.')}
              </p>
            )}
          </div>
          <CostingSheet
            open={sheet}
            requestId={requestId}
            onClose={() => setSheet(false)}
            onCosted={loadCosts}
            onUseAsOffer={takingOffers ? use : undefined}
          />
        </>
      ) : (
        <ul className="mt-2 space-y-2" data-workshop-reasons>
          {verdict.reasons.map((code) => {
            const fix = reasonFix(code);
            return (
              <li key={code} className="flex flex-wrap items-center justify-between gap-x-3 border-t border-white/5 pt-2 text-[13px] first:border-t-0 first:pt-0" data-reason={code}>
                <span className="min-w-0 flex-1 basis-56 leading-relaxed text-text-secondary">{reasonText(code, loc)}</span>
                {fix && (
                  <a
                    href={fix === 'plan' ? FIX_HREF.plan : hrefFor(FIX_HREF[fix])}
                    className="inline-flex min-h-11 items-center text-[12.5px] font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {fixLabel(fix, loc)}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
