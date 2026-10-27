/**
 * PRINTERS AND AGENTS — the machines as the server judges them, and the
 * workshop agents that drive them.
 *
 * HONEST CONNECTIVITY. `GET /printers` derives connectivity on the server
 * (printers.ts `printerStatuses`): a manual machine is «manual», an agent
 * machine never heard from is «never connected», one whose last reading is
 * older than `telemetry_stale_seconds` — or that its agent cannot reach — is
 * «offline». This screen prints exactly that. A STALE reading is labelled
 * stale with its age, its state is shown as the last one known, and its
 * remaining time is NOT shown: an ETA from a silent machine is a guess.
 *
 * MAINTENANCE windows (a machine in a planned window gets no work) are listed
 * per printer (`GET /printers/{id}/maintenance`), planned
 * (`POST /printers/{id}/maintenance`) and closed or cancelled
 * (`PATCH /maintenance/{id}`); their cost is the owner's. COMMANDS go to the
 * printer's agent (`POST /printers/{id}/commands`) — a manual machine has
 * none.
 *
 * AGENTS. A token is minted by a full admin (`POST /agents`, it controls
 * machines), shown ONCE — only its hash is stored — and revocable. Binding a
 * printer to an agent is the printer's own catalogue row (`agent_id`, and
 * `adapter: agent` so its readings decide whether it takes work).
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Cpu, KeyRound, Plus, Printer, Wrench } from 'lucide-react';
import { StatusChip } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { Checkbox } from '../../ui/Switch';
import { useConfirm } from '../../ui/ConfirmDialog';
import { toast } from '../../../lib/toastStore';
import { iqdUnit } from '../../../lib/money';
import { usePcAccess } from '../access';
import { pc, parseJsonColumn, type Agent, type MaintenanceWindow, type PrinterEvent, type PrinterStatus, type Row } from '../api';
import { AGENT_CAPABILITY, CONNECTIVITY, MACHINE_STATE, MAINTENANCE_KIND, MAINTENANCE_STATUS, PRINTER_COMMAND, PRINTER_STATUS, labelOf, tri, type Tri } from '../i18n';
import { ago, ageOf, duration, formatDateTime, fromLocalInput, num, permille, temp, toLocalInput } from '../format';
import { pcRefusal } from '../refusal';
import { invalidateRefs } from '../refs';
import { Act, Chips, Empty, Id, IntField, Json, KV, LoadState, Note, RefreshButton, SectionHead, SelectField, T, TextArea, TextField, Tray, W, useLoad, usePcLang } from '../ui';
import type { SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('الطابعات والوكلاء', 'Printers and agents', 'چاپکەر و بریکارەکان'),
  desc: tri(
    'كل آلة كما يحكم عليها الخادم: القراءة القديمة تُعرض قديمة، والطابعة الصامتة لا تُعرض متصلة أبداً.',
    'Every machine as the server judges it: a stale reading is shown as stale, and a silent printer is never shown online.',
    'هەر ئامێرێک وەک ڕاژەکار هەڵیدەسەنگێنێت: خوێندنەوەی کۆن بە کۆنی پیشان دەدرێت، و چاپکەری بێدەنگ هەرگیز پەیوەست پیشان نادرێت.'
  ),
  printers: tri('الطابعات', 'Printers', 'چاپکەرەکان'),
  agents: tri('وكلاء الورشة', 'Workshop agents', 'بریکارەکانی کارگە'),
  view: tri('العرض', 'View', 'پیشاندان'),
  noPrinters: tri('لا طابعات بعد — سجّل آلة من الكتالوج (تحتاج مديراً مالياً).', 'No printers yet — register a machine in the catalogue (needs a full admin).', 'هێشتا هیچ چاپکەرێک نییە — ئامێرێک لە کاتالۆگ تۆمار بکە (پێویستی بە بەڕێوەبەری داراییە).'),
  noReading: tri('لا قراءة بعد من هذه الطابعة.', 'No reading from this printer yet.', 'هێشتا هیچ خوێندنەوەیەک لەم چاپکەرەوە نییە.'),
  manualNoReading: tri('طابعة يدوية: يبدأ المشغّل مهامها وينهيها بنفسه.', 'A manual printer: the operator starts and finishes its jobs by hand.', 'چاپکەرێکی دەستی: کارپێکەر کارەکانی خۆی دەست پێدەکات و تەواو دەکات.'),
  stale: tri('قراءة قديمة', 'Stale reading', 'خوێندنەوەی کۆن'),
  live: tri('قراءة حيّة', 'Live reading', 'خوێندنەوەی ڕاستەوخۆ'),
  lastKnown: tri('آخر حالة معروفة', 'Last known state', 'دوایین دۆخی زانراو'),
  noEta: tri('لا وقت متبقٍّ يُعرض من قراءة قديمة.', 'No remaining time is shown from a stale reading.', 'لە خوێندنەوەی کۆنەوە هیچ کاتێکی ماوە پیشان نادرێت.'),
  progress: tri('التقدم', 'Progress', 'پێشکەوتن'),
  layer: tri('الطبقة', 'Layer', 'چین'),
  remaining: tri('المتبقي', 'Remaining', 'ماوە'),
  nozzle: tri('الفوهة', 'Nozzle', 'نۆزڵ'),
  bed: tri('السرير', 'Bed', 'تەختە'),
  errors: tri('أخطاء أبلغت عنها', 'Errors reported', 'هەڵە ڕاگەیەندراوەکان'),
  currentJob: tri('المهمة الحالية', 'Current job', 'کاری ئێستا'),
  openJob: tri('فتح المهمة', 'Open the job', 'کردنەوەی کار'),
  details: tri('السجل والصيانة والأوامر', 'Log, maintenance and commands', 'تۆمار و چاکسازی و فەرمانەکان'),
  model: tri('الطراز', 'Model', 'مۆدێل'),
  location: tri('الموقع', 'Location', 'شوێن'),
  materials: tri('المواد المحمّلة', 'Loadable materials', 'کەرەستە بارکراوەکان'),
  anyMaterial: tri('أي مادة يدعمها الطراز', 'Any material the model supports', 'هەر کەرەستەیەک مۆدێلەکە پشتگیری بکات'),
  operating: tri('ساعات التشغيل', 'Operating time', 'کاتی کارکردن'),
  events: tri('سجل الطابعة', 'Printer log', 'تۆماری چاپکەر'),
  noEvents: tri('لا أحداث بعد.', 'No events yet.', 'هێشتا هیچ ڕووداوێک نییە.'),
  maintenance: tri('نوافذ الصيانة', 'Maintenance windows', 'کاتەکانی چاکسازی'),
  maintenanceHelp: tri('طابعة في نافذة مخطَّطة — أو تبدأ قبل انتهاء المهمة — لا تأخذ عملاً.', 'A printer in a planned window — or one starting before a job would end — takes no work.', 'چاپکەرێک لە کاتێکی پلاندانراودا — یان کاتێک پێش تەواوبوونی کارەکە دەست پێبکات — هیچ کارێک وەرناگرێت.'),
  noWindows: tri('لا نوافذ صيانة.', 'No maintenance windows.', 'هیچ کاتێکی چاکسازی نییە.'),
  plan: tri('تخطيط نافذة صيانة', 'Plan a window', 'پلاندانانی کاتێک'),
  kind: tri('النوع', 'Kind', 'جۆر'),
  starts: tri('يبدأ', 'Starts', 'دەستپێدەکات'),
  ends: tri('ينتهي', 'Ends', 'کۆتایی دێت'),
  notes: tri('ملاحظات', 'Notes', 'تێبینی'),
  cost: tri('التكلفة', 'Cost', 'تێچوو'),
  planned: tri('خُطّطت النافذة.', 'Window planned.', 'کاتەکە پلاندانرا.'),
  markDone: tri('أُنجزت', 'Mark done', 'ئەنجامدرا'),
  cancelWindow: tri('إلغاء النافذة', 'Cancel the window', 'هەڵوەشاندنەوەی کاتەکە'),
  windowUpdated: tri('حُدّثت النافذة.', 'Window updated.', 'کاتەکە نوێکرایەوە.'),
  badWindow: tri('النهاية يجب أن تأتي بعد البداية.', 'The end must come after the start.', 'کۆتایی دەبێت دوای دەستپێک بێت.'),
  commands: tri('أمر للوكيل', 'A command for the agent', 'فەرمانێک بۆ بریکار'),
  commandHelp: tri('يُسجَّل الأمر ويقرؤه وكيل الطابعة في جولته التالية؛ هذا لا يعني أنه نُفّذ.', 'The command is recorded and the printer’s agent reads it on its next poll; that is not proof it was carried out.', 'فەرمانەکە تۆمار دەکرێت و بریکاری چاپکەر لە سووڕی داهاتوویدا دەیخوێنێتەوە؛ ئەمە بەڵگە نییە کە جێبەجێ کراوە.'),
  manualNoCommands: tri('طابعة يدوية: لا وكيل يستقبل الأوامر.', 'A manual printer: no agent receives commands.', 'چاپکەرێکی دەستی: هیچ بریکارێک فەرمان وەرناگرێت.'),
  command: tri('الأمر', 'Command', 'فەرمان'),
  jobId: tri('معرّف المهمة (اختياري)', 'Job id (optional)', 'ناسنامەی کار (ئارەزوومەندانە)'),
  send: tri('إرسال الأمر', 'Send the command', 'ناردنی فەرمان'),
  sent: tri('سُجّل الأمر للوكيل.', 'Command recorded for the agent.', 'فەرمانەکە بۆ بریکار تۆمارکرا.'),
  stopTitle: tri('إيقاف الطباعة نهائياً؟', 'Stop the print for good?', 'چاپەکە بە تەواوی ڕابگیرێت؟'),
  stopBody: tri('سيطلب الوكيل من الطابعة إيقاف ما تطبعه؛ لا يمكن استئناف الطباعة بعده.', 'The agent will tell the printer to stop what it prints; the print cannot be resumed after it.', 'بریکار بە چاپکەرەکە دەڵێت ئەوەی چاپی دەکات ڕایبگرێت؛ دوای ئەوە چاپەکە ناتوانرێت درێژە پێبدرێت.'),
  agentsDesc: tri('برنامج على شبكة الورشة يتحدث مع الطابعات والسلايسر؛ رمزه يُعرض مرة واحدة ويُخزَّن تجزئته فقط.', 'A program on the workshop network that talks to the printers and the slicer; its token is shown once and only its hash is stored.', 'بەرنامەیەک لەسەر تۆڕی کارگە کە لەگەڵ چاپکەر و سلایسەر قسە دەکات؛ تۆکنەکەی یەکجار پیشان دەدرێت و تەنها هاشەکەی هەڵدەگیرێت.'),
  newAgent: tri('وكيل جديد', 'New agent', 'بریکاری نوێ'),
  newAgentMoney: tri('إنشاء وكيل وإلغاؤه للمالك أو المدير المالي (يتحكم بآلات).', 'Creating and revoking agents is for the owner or a full admin (they control machines).', 'دروستکردن و هەڵوەشاندنەوەی بریکار بۆ خاوەن یان بەڕێوەبەری داراییە (ئامێرەکان کۆنترۆڵ دەکەن).'),
  noAgents: tri('لا وكلاء بعد: المهام تنتظر تقديراً يدوياً وتشغيلاً يدوياً.', 'No agents yet: jobs wait for a manual estimate and a manual start.', 'هێشتا هیچ بریکارێک نییە: کارەکان چاوەڕێی خەمڵاندن و دەستپێکردنی دەستی دەبن.'),
  name: tri('الاسم', 'Name', 'ناو'),
  capabilities: tri('القدرات', 'Capabilities', 'توانستەکان'),
  active: tri('نشط', 'Active', 'چالاک'),
  revoked: tri('ملغى', 'Revoked', 'هەڵوەشێنراوە'),
  lastSeen: tri('آخر اتصال', 'Last call', 'دوایین پەیوەندی'),
  never: tri('لم يتصل أبداً', 'Never called in', 'هەرگیز پەیوەندی نەکردووە'),
  bound: tri('الطابعات المرتبطة', 'Bound printers', 'چاپکەرە بەستراوەکان'),
  none: tri('لا شيء', 'None', 'هیچ'),
  revoke: tri('إلغاء الرمز', 'Revoke the token', 'هەڵوەشاندنەوەی تۆکن'),
  revokeTitle: tri('إلغاء رمز هذا الوكيل؟', 'Revoke this agent’s token?', 'تۆکنی ئەم بریکارە هەڵبوەشێنرێتەوە؟'),
  revokeBody: tri('يتوقف الوكيل فوراً عن الاتصال: لا قراءات ولا أوامر ولا تقطيع. لا يمكن التراجع؛ يلزم وكيل جديد.', 'The agent is cut off at once: no readings, no commands, no slicing. It cannot be undone; a new agent is needed.', 'بریکارەکە یەکسەر دەپچڕێت: نە خوێندنەوە، نە فەرمان، نە سلایس. ناگەڕێتەوە؛ بریکارێکی نوێ پێویستە.'),
  revokedDone: tri('أُلغي الرمز.', 'Token revoked.', 'تۆکنەکە هەڵوەشێنرایەوە.'),
  bindPrinters: tri('ربط الطابعات', 'Bind printers', 'بەستنەوەی چاپکەرەکان'),
  bindHelp: tri('الطابعة المرتبطة يقودها هذا الوكيل: تأخذ العمل بقراءاته فقط.', 'A bound printer is driven by this agent: it takes work only on its readings.', 'چاپکەری بەستراو ئەم بریکارە بەڕێوەی دەبات: تەنها بە خوێندنەوەکانی کار وەردەگرێت.'),
  bindDone: tri('حُدّث ربط الطابعات.', 'Printer binding updated.', 'بەستنەوەی چاپکەرەکان نوێکرایەوە.'),
  create: tri('إنشاء الوكيل', 'Create the agent', 'دروستکردنی بریکار'),
  tokenTitle: tri('رمز الوكيل — يُعرض مرة واحدة', 'The agent’s token — shown once', 'تۆکنی بریکار — یەکجار پیشان دەدرێت'),
  tokenWarning: tri(
    'انسخه الآن وضعه في إعدادات برنامج الوكيل. لا يمكن عرضه مجدداً: يُخزَّن تجزئته فقط. من يملكه يتحكم بالطابعات المرتبطة.',
    'Copy it now into the agent program’s settings. It cannot be shown again: only its hash is stored. Whoever holds it controls the bound printers.',
    'ئێستا لەبەری بگرەوە و بیخە ناو ڕێکخستنەکانی بەرنامەی بریکار. ناتوانرێت دووبارە پیشان بدرێتەوە: تەنها هاشەکەی هەڵدەگیرێت. هەر کەسێک هەیبێت چاپکەرە بەستراوەکان کۆنترۆڵ دەکات.'
  ),
  copyToken: tri('نسخ الرمز', 'Copy the token', 'لەبەرگرتنەوەی تۆکن'),
  copiedToken: tri('نُسخ الرمز.', 'Token copied.', 'تۆکنەکە لەبەرگیرایەوە.'),
  bindFailed: tri('تعذّر ربط', 'Could not bind', 'نەتوانرا ببەسترێتەوە'),
  savedToken: tri('نسختُ الرمز', 'I have copied the token', 'تۆکنەکەم لەبەرگرتەوە'),
  needName: tri('اكتب اسماً للوكيل.', 'Write a name for the agent.', 'ناوێک بۆ بریکارەکە بنووسە.'),
  needCap: tri('اختر قدرة واحدة على الأقل.', 'Choose at least one capability.', 'لانیکەم یەک توانست هەڵبژێرە.'),
} satisfies Record<string, Tri>;

type Tab = 'printers' | 'agents';

export default function PrintersSection({ go }: SectionProps) {
  const { t } = usePcLang();
  const [tab, setTab] = useState<Tab>('printers');
  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} />
      <Chips<Tab>
        label={t(S.view)}
        value={tab}
        onChange={setTab}
        items={[
          { id: 'printers', label: t(S.printers) },
          { id: 'agents', label: t(S.agents) },
        ]}
      />
      {tab === 'printers' ? <PrintersPanel go={go} /> : <AgentsPanel />}
    </div>
  );
}

const connectivityTone = (c: string) => (c === 'online' ? 'success' : c === 'offline' ? 'danger' : 'neutral');

function PrintersPanel({ go }: { go: SectionProps['go'] }) {
  const { t, lang } = usePcLang();
  const printers = useLoad(() => pc.get<PrinterStatus[]>('/printers'), []);
  const [open, setOpen] = useState<PrinterStatus | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <RefreshButton onClick={() => printers.reload()} loading={printers.loading} />
      </div>
      <LoadState state={printers}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t(S.noPrinters)} icon={<Printer size={22} aria-hidden />} />
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((p) => (
                <li key={p.id} className={`${T.surface} flex min-w-0 flex-col gap-2 p-4`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={`text-[14px] font-bold ${T.text1}`}>{p.name}</p>
                      <p className={`text-[11.5px] ${T.text3}`}>
                        <bdi dir="ltr" className="font-mono">{p.model_code}</bdi> {p.location && `· ${p.location}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <StatusChip tone={p.status === 'active' ? 'success' : p.status === 'maintenance' ? 'warning' : 'neutral'}>{labelOf(PRINTER_STATUS, p.status, lang)}</StatusChip>
                      <StatusChip tone={connectivityTone(p.connectivity)}>{labelOf(CONNECTIVITY, p.connectivity, lang)}</StatusChip>
                    </div>
                  </div>
                  <TelemetryBlock printer={p} />
                  {p.current_job_id && (
                    <p className={`text-[12.5px] ${T.text2}`}>
                      {t(S.currentJob)}:{' '}
                      <button type="button" className={T.btnGhostSm} onClick={() => go('jobs', { job: p.current_job_id as string })}>
                        <Id value={p.current_job_id} /> · {t(S.openJob)}
                      </button>
                    </p>
                  )}
                  <div className="mt-auto pt-1">
                    <Act icon={<Wrench size={14} aria-hidden />} onClick={() => setOpen(p)}>
                      {t(S.details)}
                    </Act>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </LoadState>
      {open && <PrinterSheet key={open.id} printer={open} onClose={() => setOpen(null)} onChanged={() => void printers.reload()} />}
    </div>
  );
}

/** A reading, honestly: live with its figures, stale with its age and no ETA, or none at all. */
function TelemetryBlock({ printer: p }: { printer: PrinterStatus }) {
  const { t, lang } = usePcLang();
  const tm = p.telemetry;
  if (!tm) return <p className={`text-[12.5px] ${T.text3}`}>{t(p.adapter === 'manual' ? S.manualNoReading : S.noReading)}</p>;
  const errors = Array.isArray(tm.errors) ? tm.errors : [];
  return (
    <div className="space-y-1 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={tm.stale ? 'warning' : 'info'}>{t(tm.stale ? S.stale : S.live)}</StatusChip>
        <span className={T.text3}>{ago(tm.age_seconds, lang)}</span>
      </div>
      <p className={tm.stale ? T.text3 : T.text1}>
        {tm.stale && `${t(S.lastKnown)}: `}
        {labelOf(MACHINE_STATE, tm.machine_state, lang)}
        {tm.progress_permille !== null && ` · ${t(S.progress)} ${permille(tm.progress_permille)}`}
        {tm.layer !== null && tm.total_layers !== null && ` · ${t(S.layer)} ${num(tm.layer)}/${num(tm.total_layers)}`}
      </p>
      {!tm.stale && tm.remaining_seconds !== null && (
        <p className={T.text2}>
          {t(S.remaining)}: {duration(tm.remaining_seconds, lang)}
        </p>
      )}
      {tm.stale && tm.remaining_seconds !== null && <p className={`text-[11.5px] ${T.text3}`}>{t(S.noEta)}</p>}
      {(tm.nozzle_temp_dc !== null || tm.bed_temp_dc !== null) && (
        <p className={T.text3}>
          {t(S.nozzle)} <bdi dir="ltr">{temp(tm.nozzle_temp_dc)}</bdi> · {t(S.bed)} <bdi dir="ltr">{temp(tm.bed_temp_dc)}</bdi>
        </p>
      )}
      {errors.length > 0 && (
        <p className="flex items-start gap-1.5 text-[12px] text-[var(--ap-danger)]">
          <AlertTriangle size={13} aria-hidden className="mt-[2px] shrink-0" />
          <span>
            {t(S.errors)}: <bdi dir="ltr">{errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join(' · ')}</bdi>
          </span>
        </p>
      )}
    </div>
  );
}

function PrinterSheet({ printer: p, onClose, onChanged }: { printer: PrinterStatus; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const events = useLoad(() => pc.get<PrinterEvent[]>(`/printers/${encodeURIComponent(p.id)}/events?limit=100`), [p.id]);
  const windows = useLoad(() => pc.get<MaintenanceWindow[]>(`/printers/${encodeURIComponent(p.id)}/maintenance`), [p.id]);
  const [confirm, confirmDialog] = useConfirm();
  const titleId = `pc-printer-${p.id}`;

  // ---- plan a window
  const [kind, setKind] = useState('scheduled');
  const [starts, setStarts] = useState(() => toLocalInput(new Date().toISOString()));
  const [ends, setEnds] = useState('');
  const [notes, setNotes] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const plan = async () => {
    setPlanError(null);
    const s = fromLocalInput(starts);
    const e = fromLocalInput(ends);
    if (!s || !e || e <= s) {
      setPlanError(t(S.badWindow));
      return;
    }
    try {
      await pc.post(`/printers/${encodeURIComponent(p.id)}/maintenance`, {
        kind,
        starts_at: s,
        ends_at: e,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(access.costWrite && cost !== null ? { cost_iqd: cost } : {}),
      });
      toast.success(t(S.planned));
      setNotes('');
      setEnds('');
      setCost(null);
      void windows.reload();
      onChanged();
    } catch (err) {
      setPlanError(pcRefusal(err, lang, t(W.failed)));
    }
  };
  const updateWindow = async (w: MaintenanceWindow, status: 'done' | 'cancelled') => {
    try {
      await pc.patch(`/maintenance/${encodeURIComponent(w.id)}`, { status });
      toast.success(t(S.windowUpdated));
      void windows.reload();
      onChanged();
    } catch (err) {
      toast.error(pcRefusal(err, lang, t(W.failed)));
    }
  };

  // ---- a command for the agent
  const [command, setCommand] = useState('pause');
  const [jobId, setJobId] = useState(p.current_job_id ?? '');
  const [commandError, setCommandError] = useState<string | null>(null);
  const send = async () => {
    setCommandError(null);
    if (command === 'stop' && !(await confirm({ title: t(S.stopTitle), consequence: t(S.stopBody), confirmLabel: t(S.send), destructive: true }))) return;
    try {
      await pc.post(`/printers/${encodeURIComponent(p.id)}/commands`, { command, ...(jobId.trim() ? { job_id: jobId.trim() } : {}) });
      toast.success(t(S.sent));
      void events.reload();
    } catch (err) {
      setCommandError(pcRefusal(err, lang, t(W.failed)));
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="ap w-full sm:max-w-2xl"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
            {p.name}
          </h2>
          <p className={`text-[11.5px] ${T.text3}`}>
            <bdi dir="ltr" className="font-mono">{p.id}</bdi>
          </p>
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-5">
        <KV
          rows={[
            [t(S.model), <bdi key="m" dir="ltr" className="font-mono">{p.model_code}</bdi>],
            [t(S.location), p.location || '—'],
            [t(S.nozzle), <bdi key="n" dir="ltr">{num(p.nozzle_um)} µm</bdi>],
            [t(S.materials), p.materials.length ? <bdi key="ma" dir="ltr">{p.materials.join(', ')}</bdi> : t(S.anyMaterial)],
            [t(S.operating), duration(p.operating_seconds, lang)],
          ]}
        />
        <TelemetryBlock printer={p} />

        <Tray title={t(S.maintenance)} description={t(S.maintenanceHelp)}>
          <LoadState state={windows}>
            {(list) =>
              list.length === 0 ? (
                <p className={`text-[12.5px] ${T.text3}`}>{t(S.noWindows)}</p>
              ) : (
                <ul className="space-y-2">
                  {list.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ap-border)] pb-2 text-[12.5px]">
                      <div className="min-w-0">
                        <p className={T.text1}>
                          {labelOf(MAINTENANCE_KIND, w.kind, lang)} · {formatDateTime(w.starts_at, lang)} → {formatDateTime(w.ends_at, lang)}
                        </p>
                        <p className={T.text3}>
                          {w.notes}
                          {access.costRead && typeof w.cost_iqd === 'number' && (
                            <>
                              {' '}
                              · {t(S.cost)} <Money iqd={w.cost_iqd} />
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusChip tone={w.status === 'planned' ? 'warning' : w.status === 'done' ? 'success' : 'neutral'}>{labelOf(MAINTENANCE_STATUS, w.status, lang)}</StatusChip>
                        {w.status === 'planned' && (
                          <>
                            <Act kind="secondary" onClick={() => updateWindow(w, 'done')}>
                              {t(S.markDone)}
                            </Act>
                            <Act kind="ghost" onClick={() => updateWindow(w, 'cancelled')}>
                              {t(S.cancelWindow)}
                            </Act>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )
            }
          </LoadState>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SelectField label={t(S.kind)} value={kind} options={Object.keys(MAINTENANCE_KIND).map((k) => ({ value: k, label: labelOf(MAINTENANCE_KIND, k, lang) }))} onChange={setKind} />
            <TextField type="datetime-local" label={t(S.starts)} value={starts} onChange={setStarts} ltr />
            <TextField type="datetime-local" label={t(S.ends)} value={ends} onChange={setEnds} ltr />
            {access.costWrite && <IntField label={t(S.cost)} unit={iqdUnit(lang)} value={cost} onChange={setCost} />}
            <TextArea className="sm:col-span-2" label={t(S.notes)} value={notes} onChange={setNotes} maxLength={500} rows={2} />
          </div>
          {planError && <p className="lv-field-error">{planError}</p>}
          <div className="mt-2">
            <Act kind="primary" icon={<Plus size={14} aria-hidden />} onClick={plan}>
              {t(S.plan)}
            </Act>
          </div>
        </Tray>

        <Tray title={t(S.commands)} description={p.adapter === 'agent' ? t(S.commandHelp) : undefined}>
          {p.adapter !== 'agent' ? (
            <p className={`text-[12.5px] ${T.text3}`}>{t(S.manualNoCommands)}</p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <SelectField label={t(S.command)} value={command} options={Object.keys(PRINTER_COMMAND).map((c) => ({ value: c, label: labelOf(PRINTER_COMMAND, c, lang) }))} onChange={setCommand} />
                <TextField label={t(S.jobId)} value={jobId} onChange={setJobId} ltr />
              </div>
              {commandError && <p className="lv-field-error">{commandError}</p>}
              <Act kind={command === 'stop' ? 'danger' : 'primary'} onClick={send}>
                {t(S.send)}
              </Act>
            </div>
          )}
        </Tray>

        <Tray title={t(S.events)}>
          <LoadState state={events}>
            {(list) =>
              list.length === 0 ? (
                <p className={`text-[12.5px] ${T.text3}`}>{t(S.noEvents)}</p>
              ) : (
                <ul className="space-y-2 text-[12.5px]">
                  {list.map((e) => (
                    <li key={e.id} className="border-b border-[var(--ap-border)] pb-2">
                      <p className={T.text1}>
                        <bdi dir="ltr" className="font-mono">{e.kind}</bdi> · {formatDateTime(e.created_at, lang)} · <span className={T.text3}>{e.actor_type}</span>
                      </p>
                      {e.detail_json && e.detail_json !== '{}' && <Json value={parseJsonColumn(e.detail_json, {})} />}
                    </li>
                  ))}
                </ul>
              )
            }
          </LoadState>
        </Tray>
      </div>
      {confirmDialog}
    </Sheet>
  );
}

// ------------------------------------------------------------------ agents

function AgentsPanel() {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const agents = useLoad(() => pc.get<Agent[]>('/agents'), []);
  const printers = useLoad(() => pc.get<Row[]>('/catalog/printers'), []);
  const [creating, setCreating] = useState(false);
  const [binding, setBinding] = useState<Agent | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const boundTo = (agentId: string) => (printers.data ?? []).filter((p) => p.agent_id === agentId);

  const revoke = async (a: Agent) => {
    if (!(await confirm({ title: t(S.revokeTitle), consequence: t(S.revokeBody), confirmLabel: t(S.revoke), destructive: true }))) return;
    try {
      await pc.post(`/agents/${encodeURIComponent(a.id)}/revoke`);
      toast.success(t(S.revokedDone));
      invalidateRefs('agents');
      void agents.reload();
    } catch (e) {
      toast.error(pcRefusal(e, lang, t(W.failed)));
    }
  };

  return (
    <div className="space-y-3">
      <SectionHead
        level={3}
        title={t(S.agents)}
        description={t(S.agentsDesc)}
        actions={
          <>
            <RefreshButton onClick={() => Promise.all([agents.reload(), printers.reload()])} loading={agents.loading} />
            {access.money && (
              <Act kind="primary" icon={<KeyRound size={14} aria-hidden />} onClick={() => setCreating(true)}>
                {t(S.newAgent)}
              </Act>
            )}
          </>
        }
      />
      {!access.money && <Note tone="info">{t(S.newAgentMoney)}</Note>}
      <LoadState state={agents}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t(S.noAgents)} icon={<Cpu size={22} aria-hidden />} />
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {list.map((a) => {
                const caps = parseJsonColumn<string[]>(a.capabilities_json, []);
                const bound = boundTo(a.id);
                const seen = ageOf(a.last_seen_at);
                return (
                  <li key={a.id} className={`${T.surface} space-y-2 p-4`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className={`text-[14px] font-bold ${T.text1}`}>{a.name}</p>
                        <Id value={a.id} copy />
                      </div>
                      <StatusChip tone={a.active === 1 ? 'success' : 'neutral'}>{t(a.active === 1 ? S.active : S.revoked)}</StatusChip>
                    </div>
                    <p className={`text-[12.5px] ${T.text2}`}>
                      {t(S.capabilities)}: {caps.length ? caps.map((c) => labelOf(AGENT_CAPABILITY, c, lang)).join('، ') : t(S.none)}
                    </p>
                    <p className={`text-[12.5px] ${T.text2}`}>
                      {t(S.lastSeen)}: {seen === null ? t(S.never) : `${ago(seen, lang)} (${formatDateTime(a.last_seen_at, lang)})`}
                    </p>
                    <p className={`text-[12.5px] ${T.text2}`}>
                      {t(S.bound)}: {bound.length ? bound.map((p) => String(p.name)).join('، ') : t(S.none)}
                    </p>
                    {a.active === 1 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Act onClick={() => setBinding(a)}>{t(S.bindPrinters)}</Act>
                        {access.money && (
                          <Act kind="danger" onClick={() => revoke(a)}>
                            {t(S.revoke)}
                          </Act>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        }
      </LoadState>
      {creating && (
        <CreateAgentSheet
          printers={printers.data ?? []}
          onClose={() => setCreating(false)}
          onDone={() => {
            invalidateRefs('agents');
            void agents.reload();
            void printers.reload();
          }}
        />
      )}
      {binding && (
        <BindSheet
          key={binding.id}
          agent={binding}
          printers={printers.data ?? []}
          onClose={() => setBinding(null)}
          onDone={() => void printers.reload()}
        />
      )}
      {confirmDialog}
    </div>
  );
}

/** Bind and unbind printers: the printer's own catalogue row (`agent_id`; binding also sets `adapter: agent`). */
async function applyBinding(agentId: string, printers: Row[], wanted: ReadonlySet<string>): Promise<string[]> {
  const failures: string[] = [];
  for (const p of printers) {
    const id = String(p.id);
    const isBound = p.agent_id === agentId;
    const want = wanted.has(id);
    if (want === isBound) continue;
    try {
      await pc.patch(`/catalog/printers/${encodeURIComponent(id)}`, want ? { agent_id: agentId, adapter: 'agent' } : { agent_id: null });
    } catch {
      failures.push(String(p.name));
    }
  }
  return failures;
}

function PrinterChecklist({ printers, wanted, onChange }: { printers: Row[]; wanted: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  const { t } = usePcLang();
  if (!printers.length) return <p className={`text-[12.5px] ${T.text3}`}>{t(S.noPrinters)}</p>;
  return (
    <div className="space-y-0.5">
      {printers.map((p) => (
        <Checkbox
          key={String(p.id)}
          checked={wanted.has(String(p.id))}
          label={`${String(p.name)} · ${String(p.equipment_code ?? '')}`}
          onChange={(on) => {
            const next = new Set(wanted);
            if (on) next.add(String(p.id));
            else next.delete(String(p.id));
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

function CreateAgentSheet({ printers, onClose, onDone }: { printers: Row[]; onClose: () => void; onDone: () => void }) {
  const { t, lang } = usePcLang();
  const [name, setName] = useState('');
  const [caps, setCaps] = useState<Set<string>>(() => new Set(['telemetry', 'job_control']));
  const [wanted, setWanted] = useState<Set<string>>(() => new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<{ agent_id: string; token: string; capabilities: string[]; unbound: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const titleId = 'pc-new-agent';

  const submit = async () => {
    setFailure(null);
    if (!name.trim()) {
      setFailure(t(S.needName));
      return;
    }
    if (!caps.size) {
      setFailure(t(S.needCap));
      return;
    }
    try {
      const out = await pc.post<{ agent_id: string; token: string; capabilities: string[] }>('/agents', { name: name.trim(), capabilities: [...caps] });
      // The token is in hand: bind the printers, and show it whatever the binding does.
      const unbound = await applyBinding(out.agent_id, printers, wanted);
      setCreated({ ...out, unbound });
      onDone();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };

  return (
    <Sheet open onClose={created ? () => undefined : onClose} labelledBy={titleId} detents={['large']} dismissOnScrim={!created} dismissOnEscape={!created} panelClassName="ap w-full sm:max-w-lg">
      <div className="space-y-3 px-5 pb-5 pt-2">
        <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
          {t(created ? S.tokenTitle : S.newAgent)}
        </h2>
        {created ? (
          <>
            <Note tone="warning">{t(S.tokenWarning)}</Note>
            <pre dir="ltr" className={`select-all whitespace-pre-wrap break-all rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-2)] p-3 font-mono text-[13px] ${T.text1}`}>
              {created.token}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Act
                kind="primary"
                onClick={() =>
                  navigator.clipboard?.writeText(created.token).then(
                    () => {
                      setCopied(true);
                      toast.success(t(S.copiedToken));
                    },
                    () => undefined
                  )
                }
              >
                {t(S.copyToken)}
              </Act>
              <Act kind={copied ? 'primary' : 'ghost'} onClick={onClose}>
                {t(S.savedToken)}
              </Act>
            </div>
            <p className={`text-[12px] ${T.text3}`}>
              <Id value={created.agent_id} copy /> · {created.capabilities.map((c) => labelOf(AGENT_CAPABILITY, c, lang)).join('، ')}
            </p>
            {created.unbound.length > 0 && (
              <Note tone="danger">
                {t(S.bindFailed)}: {created.unbound.join('، ')}
              </Note>
            )}
          </>
        ) : (
          <>
            <p className={`text-[12.5px] leading-relaxed ${T.text3}`}>{t(S.agentsDesc)}</p>
            <TextField label={t(S.name)} value={name} onChange={setName} maxLength={80} />
            <fieldset className="space-y-0.5">
              <legend className={`text-[12px] font-semibold ${T.text2}`}>{t(S.capabilities)}</legend>
              {Object.keys(AGENT_CAPABILITY).map((c) => (
                <Checkbox
                  key={c}
                  checked={caps.has(c)}
                  label={labelOf(AGENT_CAPABILITY, c, lang)}
                  onChange={(on) => {
                    const next = new Set(caps);
                    if (on) next.add(c);
                    else next.delete(c);
                    setCaps(next);
                  }}
                />
              ))}
            </fieldset>
            <fieldset className="space-y-1">
              <legend className={`text-[12px] font-semibold ${T.text2}`}>{t(S.bindPrinters)}</legend>
              <p className={`text-[11.5px] ${T.text3}`}>{t(S.bindHelp)}</p>
              <PrinterChecklist printers={printers} wanted={wanted} onChange={setWanted} />
            </fieldset>
            {failure && <p className="lv-field-error">{failure}</p>}
            <div className="flex gap-2">
              <Act kind="primary" onClick={submit}>
                {t(S.create)}
              </Act>
              <Act kind="ghost" onClick={onClose}>
                {t(W.cancel)}
              </Act>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

function BindSheet({ agent, printers, onClose, onDone }: { agent: Agent; printers: Row[]; onClose: () => void; onDone: () => void }) {
  const { t } = usePcLang();
  const initial = useMemo(() => new Set(printers.filter((p) => p.agent_id === agent.id).map((p) => String(p.id))), [printers, agent.id]);
  const [wanted, setWanted] = useState<Set<string>>(initial);
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = `pc-bind-${agent.id}`;
  const save = async () => {
    setFailure(null);
    const failed = await applyBinding(agent.id, printers, wanted);
    onDone();
    if (failed.length) setFailure(`${t(S.bindFailed)}: ${failed.join('، ')}`);
    else {
      toast.success(t(S.bindDone));
      onClose();
    }
  };
  return (
    <Sheet open onClose={onClose} labelledBy={titleId} panelClassName="ap w-full sm:max-w-md">
      <div className="space-y-3 px-5 pb-5 pt-2">
        <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
          {t(S.bindPrinters)} — {agent.name}
        </h2>
        <p className={`text-[12px] leading-relaxed ${T.text3}`}>{t(S.bindHelp)}</p>
        <PrinterChecklist printers={printers} wanted={wanted} onChange={setWanted} />
        {failure && <p className="lv-field-error">{failure}</p>}
        <div className="flex gap-2">
          <Act kind="primary" onClick={save}>
            {t(W.save)}
          </Act>
          <Act kind="ghost" onClick={onClose}>
            {t(W.cancel)}
          </Act>
        </div>
      </div>
    </Sheet>
  );
}
