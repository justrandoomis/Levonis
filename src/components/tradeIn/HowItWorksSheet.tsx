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
      <ol className="space-y-3 px-4 py-2">
        {STEPS.map(([title, detail], i) => (
          <li key={title} className="flex items-start gap-3">
            <span className="lv-well flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-black tabular-nums text-text-primary" aria-hidden>
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-bold leading-5 text-text-primary">{t(title)}</span>
              <span className="block text-[12.5px] leading-5 text-text-secondary">{t(detail)}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="px-4 pb-3 text-[12.5px] font-semibold text-gold">{t('promise')}</p>
    </Sheet>
  );
}
