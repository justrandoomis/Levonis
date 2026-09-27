import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, formatIqd } from '../lib/api';
import { RefreshCw, Users, Inbox, CreditCard, Rocket, PauseCircle } from 'lucide-react';
import { Overlay } from './ui/Overlay';
import { tierLabel, tierMetaFor } from './subscription/tierMeta';
/**
 * THE MEMBER DETAIL IS A WINDOW NOW, AND IT LIVES IN ./adminMemberships/.
 *
 * «أما البند الذي لم ينجز شاشة الأعضاء القديمة انقل هذا أيضا» — the owner
 * asked for the users table's pop-up treatment here too. What used to be a
 * `MemberDetail` block rendered under the table, five hundred lines down this
 * file, is now `MemberDetailModal`: the same `Overlay`, the same focus trap and
 * the same `Section`/`Row`/`Stat`/`Pill` hierarchy the users table already
 * uses, so the panel behaves identically whichever table an admin opened a
 * member from. The strings, the shared shapes and the two write actions moved
 * with it; nothing here reads them any more except the table itself.
 */
import MemberDetailModal from './adminMemberships/MemberDetailModal';
import { STRINGS, shortDate, type S } from './adminMemberships/strings';
/**
 * THE TICKET QUEUE MOVED OUT AND GREW ITS OWN SIDEBAR ENTRY.
 *
 * «لا توجد صفحة في الادارة للرد على رسائل المستخدمين» — it was here, as the
 * second tab of a MEMBERSHIP panel filed under Growth, and that is why the
 * owner could not find it. It now lives in ./adminSupport/SupportQueue.tsx and
 * is mounted BOTH from src/pages/Admin.tsx's own «الدعم والتذاكر» entry and
 * from the tab below, so an admin who knows the old route keeps it and nobody
 * maintains two consoles.
 */
import SupportQueue from './adminSupport/SupportQueue';
import type { MemberRow } from './adminMemberships/types';

/**
 * PRO-operations console (final-phase brief §10):
 *  - member search/filter (tier, membership state, KYC state, restrictions,
 *    expiry window) and a member detail view that SEPARATES subscription
 *    payment/term, identity status (kyc_cases states only), benefit
 *    eligibility context, the live BNPL credit line/ledger and restriction
 *    cases;
 *  - restriction-case management: open a typed case with evidence, gate
 *    specific benefit flags (pause/revoke), resume with reason — audited
 *    server-side. Restrictions gate benefit computation only, never orders,
 *    wallet, points, warranty or support access;
 *  - the support-ticket queue with REAL priority-then-age ordering; age is
 *    shown prominently so ordinary customers are visibly not starved.
 */

// ============================================================ members list

function MembersSection({ s, lang }: { s: S; lang: 'ar' | 'en' | 'ckb' }) {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [status, setStatus] = useState('');
  const [kyc, setKyc] = useState('');
  const [restriction, setRestriction] = useState('');
  const [expiryDays, setExpiryDays] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The control the window grew out of. `Overlay` scales the panel FROM this
   * element and `useModalFocus` puts the caret back on it when the window
   * closes, so the admin's eye and the keyboard both return to the row they
   * pressed instead of to the top of a table that may be a hundred rows long.
   */
  const detailAnchorRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (tier) params.set('tier', tier);
      if (status) params.set('status', status);
      if (kyc) params.set('kyc', kyc);
      if (restriction) params.set('restriction', restriction);
      if (expiryDays) params.set('expiry_days', expiryDays);
      const d = await api.get<{ members: MemberRow[] }>(`/api/support/admin/members?${params.toString()}`);
      setMembers(d.members || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setLoading(false);
    }
  }, [q, tier, status, kyc, restriction, expiryDays, s.loadError]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, status, kyc, restriction, expiryDays]);

  const selectCls =
    'bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
          placeholder={s.searchPlaceholder}
          className="flex-1 min-w-[180px] bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none"
        />
        <select value={tier} onChange={(e) => setTier(e.target.value)} className={selectCls} aria-label={s.fTier}>
          <option value="">{s.fTier}: {s.all}</option>
          <option value="pro">PRO</option>
          <option value="plus">PLUS</option>
          <option value="free">{s.none}</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls} aria-label={s.fStatus}>
          <option value="">{s.fStatus}: {s.all}</option>
          <option value="active">active</option>
          <option value="expired">expired</option>
          <option value="pending_launch">pending_launch</option>
          <option value="none">{s.none}</option>
        </select>
        <select value={kyc} onChange={(e) => setKyc(e.target.value)} className={selectCls} aria-label={s.fKyc}>
          <option value="">{s.fKyc}: {s.all}</option>
          {['draft', 'submitted', 'reviewing', 'changes_requested', 'rejected', 'verified'].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select value={restriction} onChange={(e) => setRestriction(e.target.value)} className={selectCls} aria-label={s.fRestriction}>
          <option value="">{s.fRestriction}: {s.all}</option>
          <option value="active">{s.active}</option>
        </select>
        <select value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} className={selectCls} aria-label={s.fExpiry}>
          <option value="">{s.fExpiry}: {s.all}</option>
          <option value="7">7 {s.days}</option>
          <option value="30">30 {s.days}</option>
          <option value="90">90 {s.days}</option>
        </select>
        <button onClick={load} className="p-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 hover:text-white">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm">
          {error}{' '}
          <button onClick={load} className="underline">
            {s.retry}
          </button>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse min-w-[820px]">
            <thead>
              <tr className="bg-zinc-800/50 border-b border-zinc-700 text-start">
                {[s.colMember, s.colTier, s.colState, s.colExpiry, s.colKyc, s.colRestr, s.colAddr].map((h) => (
                  <th key={h} className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase tracking-wider text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors">
                  <td className="py-3 px-4">
                    {/*
                      PRESSING THE MEMBER IS WHAT OPENS THE PROFILE, so the
                      member's identity is the control.

                      A REAL <button>, and not an onClick on the <tr>. A
                      clickable row is unreachable by keyboard and silent to a
                      screen reader, so half the panel's operators would have no
                      way into the profile at all — and there is no element for
                      the window to grow out of or hand focus back to, which is
                      the other half of what the owner asked for. `text-start`
                      because this is a left-aligned block of text inside a
                      control that centres by default, and `w-full` so the hit
                      target is the cell rather than the width of the name.
                    */}
                    <button
                      type="button"
                      onClick={(e) => {
                        detailAnchorRef.current = e.currentTarget;
                        setSelected(m.id);
                      }}
                      aria-label={`${s.openMember}: ${m.name || m.username || m.email}`}
                      className="-mx-2 w-full rounded-xl px-2 py-1 text-start transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gilt/60"
                    >
                      <span dir="auto" className="block truncate text-sm font-bold leading-5 text-white">
                        {m.name || m.username || '—'}
                      </span>
                      <span dir="auto" className="block truncate text-xs leading-4 text-zinc-500">
                        {m.email}
                      </span>
                    </button>
                  </td>
                  <td className="py-3 px-4 text-xs font-bold uppercase text-zinc-300">{tierLabel(m.tier)}</td>
                  <td className="py-3 px-4 text-xs text-zinc-400">{m.membership_state}</td>
                  <td className="py-3 px-4 text-xs text-zinc-500 whitespace-nowrap">{shortDate(m.expires_at)}</td>
                  <td className="py-3 px-4 text-xs text-zinc-400">{m.kyc_state ?? '—'}</td>
                  <td className="py-3 px-4">
                    {m.active_restrictions > 0 ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-300">
                        {m.active_restrictions}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-xs text-zinc-400">{m.has_approved_address ? s.yes : s.no}</td>
                </tr>
              ))}
              {!loading && members.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-zinc-500">
                    {s.empty}
                  </td>
                </tr>
              )}
              {loading && members.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-zinc-500">
                    {s.loading}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/*
        THE PROFILE WINDOW. Mounted UNCONDITIONALLY and driven by `selected`,
        so it owns its own exit animation instead of being torn out of the DOM
        mid-flight — `{selected && <MemberDetail …>}` is exactly the shape that
        made the old block appear from nowhere and vanish to nowhere.
      */}
      <MemberDetailModal
        userId={selected}
        anchorRef={detailAnchorRef}
        s={s}
        lang={lang}
        onClose={() => setSelected(null)}
        onChanged={load}
      />
    </div>
  );
}

// ================================================================== plans

/**
 * The plan catalogue and the launch switch — the two admin endpoints that
 * existed (PATCH /admin/plans/:id, POST /admin/activate-launch) but had no
 * screen, so prices and the launch could only be changed with curl.
 *
 * A price is data: an empty field means UNPRICED, which the storefront shows
 * as "price to be announced" and refuses to sell. The launch activation is
 * irreversible and starts every prepaid membership, so it asks for the word
 * ACTIVATE to be typed into an in-app window — no browser prompt.
 */
const PLAN_STRINGS = {
  ar: {
    tab: 'الخطط والإطلاق',
    title: 'خطط العضوية',
    intro: 'السعر بالدينار العراقي (عدد صحيح). اترك الحقل فارغًا ليصبح "غير مسعّر" — لا يُباع ويظهر للزبون بأن السعر يُعلن لاحقًا.',
    tier: 'الفئة',
    duration: 'المدة',
    price: 'السعر (د.ع)',
    active: 'نشطة',
    inactive: 'موقوفة',
    purchasable: 'قابلة للشراء',
    unpriced: 'غير مسعّرة',
    save: 'حفظ',
    saved: 'تم الحفظ',
    months: 'شهر',
    loading: 'جارٍ التحميل…',
    loadError: 'تعذر تحميل الخطط',
    retry: 'إعادة المحاولة',
    badPrice: 'السعر يجب أن يكون عددًا صحيحًا غير سالب',
    launchTitle: 'إطلاق العضويات',
    launchActive: 'الإطلاق مُفعّل',
    launchInactive: 'الإطلاق غير مُفعّل — كل الاشتراكات المدفوعة تبقى محجوزة حتى التفعيل.',
    launchAt: 'تاريخ الإطلاق المعلن',
    activatedAt: 'فُعّل في',
    notSet: 'غير محدد',
    activate: 'تفعيل الإطلاق',
    activateTitle: 'تفعيل إطلاق العضويات',
    activateBody: 'هذا الإجراء نهائي ويبدأ عدّاد كل اشتراك مدفوع مسبقًا من هذه اللحظة. اكتب ACTIVATE للتأكيد.',
    typeHere: 'اكتب ACTIVATE',
    confirm: 'تفعيل الآن',
    cancel: 'إلغاء',
    working: 'جارٍ التنفيذ…',
    activated: (n: number) => `تم التفعيل — ${n} اشتراكًا بدأ الآن.`,
    alreadyActivated: (n: number) => `الإطلاق كان مُفعّلًا مسبقًا — ${n} اشتراكًا متأخرًا بدأ الآن.`,
    sweep: (n: number) => `تفعيل الحجوزات المتبقية (${n})`,
    sweepNone: 'لا توجد حجوزات متبقية — كل اشتراك مدفوع يعمل الآن.',
    sweepTitle: 'تفعيل الحجوزات المتبقية',
    deferred: (n: number) => `${n} حجزًا لن يبدأ بالتفعيل — الحساب يملك فئة أعلى تعمل الآن. استرجعه أو ألغِه يدويًا.`,
    sweepBody: 'يبدأ عدّاد كل حجز متبقٍّ من هذه اللحظة، بنفس قواعد الإطلاق (أعلى فئة للحساب، ويُلغى الأدنى). اكتب ACTIVATE للتأكيد.',
    pauseTitle: 'إيقاف PRO مؤقتًا',
    pausedState: (since: string, n: number) => `PRO موقوف منذ ${since} — ${n} عضوية مجمّدة، لا تُحتسب أيامها حتى الاستئناف.`,
    liveState: 'PRO يُباع ويعمل بشكل طبيعي.',
    pauseHint: 'أثناء الإيقاف: لا يُباع PRO ولا يُمنح، وتظهر بطاقته «قريبًا» بلا سعر ولا مزايا، وتُجمَّد أيام كل مشترك ويحصل خلالها على مزايا PREMIUM. عند الاستئناف تُضاف لكل مشترك المدة التي جُمّدت كاملة.',
    pauseBtn: 'إيقاف PRO',
    resumeBtn: 'استئناف PRO',
    pauseBody: 'سيتوقف بيع PRO وتُجمَّد كل عضوية PRO فعّالة الآن. اكتب PAUSE للتأكيد.',
    resumeBody: 'سيعود بيع PRO، وتُمدَّد كل عضوية مجمّدة بالمدة التي قضتها مجمّدة. اكتب RESUME للتأكيد.',
    pausedDone: (n: number) => `أُوقف PRO — جُمّدت ${n} عضوية.`,
    resumedDone: (n: number) => `استؤنف PRO — مُدّدت ${n} عضوية.`,
    schemaPending: 'تحديث قاعدة البيانات الذي يحتاجه إيقاف PRO لم يُطبَّق بعد — أعد المحاولة بعد دقائق.',
    pausedChip: 'موقوفة مؤقتًا',
  },
  en: {
    tab: 'Plans & launch',
    title: 'Membership plans',
    intro: 'Price in IQD (a whole number). Leave the field empty to make a plan UNPRICED — it cannot be bought and the customer sees "price to be announced".',
    tier: 'Tier',
    duration: 'Duration',
    price: 'Price (IQD)',
    active: 'Active',
    inactive: 'Inactive',
    purchasable: 'Purchasable',
    unpriced: 'Unpriced',
    save: 'Save',
    saved: 'Saved',
    months: 'mo',
    loading: 'Loading…',
    loadError: 'The plans could not be loaded',
    retry: 'Retry',
    badPrice: 'The price must be a non-negative whole number',
    launchTitle: 'Membership launch',
    launchActive: 'Launch activated',
    launchInactive: 'Launch not activated — every paid membership stays reserved until it is.',
    launchAt: 'Announced launch date',
    activatedAt: 'Activated at',
    notSet: 'Not set',
    activate: 'Activate launch',
    activateTitle: 'Activate the membership launch',
    activateBody: 'This is final and starts the clock on every prepaid membership from this moment. Type ACTIVATE to confirm.',
    typeHere: 'Type ACTIVATE',
    confirm: 'Activate now',
    cancel: 'Cancel',
    working: 'Working…',
    activated: (n: number) => `Activated — ${n} memberships started now.`,
    alreadyActivated: (n: number) => `The launch was already active — ${n} straggling memberships started now.`,
    sweep: (n: number) => `Activate remaining reservations (${n})`,
    sweepNone: 'No reservations left — every paid membership is running.',
    sweepTitle: 'Activate remaining reservations',
    deferred: (n: number) => `${n} reservations will never start — the account already runs a higher tier. Refund or cancel them by hand.`,
    sweepBody: 'Starts the clock on every remaining reservation from this moment, with the launch rules (highest tier per account, lower ones cancelled). Type ACTIVATE to confirm.',
    pauseTitle: 'Pause PRO',
    pausedState: (since: string, n: number) => `PRO paused since ${since} — ${n} memberships frozen; their days do not run until it resumes.`,
    liveState: 'PRO is on sale and running normally.',
    pauseHint: 'While paused: PRO is neither sold nor granted, its card reads “Coming soon” with no price or benefits, and every member’s days are frozen while they keep the PREMIUM benefits. On resume each member gets the frozen time back in full.',
    pauseBtn: 'Pause PRO',
    resumeBtn: 'Resume PRO',
    pauseBody: 'PRO sales stop and every active PRO membership is frozen now. Type PAUSE to confirm.',
    resumeBody: 'PRO goes back on sale and every frozen membership is extended by the time it spent frozen. Type RESUME to confirm.',
    pausedDone: (n: number) => `PRO paused — ${n} memberships frozen.`,
    resumedDone: (n: number) => `PRO resumed — ${n} memberships extended.`,
    schemaPending: 'The database update the PRO pause needs has not been applied yet — try again in a few minutes.',
    pausedChip: 'Paused',
  },
  ckb: {
    tab: 'پلان و دەستپێکردن',
    title: 'پلانەکانی ئەندامێتی',
    intro: 'نرخ بە دیناری عێراقی (ژمارەی تەواو). خانەکە بەتاڵ بهێڵەرەوە بۆ ئەوەی پلانەکە "بێ نرخ" بێت — نافرۆشرێت و کڕیار دەبینێت نرخ دواتر ڕادەگەیەنرێت.',
    tier: 'ئاست',
    duration: 'ماوە',
    price: 'نرخ (د.ع)',
    active: 'چالاک',
    inactive: 'ناچالاک',
    purchasable: 'دەکڕدرێت',
    unpriced: 'بێ نرخ',
    save: 'پاشەکەوت',
    saved: 'پاشەکەوت کرا',
    months: 'مانگ',
    loading: 'باردەکرێت…',
    loadError: 'پلانەکان بار نەکران',
    retry: 'دووبارە هەوڵبدەرەوە',
    badPrice: 'نرخ دەبێت ژمارەیەکی تەواوی نا-نەرێنی بێت',
    launchTitle: 'دەستپێکردنی ئەندامێتییەکان',
    launchActive: 'دەستپێکردن چالاک کراوە',
    launchInactive: 'دەستپێکردن چالاک نەکراوە — هەموو ئەندامێتییە پارەدراوەکان پارێزراو دەمێننەوە تا چالاک دەکرێت.',
    launchAt: 'بەرواری ڕاگەیەنراوی دەستپێکردن',
    activatedAt: 'چالاک کرا لە',
    notSet: 'دیاری نەکراوە',
    activate: 'چالاککردنی دەستپێکردن',
    activateTitle: 'چالاککردنی دەستپێکردنی ئەندامێتی',
    activateBody: 'ئەمە کۆتاییە و کاتژمێری هەموو ئەندامێتییەکی پێشپارەدراو لەم ساتەوە دەست پێدەکات. ACTIVATE بنووسە بۆ پشتڕاستکردنەوە.',
    typeHere: 'ACTIVATE بنووسە',
    confirm: 'ئێستا چالاک بکە',
    cancel: 'پاشگەزبوونەوە',
    working: 'جێبەجێ دەکرێت…',
    activated: (n: number) => `چالاک کرا — ${n} ئەندامێتی ئێستا دەستی پێکرد.`,
    alreadyActivated: (n: number) => `دەستپێکردن پێشتر چالاک بوو — ${n} ئەندامێتیی دواکەوتوو ئێستا دەستی پێکرد.`,
    sweep: (n: number) => `چالاککردنی پارێزراوە ماوەکان (${n})`,
    sweepNone: 'هیچ پارێزراوێک نەماوە.',
    sweepTitle: 'چالاککردنی پارێزراوە ماوەکان',
    deferred: (n: number) => `${n} — refund / cancel`,
    sweepBody: 'ACTIVATE بنووسە بۆ پشتڕاستکردنەوە.',
    pauseTitle: 'ڕاگرتنی کاتیی PRO',
    pausedState: (since: string, n: number) => `PRO لە ${since} ەوە ڕاگیراوە — ${n} ئەندامێتی بەستراوە.`,
    liveState: 'PRO دەفرۆشرێت و بە ئاسایی کار دەکات.',
    pauseHint: 'لە کاتی ڕاگرتندا PRO نافرۆشرێت، ڕۆژەکانی هەر ئەندامێک دەبەسترێن و سوودەکانی PREMIUM ی بۆ دەمێنێتەوە؛ لە کاتی دەستپێکردنەوەدا هەموو ماوە بەستراوەکە دەگەڕێتەوە.',
    pauseBtn: 'ڕاگرتنی PRO',
    resumeBtn: 'دەستپێکردنەوەی PRO',
    pauseBody: 'PAUSE بنووسە بۆ پشتڕاستکردنەوە.',
    resumeBody: 'RESUME بنووسە بۆ پشتڕاستکردنەوە.',
    pausedDone: (n: number) => `PRO ڕاگیرا — ${n} ئەندامێتی بەسترا.`,
    resumedDone: (n: number) => `PRO دەستی پێکردەوە — ${n} ئەندامێتی درێژکرایەوە.`,
    // OWNER: Sorani to be written by hand; a Kurdish-reading admin gets the Arabic.
    schemaPending: 'تحديث قاعدة البيانات الذي يحتاجه إيقاف PRO لم يُطبَّق بعد — أعد المحاولة بعد دقائق.',
    pausedChip: 'ڕاگیراوە',
  },
};

type PS = (typeof PLAN_STRINGS)['en'];

interface AdminPlan {
  id: string;
  tier: string;
  duration_months: number;
  price_iqd: number | null;
  purchasable: boolean;
  active: boolean;
  sort: number;
  /** PRO while PRO is paused (0145): stored price kept, nothing sold. */
  paused?: boolean;
}
interface AdminProPause {
  paused: boolean;
  since: string | null;
  frozen_count: number;
}
interface AdminLaunch {
  launch_at: string | null;
  activated: boolean;
  activated_at: string | null;
}

function PlansSection({ lang }: { lang: 'ar' | 'en' | 'ckb' }) {
  const ps: PS = PLAN_STRINGS[lang] ?? PLAN_STRINGS.ar;
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [launch, setLaunch] = useState<AdminLaunch | null>(null);
  // Reservations still waiting (GET /admin/plans). After the launch they are
  // converted as each account is read; this is what the sweep would start.
  const [prepaidCount, setPrepaidCount] = useState(0);
  // Reservations the sweep leaves alone because the account runs a higher
  // tier. They are not in `prepaidCount`, so the button goes dark once the
  // sweep has done all it can, and these are named as work by hand.
  const [deferredCount, setDeferredCount] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowNote, setRowNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [activateOpen, setActivateOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [activating, setActivating] = useState(false);
  const [launchNote, setLaunchNote] = useState<{ ok: boolean; text: string } | null>(null);
  const activateBtnRef = useRef<HTMLButtonElement>(null);
  // «إيقاف PRO» — the pause switch and its typed confirmation.
  const [proPause, setProPause] = useState<AdminProPause | null>(null);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseText, setPauseText] = useState('');
  const [pausing, setPausing] = useState(false);
  const [pauseNote, setPauseNote] = useState<{ ok: boolean; text: string } | null>(null);
  const pauseBtnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const d = await api.get<{ plans: AdminPlan[]; launch: AdminLaunch; prepaid_count?: number; deferred_count?: number; pro_pause?: AdminProPause }>(
        '/api/memberships/admin/plans'
      );
      setProPause(d.pro_pause ?? null);
      setPrepaidCount(Number(d.prepaid_count) || 0);
      setDeferredCount(Number(d.deferred_count) || 0);
      setPlans(d.plans);
      setLaunch(d.launch);
      const next: Record<string, string> = {};
      for (const p of d.plans) next[p.id] = p.price_iqd === null ? '' : String(p.price_iqd);
      setDrafts(next);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : ps.loadError);
      setPlans([]);
    }
  }, [ps.loadError]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(plan: AdminPlan, body: { price_iqd?: number | null; active?: boolean }) {
    setRowBusy(plan.id);
    setRowNote((n) => ({ ...n, [plan.id]: { ok: true, text: '' } }));
    try {
      const r = await api.patch<{ plan: AdminPlan }>(`/api/memberships/admin/plans/${encodeURIComponent(plan.id)}`, body);
      setPlans((cur) => (cur ? cur.map((p) => (p.id === plan.id ? { ...p, ...r.plan } : p)) : cur));
      setDrafts((d) => ({ ...d, [plan.id]: r.plan.price_iqd === null ? '' : String(r.plan.price_iqd) }));
      setRowNote((n) => ({ ...n, [plan.id]: { ok: true, text: ps.saved } }));
    } catch (e) {
      setRowNote((n) => ({ ...n, [plan.id]: { ok: false, text: e instanceof ApiError ? e.message : ps.loadError } }));
    } finally {
      setRowBusy(null);
    }
  }

  function savePrice(plan: AdminPlan) {
    const raw = (drafts[plan.id] ?? '').replace(/[,\s]/g, '');
    if (raw === '') {
      void patch(plan, { price_iqd: null });
      return;
    }
    if (!/^\d+$/.test(raw)) {
      setRowNote((n) => ({ ...n, [plan.id]: { ok: false, text: ps.badPrice } }));
      return;
    }
    void patch(plan, { price_iqd: Number(raw) });
  }

  async function toggleProPause() {
    if (!proPause || pausing) return;
    const next = !proPause.paused;
    const word = next ? 'PAUSE' : 'RESUME';
    if (pauseText !== word) return;
    setPausing(true);
    try {
      const r = await api.post<{ memberships: number }>('/api/memberships/admin/pro-pause', { paused: next, confirm: word });
      setPauseNote({ ok: true, text: next ? ps.pausedDone(r.memberships) : ps.resumedDone(r.memberships) });
      setPauseOpen(false);
      setPauseText('');
      await load();
    } catch (e) {
      setPauseNote({ ok: false, text: e instanceof ApiError ? (e.code === 'SCHEMA_PENDING' ? ps.schemaPending : e.message) : ps.loadError });
    } finally {
      setPausing(false);
    }
  }

  async function activateLaunch() {
    if (confirmText !== 'ACTIVATE' || activating) return;
    setActivating(true);
    try {
      const r = await api.post<{ already_activated: boolean; converted: number; activated_at: string }>(
        '/api/memberships/admin/activate-launch',
        { confirm: 'ACTIVATE' }
      );
      setLaunchNote({ ok: true, text: r.already_activated ? ps.alreadyActivated(r.converted) : ps.activated(r.converted) });
      setActivateOpen(false);
      setConfirmText('');
      await load();
    } catch (e) {
      setLaunchNote({ ok: false, text: e instanceof ApiError ? e.message : ps.loadError });
    } finally {
      setActivating(false);
    }
  }

  const inputCls =
    'min-h-[36px] w-32 rounded-lg bg-zinc-800 border border-zinc-700 px-2 text-white text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-gold';

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-white font-bold text-base flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-gold" aria-hidden /> {ps.title}
            </h3>
            <p className="text-zinc-500 text-xs mt-1 max-w-2xl leading-relaxed">{ps.intro}</p>
          </div>
          <button
            type="button"
            onClick={load}
            aria-label={ps.retry}
            className="p-2 min-h-[36px] min-w-[36px] bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 hover:text-white"
          >
            <RefreshCw className={`w-4 h-4 ${plans === null ? 'animate-spin' : ''}`} aria-hidden />
          </button>
        </div>

        {loadError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm">
            {loadError}{' '}
            <button type="button" onClick={load} className="underline">
              {ps.retry}
            </button>
          </div>
        )}

        {plans === null ? (
          <p className="text-zinc-500 text-sm py-6">{ps.loading}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-zinc-900/60 text-zinc-400 text-[11px] uppercase">
                <tr>
                  <th className="text-start py-2.5 px-3 font-bold">{ps.tier}</th>
                  <th className="text-start py-2.5 px-3 font-bold">{ps.duration}</th>
                  <th className="text-start py-2.5 px-3 font-bold">{ps.price}</th>
                  <th className="text-start py-2.5 px-3 font-bold">{ps.active}</th>
                  <th className="py-2.5 px-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {plans.map((p) => {
                  const meta = tierMetaFor(p.tier);
                  const note = rowNote[p.id];
                  const busy = rowBusy === p.id;
                  return (
                    <tr key={p.id} data-admin-plan={p.id}>
                      <td className="py-2.5 px-3">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-black px-2 py-0.5 rounded-md border ${meta ? meta.chip : 'border-zinc-700 text-zinc-300'}`}>
                          {meta && <meta.Icon className="w-3.5 h-3.5" aria-hidden />}
                          {tierLabel(p.tier)}
                        </span>
                        <div className="text-[10px] text-zinc-600 font-mono mt-1">{p.id}</div>
                      </td>
                      <td className="py-2.5 px-3 text-white tabular-nums" dir="ltr">
                        {p.duration_months} {ps.months}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            value={drafts[p.id] ?? ''}
                            onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') savePrice(p);
                            }}
                            inputMode="numeric"
                            dir="ltr"
                            placeholder={ps.unpriced}
                            aria-label={`${ps.price} — ${tierLabel(p.tier)} ${p.duration_months}`}
                            className={inputCls}
                          />
                          <button
                            type="button"
                            onClick={() => savePrice(p)}
                            disabled={busy}
                            className="min-h-[36px] px-3 rounded-lg bg-gold text-accent-contrast text-xs font-bold disabled:opacity-40"
                          >
                            {busy ? ps.working : ps.save}
                          </button>
                          <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-full border ${p.paused ? 'border-amber-500/30 text-amber-300 bg-amber-500/10' : p.purchasable ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10' : 'border-amber-500/30 text-amber-300 bg-amber-500/10'}`}>
                            {p.paused ? ps.pausedChip : p.purchasable ? `${ps.purchasable} · ${formatIqd(p.price_iqd as number)}` : ps.unpriced}
                          </span>
                        </div>
                        {note?.text && (
                          <p role={note.ok ? 'status' : 'alert'} className={`text-[11px] mt-1 ${note.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                            {note.text}
                          </p>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={p.active}
                          aria-label={`${ps.active} — ${tierLabel(p.tier)} ${p.duration_months}`}
                          disabled={busy}
                          onClick={() => patch(p, { active: !p.active })}
                          className={`min-h-[32px] px-3 rounded-full text-xs font-bold border transition-colors disabled:opacity-40 ${
                            p.active
                              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                              : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                          }`}
                        >
                          {p.active ? ps.active : ps.inactive}
                        </button>
                      </td>
                      <td className="py-2.5 px-3 text-[10px] text-zinc-600 tabular-nums" dir="ltr">
                        sort {p.sort}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {proPause && (
        <section data-pro-pause={proPause.paused ? 'paused' : 'live'} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <h3 className="text-white font-bold text-base flex items-center gap-2">
            <PauseCircle className="w-4 h-4 text-coral" aria-hidden /> {ps.pauseTitle}
          </h3>
          <p className={`text-sm font-bold ${proPause.paused ? 'text-amber-300' : 'text-emerald-300'}`}>
            {proPause.paused ? ps.pausedState((proPause.since ?? '').slice(0, 10), proPause.frozen_count) : ps.liveState}
          </p>
          <p className="text-zinc-500 text-xs leading-relaxed max-w-2xl">{ps.pauseHint}</p>
          <button
            ref={pauseBtnRef}
            type="button"
            onClick={() => {
              setPauseNote(null);
              setPauseText('');
              setPauseOpen(true);
            }}
            aria-haspopup="dialog"
            className={`min-h-[40px] px-4 rounded-xl text-sm font-bold ${proPause.paused ? 'bg-emerald-600 text-snow' : 'bg-[#B03142] text-snow'}`}
          >
            {proPause.paused ? ps.resumeBtn : ps.pauseBtn}
          </button>
          {pauseNote && <p className={`text-[12.5px] ${pauseNote.ok ? 'text-emerald-400' : 'text-red-400'}`}>{pauseNote.text}</p>}
        </section>
      )}

      <Overlay
        open={pauseOpen}
        onClose={() => {
          if (!pausing) setPauseOpen(false);
        }}
        labelledBy="pro-pause-title"
        anchor={pauseBtnRef}
        dismissOnEscape={!pausing}
        dismissOnScrim={!pausing}
        testId="pro-pause"
        panelClassName="w-full max-w-md"
      >
        <div className="p-5 sm:p-6">
          <h2 id="pro-pause-title" className="text-white font-bold text-lg flex items-center gap-2">
            <PauseCircle className="w-5 h-5 text-coral" aria-hidden /> {proPause?.paused ? ps.resumeBtn : ps.pauseBtn}
          </h2>
          <p className="text-zinc-300 text-sm mt-2 leading-relaxed">{proPause?.paused ? ps.resumeBody : ps.pauseBody}</p>
          <input
            value={pauseText}
            onChange={(e) => setPauseText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void toggleProPause();
            }}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder={proPause?.paused ? 'RESUME' : 'PAUSE'}
            aria-label={proPause?.paused ? 'RESUME' : 'PAUSE'}
            className="mt-4 w-full min-h-[44px] rounded-xl bg-zinc-900 border border-zinc-700 px-3 text-white font-mono tracking-widest outline-none focus-visible:ring-2 focus-visible:ring-crimson"
          />
          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button
              type="button"
              onClick={() => setPauseOpen(false)}
              disabled={pausing}
              className="flex-1 min-h-[48px] rounded-2xl border border-zinc-700 text-zinc-200 font-semibold hover:bg-zinc-900 disabled:opacity-50"
            >
              {ps.cancel}
            </button>
            <button
              type="button"
              onClick={() => void toggleProPause()}
              disabled={pausing || pauseText !== (proPause?.paused ? 'RESUME' : 'PAUSE')}
              className="flex-1 min-h-[48px] rounded-2xl bg-[#B03142] text-snow font-bold disabled:opacity-40"
            >
              {pausing ? ps.working : proPause?.paused ? ps.resumeBtn : ps.pauseBtn}
            </button>
          </div>
        </div>
      </Overlay>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <h3 className="text-white font-bold text-base flex items-center gap-2">
          <Rocket className="w-4 h-4 text-gold" aria-hidden /> {ps.launchTitle}
        </h3>
        {launch ? (
          <div className="text-sm space-y-1.5">
            <p className={launch.activated ? 'text-emerald-300 font-bold' : 'text-amber-300'}>
              {launch.activated ? ps.launchActive : ps.launchInactive}
            </p>
            <p className="text-zinc-400 text-xs" dir="ltr">
              {ps.launchAt}: {launch.launch_at ?? ps.notSet}
            </p>
            {launch.activated && (
              <p className="text-zinc-400 text-xs" dir="ltr">
                {ps.activatedAt}: {launch.activated_at ?? ps.notSet}
              </p>
            )}
          </div>
        ) : (
          <p className="text-zinc-500 text-sm">{ps.loading}</p>
        )}
        <button
          ref={activateBtnRef}
          type="button"
          onClick={() => {
            setLaunchNote(null);
            setConfirmText('');
            setActivateOpen(true);
          }}
          // Before the launch: the launch. After it: the leftover sweep, which
          // used to be unreachable once the launch was on.
          disabled={!launch || (launch.activated && prepaidCount === 0)}
          aria-haspopup="dialog"
          className="min-h-[40px] px-4 rounded-xl bg-[#B03142] text-snow text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {launch?.activated ? ps.sweep(prepaidCount) : ps.activate}
        </button>
        {launch?.activated && prepaidCount === 0 && deferredCount === 0 && <p className="text-[12px] text-zinc-500">{ps.sweepNone}</p>}
        {deferredCount > 0 && <p className="text-[12px] text-amber-300">{ps.deferred(deferredCount)}</p>}
        {launchNote && (
          <p className={`text-[12.5px] ${launchNote.ok ? 'text-emerald-400' : 'text-red-400'}`}>{launchNote.text}</p>
        )}
      </section>

      <Overlay
        open={activateOpen}
        onClose={() => {
          if (!activating) setActivateOpen(false);
        }}
        labelledBy="activate-launch-title"
        label={launch?.activated ? ps.sweepTitle : ps.activateTitle}
        anchor={activateBtnRef}
        dismissOnEscape={!activating}
        dismissOnScrim={!activating}
        testId="activate-launch"
        panelClassName="w-full max-w-md"
      >
        <div className="p-5 sm:p-6">
          <h2 id="activate-launch-title" className="text-white font-bold text-lg flex items-center gap-2">
            <Rocket className="w-5 h-5 text-coral" aria-hidden /> {launch?.activated ? ps.sweepTitle : ps.activateTitle}
          </h2>
          <p className="text-zinc-300 text-sm mt-2 leading-relaxed">{launch?.activated ? ps.sweepBody : ps.activateBody}</p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') activateLaunch();
            }}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder={ps.typeHere}
            aria-label={ps.typeHere}
            className="mt-4 w-full min-h-[44px] rounded-xl bg-zinc-900 border border-zinc-700 px-3 text-white font-mono tracking-widest outline-none focus-visible:ring-2 focus-visible:ring-crimson"
          />
          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button
              type="button"
              onClick={() => setActivateOpen(false)}
              disabled={activating}
              className="flex-1 min-h-[48px] rounded-2xl border border-zinc-700 text-zinc-200 font-semibold hover:bg-zinc-900 disabled:opacity-50"
            >
              {ps.cancel}
            </button>
            <button
              type="button"
              onClick={activateLaunch}
              disabled={confirmText !== 'ACTIVATE' || activating}
              className="flex-1 min-h-[48px] rounded-2xl bg-[#B03142] text-snow font-bold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {activating ? ps.working : ps.confirm}
            </button>
          </div>
        </div>
      </Overlay>
    </div>
  );
}

// ==================================================================== root

export default function AdminMemberships() {
  const { lang } = useLanguage();
  const s: S = STRINGS[lang] ?? STRINGS.ar;
  const [tab, setTab] = useState<'members' | 'queue' | 'plans'>('members');
  const ps: PS = PLAN_STRINGS[lang] ?? PLAN_STRINGS.ar;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap bg-zinc-900 border border-zinc-800 p-1 rounded-xl w-fit">
        <button
          type="button"
          onClick={() => setTab('members')}
          className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
            tab === 'members' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          {s.tabMembers}
        </button>
        <button
          type="button"
          onClick={() => setTab('queue')}
          className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
            tab === 'queue' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Inbox className="w-3.5 h-3.5" />
          {s.tabQueue}
        </button>
        <button
          type="button"
          data-admin-tab="plans"
          onClick={() => setTab('plans')}
          className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
            tab === 'plans' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <CreditCard className="w-3.5 h-3.5" />
          {ps.tab}
        </button>
      </div>

      {tab === 'members' ? (
        <MembersSection s={s} lang={lang} />
      ) : tab === 'queue' ? (
        <SupportQueue />
      ) : (
        <PlansSection lang={lang} />
      )}
    </div>
  );
}
