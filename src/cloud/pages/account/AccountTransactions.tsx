/**
 * /account/transactions — EVERY MOVEMENT, NEWEST FIRST (GET /me/transactions).
 *
 * One list over the six histories the server merges — hours, material,
 * orders, refunds, sell-backs, shipments — paged on the server's exact
 * cursor (`next_before`: time, history and id, so a page never skips the
 * rows one batch wrote at the same instant). Each row in words, with its
 * figure: hours and material as the movement they made, money as the amount
 * recorded. A row leads where the server says what its id is.
 *
 * The filter narrows the rows already loaded — the server has no filter here —
 * and says so when what is loaded holds none of a kind.
 */
import { useState, type ReactNode } from 'react';
import { Field, Select } from '../../../components/ui/Field';
import { Money } from '../../../components/ui/Money';
import { getCredits, listInventory, listTransactions } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDateTime } from '../../format';
import {
  buybackStatus,
  creditEntry,
  inventoryEntry,
  orderStatusWord,
  shipmentKind,
  shipmentStatus,
  txLedger,
  txText,
} from '../../strings/account';
import { tx, useCloudText } from '../../text';
import type { CreditTierBalance, InventoryBalance, TransactionPage, TransactionRow } from '../../types';
import { ArrowLeftRight, Clock, CloudEmptyState, CloudErrorState, CloudPageSkeleton, Disc3, HandCoins, ListRow, ShoppingBag, Truck, Wallet } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { ledgerMovement, TX_LEDGERS, txHref, txStatus } from './logic';
import { LoadMore, MoneyLine, MovementFigure, SubPageHeader, useStatusWord } from './shared';

/** Rows per page (the server allows 1–200). */
const PAGE = 50;

type Ledger = TransactionRow['ledger'];
type Filter = 'all' | Ledger;

const ICONS: Record<Ledger, typeof Clock> = { credits: Clock, inventory: Disc3, orders: ShoppingBag, refunds: Wallet, buybacks: HandCoins, shipments: Truck };

interface Names {
  tiers: CreditTierBalance[];
  inventory: InventoryBalance[];
}

function TxRow({ row, names }: { row: TransactionRow; names: Names | undefined }) {
  const { t, lang } = useCloudText();
  const word = useStatusWord();
  const status = txStatus(row) ?? '';
  const material = row.subject_id ? names?.inventory.find((r) => r.variant_id === row.subject_id) : undefined;
  const tier = row.ledger === 'credits' && row.subject_id ? names?.tiers.find((x) => x.tier_id === row.subject_id) : undefined;

  let title: string;
  let figure: ReactNode = null;
  let subject: string | null = null;
  switch (row.ledger) {
    case 'credits':
      title = word(creditEntry, row.entry_type);
      subject = tier ? tx(tier.name, lang) || tier.code : null;
      figure = <MovementFigure movement={ledgerMovement(row)} unit="seconds" />;
      break;
    case 'inventory':
      title = word(inventoryEntry, row.entry_type);
      subject = material ? tx(material.name, lang) || material.sku : null;
      figure = <MovementFigure movement={ledgerMovement(row)} unit={material?.unit_code ?? ''} />;
      break;
    case 'orders':
      title = t(txText.order, { status: word(orderStatusWord, status) });
      figure = <MoneyLine text={txText.total} iqd={row.value_iqd} />;
      break;
    case 'refunds':
      title = t(txText.refund);
      figure = <Money iqd={row.value_iqd} signed />;
      break;
    case 'buybacks':
      title = t(txText.buyback, { status: word(buybackStatus, status) });
      subject = material ? tx(material.name, lang) || material.sku : null;
      figure = <Money iqd={row.value_iqd} />;
      break;
    case 'shipments':
      title = t(txText.shipment, { kind: word(shipmentKind, row.subject_id ?? ''), status: word(shipmentStatus, status) });
      figure = row.value_iqd ? <Money iqd={row.value_iqd} /> : null;
      break;
    default:
      title = row.entry_type;
  }
  const Icon = ICONS[row.ledger] ?? ArrowLeftRight;
  return (
    <li>
      <ListRow
        to={txHref(row) ?? undefined}
        leading={<Icon className="h-4 w-4" />}
        title={title}
        meta={[subject, formatDateTime(row.created_at, lang)].filter(Boolean).join(' · ')}
        trailing={figure ? <span className="text-sm font-bold text-text-primary">{figure}</span> : undefined}
      />
    </li>
  );
}

export default function AccountTransactions() {
  const { t } = useCloudText();
  const { dashboardVersion } = useCloud();
  const first = useCloudQuery((signal) => listTransactions({ limit: PAGE }, { signal }), [dashboardVersion]);
  // Names for the rows' subjects: a failure leaves them unnamed, never the list unread.
  const names = useCloudQuery(
    (signal) => Promise.all([getCredits({ signal }), listInventory(undefined, { signal })]).then(([credits, inventory]) => ({ tiers: credits.tiers, inventory })),
    [dashboardVersion]
  );
  const [more, setMore] = useState<{ base: TransactionPage; rows: TransactionRow[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const header = <SubPageHeader title={t(txText.title)} subtitle={t(txText.subtitle)} />;

  if (first.error) {
    return (
      <div>
        {header}
        <CloudErrorState error={first.error} onRetry={first.reload} />
      </div>
    );
  }
  if (!first.data) {
    return (
      <div>
        {header}
        <CloudPageSkeleton />
      </div>
    );
  }
  const base = first.data;
  // Pages loaded after the first belong to THAT first page: a reload starts the list again.
  const extra = more && more.base === base ? more : null;
  const rows = [...base.items, ...(extra?.rows ?? [])];
  const next = extra ? extra.next : base.next_before;
  const shown = filter === 'all' ? rows : rows.filter((r) => r.ledger === filter);

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listTransactions({ before: next, limit: PAGE });
      setMore((m) => ({ base, rows: [...(m && m.base === base ? m.rows : []), ...page.items], next: page.next_before }));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div>
        {header}
        <CloudEmptyState icon={<ArrowLeftRight className="h-6 w-6" />} title={t(txText.empty)} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      <Field label={t(txText.filter)} className="max-w-xs">
        <Select value={filter} onChange={(e) => setFilter(e.currentTarget.value as Filter)}>
          <option value="all">{t(txText.all)}</option>
          {TX_LEDGERS.map((l) => (
            <option key={l} value={l}>
              {t(txLedger[l])}
            </option>
          ))}
        </Select>
      </Field>
      {shown.length === 0 ? (
        <p className="text-[13px] text-text-muted">{t(txText.filteredEmpty)}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((row) => (
            <TxRow key={`${row.ledger}:${row.id}`} row={row} names={names.data} />
          ))}
        </ul>
      )}
      {moreError ? <CloudErrorState compact error={moreError} onRetry={loadMore} /> : null}
      {next ? <LoadMore onMore={loadMore} loading={loadingMore} /> : <p className="text-center text-[12px] text-text-muted">{t(txText.end)}</p>}
    </div>
  );
}
