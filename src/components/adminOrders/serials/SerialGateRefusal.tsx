/**
 * §19 AT THE DOOR THAT WAS REFUSED — «تبقى أرقام تسلسلية غير مرتبطة لهذا
 * الطلب.», drawn where the move was attempted (the stage path, the legacy
 * status correction), naming every unit still missing a serial with a way
 * straight to it. The Main Admin may move the order anyway with a reason of
 * 5–500 characters; the server re-checks that it is the owner and writes the
 * exception into the order's own record in the same batch as the move.
 *
 * One component for every door, so the gate reads the same wherever it stops
 * someone.
 */
import { useId, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, ScanLine, ShieldAlert } from 'lucide-react';
import { ApiError } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import { refusalText } from '../../../lib/refusalStrings';
import { serialStrings } from './strings';
import { MissingUnit } from './SerialsBlockerCard';
import type { GateMissing } from './types';

export interface GateRefusal {
  missing: GateMissing[];
  lotConflicts: number;
}

/** The gate's refusal out of an API error, or null for any other error. */
export function gateRefusalOf(e: unknown): GateRefusal | null {
  if (!(e instanceof ApiError) || e.code !== 'SERIALS_REQUIRED') return null;
  const d = (e.details ?? {}) as { missing?: unknown; lot_conflicts?: unknown };
  return {
    missing: Array.isArray(d.missing) ? (d.missing as GateMissing[]) : [],
    lotConflicts: Array.isArray(d.lot_conflicts) ? d.lot_conflicts.length : 0,
  };
}

export default function SerialGateRefusal({
  refusal,
  viewerOwner,
  busy,
  proceedLabel,
  onGoTo,
  onOverride,
  testId,
  listedAbove = false,
}: {
  refusal: GateRefusal;
  /**
   * The order's blocker card already lists these units on the same screen:
   * say so in one line instead of listing them twice.
   */
  listedAbove?: boolean;
  viewerOwner: boolean;
  busy: boolean;
  /** What the owner's button moves the order to («تابع النقل · في الطريق إليك»). */
  proceedLabel?: string;
  onGoTo?: (m: GateMissing) => void;
  /** Owner only: retry the same move with this reason. */
  onOverride: (reason: string) => void;
  testId?: string;
}) {
  const { lang, dir } = useLanguage();
  const s = serialStrings(lang);
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const Arrow = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const ok = reason.trim().length >= 5;

  return (
    <div role="alert" className="rounded-2xl border border-warning/35 bg-warning/10 p-3.5" data-serial-gate-refusal={testId ?? ''}>
      <p className="flex items-start gap-2 text-[13.5px] font-bold text-text-primary">
        <ScanLine className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        {refusalText('SERIALS_REQUIRED', l, s.blockerIntro)}
      </p>
      {refusal.missing.length > 0 && listedAbove && (
        <p className="mt-1.5 text-[12px] text-text-secondary" data-serial-gate-listed-above>
          {s.missingListedAbove(refusal.missing.length)}
        </p>
      )}
      {refusal.missing.length > 0 && !listedAbove && (
        <>
          <p className="mt-2 text-[12px] text-text-secondary">{s.blockerIntro}</p>
          <ul className="mt-1 divide-y divide-border-subtle">
            {refusal.missing.map((m) => (
              <li key={`${m.order_item_id}:${m.unit_index}`} className="flex items-center justify-between gap-3 py-1.5">
                <MissingUnit m={m} lang={lang} />
                {onGoTo && (
                  <button
                    type="button"
                    onClick={() => onGoTo(m)}
                    className="inline-flex shrink-0 items-center gap-1 min-h-[44px] px-3 rounded-full text-[12.5px] font-semibold text-text-primary hover:bg-surface-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                    data-serial-goto={`${m.order_item_id}:${m.unit_index}`}
                  >
                    {s.goToUnit}
                    <Arrow className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {refusal.lotConflicts > 0 && <p className="mt-2 text-[12px] text-warning">{s.lotConflict}</p>}
      {viewerOwner && (
        <form
          className="mt-3 space-y-2 border-t border-border-subtle pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok && !busy) onOverride(reason.trim());
          }}
          data-serial-gate-override
        >
          <p className="text-[13px] font-semibold text-text-primary">{s.ownerProceed}</p>
          <label htmlFor={reasonId} className="block text-[12px] font-semibold text-text-secondary">
            {s.reasonLabel}
          </label>
          <textarea
            id={reasonId}
            rows={2}
            minLength={5}
            maxLength={500}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby={`${reasonId}-hint`}
            className="w-full rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[13.5px] text-text-primary outline-none focus:border-gold resize-none"
          />
          <p id={`${reasonId}-hint`} className="text-[11.5px] text-text-secondary">
            {s.ownerProceedHint}
          </p>
          <button
            type="submit"
            disabled={!ok || busy}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-full bg-gold text-accent-contrast text-[13px] font-bold disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <ShieldAlert className="w-3.5 h-3.5" aria-hidden />}
            {s.proceed}
            {proceedLabel ? ` · ${proceedLabel}` : ''}
          </button>
        </form>
      )}
    </div>
  );
}
