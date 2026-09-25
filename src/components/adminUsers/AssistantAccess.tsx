/**
 * GRANTING «مساعد» — the missing half of an authorization that already exists.
 *
 * The owner: «أريد وضع مساعد للأدمن عن طريق الايميل، هذا المساعد لديه كامل
 * الصلاحية عدا الوصول إلى اللوحة والتفاصيل المالية».
 *
 * THE RULE IS NOT IMPLEMENTED HERE. `users.admin_scope = 'assistant'` and every
 * decision made from it live in worker/lib/adminScope.ts, which is where §11 is
 * enforced — on the SERVER, before serialization, so that reading the raw API
 * response, the HTML or a downloaded export reveals nothing. What was missing
 * was any way to SET that column outside of a manual UPDATE against production
 * D1. This screen is that way, and it is nothing more: every refusal below is
 * the server's, restated so the admin learns it before they press rather than
 * after.
 *
 * ---------------------------------------------------------------------------
 * ONE PATCH, NOT TWO — the window this closes.
 *
 * Promoting an account and restricting it are two column writes, and doing
 * them as two requests opens a window between them in which the new admin is
 * `role='admin'` with `admin_scope` NULL. NULL IS UNRESTRICTED (adminScope.ts
 * documents why: migration 0021 could not be allowed to demote every live
 * admin). So a two-request grant creates, for as long as the second request
 * takes — or forever, if it fails, or if the browser is closed between them —
 * a FULL FINANCIAL ADMIN out of an account that was meant never to see a cost.
 *
 * `PATCH /api/admin/users/:id` writes every changed column in ONE UPDATE, so
 * sending `role` and `admin_scope` together closes that window in the database
 * rather than in this component's control flow. That is why there is no
 * "promote, then restrict" path here, and why there must never be one.
 *
 * ---------------------------------------------------------------------------
 * THE LOOKUP IS PART OF THE SAFETY, not a convenience.
 *
 * A grant applied to the wrong account is an outsider inside the panel, and it
 * is invisible afterwards: the grant is perfectly valid, it is simply on the
 * wrong person. So nothing can be pressed until an EXACT email match has been
 * resolved to one account and that account's name, role and current scope are
 * on screen. `GET /api/admin/users/lookup` answers with identity only.
 */

import React, { useState } from 'react';
import { Lock, Search, Shield, ShieldCheck, ShieldOff, TriangleAlert, UserPlus, X } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { api, ApiError } from '../../lib/api';
import { useUsersStrings } from './strings';
import { Pill, Row, Section, dayLabelOf } from './ui';
import type { UserLookupResult } from './types';

/** The three acts this screen can perform, and the columns each one writes. */
type GrantAction = 'grant' | 'lift' | 'remove';

export default function AssistantAccess({ onChanged }: { onChanged?: () => void }) {
  const s = useUsersStrings();
  const { user } = useAuth();
  // A UI HINT, NEVER THE DECISION. `userPatchRefusal` in worker/lib/adminScope.ts
  // refuses a restricted admin's grant regardless of what this component
  // renders; this only spares the admin a 403 they could not have predicted.
  const mayGrant = user?.can_view_financials !== false;

  const [emailInput, setEmailInput] = useState('');
  const [found, setFound] = useState<UserLookupResult | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState<GrantAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<GrantAction | null>(null);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (looking) return;
    setLooking(true);
    setError(null);
    setNotice(null);
    setFound(null);
    setConfirming(null);
    try {
      const d = await api.get<{ user: UserLookupResult }>(
        `/api/admin/users/lookup?email=${encodeURIComponent(emailInput.trim())}`
      );
      setFound(d.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Lookup failed');
    } finally {
      setLooking(false);
    }
  };

  const apply = async (action: GrantAction) => {
    if (!found || busy) return;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      // Each body names EVERY column the act changes, so the server writes them
      // in one UPDATE (see the header — a two-step grant would mint a full
      // financial admin in the gap).
      const body =
        action === 'grant'
          ? { role: 'admin', admin_scope: 'assistant' }
          : action === 'lift'
            ? { admin_scope: null }
            : { role: 'customer', admin_scope: null };
      await api.patch(`/api/admin/users/${encodeURIComponent(found.id)}`, body);
      setFound({
        ...found,
        role: action === 'remove' ? 'customer' : 'admin',
        admin_scope: action === 'grant' ? 'assistant' : null,
      });
      setNotice(s.grantDone);
      setConfirming(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  // The server's own refusals, restated. `is_owner` and `is_self` come from the
  // lookup precisely so these can be said BEFORE a button is pressed —
  // adminScope.ts still refuses them if this component is wrong.
  const lockedReason = found?.is_owner ? s.ownerLocked : found?.is_self ? s.selfLocked : !mayGrant ? s.needFinancial : null;
  const isAdmin = found?.role === 'admin';
  const isAssistant = isAdmin && found?.admin_scope === 'assistant';

  return (
    <div className="space-y-4">
      <Section title={s.grantTitle} icon={<Shield className="h-3.5 w-3.5" />} note={s.grantIntro} testId="grant-intro">
        {/* WHAT THE OWNER IS AGREEING TO, in plain Arabic, on the screen where
            they agree to it. A permission granted without its consequences
            spelled out is granted by accident. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-mint/20 bg-mint/[0.05] p-3">
            <h5 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-mint">
              <ShieldCheck className="h-3.5 w-3.5" /> {s.canDo}
            </h5>
            <ul className="mt-2 space-y-1.5">
              {s.canList.map((line) => (
                <li key={line} className="text-xs leading-relaxed text-zinc-300">
                  • {line}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-red-500/20 bg-red-500/[0.05] p-3">
            <h5 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-red-400">
              <Lock className="h-3.5 w-3.5" /> {s.cannotDo}
            </h5>
            <ul className="mt-2 space-y-1.5">
              {s.cannotList.map((line) => (
                <li key={line} className="text-xs leading-relaxed text-zinc-300">
                  • {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {!mayGrant && (
        <p className="flex items-start gap-2 rounded-xl border border-gilt/30 bg-gilt/10 p-3 text-xs font-medium leading-relaxed text-gilt">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          {s.needFinancial}
        </p>
      )}

      <Section title={s.emailLabel} icon={<Search className="h-3.5 w-3.5" />} note={s.emailHint} testId="grant-lookup">
        <form onSubmit={lookup} className="flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="assistant-grant-email">
            {s.emailLabel}
          </label>
          <input
            id="assistant-grant-email"
            type="email"
            dir="ltr"
            autoComplete="off"
            required
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="name@example.com"
            className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-iris/50"
          />
          <button
            type="submit"
            disabled={looking || emailInput.trim().length === 0}
            className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-bold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50"
          >
            <Search className="h-4 w-4" /> {looking ? s.looking : s.lookupBtn}
          </button>
        </form>
      </Section>

      {error && (
        <p className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm font-medium text-red-400">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      {notice && (
        <p className="rounded-xl border border-mint/30 bg-mint/10 p-3 text-sm font-bold text-mint">
          {notice}
        </p>
      )}

      {found && (
        <Section title={s.confirmWho} icon={<UserPlus className="h-3.5 w-3.5" />} testId="grant-target">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span dir="auto" className="text-sm font-black text-white">
              {found.name || found.username || found.email}
            </span>
            <Pill tone={found.role === 'admin' ? 'violet' : found.role === 'merchant' ? 'gold' : 'zinc'}>{found.role}</Pill>
            {found.is_owner && <Pill tone="green">{s.ownerBadge}</Pill>}
            {found.is_self && <Pill tone="blue">{s.selfBadge}</Pill>}
            {isAdmin && !found.is_owner && (
              <Pill tone={isAssistant ? 'gold' : 'violet'}>{isAssistant ? s.assistantBadge : s.fullBadge}</Pill>
            )}
          </div>
          <Row label={s.fEmail} value={found.email} />
          <Row label={s.fUsername} value={found.username || s.none} />
          <Row label={s.fTier} value={found.membership_tier} />
          <Row label={s.fJoined} value={dayLabelOf(found.created_at, s.never)} />

          {lockedReason ? (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-800/60 p-3 text-xs font-medium leading-relaxed text-zinc-400">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              {lockedReason}
            </p>
          ) : (
            <div className="mt-4 space-y-2">
              {!isAssistant && (
                <ActionButton
                  tone="primary"
                  icon={<Shield className="h-4 w-4" />}
                  label={s.actGrant}
                  busy={busy === 'grant'}
                  busyLabel={s.saving}
                  onClick={() => void apply('grant')}
                />
              )}
              {isAdmin && isAssistant && (
                <ActionButton
                  tone="warn"
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label={s.actLift}
                  busy={busy === 'lift'}
                  busyLabel={s.saving}
                  confirm={confirming === 'lift' ? s.confirmLift : null}
                  onClick={() => (confirming === 'lift' ? void apply('lift') : setConfirming('lift'))}
                  onCancel={() => setConfirming(null)}
                  cancelLabel={s.cancel}
                />
              )}
              {isAdmin && (
                <ActionButton
                  tone="danger"
                  icon={<ShieldOff className="h-4 w-4" />}
                  label={s.actRemove}
                  busy={busy === 'remove'}
                  busyLabel={s.saving}
                  confirm={confirming === 'remove' ? s.confirmRemove : null}
                  onClick={() => (confirming === 'remove' ? void apply('remove') : setConfirming('remove'))}
                  onCancel={() => setConfirming(null)}
                  cancelLabel={s.cancel}
                />
              )}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

/**
 * An act with consequences asks twice, in place.
 *
 * `window.confirm` was the obvious alternative and is the wrong one: it cannot
 * be translated, it cannot be read right-to-left, and the sentence it shows
 * would be the only part of this panel not in the admin's own language. The
 * second press is the confirmation, and the reason is printed above it.
 */
function ActionButton({
  label,
  icon,
  tone,
  busy,
  busyLabel,
  confirm,
  onClick,
  onCancel,
  cancelLabel,
}: {
  label: string;
  icon: React.ReactNode;
  tone: 'primary' | 'warn' | 'danger';
  busy: boolean;
  busyLabel: string;
  confirm?: string | null;
  onClick: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const styles =
    tone === 'primary'
      ? 'bg-[#6B46FF] text-snow hover:bg-iris-deep'
      : tone === 'warn'
        ? 'bg-gilt/15 text-gilt border border-gilt/40 hover:bg-gilt/25'
        : 'bg-red-500/15 text-red-400 border border-red-500/40 hover:bg-red-500/25';
  return (
    <div>
      {confirm && (
        <p className="mb-2 flex items-start gap-2 rounded-xl border border-gilt/30 bg-gilt/10 p-3 text-xs font-bold leading-relaxed text-gilt">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {confirm}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onClick}
          disabled={busy}
          className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition-colors disabled:opacity-50 ${styles}`}
        >
          {icon} {busy ? busyLabel : label}
        </button>
        {confirm && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex min-h-11 items-center gap-1.5 rounded-xl px-4 text-sm font-bold text-zinc-400 transition-colors hover:bg-zinc-800"
          >
            <X className="h-4 w-4" /> {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}
