/**
 * JOBS, THE QUEUE AND FAILURES — the workshop floor.
 *
 *   Jobs      `GET /jobs` (status filter; the server returns the 500 most
 *             urgent — priority, then newest — and this screen pages them)
 *             and one job's whole record (`GET /jobs/{id}`): its timeline,
 *             its estimate WITH ITS SOURCE (measured by the slicer, or
 *             entered by an operator — never invented: no estimate is
 *             «awaiting an estimate»), its reservations, its printer and the
 *             printer's reading (stale shown as stale), and every action the
 *             job's state allows (jobRules.ts mirrors the server's state
 *             machine; a destructive one is asked twice).
 *   Queue     `GET /queue` — positions and SIMULATED start/end times, labelled
 *             as estimates — and `POST /queue/run`, which shows what the
 *             scheduler did: jobs assigned, stranded jobs released, releases
 *             deferred for room, and whether to run it again.
 *   Failures  `GET /failures` and the decision (`POST /failures/{id}/resolve`)
 *             under the configured policy; stating billable amounts by hand
 *             («manual review») is a money act.
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { ListOrdered, Play } from 'lucide-react';
import { StatusChip } from '../../ui/Badge';
import { usePcAccess } from '../access';
import { pc, type FailureRow, type JobRow, type QueueEstimate, type SchedulerRun } from '../api';
import { JOB_STATUS, QUEUE_BASIS, FAILURE_STATUS, RESPONSIBLE, labelOf, tri, type Tri } from '../i18n';
import { arrow, duration, formatDateTime, num } from '../format';
import { pcRefusal } from '../refusal';
import { Act, Chips, Empty, Id, LoadState, Note, Pager, type PcColumn, PcList, RefreshButton, SectionHead, T, useLoad, usePaged, usePcLang, W } from '../ui';
import type { SectionProps } from '../AdminPrintCloud';

const JobSheet = lazy(() => import('./jobs/JobSheet'));
const ResolveFailureSheet = lazy(() => import('./jobs/ResolveFailureSheet'));

const S = {
  title: tri('المهام والطابور', 'Jobs and queue', 'کار و ڕیز'),
  desc: tri(
    'كل مهمة طباعة بحالتها، وما يسمح به الخادم لكل حالة فقط.',
    'Every print job in its state, with only what the server allows in that state.',
    'هەر کارێکی چاپ بە دۆخی خۆی، تەنها لەگەڵ ئەوەی ڕاژەکار بۆ ئەو دۆخە ڕێگەی پێدەدات.'
  ),
  view: tri('العرض', 'View', 'پیشاندان'),
  jobs: tri('المهام', 'Jobs', 'کارەکان'),
  queue: tri('الطابور', 'Queue', 'ڕیز'),
  failures: tri('الأعطال', 'Failures', 'شکستەکان'),
  status: tri('الحالة', 'State', 'دۆخ'),
  all: tri('الكل', 'All', 'هەموو'),
  title_: tri('العنوان', 'Title', 'ناونیشان'),
  priority: tri('الأولوية', 'Priority', 'پێشینەیی'),
  created: tri('أُنشئت', 'Created', 'دروستکرا'),
  printer: tri('الطابعة', 'Printer', 'چاپکەر'),
  cap: tri('أحدث 500 مهمة حسب الأولوية ثم الأحدث.', 'The 500 most urgent jobs: by priority, then newest.', '500 کاری بەپەلەترین: بەپێی پێشینەیی، پاشان نوێترین.'),
  noJobs: tri('لا مهام في هذه الحالة.', 'No jobs in this state.', 'هیچ کارێک لەم دۆخەدا نییە.'),
  needsApproval: tri('تحتاج موافقة', 'Needs approval', 'پێویستی بە پەسەندکردنە'),
  queueDesc: tri(
    'الترتيب: الأولوية ثم وقت الدخول. الأوقات تقديرات بالمحاكاة من المدد الحقيقية — ليست وعداً.',
    'Order: priority, then time of entry. The times are simulated estimates from real durations — never a promise.',
    'ڕیزبەندی: پێشینەیی، پاشان کاتی چوونەژوورەوە. کاتەکان خەمڵاندنی لاسایین لە ماوە ڕاستەقینەکانەوە — هەرگیز بەڵێن نین.'
  ),
  position: tri('الموقع', 'Position', 'شوێن'),
  startEst: tri('بدء تقديري', 'Estimated start', 'دەستپێکی خەمڵێندراو'),
  endEst: tri('انتهاء تقديري', 'Estimated end', 'کۆتایی خەمڵێندراو'),
  basis: tri('الأساس', 'Basis', 'بنەما'),
  emptyQueue: tri('الطابور فارغ.', 'The queue is empty.', 'ڕیزەکە بەتاڵە.'),
  run: tri('تشغيل الجدولة الآن', 'Run the scheduler now', 'ئێستا خشتەکردن کار پێبکە'),
  ranTitle: tri('ما فعلته الجدولة', 'What the scheduler did', 'ئەوەی خشتەکردن کردی'),
  assigned: tri('أُسندت إلى طابعات', 'Put on printers', 'خرانە سەر چاپکەرەکان'),
  released: tri('أُلغيت لأن مهمتها السابقة لن تكتمل (أُعيدت حجوزاتها)', 'Cancelled because their earlier job cannot complete (reservations returned)', 'هەڵوەشێنرانەوە چونکە کارە پێشووەکەیان تەواو نابێت (گلدانەوەکانیان گەڕێنرانەوە)'),
  waiting: tri('ما زالت تنتظر', 'Still waiting', 'هێشتا چاوەڕێن'),
  deferred: tri('أُجّل تحريرها لضيق المساحة', 'Releases deferred for room', 'ئازادکردنەکان دواخران بۆ نەبوونی شوێن'),
  more: tri('بقي عمل: شغّل الجدولة مرة أخرى.', 'Work remains: run the scheduler again.', 'کار ماوە: دووبارە خشتەکردن کار پێبکە.'),
  nothingDone: tri('لم يتغيّر شيء: لا طابعة متوافقة وجاهزة لما ينتظر.', 'Nothing changed: no compatible, ready printer for what waits.', 'هیچ نەگۆڕا: هیچ چاپکەرێکی گونجاو و ئامادە نییە بۆ ئەوەی چاوەڕێیە.'),
  failuresDesc: tri(
    'عطل مبلَّغ عنه ينتظر قراراً: من يتحمله، وهل تُعاد الطباعة. السياسة في الإعدادات تقرر ما يُحتسب.',
    'A reported failure waits for a decision: who is responsible, and whether to reprint. The policy in Settings decides what is charged.',
    'شکستێکی ڕاگەیەندراو چاوەڕێی بڕیارە: کێ بەرپرسە، و ئایا دووبارە چاپ بکرێتەوە. سیاسەتی ناو ڕێکخستنەکان بڕیار دەدات چی حیساب دەکرێت.'
  ),
  open: tri('المفتوحة', 'Open', 'کراوە'),
  resolved: tri('المحسومة', 'Resolved', 'یەکلاکراوە'),
  noFailures: tri('لا أعطال هنا.', 'No failures here.', 'هیچ شکستێک لێرە نییە.'),
  reason: tri('السبب', 'Reason', 'هۆکار'),
  responsible: tri('المسؤول', 'Responsible', 'بەرپرس'),
  printed: tri('طُبع', 'Printed', 'چاپکرا'),
  decide: tri('اتخاذ القرار', 'Decide', 'بڕیاردان'),
  reprint: tri('إعادة الطباعة', 'Reprint', 'دووبارە چاپکردنەوە'),
} satisfies Record<string, Tri>;

type Tab = 'jobs' | 'queue' | 'failures';

export default function JobsSection({ params, go }: SectionProps) {
  const { t } = usePcLang();
  const [tab, setTab] = useState<Tab>(params.tab === 'failures' ? 'failures' : params.tab === 'queue' ? 'queue' : 'jobs');
  const [openJob, setOpenJob] = useState<string | null>(params.job ?? null);
  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} />
      <Chips<Tab>
        label={t(S.view)}
        value={tab}
        onChange={setTab}
        items={[
          { id: 'jobs', label: t(S.jobs) },
          { id: 'queue', label: t(S.queue) },
          { id: 'failures', label: t(S.failures) },
        ]}
      />
      {tab === 'jobs' && <JobsPanel initialStatus={params.status ?? ''} onOpen={setOpenJob} />}
      {tab === 'queue' && <QueuePanel onOpen={setOpenJob} />}
      {tab === 'failures' && <FailuresPanel onOpen={setOpenJob} />}
      {openJob && (
        <Suspense fallback={null}>
          <JobSheet key={openJob} jobId={openJob} onClose={() => setOpenJob(null)} go={go} />
        </Suspense>
      )}
    </div>
  );
}

const STATUS_ORDER = ['confirmed', 'queued', 'preparing', 'printing', 'paused', 'analyzing', 'failed', 'awaiting_confirmation', 'ready', 'uploaded', 'draft', 'completed', 'cancelled', 'reprint_requested'];

const statusTone = (s: string) =>
  s === 'printing' || s === 'completed' ? 'success' : s === 'failed' ? 'danger' : s === 'confirmed' || s === 'paused' || s === 'analyzing' ? 'warning' : s === 'queued' || s === 'preparing' ? 'info' : 'neutral';

function JobsPanel({ initialStatus, onOpen }: { initialStatus: string; onOpen: (id: string) => void }) {
  const { t, lang } = usePcLang();
  const [status, setStatus] = useState(initialStatus);
  const jobs = useLoad(() => pc.get<JobRow[]>(`/jobs${status ? `?status=${encodeURIComponent(status)}` : ''}`), [status]);
  const paged = usePaged(jobs.data, 50);
  const columns: PcColumn<JobRow>[] = [
    {
      id: 'title',
      header: t(S.title_),
      card: 'title',
      cell: (j) => (
        <button type="button" className="text-start font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm" onClick={() => onOpen(j.id)}>
          {j.title || j.id}
        </button>
      ),
    },
    { id: 'status', header: t(S.status), card: 'badge', cell: (j) => <StatusChip tone={statusTone(j.status)}>{labelOf(JOB_STATUS, j.status, lang)}</StatusChip> },
    { id: 'priority', header: t(S.priority), numeric: true, cell: (j) => num(j.priority) },
    { id: 'printer', header: t(S.printer), cell: (j) => <Id value={j.assigned_printer_id} /> },
    { id: 'user', header: t(W.user), cell: (j) => <Id value={j.user_id} /> },
    { id: 'created', header: t(S.created), card: 'meta', cell: (j) => formatDateTime(j.created_at, lang) },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Chips<string>
          label={t(S.status)}
          value={status}
          onChange={setStatus}
          items={[{ id: '', label: t(S.all) }, ...STATUS_ORDER.map((s) => ({ id: s, label: labelOf(JOB_STATUS, s, lang) }))]}
        />
        <RefreshButton onClick={() => jobs.reload()} loading={jobs.loading} />
      </div>
      <p className={`text-[11.5px] ${T.text3}`}>{t(S.cap)}</p>
      <PcList<JobRow>
        label={t(S.jobs)}
        columns={columns}
        rows={paged.slice}
        rowKey={(j) => j.id}
        loading={jobs.loading}
        error={jobs.error}
        onRetry={() => void jobs.reload()}
        empty={{ title: t(S.noJobs) }}
        rowLabel={(j) => j.title || j.id}
        rowActions={(j) => [{ id: 'open', label: t(W.open), onSelect: () => onOpen(j.id) }]}
      />
      <Pager page={paged.page} total={paged.total} onPage={paged.setPage} />
    </div>
  );
}

function QueuePanel({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, lang } = usePcLang();
  const queue = useLoad(() => pc.get<QueueEstimate[]>('/queue'), []);
  const [ran, setRan] = useState<SchedulerRun | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async () => {
    setFailure(null);
    try {
      setRan(await pc.post<SchedulerRun>('/queue/run'));
      void queue.reload();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };
  return (
    <div className="space-y-3">
      <SectionHead
        level={3}
        title={t(S.queue)}
        description={t(S.queueDesc)}
        actions={
          <>
            <RefreshButton onClick={() => queue.reload()} loading={queue.loading} />
            <Act kind="primary" icon={<Play size={14} aria-hidden />} onClick={run}>
              {t(S.run)}
            </Act>
          </>
        }
      />
      {failure && <Note tone="danger">{failure}</Note>}
      {ran && (
        <section className={`${T.surface} space-y-2 p-4 text-[13px]`} aria-live="polite">
          <h4 className={`font-bold ${T.text1}`}>{t(S.ranTitle)}</h4>
          {ran.assigned.length + ran.released.length === 0 && <p className={T.text3}>{t(S.nothingDone)}</p>}
          {ran.assigned.length > 0 && (
            <div>
              <p className={T.text2}>
                {t(S.assigned)}: {num(ran.assigned.length)}
              </p>
              <ul className="mt-1 space-y-0.5">
                {ran.assigned.map((a) => (
                  <li key={a.job_id}>
                    <button type="button" className={T.btnGhostSm} onClick={() => onOpen(a.job_id)}>
                      <Id value={a.job_id} />
                    </button>{' '}
                    {arrow(lang)} <Id value={a.printer_id} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ran.released.length > 0 && (
            <p className={T.text2}>
              {t(S.released)}: {ran.released.map((id) => <Id key={id} value={id} />)}
            </p>
          )}
          <p className={T.text2}>
            {t(S.waiting)}: {num(ran.waiting)}
          </p>
          {ran.deferred.length > 0 && (
            <p className={T.text2}>
              {t(S.deferred)}: {ran.deferred.map((id) => <Id key={id} value={id} />)}
            </p>
          )}
          {ran.more && <Note tone="warning">{t(S.more)}</Note>}
        </section>
      )}
      <LoadState state={queue}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty title={t(S.emptyQueue)} icon={<ListOrdered size={22} aria-hidden />} />
          ) : (
            <ol className="space-y-2">
              {rows.map((q) => (
                <li key={q.job_id} className={`${T.surface} flex flex-wrap items-center justify-between gap-2 p-3 text-[12.5px]`}>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`tabular-nums text-[15px] font-bold ${T.text1}`}>#{q.position}</span>
                    <button type="button" className={T.btnGhostSm} onClick={() => onOpen(q.job_id)}>
                      <Id value={q.job_id} />
                    </button>
                  </div>
                  <div className={`flex flex-wrap items-center gap-2 ${T.text2}`}>
                    <StatusChip tone={q.basis === 'simulated' ? 'info' : q.basis === 'dependency_cannot_complete' ? 'danger' : 'warning'}>{labelOf(QUEUE_BASIS, q.basis, lang)}</StatusChip>
                    {q.estimated_start_at && (
                      <span>
                        {t(S.startEst)}: {formatDateTime(q.estimated_start_at, lang)}
                      </span>
                    )}
                    {q.estimated_end_at && (
                      <span>
                        {t(S.endEst)}: {formatDateTime(q.estimated_end_at, lang)}
                      </span>
                    )}
                    {q.printer_id && <Id value={q.printer_id} />}
                  </div>
                </li>
              ))}
            </ol>
          )
        }
      </LoadState>
    </div>
  );
}

function FailuresPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const [status, setStatus] = useState<'reported' | 'resolved'>('reported');
  const failures = useLoad(() => pc.get<FailureRow[]>(`/failures?status=${status}`), [status]);
  const [deciding, setDeciding] = useState<FailureRow | null>(null);
  const columns: PcColumn<FailureRow>[] = useMemo(
    () => [
      {
        id: 'job',
        header: t(S.jobs),
        card: 'title',
        cell: (f) => (
          <button type="button" className="text-start font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm" onClick={() => onOpen(f.job_id)}>
            {f.title || f.job_id}
          </button>
        ),
      },
      { id: 'status', header: t(S.status), card: 'badge', cell: (f) => <StatusChip tone={f.status === 'reported' ? 'warning' : 'success'}>{labelOf(FAILURE_STATUS, f.status, lang)}</StatusChip> },
      { id: 'reason', header: t(S.reason), cell: (f) => <bdi dir="ltr" className="font-mono text-[12px]">{f.reason_code}</bdi> },
      { id: 'responsible', header: t(S.responsible), cell: (f) => labelOf(RESPONSIBLE, f.responsible, lang) },
      { id: 'printed', header: t(S.printed), numeric: true, cell: (f) => duration(f.printed_seconds, lang) },
      { id: 'reprint', header: t(S.reprint), cell: (f) => (f.reprint_job_id ? <Id value={f.reprint_job_id} /> : '—') },
      { id: 'created', header: t(S.created), card: 'meta', cell: (f) => formatDateTime(f.created_at, lang) },
    ],
    [t, lang, onOpen]
  );
  return (
    <div className="space-y-3">
      <SectionHead level={3} title={t(S.failures)} description={t(S.failuresDesc)} actions={<RefreshButton onClick={() => failures.reload()} loading={failures.loading} />} />
      <Chips<'reported' | 'resolved'>
        label={t(S.status)}
        value={status}
        onChange={setStatus}
        items={[
          { id: 'reported', label: t(S.open) },
          { id: 'resolved', label: t(S.resolved) },
        ]}
      />
      <PcList<FailureRow>
        label={t(S.failures)}
        columns={columns}
        rows={failures.data}
        rowKey={(f) => f.id}
        loading={failures.loading}
        error={failures.error}
        onRetry={() => void failures.reload()}
        empty={{ title: t(S.noFailures) }}
        rowLabel={(f) => f.title || f.job_id}
        rowActions={(f) => [
          { id: 'open', label: t(W.open), onSelect: () => onOpen(f.job_id) },
          ...(f.status === 'reported' ? [{ id: 'decide', label: t(S.decide), onSelect: () => setDeciding(f) }] : []),
        ]}
      />
      {deciding && (
        <Suspense fallback={null}>
          <ResolveFailureSheet key={deciding.id} failure={deciding} money={access.money} onClose={() => setDeciding(null)} onDone={() => void failures.reload()} />
        </Suspense>
      )}
    </div>
  );
}
