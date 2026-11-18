/**
 * «قيمة الطابعات عند الاستبدال» — THE OWNER'S VALUE TABLE (smart trade-in value, owner 2026-11-18;
 * DECISIONS row 353): every printer model of the printer sections, today's price, the resale share
 * in force and where it came from (the type's, learned from real resales, or the owner's), and what
 * the system offers at 3 / 6 / 12 / 24 months in good condition — every figure the SERVER's
 * (GET /value-table, a cost read). The owner sets a model's share and its newer model
 * (PUT /model-profiles/:id) and each type's knobs (PUT /smart-params/:family). Nothing is computed here.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { FAMILY_LABELS, type TradeInFamily } from '../../../packages/pricing/src/tradeIn';
import { useA } from './useA';
import type { AdminKey } from './copy';

interface Row {
  product_id: string;
  name: string;
  name_ar: string;
  family: TradeInFamily;
  status: string;
  now_iqd: number | null;
  resale: { resale_bp: number; source: 'family' | 'learned' | 'owner'; learned_bp: number; samples: number; superseded: boolean };
  profile: { resale_bp: number | null; successor_product_id: string | null; superseded_bp: number | null; value_off_sale: number } | null;
  offers: Array<{ months: number; offer_iqd: number | null }>;
}
type Knobs = { hours_allowance_per_month: number; last_price_decay_bp: number; last_price_max_decay_bp: number; superseded_bp: number; learn_weight: number };
type Table = { rows: Row[]; smart: Record<TradeInFamily, Knobs>; months: number[] };

const FAMILIES: TradeInFamily[] = ['fdm', 'resin', 'laser'];
/** The knobs are also the AMS's: an AMS-only part of a model no longer sold decays by its own. */
const KNOB_FAMILIES: TradeInFamily[] = ['fdm', 'resin', 'laser', 'ams'];
const KNOBS: Array<[keyof Knobs, AdminKey, 'bp' | 'n']> = [
  ['hours_allowance_per_month', 'vt.k.hours', 'n'],
  ['last_price_decay_bp', 'vt.k.decay', 'bp'],
  ['last_price_max_decay_bp', 'vt.k.maxDecay', 'bp'],
  ['superseded_bp', 'vt.k.superseded', 'bp'],
  ['learn_weight', 'vt.k.learn', 'n'],
];

/** Basis points shown as a percent (a display of the server's figure, not a computation of money). */
const pct = (bp: number) => (bp / 100).toLocaleString('en', { maximumFractionDigits: 2 });
const toBp = (text: string): number | null => {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

export default function ValueTable() {
  const { a, money, lang, loc } = useA();
  const [table, setTable] = useState<Table | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ resale: '', successor: '', superseded: '', offSale: false });
  const [knobs, setKnobs] = useState<Record<string, string>>({});
  const [knobsSaved, setKnobsSaved] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api
      .get<Table>('/api/admin/trade-in/value-table')
      .then((d) => {
        setTable(d);
        const shown = Object.fromEntries(
          KNOB_FAMILIES.flatMap((f) => KNOBS.map(([k, , kind]) => [`${f}.${k}`, kind === 'bp' ? pct(d.smart[f][k]) : String(d.smart[f][k])]))
        );
        setKnobs(shown);
        setKnobsSaved(shown);
      })
      .catch((e) => setError(apiRefusal(e, refusalLang(lang), a('loadError'))));
  }, [lang, a]);
  useEffect(load, [load]);

  const nameOf = useCallback((r: Pick<Row, 'name' | 'name_ar'>) => (lang === 'en' ? r.name || r.name_ar : r.name_ar || r.name), [lang]);
  const byFamily = useMemo(() => FAMILIES.map((f) => [f, (table?.rows ?? []).filter((r) => r.family === f)] as const).filter(([, rows]) => rows.length > 0), [table]);

  const startEdit = (r: Row) => {
    setEditing(r.product_id);
    setForm({
      resale: r.profile?.resale_bp != null ? pct(r.profile.resale_bp) : '',
      successor: r.profile?.successor_product_id ?? '',
      superseded: r.profile?.superseded_bp != null ? pct(r.profile.superseded_bp) : '',
      offSale: r.profile?.value_off_sale === 1,
    });
  };

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await f();
      load();
    } catch (e) {
      setError(apiRefusal(e, refusalLang(lang), a('failed')));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = (id: string) =>
    run(async () => {
      const resale = toBp(form.resale);
      const superseded = toBp(form.superseded);
      if (Number.isNaN(resale) || Number.isNaN(superseded)) throw new Error(a('failed'));
      await api.put(`/api/admin/trade-in/model-profiles/${encodeURIComponent(id)}`, {
        resale_bp: resale,
        successor_product_id: form.successor || null,
        superseded_bp: superseded,
        value_off_sale: form.offSale,
      });
      setEditing(null);
    });

  const saveKnobs = (f: TradeInFamily) =>
    run(async () => {
      // Only the fields the owner changed: an untouched one keeps following the code default.
      const body: Record<string, number | null> = {};
      for (const [k, , kind] of KNOBS) {
        const raw = knobs[`${f}.${k}`] ?? '';
        if (raw === (knobsSaved[`${f}.${k}`] ?? '')) continue;
        const v = kind === 'bp' ? toBp(raw) : raw.trim() === '' ? null : Number(raw);
        if (v !== null && !Number.isSafeInteger(v)) throw new Error(a('failed'));
        body[k] = v;
      }
      await api.put(`/api/admin/trade-in/smart-params/${f}`, body);
    });

  const sourceText = (r: Row) =>
    r.resale.source === 'owner' ? a('vt.src.owner') : r.resale.source === 'learned' ? a('vt.src.learned', { n: r.resale.samples }) : a('vt.src.family');

  return (
    <section className={`${T.surface} space-y-4 p-4`} data-trade-in-value-table>
      <div>
        <h3 className="text-[15px] font-bold">{a('vt.title')}</h3>
        <p className={`mt-1 text-[12.5px] leading-5 ${T.text3}`}>{a('vt.sub')}</p>
        <p className={`mt-1 text-[12px] leading-5 ${T.text3}`}>{a('vt.note')}</p>
      </div>
      {error ? (
        <p className="text-[12.5px] text-[var(--ap-danger)]" role="alert">
          {error}
        </p>
      ) : null}
      {!table ? (
        !error ? <p className={`text-[12.5px] ${T.text3}`}>{a('loading')}</p> : null
      ) : byFamily.length === 0 ? (
        <p className={`text-[12.5px] ${T.text3}`}>{a('vt.empty')}</p>
      ) : (
        byFamily.map(([family, rows]) => (
          <div key={family} className="space-y-2" data-value-family={family}>
            <h4 className="text-[13px] font-bold">{loc(FAMILY_LABELS[family].ar, FAMILY_LABELS[family].en, FAMILY_LABELS[family].ckb)}</h4>
            <div className="overflow-x-auto rounded-[var(--ap-radius-md)] border border-[var(--ap-border)]">
              <table className="w-full min-w-[640px] text-[12.5px]">
                <thead className={`bg-[var(--ap-surface-2)] ${T.text3}`}>
                  <tr>
                    <th className="px-3 py-2 text-start font-semibold">{a('vt.model')}</th>
                    <th className="px-3 py-2 text-end font-semibold">{a('vt.now')}</th>
                    <th className="px-3 py-2 text-start font-semibold">{a('vt.resale')}</th>
                    {table.months.map((m) => (
                      <th key={m} className="px-3 py-2 text-end font-semibold">
                        {a('vt.months', { n: m })}
                      </th>
                    ))}
                    <th className="px-3 py-2">
                      <span className="sr-only">{a('vt.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <React.Fragment key={r.product_id}>
                      <tr className="border-t border-[var(--ap-border)]" data-value-row={r.product_id}>
                        <td className="px-3 py-2">
                          <span className="block font-semibold">{nameOf(r)}</span>
                          {r.now_iqd === null ? <span className={`text-[11px] ${T.text3}`}>{a('vt.notOnSale')}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-end tabular-nums">{money(r.now_iqd)}</td>
                        <td className="px-3 py-2">
                          <span className="tabular-nums font-semibold">{pct(r.resale.resale_bp)}%</span>
                          <span className={`block text-[11px] ${T.text3}`}>{sourceText(r)}</span>
                          {r.resale.superseded ? <span className="block text-[11px] text-[var(--ap-warning)]">{a('vt.superseded')}</span> : null}
                          {r.profile?.value_off_sale === 1 ? <span className={`block text-[11px] ${T.text3}`}>{a('vt.offSaleOn')}</span> : null}
                        </td>
                        {r.offers.map((o) => (
                          <td key={o.months} className="px-3 py-2 text-end tabular-nums" data-value-offer={o.months}>
                            {money(o.offer_iqd)}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-end">
                          <button
                            type="button"
                            className={T.btnGhostSm}
                            aria-expanded={editing === r.product_id}
                            aria-label={editing === r.product_id ? a('vt.cancel') : a('vt.editModel', { name: nameOf(r) })}
                            onClick={() => (editing === r.product_id ? setEditing(null) : startEdit(r))}
                            data-value-edit
                          >
                            {editing === r.product_id ? a('vt.cancel') : a('vt.edit')}
                          </button>
                        </td>
                      </tr>
                      {editing === r.product_id ? (
                        <tr className="bg-[var(--ap-surface-2)]">
                          <td colSpan={4 + table.months.length} className="px-3 py-3">
                            {/* Held inside the visible width while the table scrolls sideways (a phone). */}
                            <div className="sticky start-3 max-w-[calc(100vw-4rem)] lg:max-w-none">
                            <div className="grid gap-3 lg:grid-cols-3">
                              <label className="block min-w-0">
                                <span className={`mb-1 block text-[11.5px] ${T.text3}`}>{a('vt.resaleInput')}</span>
                                <input
                                  className={`${T.input} w-full tabular-nums`}
                                  dir="ltr"
                                  inputMode="decimal"
                                  value={form.resale}
                                  placeholder={pct(r.resale.learned_bp)}
                                  onChange={(e) => setForm({ ...form, resale: e.target.value })}
                                />
                              </label>
                              <label className="block min-w-0">
                                <span className={`mb-1 block text-[11.5px] ${T.text3}`}>{a('vt.successor')}</span>
                                <select className={`${T.select} w-full`} value={form.successor} onChange={(e) => setForm({ ...form, successor: e.target.value })}>
                                  <option value="">{a('vt.none')}</option>
                                  {form.successor && !table.rows.some((x) => x.product_id === form.successor) ? (
                                    <option value={form.successor}>{a('vt.otherProduct', { id: form.successor })}</option>
                                  ) : null}
                                  {(table.rows ?? [])
                                    .filter((x) => x.product_id !== r.product_id)
                                    .map((x) => (
                                      <option key={x.product_id} value={x.product_id}>
                                        {nameOf(x)}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <label className="block min-w-0">
                                <span className={`mb-1 block text-[11.5px] ${T.text3}`}>{a('vt.supersededInput')}</span>
                                <input
                                  className={`${T.input} w-full tabular-nums`}
                                  dir="ltr"
                                  inputMode="decimal"
                                  value={form.superseded}
                                  onChange={(e) => setForm({ ...form, superseded: e.target.value })}
                                />
                              </label>
                            </div>
                            <label className="mt-3 flex items-start gap-2 text-[12.5px]">
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 accent-[var(--ap-accent)]"
                                checked={form.offSale}
                                onChange={(e) => setForm({ ...form, offSale: e.target.checked })}
                                data-value-off-sale
                              />
                              {a('vt.offSale')}
                            </label>
                            <div className="mt-3 flex gap-2">
                              <button type="button" className={T.btnPrimary} disabled={busy} onClick={() => void saveProfile(r.product_id)} data-value-save>
                                {a('save')}
                              </button>
                            </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {table ? (
        <details className="rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-3" data-value-knobs>
          <summary className="cursor-pointer text-[13px] font-bold">{a('vt.knobs')}</summary>
          <div className="mt-3 space-y-4">
            {KNOB_FAMILIES.map((f) => (
              <div key={f} className="space-y-2">
                <p className="text-[12.5px] font-semibold">{loc(FAMILY_LABELS[f].ar, FAMILY_LABELS[f].en, FAMILY_LABELS[f].ckb)}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {KNOBS.map(([k, label]) => (
                    <label key={k} className="block min-w-0">
                      <span className={`mb-1 block text-[11px] leading-4 ${T.text3}`}>{a(label)}</span>
                      <input
                        className={`${T.input} w-full tabular-nums`}
                        dir="ltr"
                        inputMode="decimal"
                        value={knobs[`${f}.${k}`] ?? ''}
                        onChange={(e) => setKnobs({ ...knobs, [`${f}.${k}`]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <button type="button" className={T.btnSecondary} disabled={busy} onClick={() => void saveKnobs(f)} data-value-knobs-save={f}>
                  {a('save')}
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
