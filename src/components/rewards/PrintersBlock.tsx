/**
 * «طابعاتك» on /rewards/coupons (owner, 2026-11-05: «coupons with every printer»;
 * docs/DECISIONS.md row 298): which printer earns, until when, when its next coupons
 * come, or why it stopped. The server decides all of it, by the same definition its
 * weekly sweep issues by; this draws it.
 *
 * Quiet: nothing while the read is on its way or after it failed, and nothing for a
 * customer with no printer (the coupons' empty state already explains). More than
 * three printers fold to three behind «عرض الكل (n)».
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatFigure } from '../../lib/localeNumber';
import { Button } from '../ui/Button';
import SafeImage from '../ui/SafeImage';
import { GROUP_HEADING } from './AreaChrome';
import type { CopyKey } from './copy';
import { nearDate } from './model';
import type { PrinterStopped, RewardPrinter, RewardPrintersData } from './types';
import type { Read } from './useRewardsData';
import { useRewardsT } from './useT';

/** How many printers show before «عرض الكل». */
const FOLDED = 3;

const STOPPED: Readonly<Record<PrinterStopped, CopyKey>> = {
  warranty_closed: 'printers.stopped.warranty_closed',
  warranty_over: 'printers.stopped.warranty_over',
  returned: 'printers.stopped.returned',
  traded_in: 'printers.stopped.traded_in',
  in_shop: 'printers.stopped.in_shop',
  programme_off: 'printers.stopped.programme_off',
};

export function PrintersBlock({ read }: { read: Read<RewardPrintersData> }) {
  const { t, lang } = useRewardsT();
  const [open, setOpen] = useState(false);
  const data = read.data;
  const printers = data?.printers ?? [];
  if (!data || data.installed === false || printers.length === 0) return null;
  const shown = open ? printers : printers.slice(0, FOLDED);

  return (
    <section aria-labelledby="my-printers-title" data-rewards-printers className="lv-surface p-4">
      <h2 id="my-printers-title" className={GROUP_HEADING}>
        {t('printers.title')}
      </h2>
      <ul className="mt-1 divide-y divide-border-subtle">
        {shown.map((p) => (
          <PrinterRow key={`${p.order_item_id}:${p.unit_index}`} p={p} serverTime={data.server_time} />
        ))}
      </ul>
      {printers.length > FOLDED && (
        <Button
          variant="ghost"
          block
          className="mt-1 justify-between"
          aria-expanded={open}
          iconEnd={<ChevronDown className={`w-4 h-4 shrink-0 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />}
          onClick={() => setOpen(!open)}
        >
          {open ? t('printers.showFewer') : t('printers.showAll', { n: formatFigure(printers.length, lang) })}
        </Button>
      )}
    </section>
  );
}

function PrinterRow({ p, serverTime }: { p: RewardPrinter; serverTime: string }) {
  const { t, tri, lang } = useRewardsT();
  return (
    <li data-rewards-printer={p.earning ? 'earning' : (p.stopped ?? 'stopped')} className="flex items-center gap-3 py-2.5">
      <SafeImage src={p.image || null} alt="" aspect="square" sizes="48px" className="size-12 shrink-0 rounded-md" bgClassName="bg-surface-raised" />
      <div className="min-w-0 flex-1">
        {/* Two lines, not a cut: the shop's real names are long, and a cut lands mid-word in an RTL line. */}
        <p className="line-clamp-2 text-[14px] font-semibold leading-5 text-text-primary">
          <bdi>{tri(p.name)}</bdi>
        </p>
        {p.earning ? (
          <>
            {p.ends_at && <p className="text-[12px] leading-5 text-text-secondary">{t('printers.earning', { date: nearDate(p.ends_at, serverTime, lang) })}</p>}
            {p.next_at && <p className="text-[12px] leading-5 text-text-muted">{t('printers.next', { date: nearDate(p.next_at, serverTime, lang) })}</p>}
          </>
        ) : (
          <p className="text-[12px] leading-5 text-text-muted">{t(STOPPED[p.stopped ?? 'programme_off'])}</p>
        )}
      </div>
    </li>
  );
}
