/**
 * /account/shipments/new — ASK FOR A PICKUP OR A DELIVERY (POST
 * /shipments/quote, then POST /shipments — a money door: it may open a
 * delivery-fee order).
 *
 * WHAT CAN LEAVE. Finished prints (GET /jobs, `completed`) on no shipment —
 * the server names the live shipment each one is on (`shipment_id`), and it
 * refuses a second one itself (ALREADY_IN_SHIPMENT), so nothing here reads
 * the shipments to find out — and free material whose catalogue row lets it
 * leave the workshop (`fulfillment_modes` names `delivery`; the server
 * refuses the rest). Pickup and delivery are offered only as the workshop
 * offers them (GET /status `delivery`).
 *
 * THE FEE IS THE SERVER'S, BEFORE THE CONFIRMATION. «Review» sends the very
 * body the request will carry to POST /shipments/quote — the request's own
 * assessment — and the confirmation states its answer: the fee and the rule
 * that set it (the owner's fee for the governorate, or the flat fee; pickup
 * is free), what leaves, and that nothing leaves before the fee is paid. A
 * refusal (a print already on a shipment, more material than is free…) is the
 * server's own, shown before anything is sent. Governorates are the server's
 * own eighteen (packages/shipping `IRAQ_GOVERNORATES`, the list
 * `parseAddress` accepts).
 *
 * One Idempotency-Key per intent (shared.tsx `useIntentKey`): a request whose
 * answer was lost, sent again, is the same request.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Field, focusFirstInvalid, Input, Select, Textarea } from '../../../components/ui/Field';
import { NumberInput } from '../../../components/ui/NumberInput';
import { Segmented } from '../../../components/ui/Segmented';
import { Checkbox } from '../../../components/ui/Switch';
import { toast } from '../../../lib/toastStore';
import { IRAQ_GOVERNORATES, governorateName } from '../../../../packages/shipping/src/iraqGovernorates';
import { cloudErrorText, createShipment, listInventory, listJobs, listStoreProducts, quoteShipment } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatQuantity } from '../../format';
import { sect, shipmentKind, shipText } from '../../strings/account';
import { tx, useCloudText } from '../../text';
import type { ShipmentQuote, ShipmentRequest, Tri } from '../../types';
import { CloudErrorState, CloudPageSkeleton, Info, SectionHeader } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { ADDRESS_MAX, addressProblems, deliverableVariants, type AddressDraft, type AddressProblem } from './logic';
import { MoneyLine, SubPageHeader, useIntentKey } from './shared';

type Kind = 'pickup' | 'delivery';
type Typed = { value: number | null; valid: boolean };

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
      Promise.all([listJobs({ signal }), listInventory(undefined, { signal }), listStoreProducts(undefined, { signal })]).then(([jobs, inventory, products]) => ({
        jobs,
        inventory,
        products,
      })),
    [cloud.dashboardVersion]
  );

  const [jobPick, setJobPick] = useState<ReadonlySet<string>>(new Set());
  const [itemPick, setItemPick] = useState<Record<string, Typed>>({});
  const [address, setAddress] = useState<AddressDraft>(() => ({ recipient_name: cloud.user?.name ?? '', phone: '', governorate: '', city: '', address_line: '', notes: '' }));
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ for: string; answer: ShipmentQuote } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<{ for: string; text: string } | null>(null);

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

  // A print the server names a live shipment for has left, or is about to: never offered again.
  const jobIds = completed.filter((j) => jobPick.has(j.id) && !j.shipment_id).map((j) => j.id);
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
  // The quote is the server's answer for THIS body: any change to what would be sent drops it.
  const signature = JSON.stringify(body);
  const shown = quote && quote.for === signature ? quote.answer : null;
  const refusal = quoteError && quoteError.for === signature ? quoteError.text : null;

  const problemOf = (key: keyof AddressDraft) => (tried && problems[key] ? t(PROBLEM_WORDS[problems[key]!]) : undefined);
  const setPart = (key: keyof AddressDraft) => (e: { currentTarget: { value: string } }) => {
    const value = e.currentTarget.value;
    setAddress((a) => ({ ...a, [key]: value }));
  };

  const review = async () => {
    setTried(true);
    if (!body) {
      // On the next frame the fields carry aria-invalid: focus the first one.
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    // The request's own assessment, for the very body it will carry: the fee and what leaves, or the refusal.
    setQuoteError(null);
    setQuoting(true);
    try {
      const answer = await quoteShipment(body);
      setQuote({ for: signature, answer });
      setError(null);
      setConfirming(true);
    } catch (e) {
      setQuoteError({ for: signature, text: cloudErrorText(e, lang) });
    } finally {
      setQuoting(false);
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
  if (!base.data) {
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
              const on = job.shipment_id ?? null;
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
      {refusal ? (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          {refusal}
        </p>
      ) : null}
      <Button variant="primary" block loading={quoting} onClick={review}>
        {t(shipText.review)}
      </Button>

      <ConfirmDialog
        open={confirming && !!body && !!shown}
        title={t(shipText.confirmTitle)}
        consequence={
          shown ? (
            <span className="block space-y-2">
              <span className="block font-semibold text-text-primary">{t(shipmentKind[shown.kind])}</span>
              <span className="block">{t(shipText.confirmCounts, { prints: shown.jobs.length, materials: shown.items.length })}</span>
              {shown.items.length > 0 ? <span className="block">{t(shipText.confirmHold)}</span> : null}
              {shown.kind === 'pickup' ? (
                <span className="block">{t(shipText.pickupNotice)}</span>
              ) : shown.fee_iqd > 0 ? (
                <>
                  <span className="block font-semibold text-text-primary">
                    <MoneyLine text={shipText.feeLine} iqd={shown.fee_iqd} />
                  </span>
                  <span className="block text-[13px]">
                    {shown.fee_rule === 'governorate' && shown.governorate
                      ? t(shipText.feeGovernorate, { governorate: governorateName(shown.governorate, lang) })
                      : t(shipText.feeFlat)}
                  </span>
                  <span className="block">{t(shipText.feeAfter)}</span>
                </>
              ) : (
                <span className="block">{t(shipText.feeNone)}</span>
              )}
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
