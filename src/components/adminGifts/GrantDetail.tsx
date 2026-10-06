/**
 * ONE GRANTED GIFT, AS THE ADMIN SEES IT (docs/GIFTS_QUICK_BUY.md §1.2): the
 * customer, the status, the product, the order, the internal note and reason
 * (editable, audited before/after), the actions this status allows — cancel,
 * convert a legacy box, mark a legacy box delivered — and the audit timeline
 * of every step. Unlike the customer's card, this one carries the note.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, failureText } from '../../lib/api';
import { Sheet } from '../ui/Overlay';
import { formatDateTime, statusLabel } from '../orders/format';
import { Banner, Field, Select, TextArea } from '../adminProducts/form/formUi';
import * as T from '../adminProducts/theme';
import { GiftStatusChip, ItemRow, triOf } from './ui';
import { actionLabel, adminText, reasonKey, type AdminLang, type AdminStringKey } from './strings';
import { GRANT_REASONS, type AdminGift, type AuditEntry, type GrantReason } from './types';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] leading-relaxed">
      <dt className="text-[var(--ap-text-3)]">{label}</dt>
      <dd className="min-w-0 text-[var(--ap-text-1)]">{children}</dd>
    </div>
  );
}

export default function GrantDetail({
  lang,
  giftId,
  onClose,
  onChanged,
}: {
  lang: AdminLang;
  giftId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = (k: AdminStringKey) => adminText(lang, k);
  const titleId = useId();
  const [grant, setGrant] = useState<AdminGift | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<GrantReason>('admin_gift');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [convertLevel, setConvertLevel] = useState(1);

  const load = useCallback(async () => {
    if (!giftId) return;
    try {
      const res = await api.get<{ grant: AdminGift; audit: AuditEntry[] }>(`/api/gifts/admin/grants/${encodeURIComponent(giftId)}`);
      setGrant(res.grant);
      setAudit(res.audit ?? []);
      setNote(res.grant.note);
      if (res.grant.reason !== 'legacy') setReason(res.grant.reason);
      setConvertLevel(Math.min(5, Math.max(1, res.grant.legacy?.max_level ?? 1)));
    } catch (e) {
      setError(failureText(e, t('loadFailed')));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on gift only
  }, [giftId]);

  useEffect(() => {
    setGrant(null);
    setAudit([]);
    setError('');
    setOk('');
    setCancelOpen(false);
    setCancelReason('');
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: AdminStringKey) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setOk('');
    try {
      await fn();
      setOk(t(done));
      await load();
      onChanged();
    } catch (e) {
      setError(failureText(e, t('loadFailed')));
    } finally {
      setBusy(false);
    }
  };

  const id = encodeURIComponent(giftId ?? '');
  const dirty = !!grant && (note !== grant.note || (grant.reason !== 'legacy' && reason !== grant.reason));

  return (
    <Sheet open={!!giftId} onClose={() => !busy && onClose()} labelledBy={titleId} panelClassName="w-full sm:max-w-xl">
      <div className={`${T.AP} px-5 pb-5 pt-2 space-y-4`} data-gift-detail={giftId ?? ''}>
        <h2 id={titleId} className="text-[15px] font-bold text-[var(--ap-text-1)]">
          {t('detail')}
        </h2>
        {!grant && !error && (
          <p className="flex items-center gap-2 text-[13px] text-[var(--ap-text-3)]">
            <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> {t('loading')}
          </p>
        )}
        {error && (
          <div role="alert">
            <Banner kind="error">{error}</Banner>
          </div>
        )}
        {ok && (
          <p role="status">
            <Banner kind="ok">{ok}</Banner>
          </p>
        )}

        {grant && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <GiftStatusChip lang={lang} status={grant.status} />
              {grant.level && <span className="text-[12.5px] text-[var(--ap-text-2)]">{triOf(lang, grant.level.name) || adminText(lang, 'levelN', { n: grant.level.n })}</span>}
              <span className="text-[12.5px] text-[var(--ap-text-3)]">· {t(reasonKey(grant.reason))}</span>
            </div>
            <dl className="space-y-1">
              <Fact label={t('customer')}>
                <span dir="auto">{grant.user.name || grant.user.username}</span>{' '}
                <span className="text-[var(--ap-text-3)]" dir="ltr">
                  {grant.user.email}
                  {grant.user.phone ? ` · ${grant.user.phone}` : ''}
                </span>
              </Fact>
              <Fact label={t('grantedBy')}>
                {grant.granted_by ? grant.granted_by.name || grant.granted_by.email || t('system') : t('system')} · {formatDateTime(grant.granted_at, lang)}
              </Fact>
              {grant.order && (
                <Fact label={t('order')}>
                  <a className="underline underline-offset-2" href={`/admin?tab=orders&order=${encodeURIComponent(grant.order.id)}`} dir="ltr">
                    {grant.order.id}
                  </a>{' '}
                  <span className="text-[var(--ap-text-3)]">· {statusLabel(lang, grant.order.status)}</span>
                </Fact>
              )}
              {grant.cancelled_at && (
                <Fact label={t('cancelledBy')}>
                  {formatDateTime(grant.cancelled_at, lang)}
                  {grant.cancel_reason ? ` — ${grant.cancel_reason}` : ''}
                </Fact>
              )}
            </dl>

            <div className="rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-3">
              <p className="mb-2 text-[12px] text-[var(--ap-text-3)]">{t('chosenProduct')}</p>
              {grant.chosen ? <ItemRow lang={lang} item={grant.chosen} /> : <p className="text-[12.5px] text-[var(--ap-text-2)]">{t('notChosen')}</p>}
            </div>

            <div className="space-y-2">
              <p className="text-[13px] font-semibold text-[var(--ap-text-1)]">{t('editNote')}</p>
              {grant.actions.edit_reason && (
                <Field ar={t('reason')} en="Reason">
                  <Select value={reason} onChange={(e) => setReason(e.target.value as GrantReason)} disabled={busy}>
                    {GRANT_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {t(reasonKey(r))}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field ar={t('note')} en="Note" hint={t('noteHint')}>
                <TextArea dir="auto" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
              </Field>
              <button
                type="button"
                className={T.btnSecondary}
                disabled={busy || !dirty}
                onClick={() =>
                  void act(
                    () =>
                      api.patch(`/api/gifts/admin/grants/${id}`, grant.actions.edit_reason ? { note, reason } : { note }),
                    'saved'
                  )
                }
                data-gift-save-note
              >
                {t('save')}
              </button>
            </div>

            {(grant.actions.cancel || grant.actions.convert || grant.actions.fulfill || grant.status === 'ORDERED') && (
              <div className="space-y-2 border-t border-[var(--ap-border)] pt-3">
                {grant.status === 'ORDERED' && <p className="text-[12.5px] text-[var(--ap-text-2)]">{t('orderedCancelHint')}</p>}
                {grant.actions.convert && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Field ar={t('chooseLevel')} en="Level" hint={t('convertHint')}>
                        <Select value={String(convertLevel)} onChange={(e) => setConvertLevel(Number(e.target.value))} disabled={busy}>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>
                              {adminText(lang, 'levelN', { n })}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <button
                      type="button"
                      className={T.btnPrimary}
                      disabled={busy}
                      onClick={() => void act(() => api.post(`/api/gifts/admin/grants/${id}/convert`, { level: convertLevel }), 'converted')}
                      data-gift-convert
                    >
                      {t('convert')}
                    </button>
                  </div>
                )}
                {grant.actions.fulfill && (
                  <button
                    type="button"
                    className={T.btnSecondary}
                    disabled={busy}
                    onClick={() => void act(() => api.post(`/api/gifts/admin/grants/${id}/fulfill`, {}), 'fulfilled')}
                  >
                    {t('fulfill')}
                  </button>
                )}
                {grant.actions.cancel &&
                  (cancelOpen ? (
                    <div className="space-y-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-danger-border)] p-3">
                      <p className="text-[12.5px] text-[var(--ap-text-2)]">{t('cancelConsequence')}</p>
                      <Field ar={t('cancelReason')} en="Reason">
                        <TextArea dir="auto" rows={2} maxLength={1000} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} disabled={busy} />
                      </Field>
                      <div className="flex gap-2">
                        <button type="button" className={T.btnGhost} onClick={() => setCancelOpen(false)} disabled={busy}>
                          {t('cancel')}
                        </button>
                        <button
                          type="button"
                          className={T.btnDanger}
                          disabled={busy || cancelReason.trim().length < 3}
                          onClick={() =>
                            void act(async () => {
                              await api.post(`/api/gifts/admin/grants/${id}/cancel`, { reason: cancelReason.trim() });
                              setCancelOpen(false);
                            }, 'cancelled')
                          }
                          data-gift-cancel-confirm
                        >
                          {t('cancelGift')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className={T.btnDanger} onClick={() => setCancelOpen(true)} disabled={busy} data-gift-cancel>
                      {t('cancelGift')}
                    </button>
                  ))}
              </div>
            )}

            <div className="space-y-2 border-t border-[var(--ap-border)] pt-3">
              <p className="text-[13px] font-semibold text-[var(--ap-text-1)]">{t('timeline')}</p>
              <ol className="space-y-2" data-gift-timeline>
                {audit.map((a) => (
                  <li key={a.id} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-1.5 w-2 h-2 shrink-0 rounded-full bg-gold" />
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-semibold text-[var(--ap-text-1)]">{actionLabel(lang, a.action)}</p>
                      <p className="text-[12px] text-[var(--ap-text-3)]">
                        {formatDateTime(a.at.includes('T') ? a.at : `${a.at.replace(' ', 'T')}Z`, lang)}
                        {a.actor ? ` · ${a.actor.name || a.actor.email}` : ` · ${t('system')}`}
                        {typeof a.detail.order_id === 'string' ? ` · ${a.detail.order_id}` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
        <div className="flex justify-end">
          <button type="button" className={T.btnGhost} onClick={onClose} disabled={busy}>
            {t('close')}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
