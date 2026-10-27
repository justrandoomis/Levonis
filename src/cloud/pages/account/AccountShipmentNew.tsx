/**
 * /account/shipments/new — ASK FOR A PICKUP OR A DELIVERY (POST /shipments,
 * a money door: it may open a delivery-fee order).
 *
 * WHAT CAN LEAVE. Finished prints (GET /jobs, `completed`) that are not
 * already on a shipment — read from the customer's own shipments, since a job
 * does not say which shipment carries it — and free material whose catalogue
 * row lets it leave the workshop (`fulfillment_modes` names `delivery`; the
 * server refuses the rest). Pickup and delivery are offered only as the
 * workshop offers them (GET /status `delivery`).
 *
 * THE FEE IS THE SERVER'S. No customer door states the delivery fee of a
 * governorate before the request, so the screen does not guess one: it says
 * the fee is set by the workshop and shown once the request is made, as an
 * order of its own that nothing leaves before; the answer's `fee_iqd` is then
 * shown on the shipment's page. Governorates are the server's own eighteen
 * (packages/shipping `IRAQ_GOVERNORATES`, the list `parseAddress` accepts).
 *
 * One Idempotency-Key per intent (shared.tsx `useIntentKey`): a request whose
 * answer was lost, sent again, is the same request.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Field, focusFirstInvalid, Input, Select, Textarea } from '../../../components/ui/Field';
import { NumberInput } from '../../../components/ui/NumberInput';
import { Segmented } from '../../../components/ui/Segmented';
import { Checkbox } from '../../../components/ui/Switch';
import { toast } from '../../../lib/toastStore';
import { IRAQ_GOVERNORATES } from '../../../../packages/shipping/src/iraqGovernorates';
import { cloudErrorText, createShipment, getShipment, listInventory, listJobs, listShipments, listStoreProducts } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatQuantity } from '../../format';
import { sect, shipmentKind, shipText } from '../../strings/account';
import { tx, useCloudText } from '../../text';
import type { ShipmentRequest, ShipmentView, Tri } from '../../types';
import { CloudErrorState, CloudPageSkeleton, Info, SectionHeader } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { ADDRESS_MAX, addressProblems, deliverableVariants, jobsOnShipments, shipmentsToCheck, type AddressDraft, type AddressProblem } from './logic';
import { SubPageHeader, useIntentKey } from './shared';

type Kind = 'pickup' | 'delivery';
type Typed = { value: number | null; valid: boolean };

/** How many of the customer's shipments are read to know which prints are taken: the most recent ones, newest first. */
const CHECK_CAP = 30;
const GOVERNORATE_IDS: ReadonlySet<string> = new Set(IRAQ_GOVERNORATES.map((g) => g.id));
const PROBLEM_WORDS: Record<AddressProblem, Tri> = { required: sect.required, format: shipText.phoneFormat, too_long: sect.tooLong };
const enc = encodeURIComponent;

export default function AccountShipmentNew() {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const preselect = params.get('variant');
  const formRef = useRef<HTMLDivElement>(null);

  const offered = cloud.status?.delivery;
  const kinds: Kind[] = [...(offered?.pickup_enabled ? (['pickup'] as const) : []), ...(offered?.enabled ? (['delivery'] as const) : [])];
  const [kindPick, setKindPick] = useState<Kind | null>(null);
  const kind: Kind | null = kindPick && kinds.includes(kindPick) ? kindPick : (kinds[0] ?? null);

  const base = useCloudQuery(
    (signal) =>
      Promise.all([listJobs({ signal }), listInventory(undefined, { signal }), listStoreProducts(undefined, { signal }), listShipments({ signal })]).then(
        ([jobs, inventory, products, shipments]) => ({ jobs, inventory, products, shipments })
      ),
    [cloud.dashboardVersion]
  );
  const toCheck = useMemo(() => shipmentsToCheck(base.data?.shipments ?? []), [base.data]);
  const details = useCloudQuery(
    (signal) => (base.data ? Promise.allSettled(toCheck.slice(0, CHECK_CAP).map((s) => getShipment(s.id, { signal }))) : Promise.resolve(null)),
    [base.data, toCheck]
  );
  const taken = useMemo(() => {
    if (!details.data) return null;
    const read = details.data.filter((r): r is PromiseFulfilledResult<ShipmentView> => r.status === 'fulfilled').map((r) => r.value);
    return { jobs: jobsOnShipments(read), partial: read.length < details.data.length || toCheck.length > CHECK_CAP };
  }, [details.data, toCheck]);

  const [jobPick, setJobPick] = useState<ReadonlySet<string>>(new Set());
  const [itemPick, setItemPick] = useState<Record<string, Typed>>({});
  const [address, setAddress] = useState<AddressDraft>(() => ({ recipient_name: cloud.user?.name ?? '', phone: '', governorate: '', city: '', address_line: '', notes: '' }));
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const completed = base.data?.jobs.completed ?? [];
  const deliverable = deliverableVariants(base.data?.products ?? []);
  const free = (base.data?.inventory ?? []).filter((r) => r.available_qty > 0);
  const rows = free.filter((r) => deliverable.has(r.variant_id));
  const hidden = free.length - rows.length;

  // `?variant=` (from a material's page) chooses that material, all of what is free of it, once.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !base.data || !preselect) return;
    seeded.current = true;
    const row = base.data.inventory.find((r) => r.variant_id === preselect && r.available_qty > 0);
    if (row && deliverableVariants(base.data.products).has(row.variant_id)) setItemPick({ [row.variant_id]: { value: row.available_qty, valid: true } });
  }, [base.data, preselect]);

  const jobIds = completed.filter((j) => jobPick.has(j.id) && !taken?.jobs.has(j.id)).map((j) => j.id);
  const items = rows.flatMap((r) => {
    const p = itemPick[r.variant_id];
    return p && p.valid && p.value != null && p.value >= 1 && p.value <= r.available_qty ? [{ variant_id: r.variant_id, qty: p.value }] : [];
  });
  const itemsInvalid = rows.some((r) => {
    const p = itemPick[r.variant_id];
    return !!p && (!p.valid || p.value == null || p.value < 1 || p.value > r.available_qty);
  });
  const problems = kind === 'delivery' ? addressProblems(address, GOVERNORATE_IDS) : {};
  const nothing = jobIds.length === 0 && items.length === 0;
  const body: ShipmentRequest | null =
    kind && !nothing && !itemsInvalid && Object.keys(problems).length === 0
      ? {
          kind,
          job_ids: jobIds,
          items,
          ...(kind === 'delivery'
            ? {
                delivery_address: {
                  recipient_name: address.recipient_name.trim(),
                  phone: address.phone.trim(),
                  governorate: address.governorate,
                  city: address.city.trim(),
                  address_line: address.address_line.trim(),
                  ...(address.notes.trim() ? { notes: address.notes.trim() } : {}),
                },
              }
            : {}),
        }
      : null;
  const intent = useIntentKey('shipment', body);

  const problemOf = (key: keyof AddressDraft) => (tried && problems[key] ? t(PROBLEM_WORDS[problems[key]!]) : undefined);
  const setPart = (key: keyof AddressDraft) => (e: { currentTarget: { value: string } }) => {
    const value = e.currentTarget.value;
    setAddress((a) => ({ ...a, [key]: value }));
  };

  const review = () => {
    setTried(true);
    if (body) {
      setError(null);
      setConfirming(true);
    } else {
      // On the next frame the fields carry aria-invalid: focus the first one.
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
    }
  };

  const submit = async () => {
    if (!body) return;
    setError(null);
    try {
      const created = await createShipment(body, intent.key);
      intent.renew();
      cloud.refreshDashboard();
      toast.success(t(shipText.sent));
      navigate(`/account/shipments/${enc(created.shipment_id)}`, { state: { created } });
    } catch (e) {
      setError(cloudErrorText(e, lang));
    }
  };

  const header = <SubPageHeader title={t(shipText.request)} back={{ to: '/account/shipments', label: t(shipText.title) }} />;

  if (kinds.length === 0) {
    return (
      <div>
        {header}
        <p className="flex items-start gap-2 rounded-xl lv-well px-3 py-2 text-[13px] leading-snug text-text-secondary">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {t(shipText.unavailable)}
        </p>
      </div>
    );
  }
  if (base.error) {
    return (
      <div>
        {header}
        <CloudErrorState error={base.error} onRetry={base.reload} />
      </div>
    );
  }
  if (!base.data || !taken) {
    return (
      <div>
        {header}
        <CloudPageSkeleton />
      </div>
    );
  }

  return (
    <div ref={formRef} className="space-y-5">
      {header}

      <section aria-labelledby="cloud-ship-how" className="space-y-2">
        <h2 id="cloud-ship-how" className="text-[17px] font-bold text-text-primary">
          {t(shipText.how)}
        </h2>
        {kinds.length > 1 ? (
          <Segmented
            group="cloud-ship-kind"
            label={t(shipText.how)}
            value={kind ?? 'pickup'}
            onChange={(id) => setKindPick(id as Kind)}
            items={kinds.map((k) => ({ id: k, label: t(shipmentKind[k]) }))}
          />
        ) : (
          <p className="text-sm font-semibold text-text-secondary">{kind ? t(shipmentKind[kind]) : null}</p>
        )}
        <p className="text-[13px] leading-relaxed text-text-muted">{kind === 'delivery' ? t(shipText.feeNotice) : t(shipText.pickupNotice)}</p>
      </section>

      <section aria-labelledby="cloud-ship-prints" className="space-y-2">
        <SectionHeader id="cloud-ship-prints" title={t(shipText.printsTitle)} count={completed.length} />
        {completed.length === 0 ? (
          <p className="text-[13px] text-text-muted">{t(shipText.printsEmpty)}</p>
        ) : (
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
            {completed.map((job) => {
              const on = taken.jobs.get(job.id);
              const title = job.title.trim() || t(sect.untitledPrint);
              return (
                <li key={job.id} className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-1">
                  <Checkbox
                    checked={!on && jobPick.has(job.id)}
                    disabled={!!on}
                    onChange={(next) =>
                      setJobPick((set) => {
                        const copy = new Set(set);
                        if (next) copy.add(job.id);
                        else copy.delete(job.id);
                        return copy;
                      })
                    }
                    label={title}
                  />
                  {on ? (
                    <Link to={`/account/shipments/${enc(on)}`} className="text-[12px] font-semibold text-text-secondary underline-offset-2 hover:underline">
                      {t(shipText.inShipment)}
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {taken.partial ? <p className="text-[12px] leading-relaxed text-text-muted">{t(shipText.checkingShipments)}</p> : null}
      </section>

      <section aria-labelledby="cloud-ship-material" className="space-y-2">
        <SectionHeader id="cloud-ship-material" title={t(shipText.materialTitle)} count={rows.length} />
        {rows.length === 0 ? (
          <p className="text-[13px] text-text-muted">{t(shipText.materialEmpty)}</p>
        ) : (
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
            {rows.map((r) => {
              const pick = itemPick[r.variant_id];
              const max = formatQuantity(r.available_qty, r.unit_code, lang);
              const wrong = !!pick && (!pick.valid || pick.value == null || pick.value < 1 || pick.value > r.available_qty);
              return (
                <li key={r.account_id} className="space-y-2 px-3 py-2">
                  <Checkbox
                    checked={!!pick}
                    onChange={(next) =>
                      setItemPick((all) => {
                        const copy = { ...all };
                        if (next) copy[r.variant_id] = { value: r.available_qty, valid: true };
                        else delete copy[r.variant_id];
                        return copy;
                      })
                    }
                    label={
                      <span className="flex flex-col">
                        <span>{tx(r.name, lang) || r.sku}</span>
                        <span className="text-[12px] text-text-muted">{t(shipText.upTo, { qty: max })}</span>
                      </span>
                    }
                  />
                  {pick ? (
                    <Field label={t(shipText.qty)} error={wrong ? t(shipText.upTo, { qty: max }) : undefined}>
                      <NumberInput
                        kind="number"
                        decimals={0}
                        min={1}
                        max={r.available_qty}
                        value={pick.value}
                        onValueChange={(value, valid) => setItemPick((all) => ({ ...all, [r.variant_id]: { value, valid } }))}
                      />
                    </Field>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 ? <p className="text-[12px] leading-relaxed text-text-muted">{t(shipText.notDeliverable)}</p> : null}
      </section>

      {kind === 'delivery' ? (
        <section aria-labelledby="cloud-ship-address" className="lv-surface space-y-3 p-4">
          <h2 id="cloud-ship-address" className="text-[17px] font-bold text-text-primary">
            {t(shipText.addressTitle)}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t(shipText.recipient)} required error={problemOf('recipient_name')}>
              <Input autoComplete="name" maxLength={ADDRESS_MAX.recipient_name} value={address.recipient_name} onChange={setPart('recipient_name')} />
            </Field>
            <Field label={t(shipText.phone)} hint={t(shipText.phoneHint)} required error={problemOf('phone')}>
              <Input ltr type="tel" inputMode="tel" autoComplete="tel" maxLength={ADDRESS_MAX.phone} value={address.phone} onChange={setPart('phone')} />
            </Field>
            <Field label={t(shipText.governorate)} required error={problemOf('governorate')}>
              <Select value={address.governorate} onChange={setPart('governorate')}>
                <option value="">{t(shipText.chooseGovernorate)}</option>
                {IRAQ_GOVERNORATES.map((g) => (
                  <option key={g.id} value={g.id}>
                    {lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t(shipText.city)} required error={problemOf('city')}>
              <Input autoComplete="address-level2" maxLength={ADDRESS_MAX.city} value={address.city} onChange={setPart('city')} />
            </Field>
          </div>
          <Field label={t(shipText.addressLine)} required error={problemOf('address_line')}>
            <Input autoComplete="street-address" maxLength={ADDRESS_MAX.address_line} value={address.address_line} onChange={setPart('address_line')} />
          </Field>
          <Field label={t(shipText.courierNotes)} optional error={problemOf('notes')}>
            <Textarea rows={2} maxLength={ADDRESS_MAX.notes} value={address.notes} onChange={setPart('notes')} />
          </Field>
        </section>
      ) : null}

      {tried && nothing ? (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          {t(shipText.nothingChosen)}
        </p>
      ) : null}
      <Button variant="primary" block onClick={review}>
        {t(shipText.review)}
      </Button>

      <ConfirmDialog
        open={confirming && !!body}
        title={t(shipText.confirmTitle)}
        consequence={
          body && kind ? (
            <span className="block space-y-2">
              <span className="block font-semibold text-text-primary">{t(shipmentKind[kind])}</span>
              <span className="block">{t(shipText.confirmCounts, { prints: jobIds.length, materials: items.length })}</span>
              {items.length > 0 ? <span className="block">{t(shipText.confirmHold)}</span> : null}
              <span className="block">{kind === 'delivery' ? t(shipText.feeNotice) : t(shipText.pickupNotice)}</span>
            </span>
          ) : null
        }
        confirmLabel={t(shipText.send)}
        cancelLabel={t(sect.goBack)}
        onConfirm={submit}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        error={error}
      />
    </div>
  );
}
