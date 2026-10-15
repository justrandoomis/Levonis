/**
 * THE QUEUE v2 (Services S-P2 spec §6.13, G18): ONE search over the customer (name, e-mail, the
 * phone's last digits), the request and order numbers, the serials (the one scanned at intake and
 * the one on record for the unit) and the device names; work chips with their counts; the family;
 * keyset pages of thirty. Each row says where the request stands and what is unusual about it —
 * a serial that did not match, hours above what was declared, a value above the ceiling, a device
 * due today, a request from before the update. Staff figures only: offer, ceiling, final.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Search, X } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import VariantImg from '../ui/VariantImg';
import { FAMILY_LABELS, TRADE_IN_FAMILIES, type TradeInFamily } from '../../../packages/pricing/src/tradeIn';
import { dateText } from '../tradeIn/model';
import { useA } from './useA';
import { QUEUE_CHIPS, type QueueAnswer, type QueueChip, type QueueRow } from './types';
import type { AdminKey } from './copy';

export function chipTone(chip: QueueChip): string {
  if (chip === 'completed') return T.badge.active;
  if (chip === 'closed') return 'text-[var(--ap-text-3)] bg-[var(--ap-surface-2)] border-[var(--ap-border)]';
  if (chip === 'decision' || chip === 'credit_ready' || chip === 'awaiting_new_device')
    return 'text-[var(--ap-accent-text)] bg-[var(--ap-accent-soft)] border-[var(--ap-accent-border)]';
  return T.badge.draft;
}

export default function TradeInQueue({ onOpen, version }: { onOpen: (id: string) => void; version: number }) {
  const { a, money, loc, lang } = useA();
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<QueueChip | ''>('');
  const [family, setFamily] = useState<TradeInFamily | ''>('');
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const mine = ++seq.current;
      const p = new URLSearchParams();
      if (q.trim().length >= 2) p.set('q', q.trim());
      if (chip) p.set('chip', chip);
      if (family) p.set('family', family);
      if (after) p.set('cursor', after);
      try {
        const d = await api.get<QueueAnswer>(`/api/admin/trade-in/requests?${p.toString()}`);
        if (mine !== seq.current) return;
        setError('');
        setRows((cur) => (after && cur ? [...cur, ...d.requests] : d.requests));
        setCounts(d.counts ?? {});
        setCursor(d.next_cursor ?? null);
      } catch {
        if (mine === seq.current) setError(a('loadError'));
      }
    },
    [q, chip, family, a]
  );

  useEffect(() => {
    const id = window.setTimeout(() => void load(null), q ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [load, q, version]);

  const flagLine = (r: QueueRow) => {
    const out: Array<{ key: AdminKey; warn: boolean }> = [];
    if (r.flags.serial === 'mismatch') out.push({ key: 'intake.mismatch', warn: true });
    if (r.flags.serial === 'unrecorded') out.push({ key: 'intake.unrecorded', warn: true });
    if (r.flags.hours) out.push({ key: 'hoursFlag', warn: true });
    if (r.flags.above_ceiling) out.push({ key: 'aboveCeilingFlag', warn: true });
    if (r.flags.overdue) out.push({ key: 'chip.overdue', warn: true });
    if (r.flags.cutover) out.push({ key: 'cutoverFlag', warn: false });
    return out;
  };

  return (
    <div className="space-y-3" data-trade-in-queue>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className={`absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 ${T.text3}`} aria-hidden />
          <input className={`${T.input} w-full ps-9 pe-10`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={a('search')} aria-label={a('search')} data-queue-search />
          {q ? (
            <button type="button" className={`${T.btnIconGhost} absolute end-1 top-1/2 -translate-y-1/2`} onClick={() => setQ('')} aria-label={a('clear')}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <select className={`${T.select} w-44`} value={family} onChange={(e) => setFamily(e.target.value as TradeInFamily | '')} aria-label={a('family.label')}>
          <option value="">{a('family.all')}</option>
          {TRADE_IN_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {loc(FAMILY_LABELS[f].ar, FAMILY_LABELS[f].en, FAMILY_LABELS[f].ckb)}
            </option>
          ))}
        </select>
        <button type="button" className={T.btnIconLg} onClick={() => void load(null)} aria-label={a('refresh')}>
          <RefreshCw className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={a('needsAction')}>
        <button type="button" aria-pressed={chip === ''} className={`${T.chip} shrink-0`} onClick={() => setChip('')} data-chip="all">
          {a('chip.all')}
        </button>
        {QUEUE_CHIPS.map((c) => (
          <button key={c} type="button" aria-pressed={chip === c} className={`${T.chip} shrink-0`} onClick={() => setChip(c)} data-chip={c}>
            {a(`chip.${c}` as AdminKey)}
            {counts[c] ? <span className="tabular-nums opacity-80">{counts[c]}</span> : null}
          </button>
        ))}
      </div>

      {error ? (
        <p className="text-[13px] text-[var(--ap-danger)]" role="alert">
          {error}
        </p>
      ) : null}
      {rows === null ? (
        <p className={`py-12 text-center text-[13px] ${T.text3}`}>{a('loading')}</p>
      ) : rows.length === 0 ? (
        <div className={`${T.surface} p-8 text-center`}>
          <p className={`text-[13px] ${T.text3}`}>{a('queue.empty')}</p>
        </div>
      ) : (
        <ul className="space-y-2" data-queue-rows>
          {rows.map((r) => {
            const flags = flagLine(r);
            const figure =
              r.final_value_iqd !== null
                ? a('row.final', { x: money(r.final_value_iqd) })
                : r.ceiling_iqd !== null
                  ? a('row.ceiling', { x: money(r.ceiling_iqd) })
                  : r.offer_iqd !== null
                    ? a('row.offer', { x: money(r.offer_iqd) })
                    : '';
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r.id)}
                  data-row={r.id}
                  className={`${T.surface} flex w-full items-center gap-3 p-3 text-start transition-colors hover:border-[var(--ap-border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
                >
                  <span className="h-12 w-12 shrink-0 overflow-hidden rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)]">
                    {r.image ? <VariantImg sizes="48px" src={r.image} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold">{r.name}</span>
                    <span className={`block truncate text-[12px] ${T.text3}`}>
                      {loc(FAMILY_LABELS[r.family].ar, FAMILY_LABELS[r.family].en, FAMILY_LABELS[r.family].ckb)} → {r.target_name || '—'}
                    </span>
                    <span className={`block truncate text-[11.5px] ${T.text3}`}>
                      {r.customer_name ?? '—'} · <bdi dir="ltr">{r.customer_phone ?? ''}</bdi> · <bdi dir="ltr">{r.order_id}</bdi>
                    </span>
                    {flags.length ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {flags.map((f) => (
                          <span key={f.key} className={`${T.badgeBase} ${f.warn ? T.badge.hidden : T.badge.draft}`} data-flag={f.key}>
                            {f.warn ? <AlertTriangle className="h-3 w-3" aria-hidden /> : null}
                            {a(f.key)}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-end">
                    <span className={`${T.badgeBase} ${chipTone(r.chip)}`}>{a(`chip.${r.chip}` as AdminKey)}</span>
                    {figure ? <span className="mt-1 block text-[12.5px] font-semibold tabular-nums">{figure}</span> : null}
                    {r.chip === 'awaiting_device' && r.offer_expires_at ? (
                      <span className={`block text-[11px] ${T.text3}`}>{a('row.due', { date: dateText(r.offer_expires_at, lang) })}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {cursor ? (
        <button
          type="button"
          className={`${T.btnSecondary} w-full`}
          disabled={more}
          onClick={async () => {
            setMore(true);
            await load(cursor);
            setMore(false);
          }}
          data-queue-more
        >
          {a('queue.more')}
        </button>
      ) : null}
    </div>
  );
}
