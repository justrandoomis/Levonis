/**
 * /account/shipments/:id — ONE SHIPMENT (GET /shipments/{id}; POST
 * /shipments/{id}/cancel).
 *
 * Where it stands on its road (a pickup: prepared, ready, collected; a
 * delivery: its fee when it has one, prepared, on its way, delivered), what it
 * carries, where it goes, the workshop's tracking reference and carrier. A
 * delivery waiting for its fee leads to the fee's own order (/orders/{id}),
 * where it is paid from the Levonis wallet or at the workshop; right after the
 * request, the server's own payment words are shown too. It can be cancelled
 * only before it leaves (the server's rule): what it held returns, and an
 * unpaid fee is closed with it.
 */
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Money } from '../../../components/ui/Money';
import { toast } from '../../../lib/toastStore';
import { governorateName } from '../../../../packages/shipping/src/iraqGovernorates';
import { cancelShipment, cloudErrorText, getShipment, listInventory, listJobs } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDate, formatQuantity } from '../../format';
import { sect, shipmentKind, shipmentStatus, shipText } from '../../strings/account';
import { tx, useCloudText } from '../../text';
import type { ShipmentCreated } from '../../types';
import { Box, Check, CloudErrorState, CloudPageSkeleton, Info, MapPin, Package, SectionHeader } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { shipmentCancellable, shipmentFeePaid, shipmentSteps } from './logic';
import { ShipmentPill, SubPageHeader, useStatusWord } from './shared';

const enc = encodeURIComponent;

function Steps({ kind, status, fee }: { kind: string; status: string; fee: number }) {
  const { t } = useCloudText();
  const word = useStatusWord();
  const steps = shipmentSteps(kind, status, fee);
  if (!steps) return null;
  return (
    <ol aria-label={t(shipText.stepsLabel)} className="space-y-1.5">
      {steps.map((s) => (
        <li key={s.status} aria-current={s.state === 'current' ? 'step' : undefined} className="flex items-center gap-2 text-[13px]">
          {s.state === 'done' ? (
            <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-snow">
              <Check className="h-3 w-3" />
            </span>
          ) : (
            <span aria-hidden="true" className={`block h-5 w-5 shrink-0 rounded-full ${s.state === 'current' ? 'bg-info' : 'lv-well'}`} />
          )}
          <span className={s.state === 'upcoming' ? 'text-text-muted' : s.state === 'current' ? 'font-bold text-text-primary' : 'text-text-secondary'}>
            {word(shipmentStatus, s.status)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function AccountShipment() {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const word = useStatusWord();
  const { id = '' } = useParams();
  const location = useLocation();
  const created = (location.state as { created?: ShipmentCreated } | null)?.created;
  const fresh = created && created.shipment_id === id ? created : null;
  const shipment = useCloudQuery((signal) => getShipment(id, { signal }), [id, cloud.dashboardVersion]);
  // Names for what it carries: a failure here leaves the ids' places plain, never the page.
  const names = useCloudQuery(
    (signal) => Promise.all([listJobs({ signal }), listInventory(undefined, { signal })]).then(([jobs, inventory]) => ({ jobs, inventory })),
    [cloud.dashboardVersion]
  );
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const header = (title: string) => <SubPageHeader title={title} back={{ to: '/account/shipments', label: t(shipText.title) }} />;
  if (shipment.error) {
    return (
      <div>
        {header(t(shipText.detailTitle))}
        <CloudErrorState error={shipment.error} onRetry={shipment.reload} />
      </div>
    );
  }
  if (!shipment.data) {
    return (
      <div>
        {header(t(shipText.detailTitle))}
        <CloudPageSkeleton />
      </div>
    );
  }
  const sh = shipment.data;
  const jobs = names.data ? [...names.data.jobs.completed, ...names.data.jobs.failed, ...names.data.jobs.cancelled, ...names.data.jobs.current] : [];
  const jobTitle = (jobId: string) => {
    const job = jobs.find((j) => j.id === jobId);
    return job ? job.title.trim() || t(sect.untitledPrint) : t(sect.viewPrint);
  };
  const material = (variantId: string) => names.data?.inventory.find((r) => r.variant_id === variantId) ?? null;
  const awaitingFee = sh.status === 'awaiting_payment' && !!sh.fee_order_id;
  const serverWords = fresh?.payment?.messages?.[lang];

  const cancel = async () => {
    setError(null);
    try {
      await cancelShipment(sh.id);
      setConfirming(false);
      toast.success(t(shipText.cancelled));
      cloud.refreshDashboard();
    } catch (e) {
      setError(cloudErrorText(e, lang));
    }
  };

  return (
    <div className="space-y-5">
      {header(word(shipmentKind, sh.kind))}
      <section aria-label={t(shipText.detailTitle)} className="lv-surface space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ShipmentPill status={sh.status} />
          <p className="text-[12px] text-text-muted">
            {t(shipText.requestedOn, { date: formatDate(sh.created_at, lang) })}
            {sh.closed_at ? ` · ${t(shipText.closedOn, { date: formatDate(sh.closed_at, lang) })}` : null}
          </p>
        </div>
        <Steps kind={sh.kind} status={sh.status} fee={sh.fee_iqd} />
        <p className="flex items-baseline justify-between gap-3 rounded-xl lv-well px-3 py-2 text-[13px]">
          <span className="text-text-secondary">{t(shipText.fee)}</span>
          <span className="font-bold text-text-primary">{sh.fee_iqd > 0 ? <Money iqd={sh.fee_iqd} /> : t(shipText.noFee)}</span>
        </p>
        {awaitingFee ? (
          <div className="space-y-2">
            {serverWords ? <p className="text-[13px] leading-relaxed text-text-secondary">{serverWords}</p> : null}
            <p className="text-[12px] text-text-muted">{t(shipText.payFeeBody)}</p>
            <Link to={`/orders/${enc(sh.fee_order_id ?? '')}`} className="lv-button lv-button-primary w-full">
              {t(shipText.payFee)}
            </Link>
          </div>
        ) : null}
        {sh.tracking_ref ? <p className="text-[13px] text-text-secondary">{t(shipText.tracking, { ref: sh.tracking_ref })}</p> : null}
        {sh.carrier ? <p className="text-[13px] text-text-secondary">{t(shipText.carrier, { name: sh.carrier })}</p> : null}
        {sh.notes ? <p className="text-[13px] text-text-muted">{t(shipText.notesLine, { text: sh.notes })}</p> : null}
      </section>

      <section aria-labelledby="cloud-shipment-items" className="space-y-2">
        <SectionHeader id="cloud-shipment-items" title={t(shipText.itemsTitle)} count={sh.items.filter((i) => Number(i.live ?? 1) === 1).length} />
        <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
          {sh.items.map((item) => {
            const live = Number(item.live ?? 1) === 1;
            const key = String(item.id ?? `${item.job_id ?? ''}${item.variant_id ?? ''}`);
            if (item.item_type === 'print_job' && typeof item.job_id === 'string') {
              return (
                <li key={key} className="flex items-center gap-3 px-3 py-2.5">
                  <Box aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                  <Link to={`/jobs/${enc(item.job_id)}`} className={`min-w-0 flex-1 truncate text-sm font-semibold underline-offset-2 hover:underline ${live ? 'text-text-primary' : 'text-text-muted line-through'}`}>
                    {jobTitle(item.job_id)}
                  </Link>
                  {live ? null : <span className="text-[11px] text-text-muted">{t(shipText.itemRemoved)}</span>}
                </li>
              );
            }
            const variantId = typeof item.variant_id === 'string' ? item.variant_id : '';
            const row = material(variantId);
            const qty = Number(item.qty);
            return (
              <li key={key} className="flex items-center gap-3 px-3 py-2.5">
                <Package aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${live ? 'text-text-primary' : 'text-text-muted line-through'}`}>
                  {row ? tx(row.name, lang) || row.sku : t(sect.unknownMaterial)}
                </span>
                <span className="shrink-0 text-sm font-bold tabular-nums text-text-primary">
                  <bdi>{row ? formatQuantity(qty, row.unit_code, lang) : Number.isFinite(qty) ? qty : '—'}</bdi>
                </span>
                {live ? null : <span className="text-[11px] text-text-muted">{t(shipText.itemRemoved)}</span>}
              </li>
            );
          })}
        </ul>
      </section>

      {sh.address ? (
        <section aria-labelledby="cloud-shipment-address" className="lv-surface space-y-1 p-4">
          <h2 id="cloud-shipment-address" className="mb-1 flex items-center gap-2 text-[17px] font-bold text-text-primary">
            <MapPin aria-hidden="true" className="h-5 w-5 text-text-secondary" />
            {t(shipText.addressTitle)}
          </h2>
          <p className="text-sm font-semibold text-text-primary">{sh.address.recipient_name}</p>
          <p dir="ltr" className="text-start text-[13px] text-text-secondary">
            {sh.address.phone}
          </p>
          <p className="text-[13px] text-text-secondary">
            {[governorateName(sh.address.governorate, lang), sh.address.city].filter(Boolean).join(' · ')}
          </p>
          <p className="text-[13px] text-text-secondary">{sh.address.address_line}</p>
          {sh.address.notes ? <p className="text-[12px] text-text-muted">{sh.address.notes}</p> : null}
        </section>
      ) : null}

      {shipmentCancellable(sh.status, sh.fee_iqd) ? (
        <div className="space-y-2">
          <p className="flex items-start gap-2 text-[12px] leading-relaxed text-text-muted">
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(shipText.cancelBody)}
          </p>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {t(shipText.cancel)}
          </Button>
        </div>
      ) : shipmentFeePaid(sh.status, sh.fee_iqd) ? (
        <p className="flex items-start gap-2 text-[12px] leading-relaxed text-text-muted">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {t(shipText.cancelFeePaid)}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        destructive
        title={t(shipText.cancelTitle)}
        consequence={t(shipText.cancelBody)}
        confirmLabel={t(shipText.cancel)}
        cancelLabel={t(sect.goBack)}
        onConfirm={cancel}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        error={error}
      />
    </div>
  );
}
