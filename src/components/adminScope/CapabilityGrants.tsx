import { useCallback, useEffect, useState } from 'react';
import { ShieldOff, UserCheck, UserX } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { apiRefusal, refusalLang, refusalText } from '../../lib/refusalStrings';
import { newOperationId, reviewApi, type CapabilityKey, type ReviewerRow } from '../../lib/merchantApplication';
import { GRANT_STRINGS } from './grantStrings';

/** Whether this row holds `key`: the keyed map, or — from a server older than row 261 — MERCHANT_REVIEW's flag. */
function holds(row: ReviewerRow, key: CapabilityKey): boolean {
  if (row.grants && typeof row.grants[key] === 'boolean') return row.grants[key] === true;
  return key === 'MERCHANT_REVIEW' ? row.granted : false;
}

/**
 * THE OWNER'S LIST OF WHO HANDLES ONE DESK (owner decision C5; DECISIONS row
 * 261): every other admin, a full admin marked as holding it by default, an
 * assistant with the owner's grant for `grantKey` and the button that issues
 * or revokes it. Mounted for the owner only (`user?.is_owner === true`) on the
 * desk it opens: merchant applications, the KYC console, the complaints desk.
 * The server re-checks the owner and a fresh sign-in on every grant.
 */
export function ReviewerGrants({ grantKey = 'MERCHANT_REVIEW' }: { grantKey?: CapabilityKey }) {
  const { lang } = useLanguage();
  const t = GRANT_STRINGS[lang as keyof typeof GRANT_STRINGS] ?? GRANT_STRINGS.ar;
  const desk = t.desks[grantKey];
  const rl = refusalLang(lang);
  const [rows, setRows] = useState<ReviewerRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await reviewApi.reviewers();
      setRows(data.reviewers);
      setError('');
    } catch (err) {
      setError(apiRefusal(err, rl, t.loadError));
    }
  }, [rl, t.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (row: ReviewerRow, grant: boolean) => {
    setBusy(row.id);
    setError('');
    try {
      if (grant) await reviewApi.grant(row.id, newOperationId(), grantKey);
      else await reviewApi.revoke(row.id, grantKey);
      await load();
    } catch (err) {
      setError(apiRefusal(err, rl, t.actionError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-8 lv-surface p-4" data-capability-grants={grantKey}>
      <h3 className="font-bold text-[14px] mb-1">{desk.title}</h3>
      <p className="text-[12px] text-text-muted mb-3 leading-relaxed">{desk.hint}</p>
      {error && <p className="lv-alert lv-alert-danger text-[12.5px] text-text-primary mb-3">{error}</p>}
      {rows && rows.length === 0 && <p className="text-text-muted text-[12.5px]">{t.noAssistants}</p>}
      <ul className="space-y-2">
        {(rows ?? []).map((r) => {
          const granted = holds(r, grantKey);
          return (
            <li key={r.id} className="flex items-center justify-between gap-2 flex-wrap text-[13px]">
              <span className="min-w-0 truncate">
                {r.name || r.username || r.id}
                {r.username && <span className="text-text-muted" dir="ltr"> @{r.username}</span>}
              </span>
              {r.by_default ? (
                <span className="text-text-muted text-[12px]">{desk.byDefault}</span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="text-[12px] text-text-secondary">{granted ? t.granted : t.notGranted}</span>
                  <button
                    onClick={() => void change(r, !granted)}
                    disabled={busy === r.id}
                    className={`lv-button lv-button-sm ${granted ? 'lv-button-secondary' : 'lv-button-primary'}`}
                  >
                    {granted ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                    {granted ? t.revoke : t.grant}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * THE DESK AN ADMIN MAY NOT OPEN, SAID IN THEIR LANGUAGE. An assistant without
 * the owner's grant never sees the KYC tab or the complaints desk (the session
 * hints `can_review_kyc` / `can_handle_disputes`); a link or an old bookmark
 * that lands there anyway reads this instead of an empty screen or a raw 403 —
 * the refusal table's own sentence for the code the server would answer, which
 * names no case and no person.
 */
export function CapabilityRefusal({ code }: { code: 'KYC_REVIEW_FORBIDDEN' | 'DISPUTES_FORBIDDEN' }) {
  const { lang } = useLanguage();
  return (
    <div role="status" data-capability-refusal={code} className="lv-surface p-5 flex items-start gap-3 text-text-primary">
      <ShieldOff className="w-5 h-5 text-warning shrink-0 mt-0.5" aria-hidden />
      <p className="text-[13px] leading-relaxed">{refusalText(code, refusalLang(lang))}</p>
    </div>
  );
}
