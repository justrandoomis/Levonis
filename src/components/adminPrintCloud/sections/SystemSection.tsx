/**
 * RECONCILIATION, BACKGROUND TASKS AND THE AUDIT TRAIL.
 *
 *   Reconcile  money scope (`GET /reconcile`): every check of the books —
 *              balances against their ledgers, lots against balances, the
 *              shelf against what customers own, one payment per fulfilled
 *              order… It REPORTS; it never fixes. A failing check lists the
 *              rows the server found, as evidence.
 *   Tasks      every admin (`GET /tasks`, `POST /tasks/run`): the background
 *              work by kind and state, the latest failures, and a by-hand run
 *              of what is due (a scheduling pass first) — showing what ran.
 *   Audit      money scope (`GET /audit`): every Print Cloud act, newest
 *              first; filter by the exact record it touched.
 */
import { useState } from 'react';
import { ClipboardList, Play, ShieldCheck } from 'lucide-react';
import { StatusChip } from '../../ui/Badge';
import { usePcAccess } from '../access';
import { pc, query, type AuditRow, type ReconcileAnswer, type TaskOverview, type TaskRun } from '../api';
import { RECONCILE_CHECK, TASK_KIND, TASK_STATUS, labelOf, tri, type Tri } from '../i18n';
import { formatDateTime, num } from '../format';
import { pcRefusal } from '../refusal';
import { Act, Chips, Empty, Id, Json, LoadState, Note, Pager, RefreshButton, SectionHead, SelectField, T, TextField, Tray, W, useLoad, usePaged, usePcLang } from '../ui';
import type { SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('المطابقة والمهام والتدقيق', 'Reconciliation, tasks and audit', 'هاوتاکردن و ئەرک و وردبینی'),
  desc: tri(
    'فحوص الدفاتر، والعمل الخلفي، وسجل كل إجراء في الطباعة السحابية.',
    'Checks of the books, the background work, and the record of every Print Cloud act.',
    'پشکنینی تۆمارەکان، کاری پشتەوە، و تۆماری هەموو کردارێکی چاپی هەوری.'
  ),
  view: tri('العرض', 'View', 'پیشاندان'),
  reconcile: tri('المطابقة', 'Reconciliation', 'هاوتاکردن'),
  tasks: tri('المهام الخلفية', 'Background tasks', 'ئەرکەکانی پشتەوە'),
  audit: tri('سجل التدقيق', 'Audit trail', 'تۆماری وردبینی'),
  // reconcile
  reconcileDesc: tri(
    'يفحص ولا يصلح: كل خلل يُعرض كما وجده الخادم ليُعالَج بقيد معوِّض.',
    'It checks and never fixes: every mismatch is shown as the server found it, to be corrected with a compensating entry.',
    'دەپشکنێت و هەرگیز چاک ناکات: هەر ناهاوتاییەک وەک ڕاژەکار دۆزییەوە پیشان دەدرێت، بۆ ئەوەی بە تۆمارێکی قەرەبووکەرەوە چاک بکرێت.'
  ),
  allOk: tri('كل الفحوص سليمة.', 'Every check passes.', 'هەموو پشکنینەکان سەرکەوتوون.'),
  someBad: tri('فحوص فيها خلل', 'Checks with mismatches', 'ئەو پشکنینانەی ناهاوتاییان تێدایە'),
  ok: tri('سليم', 'OK', 'باشە'),
  issues: tri('خلل', 'mismatches', 'ناهاوتایی'),
  evidence: tri('ما وجده الخادم (حتى 50 سطراً)', 'What the server found (up to 50 rows)', 'ئەوەی ڕاژەکار دۆزییەوە (تا 50 دێڕ)'),
  // tasks
  tasksDesc: tri(
    'العمل الذي يجري في الخلفية كل ربع ساعة: الجدولة، وإنهاء الطلبات غير المدفوعة، والمطابقة اليومية…',
    'The work that runs in the background every quarter hour: scheduling, expiring unpaid orders, the daily reconciliation…',
    'ئەو کارانەی هەر چارەکە کاتژمێرێک لە پشتەوە دەکرێن: خشتەکردن، بەسەربردنی داواکارییە پارە نەدراوەکان، هاوتاکردنی ڕۆژانە…'
  ),
  noTasks: tri('لم تُسجَّل مهام خلفية بعد.', 'No background task has been recorded yet.', 'هێشتا هیچ ئەرکێکی پشتەوە تۆمار نەکراوە.'),
  runLimit: tri('عدد المهام في هذا التشغيل', 'Tasks in this run', 'ژمارەی ئەرکەکان لەم کارپێکردنەدا'),
  run: tri('تشغيل المستحق الآن', 'Run what is due now', 'ئێستا ئەوەی کاتی هاتووە کار پێبکە'),
  ran: tri('ما جرى', 'What ran', 'ئەوەی کرا'),
  ranCount: tri('شُغّلت', 'Ran', 'کرا'),
  succeeded: tri('نجحت', 'Succeeded', 'سەرکەوتوو بوو'),
  failedCount: tri('فشلت وستُعاد', 'Failed, will retry', 'سەرنەکەوت، دووبارە دەکرێتەوە'),
  dead: tri('توقفت نهائياً', 'Gave up', 'بە تەواوی وەستا'),
  nothingDue: tri('لا شيء مستحق الآن.', 'Nothing is due now.', 'ئێستا هیچ شتێک کاتی نەهاتووە.'),
  recentFailures: tri('آخر الإخفاقات', 'Latest failures', 'دوایین سەرنەکەوتنەکان'),
  noFailures: tri('لا إخفاقات مسجّلة.', 'No failures recorded.', 'هیچ سەرنەکەوتنێک تۆمار نەکراوە.'),
  attempts: tri('المحاولات', 'Attempts', 'هەوڵەکان'),
  // audit
  auditDesc: tri('كل إجراء في الطباعة السحابية، الأحدث أولاً (حتى 500).', 'Every Print Cloud act, newest first (up to 500).', 'هەموو کردارێکی چاپی هەوری، نوێترین سەرەتا (تا 500).'),
  target: tri('معرّف السجل المتأثر (مطابقة تامة)', 'Id of the record touched (exact match)', 'ناسنامەی ئەو تۆمارەی دەستی لێدراوە (ڕێک وەک خۆی)'),
  filter: tri('تصفية', 'Filter', 'پاڵاوتن'),
  clear: tri('مسح', 'Clear', 'سڕینەوە'),
  noAudit: tri('لا إجراءات مسجّلة.', 'No acts recorded.', 'هیچ کردارێک تۆمار نەکراوە.'),
  actor: tri('المنفّذ', 'Actor', 'ئەنجامدەر'),
  showDetail: tri('التفاصيل', 'Details', 'وردەکاری'),
  hideDetail: tri('إخفاء', 'Hide', 'شاردنەوە'),
} satisfies Record<string, Tri>;

type Tab = 'reconcile' | 'tasks' | 'audit';

/** An audit row's detail as JSON when it is JSON, else as the text it is. */
function detailOf(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export default function SystemSection({ params }: SectionProps) {
  const { t } = usePcLang();
  const access = usePcAccess();
  const tabs: Array<{ id: Tab; label: string }> = [
    ...(access.money ? [{ id: 'reconcile' as Tab, label: t(S.reconcile) }] : []),
    { id: 'tasks', label: t(S.tasks) },
    ...(access.money ? [{ id: 'audit' as Tab, label: t(S.audit) }] : []),
  ];
  const wanted = (params.tab as Tab | undefined) ?? (access.money ? 'reconcile' : 'tasks');
  const [tab, setTab] = useState<Tab>(wanted);
  const shown: Tab = tabs.some((x) => x.id === tab) ? tab : 'tasks';
  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} />
      {tabs.length > 1 && <Chips<Tab> label={t(S.view)} value={shown} onChange={setTab} items={tabs} />}
      {shown === 'reconcile' && access.money && <Reconcile />}
      {shown === 'tasks' && <Tasks />}
      {shown === 'audit' && access.money && <Audit initialTarget={params.target ?? ''} />}
    </div>
  );
}

function Reconcile() {
  const { t, lang } = usePcLang();
  const answer = useLoad(() => pc.get<ReconcileAnswer>('/reconcile'), []);
  return (
    <div className="space-y-3">
      <SectionHead level={3} title={t(S.reconcile)} description={t(S.reconcileDesc)} actions={<RefreshButton onClick={() => answer.reload()} loading={answer.loading} />} />
      <LoadState state={answer}>
        {(r) => {
          const bad = r.checks.filter((c) => !c.ok);
          return (
            <div className="space-y-3">
              {r.ok ? (
                <Note tone="success">{t(S.allOk)}</Note>
              ) : (
                <Note tone="danger">
                  {t(S.someBad)}: {num(bad.length)}
                </Note>
              )}
              <ul className="space-y-2">
                {[...bad, ...r.checks.filter((c) => c.ok)].map((c) => (
                  <li key={c.name} className={`${T.surface} space-y-2 p-3 text-[12.5px]`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`font-semibold ${T.text1}`}>{labelOf(RECONCILE_CHECK, c.name, lang)}</span>
                      {c.ok ? (
                        <StatusChip tone="success">{t(S.ok)}</StatusChip>
                      ) : (
                        <StatusChip tone="danger">
                          {num(c.issues.length)} {t(S.issues)}
                        </StatusChip>
                      )}
                    </div>
                    {!c.ok && (
                      <div className="space-y-1">
                        <p className={`text-[11.5px] ${T.text3}`}>{t(S.evidence)}</p>
                        <Json value={c.issues} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </LoadState>
    </div>
  );
}

function Tasks() {
  const { t, lang } = usePcLang();
  const overview = useLoad(() => pc.get<TaskOverview>('/tasks'), []);
  const [limit, setLimit] = useState('10');
  const [ran, setRan] = useState<TaskRun | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async () => {
    setFailure(null);
    try {
      setRan(await pc.post<TaskRun>(`/tasks/run${query({ limit })}`));
      await overview.reload();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };
  return (
    <div className="space-y-3">
      <SectionHead level={3} title={t(S.tasks)} description={t(S.tasksDesc)} actions={<RefreshButton onClick={() => overview.reload()} loading={overview.loading} />} />
      <section className={`${T.surface} space-y-3 p-4`}>
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            className="w-44"
            label={t(S.runLimit)}
            value={limit}
            options={['5', '10', '25'].map((n) => ({ value: n, label: n }))}
            onChange={setLimit}
          />
          <Act kind="primary" icon={<Play size={14} aria-hidden />} onClick={run}>
            {t(S.run)}
          </Act>
        </div>
        {failure && <Note tone="danger">{failure}</Note>}
        {ran && (
          <div aria-live="polite" className="space-y-1 text-[12.5px]">
            <p className={`font-semibold ${T.text1}`}>{t(S.ran)}</p>
            {ran.ran === 0 ? (
              <p className={T.text3}>{t(S.nothingDue)}</p>
            ) : (
              <p className={T.text2}>
                {t(S.ranCount)}: {num(ran.ran)} · {t(S.succeeded)}: {num(ran.succeeded)} · {t(S.failedCount)}: {num(ran.failed)} · {t(S.dead)}: {num(ran.dead)}
              </p>
            )}
          </div>
        )}
      </section>
      <LoadState state={overview}>
        {(o) => {
          const kinds = [...new Set(o.counts.map((c) => c.kind))];
          return (
            <div className="space-y-4">
              {kinds.length === 0 ? (
                <Empty title={t(S.noTasks)} icon={<ClipboardList size={22} aria-hidden />} />
              ) : (
                <ul className="space-y-2">
                  {kinds.map((k) => (
                    <li key={k} className={`${T.surface} flex flex-wrap items-center justify-between gap-2 p-3 text-[12.5px]`}>
                      <span className={`font-semibold ${T.text1}`}>{labelOf(TASK_KIND, k, lang)}</span>
                      <span className="flex flex-wrap gap-1.5">
                        {o.counts
                          .filter((c) => c.kind === k)
                          .map((c) => (
                            <StatusChip key={c.status} tone={c.status === 'dead' ? 'danger' : c.status === 'failed' ? 'warning' : c.status === 'succeeded' ? 'success' : 'neutral'}>
                              {labelOf(TASK_STATUS, c.status, lang)} · {num(c.n)}
                            </StatusChip>
                          ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Tray title={t(S.recentFailures)}>
                {o.recent_failures.length === 0 ? (
                  <p className={`text-[12.5px] ${T.text3}`}>{t(S.noFailures)}</p>
                ) : (
                  <ul className="divide-y divide-[var(--ap-hairline)] text-[12.5px]">
                    {o.recent_failures.map((f) => (
                      <li key={f.id} className="space-y-1 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={`font-semibold ${T.text1}`}>{labelOf(TASK_KIND, f.kind, lang)}</span>
                          <span className="flex items-center gap-2">
                            <StatusChip tone={f.status === 'dead' ? 'danger' : 'warning'}>{labelOf(TASK_STATUS, f.status, lang)}</StatusChip>
                            <span className={T.text3}>{formatDateTime(f.updated_at, lang)}</span>
                          </span>
                        </div>
                        <p className={T.text3}>
                          {t(S.attempts)}: <bdi dir="ltr">{f.attempts}/{f.max_attempts}</bdi>
                        </p>
                        {f.last_error && (
                          <p dir="ltr" className={`break-all font-mono text-[11.5px] ${T.text2}`}>
                            {f.last_error}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Tray>
            </div>
          );
        }}
      </LoadState>
    </div>
  );
}

function Audit({ initialTarget }: { initialTarget: string }) {
  const { t, lang } = usePcLang();
  const [input, setInput] = useState(initialTarget);
  const [target, setTarget] = useState(initialTarget);
  const rows = useLoad(() => pc.get<AuditRow[]>(`/audit${query({ target, limit: 500 })}`), [target]);
  const paged = usePaged(rows.data, 50);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-3">
      <SectionHead level={3} title={t(S.audit)} description={t(S.auditDesc)} actions={<RefreshButton onClick={() => rows.reload()} loading={rows.loading} />} />
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTarget(input.trim());
        }}
      >
        <TextField className="min-w-[15rem] flex-1" label={t(S.target)} value={input} onChange={setInput} ltr maxLength={200} />
        <Act type="submit" kind="primary">
          {t(S.filter)}
        </Act>
        {target && (
          <Act
            kind="ghost"
            onClick={() => {
              setInput('');
              setTarget('');
            }}
          >
            {t(S.clear)}
          </Act>
        )}
      </form>
      <LoadState state={rows}>
        {() =>
          (paged.slice ?? []).length === 0 ? (
            <Empty title={t(S.noAudit)} icon={<ShieldCheck size={22} aria-hidden />} />
          ) : (
            <>
              <ul className="space-y-2">
                {(paged.slice ?? []).map((a) => (
                  <li key={a.id} className={`${T.surface} space-y-1.5 p-3 text-[12.5px]`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <bdi dir="ltr" className={`font-mono font-semibold ${T.text1}`}>
                        {a.action.replace(/^print_cloud\./, '')}
                      </bdi>
                      <span className={T.text3}>{formatDateTime(a.created_at, lang)}</span>
                    </div>
                    <p className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${T.text2}`}>
                      <span>
                        {t(W.id)}: <Id value={a.target} copy />
                      </span>
                      <span>
                        {t(S.actor)}: <Id value={a.actor_id} />
                      </span>
                    </p>
                    {a.detail && (
                      <>
                        <button type="button" className={T.btnGhostSm} aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                          {t(open === a.id ? S.hideDetail : S.showDetail)}
                        </button>
                        {open === a.id && <Json value={detailOf(a.detail)} />}
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <Pager page={paged.page} total={paged.total} onPage={paged.setPage} />
            </>
          )
        }
      </LoadState>
    </div>
  );
}
