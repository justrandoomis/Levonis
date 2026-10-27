/**
 * ONE PRINT JOB — its whole record (`GET /jobs/{id}`) and the operator's
 * actions on it.
 *
 * Only the actions the job's state allows are offered (jobRules.ts, a mirror
 * of the server's state machine pinned by tests/printCloudAdminUi.test.ts),
 * and the destructive ones — reject, cancel, fail, take off the printer — are
 * asked twice with their consequence. The estimate carries its SOURCE
 * (slicer or operator) and none is invented: a job without one is «awaiting
 * an estimate». A printer reading older than the staleness window is shown
 * stale, without its remaining time.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { Sheet } from '../../../ui/Sheet';
import { StatusChip } from '../../../ui/Badge';
import { useConfirm } from '../../../ui/ConfirmDialog';
import { toast } from '../../../../lib/toastStore';
import { pc, parseJsonColumn, type ConsumptionRecord, type JobDetail, type PrinterStatus } from '../../api';
import { ACTION_TARGET, DESTRUCTIVE, actionsFor, type JobAction } from '../../jobRules';
import { JOB_STATUS, PROVENANCE, RESPONSIBLE, MACHINE_STATE, labelOf, tri, type Tri } from '../../i18n';
import { ago, duration, formatDateTime, num, permille, qty } from '../../format';
import { pcRefusal } from '../../refusal';
import { useRefs, type RefLists } from '../../refs';
import { Act, Id, IntField, Json, KV, LoadState, Note, RefreshButton, SelectField, T, TextArea, TextField, Tray, W, useLoad, usePcLang } from '../../ui';
import { DurationInput } from '../catalog/fieldInputs';
import { MaterialLines, cleanLines, type MatLine } from './MaterialLines';
import type { Go } from '../../AdminPrintCloud';

const S = {
  customer: tri('العميل', 'Customer', 'کڕیار'),
  model: tri('طراز الطابعة', 'Printer model', 'مۆدێلی چاپکەر'),
  tier: tri('فئة الساعات', 'Hour tier', 'پلەی کاتژمێر'),
  copies: tri('النسخ', 'Copies', 'دانەکان'),
  priority: tri('الأولوية', 'Priority', 'پێشینەیی'),
  approval: tri('تحتاج موافقة المشغّل', 'Needs operator approval', 'پێویستی بە پەسەندکردنی کارپێکەرە'),
  dependsOn: tri('تنتظر المهمة', 'Waits for job', 'چاوەڕێی کاری'),
  parent: tri('إعادة طباعة للمهمة', 'Reprint of job', 'دووبارە چاپکردنەوەی کاری'),
  queuedAt: tri('دخلت الطابور', 'Queued', 'چووە ڕیز'),
  startedAt: tri('بدأت', 'Started', 'دەستیپێکرد'),
  endedAt: tri('انتهت', 'Ended', 'کۆتایی هات'),
  printedS: tri('مدة الطباعة', 'Printed time', 'کاتی چاپکردن'),
  billedS: tri('المحتسَب من الساعات', 'Hours billed', 'کاتژمێری حیسابکراو'),
  confirmBy: tri('مهلة تأكيد العميل', 'Customer confirmation deadline', 'دوایین کاتی دڵنیاکردنەوەی کڕیار'),
  estimate: tri('التقدير', 'Estimate', 'خەمڵاندن'),
  awaiting: tri('بانتظار التقدير', 'Awaiting an estimate', 'چاوەڕێی خەمڵاندنە'),
  awaitingHelp: tri(
    'لم يقِس السلايسر هذه المهمة بعد. لا يُختلق رقم: إما أن يقيسها وكيل بسلايسر، أو يدخل مشغّل ما قاسه سلايسر مكتبي.',
    'The slicer has not measured this job yet. No figure is invented: either an agent with a slicer measures it, or an operator enters what a desktop slicer measured.',
    'سلایسەر هێشتا ئەم کارەی نەپێواوە. هیچ ژمارەیەک دروست ناکرێت: یان بریکارێک بە سلایسەر دەیپێوێت، یان کارپێکەرێک ئەوەی سلایسەرێکی سەرمێز پێوای تۆماری دەکات.'
  ),
  source: tri('المصدر', 'Source', 'سەرچاوە'),
  duration: tri('المدة', 'Duration', 'ماوە'),
  grams: tri('الغرامات: نموذج / دعامات / تنظيف', 'Grams: model / support / purge', 'گرام: مۆدێل / پاڵپشت / پاککردنەوە'),
  colorChanges: tri('تبديلات اللون', 'Colour changes', 'گۆڕینی ڕەنگ'),
  layers: tri('الطبقات', 'Layers', 'چینەکان'),
  slicer: tri('السلايسر', 'Slicer', 'سلایسەر'),
  incompatible: tri('السلايسر وجدها غير متوافقة', 'The slicer found it incompatible', 'سلایسەر بە ناگونجاوی دۆزییەوە'),
  warnings: tri('تحذيرات', 'Warnings', 'ئاگادارکردنەوەکان'),
  requirements: tri('ما تحتاجه المهمة', 'What the job needs', 'ئەوەی کارەکە پێویستیەتی'),
  reservations: tri('المحجوز لها', 'Reserved for it', 'بۆی گیراوە'),
  noReservation: tri('لا حجز بعد (يُحجز عند تأكيد العميل).', 'Nothing reserved yet (reserved when the customer confirms).', 'هێشتا هیچ شتێک نەگیراوە (کاتی دڵنیاکردنەوەی کڕیار دەگیرێت).'),
  hours: tri('الساعات', 'Hours', 'کاتژمێر'),
  reserved: tri('محجوز', 'reserved', 'گیراو'),
  consumed: tri('مستهلك', 'used', 'بەکارهاتوو'),
  released: tri('مُعاد', 'released', 'گەڕێنراوە'),
  printer: tri('الطابعة', 'Printer', 'چاپکەر'),
  noPrinter: tri('ليست على طابعة.', 'Not on a printer.', 'لەسەر هیچ چاپکەرێک نییە.'),
  reading: tri('قراءة الطابعة', 'The printer’s reading', 'خوێندنەوەی چاپکەر'),
  stale: tri('قديمة — آخر حالة معروفة', 'Stale — last known state', 'کۆن — دوایین دۆخی زانراو'),
  live: tri('حيّة', 'Live', 'ڕاستەوخۆ'),
  otherJob: tri('القراءة لمهمة أخرى', 'The reading is for another job', 'خوێندنەوەکە بۆ کارێکی ترە'),
  remaining: tri('المتبقي', 'Remaining', 'ماوە'),
  failure: tri('العطل', 'The failure', 'شکستەکە'),
  reports: tri('تقارير الاستهلاك', 'Consumption reports', 'ڕاپۆرتەکانی بەکارهێنان'),
  unverified: tri('بانتظار تحقق المشغّل', 'Awaiting operator verification', 'چاوەڕێی پشتڕاستکردنەوەی کارپێکەرە'),
  verified: tri('متحقَّق منه', 'Verified', 'پشتڕاستکراوە'),
  timeline: tri('الخط الزمني', 'Timeline', 'هێڵی کات'),
  settings: tri('إعدادات الطباعة والتعليمات', 'Print settings and instructions', 'ڕێکخستنەکانی چاپ و ڕێنماییەکان'),
  actions: tri('إجراءات المشغّل', 'Operator actions', 'کردارەکانی کارپێکەر'),
  noActions: tri('لا إجراء متاح في هذه الحالة.', 'No action is available in this state.', 'هیچ کردارێک لەم دۆخەدا بەردەست نییە.'),
  done: tri('تم. الحالة الآن', 'Done. The state is now', 'ئەنجامدرا. دۆخ ئێستا'),
  reasonNeeded: tri('اكتب السبب.', 'Write the reason.', 'هۆکارەکە بنووسە.'),
  printerPick: tri('طابعة من الطراز نفسه', 'A printer of the same model', 'چاپکەرێک لە هەمان مۆدێل'),
  noCandidates: tri('لا طابعات من هذا الطراز.', 'No printers of this model.', 'هیچ چاپکەرێک لەم مۆدێلە نییە.'),
  assignHelp: tri('يتحقق الخادم من التوافق (الفوهة، المواد، الخانات، الصيانة، القراءات) ويرفض مع الأسباب.', 'The server checks compatibility (nozzle, materials, slots, maintenance, readings) and refuses with the reasons.', 'ڕاژەکار گونجاوی دەپشکنێت (نۆزڵ، کەرەستە، خانە، چاکسازی، خوێندنەوە) و بە هۆکارەوە ڕەتدەکاتەوە.'),
  materials: tri('المواد', 'Materials', 'کەرەستەکان'),
  usedMaterials: tri('المواد المستهلكة فعلاً', 'Materials actually used', 'ئەو کەرەستانەی بەڕاستی بەکارهاتن'),
  variant: tri('الصنف', 'Variant', 'جۆر'),
  modelG: tri('غ النموذج', 'Model g', 'گرامی مۆدێل'),
  supportG: tri('غ الدعامات', 'Support g', 'گرامی پاڵپشت'),
  purgeG: tri('غ التنظيف', 'Purge g', 'گرامی پاککردنەوە'),
  addLine: tri('إضافة مادة', 'Add a material', 'زیادکردنی کەرەستە'),
  removeLine: tri('حذف', 'Remove', 'سڕینەوە'),
  slicerName: tri('اسم السلايسر', 'Slicer name', 'ناوی سلایسەر'),
  slicerVersion: tri('الإصدار', 'Version', 'وەشان'),
  profile: tri('ملف الطابعة', 'Printer profile', 'پرۆفایلی چاپکەر'),
  estimateHelp: tri(
    'أدخل ما قاسه سلايسر مكتبي لهذه المهمة: يُسجَّل مصدره «مشغّل». المواد يجب أن تكون من مواد المهمة نفسها (يرفض الخادم غيرها).',
    'Enter what a desktop slicer measured for this job: its source is recorded as “operator”. Materials must be the job’s own (the server refuses others).',
    'ئەوەی سلایسەرێکی سەرمێز بۆ ئەم کارە پێوای تۆماری بکە: سەرچاوەکەی وەک «کارپێکەر» تۆمار دەکرێت. کەرەستەکان دەبێت هی خودی کارەکە بن (ڕاژەکار ئەوانی تر ڕەتدەکاتەوە).'
  ),
  completeHelp: tri(
    'يُحتسب من الحجز ما استُهلك فعلاً ويُعاد الباقي؛ مادة محجوزة لا تذكرها تُعدّ مستهلكة كما حُجزت.',
    'What was actually used is billed from the reservation and the rest released; a reserved material you leave out is taken as used exactly as reserved.',
    'ئەوەی بەڕاستی بەکارهات لە گیراوەکە حیساب دەکرێت و ئەوی تر دەگەڕێنرێتەوە؛ کەرەستەیەکی گیراو کە نایڵێیت وەک بەکارهاتوو بە هەمان بڕی گیراو دادەنرێت.'
  ),
  failHelp: tri(
    'تتوقف المهمة وتتحرر الطابعة؛ الحجوزات تنتظر قرار العطل في تبويب الأعطال.',
    'The job stops and the printer is freed; the reservations wait for the failure’s decision in the Failures tab.',
    'کارەکە دەوەستێت و چاپکەرەکە ئازاد دەکرێت؛ گلدانەوەکان چاوەڕێی بڕیاری شکستەکە دەبن لە بەشی شکستەکاندا.'
  ),
  reasonCode: tri('رمز السبب', 'Reason code', 'کۆدی هۆکار'),
  description: tri('الوصف', 'Description', 'وەسف'),
  printedTime: tri('الوقت المطبوع', 'Time printed', 'کاتی چاپکراو'),
  failedMaterials: tri('المواد المهدرة', 'Material wasted', 'کەرەستەی بەفیڕۆچوو'),
  verifyAsIs: tri('تحقق كما أُبلغ', 'Verify as reported', 'پشتڕاستکردنەوە وەک ڕاپۆرتکراو'),
  verifyHelp: tri('التحقق يحتسب الاستهلاك المبلّغ ويُكمل المهمة؛ صحّحه قبل ذلك إن لزم.', 'Verifying bills the reported consumption and completes the job; correct it first if needed.', 'پشتڕاستکردنەوە بەکارهێنانی ڕاپۆرتکراو حیساب دەکات و کارەکە تەواو دەکات؛ ئەگەر پێویست بوو پێشتر ڕاستی بکەرەوە.'),
  record: tri('التقرير', 'Report', 'ڕاپۆرت'),
  withCorrections: tri('بتصحيحاتي', 'With my corrections', 'بە ڕاستکردنەوەکانم'),
  priorityRange: tri('من ‎-100 إلى 100؛ الأعلى أولاً', 'From −100 to 100; higher goes first', 'لە ‎-100 تا 100؛ بەرزتر یەکەم دێت'),
  submit: tri('تنفيذ', 'Apply', 'جێبەجێکردن'),
  confirmTitle: tri('تأكيد', 'Confirm', 'دڵنیاکردنەوە'),
  consequence: {
    approve: tri('تدخل المهمة الطابور؛ ساعاتها وموادها محجوزة.', 'The job enters the queue; its hours and materials are reserved.', 'کارەکە دەچێتە ڕیز؛ کاتژمێر و کەرەستەکانی گیراون.'),
    reject: tri('تُلغى المهمة وتعود للعميل ساعاته وموادّه المحجوزة، ويُبلَّغ.', 'The job is cancelled, the customer gets their reserved hours and material back, and is told.', 'کارەکە هەڵدەوەشێتەوە، کاتژمێر و کەرەستە گیراوەکانی کڕیار دەگەڕێنەوە و ئاگادار دەکرێتەوە.'),
    cancel: tri('تُلغى المهمة وكل حجوزاتها تُعاد مرة واحدة، وتُترك الطابعة إن كانت عليها.', 'The job is cancelled, every reservation is released once, and a printer it was on is let go.', 'کارەکە هەڵدەوەشێتەوە، هەموو گلدانەوەکانی یەکجار دەگەڕێنەوە، و ئەگەر لەسەر چاپکەرێک بوو بەردەدرێت.'),
    unassign: tri('تعود المهمة إلى الطابور وتتحرر الطابعة.', 'The job goes back to the queue and the printer is freed.', 'کارەکە دەگەڕێتەوە ڕیز و چاپکەرەکە ئازاد دەکرێت.'),
    fail: tri('تُسجَّل المهمة فاشلة وتتحرر الطابعة؛ القرار والاحتساب في تبويب الأعطال.', 'The job is recorded as failed and the printer freed; the decision and the charge are in the Failures tab.', 'کارەکە وەک سەرنەکەوتوو تۆمار دەکرێت و چاپکەرەکە ئازاد دەکرێت؛ بڕیار و حیسابکردن لە بەشی شکستەکاندایە.'),
    complete: tri('تُغلق المهمة ويُحتسب الاستهلاك المدخل من حجز العميل نهائياً.', 'The job is closed and the consumption entered is billed from the customer’s reservation, for good.', 'کارەکە دادەخرێت و بەکارهێنانی تۆمارکراو بە یەکجاری لە گیراوی کڕیار حیساب دەکرێت.'),
    start: tri('تبدأ الطباعة على الطابعة المسندة، ويُبلَّغ العميل.', 'Printing starts on the assigned printer, and the customer is told.', 'چاپکردن لەسەر چاپکەری دیاریکراو دەست پێدەکات، و کڕیار ئاگادار دەکرێتەوە.'),
  },
} as const;

const ACTION_LABEL: Readonly<Record<JobAction, Tri>> = {
  approve: tri('موافقة', 'Approve', 'پەسەندکردن'),
  reject: tri('رفض', 'Reject', 'ڕەتکردنەوە'),
  estimate: tri('إدخال تقدير يدوي', 'Enter a manual estimate', 'تۆمارکردنی خەمڵاندنی دەستی'),
  assign: tri('إسناد إلى طابعة', 'Put on a printer', 'خستنە سەر چاپکەر'),
  unassign: tri('إنزال عن الطابعة', 'Take off the printer', 'لابردن لە چاپکەر'),
  start: tri('بدء الطباعة', 'Start printing', 'دەستپێکردنی چاپ'),
  pause: tri('إيقاف مؤقت', 'Pause', 'ڕاگرتنی کاتی'),
  resume: tri('استئناف', 'Resume', 'درێژەپێدان'),
  complete: tri('إكمال مع الاستهلاك', 'Complete with consumption', 'تەواوکردن لەگەڵ بەکارهێنان'),
  verify: tri('التحقق من تقرير الوكيل', 'Verify the agent’s report', 'پشتڕاستکردنەوەی ڕاپۆرتی بریکار'),
  fail: tri('تسجيل عطل', 'Record a failure', 'تۆمارکردنی شکست'),
  cancel: tri('إلغاء المهمة', 'Cancel the job', 'هەڵوەشاندنەوەی کار'),
  priority: tri('تغيير الأولوية', 'Change the priority', 'گۆڕینی پێشینەیی'),
};

export default function JobSheet({ jobId, onClose, go }: { jobId: string; onClose: () => void; go: Go }) {
  const { lang } = usePcLang();
  const job = useLoad(() => pc.get<JobDetail>(`/jobs/${encodeURIComponent(jobId)}`), [jobId]);
  const refs = useRefs(['variants', 'printer_models', 'tiers'], lang);
  const titleId = `pc-job-${jobId}`;
  return (
    <Sheet
      open
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="ap w-full sm:max-w-3xl"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
            {job.data?.title || jobId}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {job.data && <StatusChip tone="info">{labelOf(JOB_STATUS, job.data.status, lang)}</StatusChip>}
            <Id value={jobId} copy />
            <RefreshButton onClick={() => job.reload()} loading={job.loading} />
          </div>
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-5">
        <LoadState state={job}>{(j) => <JobBody job={j} refs={refs} reload={() => job.reload()} go={go} />}</LoadState>
      </div>
    </Sheet>
  );
}

function JobBody({ job: j, refs, reload, go }: { job: JobDetail; refs: RefLists; reload: () => Promise<void>; go: Go }) {
  const { t, lang } = usePcLang();
  const unitOf = (variantId: string) => String(refs.row('variants', variantId)?.unit_code ?? '');
  const pending = j.consumption_records.filter((r) => r.verified === 0);
  const e = j.estimate;
  return (
    <>
      <KV
        rows={[
          [t(S.customer), <Id key="u" value={j.user_id} copy />],
          [t(S.model), refs.name('printer_models', j.printer_model_id)],
          [t(S.tier), refs.name('tiers', j.tier_id)],
          [t(S.copies), num(j.copies)],
          [t(S.priority), num(j.priority)],
          [t(S.approval), t(j.needs_operator_approval ? W.yes : W.no)],
          j.depends_on_job_id ? [t(S.dependsOn), <Id key="d" value={j.depends_on_job_id} copy />] : null,
          j.parent_job_id ? [t(S.parent), <Id key="p" value={j.parent_job_id} copy />] : null,
          j.confirmation_expires_at ? [t(S.confirmBy), formatDateTime(j.confirmation_expires_at, lang)] : null,
          j.queued_at ? [t(S.queuedAt), formatDateTime(j.queued_at, lang)] : null,
          j.started_at ? [t(S.startedAt), formatDateTime(j.started_at, lang)] : null,
          j.ended_at ? [t(S.endedAt), formatDateTime(j.ended_at, lang)] : null,
          j.printed_seconds !== null ? [t(S.printedS), duration(j.printed_seconds, lang)] : null,
          j.billable_seconds !== null ? [t(S.billedS), duration(j.billable_seconds, lang)] : null,
        ]}
      />

      <Tray title={t(S.estimate)}>
        {!e ? (
          <div className="space-y-1">
            <StatusChip tone="warning" icon={<Clock size={13} aria-hidden />}>
              {t(S.awaiting)}
            </StatusChip>
            <p className={`text-[12.5px] leading-relaxed ${T.text3}`}>{t(S.awaitingHelp)}</p>
          </div>
        ) : (
          <div className="space-y-2 text-[12.5px]">
            <KV
              rows={[
                [t(S.source), labelOf(PROVENANCE, e.provenance, lang)],
                [t(S.duration), duration(e.duration_seconds, lang)],
                [t(S.grams), <bdi key="g" dir="ltr">{num(e.model_grams)} / {num(e.support_grams)} / {num(e.purge_grams)} g</bdi>],
                [t(S.colorChanges), num(e.color_changes)],
                e.layer_count !== null ? [t(S.layers), num(e.layer_count)] : null,
                e.slicer_name ? [t(S.slicer), <bdi key="s" dir="ltr">{`${e.slicer_name} ${e.slicer_version ?? ''}`.trim()}</bdi>] : null,
              ]}
            />
            {e.compatible === 0 && <Note tone="danger">{t(S.incompatible)}</Note>}
            {e.warnings.length > 0 && (
              <p className={T.text2}>
                {t(S.warnings)}: <bdi dir="ltr">{e.warnings.join(' · ')}</bdi>
              </p>
            )}
            {e.materials.length > 0 && (
              <ul className="space-y-0.5">
                {e.materials.map((m) => (
                  <li key={m.variant_id} className={T.text2}>
                    {refs.name('variants', m.variant_id)}: <bdi dir="ltr">{num(m.model_grams)} / {num(m.support_grams)} / {num(m.purge_grams)} g</bdi>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Tray>

      {j.requirements.length > 0 && (
        <Tray title={t(S.requirements)}>
          <ul className="space-y-0.5 text-[12.5px]">
            {j.requirements.map((r) => (
              <li key={`${r.kind}-${r.variant_id}`} className={T.text2}>
                {refs.name('variants', r.variant_id)}: {qty(r.qty, unitOf(r.variant_id), lang)}
              </li>
            ))}
          </ul>
        </Tray>
      )}

      <Tray title={t(S.reservations)}>
        {!j.reservations.credits && j.reservations.materials.length === 0 ? (
          <p className={`text-[12.5px] ${T.text3}`}>{t(S.noReservation)}</p>
        ) : (
          <ul className="space-y-1 text-[12.5px]">
            {j.reservations.credits && (
              <li className={T.text2}>
                {t(S.hours)}: {duration(j.reservations.credits.seconds_reserved, lang)} {t(S.reserved)} · {duration(j.reservations.credits.seconds_consumed, lang)} {t(S.consumed)} ·{' '}
                {duration(j.reservations.credits.seconds_released, lang)} {t(S.released)} · <bdi dir="ltr">{j.reservations.credits.state}</bdi>
              </li>
            )}
            {j.reservations.materials.map((m) => (
              <li key={m.variant_id} className={T.text2}>
                {refs.name('variants', m.variant_id)}: {qty(m.qty_reserved, unitOf(m.variant_id), lang)} {t(S.reserved)} · {qty(m.qty_consumed, unitOf(m.variant_id), lang)} {t(S.consumed)} ·{' '}
                {qty(m.qty_released, unitOf(m.variant_id), lang)} {t(S.released)} · <bdi dir="ltr">{m.state}</bdi>
              </li>
            ))}
          </ul>
        )}
      </Tray>

      <Tray title={t(S.printer)}>
        {!j.printer ? (
          <p className={`text-[12.5px] ${T.text3}`}>{t(S.noPrinter)}</p>
        ) : (
          <div className="space-y-1 text-[12.5px]">
            <p className={T.text1}>
              {j.printer.name} · <Id value={j.printer.printer_id} /> · {formatDateTime(j.printer.assigned_at, lang)}
            </p>
            {j.telemetry && (
              <div className="space-y-0.5">
                <p className="flex flex-wrap items-center gap-2">
                  <span className={T.text2}>{t(S.reading)}:</span>
                  <StatusChip tone={j.telemetry.stale ? 'warning' : 'info'}>{t(j.telemetry.stale ? S.stale : S.live)}</StatusChip>
                  <span className={T.text3}>{ago(j.telemetry.age_seconds, lang)}</span>
                </p>
                {j.telemetry.job_id && j.telemetry.job_id !== j.id && <Note tone="warning">{t(S.otherJob)}</Note>}
                <p className={j.telemetry.stale ? T.text3 : T.text1}>
                  {labelOf(MACHINE_STATE, j.telemetry.machine_state, lang)}
                  {j.telemetry.progress_permille !== null && ` · ${permille(j.telemetry.progress_permille)}`}
                </p>
                {j.telemetry.live && j.telemetry.remaining_seconds !== null && (
                  <p className={T.text2}>
                    {t(S.remaining)}: {duration(j.telemetry.remaining_seconds, lang)}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Tray>

      {j.failure && (
        <Tray title={t(S.failure)}>
          <div className="space-y-1 text-[12.5px]">
            <p className={T.text1}>
              <AlertTriangle size={13} aria-hidden className="inline" /> <bdi dir="ltr" className="font-mono">{String(j.failure.reason_code)}</bdi> · {labelOf(RESPONSIBLE, String(j.failure.responsible), lang)} ·{' '}
              <bdi dir="ltr">{String(j.failure.status)}</bdi>
            </p>
            <Json value={j.failure} />
          </div>
        </Tray>
      )}

      {j.consumption_records.length > 0 && (
        <Tray title={t(S.reports)}>
          <ul className="space-y-2 text-[12.5px]">
            {j.consumption_records.map((r) => (
              <li key={r.id} className="space-y-1 border-b border-[var(--ap-border)] pb-2">
                <p className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={r.verified ? 'success' : 'warning'} icon={r.verified ? <CheckCircle2 size={13} aria-hidden /> : undefined}>
                    {t(r.verified ? S.verified : S.unverified)}
                  </StatusChip>
                  <span className={T.text2}>
                    <bdi dir="ltr">{r.reported_by_type}</bdi> · {duration(r.printed_seconds, lang)} · {formatDateTime(r.created_at, lang)}
                  </span>
                </p>
                <Json value={parseJsonColumn(r.materials_json, [])} />
              </li>
            ))}
          </ul>
        </Tray>
      )}

      <Tray title={t(S.actions)}>
        <Actions job={j} pending={pending} refs={refs} reload={reload} go={go} />
      </Tray>

      <Tray title={t(S.timeline)}>
        <ol className="space-y-1.5 text-[12.5px]">
          {j.events.map((ev, i) => (
            <li key={i} className={T.text2}>
              <span className={T.text3}>{formatDateTime(ev.created_at, lang)}</span> · {ev.from_status ? `${labelOf(JOB_STATUS, ev.from_status, lang)} → ` : ''}
              {labelOf(JOB_STATUS, ev.to_status, lang)} · <bdi dir="ltr" className="font-mono">{ev.event}</bdi> · <bdi dir="ltr">{ev.actor_type}</bdi>
            </li>
          ))}
        </ol>
      </Tray>

      <Tray title={t(S.settings)}>
        <Json value={{ settings: j.settings, operator_instructions: j.operator_instructions }} />
      </Tray>
    </>
  );
}

function Actions({ job: j, pending, refs, reload, go }: { job: JobDetail; pending: ConsumptionRecord[]; refs: RefLists; reload: () => Promise<void>; go: Go }) {
  const { t, lang } = usePcLang();
  const [confirm, confirmDialog] = useConfirm();
  const [open, setOpen] = useState<JobAction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [priority, setPriority] = useState<number | null>(j.priority);
  const [printerId, setPrinterId] = useState('');
  const [seconds, setSeconds] = useState<number | null>(j.estimate?.duration_seconds ?? null);
  const [lines, setLines] = useState<MatLine[]>(() => j.reservations.materials.map((m) => ({ variant_id: m.variant_id, qty: m.qty_reserved })));
  const [reasonCode, setReasonCode] = useState('');
  const [responsible, setResponsible] = useState('undetermined');
  const [description, setDescription] = useState('');
  const [recordId, setRecordId] = useState(pending[0]?.id ?? '');
  const [asReported, setAsReported] = useState(true);
  // the manual estimate
  const [estLines, setEstLines] = useState<Array<{ variant_id: string; model: number | null; support: number | null; purge: number | null }>>(() =>
    j.requirements.filter((r) => r.kind === 'filament').map((r) => ({ variant_id: r.variant_id, model: null, support: 0, purge: 0 }))
  );
  const [layers, setLayers] = useState<number | null>(null);
  const [colorChanges, setColorChanges] = useState<number | null>(0);
  const [slicerName, setSlicerName] = useState('');
  const [slicerVersion, setSlicerVersion] = useState('');
  const [profile, setProfile] = useState('');
  const candidates = useLoad(() => pc.get<PrinterStatus[]>(`/printers?model_id=${encodeURIComponent(j.printer_model_id)}`), [j.printer_model_id], open === 'assign');

  const actions = actionsFor(j.status, pending.length > 0);
  if (!actions.length) return <p className={`text-[12.5px] ${T.text3}`}>{t(S.noActions)}</p>;

  const run = async (action: JobAction, body: Record<string, unknown> = {}) => {
    setFailure(null);
    const consequence = (S.consequence as Record<string, Tri>)[action];
    if (DESTRUCTIVE.has(action) || action === 'approve' || action === 'complete' || action === 'start' || action === 'verify') {
      const ok = await confirm({
        title: `${t(ACTION_LABEL[action])} — ${j.title || j.id}`,
        consequence: consequence ? t(consequence) : undefined,
        confirmLabel: t(ACTION_LABEL[action]),
        destructive: DESTRUCTIVE.has(action),
      });
      if (!ok) return;
    }
    const path = action === 'verify' ? 'verify-completion' : action;
    try {
      await pc.post(`/jobs/${encodeURIComponent(j.id)}/${path}`, body);
      const target = ACTION_TARGET[action];
      toast.success(target ? `${t(S.done)}: ${labelOf(JOB_STATUS, target, lang)}` : t(W.done));
      setOpen(null);
      setReason('');
      await reload();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };

  const needsReason = (a: JobAction) => a === 'reject' || a === 'cancel';
  const reasonOptional = (a: JobAction) => a === 'unassign' || a === 'pause';

  const form = (() => {
    if (!open) return null;
    if (needsReason(open) || reasonOptional(open)) {
      return (
        <div className="space-y-2">
          <TextArea label={`${t(W.reason)}${reasonOptional(open) ? ` (${t(W.optional)})` : ''}`} value={reason} onChange={setReason} maxLength={300} rows={2} />
          <Act
            kind={DESTRUCTIVE.has(open) ? 'danger' : 'primary'}
            onClick={() => {
              if (needsReason(open) && !reason.trim()) {
                setFailure(t(S.reasonNeeded));
                return undefined;
              }
              return run(open, reason.trim() ? { reason: reason.trim() } : {});
            }}
          >
            {t(ACTION_LABEL[open])}
          </Act>
        </div>
      );
    }
    if (open === 'priority') {
      return (
        <div className="space-y-2">
          <IntField label={t(S.priority)} allowNegative value={priority} onChange={setPriority} hint={t(S.priorityRange)} error={priority !== null && (priority < -100 || priority > 100) ? t(S.priorityRange) : null} />
          <Act kind="primary" disabled={priority === null || priority < -100 || priority > 100} onClick={() => run('priority', { priority })}>
            {t(S.submit)}
          </Act>
        </div>
      );
    }
    if (open === 'assign') {
      return (
        <div className="space-y-2">
          <p className={`text-[12px] ${T.text3}`}>{t(S.assignHelp)}</p>
          <LoadState state={candidates}>
            {(list) =>
              list.length === 0 ? (
                <p className={`text-[12.5px] ${T.text3}`}>{t(S.noCandidates)}</p>
              ) : (
                <SelectField
                  label={t(S.printerPick)}
                  value={printerId}
                  placeholder="—"
                  options={list.map((p) => ({
                    value: p.id,
                    label: `${p.name} · ${p.status} · ${p.connectivity}${p.current_job_id ? ' · busy' : ''}`,
                  }))}
                  onChange={setPrinterId}
                />
              )
            }
          </LoadState>
          <Act kind="primary" disabled={!printerId} onClick={() => run('assign', { printer_id: printerId })}>
            {t(ACTION_LABEL.assign)}
          </Act>
        </div>
      );
    }
    if (open === 'complete') {
      return (
        <div className="space-y-3">
          <p className={`text-[12px] leading-relaxed ${T.text3}`}>{t(S.completeHelp)}</p>
          <DurationInput label={t(S.printedTime)} value={seconds} onChange={setSeconds} />
          <MaterialLines lines={lines} onChange={setLines} refs={refs} label={t(S.usedMaterials)} />
          <Act kind="primary" disabled={seconds === null} onClick={() => run('complete', { printed_seconds: seconds, materials: cleanLines(lines) })}>
            {t(ACTION_LABEL.complete)}
          </Act>
        </div>
      );
    }
    if (open === 'verify') {
      const record = pending.find((r) => r.id === recordId);
      return (
        <div className="space-y-3">
          <p className={`text-[12px] leading-relaxed ${T.text3}`}>{t(S.verifyHelp)}</p>
          <SelectField label={t(S.record)} value={recordId} options={pending.map((r) => ({ value: r.id, label: `${formatDateTime(r.created_at, lang)} · ${duration(r.printed_seconds, lang)}` }))} onChange={setRecordId} />
          {record && <Json value={parseJsonColumn(record.materials_json, [])} />}
          <SelectField
            label={t(S.submit)}
            value={asReported ? 'as' : 'fix'}
            options={[
              { value: 'as', label: t(S.verifyAsIs) },
              { value: 'fix', label: t(S.withCorrections) },
            ]}
            onChange={(v) => setAsReported(v === 'as')}
          />
          {!asReported && (
            <>
              <DurationInput label={t(S.printedTime)} value={seconds} onChange={setSeconds} />
              <MaterialLines lines={lines} onChange={setLines} refs={refs} label={t(S.usedMaterials)} />
            </>
          )}
          <Act
            kind="primary"
            disabled={!recordId || (!asReported && seconds === null)}
            onClick={() => run('verify', asReported ? { consumption_record_id: recordId } : { consumption_record_id: recordId, printed_seconds: seconds, materials: cleanLines(lines) })}
          >
            {t(ACTION_LABEL.verify)}
          </Act>
        </div>
      );
    }
    if (open === 'fail') {
      return (
        <div className="space-y-3">
          <p className={`text-[12px] leading-relaxed ${T.text3}`}>{t(S.failHelp)}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField label={t(S.reasonCode)} value={reasonCode} onChange={setReasonCode} maxLength={60} ltr placeholder="adhesion, spaghetti, nozzle_clog…" />
            <SelectField label={t(S.customer)} value={responsible} options={Object.keys(RESPONSIBLE).map((r) => ({ value: r, label: labelOf(RESPONSIBLE, r, lang) }))} onChange={setResponsible} />
          </div>
          <TextArea label={t(S.description)} value={description} onChange={setDescription} maxLength={2000} rows={2} />
          <DurationInput label={t(S.printedTime)} value={seconds} onChange={setSeconds} />
          <MaterialLines lines={lines} onChange={setLines} refs={refs} label={t(S.failedMaterials)} />
          <Act
            kind="danger"
            disabled={!reasonCode.trim()}
            onClick={() =>
              run('fail', {
                reason_code: reasonCode.trim(),
                responsible,
                ...(description.trim() ? { description: description.trim() } : {}),
                printed_seconds: seconds ?? 0,
                failed_materials: cleanLines(lines),
              })
            }
          >
            {t(ACTION_LABEL.fail)}
          </Act>
        </div>
      );
    }
    if (open === 'estimate') {
      const ok = seconds !== null && seconds >= 1 && estLines.length > 0 && estLines.every((l) => l.variant_id && l.model !== null);
      return (
        <div className="space-y-3">
          <Note tone="info">{t(S.estimateHelp)}</Note>
          <DurationInput label={t(S.duration)} value={seconds} onChange={setSeconds} />
          <fieldset className="space-y-2">
            <legend className={`text-[12px] font-semibold ${T.text2}`}>{t(S.materials)}</legend>
            {estLines.map((l, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <SelectField className="min-w-[12rem] flex-1" label={t(S.variant)} value={l.variant_id} placeholder="—" options={refs.options('variants')} onChange={(v) => setEstLines(estLines.map((x, k) => (k === i ? { ...x, variant_id: v } : x)))} />
                <IntField className="w-28" label={t(S.modelG)} value={l.model} onChange={(v) => setEstLines(estLines.map((x, k) => (k === i ? { ...x, model: v } : x)))} />
                <IntField className="w-28" label={t(S.supportG)} value={l.support} onChange={(v) => setEstLines(estLines.map((x, k) => (k === i ? { ...x, support: v } : x)))} />
                <IntField className="w-28" label={t(S.purgeG)} value={l.purge} onChange={(v) => setEstLines(estLines.map((x, k) => (k === i ? { ...x, purge: v } : x)))} />
                <button type="button" className={T.btnGhostSm} onClick={() => setEstLines(estLines.filter((_, k) => k !== i))}>
                  {t(S.removeLine)}
                </button>
              </div>
            ))}
            <button type="button" className={T.btnGhostSm} onClick={() => setEstLines([...estLines, { variant_id: '', model: null, support: 0, purge: 0 }])}>
              {t(S.addLine)}
            </button>
          </fieldset>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <IntField label={t(S.layers)} value={layers} onChange={setLayers} />
            <IntField label={t(S.colorChanges)} value={colorChanges} onChange={setColorChanges} />
            <TextField label={t(S.slicerName)} value={slicerName} onChange={setSlicerName} maxLength={60} ltr />
            <TextField label={t(S.slicerVersion)} value={slicerVersion} onChange={setSlicerVersion} maxLength={40} ltr />
            <TextField className="sm:col-span-2" label={t(S.profile)} value={profile} onChange={setProfile} maxLength={120} ltr />
          </div>
          <Act
            kind="primary"
            disabled={!ok}
            onClick={() =>
              run('estimate', {
                duration_seconds: seconds,
                materials: estLines.map((l) => ({ variant_id: l.variant_id, model_grams: l.model ?? 0, support_grams: l.support ?? 0, purge_grams: l.purge ?? 0 })),
                ...(layers !== null ? { layer_count: layers } : {}),
                color_changes: colorChanges ?? 0,
                ...(slicerName.trim() ? { slicer_name: slicerName.trim() } : {}),
                ...(slicerVersion.trim() ? { slicer_version: slicerVersion.trim() } : {}),
                ...(profile.trim() ? { printer_profile: profile.trim() } : {}),
              })
            }
          >
            {t(ACTION_LABEL.estimate)}
          </Act>
        </div>
      );
    }
    return null;
  })();

  // Actions with nothing to ask run at once (behind their confirmation).
  const immediate = (a: JobAction) => a === 'approve' || a === 'start' || a === 'resume';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Act
            key={a}
            kind={DESTRUCTIVE.has(a) ? 'danger' : a === actions[0] ? 'primary' : 'secondary'}
            onClick={() => {
              setFailure(null);
              if (immediate(a)) return run(a);
              setOpen((cur) => (cur === a ? null : a));
              return undefined;
            }}
          >
            {t(ACTION_LABEL[a])}
          </Act>
        ))}
        {j.status === 'failed' && (
          <Act onClick={() => go('jobs', { tab: 'failures' })}>{t(S.failure)}</Act>
        )}
      </div>
      {form && <div className={`${T.surface} p-3`}>{form}</div>}
      {failure && <p className="lv-field-error">{failure}</p>}
      {confirmDialog}
    </div>
  );
}
