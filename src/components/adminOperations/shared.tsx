import { useCallback, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import * as T from '../adminProducts/theme';
import { NumberInput } from '../ui/NumberInput';
import type { ProcurementSelectionDefault } from '../../../packages/contracts/src/procurementCost';

export const PROCUREMENT = '/api/admin/procurement',
  STOCK = '/api/admin/stock-operations',
  FINANCE = '/api/admin/finance-operations';
export const today = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
export const money = (v: number | null | undefined) => (v == null ? '—' : `${v.toLocaleString('en-US')} د.ع`);
export interface Named {
  id: string;
  name?: string;
  name_ar?: string;
  name_en?: string;
}
export const nameOf = (v: Named) => v.name_ar || v.name || v.name_en || v.id;
export type Selection = {
  product_id: string;
  scope: 'base' | 'option' | 'color' | 'variant';
  scope_id: string;
  label: string;
  sku: string;
  stock: number | null;
  reserved: number;
  selling_price_iqd: number;
  unit_cost_iqd?: number | null;
  purchase_unit_iqd?: number | null;
  cost_source: string;
  cost_date?: string | null;
  image_url?: string;
  weight_g: number;
  volume_mm3: number;
  packed_weight_g?: number | null;
  packed_volume_mm3?: number | null;
  procurement_defaults?: ProcurementSelectionDefault[];
  procurement_shared_colors?: boolean;
  /** The selection's option (a variant's first option): the minimum profit's level before FX-7. */
  option_id?: string;
  color_id?: string;
};
export function useOperation() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const run = useCallback(async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      if (success) setNotice(success);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return {
    busy,
    error,
    notice,
    run,
    setError,
    feedback: (
      <>
        {error && (
          <p role="alert" className="mb-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-600">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mb-3 rounded-lg bg-green-500/10 p-3 text-sm text-green-600">
            {notice}
          </p>
        )}
      </>
    ),
  };
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-sm">
      <span className={T.text2}>{label}</span>
      {children}
      {hint && <small className={T.text3}>{hint}</small>}
    </label>
  );
}
export function Input({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  min,
  required = false,
  decimals = 6,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  min?: number;
  required?: boolean;
  decimals?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      {type === 'number' ? <NumberInput className={T.input} value={value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)} min={min} decimals={decimals} required={required} onValueChange={(n, ok) => onChange(!ok ? 'NaN' : n == null ? '' : String(n))} /> : <input
        className={T.input}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        step={type === 'number' ? 'any' : undefined}
        required={required}
      />}
    </Field>
  );
}
export function Select({
  label,
  value,
  onChange,
  options,
  empty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
  empty?: string;
}) {
  return (
    <Field label={label}>
      <select className={T.select} value={value} onChange={(e) => onChange(e.target.value)}>
        {empty !== undefined && <option value="">{empty}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={`${T.surface} mb-4 p-4`}>
      <h3 className={`mb-3 font-bold ${T.text1}`}>{title}</h3>
      {children}
    </section>
  );
}
export function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-start text-sm">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className={`border-b border-[var(--ap-border)] px-3 py-2 text-start font-medium ${T.text2}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function Cell({ children }: { children: React.ReactNode }) {
  return <td className={`border-b border-[var(--ap-border)] px-3 py-3 ${T.text1}`}>{children}</td>;
}
export function Tabs({
  value,
  onChange,
  items,
}: {
  value: string;
  onChange: (id: string) => void;
  items: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="tablist">
      {items.map((x) => (
        <button
          type="button"
          role="tab"
          aria-selected={x.id === value}
          key={x.id}
          className={T.chip}
          aria-pressed={x.id === value}
          onClick={() => onChange(x.id)}
        >
          {x.name}
        </button>
      ))}
    </div>
  );
}
export function useLabels() {
  const { loc, dir } = useLanguage();
  return { loc, dir };
}
export { api, T };
