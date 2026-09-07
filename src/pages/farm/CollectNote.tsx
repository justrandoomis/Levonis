/**
 * The collect result as a Note (role="note", house tones): the coins the
 * server paid, the batch that failed, the payout the daily cap deferred, or
 * "already collected". It draws the notice `collectNotice` derived from the
 * server's answer and nothing else; the shell mounts it inside an aria-live
 * region so a screen reader hears it once, and the printer sheet repeats it
 * beside the machine it concerns.
 */
import React from 'react';
import { AlertTriangle, CalendarClock, Coins, Info, X } from 'lucide-react';
import Note from '../../components/ui/Note';
import type { CollectNotice } from './collect';
import type { FarmStrings } from './strings';
import { FOCUS } from './ui';

export default function CollectNote({ notice, s, onClose, testId = 'farm-collect-note' }: { notice: CollectNotice; s: FarmStrings; onClose?: () => void; testId?: string }) {
  const icon =
    notice.kind === 'paid' ? (
      <Coins className="w-4 h-4" />
    ) : notice.kind === 'failed' ? (
      <AlertTriangle className="w-4 h-4" />
    ) : notice.kind === 'deferred' ? (
      <CalendarClock className="w-4 h-4" />
    ) : (
      <Info className="w-4 h-4" />
    );
  return (
    <Note tone={notice.tone} compact icon={icon} testId={testId} className="tabular-nums">
      <div className="flex items-start gap-2" data-farm-collect-kind={notice.kind}>
        <div className="flex-1 min-w-0 py-1 leading-snug">
          <p>{notice.text}</p>
          {notice.detail && <p className="text-[12px] opacity-80 mt-0.5">{notice.detail}</p>}
        </div>
        {onClose && (
          <button type="button" aria-label={s.close} onClick={onClose} className={`shrink-0 -my-2 -me-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg hover:bg-white/5 ${FOCUS}`}>
            <X aria-hidden="true" className="w-4 h-4" />
          </button>
        )}
      </div>
    </Note>
  );
}
