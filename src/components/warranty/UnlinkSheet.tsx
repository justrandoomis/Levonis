import React, { useRef } from 'react';
import { Unlink } from 'lucide-react';
import type { Language } from '../../translations';
import { Sheet } from '../ui/Overlay';
import type { Device } from './types';
import { productName } from './types';
import type { WarrantyStrings } from './strings';
import { BTN_DANGER, BTN_SECONDARY, ERROR_BOX } from './ui';

/**
 * "Remove from my account" confirmation. A `Sheet` because there is nothing
 * typed inside it to lose — a flick down is a perfectly good "no". The device
 * is named in the sheet itself so, unlike the forms, it does not need to grow
 * out of its card to say which printer it is about.
 */
export function UnlinkSheet({
  device,
  open,
  busy,
  error,
  blocked = false,
  lang,
  s,
  onConfirm,
  onClose,
}: {
  device: Device | null;
  open: boolean;
  busy: boolean;
  /** The explanation shown when the server (or a known open claim) refuses. */
  error: string;
  /** True when confirming is pointless (an open claim blocks the unlink). */
  blocked?: boolean;
  lang: Language;
  s: WarrantyStrings;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const last = useRef<Device | null>(null);
  if (device) last.current = device;
  const shown = device ?? last.current;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy="warranty-unlink-title"
      z={60}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      testId="warranty-unlink-sheet"
      panelClassName="w-full sm:max-w-md"
    >
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-4">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-full bg-red-500/10 text-red-300 flex items-center justify-center shrink-0">
            <Unlink aria-hidden="true" className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h2 id="warranty-unlink-title" className="text-white font-bold text-base leading-snug">
              {s.unlinkTitle}
            </h2>
            {shown && (
              <p className="text-zinc-400 text-[13px] mt-0.5 truncate">
                {productName(shown.product, lang)}
                {' · '}
                <span dir="ltr" className="font-mono">{shown.serial ?? s.unitN(shown.unit_index)}</span>
              </p>
            )}
          </div>
        </div>
        <p className="text-zinc-400 text-sm leading-relaxed">{s.unlinkBody}</p>
        {error && (
          <div role="alert" className={ERROR_BOX}>
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            {s.cancel}
          </button>
          <button type="button" onClick={onConfirm} disabled={busy || blocked} className={BTN_DANGER}>
            {busy ? s.unlinking : s.unlinkConfirm}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
