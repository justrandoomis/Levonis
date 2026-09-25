/**
 * «طلبات تستطيع حساب تكلفتها» — ON THE COSTING SCREEN (stream W5-B).
 *
 * The newest requests this workshop can make that carry a 3D model — from the
 * same «مناسب لي» verdicts as the board — each a door to its own page with the
 * costing sheet open (`?cost=1`). Costing a customer's request needs no
 * download and no re-upload: the server measures the stored file. Renders
 * nothing when there is nothing to cost or the board is closed to the merchant.
 */
import { useEffect, useState } from 'react';
import { Box, Calculator } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Card } from '../../ui/Card';
import { workshopApi, type BoardRequest } from './api';

export default function RequestsToCost({ requestHref }: { requestHref: (requestId: string) => string }) {
  const { loc } = useLanguage();
  const [rows, setRows] = useState<BoardRequest[] | null>(null);

  useEffect(() => {
    let alive = true;
    workshopApi
      .board({ limit: 20 })
      .then((d) => alive && setRows(d.requests.filter((r) => r.has_preview && r.my_offer !== 'accepted').slice(0, 5)))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!rows || !rows.length) return null;
  return (
    <Card
      title={loc('طلبات تستطيع حساب تكلفتها', 'Requests you can cost')}
      description={loc('من ملف العميل مباشرة، على طابعتك، دون تنزيله. السعر لك وحدك حتى ترسل عرضًا.', 'Straight from the customer’s file, on your printer, without downloading it. The price is yours alone until you send an offer.')}
      padding="none"
    >
      <ul className="divide-y divide-white/5" data-requests-to-cost>
        {rows.map((r) => (
          <li key={r.id}>
            <a
              href={requestHref(r.id)}
              className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
              data-request-to-cost={r.id}
            >
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] text-text-secondary">
                <Box className="h-4 w-4" />
              </span>
              <span dir="auto" className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-primary">{r.title}</span>
              <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-semibold text-accent">
                <Calculator aria-hidden="true" className="h-4 w-4" />
                {loc('احسب', 'Cost it')}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
