/**
 * THE MEMBER'S PRO FILE, AS A WINDOW.
 *
 * The owner asked for this twice. The first time it was the users table:
 * «عند الضغط على مستخدم أريدها نافذة منبثقة وليس أن يظهر في نهاية الصفحة،
 *  وأريد ترتيب أكثر وإضافة تفاصيل أكثر» — answered by
 * src/components/adminUsers/MemberDetailModal.tsx. The second time it was this
 * screen, and it was left undone: «أما البند الذي لم ينجز شاشة الأعضاء
 * القديمة انقل هذا أيضا».
 *
 * THE FAILURE THAT SENTENCE DESCRIBES. The PRO member detail rendered at the
 * FOOT of a list that is as long as the store has members, so pressing a
 * member scrolled that member off the screen. The admin then read a
 * subscription, a KYC state, a debt and a restriction history with no visible
 * answer to "whose are these?" — and when they were done, the row they pressed
 * was somewhere above them and had to be hunted for again. Every decision made
 * in that state is made against a name held in short-term memory, which is
 * exactly how the wrong member gets restricted.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE SAME WINDOW AS THE USERS TABLE'S, ON PURPOSE.
 *
 * `Overlay` in `modal` mode, ANCHORED to the row control, so the window grows
 * out of that row and collapses back into it; `useModalFocus` for the Tab trap
 * and the focus restore; `Section`, `Row`, `Stat` and `Pill` for the three
 * levels of hierarchy. All four are IMPORTED from `../adminUsers/` rather than
 * re-written here. Two member windows in one admin panel that closed
 * differently, trapped focus differently or dressed a fact differently would
 * be its own defect — the admin would have to learn the panel twice.
 *
 * ---------------------------------------------------------------------------
 * ORDER, NOT A STACK OF CARDS. «وأريد ترتيب أكثر».
 *
 * A strip of the four facts a decision is actually made on (tier, identity,
 * restrictions, debt) at a size that does not need reading, then the six
 * sections of the owner's screenshots — subscription, identity, benefit
 * eligibility, approved address, BNPL, restriction cases — each FINDABLE by
 * the question it answers. The restriction section spans both columns because
 * it is the only one that is also a workspace.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE OF MONEY IS BEHIND THE FINANCIAL SCOPE — AND `Money` IS THE
 * ONLY PLACE ONE IS DRAWN.
 *
 *   «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن
 *    العادي لا يراها في API ولا في HTML ولا في export»
 *
 * This window never asks who is looking. It has no role test, it never reads
 * `can_view_financials` and it never hides a number with a class — a hidden
 * number is still in the HTML, still in the JSON the admin can read in their
 * own devtools, and still in anything they save. It renders WHAT THE SERVER
 * SENT: a figure that arrived is drawn, and a figure that did not is replaced
 * by the sentence saying why. See ./types.ts for why every money field is
 * optional — and for the server gate that now does the withholding, in
 * worker/routes/support.ts, which this window needed no change to obey.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Ban,
  BadgeCheck,
  CreditCard,
  Lock,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  TicketCheck,
  TriangleAlert,
  Wallet,
  X,
} from 'lucide-react';
import { Overlay } from '../ui/Overlay';
import { api, ApiError, formatIqd } from '../../lib/api';
import { tierLabel } from '../subscription/tierMeta';
import { Pill, Row, Section, Stat } from '../adminUsers/ui';
import { useModalFocus } from '../adminUsers/useModalFocus';
import { GrantMembership, ReasonPrompt, RestrictionForm } from './actions';
import { benefitLabel, shortDate, type S } from './strings';
import type { MemberDetailData, RestrictionCase } from './types';

export interface MemberDetailModalProps {
  /** The member to show. `null` closes the window. */
  userId: string | null;
  /** The row control the window was opened from — anchor AND focus return. */
  anchorRef: React.RefObject<HTMLElement | null>;
  s: S;
  lang: 'ar' | 'en' | 'ckb';
  onClose: () => void;
  /** The list behind reloads: a grant or a restriction changes a row in it. */
  onChanged: () => void;
}

const TITLE_ID = 'admin-membership-member-title';

/**
 * THE ONLY PLACE THIS SCREEN PUTS A FIGURE OF MONEY ON THE PAGE.
 *
 * One call site means one rule, and the rule is the presence of the figure in
 * the RESPONSE — `undefined` is the server saying "not for this account", and
 * it becomes the locked note instead of a number. Spreading `formatIqd` back
 * across the sections would mean this decision had to be remembered at six
 * places, and the seventh is the leak.
 *
 * It is also the one thing standing between a gated response and a screen full
 * of `NaN د.ع`: `formatIqd(undefined as unknown as number)` rounds to NaN and
 * prints it, which reads as a real balance to somebody in a hurry.
 */
function Money({ iqd, s, tone = 'plain' }: { iqd: number | null | undefined; s: S; tone?: 'plain' | 'debt' }) {
  /**
   * PRESENCE IS THE ONLY RULE THIS COMPONENT APPLIES — and `undefined` is not
   * the only spelling of absent.
   *
   * The server gate omits these keys outright, which is the shape this window
   * was written for. But a gate is equally often written by NULLING the fields
   * instead, and `formatIqd` is `Math.round(amount).toLocaleString()` —
   * `Math.round(null)` is 0. Every money row would then render «0 د.ع»: zero
   * outstanding debt reads as a FACT, which is a worse lie than `NaN د.ع`
   * because nobody would question it, and the BNPL limit controls follow the
   * figure. A NaN from a malformed value is the same class of defect, so the
   * finite check rides with it.
   */
  if (iqd === undefined || iqd === null || !Number.isFinite(iqd)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold leading-5 text-zinc-500">
        <Lock className="h-3.5 w-3.5" aria-hidden />
        {s.moneyLocked}
        {/* The reason is announced, not merely implied by a padlock glyph. */}
        <span className="sr-only">{s.moneyHidden}</span>
      </span>
    );
  }
  return (
    <span
      dir="auto"
      className={`text-[13px] font-semibold leading-5 tabular-nums ${
        tone === 'debt' && iqd > 0 ? 'text-red-300' : 'text-zinc-200'
      }`}
    >
      {formatIqd(iqd)}
    </span>
  );
}

export default function MemberDetailModal({
  userId,
  anchorRef,
  s,
  lang,
  onClose,
  onChanged,
}: MemberDetailModalProps) {
  const open = userId !== null;
  const { setPanel } = useModalFocus(open, anchorRef);

  const [data, setData] = useState<MemberDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * WHY THE WINDOW KEEPS THE LAST MEMBER IT DREW. `userId` going null IS the
   * close, but the panel is still on screen for the length of its exit spring.
   * Reading the id directly would empty the profile out from under the
   * animation and the admin would watch a blank card shrink back into the row.
   * (The same shape, for the same reason, as the users table's window.)
   */
  const [shown, setShown] = useState<MemberDetailData | null>(null);

  const [showCaseForm, setShowCaseForm] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');
  const [resumeTarget, setResumeTarget] = useState<RestrictionCase | null>(null);
  const [bnplLimit, setBnplLimit] = useState('');
  const [bnplBusy, setBnplBusy] = useState(false);
  const [bnplNote, setBnplNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      setError('');
      try {
        const d = await api.get<{ member: MemberDetailData }>(`/api/support/admin/members/${encodeURIComponent(id)}`);
        setData(d.member);
        setShown(d.member);
        // `?? ''` and not `|| ''`: a stored limit of 0 is a real value, and a
        // response that carried no limit at all must leave the box empty
        // rather than seed it with a figure this account was not given.
        setBnplLimit(d.member.debt.credit_limit_iqd === undefined ? '' : String(d.member.debt.credit_limit_iqd));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : s.loadError);
      } finally {
        setLoading(false);
      }
    },
    [s.loadError]
  );

  useEffect(() => {
    if (!userId) return;
    // The previous member's debt must not sit under the new member's name for
    // even one frame — a mis-read waiting to happen on a screen whose whole
    // job is "who is this".
    setData(null);
    setShown(null);
    setShowCaseForm(false);
    setResumeTarget(null);
    setRowError('');
    setBnplNote(null);
    void load(userId);
  }, [userId, load]);

  const resumeCase = async (rc: RestrictionCase, reason: string) => {
    if (!userId) return;
    setRowBusy(rc.id);
    setRowError('');
    try {
      await api.patch(`/api/support/admin/restrictions/${rc.id}`, { action: 'resume', reason });
      setResumeTarget(null);
      await load(userId);
      onChanged();
    } catch (e) {
      setRowError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setRowBusy(null);
    }
  };

  const updateBnpl = async (state: 'approved' | 'suspended', storedLimit: number) => {
    if (bnplBusy || !userId) return;
    const limit = Number(bnplLimit);
    if (state === 'approved' && (!Number.isInteger(limit) || limit <= 0)) {
      setBnplNote({ ok: false, text: s.limitPlaceholder });
      return;
    }
    setBnplBusy(true);
    setBnplNote(null);
    try {
      // THE SUSPEND CARRIES THE STORED LIMIT BACK. `PUT /admin/bnpl/:userId`
      // upserts the row, so whatever `credit_limit_iqd` this request carries
      // REPLACES the stored one — and the validator defaults a missing figure
      // to 0. Suspending with no limit in hand would therefore wipe the
      // member's approved line, and resuming them later would silently give
      // them a limit of zero. `storedLimit` comes from the caller, which only
      // renders these controls when the server actually sent the figure.
      await api.put(`/api/memberships/admin/bnpl/${encodeURIComponent(userId)}`, {
        state,
        credit_limit_iqd: state === 'approved' ? limit : storedLimit,
      });
      setBnplNote({ ok: true, text: s.bnplSaved });
      await load(userId);
      onChanged();
    } catch (e) {
      setBnplNote({ ok: false, text: e instanceof ApiError ? e.message : s.loadError });
    } finally {
      setBnplBusy(false);
    }
  };

  const view = data ?? shown;
  const latestKyc = view?.kyc_cases[0] ?? null;
  const activeCases = view ? view.restriction_cases.filter((r) => r.state === 'active').length : 0;
  const storedLimit = view?.debt.credit_limit_iqd;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      mode="modal"
      anchor={anchorRef}
      labelledBy={TITLE_ID}
      z={50}
      testId="admin-membership-detail"
      panelMotion={{ ref: setPanel }}
      // Geometry only; the material belongs to the primitive. The height is
      // capped in DYNAMIC viewport units so the window still fits while a
      // phone's address bar is showing, and the BODY scrolls rather than the
      // panel so the member's name stays put while their history moves.
      panelClassName={`w-full max-w-3xl max-h-[min(88dvh,46rem)] flex flex-col overflow-hidden${
        open ? '' : ' pointer-events-none'
      }`}
    >
      <header className="flex items-start gap-3 border-b border-zinc-800 p-4 sm:p-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800">
          <CreditCard className="h-5 w-5 text-[#D4AF37]" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={TITLE_ID} className="truncate text-lg font-black leading-6 text-white" dir="auto">
            {view ? view.user.name || view.user.username || s.detailTitle : s.detailTitle}
          </h3>
          <p dir="auto" className="truncate text-xs font-medium leading-4 text-zinc-500">
            {view?.user.email ?? ''}
          </p>
          {view && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Pill tone={view.tier_status.active ? 'gold' : 'zinc'}>
                {tierLabel(view.tier_status.tier) || s.none}
              </Pill>
              <Pill tone={view.tier_status.active ? 'green' : 'zinc'}>
                {view.tier_status.active ? s.active : s.none}
              </Pill>
              {latestKyc && (
                <Pill
                  tone={latestKyc.state === 'verified' ? 'green' : latestKyc.state === 'rejected' ? 'red' : 'zinc'}
                  icon={<BadgeCheck className="h-3 w-3" />}
                >
                  {s.fKyc}: {latestKyc.state}
                </Pill>
              )}
              {activeCases > 0 && (
                <Pill tone="red" icon={<Ban className="h-3 w-3" />}>
                  {s.fRestriction}: {activeCases}
                </Pill>
              )}
              <Pill tone="blue" icon={<TicketCheck className="h-3 w-3" />}>
                {s.statTickets}: {view.support_ticket_count}
              </Pill>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={s.close}
          className="-me-1 -mt-1 shrink-0 rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
        {loading && !view && <p className="py-10 text-center text-sm font-medium leading-5 text-zinc-500">{s.loading}</p>}

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm font-medium leading-5 text-red-400">
            <span className="flex min-w-0 items-center gap-2">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{error}</span>
            </span>
            {userId && (
              <button
                type="button"
                onClick={() => void load(userId)}
                className="shrink-0 rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-bold leading-4 text-red-300"
              >
                {s.retry}
              </button>
            )}
          </div>
        )}

        {view && (
          <div className="space-y-4">
            {/* The decision strip: the four facts this window is opened FOR,
                at a size that does not need reading. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label={s.fTier}
                value={tierLabel(view.tier_status.tier) || s.none}
                sub={`${s.colExpiry}: ${shortDate(view.tier_status.expires_at)}`}
              />
              <Stat
                label={s.fKyc}
                value={latestKyc?.state ?? s.none}
                tone={latestKyc && latestKyc.state !== 'verified' ? 'warn' : 'plain'}
                sub={latestKyc ? shortDate(latestKyc.submitted_at ?? latestKyc.created_at) : s.kycNone}
              />
              <Stat
                label={s.fRestriction}
                value={activeCases}
                tone={activeCases > 0 ? 'warn' : 'plain'}
                sub={`${s.statGated}: ${view.benefit_context.gated_benefit_flags.length}`}
              />
              <Stat
                label={s.outstanding}
                value={<Money iqd={view.debt.outstanding_iqd} s={s} tone="debt" />}
                sub={`${s.accountState}: ${view.debt.account_state}`}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Section title={s.secSubscription} icon={<CreditCard className="h-3.5 w-3.5" />} testId="subscription">
                <Row label={s.fTier} value={tierLabel(view.tier_status.tier) || s.none} />
                <Row label={s.fStatus} value={view.tier_status.active ? s.active : s.none} />
                <Row label={s.colExpiry} value={shortDate(view.tier_status.expires_at)} mono />
                {view.tier_status.pending_launch && (
                  <Row
                    label={s.fStatus}
                    value={`${tierLabel(view.tier_status.pending_launch.tier)} · ${view.tier_status.pending_launch.duration_months}mo`}
                  />
                )}
                {view.memberships.length === 0 ? (
                  <p className="pt-2 text-xs leading-5 text-zinc-600">{s.subsNone}</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {view.memberships.map((m) => (
                      <li key={m.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Pill tone={m.state === 'active' ? 'green' : 'zinc'}>{tierLabel(m.tier)}</Pill>
                          <Pill tone="zinc">{m.state}</Pill>
                          <Pill tone="zinc">{m.duration_months}mo</Pill>
                          <span className="ms-auto">
                            <Money iqd={m.price_paid_iqd} s={s} />
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-4 text-zinc-600" dir="auto">
                          {shortDate(m.starts_at)} → {shortDate(m.expires_at)} · {m.source}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                <GrantMembership
                  userId={view.user.id}
                  onGranted={() => {
                    void load(view.user.id);
                    onChanged();
                  }}
                />
              </Section>

              <Section
                title={s.secIdentity}
                icon={<BadgeCheck className="h-3.5 w-3.5" />}
                note={s.kycNote}
                testId="kyc"
              >
                {view.kyc_cases.length === 0 ? (
                  <p className="text-xs leading-5 text-zinc-600">{s.kycNone}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {view.kyc_cases.map((k) => (
                      <li key={k.id} className="flex flex-wrap items-center gap-1.5">
                        <Pill tone={k.state === 'verified' ? 'green' : k.state === 'rejected' ? 'red' : 'zinc'}>
                          {k.state}
                        </Pill>
                        <span className="text-[11px] leading-4 text-zinc-400">{k.case_type}</span>
                        {k.doc_type && <span className="text-[11px] leading-4 text-zinc-500">{k.doc_type}</span>}
                        <span className="ms-auto text-[11px] leading-4 text-zinc-600">
                          {shortDate(k.submitted_at ?? k.created_at)}
                        </span>
                        {k.reason && (
                          <p dir="auto" className="w-full text-[11px] leading-relaxed text-zinc-500">
                            {k.reason}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                title={s.secBenefits}
                icon={<ShieldCheck className="h-3.5 w-3.5" />}
                note={s.benefitNote}
                testId="benefits"
              >
                <Row
                  label={s.benefitActive}
                  value={`${tierLabel(view.benefit_context.tier) || s.none} · ${
                    view.benefit_context.tier_active ? s.active : s.none
                  }`}
                />
                {view.benefit_context.gated_benefit_flags.length === 0 ? (
                  <p className="pt-2 text-xs leading-5 text-[#2CE59B]">{s.benefitNoneGated}</p>
                ) : (
                  <div className="mt-2">
                    <p className="mb-1.5 text-[11px] leading-4 text-zinc-500">{s.benefitGated}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {view.benefit_context.gated_benefit_flags.map((f) => (
                        <Pill key={f} tone="red">
                          {benefitLabel(f, lang)}
                        </Pill>
                      ))}
                    </div>
                  </div>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-[#D4AF37]/80">{s.gatingScopeNote}</p>
              </Section>

              <Section title={s.secAddresses} icon={<MapPin className="h-3.5 w-3.5" />} testId="address">
                {view.approved_addresses.length === 0 ? (
                  <p className="text-xs leading-5 text-zinc-600">{s.addrNone}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {view.approved_addresses.map((a) => (
                      <li key={a.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Pill tone={a.state === 'approved' ? 'green' : 'zinc'}>{a.state}</Pill>
                          <Pill tone="zinc">v{a.version}</Pill>
                          <span className="ms-auto text-[11px] leading-4 text-zinc-600">
                            {shortDate(a.approved_at ?? a.requested_at)}
                          </span>
                        </div>
                        <p dir="auto" className="mt-1 break-words text-[11px] leading-relaxed text-zinc-400">
                          {a.address}
                          {a.landmark ? ` — ${a.landmark}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/*
                THE SECTION THAT IS AUTHORIZATION AND NOT LAYOUT.

                The STATE of the credit line and whether this member is
                ELIGIBLE for one are operational facts — an assistant has to be
                able to answer "why was I refused?" at all. The SIZE of the
                line, what is owed against it and what is left are money, and
                each of them is drawn by `Money`, which prints what arrived and
                the locked sentence when nothing did.
              */}
              <Section
                title={s.secDebt}
                icon={<Wallet className="h-3.5 w-3.5" />}
                note={s.bnplStatus}
                className="border-[#2CE59B]/20 bg-[#2CE59B]/[0.04]"
                testId="debt"
              >
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <Pill tone={view.debt.eligible ? 'green' : 'gold'}>
                    {view.debt.eligible ? s.eligible : s.ineligible}
                  </Pill>
                  <Pill tone="zinc">
                    {s.accountState}: {view.debt.account_state}
                  </Pill>
                </div>
                {!view.debt.eligible && view.debt.eligibility_reason && (
                  <p dir="auto" className="mb-2 text-[11px] leading-relaxed text-zinc-500">
                    {view.debt.eligibility_reason}
                  </p>
                )}
                <Row label={s.creditLimit} value={<Money iqd={view.debt.credit_limit_iqd} s={s} />} />
                <Row label={s.outstanding} value={<Money iqd={view.debt.outstanding_iqd} s={s} tone="debt" />} />
                <Row label={s.available} value={<Money iqd={view.debt.available_iqd} s={s} />} />

                {/*
                  THE CONTROLS FOLLOW THE FIGURE. Setting a limit is naming a
                  sum of money, and suspending REWRITES the stored limit with
                  whatever this screen sends (see `updateBnpl`) — so an account
                  that was not given the figure is not offered the control
                  either. That is not a second gate on top of the server's: it
                  is the same one fact, `storedLimit`, deciding both.
                */}
                {storedLimit === undefined ? (
                  <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">{s.moneyHidden}</p>
                ) : (
                  <div className="mt-3">
                    <label className="mb-1 block text-[11px] leading-4 text-zinc-500" htmlFor="bnpl-credit-limit">
                      {s.bnplControls}
                    </label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        id="bnpl-credit-limit"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1000}
                        value={bnplLimit}
                        onChange={(e) => setBnplLimit(e.target.value)}
                        placeholder={s.limitPlaceholder}
                        className="min-h-10 min-w-0 flex-1 rounded-xl border border-zinc-700 bg-black px-3 text-[13px] leading-5 text-white focus:outline-none focus:ring-2 focus:ring-gold/60"
                      />
                      <button
                        type="button"
                        disabled={bnplBusy}
                        onClick={() => void updateBnpl('approved', storedLimit)}
                        className="min-h-10 rounded-xl bg-gold px-3 text-[12px] font-black leading-4 text-black disabled:opacity-50"
                      >
                        {s.approveBnpl}
                      </button>
                      <button
                        type="button"
                        disabled={bnplBusy || view.debt.account_state === 'suspended'}
                        onClick={() => void updateBnpl('suspended', storedLimit)}
                        className="min-h-10 rounded-xl border border-red-500/35 bg-red-500/10 px-3 text-[12px] font-bold leading-4 text-red-300 disabled:opacity-50"
                      >
                        {s.suspendBnpl}
                      </button>
                    </div>
                  </div>
                )}
                {bnplNote && (
                  <p
                    role={bnplNote.ok ? 'status' : 'alert'}
                    className={`mt-2 text-[12px] leading-5 ${bnplNote.ok ? 'text-[#2CE59B]' : 'text-red-300'}`}
                  >
                    {bnplNote.text}
                  </p>
                )}

                <p className="mt-3 text-[11px] font-bold uppercase leading-4 tracking-wider text-zinc-500">
                  {s.ledgerTitle}
                </p>
                {!view.debt.ledger || view.debt.ledger.length === 0 ? (
                  <p className="mt-1 text-xs leading-5 text-zinc-600">{s.noLedger}</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {view.debt.ledger.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center gap-2 text-[11px] leading-4 text-zinc-500">
                        <span className="text-zinc-400">{l.kind}</span>
                        <Money iqd={l.amount_iqd} s={s} />
                        {l.due_at && <span>→ {shortDate(l.due_at)}</span>}
                        <span className="ms-auto text-zinc-600">{shortDate(l.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                title={s.secRestrictions}
                icon={<ShieldAlert className="h-3.5 w-3.5" />}
                className={activeCases > 0 ? 'border-red-500/25 bg-red-500/[0.04] sm:col-span-2' : 'sm:col-span-2'}
                testId="restrictions"
              >
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    aria-expanded={showCaseForm}
                    onClick={() => setShowCaseForm((v) => !v)}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-bold leading-4 text-red-300"
                  >
                    {s.openCase}
                  </button>
                </div>

                {showCaseForm && (
                  <RestrictionForm
                    userId={view.user.id}
                    s={s}
                    lang={lang}
                    onDone={() => {
                      setShowCaseForm(false);
                      void load(view.user.id);
                      onChanged();
                    }}
                  />
                )}

                {rowError && !resumeTarget && (
                  <p role="alert" className="mb-2 text-xs leading-5 text-red-400">
                    {rowError}
                  </p>
                )}

                {view.restriction_cases.length === 0 ? (
                  <p className="text-xs leading-5 text-zinc-600">{s.caseNone}</p>
                ) : (
                  <ul className="space-y-2">
                    {view.restriction_cases.map((rc) => (
                      <li key={rc.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Pill tone={rc.state === 'active' ? 'red' : 'green'}>
                            {rc.state === 'active' ? s.active : s.resolved}
                          </Pill>
                          <Pill tone="zinc">
                            {((s as Record<string, unknown>)[`ct_${rc.case_type}`] as string) || rc.case_type}
                          </Pill>
                          {rc.decision && (
                            <Pill tone="gold">{rc.decision === 'pause' ? s.d_pause : s.d_revoke}</Pill>
                          )}
                          <span className="ms-auto text-[11px] leading-4 text-zinc-600">
                            {s.openedAt}: {shortDate(rc.opened_at)}
                          </span>
                        </div>
                        <p dir="auto" className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                          {rc.reason}
                        </p>
                        {rc.evidence.length > 0 && (
                          <p dir="auto" className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-500">
                            {rc.evidence.join('\n')}
                          </p>
                        )}
                        {rc.benefit_flags.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {rc.benefit_flags.map((f) => (
                              <Pill key={f} tone="zinc">
                                {benefitLabel(f, lang)}
                              </Pill>
                            ))}
                          </div>
                        )}
                        {rc.resolved_at && (
                          <p dir="auto" className="mt-1.5 text-[11px] leading-4 text-zinc-600">
                            {s.resolvedAt}: {shortDate(rc.resolved_at)} — {rc.decision_reason}
                          </p>
                        )}
                        {rc.state === 'active' && (
                          <button
                            type="button"
                            onClick={() => setResumeTarget(rc)}
                            disabled={rowBusy === rc.id || resumeTarget?.id === rc.id}
                            className="mt-2 rounded-lg border border-[#2CE59B]/30 bg-[#2CE59B]/10 px-3 py-1.5 text-xs font-bold leading-4 text-[#2CE59B] disabled:opacity-50"
                          >
                            {rowBusy === rc.id ? s.creating : s.resume}
                          </button>
                        )}
                        {/* The reason is asked for INSIDE the case it resolves,
                            so the evidence being answered is still on screen —
                            and inside the panel, so the focus trap holds. */}
                        <ReasonPrompt
                          open={resumeTarget?.id === rc.id}
                          busy={rowBusy === rc.id}
                          title={s.resume}
                          body={s.resumeReason}
                          confirmLabel={s.resume}
                          error={rowError}
                          onCancel={() => setResumeTarget(null)}
                          onConfirm={(reason) => void resumeCase(rc, reason)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-800 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5">
        <span className="min-w-0 truncate text-[11px] font-medium leading-4 text-zinc-600" dir="ltr">
          <span className="sr-only">{s.memberIdLabel}: </span>
          {view?.user.id ?? ''}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-xl bg-white px-4 py-2.5 text-sm font-bold leading-5 text-black transition-colors hover:bg-zinc-200"
        >
          {s.close}
        </button>
      </footer>
    </Overlay>
  );
}
