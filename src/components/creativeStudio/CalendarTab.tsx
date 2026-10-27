/**
 * «التقويم والشبكة» — the internal calendar (spec §25, §26; migration 0216).
 * A design gets a planned DAY (the Asia/Baghdad calendar day, week starting
 * Saturday); its status, version and approval do not change. The month view
 * lists what is planned; the grid preview is a three-column SIMULATION of the
 * next nine planned designs, drawn from each one's latest export or, without
 * one, from the design itself through the editor's renderer. There is no
 * external publishing and the screen says so: nothing here posts anything.
 */
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Select } from '../ui/Field';
import { StatusChip } from '../ui/Badge';
import VariantImg from '../ui/VariantImg';
import type { PlanItemDto } from '../../../packages/creativeDoc/src/api';
import { documents, exportFileUrl, plan as planApi } from './client';
import DocThumb from './DocThumb';
import { statusTone } from './CampaignsTab';
import { WEEKDAY_ORDER, addDays, baghdadToday, gridOrder, monthOf, monthRange, monthWeeks } from './planningModel';
import { STATUS_TEXT, S, type Lang } from './strings';
import { RemoteView, failText, useRemote, useStudio, useText } from './shared';

function intlLocale(lang: Lang): string {
  return lang === 'en' ? 'en-GB' : lang === 'ckb' ? 'ckb-IQ' : 'ar-IQ';
}

function monthTitle(month: string, lang: Lang): string {
  try {
    return new Date(`${month}-01T12:00:00Z`).toLocaleDateString(intlLocale(lang), { month: 'long', year: 'numeric', timeZone: 'UTC', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions);
  } catch {
    return month;
  }
}

function weekdayName(day: number, lang: Lang): string {
  // 2026-01-04 is a Sunday; `day` is 0 = Sunday … 6 = Saturday.
  const d = new Date(Date.UTC(2026, 0, 4 + day, 12));
  try {
    return d.toLocaleDateString(intlLocale(lang), { weekday: 'short', timeZone: 'UTC' });
  } catch {
    return String(day);
  }
}

/** A planned design drawn small: its latest export, else the design itself. */
function GridCell({ item }: { item: PlanItemDto }) {
  const { w } = useText();
  const d = item.document;
  const [doc] = useRemote(() => (d.thumb_export_id ? Promise.resolve(null) : documents.get(d.id)), [d.id, d.thumb_export_id]);
  return (
    <div className="relative aspect-square overflow-hidden bg-surface" data-grid-cell={d.id}>
      {d.thumb_export_id ? (
        <VariantImg src={exportFileUrl(d.thumb_export_id)} sizes="200px" alt={d.title} className="h-full w-full object-cover" />
      ) : doc.status === 'ready' && doc.data ? (
        <div className="flex h-full w-full items-center justify-center"><DocThumb doc={doc.data.content} width={200} label={d.title} /></div>
      ) : <span className="flex h-full items-center justify-center p-2 text-center text-xs text-text-muted">{d.title}</span>}
      <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-center text-[11px]" style={{ background: 'rgba(17,24,39,0.75)', color: '#ffffff' }}>{w(S.gridPlanned)} · {item.planned_for}</span>
    </div>
  );
}

export default function CalendarTab() {
  const studio = useStudio();
  const { lang, w } = useText();
  const today = baghdadToday();
  const [month, setMonth] = useState(monthOf(today));
  const range = monthRange(month);
  const [items, reload] = useRemote(() => planApi.between(range.from, range.to), [month]);
  const [upcoming, reloadUpcoming] = useRemote(() => planApi.between(today, addDays(today, 92)), []);
  const [recent] = useRemote(() => documents.list({ limit: 60 }), []);
  const [pick, setPick] = useState({ id: '', day: today });
  const [error, setError] = useState('');

  const setDay = async (id: string, day: string | null) => {
    setError('');
    try {
      await planApi.set(id, day);
      reload();
      reloadUpcoming();
    } catch (e) {
      setError(failText(e, lang));
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-calendar-tab>
      <p className="rounded-xl bg-surface p-3 text-sm text-text-secondary" role="note" data-no-publishing>{w(S.noPublishing)}</p>

      <Card title={w(S.calPlan)} description={w(S.calPlannedNote)}>
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); if (pick.id && pick.day) void setDay(pick.id, pick.day); }}>
          <Field label={w(S.calDesign)} className="sm:col-span-2">
            <Select value={pick.id} onChange={(e) => setPick({ ...pick, id: e.target.value })} data-plan-design>
              <option value="">—</option>
              {(recent.status === 'ready' ? recent.data.documents : []).map((d) => <option key={d.id} value={d.id}>{d.title || d.id} · {w(STATUS_TEXT[d.status])}</option>)}
            </Select>
          </Field>
          <Field label={w(S.calDay)}><Input type="date" ltr value={pick.day} onChange={(e) => setPick({ ...pick, day: e.target.value })} /></Field>
          <div><Button type="submit" variant="primary" disabled={!pick.id || !pick.day}>{w(S.calSave)}</Button></div>
        </form>
        {error ? <p className="mt-2 text-sm text-danger" role="alert">{error}</p> : null}
      </Card>

      <Card
        title={monthTitle(month, lang)}
        action={(
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" onClick={() => setMonth(monthOf(`${month}-01`, -1))}>{w(S.calPrev)}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMonth(monthOf(today))}>{w(S.calToday)}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMonth(monthOf(`${month}-01`, 1))}>{w(S.calNext)}</Button>
          </div>
        )}
      >
        <RemoteView remote={items} onRetry={reload} compact>
          {(data) => {
            const byDay = new Map<string, PlanItemDto[]>();
            for (const it of data.items) byDay.set(it.planned_for, [...(byDay.get(it.planned_for) ?? []), it]);
            return (
              <>
                {!data.migrated ? <p className="mb-2 text-sm text-warning" role="status">{w(S.notMigrated)}</p> : null}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] table-fixed border-collapse text-xs" data-month-grid>
                    <thead>
                      <tr>{WEEKDAY_ORDER.map((d) => <th key={d} scope="col" className="p-1 font-semibold text-text-muted">{weekdayName(d, lang)}</th>)}</tr>
                    </thead>
                    <tbody>
                      {monthWeeks(month).map((week, i) => (
                        <tr key={i}>
                          {week.map((day, j) => (
                            <td key={j} className={`h-20 border border-border-subtle p-1 align-top ${day === today ? 'bg-surface' : ''}`}>
                              {day ? (
                                <>
                                  <span className="block text-[11px] text-text-muted" dir="ltr">{Number(day.slice(8))}</span>
                                  {(byDay.get(day) ?? []).map((it) => (
                                    <span key={it.document.id} className="mt-1 flex items-center gap-1">
                                      <button type="button" className="min-w-0 flex-1 truncate text-start text-text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" title={`${it.document.title} · ${w(STATUS_TEXT[it.document.status])}`} onClick={() => studio.openDocument(it.document.id)}>
                                        {it.document.title || it.document.id}
                                      </button>
                                      <button type="button" aria-label={`${w(S.calUnplan)}: ${it.document.title}`} className="shrink-0 px-1 text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setDay(it.document.id, null)}>×</button>
                                    </span>
                                  ))}
                                </>
                              ) : null}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!data.items.length ? <p className="mt-2 text-sm text-text-muted">{w(S.calEmptyMonth)}</p> : (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {data.items.map((it) => <li key={it.document.id}><StatusChip tone={statusTone(it.document.status)}>{it.planned_for} · {w(STATUS_TEXT[it.document.status])}</StatusChip></li>)}
                  </ul>
                )}
              </>
            );
          }}
        </RemoteView>
      </Card>

      <Card title={w(S.gridTitle)} description={w(S.gridNote)}>
        <RemoteView remote={upcoming} onRetry={reloadUpcoming} compact>
          {(data) => {
            const cells = gridOrder(data.items);
            if (!cells.length) return <p className="text-sm text-text-muted">{w(S.gridEmpty)}</p>;
            return (
              <div className="mx-auto grid max-w-md grid-cols-3 gap-0.5" data-profile-grid>
                {cells.map((it) => <GridCell key={it.document.id} item={it} />)}
              </div>
            );
          }}
        </RemoteView>
      </Card>
    </div>
  );
}
