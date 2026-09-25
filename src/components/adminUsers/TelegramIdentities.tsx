/**
 * THE TELEGRAM ADMIN IDENTITY — the panel surface that did not exist.
 *
 * WHAT HAPPENED. The owner sent `/topic_here wallet` from their own Telegram
 * account and the bot answered «حسابك غير مربوط بصلاحية إدارة على الموقع».
 * That refusal is CORRECT and must stay correct: binding a topic decides where
 * payment proofs land, so it demands the same authority as the approve buttons
 * themselves. §12.2 spells out why — "being in the group, being a Telegram
 * admin or having a matching name does not automatically grant financial
 * authority on the site."
 *
 * The mapping that DOES grant it (`admin_tg_identities`) has had its routes in
 * worker/routes/telegram.ts all along — seed, list and revoke, each audited.
 * What it never had was a screen. So the only way to authorize an owner's own
 * phone was a hand-written API call, and the practical consequence was the
 * message above: the authority existed and could not be granted.
 *
 * ---------------------------------------------------------------------------
 * THE NUMERIC ID, AND ONLY THE NUMERIC ID.
 *
 * A @username is NOT an identity. Telegram lets it be released and taken by
 * somebody else, and it is trivially spoofable in display text — which is
 * exactly the substitution §12.2 refuses ("having a matching name"). Accepting
 * one here would mean a financial approval path keyed on a string its holder
 * does not own. So the field takes digits, the form refuses anything that is
 * not digits, and it says WHY rather than silently stripping the `@` and
 * carrying on with a number that was never entered.
 *
 * NOTHING IS HARD-CODED. The owner's own id is data they type; it is not in
 * this file, it is not a default and it is not a fallback. A build that shipped
 * a Telegram id would be shipping an approval credential.
 *
 * ---------------------------------------------------------------------------
 * THE SITE ACCOUNT IS RESOLVED THE SAME WAY THE ASSISTANT GRANT RESOLVES ONE:
 * an exact email lookup that shows who it found before anything is written.
 * The server additionally refuses to map a non-admin — the role test lives
 * inside the WHERE of both writes, so it holds even under a concurrent role
 * change — and this form states that rule instead of discovering it as a 400.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link2, Lock, Search, Send, Shield, TriangleAlert, X } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { api, ApiError } from '../../lib/api';
import { useUsersStrings } from './strings';
import { Pill, Row, Section, whenLabel } from './ui';
import type { TelegramIdentity, UserLookupResult } from './types';

/** Digits only, and long enough to be a real account id rather than a typo. */
const NUMERIC_ID = /^[0-9]{5,20}$/;

export default function TelegramIdentities() {
  const s = useUsersStrings();
  const { user } = useAuth();
  /**
   * A RESTRICTED ADMIN IS NOT OFFERED THIS, AND THIS IS NOT THE GATE.
   *
   * Binding a Telegram identity hands out the authority to APPROVE PAYMENT
   * PROOFS from the bot — `resolveAdminActor` (worker/lib/walletNotify.ts:411)
   * turns a bound numeric id into the actor that decides a deposit. That is
   * financial authority by any reading of §11, so a restricted assistant must
   * not be handing it out.
   *
   * SAY PLAINLY WHAT THIS IS AND IS NOT. `POST /api/telegram/admin/tg-identities`
   * is guarded by `requireAdmin` ALONE — it has no `canViewFinancials` check —
   * and `resolveAdminActor` matches on `users.role = 'admin'` without reading
   * `admin_scope` either. So today an assistant who reached that endpoint by
   * hand would succeed, and this constant would not have stopped them. It is a
   * refusal to OFFER the act, not a refusal to permit it; the server-side gate
   * belongs in worker/routes/telegram.ts, which this change does not own, and
   * it is reported as unresolved rather than papered over here.
   */
  const mayBind = user?.can_view_financials !== false;
  const [rows, setRows] = useState<TelegramIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [emailInput, setEmailInput] = useState('');
  const [target, setTarget] = useState<UserLookupResult | null>(null);
  const [looking, setLooking] = useState(false);
  const [tgId, setTgId] = useState('');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);

  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.get<{ identities: TelegramIdentity[] }>('/api/telegram/admin/tg-identities');
      setRows(d.identities ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load identities');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (looking) return;
    setLooking(true);
    setError(null);
    setNotice(null);
    setTarget(null);
    try {
      const d = await api.get<{ user: UserLookupResult }>(
        `/api/admin/users/lookup?email=${encodeURIComponent(emailInput.trim())}`
      );
      setTarget(d.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Lookup failed');
    } finally {
      setLooking(false);
    }
  };

  // The `@` is caught HERE, before the request, so the person reading the error
  // is told what an identity is rather than "telegramUserId must be an integer".
  const tgIdTrimmed = tgId.trim();
  const tgIdLooksLikeUsername = tgIdTrimmed.length > 0 && !/^[0-9]*$/.test(tgIdTrimmed);
  const tgIdValid = NUMERIC_ID.test(tgIdTrimmed);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (adding || !target || !tgIdValid) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/api/telegram/admin/tg-identities', {
        userId: target.id,
        telegramUserId: Number(tgIdTrimmed),
        label: label.trim(),
      });
      setNotice(s.tgAdded);
      setTgId('');
      setLabel('');
      setTarget(null);
      setEmailInput('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to link identity');
    } finally {
      setAdding(false);
    }
  };

  const revoke = async (telegramUserId: number) => {
    if (revoking || revokeReason.trim().length < 3) return;
    setRevoking(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/api/telegram/admin/tg-identities/${telegramUserId}/revoke`, {
        reason: revokeReason.trim(),
      });
      setNotice(s.tgRevoked2);
      setRevokingId(null);
      setRevokeReason('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke identity');
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title={s.tgTitle} icon={<Shield className="h-3.5 w-3.5" />} note={s.tgIntro} testId="tg-intro">
        {!mayBind ? (
          <p className="flex items-start gap-2 rounded-xl border border-gilt/30 bg-gilt/10 p-3 text-xs font-medium leading-relaxed text-gilt">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            {s.tgNeedFinancial}
          </p>
        ) : (
        <>
        <form onSubmit={lookup} className="flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="tg-admin-email">
            {s.tgAdminLabel}
          </label>
          <input
            id="tg-admin-email"
            type="email"
            dir="ltr"
            autoComplete="off"
            required
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="admin@example.com"
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
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">{s.tgAdminHint}</p>
        </>
        )}
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

      {target && (
        <Section title={s.tgAdd} icon={<Link2 className="h-3.5 w-3.5" />} note={s.tgIdHint} testId="tg-add">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span dir="auto" className="text-sm font-black text-white">
              {target.name || target.username || target.email}
            </span>
            <Pill tone={target.role === 'admin' ? 'violet' : 'zinc'}>{target.role}</Pill>
            {target.is_owner && <Pill tone="green">{s.ownerBadge}</Pill>}
          </div>
          <Row label={s.fEmail} value={target.email} />

          {target.role !== 'admin' ? (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-800/60 p-3 text-xs font-medium leading-relaxed text-zinc-400">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              {s.tgAdminHint}
            </p>
          ) : (
            <form onSubmit={add} className="mt-4 space-y-3">
              <div>
                <label htmlFor="tg-numeric-id" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-zinc-500">
                  {s.tgIdLabel}
                </label>
                <input
                  id="tg-numeric-id"
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  autoComplete="off"
                  required
                  value={tgId}
                  onChange={(e) => setTgId(e.target.value)}
                  aria-invalid={tgIdLooksLikeUsername}
                  aria-describedby={tgIdLooksLikeUsername ? 'tg-numeric-id-error' : undefined}
                  placeholder="123456789"
                  className={`min-h-11 w-full rounded-xl border bg-zinc-900 px-4 py-2 tabular-nums text-white focus:outline-none focus:ring-2 ${
                    tgIdLooksLikeUsername ? 'border-red-500/60 focus:ring-red-500/40' : 'border-zinc-700 focus:ring-iris/50'
                  }`}
                />
                {tgIdLooksLikeUsername && (
                  <p id="tg-numeric-id-error" role="alert" className="mt-1.5 text-xs font-bold text-red-400">
                    {s.tgIdNotUsername}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="tg-label" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-zinc-500">
                  {s.tgLabelLabel}
                </label>
                <input
                  id="tg-label"
                  type="text"
                  dir="auto"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={80}
                  placeholder={s.tgLabelPlaceholder}
                  className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-iris/50"
                />
              </div>
              <button
                type="submit"
                disabled={adding || !tgIdValid}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#6B46FF] px-4 text-sm font-bold text-snow transition-colors hover:bg-iris-deep disabled:opacity-50"
              >
                <Send className="h-4 w-4" /> {adding ? s.saving : s.tgAdd}
              </button>
            </form>
          )}
        </Section>
      )}

      <Section title={s.tgTitle} icon={<Link2 className="h-3.5 w-3.5" />} testId="tg-list">
        {loading && rows.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">{s.loading}</p>}
        {!loading && rows.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">{s.tgEmpty}</p>}
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.telegram_user_id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span dir="ltr" className="text-sm font-black tabular-nums text-white">
                  {r.telegram_user_id}
                </span>
                {/* The server decides `active`: live mapping AND the site
                    account is still an admin. A mapping whose account was
                    demoted authorizes nothing and is shown as such rather than
                    quietly disappearing. */}
                <Pill tone={r.revoked_at ? 'zinc' : r.active ? 'green' : 'red'}>
                  {r.revoked_at ? s.tgRevoked : r.active ? s.tgActive : s.tgInactive}
                </Pill>
                {r.label && <Pill tone="zinc">{r.label}</Pill>}
                <span dir="auto" className="ms-auto min-w-0 truncate text-xs font-medium text-zinc-400">
                  {r.name || r.username || r.user_id}
                </span>
              </div>
              <div className="mt-2">
                <Row label={s.fCreated} value={whenLabel(r.created_at, s.never)} />
                {r.revoked_at && <Row label={s.tgRevoke} value={whenLabel(r.revoked_at, s.never)} />}
                {r.revoke_reason && <Row label={s.fReason} value={r.revoke_reason} />}
              </div>

              {mayBind && !r.revoked_at &&
                (revokingId === r.telegram_user_id ? (
                  <div className="mt-3 space-y-2">
                    <label
                      htmlFor={`tg-revoke-reason-${r.telegram_user_id}`}
                      className="block text-xs font-bold uppercase tracking-wider text-zinc-500"
                    >
                      {s.tgRevokeReason}
                    </label>
                    <input
                      id={`tg-revoke-reason-${r.telegram_user_id}`}
                      type="text"
                      dir="auto"
                      value={revokeReason}
                      onChange={(e) => setRevokeReason(e.target.value)}
                      minLength={3}
                      maxLength={200}
                      className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-red-500/40"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={revoking || revokeReason.trim().length < 3}
                        onClick={() => void revoke(r.telegram_user_id)}
                        className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/15 px-4 text-sm font-bold text-red-400 transition-colors hover:bg-red-500/25 disabled:opacity-50"
                      >
                        {revoking ? s.saving : s.tgRevoke}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRevokingId(null);
                          setRevokeReason('');
                        }}
                        className="flex min-h-11 items-center gap-1.5 rounded-xl px-4 text-sm font-bold text-zinc-400 transition-colors hover:bg-zinc-800"
                      >
                        <X className="h-4 w-4" /> {s.cancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setRevokingId(r.telegram_user_id);
                      setRevokeReason('');
                    }}
                    className="mt-3 min-h-11 rounded-xl border border-zinc-700 px-4 text-sm font-bold text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
                  >
                    {s.tgRevoke}
                  </button>
                ))}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
