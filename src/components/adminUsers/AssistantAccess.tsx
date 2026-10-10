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
 * EVERY NEW ADMIN STARTS AS AN ASSISTANT (owner decision 2, 2026-10-07).
 *
 * The database decides that, not this component: migration 0177's trigger
 * `users_promotion_starts_assistant` stores 'assistant' on every promotion,
 * whatever the writer, and the PATCH route writes it too. The grant below
 * still names `admin_scope: 'assistant'` so the request says what it means.
 *
 * Widening an assistant to «كامل (بلا تكاليف)» is the MAIN ADMIN's act alone
 * (SCOPE_ELEVATION_OWNER_ONLY for anyone else, and a sign-in younger than ten
 * minutes for the owner — REAUTH_REQUIRED otherwise), so that button is shown
 * to the owner only, on the server hint `is_owner === true`. Full access moves
 * money and still sees no cost: cost is the owner's alone.
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
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import { apiRefusal, refusalText } from '../../lib/refusalStrings';
import { useUsersStrings } from './strings';
import { Pill, Row, Section, dayLabelOf } from './ui';
import type { UserLookupResult } from './types';

/** The three acts this screen can perform, and the columns each one writes. */
type GrantAction = 'grant' | 'lift' | 'remove';

export default function AssistantAccess({ onChanged }: { onChanged?: () => void }) {
  const s = useUsersStrings();
  const { user } = useAuth();
  const { lang } = useLanguage();
  // UI HINTS, NEVER THE DECISION. `userPatchRefusal` in worker/lib/adminScope.ts
  // refuses regardless of what this component renders; these only spare the
  // admin a 403 they could not have predicted. Both are compared with
  // `=== true`, so a hint the session lacks offers nothing.
  //   mayGrant  appointing or removing an admin needs money scope
  //   mayLift   widening to «كامل (بلا تكاليف)» is the owner's alone
  const mayGrant = user?.can_move_money === true;
  const mayLift = user?.is_owner === true;

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
      // Each body names every column the act changes. `lift` sends the explicit
      // 'full', not the legacy NULL, so the stored value says what was granted.
      const body =
        action === 'grant'
          ? { role: 'admin', admin_scope: 'assistant' }
          : action === 'lift'
            ? { admin_scope: 'full' }
            : { role: 'customer', admin_scope: null };
      const res = await api.patch<{ admin_scope?: 'full' | 'assistant' | null }>(
        `/api/admin/users/${encodeURIComponent(found.id)}`,
        body
      );
      // THE ROW'S SCOPE, as the server read it back after the write (critique
      // G-4) — not the one this component asked for.
      const stored = res && 'admin_scope' in res ? (res.admin_scope ?? null) : action === 'grant' ? 'assistant' : action === 'lift' ? 'full' : null;
      setFound({
        ...found,
        role: action === 'remove' ? 'customer' : 'admin',
        admin_scope: action === 'remove' ? null : stored,
      });
      setNotice(s.grantDone);
      setConfirming(null);
      onChanged?.();
    } catch (err) {
      // The refusal in the admin's own language, by code — PROMOTION_STARTS_ASSISTANT,
      // SCOPE_ELEVATION_OWNER_ONLY, REAUTH_REQUIRED, ROLE_CHANGE_DENIED… are all in
      // REFUSAL_STRINGS through the programme's refusal contract.
      setError(err instanceof ApiError ? apiRefusal(err, lang, err.message) : 'Update failed');
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
          <div className="lv-alert lv-alert-success">
            <h5 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-success">
              <ShieldCheck className="h-3.5 w-3.5" /> {s.canDo}
            </h5>
            <ul className="mt-2 space-y-1.5">
              {s.canList.map((line) => (
                <li key={line} className="text-xs leading-relaxed text-text-secondary">
                  • {line}
                </li>
              ))}
            </ul>
          </div>
          <div className="lv-alert lv-alert-danger">
            <h5 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-danger">
              <Lock className="h-3.5 w-3.5" /> {s.cannotDo}
            </h5>
            <ul className="mt-2 space-y-1.5">
              {s.cannotList.map((line) => (
                <li key={line} className="text-xs leading-relaxed text-text-secondary">
                  • {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <p
        data-testid="new-admin-note"
        className="lv-alert lv-alert-info flex items-start gap-2 text-xs font-medium leading-relaxed text-text-primary"
      >
        <Shield className="mt-0.5 h-4 w-4 shrink-0" />
        {s.newAdminNote}
      </p>

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
            className="lv-input"
            id="assistant-grant-email"
            type="email"
            dir="ltr"
            autoComplete="off"
            required
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="name@example.com"
          />
          <button
            type="submit"
            disabled={looking || emailInput.trim().length === 0}
            className="lv-button lv-button-primary shrink-0"
          >
            <Search className="h-4 w-4" /> {looking ? s.looking : s.lookupBtn}
          </button>
        </form>
      </Section>

      {error && (
        <p className="lv-alert lv-alert-danger flex items-start gap-2 text-sm font-medium text-text-primary">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      {notice && (
        <p className="lv-alert lv-alert-success text-sm font-bold text-text-primary">
          {notice}
        </p>
      )}

      {found && (
        <Section title={s.confirmWho} icon={<UserPlus className="h-3.5 w-3.5" />} testId="grant-target">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span dir="auto" className="text-sm font-black text-text-primary">
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
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-surface-raised p-3 text-xs font-medium leading-relaxed text-text-secondary">
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
              {isAdmin && isAssistant && mayLift && (
                <div data-testid="grant-lift">
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
                  <p className="mt-1.5 text-[11px] leading-relaxed text-text-secondary">{s.liftExplains}</p>
                </div>
              )}
              {isAdmin && isAssistant && !mayLift && (
                <p
                  data-testid="grant-lift-owner-only"
                  className="flex items-start gap-2 rounded-lg bg-surface-raised p-3 text-xs font-medium leading-relaxed text-text-secondary"
                >
                  <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                  {refusalText('SCOPE_ELEVATION_OWNER_ONLY', lang)}
                </p>
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
    tone === 'primary' ? 'lv-button-primary' : tone === 'warn' ? 'lv-button-accent' : 'lv-button-danger';
  return (
    <div>
      {confirm && (
        <p className="mb-2 lv-alert lv-alert-warning flex items-start gap-2 text-xs font-bold leading-relaxed text-text-primary">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {confirm}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onClick}
          disabled={busy}
          className={`lv-button flex-1 ${styles}`}
        >
          {icon} {busy ? busyLabel : label}
        </button>
        {confirm && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="lv-button lv-button-ghost"
          >
            <X className="h-4 w-4" /> {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}
