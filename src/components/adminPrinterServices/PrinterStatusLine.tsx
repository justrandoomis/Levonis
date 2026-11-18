/**
 * One line of where THIS printer stands (phase 4 redesign, DECISIONS row 355): published and showing
 * its services; published but not showing them yet; not published; what its own mapping still lacks,
 * in words; unsaved edits; and what blocks a publish — the issues of this printer and of the shared
 * list said in full, those of other printers only counted («و٢ في طابعات أخرى»), never named.
 */
import { mappingResolves, type PrinterServicesConfig } from '../../../packages/pricing/src/printerServices';
import { S, say, type Loc } from './adminPrinterStrings';

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

export default function PrinterStatusLine({ loc, productId, listed, draft, published, publishIssues, printerIds, dirty, issueSay }: {
  loc: Loc; productId: string; listed: boolean; draft: PrinterServicesConfig; published: PrinterServicesConfig | null;
  publishIssues: readonly string[]; printerIds: Iterable<string>; dirty: boolean; issueSay: IssueSay;
}) {
  const shows = !!published && mappingResolves(published, productId);
  const m = Object.hasOwn(draft.products, productId) ? draft.products[productId] : null;
  const missing = listed ? [
    !m?.warranty_family ? say(loc, S.famLabel) : null,
    !m?.delivery_class ? say(loc, S.clsLabel) : null,
  ].filter((x): x is string => !!x) : [];
  const { mine, others } = scopeIssues(publishIssues, productId, printerIds);
  const head = !listed ? say(loc, S.stNotListed)
    : shows ? `${say(loc, S.stPublished)} · ${loc(`الإصدار ${published!.revision}`, `revision ${published!.revision}`, `وەشانی ${published!.revision}`)}`
      : published ? say(loc, S.stPublishedNotHere)
        : say(loc, S.stNotPublished);
  const tone = !listed ? 'text-text-secondary' : shows ? 'text-success' : 'text-warning';

  return (
    <div className="lv-surface p-3 space-y-1 text-[12px] text-text-secondary" role="status" data-printer-status-line>
      <p className="flex flex-wrap items-center gap-2">
        <span className={`font-bold ${tone}`} data-printer-status={!listed ? 'not-listed' : shows ? 'live' : published ? 'not-here' : 'off'}>{head}</span>
        {dirty ? <span className="lv-chip [--chip:var(--color-warning)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold" data-printer-status-dirty>{say(loc, S.stUnsaved)}</span> : null}
      </p>
      {missing.length ? <p data-printer-status-missing>{say(loc, S.stMissing)} {missing.join(loc('، ', ', ', '، '))}</p> : null}
      {mine.length || others ? (
        <div data-printer-status-blockers>
          <p className="font-semibold text-text-primary">{say(loc, S.stBlockers)}</p>
          <ul className="list-disc ps-5">
            {mine.map((i) => {
              const said = issueSay(i);
              return <li key={i} dir={said.translated ? undefined : 'ltr'}>{said.text}</li>;
            })}
          </ul>
          {others ? (
            <p data-printer-status-others>
              {mine.length
                ? loc(`و${others} في طابعات أخرى`, `and ${others} on other printers`, `و ${others} لە پرینتەرەکانی تردا`)
                : loc(`${others} في طابعات أخرى`, `${others} on other printers`, `${others} لە پرینتەرەکانی تردا`)}
            </p>
          ) : null}
        </div>
      ) : listed && !dirty && !missing.length && !shows ? <p className="text-success">{say(loc, S.stReady)}</p> : null}
    </div>
  );
}
