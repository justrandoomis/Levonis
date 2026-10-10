import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Copy, Check, Share2, Gift, UserPlus, Link2, ShieldCheck, Info,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import { ErrorState, EmptyState, UnauthorizedState } from '../components/ui/AsyncStates';
import { IconButton } from '../components/ui/Button';
import { StatusChip, type Tone } from '../components/ui/Badge';

/**
 * /referrals — the standalone referrals & support-code page (integrated
 * mandate §3.1). It shows the unique username handle, the invite link, how a
 * SIGNUP INVITE differs from a PURCHASE SUPPORT CODE, and the state of every
 * gift claim — without ever exposing who bought what.
 *
 * This module also owns the browser-side pending support ref used by the
 * cart (§3.3). Those helpers are exported below and are storage-injectable
 * so they can be unit-tested without a DOM (tests/supportCode.test.ts).
 */

// The support-ref helpers live in `src/lib/supportRef.ts` — see the note at
// the top of that file for why they had to leave this one. They are re-exported
// here so every existing import path (`from './Referrals'`) still resolves.
import { inviteLinkFor } from '../lib/supportRef';
export * from '../lib/supportRef';

// ===========================================================================
// Page
// ===========================================================================

type GiftState = 'pending_eligibility' | 'due' | 'reserved' | 'paid' | 'cancelled';

interface SupportGift {
  id: string;
  order_ref: string;
  state: GiftState;
  needs_review: boolean;
  review_reason: string;
  outcome_reason: string;
  created_at: string;
  qualified_at: string | null;
  decided_at: string | null;
}

interface SignupReward {
  id: string;
  campaign: 'printer' | 'pro_sub' | string;
  state: string;
  eligible_at: string | null;
  created_at: string;
}

interface ReferralsMe {
  username: string | null;
  legacy_code: string | null;
  invite_path: string;
  product_ref_param: string;
  signup_invites: number;
  support_gifts: SupportGift[];
  support_gift_counts: Record<GiftState, number>;
  signup_rewards: SignupReward[];
}

const STRINGS = {
  ar: {
    title: 'الإحالات وكود الدعم',
    back: 'رجوع',
    handle: 'اسم المستخدم الخاص بك',
    noHandle: 'لا يوجد اسم مستخدم بعد',
    noHandleDesc: 'اختر اسم مستخدم فريدًا من تعديل الملف الشخصي لتحصل على رابط دعوة وكود دعم.',
    setHandle: 'اختيار اسم مستخدم',
    inviteLink: 'رابط الدعوة للتسجيل',
    copy: 'نسخ',
    copied: 'تم النسخ',
    share: 'مشاركة',
    legacyCode: 'الكود القديم (يبقى صالحًا)',
    diffTitle: 'ما الفرق؟',
    inviteTitle: 'دعوة التسجيل',
    inviteDesc: 'رابطك أعلاه ينشئ حسابًا جديدًا مرتبطًا بك. الارتباط يحدث مرة واحدة عند إنشاء الحساب، ولا يتغير لاحقًا. إنشاء الحساب وحده لا يمنح هدية.',
    supportTitle: 'كود دعم الشراء',
    supportDesc: 'عند مشاركة منتج من حسابك يضاف كودك إلى الرابط. من يفتحه ويشتري يمكنه دعمك — الكود لا يغيّر سعر طلبه إطلاقًا، ولا يمنحه أو يمنعه أي خصم.',
    shareProduct: 'مشاركة منتج بكودك',
    shareProductDesc: 'من صفحة أي منتج اضغط مشاركة وأنت مسجّل الدخول: يُضاف {param} إلى رابط المنتج نفسه.',
    giftsTitle: 'هدايا الدعم',
    giftsDesc: 'تُنشأ الهدية للمُحيل بعد تسليم الطلب وتحصيل دفعه فعليًا، ولمرة واحدة لكل طلب مؤهل. لا تُشترط عضوية PRO ولا توجد مهلة سبعة أيام هنا — تلك مهلة النقاط ونظام مختلف.',
    giftsEmpty: 'لا توجد هدايا دعم بعد',
    giftsEmptyDesc: 'شارك رابط منتج مؤهل بكودك؛ تظهر الهدية هنا بعد التسليم والتحصيل.',
    rewardsTitle: 'برنامج الإحالة السابق (منفصل)',
    rewardsDesc: 'مكافآت دعوات التسجيل واشتراكات PRO تبقى كما هي في برنامجها الخاص، ولا تُدمج مع هدايا كود الدعم.',
    rewardsEmpty: 'لا توجد مكافآت في البرنامج السابق',
    invites: 'حسابات انضمت بدعوتك',
    stateLabels: {
      pending_eligibility: 'بانتظار الأهلية',
      due: 'مستحقة',
      reserved: 'محجوزة',
      paid: 'مصروفة',
      cancelled: 'ملغاة',
    } as Record<GiftState, string>,
    review: 'قيد المراجعة الإدارية',
    orderRef: 'طلب',
    created: 'أُنشئت',
    qualified: 'استحقت',
    printer: 'إحالة شراء طابعة',
    proSub: 'إحالة اشتراك PRO',
    noPii: 'لا تُعرض بيانات المشتري هنا — فقط حالة استحقاقك.',
    signIn: 'سجّل الدخول لعرض إحالاتك',
  },
  en: {
    title: 'Referrals & support code',
    back: 'Back',
    handle: 'Your username',
    noHandle: 'No username yet',
    noHandleDesc: 'Pick a unique username in Edit profile to get an invite link and a support code.',
    setHandle: 'Choose a username',
    inviteLink: 'Sign-up invite link',
    copy: 'Copy',
    copied: 'Copied',
    share: 'Share',
    legacyCode: 'Legacy code (still valid)',
    diffTitle: 'What is the difference?',
    inviteTitle: 'Sign-up invite',
    inviteDesc: 'The link above creates a new account linked to you. The link is bound once, at account creation, and never moves afterwards. Creating an account alone grants no gift.',
    supportTitle: 'Purchase support code',
    supportDesc: 'Sharing a product while signed in adds your code to the link. Whoever opens it can support you when they buy — the code never changes their price, and it neither adds nor blocks any discount.',
    shareProduct: 'Share a product with your code',
    shareProductDesc: 'On any product page, tap Share while signed in: {param} is added to that product’s own link.',
    giftsTitle: 'Support gifts',
    giftsDesc: 'A gift is created for the referrer after the order is delivered AND its payment is actually collected — once per qualifying order. No PRO membership is required and there is no seven-day wait here; that clock belongs to points, a different system.',
    giftsEmpty: 'No support gifts yet',
    giftsEmptyDesc: 'Share an eligible product link with your code; the gift appears here after delivery and collection.',
    rewardsTitle: 'Earlier referral program (separate)',
    rewardsDesc: 'Sign-up invite and PRO subscription rewards stay in their own program and are never merged with support-code gifts.',
    rewardsEmpty: 'No rewards in the earlier program',
    invites: 'Accounts joined with your invite',
    stateLabels: {
      pending_eligibility: 'Awaiting eligibility',
      due: 'Due',
      reserved: 'Reserved',
      paid: 'Fulfilled',
      cancelled: 'Cancelled',
    } as Record<GiftState, string>,
    review: 'Held for admin review',
    orderRef: 'Order',
    created: 'Created',
    qualified: 'Qualified',
    printer: 'Printer purchase referral',
    proSub: 'PRO subscription referral',
    noPii: 'No buyer details are shown here — only the state of your claim.',
    signIn: 'Sign in to see your referrals',
  },
  ckb: {
    title: 'بانگهێشتکردن و کۆدی پاڵپشتی',
    back: 'گەڕانەوە',
    handle: 'ناوی بەکارهێنەری تۆ',
    noHandle: 'هێشتا ناوی بەکارهێنەر نییە',
    noHandleDesc: 'لە دەستکاری پرۆفایل ناوێکی بەکارهێنەری تایبەت هەڵبژێرە بۆ وەرگرتنی لینکی بانگهێشت و کۆدی پاڵپشتی.',
    setHandle: 'هەڵبژاردنی ناوی بەکارهێنەر',
    inviteLink: 'لینکی بانگهێشتی خۆتۆمارکردن',
    copy: 'لەبەرگرتنەوە',
    copied: 'لەبەرگیرایەوە',
    share: 'هاوبەشکردن',
    legacyCode: 'کۆدی کۆن (هێشتا کاردەکات)',
    diffTitle: 'جیاوازییەکە چییە؟',
    inviteTitle: 'بانگهێشتی خۆتۆمارکردن',
    inviteDesc: 'لینکەکەی سەرەوە هەژمارێکی نوێ دروست دەکات کە بە تۆوە بەستراوە. بەستنەکە تەنها یەک جار لە کاتی دروستکردنی هەژماردا ڕوودەدات و دواتر ناگۆڕێت. دروستکردنی هەژمار بە تەنها هیچ دیارییەک نادات.',
    supportTitle: 'کۆدی پاڵپشتی کڕین',
    supportDesc: 'کاتێک بەرهەمێک هاوبەش دەکەیت و چووبیتە ژوورەوە، کۆدەکەت بۆ لینکەکە زیاد دەکرێت. ئەوەی دەیکاتەوە و دەکڕێت دەتوانێت پاڵپشتیت بکات — کۆدەکە هەرگیز نرخی داواکاریەکەی ناگۆڕێت.',
    shareProduct: 'هاوبەشکردنی بەرهەم بە کۆدەکەت',
    shareProductDesc: 'لە پەڕەی هەر بەرهەمێک، لە کاتی چوونەژوورەوە دوگمەی هاوبەشکردن دابگرە: {param} بۆ لینکی هەمان بەرهەم زیاد دەکرێت.',
    giftsTitle: 'دیاری پاڵپشتی',
    giftsDesc: 'دیاری بۆ بانگهێشتکار دروست دەبێت دوای گەیاندنی داواکاری و کۆکردنەوەی پارەکەی بە ڕاستی، یەک جار بۆ هەر داواکارییەکی شیاو. ئەندامێتی PRO پێویست نییە و لێرەدا چاوەڕوانی حەوت ڕۆژ نییە.',
    giftsEmpty: 'هێشتا هیچ دیارییەکی پاڵپشتی نییە',
    giftsEmptyDesc: 'لینکی بەرهەمێکی شیاو بە کۆدەکەت هاوبەش بکە؛ دیارییەکە دوای گەیاندن و کۆکردنەوە لێرە دەردەکەوێت.',
    rewardsTitle: 'پرۆگرامی پێشووی بانگهێشتکردن (جیاواز)',
    rewardsDesc: 'خەڵاتەکانی بانگهێشتی خۆتۆمارکردن و ئەندامێتی PRO لە پرۆگرامی خۆیاندا دەمێننەوە و لەگەڵ دیاری کۆدی پاڵپشتی تێکەڵ ناکرێن.',
    rewardsEmpty: 'هیچ خەڵاتێک لە پرۆگرامی پێشوودا نییە',
    invites: 'هەژمارەکانی بە بانگهێشتی تۆ هاتوون',
    stateLabels: {
      pending_eligibility: 'چاوەڕێی شیاوبوون',
      due: 'شیاوە',
      reserved: 'حیجزکراوە',
      paid: 'گەیەنراوە',
      cancelled: 'هەڵوەشێنراوەتەوە',
    } as Record<GiftState, string>,
    review: 'لە پێداچوونەوەی بەڕێوەبەریدایە',
    orderRef: 'داواکاری',
    created: 'دروستکراوە',
    qualified: 'شیاو بووە',
    printer: 'بانگهێشتکردنی کڕینی پرینتەر',
    proSub: 'بانگهێشتکردنی ئەندامێتی PRO',
    noPii: 'هیچ زانیاریەکی کڕیار لێرە پیشان نادرێت — تەنها دۆخی مافەکەت.',
    signIn: 'بچۆ ژوورەوە بۆ بینینی بانگهێشتەکانت',
  },
} as const;

const STATE_TONE: Record<GiftState, Tone> = {
  pending_eligibility: 'warning',
  due: 'success',
  reserved: 'info',
  paid: 'success',
  cancelled: 'danger',
};

export default function Referrals() {
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const { isAuthenticated, isLoaded } = useAuth();
  const s = STRINGS[lang] ?? STRINGS.ar;

  const [data, setData] = useState<ReferralsMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [shareNote, setShareNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<ReferralsMe>('/api/referrals/me');
      setData(res);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    load();
  }, [isLoaded, isAuthenticated, load]);

  // The origin is the one the page is actually served from — never a
  // hardcoded host, so staging never hands out production links.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const handle = data?.username || '';
  const inviteLink = handle ? inviteLinkFor(handle, origin) : '';

  const copy = async (text: string) => {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setShareNote(lang === 'en' ? 'Copying is blocked by the browser — select the link manually.' : 'النسخ محجوب من المتصفح — حدد الرابط يدويًا.');
    }
  };

  const share = async () => {
    if (!inviteLink) return;
    try {
      if (navigator.share) await navigator.share({ title: 'LEVONIS', url: inviteLink });
      else await copy(inviteLink);
    } catch {
      /* the user dismissed the share sheet — not an error */
    }
  };

  const fmtDate = (iso: string | null | undefined) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString(lang === 'ar' ? 'ar-IQ' : lang === 'ckb' ? 'ckb' : 'en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return d.toLocaleDateString('en-GB');
    }
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div className="w-full min-h-screen text-text-primary font-sans pb-24">
      <div className="sticky top-0 z-30 bg-canvas border-b border-border-subtle px-4 py-3 flex items-center gap-2">
        <IconButton
          label={s.back}
          onClick={() => {
            navigate(-1);
          }}
          className="-ms-2"
          icon={<Back className="w-5 h-5" aria-hidden="true" />}
        />
        <h1 className="text-text-primary font-bold text-[17px]">{s.title}</h1>
      </div>

      <div className="max-w-3xl mx-auto px-4 pt-4 flex flex-col gap-4">
        {!isLoaded || loading ? (
          <SkeletonGroup className="flex flex-col gap-4">
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </SkeletonGroup>
        ) : !isAuthenticated ? (
          <UnauthorizedState next="/referrals" />
        ) : error ? (
          <ErrorState error={error} onRetry={load} next="/referrals" />
        ) : !data ? (
          <ErrorState onRetry={load} next="/referrals" />
        ) : (
          <>
            {/* ---------------------------------------------- handle + link */}
            <section className="lv-surface p-4">
              <p className="text-[12px] text-text-muted mb-1">{s.handle}</p>
              {handle ? (
                <>
                  <p dir="ltr" className="text-text-primary font-bold text-[20px] font-mono text-start break-all">@{handle}</p>
                  <p className="text-[12px] text-text-muted mt-3 mb-1">{s.inviteLink}</p>
                  <div className="flex flex-wrap items-center gap-2 lv-well rounded-lg p-2">
                    <span dir="ltr" className="flex-1 min-w-0 text-[12px] font-mono text-text-secondary break-all text-start">
                      {inviteLink}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => copy(inviteLink)}
                        className="lv-button lv-button-primary lv-button-sm"
                      >
                        {copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
                        {copied ? s.copied : s.copy}
                      </button>
                      <button
                        type="button"
                        onClick={share}
                        className="lv-button lv-button-secondary lv-button-sm"
                      >
                        <Share2 className="w-4 h-4" aria-hidden="true" />
                        {s.share}
                      </button>
                    </div>
                  </div>
                  {shareNote && <p className="text-[12px] text-warning mt-2">{shareNote}</p>}
                  {data.legacy_code && (
                    <p className="text-[12px] text-text-muted mt-3">
                      {s.legacyCode}: <span dir="ltr" className="font-mono text-text-secondary">{data.legacy_code}</span>
                    </p>
                  )}
                  <p className="text-[12px] text-text-muted mt-3 flex items-center gap-1.5">
                    <UserPlus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    {s.invites}: <span className="font-bold text-text-secondary">{data.signup_invites}</span>
                  </p>
                </>
              ) : (
                <div className="flex flex-col gap-2 items-start">
                  <p className="text-text-primary font-bold text-[15px]">{s.noHandle}</p>
                  <p className="text-[13px] text-text-secondary leading-relaxed">{s.noHandleDesc}</p>
                  <button
                    type="button"
                    onClick={() => navigate('/edit-profile')}
                    className="lv-button lv-button-primary"
                  >
                    {s.setHandle}
                  </button>
                </div>
              )}
            </section>

            {/* ------------------------------------- invite vs support code */}
            <section className="lv-surface p-4">
              <h2 className="text-text-primary font-bold text-[15px] mb-3 flex items-center gap-2">
                <Info className="w-4 h-4 text-gold" aria-hidden="true" />
                {s.diffTitle}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg bg-surface-raised p-3">
                  <p className="text-[13px] font-bold text-text-primary mb-1 flex items-center gap-1.5">
                    <UserPlus className="w-4 h-4 text-success" aria-hidden="true" />
                    {s.inviteTitle}
                  </p>
                  <p className="text-[12.5px] text-text-secondary leading-relaxed">{s.inviteDesc}</p>
                </div>
                <div className="rounded-lg bg-surface-raised p-3">
                  <p className="text-[13px] font-bold text-text-primary mb-1 flex items-center gap-1.5">
                    <Link2 className="w-4 h-4 text-info" aria-hidden="true" />
                    {s.supportTitle}
                  </p>
                  <p className="text-[12.5px] text-text-secondary leading-relaxed">{s.supportDesc}</p>
                </div>
              </div>
              {handle && (
                <div className="mt-3 rounded-lg bg-surface-raised p-3">
                  <p className="text-[13px] font-bold text-text-primary mb-1">{s.shareProduct}</p>
                  <p className="text-[12.5px] text-text-secondary leading-relaxed">
                    {s.shareProductDesc.split('{param}')[0]}
                    <code dir="ltr" className="mx-1 px-1.5 py-0.5 rounded bg-surface-selected text-text-primary font-mono text-[12px]">
                      {data.product_ref_param}
                    </code>
                    {s.shareProductDesc.split('{param}')[1]}
                  </p>
                </div>
              )}
            </section>

            {/* ------------------------------------------------- gift claims */}
            <section className="lv-surface p-4">
              <h2 className="text-text-primary font-bold text-[15px] mb-1 flex items-center gap-2">
                <Gift className="w-4 h-4 text-scarlet" aria-hidden="true" />
                {s.giftsTitle}
              </h2>
              <p className="text-[12.5px] text-text-secondary leading-relaxed mb-3">{s.giftsDesc}</p>

              {data.support_gifts.length === 0 ? (
                <EmptyState
                  icon={<Gift aria-hidden="true" className="w-6 h-6" />}
                  title={s.giftsEmpty}
                  description={s.giftsEmptyDesc}
                  compact
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.support_gifts.map((g) => (
                    <li
                      key={g.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-raised px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-[13px] text-text-primary font-bold">
                          {s.orderRef} <span dir="ltr" className="font-mono text-text-secondary">{g.order_ref}</span>
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {s.created} {fmtDate(g.created_at)}
                          {g.qualified_at ? ` · ${s.qualified} ${fmtDate(g.qualified_at)}` : ''}
                        </p>
                        {g.state === 'cancelled' && g.outcome_reason && (
                          <p dir="ltr" className="text-[11px] text-danger font-mono break-all text-start">{g.outcome_reason}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {g.needs_review && (
                          <StatusChip tone="warning" dot={false}>
                            {s.review}
                          </StatusChip>
                        )}
                        <StatusChip tone={STATE_TONE[g.state]}>
                          {s.stateLabels[g.state] ?? g.state}
                        </StatusChip>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11.5px] text-text-muted mt-3 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                {s.noPii}
              </p>
            </section>

            {/* --------------------------------- the separate legacy program */}
            <section className="lv-surface p-4">
              <h2 className="text-text-primary font-bold text-[15px] mb-1">{s.rewardsTitle}</h2>
              <p className="text-[12.5px] text-text-secondary leading-relaxed mb-3">{s.rewardsDesc}</p>
              {data.signup_rewards.length === 0 ? (
                <p className="text-[12.5px] text-text-muted py-2">{s.rewardsEmpty}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.signup_rewards.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-surface-raised px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-[13px] text-text-primary font-bold truncate">
                          {r.campaign === 'printer' ? s.printer : s.proSub}
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {r.state === 'pending' && r.eligible_at ? fmtDate(r.eligible_at) : fmtDate(r.created_at)}
                        </p>
                      </div>
                      <StatusChip>{r.state}</StatusChip>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
