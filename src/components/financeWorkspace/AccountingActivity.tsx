import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Loading, Money, Surface, useNarrow } from './ui';
import { WORKSPACE_API } from './types';
import { aas, actionWords } from './activityStrings';

/**
 * «المال والأرباح» → المحاسبة → «سجل العمليات المالية» (the owner's brief, 2026-11-12, part 4: «audit logs … traceable»;
 * GET /api/admin/finance-workspace/activity, DECISIONS row 328).
 *
 * Every change to money in the period — who made it, when (Baghdad time), what it was, on what, and its money where the row
 * carries it — newest first, fifty at a time with «المزيد». A search keeps the rows whose order, name or reference holds the
 * text; by default only what a person did, «يشمل ما فعله النظام وحده» adds the system's own recomputations. The page writes
 * nothing. A table on a wide screen; on a phone each act is one item of the attention list, its money at the end, so nothing
 * hides behind a sideways scroll.
 *
 * A PAYMENT'S STATEMENT (the owner's brief, 2026-11-12, part 2; DECISIONS rows 330–331). A staff payment's row carries its
 * statement — every wage it paid, traced — and a paid withdrawal's row the investor's — the summary per agreement and every
 * sold unit behind it — as Excel and as a page to print or save as PDF, in the reader's language.
 *
 * ON WHAT. The order the act concerns when there is one — its own target, or the order its detail names (a collection, an
 * approved wage) — as a button that opens its sheet; otherwise the row's own id.
 *
 * WHAT THE AMOUNT IS. Each kind of row writes its own detail (worker/lib/audit.ts callers): the first of its amount, the
 * journal's debit, the cash that reached the till, the value after a correction, an agreement's principal; a correction that
 * names both shows «before ← after» in the reader's direction (→ in English). The reason, note, reference or title is its
 * small line.
 */
export interface ActivityRow { id: number; actor_id: string | null; actor_name: string | null; action: string; target: string; detail: unknown; at: string }
interface ActivityAnswer { rows: ActivityRow[]; next: number | null }

const ORDER_ID = /^ORD-/;
const whenOf = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : at; };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fields = (detail: unknown) => (detail && typeof detail === 'object' ? detail : {}) as Record<string, unknown>;

/** The row's money, as its detail carries it (see the header): a change, one amount, or none. */
export function activityMoney(detail: unknown): { before: number; after: number } | { value: number } | null {
  const d = fields(detail);
  const before = num(d.before_iqd), after = num(d.after_iqd);
  if (before !== null && after !== null) return { before, after };
  const value = [d.amount_iqd, d.debit_iqd, d.net_iqd, d.after_iqd, d.principal_iqd, d.fee_iqd].map(num).find((v) => v !== null);
  return value === undefined || value === null ? null : { value };
}
/** The order the act concerns: its target, or the order its detail names. */
export function activityOrder(row: Pick<ActivityRow, 'target' | 'detail'>): string | null {
  if (ORDER_ID.test(row.target)) return row.target;
  const o = fields(row.detail).order_id;
  return typeof o === 'string' && ORDER_ID.test(o) ? o : null;
}
/** The row's small line: its reason, note, reference, title, name or month. */
export function activityNote(detail: unknown): string {
  const d = fields(detail);
  const text = [d.reason, d.note, d.reference, d.title, d.name, d.month].find((v) => typeof v === 'string' && v.trim() !== '') as string | undefined;
  return text ? (text.length > 90 ? `${text.slice(0, 89)}…` : text) : '';
}

export default function AccountingActivity({ from, to, onOpenOrder }: { from: string; to: string; onOpenOrder: (orderId: string) => void }) {
  const { loc, lang } = useLanguage();
  const narrow = useNarrow();
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef<AbortController | null>(null);

  // A search is sent a moment after the typing stops, not on every key.
  useEffect(() => { const t = setTimeout(() => setQuery(typed.trim()), 350); return () => clearTimeout(t); }, [typed]);

  const read = useCallback((before: number | null) => {
    live.current?.abort();
    const controller = new AbortController();
    live.current = controller;
    setBusy(true);
    setFailed(false);
    const params = new URLSearchParams({ from, to, ...(auto ? { auto: '1' } : {}), ...(query ? { q: query } : {}), ...(before ? { before: String(before) } : {}) });
    api.get<ActivityAnswer>(`${WORKSPACE_API}/activity?${params}`, { signal: controller.signal })
      .then((r) => { if (controller.signal.aborted) return; setRows((old) => (before && old ? [...old, ...r.rows] : r.rows)); setNext(r.next); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
  }, [from, to, auto, query]);
  useEffect(() => { read(null); return () => live.current?.abort(); }, [read]);

  const arrow = loc('←', '→', '←');
  const money = (r: ActivityRow): ReactNode => {
    const m = activityMoney(r.detail);
    return !m ? null : 'value' in m ? <Money value={m.value} /> : <><Money value={m.before} /> {arrow} <Money value={m.after} /></>;
  };
  const on = (r: ActivityRow): ReactNode => {
    const order = activityOrder(r);
    return order ? <button type="button" className="fw-link" onClick={() => onOpenOrder(order)}>{order}</button> : <span dir="ltr">{r.target}</span>;
  };
  const who = (r: ActivityRow) => r.actor_name || r.actor_id || aas(loc, 'system');
  const statement = (r: ActivityRow): ReactNode => {
    const kind = r.action === 'finance.staff_paid' ? 'staff-payments' : r.action === 'finance.withdrawal_paid' ? 'withdrawals' : null;
    if (!kind || !r.target) return null;
    const base = `${WORKSPACE_API}/statements/${kind}/${encodeURIComponent(r.target)}`;
    return <small data-finance-activity-statement>{aas(loc, 'statement')}: <a className="fw-link" href={`${base}/export.xlsx?lang=${lang}`}>Excel</a>
      {' · '}<a className="fw-link" href={`${base}/print?lang=${lang}`} target="_blank" rel="noopener">PDF</a></small>;
  };

  return <Surface title={aas(loc, 'title')} subtitle={aas(loc, 'sub')}>
    <div data-finance-activity aria-busy={busy}>
      <div className="fw-toolbar">
        <input className="fw-input" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={aas(loc, 'search')} aria-label={aas(loc, 'search')} data-finance-activity-search />
        <label className="fw-chip"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-finance-activity-auto />{aas(loc, 'auto')}</label>
      </div>
      {failed ? <p className="fw-note" role="alert">{aas(loc, 'failed')}</p>
        : rows === null ? <Loading text={aas(loc, 'title')} />
          : rows.length === 0 ? <p className="fw-note" data-finance-activity-none>{aas(loc, 'none')}</p>
            : narrow ? <ul className="fw-att">{rows.map((r) => {
              const note = activityNote(r.detail);
              return <li key={r.id} data-finance-activity-row={r.action}>
                <small dir="ltr">{whenOf(r.at).slice(5)}</small>
                <div><strong>{actionWords(loc, r.action)}</strong><small>{who(r)} · {on(r)}{note && <> · {note}</>}</small>{statement(r)}</div>
                <span>{money(r)}</span>
              </li>;
            })}</ul>
              : <div className="fw-table-wrap"><table className="fw-table">
                <thead><tr><th>{aas(loc, 'colWhat')}</th><th>{aas(loc, 'colWhen')}</th><th>{aas(loc, 'colWho')}</th><th>{aas(loc, 'colOn')}</th><th>{aas(loc, 'colAmount')}</th></tr></thead>
                <tbody>{rows.map((r) => {
                  const note = activityNote(r.detail);
                  return <tr key={r.id} data-finance-activity-row={r.action}>
                    <th scope="row"><div>{actionWords(loc, r.action)}</div>{note && <small>{note}</small>}{statement(r)}</th>
                    <td dir="ltr">{whenOf(r.at)}</td>
                    <td>{who(r)}</td>
                    <td>{on(r)}</td>
                    <td>{money(r)}</td>
                  </tr>;
                })}</tbody>
              </table></div>}
      {next !== null && !failed && <Button onClick={() => read(next)} busy={busy} data-finance-activity-more>{aas(loc, 'more')}</Button>}
    </div>
  </Surface>;
}
