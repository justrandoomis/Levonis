/**
 * ONE CUSTOMER'S PRINT CLOUD BALANCES — a money section (full admin).
 *
 *   Lookup       by e-mail through the platform's exact-match lookup
 *                (`GET /api/admin/users/lookup?email=` — one account, never a
 *                near match), or by the account id itself.
 *   The record   `GET /customers/{userId}`: hour balances per tier, material
 *                balances per variant, the 100 newest orders, jobs and ledger
 *                entries of each kind.
 *   Corrections  `POST /customers/{userId}/credits/adjust` and
 *                `…/inventory/adjust` — a compensating, audited ledger entry,
 *                never an edit, with an Idempotency-Key minted per correction
 *                and reused by every retry of it (a changed correction is a
 *                new key). Granting material allocates it from the
 *                workshop's sellable stock; taking it back returns it.
 */
import { useState } from 'react';
import { Search, UserRound } from 'lucide-react';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { StatusChip } from '../../ui/Badge';
import { Checkbox } from '../../ui/Switch';
import { useConfirm } from '../../ui/ConfirmDialog';
import { toast } from '../../../lib/toastStore';
import { api, ApiError } from '../../../lib/api';
import { enc, newIdempotencyKey, pc, query, type CustomerView, type Row, type UserLookup } from '../api';
import { JOB_STATUS, ORDER_STATUS, labelOf, tri, type Tri } from '../i18n';
import { duration, formatDateTime, qty, signedDuration } from '../format';
import { pcRefusal } from '../refusal';
import { useRefs, type RefLists } from '../refs';
import { Act, Empty, Id, IntField, KV, LoadState, Note, RefreshButton, SectionHead, SelectField, T, TextArea, TextField, Tray, W, useLoad, usePcLang } from '../ui';
import { DurationInput } from './catalog/fieldInputs';
import type { Go, SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('العملاء', 'Customers', 'کڕیاران'),
  desc: tri(
    'أرصدة عميل واحد في الطباعة السحابية: ساعاته وموادّه وطلباته ومهامه وسجلّه، وتصحيح الرصيد بقيد معوِّض مدقَّق.',
    'One customer’s Print Cloud balances: hours, materials, orders, jobs and ledger — and a balance correction as an audited compensating entry.',
    'باڵانسەکانی یەک کڕیار لە چاپی هەوری: کاتژمێر و کەرەستە و داواکاری و کار و تۆمار — و ڕاستکردنەوەی باڵانس بە تۆمارێکی قەرەبووکەرەوەی وردبینیکراو.'
  ),
  lookup: tri('البريد الإلكتروني أو معرّف الحساب', 'E-mail or account id', 'ئیمەیڵ یان ناسنامەی هەژمار'),
  lookupHint: tri('البريد يجب أن يطابق الحساب تماماً.', 'An e-mail must match the account exactly.', 'ئیمەیڵ دەبێت ڕێک وەک هی هەژمارەکە بێت.'),
  find: tri('عرض', 'Show', 'پیشاندان'),
  notFound: tri('لا حساب بهذا البريد.', 'No account has that e-mail.', 'هیچ هەژمارێک ئەو ئیمەیڵەی نییە.'),
  start: tri('ابحث عن عميل بالبريد أو المعرّف لعرض أرصدته.', 'Look a customer up by e-mail or id to see their balances.', 'کڕیارێک بە ئیمەیڵ یان ناسنامە بدۆزەرەوە بۆ بینینی باڵانسەکانی.'),
  name: tri('الاسم', 'Name', 'ناو'),
  email: tri('البريد', 'E-mail', 'ئیمەیڵ'),
  username: tri('اسم المستخدم', 'Username', 'ناوی بەکارهێنەر'),
  account: tri('الحساب', 'Account', 'هەژمار'),
  hours: tri('رصيد الساعات', 'Hour balances', 'باڵانسی کاتژمێر'),
  noHours: tri('لا رصيد ساعات.', 'No hour balance.', 'هیچ باڵانسێکی کاتژمێر نییە.'),
  tier: tri('الفئة', 'Tier', 'پلە'),
  available: tri('المتاح', 'Available', 'بەردەست'),
  reserved: tri('المحجوز لمهام', 'Reserved for jobs', 'گیراو بۆ کارەکان'),
  consumed: tri('المستهلك', 'Used', 'بەکارهاتوو'),
  materials: tri('رصيد المواد', 'Material balances', 'باڵانسی کەرەستە'),
  noMaterials: tri('لا رصيد مواد.', 'No material balance.', 'هیچ باڵانسێکی کەرەستە نییە.'),
  variant: tri('الصنف', 'Variant', 'جۆر'),
  orders: tri('الطلبات', 'Orders', 'داواکارییەکان'),
  noOrders: tri('لا طلبات.', 'No orders.', 'هیچ داواکارییەک نییە.'),
  jobs: tri('المهام', 'Jobs', 'کارەکان'),
  noJobs: tri('لا مهام.', 'No jobs.', 'هیچ کارێک نییە.'),
  creditLedger: tri('سجل الساعات (أحدث 100)', 'Hour ledger (100 newest)', 'تۆماری کاتژمێر (100 نوێترین)'),
  inventoryLedger: tri('سجل المواد (أحدث 100)', 'Material ledger (100 newest)', 'تۆماری کەرەستە (100 نوێترین)'),
  noEntries: tri('لا قيود.', 'No entries.', 'هیچ تۆمارێک نییە.'),
  value: tri('القيمة', 'Value', 'بەها'),
  adjustHours: tri('تصحيح رصيد الساعات', 'Correct the hour balance', 'ڕاستکردنەوەی باڵانسی کاتژمێر'),
  adjustMaterials: tri('تصحيح رصيد المواد', 'Correct the material balance', 'ڕاستکردنەوەی باڵانسی کەرەستە'),
  direction: tri('الاتجاه', 'Direction', 'ئاراستە'),
  add: tri('إضافة إلى رصيد العميل', 'Add to the customer’s balance', 'زیادکردن بۆ باڵانسی کڕیار'),
  remove: tri('سحب من رصيد العميل', 'Take from the customer’s balance', 'لابردن لە باڵانسی کڕیار'),
  howMuch: tri('المقدار', 'How much', 'چەند'),
  compensation: tri('تعويض عن خطأ من الورشة', 'Compensation for a workshop mistake', 'قەرەبوو بۆ هەڵەیەکی کارگە'),
  adjustHelp: tri(
    'قيد معوِّض مدقَّق — لا يُعدَّل أي قيد سابق. يُسجَّل باسمك مع السبب.',
    'An audited compensating entry — no earlier entry is edited. It is recorded under your name with the reason.',
    'تۆمارێکی قەرەبووکەرەوەی وردبینیکراو — هیچ تۆمارێکی پێشوو دەستکاری ناکرێت. بە ناوی تۆ و لەگەڵ هۆکارەکە تۆمار دەکرێت.'
  ),
  stockNote: tri(
    'إضافة مادة تخصّصها من مخزون الورشة القابل للبيع (ولا تتجاوز ما على الرف)؛ سحبها يعيدها إليه.',
    'Adding material allocates it from the workshop’s sellable stock (never beyond what is on the shelf); taking it back returns it there.',
    'زیادکردنی کەرەستە لە کۆگای فرۆشراوی کارگە تەرخانی دەکات (هەرگیز زیاتر لەوەی لەسەر ڕەفە نا)؛ لابردنی دەیگەڕێنێتەوە بۆ ئەوێ.'
  ),
  apply: tri('تسجيل التصحيح', 'Record the correction', 'تۆمارکردنی ڕاستکردنەوە'),
  ask: tri('تسجيل هذا التصحيح؟', 'Record this correction?', 'ئەم ڕاستکردنەوەیە تۆمار بکرێت؟'),
  askText: tri('يُسجَّل نهائياً في سجل العميل ويُبلَّغ به.', 'It is recorded for good in the customer’s ledger and they are notified.', 'بە یەکجاری لە تۆماری کڕیاردا تۆمار دەکرێت و ئاگادار دەکرێتەوە.'),
  done: tri('سُجّل التصحيح', 'The correction is recorded', 'ڕاستکردنەوەکە تۆمارکرا'),
  replayed: tri('(كان مسجّلاً من قبل — لم يتكرر)', '(it was already recorded — not repeated)', '(پێشتر تۆمارکرابوو — دووبارە نەکرایەوە)'),
  pick: tri('اختر.', 'Choose one.', 'یەکێک هەڵبژێرە.'),
  amountNeeded: tri('أدخل مقداراً أكبر من صفر.', 'Enter an amount above zero.', 'بڕێکی سەروو سفر بنووسە.'),
  reasonNeeded: tri('اذكر السبب.', 'State the reason.', 'هۆکارەکە بنووسە.'),
  balanceNow: tri('الرصيد الآن', 'Balance now', 'باڵانسی ئێستا'),
  idOnly: tri(
    'بُحث بالمعرّف: هذه القراءة لا تؤكد وجود الحساب — معرّف غير موجود يظهر بأرصدة فارغة. البحث بالبريد يؤكده.',
    'Looked up by id: this read does not confirm that the account exists — an unknown id shows empty balances. A lookup by e-mail confirms it.',
    'بە ناسنامە گەڕا: ئەم خوێندنەوەیە دڵنیایی نادات کە هەژمارەکە هەیە — ناسنامەیەکی نەناسراو باڵانسی بەتاڵ پیشان دەدات. گەڕان بە ئیمەیڵ دڵنیای دەکاتەوە.'
  ),
} satisfies Record<string, Tri>;

const LEDGER_ENTRY: Readonly<Record<string, Tri>> = {
  purchase: tri('شراء', 'Purchase', 'کڕین'),
  reserve: tri('حجز لمهمة', 'Reserved for a job', 'گیرا بۆ کارێک'),
  release: tri('تحرير حجز', 'Reservation released', 'گلدانەوە ئازادکرا'),
  consume: tri('استهلاك', 'Used', 'بەکارهات'),
  refund: tri('استرداد', 'Refund', 'گەڕاندنەوە'),
  adjust_credit: tri('تصحيح بالإضافة', 'Correction — added', 'ڕاستکردنەوە — زیادکرا'),
  adjust_debit: tri('تصحيح بالسحب', 'Correction — taken', 'ڕاستکردنەوە — لابرا'),
  conversion_in: tri('تحويل وارد', 'Converted in', 'گۆڕینەوەی هاتوو'),
  conversion_out: tri('تحويل صادر', 'Converted out', 'گۆڕینەوەی ڕۆیشتوو'),
  expire: tri('انتهت صلاحيته', 'Expired', 'بەسەرچوو'),
  compensation: tri('تعويض', 'Compensation', 'قەرەبوو'),
  deliver: tri('سُلّم للعميل', 'Delivered to the customer', 'درا بە کڕیار'),
  buyback: tri('إعادة شراء', 'Buyback', 'کڕینەوە'),
};

/** A signed quantity in a unit: «+200 g», «−20 pcs». */
function signedQty(n: number, unit: string, lang: 'ar' | 'en' | 'ckb'): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${qty(Math.abs(n), unit, lang)}`;
}

export default function CustomersSection({ params, go }: SectionProps) {
  const { t, lang } = usePcLang();
  const [input, setInput] = useState(params.user ?? '');
  const [userId, setUserId] = useState<string | null>(params.user ?? null);
  const [identity, setIdentity] = useState<UserLookup | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const find = async () => {
    setFailure(null);
    const v = input.trim();
    if (!v) return;
    if (!v.includes('@')) {
      setIdentity(null);
      setUserId(v);
      return;
    }
    try {
      const res = await api.get<{ success: true; user: UserLookup }>(`/api/admin/users/lookup${query({ email: v })}`);
      setIdentity(res.user);
      setUserId(res.user.id);
    } catch (e) {
      setFailure(e instanceof ApiError && e.status === 404 ? t(S.notFound) : pcRefusal(e, lang, t(W.failed)));
    }
  };

  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} />
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <TextField className="min-w-[15rem] flex-1" label={t(S.lookup)} hint={t(S.lookupHint)} value={input} onChange={setInput} ltr maxLength={200} />
        <Act type="submit" kind="primary" icon={<Search size={14} aria-hidden />}>
          {t(S.find)}
        </Act>
      </form>
      {failure && <Note tone="danger">{failure}</Note>}
      {userId ? <CustomerRecord key={userId} userId={userId} identity={identity} go={go} /> : <Empty title={t(S.start)} icon={<UserRound size={22} aria-hidden />} />}
    </div>
  );
}

function CustomerRecord({ userId, identity, go }: { userId: string; identity: UserLookup | null; go: Go }) {
  const { t, lang } = usePcLang();
  const view = useLoad(() => pc.get<CustomerView>(`/customers/${enc(userId)}`), [userId]);
  const refs = useRefs(['tiers', 'variants'], lang);
  const [adjusting, setAdjusting] = useState<'credits' | 'inventory' | null>(null);
  return (
    <div className="space-y-4">
      <section className={`${T.surface} flex flex-wrap items-start justify-between gap-3 p-4`}>
        <KV
          rows={[
            [t(S.account), <Id key="id" value={userId} copy />],
            !!identity && [t(S.name), identity.name || '—'],
            !!identity && [t(S.email), <bdi key="e" dir="ltr">{identity.email}</bdi>],
            !!identity?.username && [t(S.username), <bdi key="un" dir="ltr">{identity.username}</bdi>],
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <RefreshButton onClick={() => view.reload()} loading={view.loading} />
          <Act onClick={() => setAdjusting('credits')}>{t(S.adjustHours)}</Act>
          <Act onClick={() => setAdjusting('inventory')}>{t(S.adjustMaterials)}</Act>
        </div>
      </section>

      {!identity && <Note tone="info">{t(S.idOnly)}</Note>}
      <LoadState state={view}>
        {(v) => (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Tray title={t(S.hours)}>
              {v.credits.length === 0 ? (
                <p className={`text-[12.5px] ${T.text3}`}>{t(S.noHours)}</p>
              ) : (
                <ul className="space-y-2 text-[12.5px]">
                  {v.credits.map((c) => (
                    <li key={c.tier_id} className="space-y-0.5">
                      <p className={`font-semibold ${T.text1}`}>{refs.name('tiers', c.tier_id)}</p>
                      <p className={T.text2}>
                        {t(S.available)}: {duration(c.available_seconds, lang)} · {t(S.reserved)}: {duration(c.reserved_seconds, lang)} · {t(S.consumed)}: {duration(c.consumed_seconds, lang)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Tray>

            <Tray title={t(S.materials)}>
              {v.inventory.length === 0 ? (
                <p className={`text-[12.5px] ${T.text3}`}>{t(S.noMaterials)}</p>
              ) : (
                <ul className="space-y-2 text-[12.5px]">
                  {v.inventory.map((m) => (
                    <li key={m.variant_id} className="space-y-0.5">
                      <p className={`font-semibold ${T.text1}`}>{refs.name('variants', m.variant_id)}</p>
                      <p className={T.text2}>
                        {t(S.available)}: {qty(m.available_qty, m.unit_code, lang)} · {t(S.reserved)}: {qty(m.reserved_qty, m.unit_code, lang)} · {t(S.consumed)}: {qty(m.consumed_qty, m.unit_code, lang)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Tray>

            <Tray title={t(S.orders)}>
              {v.orders.length === 0 ? (
                <p className={`text-[12.5px] ${T.text3}`}>{t(S.noOrders)}</p>
              ) : (
                <ul className="space-y-1.5 text-[12.5px]">
                  {v.orders.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
                      <button type="button" className={T.btnGhostSm} onClick={() => go('orders', { order: o.id })}>
                        <Id value={o.id} />
                      </button>
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusChip tone={o.status === 'fulfilled' ? 'success' : o.status === 'awaiting_payment' ? 'warning' : 'neutral'}>{labelOf(ORDER_STATUS, o.status, lang)}</StatusChip>
                        <Money iqd={o.total_iqd} />
                        <span className={T.text3}>{formatDateTime(o.created_at, lang)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Tray>

            <Tray title={t(S.jobs)}>
              {v.jobs.length === 0 ? (
                <p className={`text-[12.5px] ${T.text3}`}>{t(S.noJobs)}</p>
              ) : (
                <ul className="space-y-1.5 text-[12.5px]">
                  {v.jobs.map((j) => (
                    <li key={j.id} className="flex flex-wrap items-center justify-between gap-2">
                      <button type="button" className={`${T.btnGhostSm} min-w-0`} onClick={() => go('jobs', { job: j.id })}>
                        <span className="truncate">{j.title || j.id}</span>
                      </button>
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusChip tone="neutral">{labelOf(JOB_STATUS, j.status, lang)}</StatusChip>
                        <span className={T.text3}>{formatDateTime(j.created_at, lang)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Tray>

            <Tray title={t(S.creditLedger)} className="col-span-full">
              <Ledger rows={v.credit_ledger} kind="credits" refs={refs} />
            </Tray>
            <Tray title={t(S.inventoryLedger)} className="col-span-full">
              <Ledger rows={v.inventory_ledger} kind="inventory" refs={refs} />
            </Tray>
          </div>
        )}
      </LoadState>

      {adjusting && <AdjustSheet key={adjusting} kind={adjusting} userId={userId} refs={refs} onClose={() => setAdjusting(null)} onDone={() => void view.reload()} />}
    </div>
  );
}

function Ledger({ rows, kind, refs }: { rows: Row[]; kind: 'credits' | 'inventory'; refs: RefLists }) {
  const { t, lang } = usePcLang();
  if (rows.length === 0) return <p className={`text-[12.5px] ${T.text3}`}>{t(S.noEntries)}</p>;
  return (
    <ul className="divide-y divide-[var(--ap-hairline)] text-[12.5px]">
      {rows.map((r) => {
        const unit = kind === 'inventory' ? String(refs.row('variants', String(r.variant_id))?.unit_code ?? '') : '';
        const delta = (n: unknown) => (kind === 'credits' ? signedDuration(Number(n), lang) : signedQty(Number(n), unit, lang));
        const parts: string[] = [];
        if (Number(r.delta_available)) parts.push(`${t(S.available)} ${delta(r.delta_available)}`);
        if (Number(r.delta_reserved)) parts.push(`${t(S.reserved)} ${delta(r.delta_reserved)}`);
        if (Number(r.delta_consumed)) parts.push(`${t(S.consumed)} ${delta(r.delta_consumed)}`);
        return (
          <li key={String(r.id)} className="space-y-0.5 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`font-semibold ${T.text1}`}>
                {labelOf(LEDGER_ENTRY, String(r.entry_type), lang)} · {kind === 'credits' ? refs.name('tiers', String(r.tier_id)) : refs.name('variants', String(r.variant_id))}
              </span>
              <span className={T.text3}>{formatDateTime(String(r.created_at), lang)}</span>
            </div>
            <p dir="auto" className={T.text2}>
              {parts.join(' · ') || '—'}
              {Number(r.value_iqd) > 0 && (
                <>
                  {' · '}
                  {t(S.value)}: <Money iqd={Number(r.value_iqd)} />
                </>
              )}
            </p>
            {!!r.note && <p className={T.text3}>{String(r.note)}</p>}
          </li>
        );
      })}
    </ul>
  );
}

interface AdjustAnswer {
  replayed: boolean;
  account?: { available_seconds: number; reserved_seconds: number; consumed_seconds: number } | null;
}

/**
 * One correction. Its Idempotency-Key is minted with the form and replaced
 * whenever the correction changes, so a retry of the same correction (a lost
 * answer) is recorded once and a different one is never refused as a reuse.
 */
function AdjustSheet({ kind, userId, refs, onClose, onDone }: { kind: 'credits' | 'inventory'; userId: string; refs: RefLists; onClose: () => void; onDone: () => void }) {
  const { t, lang } = usePcLang();
  const [confirm, confirmDialog] = useConfirm();
  const [key, setKey] = useState(() => newIdempotencyKey());
  const [target, setTarget] = useState('');
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [compensation, setCompensation] = useState(false);
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<AdjustAnswer | null>(null);
  const credits = kind === 'credits';
  const unit = credits ? '' : String(refs.row('variants', target)?.unit_code ?? '');
  const change = <V,>(set: (v: V) => void) => (v: V) => {
    set(v);
    setKey(newIdempotencyKey());
    setDone(null);
  };
  const targetError = !target ? t(S.pick) : null;
  const amountError = amount === null || amount <= 0 ? t(S.amountNeeded) : null;
  const reasonError = !reason.trim() ? t(S.reasonNeeded) : null;

  const submit = async () => {
    setTried(true);
    setFailure(null);
    if (targetError || amountError || reasonError || amount === null) return;
    const signed = direction === 'add' ? amount : -amount;
    const ok = await confirm({
      title: t(S.ask),
      consequence: `${credits ? `${refs.name('tiers', target)} ${signedDuration(signed, lang)}` : `${refs.name('variants', target)} ${signedQty(signed, unit, lang)}`}. ${t(S.askText)}`,
      confirmLabel: t(S.apply),
      destructive: direction === 'remove',
    });
    if (!ok) return;
    try {
      const out = await pc.post<AdjustAnswer>(
        `/customers/${enc(userId)}/${credits ? 'credits' : 'inventory'}/adjust`,
        {
          ...(credits ? { tier_id: target, seconds: signed } : { variant_id: target, qty: signed }),
          reason: reason.trim(),
          ...(direction === 'add' && compensation ? { compensation: true } : {}),
        },
        key
      );
      setDone(out);
      // Recorded: the next correction is a new one, with a new key.
      setAmount(null);
      setReason('');
      setCompensation(false);
      setTried(false);
      setKey(newIdempotencyKey());
      toast.success(t(S.done));
      onDone();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };

  const titleId = `pc-adjust-${kind}`;
  return (
    <Sheet open onClose={onClose} labelledBy={titleId} panelClassName="ap w-full sm:max-w-lg">
      <div className="space-y-3 px-5 pb-5 pt-2">
        <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
          {t(credits ? S.adjustHours : S.adjustMaterials)}
        </h2>
        <Note tone="info">{t(S.adjustHelp)}</Note>
        {!credits && <Note tone="info">{t(S.stockNote)}</Note>}
        <SelectField label={t(credits ? S.tier : S.variant)} value={target} placeholder="—" options={refs.options(credits ? 'tiers' : 'variants')} onChange={change(setTarget)} error={tried ? targetError : null} />
        <SelectField
          label={t(S.direction)}
          value={direction}
          options={[
            { value: 'add', label: t(S.add) },
            { value: 'remove', label: t(S.remove) },
          ]}
          onChange={change((v: string) => setDirection(v === 'remove' ? 'remove' : 'add'))}
        />
        {credits ? (
          <DurationInput label={t(S.howMuch)} value={amount} onChange={change(setAmount)} error={tried ? amountError : null} />
        ) : (
          <IntField label={t(S.howMuch)} unit={unit || undefined} value={amount} onChange={change(setAmount)} error={tried ? amountError : null} />
        )}
        {direction === 'add' && <Checkbox checked={compensation} onChange={change(setCompensation)} label={t(S.compensation)} />}
        <TextArea label={t(W.reason)} value={reason} onChange={change(setReason)} maxLength={500} rows={2} error={tried ? reasonError : null} />
        {done && (
          <Note tone="success">
            {t(S.done)} {done.replayed && t(S.replayed)}
            {done.account && ` · ${t(S.balanceNow)}: ${duration(done.account.available_seconds, lang)}`}
          </Note>
        )}
        {failure && <Note tone="danger">{failure}</Note>}
        <div className="flex flex-wrap gap-2">
          <Act kind={direction === 'remove' ? 'danger' : 'primary'} onClick={submit}>
            {t(S.apply)}
          </Act>
          <Act kind="ghost" onClick={onClose}>
            {t(W.close)}
          </Act>
        </div>
      </div>
      {confirmDialog}
    </Sheet>
  );
}
