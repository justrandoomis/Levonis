/**
 * «قبل أن تفتح متجرك» — THE READINESS VERDICT BEFORE OPENING (Community V3
 * push 1.3, wave 1; ./readiness.ts says the rules).
 *
 * The status strip opens this sheet instead of re-opening at once when an
 * APPROVED merchant switches a closed store on: the needed steps, then the
 * recommended ones, each a tick or a door to where it is fixed, from the
 * attention read the checklist already makes. Opening is the merchant's own
 * tap on the button at the bottom — the same PATCH /api/merchant/store {open}
 * the switch used, refused by the server in the store's own words when it
 * must be (E8, DELIVERY_NO_COVERAGE). Its chunk loads on the first open.
 */
import { ChevronRight, Circle, CircleCheck } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Sheet } from '../../ui/Sheet';
import { useWorkspace } from '../shell/context';
import { Door } from './PulseRow';
import { missingRequired, readinessVerdicts, verdictText, type Verdict } from './readiness';
import { fill, useCounterStrings } from './strings';

export default function ReadinessSheet({
  open,
  busy,
  onClose,
  onOpenStore,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onOpenStore: () => void;
}) {
  const s = useCounterStrings();
  const ws = useWorkspace();
  const setup = ws.attention.data?.setup;
  const verdicts = setup ? readinessVerdicts(setup, ws.me.approved === true) : null;
  const missing = verdicts ? missingRequired(verdicts) : 0;
  const ready = !!verdicts && missing === 0;

  const row = (v: Verdict) => (
    <li key={v.id} data-readiness={v.id} data-ok={v.ok ? 'true' : 'false'} data-required={v.required ? 'true' : 'false'}>
      {v.ok || !v.link ? (
        <p className={`flex min-h-11 items-center gap-3 text-[13.5px] ${v.ok ? 'text-text-muted' : 'text-text-primary'}`}>
          {v.ok ? <CircleCheck aria-hidden="true" className="h-5 w-5 shrink-0 text-success" /> : <Circle aria-hidden="true" className="h-5 w-5 shrink-0 text-warning" />}
          <span className="min-w-0 flex-1">{verdictText(v.id, s)}</span>
          <span className="sr-only">{v.ok ? s.readiness.done : s.readiness.fix}</span>
        </p>
      ) : (
        <Door
          to={v.link}
          className="group flex min-h-11 items-center gap-3 rounded-lg text-[13.5px] font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Circle aria-hidden="true" className={`h-5 w-5 shrink-0 ${v.required ? 'text-warning' : 'text-text-muted'}`} />
          <span className="min-w-0 flex-1">{verdictText(v.id, s)}</span>
          <span className="shrink-0 text-[12px] text-text-muted">{s.readiness.fix}</span>
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted rtl:-scale-x-100" />
        </Door>
      )}
    </li>
  );

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      detents={['large']}
      label={s.readiness.title}
      header={
        <div className="px-4 pb-2">
          <h2 className="text-[15px] font-bold text-text-primary">{s.readiness.title}</h2>
          <p className="text-[12.5px] leading-relaxed text-text-muted">{s.readiness.lead}</p>
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {s.readiness.notNow}
          </Button>
          <Button variant={ready ? 'primary' : 'secondary'} size="sm" onClick={onOpenStore} loading={busy} data-readiness-open={ready ? 'ready' : 'anyway'}>
            {ready ? s.readiness.open : s.readiness.openAnyway}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 px-4 py-3" data-readiness-sheet>
        {!verdicts ? (
          <p className="text-[13px] text-text-muted" data-readiness-unknown>
            {s.readiness.unknown}
          </p>
        ) : (
          <>
            <p role="status" className={`text-[13px] font-semibold ${ready ? 'text-success' : 'text-warning'}`} data-readiness-summary>
              {ready ? s.readiness.ready : fill(s.readiness.missing, { n: missing })}
            </p>
            <section aria-labelledby="readiness-required">
              <h3 id="readiness-required" className="text-[12px] font-semibold text-text-muted">
                {s.readiness.required}
              </h3>
              <ul className="divide-y divide-border-subtle">{verdicts.filter((v) => v.required).map(row)}</ul>
            </section>
            <section aria-labelledby="readiness-recommended">
              <h3 id="readiness-recommended" className="text-[12px] font-semibold text-text-muted">
                {s.readiness.recommended}
              </h3>
              <ul className="divide-y divide-border-subtle">{verdicts.filter((v) => !v.required).map(row)}</ul>
            </section>
          </>
        )}
      </div>
    </Sheet>
  );
}
