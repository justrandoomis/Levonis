/**
 * ONE REQUEST AT THE DESK (spec §6.13, trade-in design B.5): the facts (the order, the dates, the
 * warranty left, the part, the new device, the offer and when the device is due), what the
 * customer declared against what the desk saw, the photographs by who took them, the history —
 * and the one thing to do next:
 *
 *   waiting for the device   «استلام الجهاز» (IntakeSheet, any admin)
 *   received, not valued     the value panel (ValuePanel, financial; above the ceiling the owner)
 *   cancelled after intake   «سجّل إعادة الجهاز للزبون» (any admin, once)
 *   credit spent, delivered  «إتمام الاستبدال» (the owner; normally automatic)
 *
 * The owner's valuation record is its own lazy panel, for the owner only. A button the server
 * would refuse is not offered; the server still decides.
 */
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, ExternalLink, PackageCheck, Undo2 } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { Modal } from '../adminProducts/ui';
import { api } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { FAMILY_LABELS, OPTIONAL_PHOTO, REQUIRED_PHOTOS, anglesFor, type TradeInFamily } from '../../../packages/pricing/src/tradeIn';
import { timeLeftWords, warrantyTimeLeft } from '../../../packages/pricing/src/warrantyTime';
import VariantImg from '../ui/VariantImg';
import { dateText, nameOf, triText } from '../tradeIn/model';
import { useA } from './useA';
import { chipTone } from './TradeInQueue';
import { refreshServicesBadge } from './servicesBadge';
import IntakeSheet from './IntakeSheet';
import ValuePanel from './ValuePanel';
import type { AdminRequestView, DetailResponse, QueueChip } from './types';
import type { AdminKey } from './copy';

/** The owner's record of the computation: its own chunk, fetched by the owner only. */
const OwnerValuationPanel = React.lazy(() => import('./OwnerValuationPanel'));

const INTAKE_OPEN = ['submitted', 'under_review', 'value_changed', 'awaiting_payment', 'completed'];

/** The desk's chip for a request, from the customer's stage. */
function chipOf(r: AdminRequestView): QueueChip {
  switch (r.stage) {
    case 'awaiting_device':
      return 'awaiting_device';
    case 'inspecting':
      return 'inspecting';
    case 'decision':
      return 'decision';
    case 'credit_ready':
      return 'credit_ready';
    case 'awaiting_new_device':
      return 'awaiting_new_device';
    case 'completed':
    case 'credit_reissued':
      return 'completed';
    case 'device_to_collect':
      return 'device_to_collect';
    default:
      return 'closed';
  }
}

export default function TradeInDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { a, money, loc, lang } = useA();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<DetailResponse>(`/api/admin/trade-in/requests/${encodeURIComponent(id)}`));
    } catch (e) {
      setError(apiRefusal(e, refusalLang(lang), a('loadError')));
    }
  }, [id, lang, a]);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = (r: AdminRequestView) => {
    setData((cur) => (cur ? { ...cur, request: r } : cur));
    onChanged();
    void refreshServicesBadge();
  };

  const act = async (name: string, path: string, body?: Record<string, unknown>) => {
    setBusy(name);
    setError('');
    try {
      const d = await api.post<{ request: AdminRequestView }>(`/api/admin/trade-in/requests/${encodeURIComponent(id)}/${path}`, body ?? {});
      setCancelOpen(false);
      changed(d.request);
    } catch (e) {
      setError(apiRefusal(e, refusalLang(lang), a('failed')));
    } finally {
      setBusy('');
    }
  };

  const r = data?.request;
  const ownerScope = data?.owner_scope === true;
  const money0 = data?.financial_scope === true;
  const title = a('detail.title');

  const footer = r ? (
    <div className="flex flex-wrap items-center gap-2">
      {r.stage === 'device_to_collect' ? (
        <button type="button" className={`${T.btnSecondary} min-h-[44px]`} disabled={!!busy} onClick={() => act('returned', 'device-returned')} data-act="device-returned">
          <Undo2 className="h-4 w-4" aria-hidden />
          {a('act.returned')}
        </button>
      ) : null}
      {ownerScope && r.status === 'awaiting_payment' && r.credit_order?.status === 'delivered' ? (
        <button
          type="button"
          className={`${T.btnPrimary} min-h-[44px]`}
          disabled={!!busy}
          onClick={() => act('complete', 'complete')}
          title={a('act.completeHint')}
          data-act="complete"
        >
          <PackageCheck className="h-4 w-4" aria-hidden />
          {a('act.complete')}
        </button>
      ) : null}
      {r.can.cancel ? (
        <button type="button" className={`${T.btnDanger} min-h-[44px]`} disabled={!!busy} aria-expanded={cancelOpen} onClick={() => setCancelOpen((v) => !v)} data-act="cancel">
          <Ban className="h-4 w-4" aria-hidden />
          {a('act.cancel')}
        </button>
      ) : null}
    </div>
  ) : null;

  const scopeKey: AdminKey = r?.scope === 'ams_only' ? 'scope.ams' : r?.scope === 'printer_only' ? 'scope.printer' : 'scope.whole';
  const left = r ? warrantyTimeLeft(r.source.warranty_end_at, new Date().toISOString()) : { months: 0, days: 0 };
  const serialKey: AdminKey | null = r?.intake?.serial_match
    ? r.intake.serial_match === 'match'
      ? 'intake.match'
      : r.intake.serial_match === 'mismatch'
        ? 'intake.mismatch'
        : r.intake.serial_match === 'unrecorded'
          ? 'intake.unrecorded'
          : 'intake.notApplicable'
    : null;
  const canIntake = !!r && !r.intake && INTAKE_OPEN.includes(r.status) && !r.credit_order;
  const canValue = !!r && !!r.intake && (r.status === 'under_review' || r.status === 'value_changed' || r.status === 'submitted');

  const angleLabel = (family: TradeInFamily, id: string) => {
    const x = [...anglesFor(family, 2), ...REQUIRED_PHOTOS[family], OPTIONAL_PHOTO].find((p) => p.id === id);
    return x ? loc(x.label_ar, x.label_en, x.label_ckb) : id;
  };
  const fact = (k: AdminKey, v: React.ReactNode) => (
    <div className="min-w-0">
      <dt className={`text-[11.5px] ${T.text3}`}>{a(k)}</dt>
      <dd className="min-w-0 break-words text-[13px]">{v}</dd>
    </div>
  );

  return (
    <Modal titleAr={title} titleEn={lang === 'en' ? '' : 'Trade-in request'} onClose={onClose} wide footer={footer}>
      {!r ? (
        <p className={`py-10 text-center text-[13px] ${T.text3}`}>{error || a('loading')}</p>
      ) : (
        <div className="space-y-4" data-admin-trade-in={r.id} data-stage={r.stage}>
          <section className={`${T.surface} p-4`}>
            <div className="flex items-center gap-3">
              <span className="h-14 w-14 shrink-0 overflow-hidden rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)]">
                {r.source.image ? <VariantImg sizes="56px" src={r.source.image} alt="" className="h-full w-full object-cover" /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold">{r.source.name}</p>
                <p className={`text-[12.5px] ${T.text3}`}>
                  {r.source.variant ? `${r.source.variant} · ` : ''}
                  {loc(FAMILY_LABELS[r.family].ar, FAMILY_LABELS[r.family].en, FAMILY_LABELS[r.family].ckb)} · {a(scopeKey)}
                </p>
              </div>
              <span className={`${T.badgeBase} ${chipTone(chipOf(r))}`}>{triText(r.stage_label, loc)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {serialKey ? (
                <span className={`${T.badgeBase} ${r.intake?.serial_match === 'match' ? T.badge.active : T.badge.hidden}`} data-flag-serial={r.intake?.serial_match}>
                  {r.intake?.serial_match !== 'match' ? <AlertTriangle className="h-3 w-3" aria-hidden /> : null}
                  {a(serialKey)}
                </span>
              ) : null}
              {r.intake?.hours_flag ? <span className={`${T.badgeBase} ${T.badge.hidden}`}>{a('hoursFlag')}</span> : null}
              {r.above_ceiling ? <span className={`${T.badgeBase} ${T.badge.hidden}`}>{a('aboveCeilingFlag')}</span> : null}
              {r.cutover ? <span className={`${T.badgeBase} ${T.badge.draft}`}>{a('cutoverFlag')}</span> : null}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {fact(
                'f.order',
                <a className="underline decoration-dotted" href={`/admin?tab=orders&order=${encodeURIComponent(r.order_id)}`} dir="ltr">
                  {r.order_id} <ExternalLink className="inline h-3 w-3" aria-hidden />
                </a>
              )}
              {fact('f.delivered', dateText(r.source.delivered_at, lang))}
              {fact(
                'f.warrantyLeft',
                left.months > 0 || left.days > 0 ? loc(timeLeftWords(left, 'ar'), timeLeftWords(left, 'en'), timeLeftWords(left, 'ckb')) : a('f.warrantyOver')
              )}
              {fact('f.target', r.target ? nameOf(r.target, loc) : '—')}
              {fact('f.targetPrice', money(r.target?.price_iqd))}
              {fact('f.offer', money(r.offer?.offer_iqd ?? r.estimated_iqd))}
              {r.offer_expires_at && !r.intake ? fact('f.offerUntil', dateText(r.offer_expires_at, lang)) : null}
              {fact('f.final', money(r.final_value_iqd))}
              {fact('f.credit', money(r.credit_iqd))}
              {fact('f.difference', money(r.difference_iqd))}
              {fact('f.handover', r.handover ? a(`handover.${r.handover}` as AdminKey) : '—')}
              {typeof r.previews === 'number' ? fact('f.previews', <span className="tabular-nums">{r.previews}</span>) : null}
              {r.credit_order ? fact('f.creditOrder', <bdi dir="ltr">{`${r.credit_order.id} (${r.credit_order.status})`}</bdi>) : null}
              {r.device_returned_at ? fact('f.returned', dateText(r.device_returned_at, lang)) : null}
            </dl>
          </section>

          {!money0 ? (
            <p className="rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] p-2.5 text-[12.5px] text-[var(--ap-warning)]">
              {a('noMoneyScope')}
            </p>
          ) : null}

          {cancelOpen ? (
            <section className={`${T.surface} space-y-2 p-3`}>
              <label className="block">
                <span className={`mb-1 block text-[12px] ${T.text3}`}>{a('reasonCustomer')}</span>
                <input className={`${T.input} w-full`} maxLength={500} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} data-cancel-reason />
              </label>
              <button
                type="button"
                className={T.btnDanger}
                disabled={cancelReason.trim().length < 3 || !!busy}
                onClick={() => act('cancel', 'cancel', { reason: cancelReason.trim() })}
                data-confirm-cancel
              >
                {a('act.confirmCancel')}
              </button>
            </section>
          ) : null}
          {error ? (
            <p className="text-[13px] text-[var(--ap-danger)]" role="alert">
              {error}
            </p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
            <div className="min-w-0 space-y-4">
              {canIntake ? <IntakeSheet req={r} ownerScope={ownerScope} onDone={changed} /> : null}
              {canValue && money0 ? <ValuePanel req={r} ownerScope={ownerScope} onDone={changed} /> : null}
              {!r.intake && !canIntake && money0 && ['submitted', 'under_review'].includes(r.status) ? <p className={`text-[12.5px] ${T.text3}`}>{a('value.waitIntake')}</p> : null}

              {r.intake ? (
                <section className={`${T.surface} space-y-2 p-4`} data-intake-record>
                  <h3 className="text-[14px] font-bold">{a('intake')}</h3>
                  <p className={`text-[12.5px] ${T.text2}`}>{a('intake.by', { name: r.intake.by_name ?? '—', date: dateText(r.intake.received_at, lang) })}</p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                    {fact(
                      'intake.serial',
                      <bdi dir="ltr" className="font-mono">
                        {r.intake.serial_norm ?? '—'}
                      </bdi>
                    )}
                    {fact('intake.hours', <span className="tabular-nums">{r.intake.hours_seen ?? '—'}</span>)}
                  </dl>
                  {r.intake.findings ? fact('intake.findings', r.intake.findings) : null}
                  {r.declared_vs_intake?.length ? (
                    <div className="overflow-x-auto">
                      <p className={`mb-1 text-[12px] ${T.text3}`}>{a('declaredVsSeen')}</p>
                      <table className="w-full text-[12.5px]" data-declared-vs-seen>
                        <thead>
                          <tr className={T.text3}>
                            <th className="py-1 text-start font-medium" scope="col">
                              {a('col.answer')}
                            </th>
                            <th className="py-1 text-start font-medium" scope="col">
                              {a('col.declared')}
                            </th>
                            <th className="py-1 text-start font-medium" scope="col">
                              {a('col.seen')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.declared_vs_intake.map((d, i) => (
                            <tr key={i} className="border-t border-[var(--ap-hairline)]">
                              <td className="py-1" dir="ltr">
                                {d.field}
                              </td>
                              <td className="py-1" dir="ltr">
                                {JSON.stringify(d.declared)}
                              </td>
                              <td className="py-1 font-semibold" dir="ltr">
                                {JSON.stringify(d.seen)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {r.intake_photos?.length ? (
                    <div>
                      <p className={`mb-1 text-[12px] ${T.text3}`}>{a('intake.photos')}</p>
                      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                        {r.intake_photos.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setPhoto(p.url)}
                            className="relative aspect-square overflow-hidden rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)]"
                          >
                            <img src={p.url} alt={a('intake.photos')} className="h-full w-full object-cover" loading="lazy" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {r.components.map((c) => (
                <section key={c.role} className={`${T.surface} space-y-2 p-4`} data-component={c.role}>
                  <h3 className="text-[14px] font-bold">
                    {a('photos.customer')} · {a(c.role === 'ams' ? 'part.ams' : 'part.device')}
                  </h3>
                  <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                    {c.photos.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPhoto(p.url)}
                        className="relative aspect-square overflow-hidden rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)]"
                        title={angleLabel(c.family, p.angle)}
                      >
                        <img src={p.url} alt={angleLabel(c.family, p.angle)} className="h-full w-full object-cover" loading="lazy" />
                        <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[10px] text-white">
                          {p.proves && p.proves !== 'hours' ? p.proves : angleLabel(c.family, p.angle)}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {r.customer_note ? (
                <section className={`${T.surface} p-4 text-[13px]`}>
                  <p className={`mb-1 text-[12px] ${T.text3}`}>{a('customerNote')}</p>
                  {r.customer_note}
                </section>
              ) : null}
            </div>

            <aside className="space-y-4">
              {ownerScope ? (
                <Suspense fallback={<p className={`text-[12.5px] ${T.text3}`}>{a('loading')}</p>}>
                  <OwnerValuationPanel requestId={r.id} />
                </Suspense>
              ) : null}
              {data?.customer ? (
                <section className={`${T.surface} space-y-1 p-4 text-[13px]`}>
                  <h3 className="mb-1 text-[14px] font-bold">{a('customer')}</h3>
                  <p>{data.customer.name}</p>
                  <p dir="ltr" className={T.text2}>
                    {data.customer.phone_e164 ?? ''}
                  </p>
                  <p dir="ltr" className={T.text2}>
                    {data.customer.email}
                  </p>
                </section>
              ) : null}
              <section className={`${T.surface} p-4`}>
                <h3 className="mb-2 text-[14px] font-bold">{a('history')}</h3>
                <ol className="space-y-2 text-[12.5px]">
                  {r.events.map((e, n) => {
                    const label = a(`ev.${e.action}` as AdminKey).replace(/^ev\./, '');
                    return (
                      <li key={n}>
                        <span className="font-semibold">{label}</span>
                        <span className={T.text3}>
                          {' · '}
                          {a(`role.${e.actor_role}` as AdminKey)} · {dateText(e.created_at, lang)}
                        </span>
                        {typeof e.detail.value_iqd === 'number' ? <span className={T.text2}> · {money(e.detail.value_iqd as number)}</span> : null}
                        {typeof e.detail.reason === 'string' && e.detail.reason ? <p className={T.text3}>{e.detail.reason as string}</p> : null}
                      </li>
                    );
                  })}
                </ol>
              </section>
            </aside>
          </div>
          {photo ? (
            <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4" role="dialog" aria-modal="true" onClick={() => setPhoto(null)}>
              <img src={photo} alt="" className="max-h-full max-w-full rounded-[var(--ap-radius-md)]" />
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
