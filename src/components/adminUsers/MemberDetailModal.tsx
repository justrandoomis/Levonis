/**
 * THE MEMBER PROFILE, AS A WINDOW.
 *
 * The owner: «عند الضغط على مستخدم أريدها نافذة منبثقة وليس أن يظهر في نهاية
 * الصفحة، وأريد ترتيب أكثر وإضافة تفاصيل أكثر».
 *
 * THE FAILURE THAT SENTENCE DESCRIBES. A member detail rendered at the BOTTOM
 * of a page whose table is a hundred rows long means that pressing a user
 * scrolls that user off the screen. The admin then reads a profile with no
 * visible answer to "whose profile is this?", and when they are done the row
 * they pressed is somewhere above them and has to be hunted for again. Every
 * decision made in that state is made against a name held in short-term
 * memory, which is exactly how the wrong account gets restricted.
 *
 * So the profile comes to the row instead: `Overlay` in `modal` mode, ANCHORED
 * to the button that opened it, so the window grows out of that row and
 * collapses back into it — the spatial rule the primitive exists for.
 *
 * ---------------------------------------------------------------------------
 * THE KEYBOARD IS PART OF "IT OPENS WHERE I PRESSED".
 *
 * `Overlay` gives Escape, the page-scroll lock and initial focus, and says in
 * its own header that it is deliberately not a focus manager. The missing half
 * — a Tab trap and a focus RESTORE to the row — is `useModalFocus`, and it is
 * here rather than in the primitive for the reason the primitive gives: a
 * window that cannot trap focus should be visibly missing it, not silently
 * pretending.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE UNDER «الأرقام المالية» IS BEHIND THE FINANCIAL SCOPE.
 *
 * «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن العادي
 *  لا يراها في API ولا في HTML ولا في export»
 *
 * A LIFETIME VALUE IS MONEY, and so is a wallet balance and a BNPL limit. This
 * component does not hide them with a class or a ternary on the session's role,
 * because a hidden number is still in the HTML and still in the JSON the admin
 * can read in their own devtools. It renders what the SERVER SENT: for a
 * restricted admin the response has no `financial` key at all (see the handler
 * in worker/routes/admin.ts), so there is nothing to render and the section is
 * replaced by the sentence that says why. The session's own
 * `can_view_financials` is never consulted here — it is a UI hint on the
 * account, and this window must reflect the answer to THIS request.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Ban,
  BadgeCheck,
  Bell,
  Coins,
  CreditCard,
  Globe,
  Lock,
  LogIn,
  Mail,
  MapPin,
  Phone,
  Shield,
  ShieldCheck,
  ShoppingBag,
  Store,
  TriangleAlert,
  TrendingUp,
  User,
  Wallet,
  X,
} from 'lucide-react';
import { Overlay } from '../ui/Overlay';
import { api, ApiError, formatIqd, formatUsdCents, formatWalletIqd } from '../../lib/api';
import { useWallet } from '../../WalletContext';
import { useUsersStrings } from './strings';
import { useModalFocus } from './useModalFocus';
import { WalletAdjustPanel } from './WalletAdjustPanel';
import { Pill, Row, Section, Stat, dayLabelOf, whenLabel } from './ui';
import type { MemberDetailResponse } from './types';

export interface MemberDetailModalProps {
  /** The member to show. `null` closes the window. */
  userId: string | null;
  /** The row control the window was opened from — anchor AND focus return. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Opens the existing role/plan editor for this member. */
  onEdit: (userId: string) => void;
}

/**
 * THE MEMBER'S BALANCE AS THE MEMBER SEES IT — the server's dinars
 * (`wallet_iqd`, the same `walletIqdAvailable` their wallet page reads), not
 * the cents converted at today's rate: a member who typed 50,000 د.ع read
 * 49,994 here. A server older than the field still converts the cents.
 */
function memberWalletIqd(f: { wallet_iqd?: number; wallet_usd_cents: number }, exchangeRate: number): string {
  return typeof f.wallet_iqd === 'number' && Number.isFinite(f.wallet_iqd)
    ? formatIqd(f.wallet_iqd)
    : formatWalletIqd(f.wallet_usd_cents, exchangeRate);
}

const ROLE_ICON: Record<string, React.ReactNode> = {
  admin: <Shield className="h-5 w-5 text-[#6B46FF]" />,
  merchant: <Store className="h-5 w-5 text-[#D4AF37]" />,
  customer: <User className="h-5 w-5 text-zinc-400" />,
};

export default function MemberDetailModal({ userId, anchorRef, onClose, onEdit }: MemberDetailModalProps) {
  /** Dinars beside the ledger's own dollars — the wallet is stored in USD
   *  cents and an admin reading a member's balance needs the figure their
   *  customer sees. */
  const { exchangeRate } = useWallet();
  const s = useUsersStrings();
  const open = userId !== null;
  const { setPanel } = useModalFocus(open, anchorRef);

  const [data, setData] = useState<MemberDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WHY THE WINDOW KEEPS THE LAST MEMBER IT DREW. `userId` going null IS the
  // close, but the panel is still on screen for the length of its exit spring.
  // Reading the id directly would empty the profile out from under the
  // animation and the admin would watch a blank card shrink back into the row.
  // (The same reasoning, and the same shape, as the edit window in
  // AdminUsers.tsx — the two behave identically on purpose.)
  const [shown, setShown] = useState<MemberDetailResponse | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.get<MemberDetailResponse>(`/api/admin/users/${encodeURIComponent(id)}/detail`);
      setData(d);
      setShown(d);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load member');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    // The previous member's numbers must not sit under the new member's name
    // for even one frame — that is a mis-read waiting to happen on a screen
    // whose whole job is "who is this".
    setData(null);
    setShown(null);
    void load(userId);
  }, [userId, load]);

  const view = data ?? shown;
  const m = view?.member;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      mode="modal"
      anchor={anchorRef}
      labelledBy="admin-member-title"
      z={50}
      testId="admin-member-detail"
      panelMotion={{ ref: setPanel }}
      // Geometry only; the material belongs to the primitive. The height is
      // capped in DYNAMIC viewport units so the window still fits when a
      // phone's address bar is showing, and the BODY scrolls rather than the
      // panel so the header and its identity stay put while the profile moves.
      panelClassName={`w-full max-w-2xl max-h-[min(88dvh,46rem)] flex flex-col overflow-hidden${open ? '' : ' pointer-events-none'}`}
    >
      <header className="flex items-start gap-3 border-b border-zinc-800 p-4 sm:p-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800">
          {ROLE_ICON[m?.identity.role ?? 'customer'] ?? ROLE_ICON.customer}
        </div>
        <div className="min-w-0 flex-1">
          <h3 id="admin-member-title" className="truncate text-lg font-black text-white" dir="auto">
            {m ? m.identity.name || m.identity.username || s.memberTitle : s.memberTitle}
          </h3>
          <p dir="auto" className="truncate text-xs font-medium text-zinc-500">
            {m?.identity.email ?? ''}
          </p>
          {m && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Pill tone={m.identity.role === 'admin' ? 'violet' : m.identity.role === 'merchant' ? 'gold' : 'zinc'}>
                {s.fRole}: {m.identity.role}
              </Pill>
              {m.identity.is_owner && (
                <Pill tone="green" icon={<ShieldCheck className="h-3 w-3" />}>
                  {s.ownerBadge}
                </Pill>
              )}
              {m.identity.is_self && <Pill tone="blue">{s.selfBadge}</Pill>}
              {m.identity.role === 'admin' && !m.identity.is_owner && (
                <Pill
                  tone={m.identity.admin_scope === 'assistant' ? 'gold' : 'violet'}
                  icon={m.identity.admin_scope === 'assistant' ? <Lock className="h-3 w-3" /> : undefined}
                >
                  {m.identity.admin_scope === 'assistant' ? s.assistantBadge : s.fullBadge}
                </Pill>
              )}
              {m.membership.is_investor && (
                <Pill tone="green" icon={<TrendingUp className="h-3 w-3" />}>
                  {s.fInvestor}
                </Pill>
              )}
              {m.active_restrictions > 0 && (
                <Pill tone="red" icon={<Ban className="h-3 w-3" />}>
                  {s.secRestrictions}: {m.active_restrictions}
                </Pill>
              )}
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
        {loading && !view && <p className="py-10 text-center text-sm font-medium text-zinc-500">{s.loading}</p>}

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm font-medium text-red-400">
            <span className="flex min-w-0 items-center gap-2">
              <TriangleAlert className="h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </span>
            {userId && (
              <button
                type="button"
                onClick={() => void load(userId)}
                className="shrink-0 rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-bold text-red-300"
              >
                {s.retry}
              </button>
            )}
          </div>
        )}

        {view && m && (
          <div className="space-y-4">
            {/* The decision strip: the few numbers an owner opens this window
                FOR, at a size that does not need reading. Money only appears
                here when the server sent money. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={s.fOrders} value={m.activity.orders_total.toLocaleString()} sub={`${s.fDelivered}: ${m.activity.orders_delivered.toLocaleString()}`} />
              {view.financial ? (
                <Stat label={s.fLifetime} value={formatIqd(view.financial.lifetime_value_iqd)} tone="money" sub={`${s.fDeliveredValue}: ${formatIqd(view.financial.delivered_value_iqd)}`} />
              ) : (
                <Stat label={s.fLifetime} value={<Lock className="h-4 w-4 text-zinc-600" />} sub={s.fScope} />
              )}
              {view.financial ? (
                <Stat label={s.fWalletUsd} value={memberWalletIqd(view.financial, exchangeRate)} tone="money" sub={`${formatUsdCents(view.financial.wallet_usd_cents)} · ${s.fWalletPoints}: ${view.financial.wallet_points.toLocaleString()}`} />
              ) : (
                <Stat label={s.fWalletUsd} value={<Lock className="h-4 w-4 text-zinc-600" />} sub={s.fScope} />
              )}
              <Stat label={s.fJoined} value={dayLabelOf(m.identity.created_at, s.never)} sub={`${s.fTier}: ${m.membership.tier}`} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Section title={s.secIdentity} icon={<BadgeCheck className="h-3.5 w-3.5" />} testId="identity">
                <Row label={s.fEmail} value={m.identity.email} />
                <Row label={s.fUsername} value={m.identity.username || s.none} />
                <Row label={s.fPhone} value={m.identity.phone_e164 || s.none} mono />
                <Row label={s.fCountry} value={m.identity.country || s.none} />
                <Row label={s.fLocale} value={m.identity.locale} />
                <Row
                  label={s.fEmailVerified}
                  value={m.identity.email_verified_at ? dayLabelOf(m.identity.email_verified_at, s.never) : s.no}
                />
                <Row label={s.fJoined} value={whenLabel(m.identity.created_at, s.never)} />
              </Section>

              <Section title={s.secMembership} icon={<CreditCard className="h-3.5 w-3.5" />} testId="membership">
                <Row label={s.fTier} value={m.membership.tier} />
                <Row
                  label={s.fExpiry}
                  value={m.membership.expiry > 0 ? new Date(m.membership.expiry).toLocaleDateString() : s.none}
                />
                <Row label={s.fTermDays} value={m.membership.term_days > 0 ? m.membership.term_days : s.none} mono />
                <Row label={s.fInvestor} value={m.membership.is_investor ? s.yes : s.no} />
                <Row label={s.fStreak} value={m.membership.checkin_streak} mono />
                <Row label={s.fBnplState} value={m.bnpl_state} />
              </Section>

              <Section
                title={s.secActivity}
                icon={<ShoppingBag className="h-3.5 w-3.5" />}
                note={s.lastSeenNote}
                testId="activity"
              >
                <Row label={s.fOrders} value={m.activity.orders_total} mono />
                <Row label={s.fDelivered} value={m.activity.orders_delivered} mono />
                <Row label={s.fOpen} value={m.activity.orders_open} mono />
                <Row label={s.fCancelled} value={m.activity.orders_cancelled} mono />
                <Row label={s.fLastOrder} value={whenLabel(m.activity.last_order_at, s.never)} />
                <Row
                  label={s.fLastSeen}
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <LogIn className="h-3.5 w-3.5 text-zinc-500" />
                      {whenLabel(m.activity.newest_session_at, s.never)}
                    </span>
                  }
                />
                <Row label={s.fLiveSessions} value={m.activity.live_sessions} mono />
              </Section>

              {/*
                THE ONE SECTION THAT IS AUTHORIZATION AND NOT LAYOUT.
                `view.financial` is present only when the SERVER decided this
                account may see money. There is no `hidden`, no `opacity-0` and
                no role test — for a restricted admin these numbers were never
                read out of the database, so there is nothing on this page, in
                the network tab or in a saved copy of it to find.
              */}
              {view.financial ? (
                <Section
                  title={s.secMoney}
                  icon={<Wallet className="h-3.5 w-3.5" />}
                  note={s.lifetimeNote}
                  className="border-[#2CE59B]/20 bg-[#2CE59B]/[0.04]"
                  testId="financial"
                >
                  <Row label={s.fLifetime} value={formatIqd(view.financial.lifetime_value_iqd)} mono />
                  <Row label={s.fDeliveredValue} value={formatIqd(view.financial.delivered_value_iqd)} mono />
                  <Row
                    label={s.fWalletUsd}
                    value={`${memberWalletIqd(view.financial, exchangeRate)} · ${formatUsdCents(view.financial.wallet_usd_cents)}`}
                    mono
                  />
                  <Row
                    label={s.fWalletPoints}
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        <Coins className="h-3.5 w-3.5 text-[#D4AF37]" />
                        {view.financial.wallet_points.toLocaleString()}
                      </span>
                    }
                    mono
                  />
                  <Row label={s.fBnplLimit} value={formatIqd(view.financial.bnpl_credit_limit_iqd)} mono />
                  <Row label={s.fBnplDue} value={formatIqd(view.financial.bnpl_outstanding_iqd)} mono />
                </Section>
              ) : (
                <Section title={s.secMoney} icon={<Lock className="h-3.5 w-3.5" />} testId="financial-denied">
                  <p className="text-xs leading-relaxed text-zinc-500">{s.moneyHidden}</p>
                </Section>
              )}

              {/* «تعديل الرصيد والنقاط» — behind the same server decision as
                  the figures above: no `financial`, no control. */}
              {view.financial && (
                <Section
                  title={s.adjTitle}
                  icon={<Coins className="h-3.5 w-3.5" />}
                  className="sm:col-span-2"
                  testId="wallet-adjust-section"
                >
                  <WalletAdjustPanel
                    key={m.identity.id}
                    userId={m.identity.id}
                    balanceIqd={
                      typeof view.financial.wallet_iqd === 'number' && Number.isFinite(view.financial.wallet_iqd)
                        ? view.financial.wallet_iqd
                        : Math.floor((view.financial.wallet_usd_cents * exchangeRate) / 100)
                    }
                    points={view.financial.wallet_points}
                    onDone={() => void load(m.identity.id)}
                  />
                </Section>
              )}

              <Section title={s.secKyc} icon={<BadgeCheck className="h-3.5 w-3.5" />} note={s.kycNote} testId="kyc">
                {m.kyc ? (
                  <>
                    <Row label={s.fState} value={<Pill tone={m.kyc.state === 'verified' ? 'green' : m.kyc.state === 'rejected' ? 'red' : 'zinc'}>{m.kyc.state}</Pill>} />
                    <Row label={s.fSubmitted} value={whenLabel(m.kyc.submitted_at, s.never)} />
                    {m.kyc.reason && <Row label={s.fReason} value={m.kyc.reason} />}
                  </>
                ) : (
                  <p className="text-xs text-zinc-500">{s.noKyc}</p>
                )}
              </Section>

              <Section title={s.secAddress} icon={<MapPin className="h-3.5 w-3.5" />} testId="address">
                {m.approved_address ? (
                  <>
                    <Row label={s.fState} value={<Pill tone={m.approved_address.state === 'approved' ? 'green' : 'zinc'}>{m.approved_address.state}</Pill>} />
                    <Row label={s.fVersion} value={`v${m.approved_address.version}`} mono />
                    <Row label={s.fSubmitted} value={whenLabel(m.approved_address.requested_at, s.never)} />
                    <Row label={s.fApproved} value={whenLabel(m.approved_address.approved_at, s.never)} />
                  </>
                ) : (
                  <p className="text-xs text-zinc-500">{s.noAddress}</p>
                )}
              </Section>

              <Section title={s.secChannels} icon={<Bell className="h-3.5 w-3.5" />} testId="channels">
                {m.channels.length === 0 ? (
                  <p className="text-xs text-zinc-500">{s.noChannels}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {m.channels.map((ch) => (
                      <Pill
                        key={ch.channel}
                        tone={!ch.enabled ? 'zinc' : ch.is_primary ? 'green' : 'blue'}
                        icon={ch.channel === 'email' ? <Mail className="h-3 w-3" /> : ch.channel === 'telegram' ? <Globe className="h-3 w-3" /> : ch.channel === 'whatsapp' ? <Phone className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
                      >
                        {ch.channel}
                        {ch.is_primary ? ` · ${s.primaryChannel}` : ''}
                        {!ch.enabled ? ` · ${s.channelOff}` : ''}
                      </Pill>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title={s.secRestrictions}
                icon={<Ban className="h-3.5 w-3.5" />}
                className={m.active_restrictions > 0 ? 'border-red-500/25 bg-red-500/[0.04] sm:col-span-2' : 'sm:col-span-2'}
                testId="restrictions"
              >
                {m.restrictions.length === 0 ? (
                  <p className="text-xs text-zinc-500">{s.noRestrictions}</p>
                ) : (
                  <ul className="space-y-2">
                    {m.restrictions.map((r) => (
                      <li key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Pill tone={r.state === 'active' ? 'red' : 'zinc'}>{r.state}</Pill>
                          <Pill tone="zinc">{r.case_type || r.kind}</Pill>
                          {r.benefit_flags.map((f) => (
                            <Pill key={f} tone="gold">
                              {f}
                            </Pill>
                          ))}
                          <span className="ms-auto text-[11px] text-zinc-600">{dayLabelOf(r.opened_at, s.never)}</span>
                        </div>
                        {r.reason && (
                          <p dir="auto" className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                            {r.reason}
                          </p>
                        )}
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
        <span className="min-w-0 truncate text-[11px] font-medium text-zinc-600" dir="ltr">
          {m?.identity.id ?? ''}
        </span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2.5 text-sm font-bold text-zinc-400 transition-colors hover:bg-zinc-800"
          >
            {s.close}
          </button>
          <button
            type="button"
            disabled={!m}
            onClick={() => m && onEdit(m.identity.id)}
            className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50"
          >
            <Shield className="h-4 w-4" /> {s.editMember}
          </button>
        </div>
      </footer>
    </Overlay>
  );
}
