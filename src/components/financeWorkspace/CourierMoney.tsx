import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ExpenseCategory } from '../../lib/api';
import { fetchExpenseCategories } from '../../lib/financeApi';
import { useLanguage } from '../../LanguageContext';
import { Button, Field, Loading, Money, Status, Surface } from './ui';
import { WORKSPACE_API, type CourierOverview, type CourierParcel, type CourierRemittanceDetail, type CourierRemittanceRow } from './types';
import { categoryName } from './expenseKinds';
import { crs } from './courierStrings';

/**
 * «المال والأرباح» → المحاسبة → «أموال لدى شركة التوصيل» (the owner's brief, 2026-11-12, part 3: «money collected by
 * delivery companies but not yet transferred … Track pending, received, and reconciled payments»; DECISIONS row 332;
 * worker/lib/courierCollections.ts).
 *
 * Three figures: the cash still with Al-Zaeem, the same after the estimated fees, and what arrived but is not checked yet.
 * The parcels still with Al-Zaeem, oldest first: ticking them builds a transfer — each with its cash and its fee (the
 * estimate until the owner types the invoice's), the amount that arrived (their cash less their fees until typed), the
 * day, the statement number, the fee category (the last one used) and a note. The owner's rule (2026-11-13): what a
 * delivery company pays is never less than the site's figure — a shortfall holds «سجّل التحويل» until a parcel is
 * corrected; more is fine, and is recorded as lower courier fees. Until the first
 * transfer, the ticked parcels can be recorded instead as the opening balance, forty at a time. The transfers, newest first: each
 * opens its parcels, and «تمت المطابقة» checks it against Al-Zaeem's statement, once. Every write carries an operation id
 * kept for the same request, so a retry is never a second transfer.
 */
/** The server's MAX_REMITTANCE_PARCELS (tests/courierMoneyPage.test.ts holds them equal). */
export const MAX_PARCELS = 40;

const baghdadToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const digits = (v: string) => v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[^\d]/g, '');
const num = (v: string) => (digits(v) === '' ? 0 : Number(digits(v)));
const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

interface Pick { cash: string; fee: string }

export default function CourierMoney({ onOpenOrder, onChanged }: { onOpenOrder: (orderId: string) => void; onChanged: () => void }) {
  const { loc, lang } = useLanguage();
  const [data, setData] = useState<CourierOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Map<string, Pick>>(new Map());
  const [form, setForm] = useState({ amount: '', day: baghdadToday(), reference: '', category: '', note: '' });
  const [amountTyped, setAmountTyped] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const operations = useRef(new Map<string, string>());
  const live = useRef<AbortController | null>(null);

  const read = useCallback(() => {
    live.current?.abort();
    const controller = new AbortController();
    live.current = controller;
    setBusy(true);
    setFailed(false);
    api.get<CourierOverview>(`${WORKSPACE_API}/courier`, { signal: controller.signal })
      .then((r) => { if (controller.signal.aborted) return; setData(r); setForm((f) => (f.category ? f : { ...f, category: r.fee_category?.id ?? '' })); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
  }, []);
  useEffect(() => { read(); return () => live.current?.abort(); }, [read]);
  useEffect(() => { fetchExpenseCategories().then((r) => setCategories((r.categories ?? []).filter((c) => c.active))).catch(() => setCategories([])); }, []);

  const parcels = useMemo(() => data?.pending.parcels ?? [], [data]);
  const lines = parcels.filter((p) => picked.has(p.order_id)).map((p) => ({ parcel: p, cash: num(picked.get(p.order_id)!.cash), fee: num(picked.get(p.order_id)!.fee) }));
  const expected = lines.reduce((n, l) => n + l.cash - l.fee, 0);
  const amount = amountTyped ? num(form.amount) : expected;
  const difference = amount - expected;
  const fees = lines.reduce((n, l) => n + l.fee, 0);

  const toggle = (p: CourierParcel, on: boolean) => setPicked((m) => {
    const next = new Map(m);
    if (on) next.set(p.order_id, { cash: String(p.due_iqd), fee: String(Math.min(p.fee_estimate_iqd, p.due_iqd)) });
    else next.delete(p.order_id);
    return next;
  });
  const toggleAll = (on: boolean) => setPicked(on ? new Map(parcels.map((p) => [p.order_id, { cash: String(p.due_iqd), fee: String(Math.min(p.fee_estimate_iqd, p.due_iqd)) }])) : new Map());
  const edit = (id: string, key: keyof Pick, value: string) => setPicked((m) => { const next = new Map(m); next.set(id, { ...next.get(id)!, [key]: digits(value) }); return next; });

  /** The same request keeps its operation id: a retry after a lost answer is the same transfer, never a second one. */
  const operationFor = (body: object) => {
    const key = JSON.stringify(body);
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    return operations.current.get(key)!;
  };
  const parcelBody = (ls: typeof lines) => ls.map((l) => ({ order_id: l.parcel.order_id, collected_iqd: l.cash, fee_iqd: l.fee }));
  const done = (n: number) => {
    setPicked(new Map());
    setAmountTyped(false);
    setForm((f) => ({ ...f, amount: '', reference: '', note: '' }));
    setMessage(crs(loc, 'recorded', { n }));
    read();
    onChanged();
  };

  const recordTransfer = async () => {
    setError(null); setMessage(null);
    const body = { kind: 'transfer', received_day: form.day, reference: form.reference.trim(), amount_iqd: amount, note: form.note.trim(), category_id: form.category, parcels: parcelBody(lines) };
    setSaving('transfer');
    try {
      await api.post(`${WORKSPACE_API}/courier/remittances`, { ...body, operation_id: operationFor(body) });
      done(lines.length);
    } catch (e) { setError(errorText(e, crs(loc, 'saveFailed'))); } finally { setSaving(null); }
  };
  const recordOpening = async () => {
    setError(null); setMessage(null);
    const chunks: Array<typeof lines> = [];
    for (let i = 0; i < lines.length; i += MAX_PARCELS) chunks.push(lines.slice(i, i + MAX_PARCELS));
    let recorded = 0;
    try {
      for (const chunk of chunks) {
        setSaving(crs(loc, 'openingProgress', { done: recorded, total: lines.length }));
        const body = { kind: 'opening', received_day: baghdadToday(), reference: '', note: '', category_id: form.category, parcels: parcelBody(chunk) };
        await api.post(`${WORKSPACE_API}/courier/remittances`, { ...body, operation_id: operationFor(body) });
        recorded += chunk.length;
      }
      done(recorded);
    } catch (e) {
      setError(errorText(e, crs(loc, 'saveFailed')));
      if (recorded) { read(); onChanged(); }
    } finally { setSaving(null); }
  };

  if (failed) return <Surface title={crs(loc, 'title')} subtitle={crs(loc, 'sub')}><p className="fw-note" role="alert">{crs(loc, 'failed')}</p></Surface>;
  if (!data) return <Surface title={crs(loc, 'title')} subtitle={crs(loc, 'sub')}><Loading text={crs(loc, 'title')} /></Surface>;

  const p = data.pending;
  const tooMany = lines.length > MAX_PARCELS;
  const needsCategory = fees > 0 && !form.category;
  const canTransfer = lines.length > 0 && !tooMany && !needsCategory && difference >= 0 && !saving;

  return <Surface title={crs(loc, 'title')} subtitle={crs(loc, 'sub')} action={<Button variant="ghost" onClick={read} busy={busy}>↻</Button>}>
    <div data-courier-money aria-busy={busy}>
      <div className="fw-metrics fw-courier-metrics">
        <div className="fw-metric" data-courier-due><span>{crs(loc, 'withCourier')}</span><Money value={p.due_iqd} /><small className="fw-muted">{crs(loc, 'withCourierHint', { n: p.count, days: p.oldest_days })}</small></div>
        <div className="fw-metric" data-courier-net><span>{crs(loc, 'afterFees')}</span><Money value={p.net_estimate_iqd} /><small className="fw-muted">{crs(loc, 'afterFeesHint')}</small></div>
        <div className="fw-metric" data-courier-unchecked><span>{crs(loc, 'unchecked')}</span><Money value={data.unreconciled.amount_iqd} /><small className="fw-muted">{crs(loc, 'uncheckedHint', { n: data.unreconciled.count })}</small></div>
      </div>
      <p className="fw-note" data-courier-howto>{crs(loc, data.first_time ? 'firstTime' : 'howTo')}</p>
      {message && <p className="fw-note" role="status" data-courier-message>{message}</p>}
      {error && <div className="fw-error" role="alert" data-courier-error>{error}</div>}

      <h3 className="fw-courier-h">{crs(loc, 'pendingTitle')}</h3>
      {parcels.length === 0 ? <p className="fw-note" data-courier-none>{crs(loc, 'nonePending')}</p>
        : <div className="fw-table-wrap"><table className="fw-table fw-courier-table" data-courier-parcels>
          <thead><tr>
            <th scope="col"><input data-courier-pick-all type="checkbox" aria-label={crs(loc, 'selectAll')} checked={picked.size === parcels.length} onChange={(e) => toggleAll(e.target.checked)} /></th>
            <th scope="col">{crs(loc, 'colOrder')}</th><th scope="col">{crs(loc, 'colCustomer')}</th><th scope="col">{crs(loc, 'colGovernorate')}</th>
            <th scope="col">{crs(loc, 'colDelivered')}</th><th scope="col">{crs(loc, 'colDays')}</th><th scope="col">{crs(loc, 'colCash')}</th>
            <th scope="col">{crs(loc, 'colFee')}</th><th scope="col">{crs(loc, 'colNet')}</th>
          </tr></thead>
          <tbody>{parcels.map((x) => {
            const pick = picked.get(x.order_id);
            const cash = pick ? num(pick.cash) : x.due_iqd, fee = pick ? num(pick.fee) : Math.min(x.fee_estimate_iqd, x.due_iqd);
            return <tr key={x.order_id} data-courier-parcel={x.order_id} aria-selected={!!pick}>
              <td><input data-courier-pick type="checkbox" aria-label={crs(loc, 'selectParcel', { id: x.order_id })} checked={!!pick} onChange={(e) => toggle(x, e.target.checked)} /></td>
              <td dir="ltr"><button type="button" className="fw-link" onClick={() => onOpenOrder(x.order_id)}>{x.order_id}</button></td>
              <td>{x.customer_name ?? ''}</td><td>{x.governorate ?? ''}</td><td dir="ltr">{x.delivered_day ?? ''}</td><td>{x.days}</td>
              <td>{pick ? <input data-courier-cash className="fw-input fw-courier-num" dir="ltr" inputMode="numeric" aria-label={`${crs(loc, 'colCash')} ${x.order_id}`} value={pick.cash} onChange={(e) => edit(x.order_id, 'cash', e.target.value)} /> : <Money value={cash} />}</td>
              <td>{pick ? <input data-courier-fee className="fw-input fw-courier-num" dir="ltr" inputMode="numeric" aria-label={`${crs(loc, 'colFee')} ${x.order_id}`} value={pick.fee} onChange={(e) => edit(x.order_id, 'fee', e.target.value)} /> : <Money value={fee} />}</td>
              <td><Money value={cash - fee} /></td>
            </tr>;
          })}</tbody>
        </table></div>}

      {lines.length > 0 && <div className="fw-courier-form" data-courier-form>
        <p className="fw-courier-sum"><strong>{crs(loc, 'selected', { n: lines.length })}</strong> · {crs(loc, 'expected')}: <Money value={expected} /></p>
        {tooMany && <p className="fw-error" role="alert" data-courier-too-many>{crs(loc, 'tooMany', { max: MAX_PARCELS })}</p>}
        <div className="fw-fields">
          <Field label={crs(loc, 'amount')}><input className="fw-input" dir="ltr" inputMode="numeric" data-courier-amount value={amountTyped ? form.amount : String(expected)}
            onChange={(e) => { setAmountTyped(true); setForm((f) => ({ ...f, amount: digits(e.target.value) })); }} /></Field>
          <Field label={crs(loc, 'day')}><input className="fw-input" dir="ltr" type="date" lang={lang === 'en' ? 'en-GB' : 'ar-IQ'} value={form.day} onChange={(e) => setForm((f) => ({ ...f, day: e.target.value }))} /></Field>
          <Field label={crs(loc, 'reference')}><input className="fw-input" dir="ltr" data-courier-reference value={form.reference} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} /></Field>
          <Field label={crs(loc, 'category')}><select className="fw-select" data-courier-category value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
            <option value="">{crs(loc, 'categoryPick')}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{categoryName(lang, c)}</option>)}
          </select></Field>
        </div>
        {difference !== 0 && <p className="fw-courier-diff" data-courier-difference={difference < 0 ? 'short' : 'surplus'} role={difference < 0 ? 'alert' : undefined}>
          <Status tone={difference < 0 ? 'danger' : 'positive'}>{crs(loc, 'difference')}</Status> <Money value={difference} /> — {crs(loc, difference < 0 ? 'short' : 'surplus')}</p>}
        <Field label={crs(loc, 'note')}><input className="fw-input" data-courier-note value={form.note} maxLength={500} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></Field>
        <div className="fw-courier-actions">
          <Button variant="primary" disabled={!canTransfer} busy={saving === 'transfer'} onClick={recordTransfer} data-courier-record>{crs(loc, 'record')}</Button>
          {data.first_time && <Button variant="secondary" disabled={!!saving || needsCategory} onClick={recordOpening} data-courier-opening>{crs(loc, 'recordOpening')}</Button>}
          {saving && saving !== 'transfer' && <span className="fw-muted" role="status">{saving}</span>}
        </div>
      </div>}

      <h3 className="fw-courier-h">{crs(loc, 'transfersTitle')}</h3>
      {data.remittances.length === 0 ? <p className="fw-note" data-courier-no-transfers>{crs(loc, 'noTransfers')}</p>
        : <div className="fw-table-wrap"><table className="fw-table fw-courier-table" data-courier-transfers>
          <thead><tr>
            <th scope="col">{crs(loc, 'colDay')}</th><th scope="col">{crs(loc, 'colReference')}</th><th scope="col">{crs(loc, 'colParcels')}</th>
            <th scope="col">{crs(loc, 'colCash')}</th><th scope="col">{crs(loc, 'colFees')}</th><th scope="col">{crs(loc, 'colArrived')}</th>
            <th scope="col">{crs(loc, 'difference')}</th><th scope="col">{crs(loc, 'colState')}</th>
          </tr></thead>
          <tbody>{data.remittances.map((r) => <TransferRow key={r.id} r={r} onOpenOrder={onOpenOrder} onChanged={() => { read(); onChanged(); }} />)}</tbody>
        </table></div>}
    </div>
  </Surface>;
}

function TransferRow({ r, onOpenOrder, onChanged }: { r: CourierRemittanceRow; onOpenOrder: (id: string) => void; onChanged: () => void }) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<CourierRemittanceDetail | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const show = () => {
    setOpen((v) => !v);
    if (!detail) api.get<CourierRemittanceDetail>(`${WORKSPACE_API}/courier/remittances/${encodeURIComponent(r.id)}`).then(setDetail).catch(() => setError(crs(loc, 'failed')));
  };
  const reconcile = async () => {
    setBusy(true); setError(null);
    try {
      await api.post(`${WORKSPACE_API}/courier/remittances/${encodeURIComponent(r.id)}/reconcile`, { note: note.trim() });
      setChecking(false);
      onChanged();
    } catch (e) { setError(errorText(e, crs(loc, 'saveFailed'))); } finally { setBusy(false); }
  };
  return <Fragment>
    <tr data-courier-transfer={r.id} data-courier-state={r.state}>
      <td dir="ltr">{r.received_day}</td>
      <td>{r.kind === 'opening' ? crs(loc, 'kindOpening') : <bdi dir="ltr">{r.reference}</bdi>}</td>
      <td><button type="button" className="fw-link" aria-expanded={open} onClick={show}>{r.parcels} · {crs(loc, open ? 'hideParcels' : 'showParcels')}</button></td>
      <td><Money value={r.collected_iqd} /></td><td><Money value={r.fee_iqd} /></td><td><Money value={r.amount_iqd} /></td>
      <td>{r.difference_iqd ? <span title={r.note}><Money value={r.difference_iqd} /></span> : '—'}</td>
      <td>{r.state === 'reconciled'
        ? <span title={r.reconcile_note}><Status tone="positive">{crs(loc, 'stateReconciled')}</Status> <small className="fw-muted">{crs(loc, 'reconciledBy', { name: r.reconciled_by_name ?? '', day: (r.reconciled_at ?? '').slice(0, 10) })}</small></span>
        : <span><Status tone="warning">{crs(loc, 'stateReceived')}</Status> {!checking && <Button variant="ghost" onClick={() => setChecking(true)} data-courier-reconcile>{crs(loc, 'reconcile')}</Button>}</span>}</td>
    </tr>
    {(checking || error) && <tr><td colSpan={8}>
      {error && <div className="fw-error" role="alert">{error}</div>}
      {checking && <div className="fw-courier-check">
        <Field label={crs(loc, 'reconcileNote')}><input className="fw-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} data-courier-reconcile-note /></Field>
        <Button variant="primary" busy={busy} onClick={reconcile} data-courier-reconcile-confirm>{crs(loc, 'reconcileConfirm')}</Button>
        <Button variant="ghost" onClick={() => setChecking(false)}>{crs(loc, 'cancel')}</Button>
      </div>}
    </td></tr>}
    {open && <tr><td colSpan={8}>{!detail ? <Loading text={crs(loc, 'colParcels')} /> : <ul className="fw-rows" data-courier-transfer-parcels>{detail.parcels.map((x) => <li key={x.order_id}><div>
      <span className="fw-rows-a"><button type="button" className="fw-link" dir="ltr" onClick={() => onOpenOrder(x.order_id)}>{x.order_id}</button> {x.customer_name ?? ''}</span>
      <span className="fw-rows-b"><Money value={x.net_iqd} /></span>
      <span className="fw-rows-c"><Money value={x.collected_iqd} /> − <Money value={x.fee_iqd} /></span>
    </div></li>)}</ul>}</td></tr>}
  </Fragment>;
}
