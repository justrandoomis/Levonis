import { useEffect, useState } from 'react';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { api, Field, PROCUREMENT, Select, T, money, useLabels, type Selection } from './shared';

export default function StockSelection({
  value,
  onChange,
}: {
  value: Selection | null;
  onChange: (value: Selection | null) => void;
}) {
  const { loc } = useLabels();
  const [product, setProduct] = useState(value?.product_id ?? ''),
    [rows, setRows] = useState<Selection[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (value?.product_id && value.product_id !== product) setProduct(value.product_id);
  }, [value?.product_id, product]);
  useEffect(() => {
    if (!product) {
      setRows([]);
      return;
    }
    let active = true;
    setRows([]);
    setBusy(true);
    setError('');
    api
      .get<{ selections: Selection[] }>(`${PROCUREMENT}/selections/${encodeURIComponent(product)}`)
      .then((r) => {
        if (!active) return;
        setRows(r.selections);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [product]);
  const chosen = value?.product_id === product ? `${value.scope}:${value.scope_id}` : '';
  return (
    <div className="grid gap-3">
      <Field label={loc('ابحث عن المنتج أو امسح SKU', 'Find product or scan SKU')}>
        <ProductPicker
          value={product}
          onChange={(id) => {
            setProduct(id);
            onChange(null);
          }}
        />
      </Field>
      {busy && <p className={`text-sm ${T.text3}`}>{loc('جاري تحميل الخيارات…', 'Loading selections…')}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {rows.length > 0 && rows[0].product_id === product && (
        <Select
          label={loc('الخيار واللون / النسخة', 'Option and colour / variant')}
          value={chosen}
          onChange={(id) => onChange(rows.find((r) => `${r.scope}:${r.scope_id}` === id) ?? null)}
          empty={loc('حدد المنتج الدقيق', 'Choose exact selection')}
          options={rows.map((r) => ({
            id: `${r.scope}:${r.scope_id}`,
            name: `${r.label}${r.sku ? ` · ${r.sku}` : ''}`,
          }))}
        />
      )}
      {value && (
        <p className={`text-xs ${T.text3}`}>
          {loc('المتاح', 'Available')}: {value.stock === null ? '∞' : value.stock - value.reserved} ·{' '}
          {loc('سعر البيع المرجعي', 'Selling reference')}: {money(value.selling_price_iqd)}
          {value.purchase_unit_iqd !== undefined && (
            <>
              {' '}
              · {loc('تكلفة الشراء المرجعية', 'Purchase reference')}: {money(value.purchase_unit_iqd)} (
              {value.cost_source === 'latest_purchase'
                ? loc('آخر شراء لنفس النسخة', 'Latest purchase')
                : value.cost_source === 'catalogue'
                  ? loc('بطاقة المنتج', 'Catalogue')
                  : loc('غير معروفة', 'Unknown')}
              )
            </>
          )}
        </p>
      )}
    </div>
  );
}
