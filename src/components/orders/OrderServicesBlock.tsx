/**
 * «خدمات الطابعة» — WHAT WAS BOUGHT WITH THIS PRINTER, READ IN SECONDS (owner, 2026-11-21; DECISIONS row 364).
 *
 * The order line carried all of it (`items[].services`, worker/lib/printerServices.ts orderServicesView)
 * and no order screen drew it: staff packed a printer without seeing whether its box takes extra
 * packaging, whether it must be inspected before it leaves, whether a session is to be scheduled, whether
 * the customer holds a warranty and until when. Three short groups, in the order the work happens:
 *
 *   1. «لهذا الصندوق» — packaging, inspection, training, hand-over (what the packer does to THIS box);
 *   2. the cover — warranty and Levo Care, with the end date once delivered, «بلا ضمان» in words;
 *   3. the fees per printer, each named, and for a printer sold under the price anchor the plain
 *      sentence of what its price already includes and what the choice moved it by.
 *
 * THE CHARGE IS `net_fee_iqd` (fee − what the price included), never `fee_iqd`, on an anchored line.
 * The same component serves the customer's order page (`audience="customer"`: his words, no task state).
 */
import type { AdminServiceTask, OrderItemServices } from '../../lib/api';
import { orderServicesStrings, type Loc } from './orderServicesStrings';

type Tone = 'plain' | 'do' | 'done' | 'warn' | 'muted';

const TONE: Record<Tone, string> = {
  plain: 'text-text-primary',
  do: 'text-warning',
  done: 'text-success',
  warn: 'text-warning',
  muted: 'text-text-secondary',
};

function Fact({ label, value, note, tone = 'plain', state, attr }: {
  label: string; value: string; note?: string | null; tone?: Tone; state?: { text: string; tone: Tone } | null; attr?: string;
}) {
  return (
    <div className="flex items-start gap-2 min-w-0" data-service-fact={attr}>
      <dt className="w-16 shrink-0 text-[12px] leading-relaxed text-text-secondary">{label}</dt>
      <dd className="min-w-0 flex-1">
        <span className={`block text-[13px] leading-relaxed font-bold break-words ${TONE[tone]}`}>{value}</span>
        {note ? <span className="block text-[11.5px] leading-relaxed text-text-secondary break-words">{note}</span> : null}
        {/* ONE CUE FOR «STILL TO DO»: the amber chip. The service itself is written plainly, so a box with
            three services is not three amber sentences with nothing standing out. */}
        {state ? (
          <span
            className={`lv-chip mt-1 inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-bold break-words ${state.tone === 'done' ? '[--chip:var(--color-success)]' : '[--chip:var(--color-warning)]'}`}
            data-service-state={state.tone === 'done' ? 'done' : 'todo'}
          >
            {state.text}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

export default function OrderServicesBlock({
  services,
  qty,
  audience,
  loc,
  money,
  formatDay,
  tasks = [],
}: {
  services: OrderItemServices;
  qty: number;
  audience: 'admin' | 'customer';
  loc: Loc;
  money: (iqd: number) => string;
  /** An ISO instant as a day in the reader's language. */
  formatDay: (iso: string) => string;
  /** Admin only: this line's packing / inspection / Academy tasks. */
  tasks?: readonly AdminServiceTask[];
}) {
  const s = orderServicesStrings(loc);
  const admin = audience === 'admin';
  const sel = services.selection ?? {};
  const line = (service: string) => services.lines.find((l) => l.service === service);
  const task = (kind: string) => tasks.find((t) => t.kind === kind);
  const stateOf = (kind: string): { text: string; tone: Tone } | null => {
    if (!admin) return null;
    const t = task(kind);
    if (!t) return null;
    if (t.status === 'done') {
      const who = [t.done_by_name, t.done_at ? formatDay(t.done_at) : ''].filter(Boolean).join(' · ');
      return { text: who ? `${s.done} — ${who}` : s.done, tone: 'done' };
    }
    return t.status === 'open' ? { text: s.todo, tone: 'do' } : null;
  };

  const extra = line('packaging')?.choice === 'extra';
  const inspected = line('inspection')?.choice === 'full';
  const academy = line('academy')?.choice ?? sel.academy ?? '';
  const lead = services.inspection_lead_business_days;
  const delivery = services.delivery;
  const cover = services.cover ?? null;

  const anchored = typeof services.anchor_fee_iqd === 'number';
  const net = typeof services.net_fee_iqd === 'number' ? services.net_fee_iqd : services.fee_iqd;
  const paidLines = services.lines.filter((l) => l.fee_iqd > 0 || (l.pro_discount_iqd ?? 0) > 0);

  return (
    <div data-order-services className="w-full min-w-0 rounded-xl border border-border-subtle bg-surface-selected p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-[13px] font-black text-text-primary">{s.title}</p>
        <span className="lv-chip [--chip:var(--color-gold)] rounded-full px-2 py-0.5 text-[11px] font-bold" data-service-package={sel.package ?? ''}>
          {s.package(sel.package)}
        </span>
        {qty > 1 ? <span className="text-[11.5px] font-bold text-text-secondary">{s.perPrinter(qty)}</span> : null}
      </div>

      <div>
        {admin ? <p className="text-[11px] font-bold text-text-secondary mb-1">{s.boxHeading}</p> : null}
        <dl className="space-y-1.5">
          <Fact
            attr="packaging"
            label={s.packaging}
            value={extra ? s.packagingExtra : s.packagingStandard}
            tone={extra ? 'plain' : 'muted'}
            state={extra ? stateOf('packaging') : null}
          />
          {(inspected || admin) && (
            <Fact
              attr="inspection"
              label={s.inspection}
              value={inspected ? s.inspectionFull : s.inspectionNone}
              note={inspected && lead ? s.inspectionLead(lead[0], lead[1]) : null}
              tone={inspected ? 'plain' : 'muted'}
              state={inspected ? stateOf('inspection') : null}
            />
          )}
          {academy ? (
            <Fact
              attr="academy"
              label={s.academy}
              value={
                academy === 'live_whatsapp' ? (admin ? s.academyWhatsapp : s.academyWhatsappMine)
                  : academy === 'live_in_person' ? (admin ? s.academyInPerson : s.academyInPersonMine)
                    : admin ? s.academyRecorded : s.academyRecordedMine
              }
              tone={academy === 'recorded' ? 'muted' : 'plain'}
              state={academy === 'recorded' ? null : stateOf('academy')}
            />
          ) : null}
          {delivery === 'pickup' ? (
            <Fact attr="delivery" label={s.delivery} value={admin ? s.deliveryPickup : s.deliveryPickupMine} tone={admin ? 'warn' : 'plain'} />
          ) : delivery === 'economy' || delivery === 'personal' ? (
            <Fact
              attr="delivery"
              label={s.delivery}
              value={delivery === 'personal' ? s.deliveryPersonal : s.deliveryEconomy}
              note={typeof services.delivery_fee_iqd === 'number' ? s.deliveryFee(money(services.delivery_fee_iqd)) : null}
            />
          ) : null}
        </dl>
      </div>

      <div>
        <p className="text-[11px] font-bold text-text-secondary mb-1">{admin ? s.coverHeading : s.coverHeadingMine}</p>
        <dl className="space-y-1.5">
          {services.warranty_months > 0 ? (
            <Fact
              attr="warranty"
              label={s.warranty}
              value={cover?.warranty_end_at ? `${s.warrantyMonths(services.warranty_months)} — ${s.until(formatDay(cover.warranty_end_at))}` : s.warrantyMonths(services.warranty_months)}
              note={cover?.warranty_end_at ? null : s.fromDelivery}
            />
          ) : (
            <Fact
              attr="warranty"
              label={s.warranty}
              value={admin ? s.noWarranty : s.noWarrantyMine}
              note={sel.ack_no_warranty ? (admin ? s.ackRecorded : s.ackRecordedMine) : null}
              tone="warn"
            />
          )}
          {services.care_total_months > 0 ? (
            <Fact
              attr="care"
              label={s.care}
              value={cover?.care_end_at ? `${s.careMonths(services.care_total_months)} — ${s.until(formatDay(cover.care_end_at))}` : s.careMonths(services.care_total_months)}
              note={cover?.care_end_at ? null : services.warranty_months > 0 ? s.careAfterWarranty : s.fromDelivery}
            />
          ) : (
            <Fact attr="care" label={s.care} value={s.careNone} tone="muted" />
          )}
        </dl>
      </div>

      {(paidLines.length > 0 || anchored) && (
        <div data-service-fees>
          <p className="text-[11px] font-bold text-text-secondary mb-1">{s.feesHeading}</p>
          <dl className="rounded-lg border border-border-subtle divide-y divide-border-subtle bg-surface">
            {paidLines.map((l) => (
              <div key={`${l.service}:${l.choice}`} className="flex items-start justify-between gap-3 px-3 py-2 min-w-0">
                <dt className="min-w-0 text-[12px] text-text-secondary break-words">
                  {s.service(l.service, l.choice)}
                  {(l.pro_discount_iqd ?? 0) > 0 ? (
                    <span className="block text-[11px] font-bold text-success" data-service-pro-saving>{s.proSaving(money(l.pro_discount_iqd ?? 0))}</span>
                  ) : null}
                </dt>
                <dd className="shrink-0 text-[12px] tabular-nums text-text-primary">{money(l.fee_iqd)}</dd>
              </div>
            ))}
            <div className="flex items-start justify-between gap-3 px-3 py-2 min-w-0">
              <dt className="min-w-0 text-[12px] font-bold text-text-primary">{s.feesTotal}</dt>
              <dd className="shrink-0 text-[12px] font-bold tabular-nums text-text-primary">{money(services.fee_iqd)}</dd>
            </div>
            {anchored ? (
              <div className="px-3 py-2 min-w-0" data-service-anchor>
                <p className="text-[12px] leading-relaxed text-text-secondary break-words">{s.anchorIncluded(money(services.anchor_fee_iqd ?? 0))}</p>
                <p className="mt-1 flex items-start justify-between gap-3">
                  <span className="min-w-0 text-[12px] font-bold text-text-primary break-words">
                    {s.package(sel.package)} — {net > 0 ? s.chargedMore : net < 0 ? s.chargedLess : s.chargedSame}
                  </span>
                  <span className={`shrink-0 text-[13px] font-black tabular-nums ${net < 0 ? 'text-success' : 'text-text-primary'}`} data-service-net={net}>
                    {net === 0 ? money(0) : `${net > 0 ? '+' : '−'} ${money(Math.abs(net))}`}
                  </span>
                </p>
              </div>
            ) : null}
          </dl>
        </div>
      )}
    </div>
  );
}
