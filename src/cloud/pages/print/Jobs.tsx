/**
 * /jobs — EVERY PRINT, BY WHERE IT IS (GET /jobs, grouped by the server:
 * printing now, waiting in the queue or for the workshop's approval, being set
 * up, failed, completed, cancelled). The server keeps the 500 most recent.
 * While something is printing or waiting the list is asked again now and
 * then; the states are the server's, each said in words and a tone.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { formatFigure } from '../../../lib/localeNumber';
import { listJobs } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatRelative } from '../../format';
import { nav } from '../../strings/common';
import { jobsWords, print } from '../../strings/print';
import { useCloudText } from '../../text';
import type { JobGroups, JobSummary } from '../../types';
import {
  Box,
  CalendarClock,
  CloudEmptyState,
  CloudErrorState,
  CloudPageSkeleton,
  History,
  ListRow,
  PageHeader,
  Printer,
  SectionHeader,
  StatusPill,
  jobPillState,
} from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { MoreRow, RefreshNote, printerName, usePoll, usePrinterModels, useShown } from './kit';

const GROUPS = ['current', 'queued', 'in_preparation', 'failed', 'completed', 'cancelled'] as const;
type Group = (typeof GROUPS)[number];
const SERVER_CAP = 500;
const FIRST = 5;
const POLL_MS = 30_000;

const ICON: Record<Group, typeof Printer> = {
  current: Printer,
  queued: CalendarClock,
  in_preparation: Box,
  failed: History,
  completed: History,
  cancelled: History,
};

function GroupList({ group, jobs, modelName }: { group: Group; jobs: JobSummary[]; modelName: (id: string) => string | null }) {
  const { t, lang } = useCloudText();
  const [open, setOpen] = useState(false);
  const { shown, hasMore, more } = useShown(jobs);
  const rows = open ? shown : jobs.slice(0, FIRST);
  const Icon = ICON[group];
  return (
    <section aria-labelledby={`print-jobs-${group}`} className="space-y-2">
      <SectionHeader
        id={`print-jobs-${group}`}
        title={t(jobsWords[group])}
        count={jobs.length}
        action={
          !open && jobs.length > FIRST ? (
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              {t(jobsWords.showAll, { n: formatFigure(jobs.length, lang) })}
            </Button>
          ) : undefined
        }
      />
      <ul className="space-y-2">
        {rows.map((job) => (
          <li key={job.id}>
            <ListRow
              to={`/jobs/${encodeURIComponent(job.id)}`}
              leading={<Icon className="h-4 w-4" />}
              title={job.title.trim() || t(print.untitled)}
              meta={[modelName(job.printer_model_id), t(print.updated, { when: formatRelative(job.updated_at, lang) })].filter(Boolean).join(' · ')}
              trailing={<StatusPill kind="job" state={jobPillState(job.status)} />}
            />
          </li>
        ))}
      </ul>
      {open ? <MoreRow hasMore={hasMore} onMore={more} total={jobs.length} /> : null}
    </section>
  );
}

export default function Jobs() {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const q = useCloudQuery((signal) => listJobs({ signal }), [cloud.dashboardVersion]);
  const printers = usePrinterModels();
  const data: JobGroups | undefined = q.data;
  const moving = !!data && (data.current.length > 0 || data.queued.length > 0 || data.in_preparation.some((j) => j.status === 'analyzing'));
  usePoll(q.reload, moving, POLL_MS);
  const total = data ? GROUPS.reduce((s, g) => s + data[g].length, 0) : 0;
  const modelName = (id: string) => {
    const m = printers.byId.get(id);
    return m ? printerName(m) : null;
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title={t(print.myPrints)}
        subtitle={t(jobsWords.subtitle)}
        back={{ to: '/print', label: t(nav.print) }}
        actions={
          <Link to="/print" className="lv-button lv-button-primary lv-button-sm">
            {t(jobsWords.start)}
          </Link>
        }
      />
      {q.error && !data ? (
        <CloudErrorState error={q.error} onRetry={q.reload} />
      ) : !data ? (
        <CloudPageSkeleton />
      ) : total === 0 ? (
        <CloudEmptyState
          icon={<Printer className="h-6 w-6" />}
          title={t(jobsWords.none)}
          body={t(jobsWords.noneBody)}
          action={
            <Link to="/print" className="lv-button lv-button-primary">
              {t(jobsWords.start)}
            </Link>
          }
        />
      ) : (
        <>
          <RefreshNote error={q.error} onRetry={q.reload} />
          {GROUPS.filter((g) => data[g].length > 0).map((g) => (
            <GroupList key={g} group={g} jobs={data[g]} modelName={modelName} />
          ))}
          {total >= SERVER_CAP ? <p className="text-center text-[12px] text-text-muted">{t(print.capNote, { n: formatFigure(SERVER_CAP, lang) })}</p> : null}
        </>
      )}
    </div>
  );
}
