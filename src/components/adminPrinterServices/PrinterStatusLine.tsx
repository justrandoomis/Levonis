/**
 * The status header of ONE printer (phase 5 redesign, DECISIONS row 358): first, in words, what a
 * customer sees for this printer right now; then the single next step («الخطوة التالية») on the way
 * choose → save → publish, with the three stages ticked as they are done; then what still blocks a
 * publish — this printer's and the shared list's issues said in full, those of other printers only
 * counted («و٢ في طابعات أخرى»), never named.
 */
import { mappingResolves, type PrinterServicesConfig } from '../../../packages/pricing/src/printerServices';
import { S, say, type Loc, type Tri } from './adminPrinterStrings';

export type IssueSay = (issue: string) => { text: string; translated: boolean };

/** Splits server issues: this printer's or the shared list's (said), and other printers' (counted). */
export function scopeIssues(issues: readonly string[], productId: string, printerIds: Iterable<string>): { mine: string[]; others: number } {
  const others = [...new Set(printerIds)].filter((id) => id && id !== productId);
  const mine: string[] = [];
  let count = 0;
  for (const i of issues) {
    if (i.includes(productId)) mine.push(i);
    else if (others.some((id) => i.includes(id))) count += 1;
    else mine.push(i);
  }
  return { mine, others: count };
}

export type NextStep = 'save-product' | 'none' | 'map' | 'fix-local' | 'save' | 'fix' | 'publish' | 'done';

/**
 * The ONE thing to do next. In order: the product must be a saved printer; a used printer takes no
 * services; this printer needs its family and class; a kit / add-on problem the save would refuse;
 * unsaved edits; what the publish would refuse; an unpublished saved copy; nothing.
 */
export function nextStepOf(a: { listed: boolean; used: boolean; mapped: boolean; held: boolean; dirty: boolean; issues: number; upToDate: boolean }): NextStep {
  if (!a.listed) return 'save-product';
  if (a.used) return 'none';
  if (!a.mapped) return 'map';
  if (a.held) return 'fix-local';
  if (a.dirty) return 'save';
  if (a.issues > 0) return 'fix';
  return a.upToDate ? 'done' : 'publish';
}

/** Where a blocker is fixed: step 1 (this printer's two choices), step 2 (what is sold with it), step 3 (the shared list). */
export function whereOf(issue: string): Tri | null {
  if (/^products: map at least one|^products\.[^:]*: no (warranty family|delivery class|version has both)/.test(issue)) return S.inStep1;
  if (/^(kits|addons)\b|store.bundle/.test(issue)) return S.inStep2;
  if (/^(care|packages|membership|warranty|delivery|packaging|inspection|academy)\b/.test(issue)) return S.inStep3;
  return null;
}

const NEXT: Record<NextStep, Tri> = {
  'save-product': S.nextSaveProduct, none: S.nextNone, map: S.nextMap, 'fix-local': S.nextFixLocal,
  save: S.nextSave, fix: S.nextFix, publish: S.nextPublish, done: S.nextDone,
};

export default function PrinterStatusLine({ loc, productId, listed, used = false, productStatus = 'active', draft, published, publishIssues, printerIds, dirty, held = false, readOnly = false, issueSay }: {
  loc: Loc; productId: string; listed: boolean; used?: boolean; productStatus?: string;
  draft: PrinterServicesConfig; published: PrinterServicesConfig | null;
  /** What blocks a publish: worked out from the draft on screen, plus the server's catalogue checks of the saved copy. */
  publishIssues: readonly string[]; printerIds: Iterable<string>; dirty: boolean;
  /** A kit or an add-on carries a problem the save would refuse. */
  held?: boolean; readOnly?: boolean; issueSay: IssueSay;
}) {
  const shows = !!published && mappingResolves(published, productId);
  const mapped = mappingResolves(draft, productId);
  const upToDate = !!published && published.revision === draft.revision;
  const { mine, others } = scopeIssues(publishIssues, productId, printerIds);
  const step = nextStepOf({ listed, used, mapped, held, dirty, issues: mine.length + others, upToDate });
  const state = !listed ? 'not-listed' : used ? 'used' : shows ? 'live' : published ? 'not-here' : 'off';
  const head = state === 'not-listed' ? S.stNotListed : state === 'used' ? S.stUsed : state === 'live' ? S.stPublished : state === 'not-here' ? S.stPublishedNotHere : S.stNotPublished;
  const tone = state === 'live' ? 'text-success' : state === 'not-listed' || state === 'used' ? 'text-text-primary' : 'text-warning';
  // choose → save → publish: a stage is done once nothing before it is still open.
  const stages: Array<[Tri, boolean]> = [
    [S.stepMap, mapped],
    [S.stepSave, mapped && !dirty && !held],
    [S.stepPublish, mapped && !dirty && !held && upToDate && shows],
  ];
  const current = stages.findIndex(([, done]) => !done);

  return (
    <div className="lv-surface p-3 space-y-2 text-[12px] text-text-secondary" role="status" data-printer-status-line>
      <p className="flex flex-wrap items-center gap-2">
        <span className={`text-[14px] font-bold leading-snug ${tone}`} data-printer-status={state}>{say(loc, head)}</span>
        {dirty ? <span className="lv-chip [--chip:var(--color-warning)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold" data-printer-status-dirty>{say(loc, S.stUnsaved)}</span> : null}
      </p>
      {state === 'live' && !upToDate ? <p data-printer-status-older>{say(loc, S.stPublishedOlder)}</p> : null}
      {listed && productStatus !== 'active' ? <p className="text-warning" data-printer-status-product-hidden>{say(loc, S.stProductHidden)}</p> : null}

      {listed && !used ? (
        <ol className="flex flex-wrap items-center gap-1.5" aria-label={say(loc, S.stepsLabel)} data-printer-status-steps>
          {stages.map(([label, done], i) => (
            <li
              key={i}
              className={`lv-chip shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${done ? '[--chip:var(--color-success)]' : i === current ? '[--chip:var(--color-warning)]' : '[--chip:var(--color-info)]'}`}
              aria-current={i === current ? 'step' : undefined}
              data-step-state={done ? 'done' : i === current ? 'current' : 'todo'}
            >
              {done ? <span aria-hidden="true">✓ </span> : null}{say(loc, label)}{done ? <span className="sr-only"> · {say(loc, S.stepDone)}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      <p className={step === 'done' || step === 'none' ? 'text-[13px] text-text-secondary leading-relaxed' : 'rounded-lg border border-border-subtle p-2 text-[13px] text-text-primary leading-relaxed'} data-printer-next-step={step}>
        {step === 'done' || step === 'none' ? null : <span className="font-bold">{say(loc, S.next)}: </span>}
        {say(loc, NEXT[step])}
        {readOnly && step !== 'done' && step !== 'none' ? <span className="text-text-secondary"> {say(loc, S.nextOwner)}</span> : null}
      </p>

      {mine.length || others ? (
        <div data-printer-status-blockers>
          <p className="font-semibold text-text-primary">{say(loc, S.stBlockers)}</p>
          <ul className="list-disc ps-5 leading-relaxed">
            {mine.map((i) => {
              const said = issueSay(i);
              const where = said.translated ? whereOf(i) : null;
              return <li key={i} dir={said.translated ? undefined : 'ltr'}>{said.text}{where ? <span className="text-text-muted"> ({say(loc, where)})</span> : null}</li>;
            })}
          </ul>
          {others ? (
            <p data-printer-status-others>
              {mine.length
                ? loc(`و${others} في طابعات أخرى`, `and ${others} on other printers`, `و ${others} لە پرینتەرەکانی تردا`)
                : loc(`${others} في طابعات أخرى`, `${others} on other printers`, `${others} لە پرینتەرەکانی تردا`)}
            </p>
          ) : null}
          {dirty ? <p className="text-[11px] text-text-muted" data-printer-status-live-note>{say(loc, S.stIssuesLive)}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
