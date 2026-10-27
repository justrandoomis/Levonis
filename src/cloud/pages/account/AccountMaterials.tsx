/**
 * /account/materials — WHAT THE CUSTOMER OWNS AT THE WORKSHOP (GET
 * /me/inventory, /me/inventory/reorder-suggestions; POST
 * /me/inventory/top-up-quote).
 *
 * One row per variant, in that variant's own unit (grams of one colour, pieces
 * of one magnet — never added together), with what is free to use and what
 * prints hold; a row opens its own page (the reminder, the top-up, the
 * movements). Above them, when prints waiting for the customer's confirmation
 * need more than they own, the server's own reorder suggestion, priced on
 * demand as a stored quote that goes on into the store's cart.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { cloudErrorText, inventoryTopUpQuote, listInventory, listReorderSuggestions, listStoreProducts } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatQuantity } from '../../format';
import { account, materialsText } from '../../strings/account';
import { tx, useCloudText } from '../../text';
import type { InventoryBalance, ReorderSuggestion, StoreProduct, TopUpQuote, Tri } from '../../types';
import { CloudEmptyState, CloudErrorState, CloudPageSkeleton, Disc3, ListRow, Package, SectionHeader, TriangleAlert } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { inventoryFigures, isLow } from './logic';
import { SubPageHeader, Swatch, TopUpResult } from './shared';

const enc = encodeURIComponent;

const GROUPS: Array<{ kind: string; title: Tri }> = [
  { kind: 'filament', title: materialsText.kindFilament },
  { kind: 'accessory', title: materialsText.kindAccessory },
  { kind: 'tool', title: materialsText.kindTool },
];

function MaterialRow({ row }: { row: InventoryBalance }) {
  const { t, lang } = useCloudText();
  const f = inventoryFigures(row);
  const low = isLow(row);
  const meta = [[row.brand, row.material].filter(Boolean).join(' '), f.reserved ? t(materialsText.heldLine, { amount: formatQuantity(f.reserved, row.unit_code, lang) }) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <ListRow
        to={`/account/materials/${enc(row.variant_id)}`}
        leading={row.color_hex ? <Swatch hex={row.color_hex} /> : row.category_kind === 'filament' ? <Disc3 className="h-4 w-4" /> : <Package className="h-4 w-4" />}
        title={tx(row.name, lang) || row.sku}
        meta={meta || null}
        trailing={
          <span className="flex flex-col items-end gap-0.5">
            <span className="text-sm font-bold tabular-nums text-text-primary">
              <bdi>{formatQuantity(f.available, row.unit_code, lang)}</bdi>
            </span>
            {low ? (
              <span className="flex items-center gap-1 text-[11px] font-semibold text-warning">
                <TriangleAlert aria-hidden="true" className="h-3 w-3" />
                {t(account.runningLow)}
              </span>
            ) : (
              <span className="text-[11px] text-text-muted">{t(materialsText.available)}</span>
            )}
          </span>
        }
      />
    </li>
  );
}

function SuggestionRow({ suggestion, name }: { suggestion: ReorderSuggestion; name: string }) {
  const { t, lang } = useCloudText();
  const [result, setResult] = useState<TopUpQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unit = suggestion.unit_code;
  const price = async () => {
    setError(null);
    try {
      // The server's own suggested quantity, priced as a new purchase of exactly that much.
      setResult(await inventoryTopUpQuote({ variant_id: suggestion.variant_id, quantity: suggestion.suggested_purchase_qty }));
    } catch (e) {
      setError(cloudErrorText(e, lang));
    }
  };
  return (
    <li className="lv-surface space-y-2 p-3">
      <p className="text-sm font-semibold text-text-primary">{name}</p>
      <p className="text-[12px] text-text-muted">
        {t(materialsText.reorderLine, {
          needed: formatQuantity(suggestion.needed_qty, unit, lang),
          owned: formatQuantity(suggestion.owned_qty, unit, lang),
          short: formatQuantity(suggestion.shortfall_qty, unit, lang),
        })}
      </p>
      <p className="text-[12px] font-semibold text-text-secondary">{t(materialsText.reorderSuggest, { qty: formatQuantity(suggestion.suggested_purchase_qty, unit, lang) })}</p>
      {result ? (
        <TopUpResult result={result} unit={unit} />
      ) : (
        <Button variant="secondary" size="sm" onClick={price}>
          {t(materialsText.priceIt)}
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function Reorder({ rows }: { rows: InventoryBalance[] }) {
  const { t, lang } = useCloudText();
  const { dashboardVersion } = useCloud();
  const suggestions = useCloudQuery((signal) => listReorderSuggestions({ signal }), [dashboardVersion]);
  // A material the customer has never owned has no balance row to name it: the catalogue does.
  const unnamed = (suggestions.data ?? []).some((s) => !rows.some((r) => r.variant_id === s.variant_id));
  const catalogue = useCloudQuery<StoreProduct[]>((signal) => (unnamed ? listStoreProducts(undefined, { signal }) : Promise.resolve([])), [unnamed]);
  if (suggestions.error) return <CloudErrorState compact error={suggestions.error} onRetry={suggestions.reload} />;
  if (!suggestions.data || suggestions.data.length === 0) return null;
  const nameOf = (variantId: string): string => {
    const own = rows.find((r) => r.variant_id === variantId);
    if (own) return tx(own.name, lang) || own.sku;
    const product = (catalogue.data ?? []).find((p) => p.id === variantId);
    return product ? tx(product.name, lang) || product.sku : variantId;
  };
  return (
    <section aria-labelledby="cloud-materials-reorder" className="space-y-2">
      <SectionHeader id="cloud-materials-reorder" title={t(materialsText.reorderTitle)} count={suggestions.data.length} />
      <p className="text-[13px] leading-relaxed text-text-muted">{t(materialsText.reorderBody)}</p>
      <ul className="space-y-2">
        {suggestions.data.map((s) => (
          <SuggestionRow key={s.variant_id} suggestion={s} name={nameOf(s.variant_id)} />
        ))}
      </ul>
    </section>
  );
}

export default function AccountMaterials() {
  const { t } = useCloudText();
  const { dashboardVersion } = useCloud();
  const inventory = useCloudQuery((signal) => listInventory(undefined, { signal }), [dashboardVersion]);
  const header = (
    <SubPageHeader
      title={t(materialsText.title)}
      subtitle={t(materialsText.subtitle)}
      actions={
        <Link to="/store?tab=materials" className="lv-button lv-button-secondary lv-button-sm">
          {t(materialsText.buy)}
        </Link>
      }
    />
  );

  if (inventory.error) {
    return (
      <div>
        {header}
        <CloudErrorState error={inventory.error} onRetry={inventory.reload} />
      </div>
    );
  }
  if (!inventory.data) {
    return (
      <div>
        {header}
        <CloudPageSkeleton />
      </div>
    );
  }
  const rows = inventory.data;
  const known = new Set(GROUPS.map((g) => g.kind));
  const groups = [...GROUPS, { kind: 'other', title: materialsText.kindOther }]
    .map((g) => ({ ...g, rows: rows.filter((r) => (g.kind === 'other' ? !known.has(r.category_kind) : r.category_kind === g.kind)) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-5">
      {header}
      <Reorder rows={rows} />
      {rows.length === 0 ? (
        <CloudEmptyState
          icon={<Disc3 className="h-6 w-6" />}
          title={t(materialsText.emptyTitle)}
          body={t(materialsText.emptyBody)}
          action={
            <Link to="/store?tab=materials" className="lv-button lv-button-primary">
              {t(materialsText.buy)}
            </Link>
          }
        />
      ) : (
        groups.map((g) => (
          <section key={g.kind} aria-labelledby={`cloud-materials-${g.kind}`} className="space-y-2">
            <SectionHeader id={`cloud-materials-${g.kind}`} title={t(g.title)} count={g.rows.length} />
            <ul className="space-y-2">
              {g.rows.map((r) => (
                <MaterialRow key={r.account_id} row={r} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
