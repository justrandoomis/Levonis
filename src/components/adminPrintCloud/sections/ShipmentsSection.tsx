/**
 * SHIPMENTS — finished prints and owned material leaving the workshop.
 *
 *   List      `GET /shipments` (status filter; the 500 newest, paged here).
 *   One       `GET /shipments/{id}`: the address, the packing list (prints
 *             and material), carrier and tracking — and the delivery fee
 *             with its fee order for money scope only (the server removes
 *             both for everyone else).
 *   Moves     `POST /shipments/{id}/advance`, only the moves the server's
 *             machine allows from the state (jobRules.ts `shipmentMoves`):
 *             a shipment waiting for its fee moves on when the fee is PAID,
 *             never by hand — cancelling it closes the unpaid fee order with
 *             it. Hand-over (shipped, picked up) settles the material.
 */
import { useMemo, useState } from 'react';
import { Truck } from 'lucide-react';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { StatusChip, type Tone } from '../../ui/Badge';
import { useConfirm } from '../../ui/ConfirmDialog';
import { toast } from '../../../lib/toastStore';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { usePcAccess } from '../access';
import { enc, parseJsonColumn, pc, query, type ShipmentDetail, type ShipmentRow } from '../api';
import { SHIPMENT_KIND, SHIPMENT_STATUS, labelOf, tri, type Tri } from '../i18n';
import { shipmentMoves } from '../jobRules';
import { formatDateTime, qty } from '../format';
import { pcRefusal } from '../refusal';
import { useRefs } from '../refs';
import { Act, Chips, Id, KV, LoadState, Note, Pager, type PcColumn, PcList, RefreshButton, SectionHead, T, TextArea, TextField, Tray, useLoad, usePaged, usePcLang, W } from '../ui';
import type { Go, SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('الشحنات', 'Shipments', 'ناردنەکان'),
  desc: tri(
    'استلام من الورشة أو توصيل للمطبوعات المنتهية وللمواد التي يملكها العميل. التسليم يُخرج المادة من الرف.',
    'Pickup at the workshop or delivery of finished prints and of material the customer owns. Hand-over takes the material off the shelf.',
    'وەرگرتن لە کارگە یان گەیاندنی چاپە تەواوبووەکان و ئەو کەرەستانەی کڕیار خاوەنیانە. ڕادەستکردن کەرەستەکە لە ڕەف دەردەهێنێت.'
  ),
  status: tri('الحالة', 'State', 'دۆخ'),
  all: tri('الكل', 'All', 'هەموو'),
  search: tri('بحث بالمعرّف أو العميل أو رقم التتبع', 'Search by id, customer or tracking number', 'گەڕان بە ناسنامە یان کڕیار یان ژمارەی بەدواداچوون'),
  cap: tri('أحدث 500 شحنة في هذه الحالة.', 'The 500 newest shipments in this state.', '500 نوێترین ناردن لەم دۆخەدا.'),
  empty: tri('لا شحنات هنا.', 'No shipments here.', 'هیچ ناردنێک لێرە نییە.'),
  shipment: tri('الشحنة', 'Shipment', 'ناردن'),
  kind: tri('النوع', 'Kind', 'جۆر'),
  where: tri('المحافظة', 'Governorate', 'پارێزگا'),
  tracking: tri('رقم التتبع', 'Tracking number', 'ژمارەی بەدواداچوون'),
  carrier: tri('شركة الشحن', 'Carrier', 'کۆمپانیای گواستنەوە'),
  fee: tri('رسوم التوصيل', 'Delivery fee', 'کرێی گەیاندن'),
  feeOrder: tri('طلب الرسوم', 'Fee order', 'داواکاریی کرێ'),
  openFeeOrder: tri('فتح طلب الرسوم', 'Open the fee order', 'کردنەوەی داواکاریی کرێ'),
  packaging: tri('التغليف', 'Packaging', 'پێچانەوە'),
  notes: tri('ملاحظات', 'Notes', 'تێبینی'),
  created: tri('أُنشئت', 'Created', 'دروستکرا'),
  updated: tri('آخر تحديث', 'Last update', 'دوایین نوێکردنەوە'),
  closed: tri('أُغلقت', 'Closed', 'داخرا'),
  address: tri('العنوان', 'Address', 'ناونیشان'),
  recipient: tri('المستلم', 'Recipient', 'وەرگر'),
  phone: tri('الهاتف', 'Phone', 'تەلەفۆن'),
  city: tri('المدينة', 'City', 'شار'),
  line: tri('العنوان التفصيلي', 'Address line', 'ناونیشانی ورد'),
  addressNotes: tri('ملاحظات العميل', 'Customer notes', 'تێبینی کڕیار'),
  items: tri('ما تحمله', 'What it carries', 'ئەوەی هەڵیدەگرێت'),
  noItems: tri('لا عناصر.', 'No items.', 'هیچ بڕگەیەک نییە.'),
  print: tri('مطبوعة منتهية', 'Finished print', 'چاپی تەواوبوو'),
  material: tri('مادة يملكها العميل', 'Material the customer owns', 'کەرەستەی موڵکی کڕیار'),
  released: tri('(أُعيدت — لم تعد ضمنها)', '(released — no longer in it)', '(ئازادکرا — ئیتر تێیدا نییە)'),
  openJob: tri('فتح المهمة', 'Open the job', 'کردنەوەی کار'),
  moves: tri('الخطوة التالية', 'Next step', 'هەنگاوی دواتر'),
  noMoves: tri('لا خطوة متاحة من هذه الحالة.', 'No step is available from this state.', 'هیچ هەنگاوێک لەم دۆخەوە بەردەست نییە.'),
  waitingFee: tri(
    'تنتظر دفع رسوم التوصيل: تنتقل وحدها إلى التجهيز عند الدفع. إلغاؤها يغلق طلب الرسوم غير المدفوع معها.',
    'Waiting for its delivery fee: it moves to preparation by itself once paid. Cancelling it closes the unpaid fee order with it.',
    'چاوەڕێی پارەدانی کرێی گەیاندنە: کە پارە درا خۆی دەچێتە ئامادەکردن. هەڵوەشاندنەوەی داواکاریی کرێی پارە نەدراو لەگەڵیدا دادەخات.'
  ),
  note: tri('ملاحظة (اختياري)', 'Note (optional)', 'تێبینی (ئارەزوومەندانە)'),
  confirmTitle: tri('تنفيذ هذه الخطوة؟', 'Take this step?', 'ئەم هەنگاوە بنرێت؟'),
  handover: tri('التسليم يُخرج المادة من الرف ويسوّي حجوزات العميل — لا يمكن التراجع.', 'Hand-over takes the material off the shelf and settles the customer’s holds — it cannot be undone.', 'ڕادەستکردن کەرەستەکە لە ڕەف دەردەهێنێت و گلدانەوەکانی کڕیار یەکلا دەکاتەوە — ناگەڕێتەوە.'),
  cancelText: tri('تُلغى الشحنة وتعود المادة المحجوزة إلى رصيد العميل — لا يمكن التراجع.', 'The shipment is cancelled and the held material goes back to the customer’s balance — it cannot be undone.', 'ناردنەکە هەڵدەوەشێتەوە و کەرەستە گیراوەکە بۆ باڵانسی کڕیار دەگەڕێتەوە — ناگەڕێتەوە.'),
  finalText: tri('خطوة نهائية — لا يمكن التراجع.', 'A final step — it cannot be undone.', 'هەنگاوێکی کۆتایی — ناگەڕێتەوە.'),
  moved: tri('تم — الحالة الآن', 'Done — now', 'ئەنجامدرا — ئێستا'),
} satisfies Record<string, Tri>;

const MOVE_LABEL: Readonly<Record<string, Tri>> = {
  ready_for_pickup: tri('جاهزة للاستلام', 'Ready for pickup', 'ئامادەیە بۆ وەرگرتن'),
  shipped: tri('تسجيل الشحن', 'Record as shipped', 'تۆمارکردن وەک نێردراو'),
  picked_up: tri('تسجيل استلام العميل', 'Record the pickup', 'تۆمارکردنی وەرگرتن'),
  delivered: tri('تسجيل التسليم', 'Record the delivery', 'تۆمارکردنی گەیاندن'),
  cancelled: tri('إلغاء الشحنة', 'Cancel the shipment', 'هەڵوەشاندنەوەی ناردن'),
};

const PACKAGING: Readonly<Record<string, Tri>> = {
  standard: tri('عادي', 'Standard', 'ئاسایی'),
};

const STATES = ['awaiting_payment', 'preparing', 'ready_for_pickup', 'shipped', 'delivered', 'picked_up', 'cancelled'];

const tone = (s: string): Tone => (s === 'delivered' || s === 'picked_up' ? 'success' : s === 'awaiting_payment' ? 'warning' : s === 'cancelled' ? 'neutral' : 'info');

const governorateOf = (raw: string | null, lang: 'ar' | 'en' | 'ckb'): string => {
  const a = parseJsonColumn<Record<string, string> | null>(raw, null);
  return a?.governorate ? labelOf(GOVERNORATE_LABELS, a.governorate, lang) : '—';
};

export default function ShipmentsSection({ params, go }: SectionProps) {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const [status, setStatus] = useState(params.status ?? '');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(params.shipment ?? null);
  const list = useLoad(() => pc.get<ShipmentRow[]>(`/shipments${query({ status })}`), [status]);
  const needle = search.trim().toLowerCase();
  const rows = useMemo(
    () => (list.data && needle ? list.data.filter((s) => [s.id, s.user_id, s.tracking_ref].some((v) => String(v ?? '').toLowerCase().includes(needle))) : list.data),
    [list.data, needle]
  );
  const paged = usePaged(rows, 50);
  const columns: PcColumn<ShipmentRow>[] = [
    {
      id: 'id',
      header: t(S.shipment),
      card: 'title',
      cell: (s) => (
        <button type="button" className="rounded-sm text-start font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setOpen(s.id)}>
          <Id value={s.id} />
        </button>
      ),
    },
    { id: 'status', header: t(S.status), card: 'badge', cell: (s) => <StatusChip tone={tone(s.status)}>{labelOf(SHIPMENT_STATUS, s.status, lang)}</StatusChip> },
    { id: 'kind', header: t(S.kind), cell: (s) => labelOf(SHIPMENT_KIND, s.kind, lang) },
    { id: 'where', header: t(S.where), cell: (s) => (s.kind === 'delivery' ? governorateOf(s.address_json, lang) : '—') },
    { id: 'tracking', header: t(S.tracking), cell: (s) => (s.tracking_ref ? <bdi dir="ltr">{s.tracking_ref}</bdi> : '—') },
    ...(access.money ? [{ id: 'fee', header: t(S.fee), numeric: true, cell: (s: ShipmentRow) => (typeof s.fee_iqd === 'number' ? <Money iqd={s.fee_iqd} /> : '—') }] : []),
    { id: 'user', header: t(W.user), cell: (s) => <Id value={s.user_id} /> },
    { id: 'created', header: t(S.created), card: 'meta', cell: (s) => formatDateTime(s.created_at, lang) },
  ];
  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} actions={<RefreshButton onClick={() => list.reload()} loading={list.loading} />} />
      <Chips<string> label={t(S.status)} value={status} onChange={setStatus} items={[{ id: '', label: t(S.all) }, ...STATES.map((s) => ({ id: s, label: labelOf(SHIPMENT_STATUS, s, lang) }))]} />
      <TextField label={t(S.search)} value={search} onChange={setSearch} ltr maxLength={120} className="max-w-md" />
      <p className={`text-[11.5px] ${T.text3}`}>{t(S.cap)}</p>
      <PcList<ShipmentRow>
        label={t(S.title)}
        columns={columns}
        rows={paged.slice}
        rowKey={(s) => s.id}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        empty={{ title: t(S.empty), icon: <Truck size={22} aria-hidden /> }}
        rowLabel={(s) => s.id}
        rowActions={(s) => [{ id: 'open', label: t(W.open), onSelect: () => setOpen(s.id) }]}
      />
      <Pager page={paged.page} total={paged.total} onPage={paged.setPage} />
      {open && <ShipmentSheet key={open} id={open} money={access.money} go={go} onClose={() => setOpen(null)} onMoved={() => void list.reload()} />}
    </div>
  );
}

function ShipmentSheet({ id, money, go, onClose, onMoved }: { id: string; money: boolean; go: Go; onClose: () => void; onMoved: () => void }) {
  const { t, lang } = usePcLang();
  const detail = useLoad(() => pc.get<ShipmentDetail>(`/shipments/${enc(id)}`), [id]);
  const refs = useRefs(['variants'], lang);
  const titleId = `pc-shipment-${id}`;
  return (
    <Sheet
      open
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="ap w-full sm:max-w-xl"
      header={
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-2 pt-1">
          <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
            {t(S.shipment)} <Id value={id} copy />
          </h2>
          <RefreshButton onClick={() => detail.reload()} loading={detail.loading} />
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-5">
        <LoadState state={detail}>
          {(s) => {
            const a = s.address;
            return (
              <>
                <section className={`${T.surface} space-y-3 p-4`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip tone={tone(s.status)}>{labelOf(SHIPMENT_STATUS, s.status, lang)}</StatusChip>
                    <span className={`text-[12px] ${T.text3}`}>{labelOf(SHIPMENT_KIND, s.kind, lang)}</span>
                  </div>
                  <KV
                    rows={[
                      [t(W.user), <Id key="u" value={s.user_id} copy />],
                      [t(S.packaging), labelOf(PACKAGING, s.packaging, lang)],
                      !!s.carrier && [t(S.carrier), s.carrier],
                      !!s.tracking_ref && [t(S.tracking), <bdi key="tr" dir="ltr">{s.tracking_ref}</bdi>],
                      money && typeof s.fee_iqd === 'number' && [t(S.fee), <Money key="f" iqd={s.fee_iqd} />],
                      money && !!s.fee_order_id && [t(S.feeOrder), <Id key="fo" value={s.fee_order_id} copy />],
                      !!s.notes && [t(S.notes), s.notes],
                      [t(S.created), formatDateTime(s.created_at, lang)],
                      [t(S.updated), formatDateTime(s.updated_at, lang)],
                      !!s.closed_at && [t(S.closed), formatDateTime(s.closed_at, lang)],
                    ]}
                  />
                  {money && s.fee_order_id && (
                    <Act kind="ghost" onClick={() => go('orders', { order: s.fee_order_id as string })}>
                      {t(S.openFeeOrder)}
                    </Act>
                  )}
                </section>

                {a && (
                  <Tray title={t(S.address)}>
                    <KV
                      rows={[
                        [t(S.recipient), a.recipient_name || '—'],
                        [t(S.phone), <bdi key="ph" dir="ltr">{a.phone || '—'}</bdi>],
                        [t(S.where), a.governorate ? labelOf(GOVERNORATE_LABELS, a.governorate, lang) : '—'],
                        [t(S.city), a.city || '—'],
                        [t(S.line), a.address_line || '—'],
                        !!a.notes && [t(S.addressNotes), a.notes],
                      ]}
                    />
                  </Tray>
                )}

                <Tray title={t(S.items)}>
                  {s.items.length === 0 ? (
                    <p className={`text-[12.5px] ${T.text3}`}>{t(S.noItems)}</p>
                  ) : (
                    <ul className="space-y-1.5 text-[12.5px]">
                      {s.items.map((it) => (
                        <li key={it.id} className="flex flex-wrap items-center justify-between gap-2">
                          <span className={it.live ? T.text1 : T.text3}>
                            {it.item_type === 'print_job' ? t(S.print) : `${t(S.material)}: ${refs.name('variants', it.variant_id)} · ${qty(it.qty, String(refs.row('variants', it.variant_id)?.unit_code ?? ''), lang)}`}
                            {!it.live && ` ${t(S.released)}`}
                          </span>
                          {it.item_type === 'print_job' && it.job_id && (
                            <button type="button" className={T.btnGhostSm} onClick={() => go('jobs', { job: it.job_id as string })}>
                              {t(S.openJob)} <Id value={it.job_id} />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Tray>

                <Moves shipment={s} reload={detail.reload} onMoved={onMoved} />
              </>
            );
          }}
        </LoadState>
      </div>
    </Sheet>
  );
}

function Moves({ shipment: s, reload, onMoved }: { shipment: ShipmentDetail; reload: () => Promise<void>; onMoved: () => void }) {
  const { t, lang } = usePcLang();
  const [confirm, confirmDialog] = useConfirm();
  const [carrier, setCarrier] = useState(s.carrier);
  const [tracking, setTracking] = useState(s.tracking_ref);
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const moves = shipmentMoves(s.status, s.kind);

  const move = async (to: string) => {
    setFailure(null);
    const consequence = to === 'cancelled' ? t(S.cancelText) : to === 'shipped' || to === 'picked_up' ? t(S.handover) : t(S.finalText);
    const ok = await confirm({ title: `${t(S.confirmTitle)} — ${t(MOVE_LABEL[to] ?? S.moves)}`, consequence, confirmLabel: t(MOVE_LABEL[to] ?? S.moves), destructive: to === 'cancelled' });
    if (!ok) return;
    try {
      await pc.post(`/shipments/${enc(s.id)}/advance`, {
        to,
        ...(to === 'shipped' && carrier.trim() ? { carrier: carrier.trim() } : {}),
        ...(to === 'shipped' && tracking.trim() ? { tracking_ref: tracking.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(`${t(S.moved)}: ${labelOf(SHIPMENT_STATUS, to, lang)}`);
      setNote('');
      onMoved();
      await reload();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };

  return (
    <Tray title={t(S.moves)}>
      <div className="space-y-3">
        {s.status === 'awaiting_payment' && <Note tone="info">{t(S.waitingFee)}</Note>}
        {moves.length === 0 ? (
          <p className={`text-[12.5px] ${T.text3}`}>{t(S.noMoves)}</p>
        ) : (
          <>
            {moves.includes('shipped') && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField label={t(S.carrier)} value={carrier} onChange={setCarrier} maxLength={80} />
                <TextField label={t(S.tracking)} value={tracking} onChange={setTracking} ltr maxLength={120} />
              </div>
            )}
            <TextArea label={t(S.note)} value={note} onChange={setNote} maxLength={300} rows={2} />
            {failure && <Note tone="danger">{failure}</Note>}
            <div className="flex flex-wrap gap-2">
              {moves.map((to) => (
                <Act key={to} kind={to === 'cancelled' ? 'danger' : 'primary'} onClick={() => move(to)}>
                  {t(MOVE_LABEL[to] ?? S.moves)}
                </Act>
              ))}
            </div>
          </>
        )}
      </div>
      {confirmDialog}
    </Tray>
  );
}
