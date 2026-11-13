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
 * The parcels still with Al-Zaeem, oldest first, grouped by delivery day — a day's box ticks its parcels, a search narrows
 * the list, and «من يوم / إلى يوم» ticks a transfer's days in one go (DECISIONS row 335); the transfer panel sits beside the
 * list, in view while the owner ticks, and on a phone each parcel is a card. Ticking parcels builds a transfer — each with its cash and its fee (the
 * estimate until the owner types the invoice's), the amount that arrived (their cash less their fees until typed), the
 * day, the statement number, the fee category (the last one used) and a note. The owner's rule (2026-11-13): what a
 * delivery company pays is never less than the site's figure — a shortfall holds «سجّل التحويل» until a parcel is
 * corrected; more is fine, and is recorded as lower courier fees. Until the first
 * transfer, the ticked parcels can be recorded instead as the opening balance, forty at a time. The transfers, newest first: each
 * opens its parcels, and «تمت المطابقة» checks it against Al-Zaeem's statement, once. Every write carries an operation id
 * kept for the same request, so a retry is never a second transfer.
 *
 * THE SECOND ROUND (DECISIONS row 338). Prepaid parcels — paid before delivery, no cash at the door — wait below the list
 * for their fee: ticked by hand (never by the day range, which ticks only parcels with cash), each with its fee, they go
 * with the transfer and lower what should arrive by their fees. A transfer not yet checked has «تراجع»: with a reason it
 * is taken back — its parcels return to the list — and it stays in the list as undone.
 */
/** The server's MAX_REMITTANCE_PARCELS (tests/courierMoneyPage.test.ts holds them equal). */
export const MAX_PARCELS = 40;

const baghdadToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const digits = (v: string) => v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[^\d]/g, '');
const num = (v: string) => (digits(v) === '' ? 0 : Number(digits(v)));
const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
/** The search: the order, customer, governorate or tracking number holds it. */
const matches = (x: CourierParcel, q: string) => [x.order_id, x.customer_name, x.governorate, x.tracking_no].some((v) => String(v ?? '').toLowerCase().includes(q));

interface Pick { cash: string; fee: string }

export default function CourierMoney({ onOpenOrder, onChanged }: { onOpenOrder: (orderId: string) => void; onChanged: () => void }) {
  const { loc, lang } = useLanguage();
  const [data, setData] = useState<CourierOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Map<string, Pick>>(new Map());
  /** The prepaid parcels ticked, each with its fee as typed. */
  const [fees, setFees] = useState<Map<string, string>>(new Map());
  const [showPrepaid, setShowPrepaid] = useState(false);
  const [form, setForm] = useState({ amount: '', day: baghdadToday(), reference: '', category: '', note: '' });
  const [amountTyped, setAmountTyped] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [query, setQuery] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
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
  const prepaid = useMemo(() => data?.prepaid?.parcels ?? [], [data]);
  const lines = parcels.filter((p) => picked.has(p.order_id)).map((p) => ({ parcel: p, cash: num(picked.get(p.order_id)!.cash), fee: num(picked.get(p.order_id)!.fee) }));
  const feeLines = prepaid.filter((p) => fees.has(p.order_id)).map((p) => ({ parcel: p, fee: num(fees.get(p.order_id)!) }));
  const prepaidFees = feeLines.reduce((n, l) => n + l.fee, 0);
  /** What should arrive: the ticked parcels' cash less their fees, less the ticked prepaid parcels' fees. */
  const expected = lines.reduce((n, l) => n + l.cash - l.fee, 0) - prepaidFees;
  const amount = amountTyped ? num(form.amount) : Math.max(0, expected);
  const difference = amount - expected;
  const feeTotal = lines.reduce((n, l) => n + l.fee, 0) + prepaidFees;

  /** What the lists show: every parcel, or those whose order, customer, governorate or tracking number holds the search. */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? parcels.filter((x) => matches(x, q)) : parcels;
  }, [parcels, query]);
  const shownPrepaid = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? prepaid.filter((x) => matches(x, q)) : prepaid;
  }, [prepaid, query]);
  /** The shown parcels by delivery day, oldest day first (the server sends them oldest first). */
  const days = useMemo(() => {
    const m = new Map<string, CourierParcel[]>();
    for (const x of shown) { const d = x.delivered_day ?? ''; m.set(d, [...(m.get(d) ?? []), x]); }
    return [...m.entries()];
  }, [shown]);
  const toggleMany = (list: CourierParcel[], on: boolean) => setPicked((m) => {
    const next = new Map(m);
    for (const p of list) {
      if (!on) next.delete(p.order_id);
      else if (!next.has(p.order_id)) next.set(p.order_id, { cash: String(p.due_iqd), fee: String(Math.min(p.fee_estimate_iqd, p.due_iqd)) });
    }
    return next;
  });
  const toggle = (p: CourierParcel, on: boolean) => toggleMany([p], on);
  const toggleAll = (on: boolean) => toggleMany(shown, on);
  /** «من يوم / إلى يوم»: ticks every parcel with cash delivered on those days (either end may be open), whatever the search shows. */
  const pickRange = () => toggleMany(parcels.filter((x) => {
    const d = x.delivered_day ?? '';
    return d !== '' && (!range.from || d >= range.from) && (!range.to || d <= range.to);
  }), true);
  const edit = (id: string, key: keyof Pick, value: string) => setPicked((m) => { const next = new Map(m); next.set(id, { ...next.get(id)!, [key]: digits(value) }); return next; });
  const toggleFees = (list: CourierParcel[], on: boolean) => setFees((m) => {
    const next = new Map(m);
    for (const p of list) {
      if (!on) next.delete(p.order_id);
      else if (!next.has(p.order_id)) next.set(p.order_id, String(p.fee_estimate_iqd));
    }
    return next;
  });
  const editFee = (id: string, value: string) => setFees((m) => { const next = new Map(m); next.set(id, digits(value)); return next; });

  /** The same request keeps its operation id: a retry after a lost answer is the same transfer, never a second one. */
  const operationFor = (body: object) => {
    const key = JSON.stringify(body);
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    return operations.current.get(key)!;
  };
  const parcelBody = (ls: typeof lines) => ls.map((l) => ({ order_id: l.parcel.order_id, collected_iqd: l.cash, fee_iqd: l.fee }));
  /** Prepaid parcels' fees, sent only when there are some: a transfer without them keeps the first round's request. */
  const feeBody = (ls: typeof feeLines) => (ls.length ? { fees: ls.map((l) => ({ order_id: l.parcel.order_id, fee_iqd: l.fee })) } : {});
  const clear = () => {
    setPicked(new Map());
    setFees(new Map());
    setAmountTyped(false);
    setForm((f) => ({ ...f, amount: '', reference: '', note: '' }));
    // An answered request's id is never sent again: the same parcels recorded after an undo are a new transfer.
    operations.current.clear();
  };
  const done = (n: number) => {
    clear();
    setMessage(crs(loc, 'recorded', { n }));
    read();
    onChanged();
  };
  /** A transfer was undone: its parcels come back unticked; a selection being built for another transfer stays. */
  const undone = () => {
    operations.current.clear();
    setError(null);
    setMessage(crs(loc, 'undoneMsg'));
    read();
    onChanged();
  };

  const recordTransfer = async () => {
    setError(null); setMessage(null);
    const body = { kind: 'transfer', received_day: form.day, reference: form.reference.trim(), amount_iqd: amount, note: form.note.trim(), category_id: form.category, parcels: parcelBody(lines), ...feeBody(feeLines) };
    setSaving('transfer');
    try {
      await api.post(`${WORKSPACE_API}/courier/remittances`, { ...body, operation_id: operationFor(body) });
      done(lines.length + feeLines.length);
    } catch (e) { setError(errorText(e, crs(loc, 'saveFailed'))); } finally { setSaving(null); }
  };
  const recordOpening = async () => {
    setError(null); setMessage(null);
    // Forty lines a request; the prepaid parcels' fees go with the first, which carries parcels with cash too.
    if (!lines.length || feeLines.length >= MAX_PARCELS) return;
    const chunks: Array<{ cash: typeof lines; fees: typeof feeLines }> = [];
    for (let i = 0; i < lines.length;) {
      const room = chunks.length ? MAX_PARCELS : MAX_PARCELS - feeLines.length;
      chunks.push({ cash: lines.slice(i, i + room), fees: chunks.length ? [] : feeLines });
      i += room;
    }
    const total = lines.length + feeLines.length;
    let recorded = 0;
    try {
      for (const chunk of chunks) {
        setSaving(crs(loc, 'openingProgress', { done: recorded, total }));
        const body = { kind: 'opening', received_day: baghdadToday(), reference: '', note: '', category_id: form.category, parcels: parcelBody(chunk.cash), ...feeBody(chunk.fees) };
        await api.post(`${WORKSPACE_API}/courier/remittances`, { ...body, operation_id: operationFor(body) });
        recorded += chunk.cash.length + chunk.fees.length;
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
  const count = lines.length + feeLines.length;
  const tooMany = count > MAX_PARCELS;
  const needsCategory = feeTotal > 0 && !form.category;
  const needsCash = feeLines.length > 0 && lines.length === 0;
  const feesExceed = expected < 0;
  const canTransfer = lines.length > 0 && !tooMany && !needsCategory && !feesExceed && difference >= 0 && !saving;
  const canOpen = lines.length > 0 && feeLines.length < MAX_PARCELS && !needsCategory && !feesExceed && !saving;

  return <Surface title={crs(loc, 'title')} subtitle={crs(loc, 'sub')} action={<Button variant="ghost" onClick={read} busy={busy}>↻</Button>}>
    <div data-courier-money aria-busy={busy}>
      <div className="fw-metrics fw-courier-metrics">
        <div className="fw-metric" data-courier-due><span>{crs(loc, 'withCourier')}</span><Money value={p.due_iqd} /><small className="fw-muted">{crs(loc, 'withCourierHint', { n: p.count, days: p.oldest_days })}</small></div>
        <div className="fw-metric" data-courier-net><span>{crs(loc, 'afterFees')}</span><Money value={p.net_estimate_iqd} /><small className="fw-muted">{crs(loc, 'afterFeesHint')}</small></div>
        <div className="fw-metric" data-courier-unchecked><span>{crs(loc, 'unchecked')}</span><Money value={data.unreconciled.amount_iqd} /><small className="fw-muted">{crs(loc, 'uncheckedHint', { n: data.unreconciled.count })}</small></div>
      </div>
      <p className="fw-note" data-courier-howto>{crs(loc, data.first_time ? 'firstTime' : 'howTo')}</p>
      {data.first_time && prepaid.length > 0 && <p className="fw-note" data-courier-first-prepaid>{crs(loc, 'firstTimePrepaid')}</p>}
      {message && <p className="fw-note" role="status" data-courier-message>{message}</p>}
      {error && <div className="fw-error" role="alert" data-courier-error>{error}</div>}

      <div className="fw-courier-layout">
      <section className="fw-courier-list" aria-labelledby="fw-courier-pending">
      <h3 id="fw-courier-pending" className="fw-courier-h">{crs(loc, 'pendingTitle')}</h3>
      {parcels.length === 0 ? <p className="fw-note" data-courier-none>{crs(loc, 'nonePending')}</p>
        : <>
        <div className="fw-courier-tools" data-courier-tools>
          <input className="fw-input fw-courier-search" type="search" value={query} placeholder={crs(loc, 'search')} aria-label={crs(loc, 'search')} onChange={(e) => setQuery(e.target.value)} data-courier-search />
          <label className="fw-courier-range">{crs(loc, 'rangeFrom')}<input className="fw-input" type="date" dir="ltr" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} data-courier-from /></label>
          <label className="fw-courier-range">{crs(loc, 'rangeTo')}<input className="fw-input" type="date" dir="ltr" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} data-courier-to /></label>
          <Button variant="secondary" disabled={!range.from && !range.to} onClick={pickRange} data-courier-pick-range>{crs(loc, 'selectRange')}</Button>
          {(picked.size > 0 || fees.size > 0) && <Button variant="ghost" onClick={() => { setPicked(new Map()); setFees(new Map()); }} data-courier-clear>{crs(loc, 'clearSelection')}</Button>}
        </div>
        {shown.length === 0 ? <p className="fw-note" data-courier-no-match>{crs(loc, 'noMatch')}</p>
        : <div className="fw-table-wrap"><table className="fw-table fw-courier-table" data-courier-parcels>
          <thead><tr>
            <th scope="col"><input data-courier-pick-all type="checkbox" aria-label={crs(loc, 'selectAll')} checked={shown.every((x) => picked.has(x.order_id))} onChange={(e) => toggleAll(e.target.checked)} /></th>
            <th scope="col">{crs(loc, 'colOrder')}</th><th scope="col">{crs(loc, 'colCustomer')}</th><th scope="col">{crs(loc, 'colGovernorate')}</th>
            <th scope="col">{crs(loc, 'colDelivered')}</th><th scope="col">{crs(loc, 'colDays')}</th><th scope="col">{crs(loc, 'colCash')}</th>
            <th scope="col">{crs(loc, 'colFee')}</th><th scope="col">{crs(loc, 'colNet')}</th>
          </tr></thead>
          <tbody>{days.map(([day, list]) => <Fragment key={day}>
            <tr className="fw-courier-day" data-courier-day={day}><th colSpan={9} scope="rowgroup"><label>
              <input data-courier-pick-day type="checkbox" aria-label={crs(loc, 'pickDay', { day })} checked={list.every((x) => picked.has(x.order_id))} onChange={(e) => toggleMany(list, e.target.checked)} />
              <bdi dir="ltr">{day}</bdi><span className="fw-muted">{crs(loc, 'dayCount', { n: list.length })} · <Money value={list.reduce((n, x) => n + x.due_iqd, 0)} /></span>
            </label></th></tr>
            {list.map((x) => {
            const pick = picked.get(x.order_id);
            const cash = pick ? num(pick.cash) : x.due_iqd, fee = pick ? num(pick.fee) : Math.min(x.fee_estimate_iqd, x.due_iqd);
            return <tr key={x.order_id} data-courier-parcel={x.order_id} aria-selected={!!pick}>
              <td><input data-courier-pick type="checkbox" aria-label={crs(loc, 'selectParcel', { id: x.order_id })} checked={!!pick} onChange={(e) => toggle(x, e.target.checked)} /></td>
              <td dir="ltr" data-label={crs(loc, 'colOrder')}><button type="button" className="fw-link" onClick={() => onOpenOrder(x.order_id)}>{x.order_id}</button></td>
              <td data-label={crs(loc, 'colCustomer')}>{x.customer_name ?? ''}</td><td data-label={crs(loc, 'colGovernorate')}>{x.governorate ?? ''}</td>
              <td dir="ltr" data-label={crs(loc, 'colDelivered')}>{x.delivered_day ?? ''}</td><td data-label={crs(loc, 'colDays')}>{x.days}</td>
              <td data-label={crs(loc, 'colCash')}>{pick ? <input data-courier-cash className="fw-input fw-courier-num" dir="ltr" inputMode="numeric" aria-label={`${crs(loc, 'colCash')} ${x.order_id}`} value={pick.cash} onChange={(e) => edit(x.order_id, 'cash', e.target.value)} /> : <Money value={cash} />}</td>
              <td data-label={crs(loc, 'colFee')}>{pick ? <input data-courier-fee className="fw-input fw-courier-num" dir="ltr" inputMode="numeric" aria-label={`${crs(loc, 'colFee')} ${x.order_id}`} value={pick.fee} onChange={(e) => edit(x.order_id, 'fee', e.target.value)} /> : <Money value={fee} />}</td>
              <td data-label={crs(loc, 'colNet')}><Money value={cash - fee} /></td>
            </tr>;
          })}</Fragment>)}</tbody>
        </table></div>}
        </>}

      {prepaid.length > 0 && <div className="fw-courier-prepaid" data-courier-prepaid>
        <h3 className="fw-courier-h"><button type="button" className="fw-link" aria-expanded={showPrepaid} onClick={() => setShowPrepaid((v) => !v)} data-courier-prepaid-toggle>
          {crs(loc, 'prepaidTitle', { n: data.prepaid.more ? `${prepaid.length}+` : prepaid.length })}</button>
          {fees.size > 0 && <span className="fw-muted"> · {crs(loc, 'prepaidPicked', { n: fees.size })}</span>}</h3>
        {showPrepaid && <>
          <p className="fw-note">{crs(loc, 'prepaidHint')}</p>
          {shownPrepaid.length === 0 ? <p className="fw-note">{crs(loc, 'noMatch')}</p>
          : <div className="fw-table-wrap"><table className="fw-table fw-courier-table" data-courier-prepaid-parcels>
            <thead><tr>
              <th scope="col"><input data-courier-prepaid-pick-all type="checkbox" aria-label={crs(loc, 'selectAllPrepaid')} checked={shownPrepaid.every((x) => fees.has(x.order_id))} onChange={(e) => toggleFees(shownPrepaid, e.target.checked)} /></th>
              <th scope="col">{crs(loc, 'colOrder')}</th><th scope="col">{crs(loc, 'colCustomer')}</th><th scope="col">{crs(loc, 'colGovernorate')}</th>
              <th scope="col">{crs(loc, 'colDelivered')}</th><th scope="col">{crs(loc, 'colFee')}</th>
            </tr></thead>
            <tbody>{shownPrepaid.map((x) => {
              const fee = fees.get(x.order_id);
              return <tr key={x.order_id} data-courier-parcel={x.order_id} data-courier-prepaid-parcel aria-selected={fee !== undefined}>
                <td><input data-courier-prepaid-pick type="checkbox" aria-label={crs(loc, 'selectParcel', { id: x.order_id })} checked={fee !== undefined} onChange={(e) => toggleFees([x], e.target.checked)} /></td>
                <td dir="ltr" data-label={crs(loc, 'colOrder')}><button type="button" className="fw-link" onClick={() => onOpenOrder(x.order_id)}>{x.order_id}</button></td>
                <td data-label={crs(loc, 'colCustomer')}>{x.customer_name ?? ''}</td><td data-label={crs(loc, 'colGovernorate')}>{x.governorate ?? ''}</td>
                <td dir="ltr" data-label={crs(loc, 'colDelivered')}>{x.delivered_day ?? ''}</td>
                <td data-label={crs(loc, 'colFee')}>{fee !== undefined ? <input data-courier-prepaid-fee className="fw-input fw-courier-num" dir="ltr" inputMode="numeric" aria-label={`${crs(loc, 'colFee')} ${x.order_id}`} value={fee} onChange={(e) => editFee(x.order_id, e.target.value)} /> : <Money value={x.fee_estimate_iqd} />}</td>
              </tr>;
            })}</tbody>
          </table></div>}
        </>}
      </div>}
      </section>

      <aside className="fw-courier-panel" aria-label={crs(loc, 'panelTitle')}>
      <h3 className="fw-courier-h">{crs(loc, 'panelTitle')}</h3>
      {count === 0 ? <p className="fw-note" data-courier-panel-empty>{crs(loc, 'noneSelected')}</p> : <div className="fw-courier-form" data-courier-form>
        <p className="fw-courier-sum"><strong>{crs(loc, 'selected', { n: lines.length })}</strong>
          {feeLines.length > 0 && <span data-courier-prepaid-sum> · {crs(loc, 'selectedPrepaid', { n: feeLines.length })} <Money value={-prepaidFees} /></span>}
          {' · '}{crs(loc, 'expected')}: <Money value={expected} /></p>
        {tooMany && <p className="fw-error" role="alert" data-courier-too-many>{crs(loc, 'tooMany', { max: MAX_PARCELS })}</p>}
        {needsCash && <p className="fw-note" role="status" data-courier-needs-cash>{crs(loc, 'needsCash')}</p>}
        {feesExceed && <p className="fw-error" role="alert" data-courier-fees-exceed>{crs(loc, 'feesExceed')}</p>}
        <div className="fw-fields">
          <Field label={crs(loc, 'amount')}><input className="fw-input" dir="ltr" inputMode="numeric" data-courier-amount value={amountTyped ? form.amount : String(Math.max(0, expected))}
            onChange={(e) => { setAmountTyped(true); setForm((f) => ({ ...f, amount: digits(e.target.value) })); }} /></Field>
          <Field label={crs(loc, 'day')}><input className="fw-input" dir="ltr" type="date" lang={lang === 'en' ? 'en-GB' : 'ar-IQ'} value={form.day} onChange={(e) => setForm((f) => ({ ...f, day: e.target.value }))} /></Field>
          <Field label={crs(loc, 'reference')}><input className="fw-input" dir="ltr" data-courier-reference value={form.reference} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} /></Field>
          <Field label={crs(loc, 'category')}><select className="fw-select" data-courier-category value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
            <option value="">{crs(loc, 'categoryPick')}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{categoryName(lang, c)}</option>)}
          </select></Field>
        </div>
        {difference !== 0 && !feesExceed && <p className="fw-courier-diff" data-courier-difference={difference < 0 ? 'short' : 'surplus'} role={difference < 0 ? 'alert' : undefined}>
          <Status tone={difference < 0 ? 'danger' : 'positive'}>{crs(loc, 'difference')}</Status> <Money value={difference} /> — {crs(loc, difference < 0 ? 'short' : 'surplus')}</p>}
        <Field label={crs(loc, 'note')}><input className="fw-input" data-courier-note value={form.note} maxLength={500} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></Field>
        <div className="fw-courier-actions">
          <Button variant="primary" disabled={!canTransfer} busy={saving === 'transfer'} onClick={recordTransfer} data-courier-record>{crs(loc, 'record')}</Button>
          {data.first_time && <Button variant="secondary" disabled={!canOpen} onClick={recordOpening} data-courier-opening>{crs(loc, 'recordOpening')}</Button>}
          {saving && saving !== 'transfer' && <span className="fw-muted" role="status">{saving}</span>}
        </div>
      </div>}
      </aside>
      </div>

      <h3 className="fw-courier-h">{crs(loc, 'transfersTitle')}</h3>
      {data.remittances.length === 0 ? <p className="fw-note" data-courier-no-transfers>{crs(loc, 'noTransfers')}</p>
        : <div className="fw-table-wrap"><table className="fw-table fw-courier-table" data-courier-transfers>
          <thead><tr>
            <th scope="col">{crs(loc, 'colDay')}</th><th scope="col">{crs(loc, 'colReference')}</th><th scope="col">{crs(loc, 'colParcels')}</th>
            <th scope="col">{crs(loc, 'colCash')}</th><th scope="col">{crs(loc, 'colFees')}</th><th scope="col">{crs(loc, 'colArrived')}</th>
            <th scope="col">{crs(loc, 'difference')}</th><th scope="col">{crs(loc, 'colState')}</th>
          </tr></thead>
          <tbody>{data.remittances.map((r) => <TransferRow key={r.id} r={r} canUndo={data.undo} onOpenOrder={onOpenOrder} onChanged={() => { read(); onChanged(); }} onUndone={undone} />)}</tbody>
        </table></div>}
    </div>
  </Surface>;
}

function TransferRow({ r, canUndo, onOpenOrder, onChanged, onUndone }: { r: CourierRemittanceRow; canUndo: boolean; onOpenOrder: (id: string) => void; onChanged: () => void; onUndone: () => void }) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<CourierRemittanceDetail | null>(null);
  /** The form open under the row: the check against the courier's statement, or the undo with its reason. */
  const [mode, setMode] = useState<'check' | 'undo' | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undone = !!r.undone_at;
  const show = () => {
    setOpen((v) => !v);
    if (!detail) api.get<CourierRemittanceDetail>(`${WORKSPACE_API}/courier/remittances/${encodeURIComponent(r.id)}`).then(setDetail).catch(() => setError(crs(loc, 'failed')));
  };
  const send = async (path: 'reconcile' | 'undo', body: object, after: () => void) => {
    setBusy(true); setError(null);
    try {
      await api.post(`${WORKSPACE_API}/courier/remittances/${encodeURIComponent(r.id)}/${path}`, body);
      // What the transfer holds is read again when it is next opened.
      setMode(null);
      setOpen(false);
      setDetail(null);
      after();
    } catch (e) { setError(errorText(e, crs(loc, 'saveFailed'))); } finally { setBusy(false); }
  };
  return <Fragment>
    <tr data-courier-transfer={r.id} data-courier-state={undone ? 'undone' : r.state} className={undone ? 'fw-courier-undone' : undefined}>
      <td dir="ltr">{r.received_day}</td>
      <td>{r.kind === 'opening' ? crs(loc, 'kindOpening') : <bdi dir="ltr">{r.reference}</bdi>}</td>
      <td><button type="button" className="fw-link" aria-expanded={open} onClick={show}>{r.parcels} · {crs(loc, open ? 'hideParcels' : 'showParcels')}</button></td>
      <td><Money value={r.collected_iqd} /></td><td><Money value={r.fee_iqd} /></td><td><Money value={r.amount_iqd} /></td>
      <td>{r.difference_iqd ? <span title={r.note}><Money value={r.difference_iqd} /></span> : '—'}</td>
      <td>{undone
        ? <span title={r.undo_reason}><Status>{crs(loc, 'stateUndone')}</Status> <small className="fw-muted">{crs(loc, 'undoneBy', { name: r.undone_by_name ?? '', day: (r.undone_at ?? '').slice(0, 10) })}</small></span>
        : r.state === 'reconciled'
          ? <span title={r.reconcile_note}><Status tone="positive">{crs(loc, 'stateReconciled')}</Status> <small className="fw-muted">{crs(loc, 'reconciledBy', { name: r.reconciled_by_name ?? '', day: (r.reconciled_at ?? '').slice(0, 10) })}</small></span>
          : <span><Status tone="warning">{crs(loc, 'stateReceived')}</Status> {!mode && <>
            <Button variant="ghost" onClick={() => setMode('check')} data-courier-reconcile>{crs(loc, 'reconcile')}</Button>
            {canUndo && <Button variant="ghost" onClick={() => setMode('undo')} data-courier-undo>{crs(loc, 'undo')}</Button>}
          </>}</span>}</td>
    </tr>
    {(mode || error) && <tr><td colSpan={8}>
      {error && <div className="fw-error" role="alert">{error}</div>}
      {mode === 'check' && <div className="fw-courier-check">
        <Field label={crs(loc, 'reconcileNote')}><input className="fw-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} data-courier-reconcile-note /></Field>
        <Button variant="primary" busy={busy} onClick={() => send('reconcile', { note: note.trim() }, onChanged)} data-courier-reconcile-confirm>{crs(loc, 'reconcileConfirm')}</Button>
        <Button variant="ghost" onClick={() => setMode(null)}>{crs(loc, 'cancel')}</Button>
      </div>}
      {mode === 'undo' && <div className="fw-courier-check" data-courier-undo-form>
        <p className="fw-note">{crs(loc, 'undoWarn')}</p>
        <Field label={crs(loc, 'undoReason')}><input className="fw-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-courier-undo-reason /></Field>
        <Button variant="danger" disabled={!reason.trim()} busy={busy} onClick={() => send('undo', { reason: reason.trim() }, onUndone)} data-courier-undo-confirm>{crs(loc, 'undoConfirm')}</Button>
        <Button variant="ghost" onClick={() => setMode(null)}>{crs(loc, 'cancel')}</Button>
      </div>}
    </td></tr>}
    {open && <tr><td colSpan={8}>{!detail ? <Loading text={crs(loc, 'colParcels')} /> : <ul className="fw-rows" data-courier-transfer-parcels>{detail.parcels.map((x) => <li key={x.order_id}><div>
      <span className="fw-rows-a"><button type="button" className="fw-link" dir="ltr" onClick={() => onOpenOrder(x.order_id)}>{x.order_id}</button> {x.customer_name ?? ''}</span>
      <span className="fw-rows-b"><Money value={x.net_iqd} /></span>
      <span className="fw-rows-c">{x.kind === 'fee' ? <>{crs(loc, 'prepaidLine')}: <Money value={-x.fee_iqd} /></> : <><Money value={x.collected_iqd} /> − <Money value={x.fee_iqd} /></>}</span>
    </div></li>)}</ul>}</td></tr>}
  </Fragment>;
}
