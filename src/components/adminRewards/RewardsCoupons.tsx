/**
 * ADMIN → المكافآت → الكوبونات (migration 0220; docs/DECISIONS.md rows 287 and 298).
 *
 * Every reward coupon issued: its customer, the printer or the shop it came from, what
 * it does in words, what it took and the order it went on. «سحب» (any admin), «تمديد»
 * and «منح كوبون» (the financial scope, and the owner on their own account). The server
 * decides each and says why when it refuses; a reason or a number the server would
 * refuse is refused here first, in words, beside its field.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Gift, Loader2, Search, Ticket, Truck, Percent, X } from 'lucide-react';
import { api, ApiError, newIdempotencyKey } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { formatFigure } from '../../lib/localeNumber';
import { formatDate } from '../orders/format';
import { countText } from '../rewards/copy';
import { StatusChip } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { Overlay } from '../ui/Overlay';
import { usePrompt } from '../ui/PromptDialog';

type Tri = { ar: string; en: string; ckb: string };
export type RewardKind = 'free_shipping' | 'filament_discount';

export interface AdminGrant {
  id: string;
  kind: RewardKind;
  source: 'printer' | 'points_shop' | 'admin';
  state: 'active' | 'used' | 'expired' | 'revoked';
  code: string;
  percent: number;
  amount_iqd: number | null;
  min_total_iqd: number;
  max_discount_iqd: number | null;
  max_quantity: number | null;
  issued_at: string;
  expires_at: string;
  order_id: string | null;
  points_spent: number;
  used_on_order_id: string | null;
  revoke_reason: string;
  printer: { name: Tri; image: string; unit_index: number; week: number; product_slug: string } | null;
  amount_spent_iqd: number;
  user: { id: string; name: string; username: string; email: string };
}

export interface CustomerFilter {
  id: string;
  label: string;
}

/**
 * What withdrawing this coupon gives back: a live coupon the customer bought with points returns them
 * (row 303 R2; policy 14.10), anything else nothing. The server decides it; the dialog only says it first.
 */
export function pointsBackOnWithdraw(g: Pick<AdminGrant, 'source' | 'state' | 'points_spent'>): number {
  return g.source === 'points_shop' && g.state === 'active' ? Math.max(0, Math.trunc(Number(g.points_spent) || 0)) : 0;
}

/** Links out of the admin's single page reload it: the order board opens on `order`. */
const orderHref = (id: string) => `/admin?tab=orders&order=${encodeURIComponent(id)}`;

/** A refusal in the admin's language; anything else in the server's own words. */
export function useRewardsRefusal() {
  const { loc } = useLanguage();
  return useCallback(
    (err: unknown): string => {
      const code = err instanceof ApiError ? err.code : '';
      switch (code) {
        case 'OWNER_REQUIRED':
          return loc('هذا القرار للمالك وحده.', 'This decision is the owner’s alone.', 'ئەم بڕیارە تەنها هی خاوەنەکەیە.');
        case 'FINANCIAL_SCOPE_REQUIRED':
          return loc('هذا الفعل يحتاج صلاحية مالية.', 'This needs the owner or a financial admin.', 'ئەم کارە دەسەڵاتی دارایی پێویستە.');
        case 'OWNER_REASON_REQUIRED':
          return loc('اكتب سببًا من 5 أحرف على الأقل.', 'Write a reason of at least 5 characters.', 'هۆکارێک بنووسە کە لانیکەم 5 پیت بێت.');
        case 'REWARD_COUPON_USED':
          return loc('صُرف هذا الكوبون في طلب، ويبقى مع ذلك الطلب.', 'This coupon was spent on an order and stays with it.', 'ئەم کۆپۆنە لە داواکارییەکدا بەکارهاتووە و لەگەڵیدا دەمێنێتەوە.');
        case 'REWARD_COUPON_REVOKED':
          return loc('سُحب هذا الكوبون من قبل.', 'This coupon was already withdrawn.', 'ئەم کۆپۆنە پێشتر کشێنراوەتەوە.');
        case 'USER_NOT_FOUND':
          return loc('هذا الزبون غير موجود.', 'That customer does not exist.', 'ئەم کڕیارە بوونی نییە.');
        case 'REWARDS_NOT_INSTALLED':
          return loc('جداول المكافآت غير مثبّتة على هذه القاعدة بعد.', 'The rewards tables are not on this database yet.', 'خشتەکانی خەڵات هێشتا لەم داتابەیسەدا نین.');
        default:
          return err instanceof Error ? err.message : '';
      }
    },
    [loc]
  );
}

// ------------------------------------------------------------ one coupon's words

export function useGrantWords() {
  const { loc, lang } = useLanguage();
  const { money } = useMoney();
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  return {
    title: (g: Pick<AdminGrant, 'kind' | 'percent'>) =>
      g.kind === 'free_shipping' ? loc('كوبون توصيل', 'Delivery coupon', 'کۆپۆنی گەیاندن') : loc(`خصم ${g.percent}% على الفلامنت`, `${g.percent}% off filament`, `${g.percent}% داشکاندن لەسەر فیلامێنت`),
    /** What it does, in words: its amount and minimum, or its percentage, pieces and cap. */
    terms: (g: Pick<AdminGrant, 'kind' | 'amount_iqd' | 'min_total_iqd' | 'max_discount_iqd' | 'max_quantity'>) => {
      if (g.kind === 'free_shipping') {
        const amount = g.amount_iqd ? loc(`${money(g.amount_iqd)} من التوصيل`, `${money(g.amount_iqd)} off the delivery`, `${money(g.amount_iqd)} لە کرێی گەیاندن`) : loc('رسوم التوصيل كاملة', 'The whole delivery fee', 'هەموو کرێی گەیاندن');
        return g.min_total_iqd > 0 ? `${amount} · ${loc(`للطلبات من ${money(g.min_total_iqd)} فأكثر`, `On orders of ${money(g.min_total_iqd)} or more`, `بۆ داواکارییەکانی ${money(g.min_total_iqd)} و زیاتر`)}` : amount;
      }
      const pieces = g.max_quantity ? countText('pieces', g.max_quantity, l) : loc('كل القطع', 'every piece', 'هەموو پارچەکان');
      const on = loc(`على ${pieces}`, `On ${pieces}`, `لەسەر ${pieces}`);
      return g.max_discount_iqd ? `${on} · ${loc(`حتى ${money(g.max_discount_iqd)}`, `Up to ${money(g.max_discount_iqd)}`, `تا ${money(g.max_discount_iqd)}`)}` : on;
    },
    source: (g: Pick<AdminGrant, 'source' | 'printer' | 'points_spent'>) => {
      if (g.source === 'printer') {
        const name = g.printer ? (g.printer.name[l] || g.printer.name.en) : '';
        const week = g.printer ? formatFigure(g.printer.week + 1, l) : '';
        // The name in an isolate: a Latin name keeps its place in an Arabic line.
        const shown = `\u2068${name}\u2069`;
        return name
          ? // No fixed word for «printer»: the shop's own names carry it, and the line doubled it.
            loc(`${shown} · الأسبوع ${week}`, `${shown} · week ${week}`, `${shown} · هەفتەی ${week}`)
          : loc('طابعة', 'Printer', 'چاپکەر');
      }
      if (g.source === 'points_shop') {
        const points = countText('points', g.points_spent, l);
        return loc(`متجر النقاط · ${points}`, `Points shop · ${points}`, `فرۆشگای خاڵ · ${points}`);
      }
      return loc('من الفريق', 'From the team', 'لە تیمەکەوە');
    },
    state: (s: AdminGrant['state']) =>
      s === 'active' ? loc('صالح', 'Active', 'چالاک') : s === 'used' ? loc('مصروف', 'Spent', 'خەرجکراو') : s === 'expired' ? loc('منتهٍ', 'Expired', 'بەسەرچوو') : loc('مسحوب', 'Withdrawn', 'کشاوەتەوە'),
  };
}

const STATE_TONE: Record<AdminGrant['state'], 'success' | 'neutral' | 'warning' | 'info'> = { active: 'success', used: 'info', expired: 'neutral', revoked: 'warning' };

/** One coupon as a card: the printers' sheet shows the same. */
export function GrantCard({ g, busy, onExtend, onRevoke, showCustomer = true }: { g: AdminGrant; busy?: boolean; onExtend?: (g: AdminGrant) => void; onRevoke?: (g: AdminGrant) => void; showCustomer?: boolean }) {
  const { loc, lang } = useLanguage();
  const { money } = useMoney();
  const words = useGrantWords();
  const live = g.state !== 'used' && g.state !== 'revoked';
  return (
    <li data-admin-reward-grant={g.state} className="lv-surface p-3 space-y-2">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="size-9 shrink-0 rounded-full lv-well grid place-items-center text-text-secondary">
          {g.kind === 'free_shipping' ? <Truck className="w-4 h-4" /> : <Percent className="w-4 h-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <p className="min-w-0 text-[14px] font-bold leading-5 text-text-primary">{words.title(g)}</p>
            <StatusChip tone={STATE_TONE[g.state]}>{words.state(g.state)}</StatusChip>
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-text-secondary">{words.terms(g)}</p>
        </div>
      </div>
      {showCustomer && (
        <p className="min-w-0 text-[12px] leading-5">
          <span className="block font-semibold text-text-primary">{g.user.name || g.user.username}</span>
          {g.user.email && (
            <span className="block truncate text-text-muted">
              <bdi dir="ltr">{g.user.email}</bdi>
            </span>
          )}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] leading-5">
        <div className="min-w-0">
          <dt className="text-text-muted">{loc('الكود', 'Code', 'کۆد')}</dt>
          <dd className="truncate font-mono text-text-primary"><bdi dir="ltr">{g.code}</bdi></dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted">{loc('المصدر', 'Source', 'سەرچاوە')}</dt>
          <dd className="text-text-primary">{words.source(g)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted">{loc('صدر', 'Issued', 'دەرچوو')}</dt>
          <dd className="text-text-primary">{formatDate(g.issued_at, lang)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted">{loc('ينتهي', 'Ends', 'کۆتایی دێت')}</dt>
          <dd className="text-text-primary">{formatDate(g.expires_at, lang)}</dd>
        </div>
        {g.used_on_order_id && (
          <>
            <div className="min-w-0">
              <dt className="text-text-muted">{loc('خصم من الطلب', 'Took off the order', 'لە داواکارییەکە کەم کرد')}</dt>
              <dd className="font-semibold tabular-nums text-text-primary">{money(g.amount_spent_iqd)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted">{loc('الطلب', 'Order', 'داواکاری')}</dt>
              <dd className="truncate">
                <a dir="ltr" href={orderHref(g.used_on_order_id)} className="font-mono text-text-primary underline underline-offset-2">
                  {g.used_on_order_id}
                </a>
              </dd>
            </div>
          </>
        )}
      </dl>
      {live && (onExtend || onRevoke) && (
        <div className="flex justify-end gap-2">
          {onExtend && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onExtend(g)}>
              {loc('تمديد', 'Extend', 'درێژکردنەوە')}
            </Button>
          )}
          {onRevoke && (
            <Button variant="ghost" size="sm" disabled={busy} className="text-danger" onClick={() => onRevoke(g)}>
              {loc('سحب', 'Withdraw', 'کشاندنەوە')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** «سحب» and «تمديد», asked in the admin's language with a real message for a bad answer. */
export function useGrantActions(onDone: () => unknown, onError: (text: string) => void) {
  const { loc } = useLanguage();
  const [prompt, promptDialog] = usePrompt();
  const refusal = useRewardsRefusal();
  const [busy, setBusy] = useState('');

  const askReason = (title: string, confirmLabel: string, destructive = false, before = '') =>
    prompt({
      title,
      description: `${before}${loc('يُحفظ السبب في السجل.', 'The reason is kept in the audit log.', 'هۆکارەکە لە تۆماردا دەمێنێتەوە.')}`,
      label: loc('السبب', 'Reason', 'هۆکار'),
      required: true,
      maxLength: 200,
      multiline: true,
      confirmLabel,
      destructive,
      validate: (v) => (v.length < 3 ? loc('اكتب 3 أحرف على الأقل.', 'Write at least 3 characters.', 'لانیکەم 3 پیت بنووسە.') : null),
    });

  const send = async (g: AdminGrant, what: 'revoke' | 'extend', body: Record<string, unknown>) => {
    setBusy(g.id);
    onError('');
    try {
      await api.post(`/api/admin/rewards/grants/${encodeURIComponent(g.id)}/${what}`, body);
      await onDone();
    } catch (err) {
      onError(refusal(err));
    } finally {
      setBusy('');
    }
  };

  const revoke = async (g: AdminGrant) => {
    const back = pointsBackOnWithdraw(g);
    const reason = await askReason(
      loc(`سحب الكوبون ${g.code}؟`, `Withdraw coupon ${g.code}?`, `کۆپۆنی ${g.code} بکشێتەوە؟`),
      loc('سحب', 'Withdraw', 'کشاندنەوە'),
      true,
      // The customer paid points for it: they go back with it, once (row 303 R2; policy 14.10).
      back > 0
        ? `${loc(
            `تعود إلى الزبون ${formatFigure(back, 'ar')} نقطة دفعها مقابل هذا الكوبون، ويصله إشعار بذلك.`,
            `The ${formatFigure(back, 'en')} points the customer paid for this coupon go back to them, with a notice.`,
            `ئەو ${formatFigure(back, 'ckb')} خاڵەی کڕیار بۆ ئەم کۆپۆنە دای بۆی دەگەڕێتەوە، و ئاگادارکردنەوەیەکی پێدەگات.`
          )} `
        : ''
    );
    if (reason !== null) await send(g, 'revoke', { reason });
  };

  const extend = async (g: AdminGrant) => {
    const raw = await prompt({
      title: loc(`تمديد الكوبون ${g.code}`, `Extend coupon ${g.code}`, `درێژکردنەوەی کۆپۆنی ${g.code}`),
      label: loc('كم يومًا؟ من 1 إلى 30', 'How many days? From 1 to 30', 'چەند ڕۆژ؟ لە 1 تا 30'),
      required: true,
      inputMode: 'numeric',
      confirmLabel: loc('التالي', 'Next', 'دواتر'),
      validate: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 30 ? null : loc('اكتب عددًا صحيحًا من 1 إلى 30.', 'Write a whole number from 1 to 30.', 'ژمارەیەکی تەواو لە 1 تا 30 بنووسە.');
      },
    });
    if (raw === null) return;
    const reason = await askReason(loc(`تمديد ${g.code} ${raw} يومًا`, `Extend ${g.code} by ${raw} days`, `درێژکردنەوەی ${g.code} بە ${raw} ڕۆژ`), loc('تمديد', 'Extend', 'درێژکردنەوە'));
    if (reason !== null) await send(g, 'extend', { days: Number(raw), reason });
  };

  return { busy, revoke, extend, promptDialog };
}

// ------------------------------------------------------------ the tab

export default function RewardsCoupons({ customer, onClearCustomer }: { customer?: CustomerFilter | null; onClearCustomer?: () => void }) {
  const { loc } = useLanguage();
  const words = useGrantWords();
  const [rows, setRows] = useState<AdminGrant[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [state, setState] = useState('active');
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [granting, setGranting] = useState(false);
  const refusal = useRewardsRefusal();

  const params = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams();
      if (state) p.set('state', state);
      if (kind) p.set('kind', kind);
      if (source) p.set('source', source);
      if (q) p.set('q', q);
      if (customer?.id) p.set('user_id', customer.id);
      if (cursor) p.set('cursor', cursor);
      return p.toString();
    },
    [state, kind, source, q, customer?.id]
  );

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get<{ grants: AdminGrant[]; next_cursor?: string | null }>(`/api/admin/rewards/grants?${params()}`);
      setRows(res.grants);
      setNextCursor(res.next_cursor ?? null);
    } catch (err) {
      setError(refusal(err));
      setRows([]);
      setNextCursor(null);
    }
  }, [params, refusal]);

  useEffect(() => {
    void load();
  }, [load]);

  // A search waits for the admin to stop typing.
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const more = async () => {
    if (!nextCursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const res = await api.get<{ grants: AdminGrant[]; next_cursor?: string | null }>(`/api/admin/rewards/grants?${params(nextCursor)}`);
      setRows((prev) => [...(prev ?? []), ...res.grants]);
      setNextCursor(res.next_cursor ?? null);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setMoreBusy(false);
    }
  };

  const actions = useGrantActions(load, setError);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] leading-5 text-text-muted">
          {loc('كوبون صُرف في طلب لا يُسحب منه أبدًا.', 'A coupon spent on an order is never taken back from it.', 'کۆپۆنێک کە لە داواکارییەکدا بەکارهاتبێت هەرگیز لێی ناسەندرێتەوە.')}
        </p>
        <Button variant="primary" size="sm" icon={<Gift className="w-4 h-4" aria-hidden />} onClick={() => setGranting(true)} data-admin-reward-grant-open>
          {loc('منح كوبون', 'Grant a coupon', 'کۆپۆنێک ببەخشە')}
        </Button>
      </div>

      <div className="lv-surface p-3 grid gap-2 grid-cols-2 sm:grid-cols-4">
        <Select className="text-sm" value={state} onChange={(e) => setState(e.target.value)} aria-label={loc('الحالة', 'State', 'دۆخ')}>
          <option value="">{loc('كل الحالات', 'All states', 'هەموو دۆخەکان')}</option>
          <option value="active">{words.state('active')}</option>
          <option value="used">{words.state('used')}</option>
          <option value="expired">{words.state('expired')}</option>
          <option value="revoked">{words.state('revoked')}</option>
        </Select>
        <Select className="text-sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={loc('النوع', 'Kind', 'جۆر')}>
          <option value="">{loc('كل الأنواع', 'All kinds', 'هەموو جۆرەکان')}</option>
          <option value="free_shipping">{loc('توصيل', 'Delivery', 'گەیاندن')}</option>
          <option value="filament_discount">{loc('فلامنت', 'Filament', 'فیلامێنت')}</option>
        </Select>
        <Select className="text-sm" value={source} onChange={(e) => setSource(e.target.value)} aria-label={loc('المصدر', 'Source', 'سەرچاوە')}>
          <option value="">{loc('كل المصادر', 'All sources', 'هەموو سەرچاوە')}</option>
          <option value="printer">{loc('طابعة', 'Printer', 'چاپکەر')}</option>
          <option value="points_shop">{loc('متجر النقاط', 'Points shop', 'فرۆشگای خاڵ')}</option>
          <option value="admin">{loc('من الفريق', 'From the team', 'لە تیمەکەوە')}</option>
        </Select>
        <Input className="text-sm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={loc('كود أو زبون أو طلب…', 'Code, name or order…', 'کۆد، کڕیار، داواکاری…')} aria-label={loc('بحث', 'Search', 'گەڕان')} />
      </div>

      {customer && (
        <p className="flex items-center gap-2 text-[12px] text-text-secondary" data-admin-reward-customer-filter>
          <StatusChip tone="info" dot={false}>{customer.label}</StatusChip>
          <button type="button" onClick={onClearCustomer} className="rounded p-1 text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" aria-label={loc('إزالة التصفية', 'Clear the filter', 'لابردنی پاڵاوتن')}>
            <X className="w-4 h-4" aria-hidden />
          </button>
        </p>
      )}
      {notice && (
        <div role="status" className="lv-alert lv-alert-success flex items-center gap-2 text-xs text-text-primary">
          <Check className="w-4 h-4" aria-hidden /> {notice}
        </div>
      )}
      {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}

      {rows === null ? (
        <p className="text-sm text-text-secondary">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>
      ) : rows.length === 0 ? (
        <div className="lv-surface flex flex-col items-center gap-2 p-6 text-center">
          <Ticket className="w-6 h-6 text-text-muted" aria-hidden />
          <p className="text-sm text-text-secondary">{loc('لا كوبونات هنا.', 'No coupons here.', 'هیچ کۆپۆنێک لێرە نییە.')}</p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((g) => (
              <GrantCard key={g.id} g={g} busy={actions.busy === g.id} onExtend={(x) => void actions.extend(x)} onRevoke={(x) => void actions.revoke(x)} />
            ))}
          </ul>
          {nextCursor && (
            <Button variant="secondary" block loading={moreBusy} onClick={() => void more()}>
              {loc('عرض المزيد', 'Show more', 'زیاتر پیشان بدە')}
            </Button>
          )}
        </>
      )}

      {actions.promptDialog}
      <GrantCouponDialog
        open={granting}
        onClose={() => setGranting(false)}
        onGranted={(text) => {
          setGranting(false);
          setNotice(text);
          void load();
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------ «منح كوبون»

interface UserHit {
  id: string;
  name: string | null;
  email: string | null;
  username: string | null;
}

interface GrantTerms {
  valid_days: number;
  free_shipping: { amount_iqd: number; min_order_iqd: number };
  filament: { percent: number; max_discount_iqd: number | null; max_pieces: number; product_ids: string[] };
}

/**
 * One coupon, on today's terms, to one customer found by the lookup the gifts' grant
 * sheet uses. The figures are the programme's settings: this names none of its own.
 * One key per opening, so a press repeated after a lost answer is the same coupon.
 */
export function GrantCouponDialog({ open, onClose, onGranted }: { open: boolean; onClose: () => void; onGranted: (notice: string) => void }) {
  const { loc } = useLanguage();
  const words = useGrantWords();
  const titleId = useId();
  const refusal = useRewardsRefusal();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [user, setUser] = useState<UserHit | null>(null);
  const [kind, setKind] = useState<RewardKind>('free_shipping');
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const [terms, setTerms] = useState<GrantTerms | null>(null);
  const [errors, setErrors] = useState<{ user?: string; days?: string; reason?: string; server?: string }>({});
  const [busy, setBusy] = useState(false);
  const key = useRef('');
  const seq = useRef(0);
  /** A field put right stops saying what was wrong with it. */
  const corrected = (field: 'user' | 'days' | 'reason') => setErrors((e) => (e[field] || e.server ? { ...e, [field]: undefined, server: undefined } : e));

  // A new opening starts clean, with its own key.
  useEffect(() => {
    if (!open) return;
    key.current = newIdempotencyKey();
    setQuery('');
    setHits([]);
    setUser(null);
    setKind('free_shipping');
    setDays('');
    setReason('');
    setErrors({});
    setBusy(false);
    api
      .get<{ config: GrantTerms }>('/api/admin/rewards/config')
      .then((r) => setTerms(r.config))
      .catch(() => setTerms(null));
  }, [open]);

  // Type to find the customer, debounced; only the latest answer counts.
  useEffect(() => {
    const q = query.trim();
    if (!open || user || q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .get<{ users: UserHit[] }>(`/api/gifts/admin/users?q=${encodeURIComponent(q)}`)
        .then((r) => mine === seq.current && setHits(r.users ?? []))
        .catch(() => mine === seq.current && setHits([]))
        .finally(() => mine === seq.current && setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open, user]);

  const validDays = days.trim() === '' ? (terms?.valid_days ?? null) : Number(days);
  const sample: Parameters<typeof words.terms>[0] | null = !terms
    ? null
    : kind === 'free_shipping'
      ? { kind, amount_iqd: terms.free_shipping.amount_iqd, min_total_iqd: terms.free_shipping.min_order_iqd, max_discount_iqd: null, max_quantity: null }
      : { kind, amount_iqd: null, min_total_iqd: 0, max_discount_iqd: terms.filament.max_discount_iqd, max_quantity: terms.filament.max_pieces };

  const submit = async () => {
    const problems: typeof errors = {};
    if (!user) problems.user = loc('اختر الزبون أولًا.', 'Choose the customer first.', 'سەرەتا کڕیارەکە هەڵبژێرە.');
    if (days.trim() !== '' && !(Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 90)) {
      problems.days = loc('اكتب عددًا صحيحًا من 1 إلى 90.', 'Write a whole number from 1 to 90.', 'ژمارەیەکی تەواو لە 1 تا 90 بنووسە.');
    }
    if (reason.trim().length < 3) problems.reason = loc('اكتب سببًا من 3 أحرف على الأقل.', 'Write a reason of at least 3 characters.', 'هۆکارێک بنووسە کە لانیکەم 3 پیت بێت.');
    setErrors(problems);
    if (Object.keys(problems).length > 0 || !user) return;
    setBusy(true);
    try {
      await api.post('/api/admin/rewards/grants', {
        user_id: user.id,
        kind,
        reason: reason.trim(),
        idempotency_key: key.current,
        ...(days.trim() !== '' ? { valid_days: Number(days) } : {}),
      });
      onGranted(loc(`مُنح الكوبون إلى ${user.name || user.email || user.id} ووصله إشعار.`, `The coupon was granted to ${user.name || user.email || user.id}, and they were notified.`, `کۆپۆنەکە بەخشرا بە ${user.name || user.email || user.id} و ئاگادار کرایەوە.`));
    } catch (err) {
      setErrors({ server: refusal(err) });
    } finally {
      setBusy(false);
    }
  };

  const choice = (active: boolean) => `lv-choice flex min-h-11 items-center justify-center gap-2 px-2 py-2 text-[13px] font-semibold ${active ? 'bg-surface-selected text-text-primary' : 'text-text-secondary'}`;

  return (
    <Overlay open={open} onClose={onClose} labelledBy={titleId} placement="bottom" testId="reward-grant-dialog" panelClassName="w-full sm:max-w-md max-h-[calc(100dvh-3.5rem)] overflow-y-auto">
      <form
        className="space-y-4 p-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id={titleId} className="text-[17px] font-bold leading-snug text-text-primary">
          {loc('منح كوبون', 'Grant a coupon', 'کۆپۆنێک ببەخشە')}
        </h2>

        <Field label={loc('الزبون', 'Customer', 'کڕیار')} error={errors.user} required>
          {user ? (
            <div className="lv-well flex min-h-11 items-center justify-between gap-2 rounded-md px-3 py-2" data-grant-user>
              <span className="min-w-0 text-sm text-text-primary">
                <span className="block truncate font-semibold">{user.name || user.username || user.id}</span>
                {user.email && <span className="block truncate text-[12px] text-text-muted"><bdi dir="ltr">{user.email}</bdi></span>}
              </span>
              <button type="button" onClick={() => { setUser(null); corrected('user'); }} aria-label={loc('تغيير الزبون', 'Change the customer', 'گۆڕینی کڕیار')} className="shrink-0 rounded p-1 text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                <X className="w-4 h-4" aria-hidden />
              </button>
            </div>
          ) : (
            <Input value={query} onChange={(e) => { setQuery(e.target.value); corrected('user'); }} placeholder={loc('الاسم أو البريد أو اسم المستخدم أو الهاتف', 'Name, e-mail, username or phone', 'ناو، ئیمەیڵ، ناوی بەکارهێنەر یان تەلەفۆن')} autoComplete="off" />
          )}
        </Field>
        {!user && (searching || hits.length > 0) && (
          <ul className="-mt-2 space-y-1" data-grant-hits>
            {searching && hits.length === 0 && (
              <li className="flex items-center gap-2 px-1 py-1 text-[12px] text-text-muted">
                <Search className="w-3.5 h-3.5" aria-hidden /> {loc('جارٍ البحث…', 'Searching…', 'گەڕان…')}
              </li>
            )}
            {hits.map((u) => (
              <li key={u.id}>
                <button type="button" className="lv-choice flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-start" onClick={() => { setUser(u); corrected('user'); }}>
                  <span className="min-w-0 truncate text-[13px] font-semibold text-text-primary">{u.name || u.username || u.id}</span>
                  <span dir="ltr" className="min-w-0 truncate text-[12px] text-text-muted">{u.email || u.username || ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-text-secondary">{loc('الكوبون', 'Coupon', 'کۆپۆن')}</p>
          <div role="radiogroup" aria-label={loc('الكوبون', 'Coupon', 'کۆپۆن')} className="grid grid-cols-2 gap-2">
            <button type="button" role="radio" aria-checked={kind === 'free_shipping'} className={choice(kind === 'free_shipping')} onClick={() => setKind('free_shipping')}>
              <Truck className="w-4 h-4 shrink-0" aria-hidden /> {loc('توصيل', 'Delivery', 'گەیاندن')}
            </button>
            <button type="button" role="radio" aria-checked={kind === 'filament_discount'} className={choice(kind === 'filament_discount')} onClick={() => setKind('filament_discount')}>
              <Percent className="w-4 h-4 shrink-0" aria-hidden /> {loc('فلامنت', 'Filament', 'فیلامێنت')}
            </button>
          </div>
          {sample && (
            <p className="mt-1.5 text-[12px] leading-5 text-text-muted" data-grant-terms>
              {words.terms(sample)}
              {kind === 'filament_discount' && terms && ` · ${terms.filament.percent}%`}
              {' · '}
              {terms?.filament && kind === 'filament_discount' && terms.filament.product_ids.length > 0
                ? loc(`الفلامنت المختار (${terms.filament.product_ids.length})`, `The selected filaments (${terms.filament.product_ids.length})`, `فیلامێنتە هەڵبژێردراوەکان (${terms.filament.product_ids.length})`)
                : kind === 'filament_discount'
                  ? loc('كل فلامنت FDM', 'Every FDM filament', 'هەموو فیلامێنتی FDM')
                  : loc('بشروط الإعدادات الحالية', 'On the current settings', 'بە مەرجەکانی ڕێکخستنی ئێستا')}
            </p>
          )}
        </div>

        <Field
          label={loc('مدة الصلاحية (أيام)', 'Valid for (days)', 'ماوەی بەکارهێنان (ڕۆژ)')}
          hint={validDays && days.trim() === '' ? loc(`الافتراضي من الإعدادات: ${validDays}`, `The settings' default: ${validDays}`, `بنەڕەتی لە ڕێکخستنەکانەوە: ${validDays}`) : undefined}
          error={errors.days}
          optional
        >
          <Input ltr inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value); corrected('days'); }} placeholder={terms ? String(terms.valid_days) : ''} />
        </Field>

        <Field label={loc('السبب (يُحفظ في السجل)', 'Reason (kept in the audit log)', 'هۆکار (لە تۆماردا دەمێنێتەوە)')} error={errors.reason} required>
          <Textarea rows={2} dir="auto" maxLength={200} value={reason} onChange={(e) => { setReason(e.target.value); corrected('reason'); }} />
        </Field>

        {errors.server && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{errors.server}</div>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose} className="sm:min-w-24">
            {loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy} className="sm:min-w-24" icon={busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : undefined} data-grant-submit>
            {loc('منح الكوبون', 'Grant the coupon', 'کۆپۆنەکە ببەخشە')}
          </Button>
        </div>
      </form>
    </Overlay>
  );
}
