/**
 * The one value a bulk action needs — a price, a stock count, or a
 * collection — asked in a small sheet. The server applies it per product and
 * answers per product (a product with variants keeps its variants' stock:
 * VARIANTS_HAVE_OWN_STOCK).
 */
import { useEffect, useId, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Field, Select } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import type { Collection } from './catalogApi';
import { catalogStrings } from './strings';

export type BulkValueKind = 'price' | 'stock' | 'add_to_collection' | 'remove_from_collection';

export default function BulkValueSheet({
  kind,
  count,
  collections,
  onClose,
  onApply,
}: {
  kind: BulkValueKind | null;
  count: number;
  collections: Collection[];
  onClose: () => void;
  onApply: (extra: Record<string, unknown>) => void;
}) {
  const { loc, lang } = useLanguage();
  const s = catalogStrings(loc);
  const titleId = useId();
  const [n, setN] = useState<number | null>(null);
  const [collection, setCollection] = useState('');

  useEffect(() => {
    setN(null);
    setCollection(collections[0]?.id ?? '');
  }, [kind, collections]);

  const title =
    kind === 'price' ? s.setPrice : kind === 'stock' ? s.setStock : kind === 'add_to_collection' ? s.addToCollection : s.removeFromCollection;
  const isCollection = kind === 'add_to_collection' || kind === 'remove_from_collection';
  const ready = isCollection ? !!collection : n !== null && Number.isInteger(n) && n >= 0;

  return (
    <Sheet
      open={!!kind}
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="w-full sm:max-w-sm"
      header={
        <div className="px-5 pb-1 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">{title}</h2>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{s.selected(count)}</p>
        </div>
      }
      footer={
        <div className="flex gap-2 px-5 py-3">
          <Button variant="ghost" onClick={onClose} className="flex-1">{s.cancel}</Button>
          <Button
            variant="primary"
            className="flex-[2]"
            disabled={!ready}
            onClick={() => onApply(kind === 'price' ? { price_iqd: n } : kind === 'stock' ? { stock: n } : { collection_id: collection })}
          >
            {s.apply}
          </Button>
        </div>
      }
    >
      <div className="px-5 pb-4 pt-2">
        {isCollection ? (
          collections.length ? (
            <Field label={s.chooseCollection}>
              <Select value={collection} onChange={(e) => setCollection(e.target.value)}>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{lang === 'en' ? c.name : c.name_ar || c.name}</option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-[12.5px] text-text-muted">{s.noCollections}</p>
          )
        ) : (
          <Field label={kind === 'price' ? s.priceIqd : s.quantity}>
            {kind === 'price' ? (
              <NumberInput kind="money" value={n} onValueChange={(v) => setN(v)} />
            ) : (
              <NumberInput kind="quantity" min={0} value={n} onValueChange={(v) => setN(v)} />
            )}
          </Field>
        )}
      </div>
    </Sheet>
  );
}
