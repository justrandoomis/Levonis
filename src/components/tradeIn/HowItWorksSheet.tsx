/**
 * «كيف يعمل؟» — the five steps in one sheet, so the device list can open on the devices
 * themselves (trade-in design B.2: the intro collapses to one line and this sheet).
 */
import React, { useId } from 'react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { useT } from './useT';
import type { CopyKey } from './copy';

const STEPS: Array<[CopyKey, CopyKey]> = [
  ['how.1', 'how.1d'],
  ['how.2', 'how.2d'],
  ['how.3', 'how.3d'],
  ['how.4', 'how.4d'],
  ['how.5', 'how.5d'],
];

/**
 * The five steps as a list: in the sheet, and on the page itself where the page has nothing else
 * to show yet (signed out, or no LEVONIS device delivered). `compact` lays them in two columns on
 * a wide screen and sets them a size smaller.
 */
export function TradeInSteps({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  return (
    <ol className={compact ? 'grid gap-2.5 sm:grid-flow-col sm:grid-cols-2 sm:grid-rows-3' : 'space-y-3'} data-trade-in-steps>
      {STEPS.map(([title, detail], i) => (
        <li key={title} className="flex items-start gap-3">
          <span className={`lv-well flex shrink-0 items-center justify-center rounded-full font-black tabular-nums text-text-primary ${compact ? 'h-7 w-7 text-[12px]' : 'h-8 w-8 text-[13px]'}`} aria-hidden>
            {i + 1}
          </span>
          <span className="min-w-0">
            <span className={`block font-bold leading-5 text-text-primary ${compact ? 'text-[13px]' : 'text-[14px]'}`}>{t(title)}</span>
            <span className={`block leading-5 text-text-secondary ${compact ? 'text-[12px]' : 'text-[12.5px]'}`}>{t(detail)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function HowItWorksSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const titleId = useId();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      dragHandle
      testId="trade-in-how"
      panelClassName="sm:max-w-[460px] sm:w-[92vw]"
      header={
        <h2 id={titleId} className="px-4 pb-2 pt-1 text-center text-[16px] font-extrabold text-text-primary">
          {t('how.title')}
        </h2>
      }
      footer={
        <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
          <Button variant="secondary" block onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      }
    >
      <div className="px-4 py-2">
        <TradeInSteps />
      </div>
      <p className="px-4 pb-3 text-[12.5px] font-semibold text-gold">{t('promise')}</p>
    </Sheet>
  );
}
