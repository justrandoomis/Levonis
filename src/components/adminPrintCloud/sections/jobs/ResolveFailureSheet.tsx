/**
 * DECIDING A FAILURE — `POST /failures/{id}/resolve`.
 *
 * The operator names who is responsible; the POLICY for that party is the
 * owner's setting (`failure_policy`, read here from `GET /settings`, never
 * assumed) and decides what the customer is charged:
 *
 *   no_charge        nothing; every reservation goes back to the customer
 *   charge_printed   the printed time and the wasted material
 *   manual_review    what a full admin states by hand — a money act, so the
 *                    amounts are asked only of one (`can_move_money`); the
 *                    server refuses the policy without them
 *
 * Under every policy the server never charges beyond what was reserved. A
 * reprint after a WORKSHOP failure exists only when the owner's free-reprint
 * setting is on (the server ignores the request otherwise, so the box is not
 * offered); after any other party's failure it is a new job the customer
 * confirms and pays for.
 */
import { useState } from 'react';
import { Sheet } from '../../../ui/Sheet';
import { StatusChip } from '../../../ui/Badge';
import { Checkbox } from '../../../ui/Switch';
import { useConfirm } from '../../../ui/ConfirmDialog';
import { pc, parseJsonColumn, type FailureRow, type SettingsAnswer } from '../../api';
import { FAILURE_POLICY, RESPONSIBLE, labelOf, tri, type Tri } from '../../i18n';
import { duration, qty } from '../../format';
import { pcRefusal } from '../../refusal';
import { useRefs } from '../../refs';
import { Act, Id, KV, LoadState, Note, SelectField, T, TextArea, W, useLoad, usePcLang } from '../../ui';
import { DurationInput } from '../catalog/fieldInputs';
import { MaterialLines, cleanLines, type MatLine } from './MaterialLines';

const S = {
  title: tri('القرار في العطل', 'Decide the failure', 'بڕیاردان لەسەر شکستەکە'),
  reported: tri('ما بُلّغ عنه', 'What was reported', 'ئەوەی ڕاگەیەندرا'),
  reason: tri('رمز السبب', 'Reason code', 'کۆدی هۆکار'),
  reportedBy: tri('المسؤول حسب البلاغ', 'Responsible, as reported', 'بەرپرس، وەک ڕاگەیەندرا'),
  description: tri('الوصف', 'Description', 'وەسف'),
  printed: tri('ما طُبع قبل العطل', 'Printed before the failure', 'ئەوەی پێش شکستەکە چاپکرا'),
  wasted: tri('المواد المهدرة', 'Material wasted', 'کەرەستەی بەفیڕۆچوو'),
  job: tri('المهمة', 'Job', 'کار'),
  responsible: tri('من يتحمّل العطل', 'Who is responsible', 'کێ بەرپرسە'),
  policy: tri('السياسة المطبّقة (من الإعدادات)', 'Policy applied (from Settings)', 'ئەو سیاسەتەی جێبەجێ دەکرێت (لە ڕێکخستنەکانەوە)'),
  policyNoCharge: tri(
    'لا يُحتسب على العميل شيء: تُعاد له كل الساعات والمواد المحجوزة، وتتحمّل الورشة ما استُهلك.',
    'Nothing is charged: every reserved hour and material goes back to the customer, and the workshop absorbs what was used.',
    'هیچ شتێک لە کڕیار حیساب ناکرێت: هەموو کاتژمێر و کەرەستە گیراوەکان بۆی دەگەڕێنەوە، و کارگە ئەوەی بەکارهات لەسەر خۆی دەگرێت.'
  ),
  policyPrinted: tri(
    'يُحتسب ما طُبع فعلاً من وقت ومواد مهدرة — ولا يتجاوز أبداً ما كان محجوزاً — ويعود الباقي إلى العميل.',
    'The time actually printed and the wasted material are charged — never beyond what was reserved — and the rest goes back to the customer.',
    'ئەو کاتەی بەڕاستی چاپکرا و کەرەستە بەفیڕۆچووەکە حیساب دەکرێن — هەرگیز زیاتر لەوەی گیرابوو نا — و ئەوەی تر بۆ کڕیار دەگەڕێتەوە.'
  ),
  policyManual: tri(
    'مدير مالي يحدد بيده ما يُحتسب من وقت ومواد — ولا يتجاوز أبداً ما كان محجوزاً.',
    'A full admin states by hand the time and material charged — never beyond what was reserved.',
    'بەڕێوەبەرێکی دارایی بە دەست دیاری دەکات چ کات و کەرەستەیەک حیساب دەکرێت — هەرگیز زیاتر لەوەی گیرابوو نا.'
  ),
  manualNeedsMoney: tri(
    'هذه السياسة تحتاج مديراً مالياً ليحدد المبالغ المحتسبة — اطلب من المالك أو مدير مالي اتخاذ القرار.',
    'This policy needs a full admin to state the billable amounts — ask the owner or a full admin to decide it.',
    'ئەم سیاسەتە پێویستی بە بەڕێوەبەرێکی داراییە بۆ دیاریکردنی بڕە حیسابکراوەکان — داوا لە خاوەن یان بەڕێوەبەرێکی دارایی بکە بڕیار بدات.'
  ),
  billSeconds: tri('الوقت المحتسب على العميل', 'Time charged to the customer', 'ئەو کاتەی لە کڕیار حیساب دەکرێت'),
  billSecondsHelp: tri('مطلوب؛ صفر يعني بلا وقت محتسب.', 'Required; zero means no time is charged.', 'پێویستە؛ سفر واتە هیچ کاتێک حیساب ناکرێت.'),
  billMaterials: tri('المواد المحتسبة على العميل', 'Material charged to the customer', 'ئەو کەرەستەیەی لە کڕیار حیساب دەکرێت'),
  reprint: tri('إنشاء مهمة إعادة طباعة', 'Create a reprint job', 'دروستکردنی کاری دووبارە چاپکردنەوە'),
  reprintFree: tri(
    'إعادة طباعة مجانية بالملف والإعدادات نفسها وبأولوية أعلى، وتدخل الطابور تلقائياً إن أمكن.',
    'A free reprint with the same file and settings at a higher priority, queued automatically when possible.',
    'دووبارە چاپکردنەوەیەکی بێبەرامبەر بە هەمان فایل و ڕێکخستن و پێشینەیی بەرزتر، و ئەگەر بکرێت خۆکارانە دەچێتە ڕیز.'
  ),
  reprintOff: tri(
    'إعادة الطباعة المجانية بعد عطل الورشة مُطفأة في الإعدادات: لن تُنشأ مهمة إعادة طباعة.',
    'Free reprints after a workshop failure are switched off in Settings: no reprint job will be created.',
    'دووبارە چاپکردنەوەی بێبەرامبەر دوای شکستی کارگە لە ڕێکخستنەکاندا کوژاوەتەوە: هیچ کاری دووبارە چاپکردنەوە دروست ناکرێت.'
  ),
  reprintPaid: tri(
    'مهمة جديدة بانتظار تأكيد العميل — تُدفع من رصيده كأي مهمة.',
    'A new job awaiting the customer’s confirmation — paid from their balance like any job.',
    'کارێکی نوێ چاوەڕێی دڵنیاکردنەوەی کڕیارە — وەک هەر کارێک لە باڵانسەکەی دەدرێت.'
  ),
  note: tri('ملاحظة للسجل', 'Note for the record', 'تێبینی بۆ تۆمار'),
  decide: tri('حسم العطل', 'Resolve the failure', 'یەکلاکردنەوەی شکستەکە'),
  confirmTitle: tri('حسم هذا العطل؟', 'Resolve this failure?', 'ئەم شکستە یەکلا بکرێتەوە؟'),
  confirmText: tri('القرار نهائي: تُسوّى الحجوزات ويُسجَّل ما يُحتسب.', 'The decision is final: reservations are settled and what is charged is recorded.', 'بڕیارەکە کۆتاییە: گلدانەوەکان یەکلا دەکرێنەوە و ئەوەی حیساب دەکرێت تۆمار دەکرێت.'),
  resolved: tri('حُسم العطل', 'The failure is resolved', 'شکستەکە یەکلاکرایەوە'),
  billed: tri('الوقت المحتسب', 'Time charged', 'کاتی حیسابکراو'),
  reprintJob: tri('مهمة إعادة الطباعة', 'Reprint job', 'کاری دووبارە چاپکردنەوە'),
  reprintState: tri('حالتها', 'Its state', 'دۆخەکەی'),
  noReprint: tri('لم تُنشأ إعادة طباعة.', 'No reprint was created.', 'هیچ دووبارە چاپکردنەوەیەک دروست نەکرا.'),
  noPolicy: tri('لا سياسة لهذا الطرف في الإعدادات.', 'Settings hold no policy for this party.', 'ڕێکخستنەکان هیچ سیاسەتێکیان بۆ ئەم لایەنە نییە.'),
} satisfies Record<string, Tri>;

const REPRINT_STATE: Readonly<Record<string, Tri>> = {
  queued: tri('دخلت الطابور', 'Queued', 'چووە ڕیز'),
  confirmed: tri('مؤكَّدة — بانتظار موافقة المشغّل', 'Confirmed — awaiting operator approval', 'پشتڕاستکرایەوە — چاوەڕێی پەسەندکردنی کارپێکەرە'),
  waiting_for_customer: tri('بانتظار تأكيد العميل', 'Awaiting the customer’s confirmation', 'چاوەڕێی دڵنیاکردنەوەی کڕیارە'),
};

const PARTIES = ['workshop', 'customer', 'model', 'undetermined'] as const;

interface ResolveAnswer {
  failure_id: string;
  policy: string;
  billed_seconds: number;
  reprint_job_id: string | null;
  reprint_status: string | null;
}

export default function ResolveFailureSheet({ failure: f, money, onClose, onDone }: { failure: FailureRow; money: boolean; onClose: () => void; onDone: () => void }) {
  const { t, lang } = usePcLang();
  const refs = useRefs(['variants'], lang);
  const settings = useLoad(() => pc.get<SettingsAnswer>('/settings'), []);
  const [confirm, confirmDialog] = useConfirm();
  const wasted = parseJsonColumn<Array<{ variant_id: string; qty: number }>>(f.failed_materials_json, []);
  const [responsible, setResponsible] = useState<string>((PARTIES as readonly string[]).includes(f.responsible) ? f.responsible : 'undetermined');
  const [reprint, setReprint] = useState(false);
  const [note, setNote] = useState('');
  const [billSeconds, setBillSeconds] = useState<number | null>(null);
  const [billLines, setBillLines] = useState<MatLine[]>(() => wasted.map((m) => ({ variant_id: m.variant_id, qty: m.qty })));
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveAnswer | null>(null);
  const [tried, setTried] = useState(false);
  const titleId = `pc-failure-${f.id}`;
  const unitOf = (variantId: string) => String(refs.row('variants', variantId)?.unit_code ?? '');

  return (
    <Sheet
      open
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="ap w-full sm:max-w-xl"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
            {t(S.title)} — {f.title || f.job_id}
          </h2>
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-5">
        <section className={`${T.surface} space-y-2 p-3`}>
          <h3 className={`text-[13px] font-bold ${T.text1}`}>{t(S.reported)}</h3>
          <KV
            rows={[
              [t(S.job), <Id key="j" value={f.job_id} copy />],
              [t(S.reason), <bdi key="r" dir="ltr" className="font-mono">{f.reason_code}</bdi>],
              [t(S.reportedBy), labelOf(RESPONSIBLE, f.responsible, lang)],
              [t(S.printed), duration(f.printed_seconds, lang)],
              !!f.description && [t(S.description), f.description],
              wasted.length > 0 && [
                t(S.wasted),
                <ul key="w" className="space-y-0.5">
                  {wasted.map((m) => (
                    <li key={m.variant_id}>
                      {refs.name('variants', m.variant_id)}: {qty(m.qty, unitOf(m.variant_id), lang)}
                    </li>
                  ))}
                </ul>,
              ],
            ]}
          />
        </section>

        {result ? (
          <section className="space-y-3" aria-live="polite">
            <Note tone="success">{t(S.resolved)}</Note>
            <KV
              rows={[
                [t(S.policy), labelOf(FAILURE_POLICY, result.policy, lang)],
                [t(S.billed), duration(result.billed_seconds, lang)],
                [t(S.reprintJob), result.reprint_job_id ? <Id key="rj" value={result.reprint_job_id} copy /> : t(S.noReprint)],
                !!result.reprint_status && [t(S.reprintState), labelOf(REPRINT_STATE, result.reprint_status, lang)],
              ]}
            />
            <Act kind="primary" onClick={onClose}>
              {t(W.close)}
            </Act>
          </section>
        ) : (
          <LoadState state={settings}>
            {({ config }) => {
              const policy = config.failure_policy?.[responsible] ?? '';
              const manual = policy === 'manual_review';
              const blocked = manual && !money;
              const freeReprint = config.free_reprint_on_workshop_failure === true;
              const reprintAllowed = responsible !== 'workshop' || freeReprint;
              const billError = manual && money && billSeconds === null ? t(S.billSecondsHelp) : null;
              const submit = async () => {
                setFailure(null);
                setTried(true);
                if (blocked || billError) return;
                const ok = await confirm({
                  title: t(S.confirmTitle),
                  consequence: `${labelOf(RESPONSIBLE, responsible, lang)} · ${labelOf(FAILURE_POLICY, policy, lang)}. ${t(S.confirmText)}`,
                  confirmLabel: t(S.decide),
                });
                if (!ok) return;
                try {
                  const out = await pc.post<ResolveAnswer>(`/failures/${encodeURIComponent(f.id)}/resolve`, {
                    responsible,
                    reprint: reprint && reprintAllowed,
                    ...(note.trim() ? { note: note.trim() } : {}),
                    // Billable amounts are a money act, and only the manual policy reads them.
                    ...(manual && money ? { billable_seconds: billSeconds, billable_materials: cleanLines(billLines) } : {}),
                  });
                  setResult(out);
                  onDone();
                } catch (e) {
                  setFailure(pcRefusal(e, lang, t(W.failed)));
                }
              };
              return (
                <div className="space-y-3">
                  <SelectField
                    label={t(S.responsible)}
                    value={responsible}
                    options={PARTIES.map((p) => ({ value: p, label: labelOf(RESPONSIBLE, p, lang) }))}
                    onChange={(v) => {
                      setResponsible(v);
                      setFailure(null);
                    }}
                  />
                  <div className={`${T.surface} space-y-1 p-3 text-[12.5px]`}>
                    <p className={`font-semibold ${T.text2}`}>{t(S.policy)}</p>
                    {policy ? <StatusChip tone={policy === 'no_charge' ? 'success' : policy === 'manual_review' ? 'warning' : 'info'}>{labelOf(FAILURE_POLICY, policy, lang)}</StatusChip> : <p className={T.text3}>{t(S.noPolicy)}</p>}
                    {policy && <p className={`leading-relaxed ${T.text3}`}>{t(policy === 'no_charge' ? S.policyNoCharge : policy === 'manual_review' ? S.policyManual : S.policyPrinted)}</p>}
                  </div>
                  {blocked && <Note tone="warning">{t(S.manualNeedsMoney)}</Note>}
                  {manual && money && (
                    <>
                      <DurationInput label={t(S.billSeconds)} value={billSeconds} onChange={setBillSeconds} error={tried ? billError : null} hint={`${t(S.printed)}: ${duration(f.printed_seconds, lang)}`} />
                      <MaterialLines lines={billLines} onChange={setBillLines} refs={refs} label={t(S.billMaterials)} />
                    </>
                  )}
                  {reprintAllowed ? (
                    <div className="space-y-1">
                      <Checkbox checked={reprint} onChange={setReprint} label={t(S.reprint)} />
                      <p className={`text-[11.5px] leading-relaxed ${T.text3}`}>{t(responsible === 'workshop' ? S.reprintFree : S.reprintPaid)}</p>
                    </div>
                  ) : (
                    <Note tone="info">{t(S.reprintOff)}</Note>
                  )}
                  <TextArea label={`${t(S.note)} (${t(W.optional)})`} value={note} onChange={setNote} maxLength={500} rows={2} />
                  {failure && <Note tone="danger">{failure}</Note>}
                  <div className="flex flex-wrap gap-2">
                    <Act kind="primary" disabled={blocked || !policy} onClick={submit}>
                      {t(S.decide)}
                    </Act>
                    <Act kind="ghost" onClick={onClose}>
                      {t(W.cancel)}
                    </Act>
                  </div>
                </div>
              );
            }}
          </LoadState>
        )}
      </div>
      {confirmDialog}
    </Sheet>
  );
}
