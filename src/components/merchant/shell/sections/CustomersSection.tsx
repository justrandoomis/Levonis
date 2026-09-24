/**
 * `/merchant/customers` — the people who have bought from this store.
 *
 * Moved out of the old dashboard page unchanged. Only people who have
 * actually bought here — not a directory: a merchant has no way to browse
 * Levonis users from this screen (§60), and cancelled orders do not make a
 * customer (the server's own rule, audit 01 B12).
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../../../../LanguageContext';
import { merchantApi, iqd } from '../../../../lib/merchant';
import { ListRowsSkeleton } from '../../../ui/DashboardSkeletons';
import { Empty } from '../../dashboard/ui';

export default function CustomersSection() {
  const { loc } = useLanguage();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    merchantApi.customers().then((d) => setRows(d.customers)).catch(() => setRows([]));
  }, []);

  if (rows === null) return <ListRowsSkeleton rows={4} thumbnail={false} />;
  if (!rows.length) return <Empty text={loc('لا يوجد عملاء بعد', 'No customers yet', 'هێشتا کڕیار نییە')} />;

  return (
    <div className="space-y-2">
      {rows.map((c) => (
        <div key={String(c.id)} className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-white text-[12.5px] font-semibold truncate">{String(c.name)}</p>
            <p className="text-zinc-500 text-[11px]">
              {loc(`${c.order_count} طلب`, `${c.order_count} orders`, `${c.order_count} داواکاری`)}
            </p>
          </div>
          <span className="text-gold text-[12px] font-bold shrink-0" dir="ltr">{iqd(Number(c.lifetime_iqd))}</span>
        </div>
      ))}
    </div>
  );
}
