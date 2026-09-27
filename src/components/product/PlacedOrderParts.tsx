import { useEffect, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { api, type ApiOrder } from '../../lib/api';
import MaintenanceShelf from './MaintenanceShelf';

/**
 * «مواد الصيانة لطابعتك» ON THE CONFIRMATION — the moment the printer is bought.
 *
 * The owner: «عندما يشتري المستخدم طابعة معينة يظهر له اقتراحات مواد الصيانة
 * لهذه الطابعة التي اشتراها». The order the customer just placed is read back
 * (`GET /api/orders/:id` names each printer on it that has maintenance parts,
 * a used unit as its model) and the first one gets its shelf under the
 * buttons. Asked for only after the celebration has finished moving, and
 * silent when the order has no printer or the read fails: a confirmation
 * screen must never grow an error card.
 */
export default function PlacedOrderParts({ orderId }: { orderId: string }) {
  const { lang, loc } = useLanguage();
  const [parts, setParts] = useState<NonNullable<ApiOrder['maintenance_parts']>>([]);

  useEffect(() => {
    let alive = true;
    api
      .get<{ order: ApiOrder }>(`/api/orders/${encodeURIComponent(orderId)}`, { mascot: 'silent' })
      .then((res) => alive && setParts(res.order?.maintenance_parts ?? []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [orderId]);

  const m = parts[0];
  if (!m) return null;
  const printer = lang === 'en' ? m.name || m.name_ar : lang === 'ckb' ? m.name_ckb || m.name_ar || m.name : m.name_ar || m.name;
  // OWNER: Sorani to be written by hand.
  return (
    <div className="mt-12 w-full max-w-[1200px] text-start" data-placed-order-parts={m.printer_slug}>
      <MaintenanceShelf
        id="placed-order-parts"
        printerSlug={m.printer_slug}
        count={m.count}
        path={m.path}
        title={loc('مواد الصيانة لطابعتك', 'Maintenance parts for your printer')}
        subline={lang === 'en' ? `Fits your ${printer}` : `تناسب طابعتك ${printer}`}
      />
    </div>
  );
}
