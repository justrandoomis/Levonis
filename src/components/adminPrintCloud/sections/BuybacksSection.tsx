/**
 * BUYBACKS — material a customer sells back to the workshop (money section).
 *
 *   `GET /buybacks` (status filter; the 500 newest), and the decisions:
 *   approve (`POST /buybacks/{id}/approve`: the units leave the customer for
 *   the workshop's sellable stock and the value owed is fixed — computed by
 *   the server from what the units were bought for, at the category's rate),
 *   reject (`…/reject`, a note required: the units go back to the customer),
 *   and the payout (`…/paid`, a reference required) once the customer is paid.
 *   The estimate shown before a decision is the one recorded with the request;
 *   the final value is the server's, after approval.
 */
import { useState } from 'react';
import { Recycle } from 'lucide-react';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { StatusChip, type Tone } from '../../ui/Badge';
import { useConfirm } from '../../ui/ConfirmDialog';
import { toast } from '../../../lib/toastStore';
import { formatMoney } from '../../../lib/money';
import { enc, parseJsonColumn, pc, query, type BuybackRow } from '../api';
import { BUYBACK_STATUS, PAYOUT_STATUS, labelOf, tri, type Tri } from '../i18n';
import { bps, formatDateTime, qty } from '../format';
import { pcRefusal } from '../refusal';
import { useRefs, type RefLists } from '../refs';
import { Act, Chips, Id, Json, KV, Note, Pager, type PcColumn, PcList, RefreshButton, SectionHead, T, TextArea, TextField, Tray, useLoad, usePaged, usePcLang, W } from '../ui';
import type { SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('إعادة الشراء', 'Buybacks', 'کڕینەوە'),
  desc: tri(
    'مواد يبيعها العميل للورشة. القيمة النهائية يحسبها الخادم عند القبول من سعر شراء الوحدات وبنسبة الفئة.',
    'Material a customer sells back to the workshop. The final value is computed by the server on approval, from what the units were bought for and the category’s rate.',
    'ئەو کەرەستانەی کڕیار دەیفرۆشێتەوە بە کارگە. بەهای کۆتایی ڕاژەکار لە کاتی پەسەندکردندا دەیژمێرێت، لە نرخی کڕینی یەکەکان و ڕێژەی پۆلەکە.'
  ),
  status: tri('الحالة', 'State', 'دۆخ'),
  all: tri('الكل', 'All', 'هەموو'),
  cap: tri('أحدث 500 طلب في هذه الحالة.', 'The 500 newest requests in this state.', '500 نوێترین داواکاری لەم دۆخەدا.'),
  empty: tri('لا طلبات إعادة شراء هنا.', 'No buyback requests here.', 'هیچ داواکارییەکی کڕینەوە لێرە نییە.'),
  request: tri('الطلب', 'Request', 'داواکاری'),
  material: tri('المادة', 'Material', 'کەرەستە'),
  rate: tri('النسبة', 'Rate', 'ڕێژە'),
  estimate: tri('التقدير عند الطلب', 'Estimate at request', 'خەمڵاندن لە کاتی داواکاری'),
  final: tri('القيمة النهائية', 'Final value', 'بەهای کۆتایی'),
  payout: tri('الدفع للعميل', 'Payout', 'پارەدان بە کڕیار'),
  payoutMethod: tri('طريقة الدفع للعميل', 'Payout method', 'شێوازی پارەدان بە کڕیار'),
  created: tri('أُنشئ', 'Created', 'دروستکرا'),
  decided: tri('القرار', 'Decided', 'بڕیار'),
  note: tri('ملاحظة', 'Note', 'تێبینی'),
  lots: tri('دفعات الشراء التي جاءت منها الوحدات', 'Purchase lots the units came from', 'ئەو کۆمەڵە کڕینانەی یەکەکان لێیانەوە هاتوون'),
  approve: tri('قبول', 'Approve', 'پەسەندکردن'),
  reject: tri('رفض', 'Reject', 'ڕەتکردنەوە'),
  paid: tri('تسجيل الدفع للعميل', 'Record the payout', 'تۆمارکردنی پارەدان بە کڕیار'),
  reference: tri('مرجع الدفع (إيصال أو تحويل)', 'Payout reference (receipt or transfer)', 'سەرچاوەی پارەدان (پسوولە یان گواستنەوە)'),
  noteHint: tri('اختيارية عند القبول، ومطلوبة عند الرفض — يقرؤها العميل.', 'Optional to approve, required to reject — the customer reads it.', 'بۆ پەسەندکردن ئارەزوومەندانەیە، بۆ ڕەتکردنەوە پێویستە — کڕیار دەیخوێنێتەوە.'),
  approveAsk: tri('قبول إعادة الشراء؟', 'Approve the buyback?', 'کڕینەوەکە پەسەند بکرێت؟'),
  approveText: tri(
    'تخرج الوحدات من رصيد العميل إلى مخزون الورشة القابل للبيع، ويُثبَّت المبلغ المستحق له كما يحسبه الخادم.',
    'The units leave the customer’s balance for the workshop’s sellable stock, and the amount owed to them is fixed as the server computes it.',
    'یەکەکان لە باڵانسی کڕیارەوە دەچنە کۆگای فرۆشراوی کارگە، و ئەو بڕەی قەرزاریەتی وەک ڕاژەکار دەیژمێرێت جێگیر دەکرێت.'
  ),
  rejectAsk: tri('رفض إعادة الشراء؟', 'Reject the buyback?', 'کڕینەوەکە ڕەت بکرێتەوە؟'),
  rejectText: tri('تعود الوحدات المحجوزة إلى رصيد العميل.', 'The held units go back to the customer’s balance.', 'یەکە گیراوەکان بۆ باڵانسی کڕیار دەگەڕێنەوە.'),
  paidAsk: tri('تسجيل أن العميل قبض المبلغ؟', 'Record that the customer was paid?', 'تۆمار بکرێت کە پارە بە کڕیار درا؟'),
  paidText: tri('يُسجَّل الدفع بالمرجع المذكور — لا يمكن التراجع.', 'The payout is recorded with this reference — it cannot be undone.', 'پارەدانەکە بەم سەرچاوەیە تۆمار دەکرێت — ناگەڕێتەوە.'),
  approved: tri('قُبل — القيمة النهائية', 'Approved — final value', 'پەسەندکرا — بەهای کۆتایی'),
  rejected: tri('رُفض.', 'Rejected.', 'ڕەتکرایەوە.'),
  recorded: tri('سُجّل الدفع للعميل.', 'The payout is recorded.', 'پارەدان بە کڕیار تۆمارکرا.'),
  noteNeeded: tri('اكتب ملاحظة للعميل.', 'Write a note to the customer.', 'تێبینییەک بۆ کڕیار بنووسە.'),
  referenceNeeded: tri('أدخل مرجع الدفع.', 'Enter the payout reference.', 'سەرچاوەی پارەدان بنووسە.'),
  nothingToDo: tri('لا إجراء متاح في هذه الحالة.', 'No action is available in this state.', 'هیچ کردارێک لەم دۆخەدا بەردەست نییە.'),
} satisfies Record<string, Tri>;

const PAYOUT_METHOD: Readonly<Record<string, Tri>> = {
  manual: tri('يدوياً (نقد أو تحويل)', 'By hand (cash or transfer)', 'بە دەست (نەقد یان گواستنەوە)'),
  levonis_wallet: tri('إلى محفظة Levonis', 'To the Levonis wallet', 'بۆ جزدانی Levonis'),
};

const STATES = ['requested', 'approved', 'rejected', 'cancelled'];
const tone = (s: string): Tone => (s === 'approved' ? 'success' : s === 'requested' ? 'warning' : s === 'rejected' ? 'danger' : 'neutral');
const payoutTone = (s: string): Tone => (s === 'paid' ? 'success' : s === 'pending' ? 'warning' : 'neutral');

export default function BuybacksSection({ params }: SectionProps) {
  const { t, lang } = usePcLang();
  const [status, setStatus] = useState(params.status ?? 'requested');
  const [open, setOpen] = useState<BuybackRow | null>(null);
  const list = useLoad(() => pc.get<BuybackRow[]>(`/buybacks${query({ status })}`), [status]);
  const refs = useRefs(['variants'], lang);
  const paged = usePaged(list.data, 50);
  const unitOf = (variantId: string) => String(refs.row('variants', variantId)?.unit_code ?? '');
  const columns: PcColumn<BuybackRow>[] = [
    {
      id: 'material',
      header: t(S.material),
      card: 'title',
      cell: (b) => (
        <button type="button" className="rounded-sm text-start font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setOpen(b)}>
          {refs.name('variants', b.variant_id)} · {qty(b.qty, unitOf(b.variant_id), lang)}
        </button>
      ),
    },
    { id: 'status', header: t(S.status), card: 'badge', cell: (b) => <StatusChip tone={tone(b.status)}>{labelOf(BUYBACK_STATUS, b.status, lang)}</StatusChip> },
    { id: 'payout', header: t(S.payout), cell: (b) => <StatusChip tone={payoutTone(b.payout_status)}>{labelOf(PAYOUT_STATUS, b.payout_status, lang)}</StatusChip> },
    { id: 'rate', header: t(S.rate), numeric: true, cell: (b) => bps(b.rate_bps) },
    { id: 'estimate', header: t(S.estimate), numeric: true, cell: (b) => <Money iqd={b.estimated_value_iqd} /> },
    { id: 'final', header: t(S.final), numeric: true, cell: (b) => (b.final_value_iqd === null ? '—' : <Money iqd={b.final_value_iqd} />) },
    { id: 'user', header: t(W.user), cell: (b) => <Id value={b.user_id} /> },
    { id: 'created', header: t(S.created), card: 'meta', cell: (b) => formatDateTime(b.created_at, lang) },
  ];
  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} actions={<RefreshButton onClick={() => list.reload()} loading={list.loading} />} />
      <Chips<string> label={t(S.status)} value={status} onChange={setStatus} items={[...STATES.map((s) => ({ id: s, label: labelOf(BUYBACK_STATUS, s, lang) })), { id: '', label: t(S.all) }]} />
      <p className={`text-[11.5px] ${T.text3}`}>{t(S.cap)}</p>
      <PcList<BuybackRow>
        label={t(S.title)}
        columns={columns}
        rows={paged.slice}
        rowKey={(b) => b.id}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        empty={{ title: t(S.empty), icon: <Recycle size={22} aria-hidden /> }}
        rowLabel={(b) => b.id}
        rowActions={(b) => [{ id: 'open', label: t(W.open), onSelect: () => setOpen(b) }]}
      />
      <Pager page={paged.page} total={paged.total} onPage={paged.setPage} />
      {open && (
        <BuybackSheet
          key={open.id}
          buyback={open}
          refs={refs}
          onClose={() => setOpen(null)}
          onDone={async () => {
            setOpen(null);
            await list.reload();
          }}
        />
      )}
    </div>
  );
}

function BuybackSheet({ buyback: b, refs, onClose, onDone }: { buyback: BuybackRow; refs: RefLists; onClose: () => void; onDone: () => Promise<void> }) {
  const { t, lang } = usePcLang();
  const [confirm, confirmDialog] = useConfirm();
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const unit = String(refs.row('variants', b.variant_id)?.unit_code ?? '');
  const lots = parseJsonColumn<unknown>(b.lots_json, null);
  const titleId = `pc-buyback-${b.id}`;

  const act = async (kind: 'approve' | 'reject' | 'paid') => {
    setFailure(null);
    if (kind === 'reject' && !note.trim()) return setFailure(t(S.noteNeeded));
    if (kind === 'paid' && !reference.trim()) return setFailure(t(S.referenceNeeded));
    const ask = kind === 'approve' ? { title: t(S.approveAsk), consequence: t(S.approveText), confirmLabel: t(S.approve) } : kind === 'reject' ? { title: t(S.rejectAsk), consequence: t(S.rejectText), confirmLabel: t(S.reject), destructive: true } : { title: t(S.paidAsk), consequence: t(S.paidText), confirmLabel: t(S.paid) };
    if (!(await confirm(ask))) return;
    try {
      if (kind === 'approve') {
        const out = await pc.post<{ value_iqd: number }>(`/buybacks/${enc(b.id)}/approve`, note.trim() ? { note: note.trim() } : {});
        toast.success(`${t(S.approved)}: ${formatMoney(out.value_iqd, lang)}`);
      } else if (kind === 'reject') {
        await pc.post(`/buybacks/${enc(b.id)}/reject`, { note: note.trim() });
        toast.success(t(S.rejected));
      } else {
        await pc.post(`/buybacks/${enc(b.id)}/paid`, { reference: reference.trim() });
        toast.success(t(S.recorded));
      }
      await onDone();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };

  return (
    <Sheet open onClose={onClose} labelledBy={titleId} detents={['large']} panelClassName="ap w-full sm:max-w-xl">
      <div className="space-y-4 px-5 pb-5 pt-2">
        <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
          {t(S.request)} <Id value={b.id} copy />
        </h2>
        <section className={`${T.surface} space-y-3 p-4`}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={tone(b.status)}>{labelOf(BUYBACK_STATUS, b.status, lang)}</StatusChip>
            <StatusChip tone={payoutTone(b.payout_status)}>{labelOf(PAYOUT_STATUS, b.payout_status, lang)}</StatusChip>
          </div>
          <KV
            rows={[
              [t(W.user), <Id key="u" value={b.user_id} copy />],
              [t(S.material), `${refs.name('variants', b.variant_id)} · ${qty(b.qty, unit, lang)}`],
              [t(S.rate), bps(b.rate_bps)],
              [t(S.estimate), <Money key="e" iqd={b.estimated_value_iqd} />],
              [t(S.final), b.final_value_iqd === null ? '—' : <Money key="f" iqd={b.final_value_iqd} />],
              [t(S.payoutMethod), labelOf(PAYOUT_METHOD, b.payout_method, lang)],
              [t(S.created), formatDateTime(b.created_at, lang)],
              !!b.decided_at && [t(S.decided), `${formatDateTime(b.decided_at, lang)}${b.decided_by ? ` · ${b.decided_by}` : ''}`],
              !!b.note && [t(S.note), b.note],
            ]}
          />
        </section>
        {lots !== null && (
          <Tray title={t(S.lots)}>
            <Json value={lots} />
          </Tray>
        )}
        {b.status === 'requested' ? (
          <div className="space-y-3">
            <TextArea label={t(S.note)} hint={t(S.noteHint)} value={note} onChange={setNote} maxLength={500} rows={2} />
            {failure && <Note tone="danger">{failure}</Note>}
            <div className="flex flex-wrap gap-2">
              <Act kind="primary" onClick={() => act('approve')}>
                {t(S.approve)}
              </Act>
              <Act kind="danger" onClick={() => act('reject')}>
                {t(S.reject)}
              </Act>
            </div>
          </div>
        ) : b.status === 'approved' && b.payout_status === 'pending' ? (
          <div className="space-y-3">
            <TextField label={t(S.reference)} value={reference} onChange={setReference} ltr maxLength={200} />
            {failure && <Note tone="danger">{failure}</Note>}
            <Act kind="primary" onClick={() => act('paid')}>
              {t(S.paid)}
            </Act>
          </div>
        ) : (
          <p className={`text-[12.5px] ${T.text3}`}>{t(S.nothingToDo)}</p>
        )}
      </div>
      {confirmDialog}
    </Sheet>
  );
}
