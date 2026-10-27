/**
 * /account/materials/:variantId — ONE MATERIAL THE CUSTOMER OWNS (GET
 * /me/inventory, /me/inventory/ledger?variant_id; PATCH
 * /me/inventory/{variantId}/alert; POST /me/inventory/top-up-quote).
 *
 * The four figures (yours = free + held, held, free, used — the server's own,
 * in the variant's unit), what was paid for what remains (the customer's own
 * money, never a workshop cost), the low-balance reminder (their own amount,
 * or the workshop's default when they set none — a default no customer door
 * states, so it is named, never numbered), «top up to N» priced by the server
 * as a new purchase, and the movements of this one material.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { Field } from '../../../components/ui/Field';
import { NumberInput } from '../../../components/ui/NumberInput';
import { Skeleton } from '../../../components/ui/Skeleton';
import { toast } from '../../../lib/toastStore';
import { cloudErrorText, inventoryTopUpQuote, listInventory, listInventoryLedger, setInventoryAlert } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDateTime, formatQuantity, unitWord } from '../../format';
import { account, inventoryEntry, materialsText, sect } from '../../strings/account';
import { tx, useCloudText } from '../../text';
import type { InventoryBalance, TopUpQuote } from '../../types';
import { Bell, CloudEmptyState, CloudErrorState, CloudPageSkeleton, HandCoins, PackageSearch, SectionHeader, Truck } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { inventoryFigures, isLow, ledgerMovement } from './logic';
import { CapNote, Figures, MoneyLine, MovementFigure, SubPageHeader, Swatch, TopUpResult, useStatusWord } from './shared';

/** How many movements the page asks for; the full history pages exactly in Transactions. */
const LEDGER_PAGE = 50;
const enc = encodeURIComponent;

type Typed = { value: number | null; valid: boolean };

function Reminder({ row }: { row: InventoryBalance }) {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const [typed, setTyped] = useState<Typed>({ value: row.low_stock_alert_qty, valid: true });
  const [error, setError] = useState<string | null>(null);
  const save = async (qty: number | null) => {
    setError(null);
    try {
      await setInventoryAlert(row.variant_id, qty);
      toast.success(t(materialsText.alertSaved));
      if (qty === null) setTyped({ value: null, valid: true });
      cloud.refreshDashboard();
    } catch (e) {
      setError(cloudErrorText(e, lang));
    }
  };
  const unchanged = typed.value === row.low_stock_alert_qty;
  return (
    <section aria-labelledby="cloud-material-alert" className="lv-surface space-y-3 p-4">
      <h2 id="cloud-material-alert" className="flex items-center gap-2 text-[17px] font-bold text-text-primary">
        <Bell aria-hidden="true" className="h-5 w-5 text-text-secondary" />
        {t(materialsText.alertTitle)}
      </h2>
      <p className="text-[13px] font-semibold text-text-secondary">
        {row.low_stock_alert_qty == null ? t(materialsText.alertDefault) : t(materialsText.alertCurrent, { qty: formatQuantity(row.low_stock_alert_qty, row.unit_code, lang) })}
      </p>
      <Field label={t(materialsText.alertLabel)} hint={t(materialsText.alertBody)}>
        <NumberInput kind="number" decimals={0} min={0} unit={unitWord(row.unit_code, lang)} value={typed.value} onValueChange={(value, valid) => setTyped({ value, valid })} />
      </Field>
      {error ? (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!typed.valid || typed.value === null || unchanged} onClick={() => save(typed.value)}>
          {t(materialsText.alertSave)}
        </Button>
        {row.low_stock_alert_qty != null ? (
          <Button variant="ghost" onClick={() => save(null)}>
            {t(materialsText.alertUseDefault)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function TopUp({ row }: { row: InventoryBalance }) {
  const { t, lang } = useCloudText();
  const [target, setTarget] = useState<Typed>({ value: null, valid: true });
  const [result, setResult] = useState<TopUpQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const price = async () => {
    setError(null);
    setResult(null);
    try {
      // No target typed: the server's own usual amount applies — the screen never assumes one.
      setResult(await inventoryTopUpQuote(target.value != null ? { variant_id: row.variant_id, target_qty: target.value } : { variant_id: row.variant_id }));
    } catch (e) {
      setError(cloudErrorText(e, lang));
    }
  };
  return (
    <section aria-labelledby="cloud-material-topup" className="lv-surface space-y-3 p-4">
      <h2 id="cloud-material-topup" className="text-[17px] font-bold text-text-primary">
        {t(materialsText.topUpTitle)}
      </h2>
      <p className="text-[13px] leading-relaxed text-text-muted">{t(materialsText.topUpBody)}</p>
      <Field label={t(materialsText.topUpTarget)} hint={t(materialsText.topUpHint)}>
        <NumberInput
          kind="number"
          decimals={0}
          min={1}
          unit={unitWord(row.unit_code, lang)}
          value={target.value}
          onValueChange={(value, valid) => {
            setTarget({ value, valid });
            setResult(null);
          }}
        />
      </Field>
      <Button variant="secondary" disabled={!target.valid} onClick={price}>
        {t(materialsText.topUpPrice)}
      </Button>
      {error ? (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
      {result ? <TopUpResult result={result} unit={row.unit_code} /> : null}
    </section>
  );
}

function History({ row }: { row: InventoryBalance }) {
  const { t, lang } = useCloudText();
  const { dashboardVersion } = useCloud();
  const word = useStatusWord();
  const ledger = useCloudQuery((signal) => listInventoryLedger({ variant_id: row.variant_id, limit: LEDGER_PAGE }, { signal }), [row.variant_id, dashboardVersion]);
  return (
    <section aria-labelledby="cloud-material-history" className="space-y-2">
      <SectionHeader id="cloud-material-history" title={t(materialsText.historyTitle)} />
      {ledger.error ? (
        <CloudErrorState compact error={ledger.error} onRetry={ledger.reload} />
      ) : !ledger.data ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : ledger.data.length === 0 ? null : (
        <>
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
            {ledger.data.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{word(inventoryEntry, e.entry_type)}</p>
                  <p className="truncate text-[12px] text-text-muted">{formatDateTime(e.created_at, lang)}</p>
                </div>
                <span className="shrink-0 text-sm font-bold">
                  <MovementFigure movement={ledgerMovement(e)} unit={row.unit_code} />
                </span>
              </li>
            ))}
          </ul>
          <CapNote shown={ledger.data.length} cap={LEDGER_PAGE} history />
        </>
      )}
    </section>
  );
}

export default function AccountMaterial() {
  const { t, lang } = useCloudText();
  const { dashboardVersion } = useCloud();
  const { variantId = '' } = useParams();
  const inventory = useCloudQuery((signal) => listInventory(undefined, { signal }), [dashboardVersion]);
  const back = { to: '/account/materials', label: t(materialsText.title) };

  if (inventory.error) {
    return (
      <div>
        <SubPageHeader title={t(materialsText.title)} back={back} />
        <CloudErrorState error={inventory.error} onRetry={inventory.reload} />
      </div>
    );
  }
  if (!inventory.data) {
    return (
      <div>
        <SubPageHeader title={t(materialsText.title)} back={back} />
        <CloudPageSkeleton />
      </div>
    );
  }
  const row = inventory.data.find((r) => r.variant_id === variantId);
  if (!row) {
    return (
      <div>
        <SubPageHeader title={t(materialsText.title)} back={back} />
        <CloudEmptyState
          icon={<PackageSearch className="h-6 w-6" />}
          title={t(materialsText.notFoundTitle)}
          action={
            <Link to="/account/materials" className="lv-button lv-button-secondary">
              {t(materialsText.title)}
            </Link>
          }
        />
      </div>
    );
  }

  const f = inventoryFigures(row);
  const q = (n: number | null) => formatQuantity(n, row.unit_code, lang);
  const name = tx(row.name, lang) || row.sku || t(sect.unknownMaterial);
  return (
    <div className="space-y-5">
      <SubPageHeader title={name} subtitle={[row.brand, row.material, row.color_name].filter(Boolean).join(' · ') || null} back={back} />
      <section aria-label={name} className="lv-surface space-y-3 p-4">
        <div className="flex items-center gap-3">
          <Swatch hex={row.color_hex} className="h-8 w-8" />
          <p className="min-w-0 flex-1 text-[13px] text-text-muted">
            <MoneyLine text={materialsText.paidRemaining} iqd={row.remaining_value_iqd} />
          </p>
          {isLow(row) ? <span className="text-[12px] font-semibold text-warning">{t(account.runningLow)}</span> : null}
        </div>
        <Figures
          items={[
            { label: t(materialsText.owned), value: q(f.owned) },
            { label: t(materialsText.held), value: q(f.reserved) },
            { label: t(materialsText.available), value: q(f.available) },
            { label: t(materialsText.used), value: q(f.used) },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {row.available_qty > 0 ? (
            <>
              <Link to={`/account/shipments/new?variant=${enc(row.variant_id)}`} className="lv-button lv-button-secondary lv-button-sm">
                <Truck aria-hidden="true" className="h-4 w-4" />
                {t(materialsText.ship)}
              </Link>
              <Link to={`/account/buyback?variant=${enc(row.variant_id)}`} className="lv-button lv-button-secondary lv-button-sm">
                <HandCoins aria-hidden="true" className="h-4 w-4" />
                {t(materialsText.sellBack)}
              </Link>
            </>
          ) : null}
          <Link to="/store?tab=materials" className="lv-button lv-button-ghost lv-button-sm">
            {t(materialsText.buyMore)}
          </Link>
        </div>
      </section>
      <Reminder key={`${row.variant_id}:${row.low_stock_alert_qty ?? 'default'}`} row={row} />
      <TopUp row={row} />
      <History row={row} />
    </div>
  );
}
