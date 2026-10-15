/**
 * SCREEN 2 — «ماذا تستبدل؟», a Combo only (trade-in design B.2): the whole machine, the printer
 * alone or the AMS alone, as three radio rows. No figure here — the offer is screen 5's alone. A
 * part the shop cannot value today is disabled with its reason.
 */
import React, { useEffect, useId, useState } from 'react';
import { Check } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import SafeImage from '../ui/SafeImage';
import { useT } from './useT';
import { ErrorLine, RadioGroup } from './parts';
import { reasonKey } from './DeviceList';
import type { EligibleUnit, TradeInScope } from './model';
import type { CopyKey } from './copy';

const LABEL: Record<TradeInScope, [CopyKey, CopyKey]> = {
  whole: ['scope.whole', 'scope.wholeHint'],
  printer_only: ['scope.printer', 'scope.printerHint'],
  ams_only: ['scope.ams', 'scope.amsHint'],
};

/** Why one part cannot be traded, in the customer's words (review F-24): the server's reason, else the generic line. */
export function scopeReasonKey(reason: string | null | undefined): CopyKey {
  if (!reason || reason === 'TRADE_IN_SCOPE_UNAVAILABLE') return 'reason.scope';
  const k = reasonKey({ reason, open_request_id: null, in_shop: false });
  return k === 'reason.other' ? 'reason.scope' : k;
}

export default function ScopeSheet({
  unit,
  onClose,
  onChoose,
  busy,
  error,
}: {
  unit: EligibleUnit | null;
  onClose: () => void;
  onChoose: (scope: TradeInScope) => unknown;
  busy: boolean;
  error: string;
}) {
  const { t } = useT();
  const titleId = useId();
  const [scope, setScope] = useState<TradeInScope>('whole');
  useEffect(() => {
    if (unit) setScope(unit.scopes.find((s) => s.available)?.scope ?? 'whole');
  }, [unit]);
  const chosen = unit?.scopes.find((s) => s.scope === scope);
  return (
    <Sheet
      open={!!unit}
      onClose={onClose}
      labelledBy={titleId}
      dragHandle
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      testId="trade-in-scope"
      panelClassName="sm:max-w-[460px] sm:w-[92vw]"
      header={
        <div className="px-4 pb-2 pt-1">
          <h2 id={titleId} className="text-center text-[16px] font-extrabold text-text-primary">
            {t('scope.q')}
          </h2>
        </div>
      }
      footer={
        <div className="space-y-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
          <ErrorLine>{error}</ErrorLine>
          <Button variant="primary" block loading={busy} disabled={!chosen?.available} onClick={() => onChoose(scope)} data-scope-continue>
            {t('continue')}
          </Button>
        </div>
      }
    >
      {unit ? (
        <div className="space-y-3 px-4 py-2">
          <div className="flex items-center gap-3">
            <SafeImage sizes="48px" src={unit.image} alt="" aspect="square" className="h-12 w-12 shrink-0 rounded-md" bgClassName="bg-surface" />
            <p className="min-w-0 text-[14px] font-bold leading-5 text-text-primary line-clamp-2">{unit.name}</p>
          </div>
          <RadioGroup aria-labelledby={titleId} className="space-y-2">
            {unit.scopes.map((s) => {
              const on = s.scope === scope;
              const [title, hint] = LABEL[s.scope];
              return (
                <button
                  key={s.scope}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!s.available}
                  onClick={() => setScope(s.scope)}
                  data-scope={s.scope}
                  className="lv-choice flex w-full items-center gap-3 p-3.5 text-start disabled:opacity-55"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] font-bold text-text-primary">{t(title)}</span>
                    <span className="block text-[12.5px] leading-5 text-text-muted">{s.available ? t(hint) : t(scopeReasonKey(s.reason))}</span>
                  </span>
                  <span className="lv-choice-mark" aria-hidden>
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                </button>
              );
            })}
          </RadioGroup>
        </div>
      ) : null}
    </Sheet>
  );
}
