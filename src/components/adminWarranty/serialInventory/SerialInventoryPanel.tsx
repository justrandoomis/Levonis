/**
 * «مخزون الأرقام التسلسلية» — the admin's list of device serials the shop
 * holds, where each one stands, and the door to add more.
 *
 * Status is the server's derived answer (in stock → sold → linked to an
 * account, or void); the row names the order and the account when there is
 * one, because «مَن يملك هذا الجهاز» is the question a warranty desk asks.
 * Search, a status filter with counts, keyset «عرض المزيد», and a CSV export
 * of exactly the filtered set.
 *
 * Phones get cards, wider screens a table: the table's eight columns do not
 * fit 390px, and a table that scrolls sideways hides its own actions.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Ban, Download, History, Link2, Pencil, Plus, RefreshCw, RotateCcw, Search } from 'lucide-react';
import * as T from '../../adminProducts/theme';
import { useLanguage } from '../../../LanguageContext';
import { useToast } from '../../ui/Toast';
import { usePrompt } from '../../ui/PromptDialog';
import AddSerialsPanel, { ICON_BTN_44 } from './AddSerialsPanel';
import EditSerialDialog from './EditSerialDialog';
import LinkProductDialog, { type LinkTarget } from './LinkProductDialog';
import SerialDetail from '../serial/SerialDetail';
import SerialGateCard from '../serial/SerialGateCard';
import { serialStrings } from '../../adminOrders/serials/strings';
import {
  INVENTORY_BASE,
  STR,
  inventoryApi,
  refusalText,
  type InventoryRow,
  type InventoryStatus,
  type InventoryStrings,
} from './model';

const FILTERS: Array<InventoryStatus | 'all'> = ['all', 'in_stock', 'reserved', 'sold', 'registered', 'returned', 'unavailable', 'void'];

const STATUS_TONE: Record<InventoryStatus, string> = {
  in_stock: 'text-[var(--ap-info)] bg-[var(--ap-info-bg)] border-[var(--ap-info-border)]',
  reserved: 'text-[var(--ap-accent-text)] bg-[var(--ap-accent-soft)] border-[var(--ap-accent-border)]',
  sold: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  registered: 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]',
  returned: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  unavailable: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
  void: 'text-[var(--ap-text-3)] bg-[var(--ap-surface-2)] border-[var(--ap-border)]',
};

/** The status in the reader's language — Sorani from the serial-scan words (this panel's own table is ar/en). */
function statusLabel(status: InventoryStatus, t: InventoryStrings, lang: string): string {
  return lang === 'ckb' ? serialStrings('ckb').status[status] ?? t[status] : t[status];
}

const shortDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');

function StatusBadge({ row, t }: { row: InventoryRow; t: InventoryStrings }) {
  const { lang } = useLanguage();
  return (
    <span className={`${T.badgeBase} ${STATUS_TONE[row.status] ?? STATUS_TONE.void}`} data-serial-status={row.status}>
      {statusLabel(row.status, t, lang)}
    </span>
  );
}

function Whereabouts({ row, t }: { row: InventoryRow; t: InventoryStrings }) {
  if (row.status === 'void') return row.void_reason ? <span className="text-[11px] text-[var(--ap-text-3)]">{row.void_reason}</span> : null;
  return (
    <span className="block text-[11px] text-[var(--ap-text-3)] space-x-1.5 rtl:space-x-reverse" dir="auto">
      {row.unit?.order_id && (
        <span>
          {t.order} <span dir="ltr" className="font-mono">{row.unit.order_id}</span>
        </span>
      )}
      {row.holder && (
        <span>
          · {t.holder} <span dir="ltr">{row.holder.email ?? row.holder.username ?? row.holder.id}</span>
        </span>
      )}
    </span>
  );
}

export default function SerialInventoryPanel() {
  const { lang, dir } = useLanguage();
  const t = lang === 'en' ? STR.en : STR.ar;
  const toast = useToast();
  const [prompt, promptDialog] = usePrompt();

  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<InventoryStatus | 'all', number> | null>(null);
  const [filter, setFilter] = useState<InventoryStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<InventoryRow | null>(null);
  const [linking, setLinking] = useState<LinkTarget | null>(null);
  // The §16 serial / warranty page, as a sheet over the list.
  const [detail, setDetail] = useState<string | null>(null);

  const params = useCallback(
    (after?: string | null) => {
      const p = new URLSearchParams({ limit: '50' });
      if (search.trim()) p.set('q', search.trim());
      if (filter !== 'all') p.set('status', filter);
      if (after) p.set('cursor', after);
      return p;
    },
    [search, filter]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await inventoryApi.list(params());
      setRows(res.rows);
      setCursor(res.next_cursor);
      if (res.counts) setCounts(res.counts);
      setErr(null);
    } catch (e) {
      setErr(refusalText(e, t));
    } finally {
      setLoading(false);
    }
  }, [params, t]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [load, search]);

  const more = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await inventoryApi.list(params(cursor));
      setRows((r) => [...r, ...res.rows]);
      setCursor(res.next_cursor);
    } catch (e) {
      toast.error(refusalText(e, t));
    } finally {
      setLoadingMore(false);
    }
  };

  const replaceRow = (row: InventoryRow | null) => {
    if (row) setRows((list) => list.map((r) => (r.serial_norm === row.serial_norm ? row : r)));
  };

  const toggleVoid = async (row: InventoryRow) => {
    const voiding = row.status !== 'void';
    const reason = await prompt({
      title: voiding ? t.voidTitle : t.restoreTitle,
      description: voiding ? t.voidBody : undefined,
      label: t.reason,
      required: true,
      multiline: true,
      maxLength: 300,
      validate: (v) => (v.trim().length < 3 ? t.reasonShort : null),
      confirmLabel: voiding ? t.confirmVoid : t.confirmRestore,
      cancelLabel: t.cancel,
      destructive: voiding,
    });
    if (reason === null) return;
    try {
      const res = await inventoryApi.setVoid(row.serial_norm, voiding, reason.trim());
      replaceRow(res.row);
      toast.success(voiding ? t.voided : t.restored);
      void load();
    } catch (e) {
      toast.error(refusalText(e, t));
    }
  };

  const exportHref = `${INVENTORY_BASE}/export?${(() => {
    const p = params();
    p.delete('limit');
    return p.toString();
  })()}`;

  const actions = (row: InventoryRow) => (
    <div className="flex items-center justify-end gap-0.5">
      <button type="button" className={ICON_BTN_44} onClick={() => setEditing(row)} aria-label={`${t.edit} ${row.serial}`} title={t.edit} data-serial-edit>
        <Pencil className="w-4 h-4" aria-hidden />
      </button>
      <button
        type="button"
        className={ICON_BTN_44}
        onClick={() => setDetail(row.serial_norm)}
        aria-haspopup="dialog"
        aria-label={`${serialStrings(lang).pageTitle} ${row.serial}`}
        title={serialStrings(lang).pageTitle}
        data-serial-open-detail={row.serial_norm}
      >
        <History className="w-4 h-4" aria-hidden />
      </button>
      <button
        type="button"
        className={`${ICON_BTN_44} ${row.status === 'void' ? '' : 'text-[var(--ap-danger)] hover:text-[var(--ap-danger)]'}`}
        onClick={() => void toggleVoid(row)}
        aria-label={`${row.status === 'void' ? t.restore : t.voidIt} ${row.serial}`}
        title={row.status === 'void' ? t.restore : t.voidIt}
        data-serial-void
      >
        {row.status === 'void' ? <RotateCcw className="w-4 h-4" aria-hidden /> : <Ban className="w-4 h-4" aria-hidden />}
      </button>
    </div>
  );

  const productLabel = (row: InventoryRow) =>
    row.product ? (lang === 'en' ? row.product.name || row.product.name_ar : row.product.name_ar || row.product.name) : t.noProduct;

  /**
   * «بلا منتج» is a question with an answer, so it carries the way to answer
   * it: one tap files this serial — and, with an EAN, every unlinked serial of
   * that EAN, which also teaches the camera the box for next time.
   */
  const linkButton = (row: InventoryRow) =>
    row.product || row.status === 'void' ? null : (
      <button
        type="button"
        className={`${T.btnSecondary} h-8 min-h-[32px] px-2.5 text-[12px]`}
        onClick={() => setLinking({ ean: row.ean, serialNorm: row.serial_norm, serial: row.serial, hint: row.model_name || row.model_hint })}
        data-serial-link={row.serial_norm}
      >
        <Link2 className="w-3.5 h-3.5" aria-hidden />
        {t.linkBtn}
      </button>
    );

  /** The model as typed, else what the label says — marked as such, never passed off as typed. */
  const modelLabel = (row: InventoryRow) =>
    row.model_name ? (
      row.model_name
    ) : row.model_hint ? (
      <span className="text-[var(--ap-text-2)]" title={t.hintFromLabel}>
        {row.model_hint}
      </span>
    ) : null;

  return (
    <div className="space-y-4" dir={dir} data-panel="serial-inventory">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-bold leading-tight text-[var(--ap-text-1)]">{t.title}</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--ap-text-3)] max-w-[70ch]">{t.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <a className={`${T.btnSecondary} min-h-[44px]`} href={exportHref} download data-serial-export>
            <Download className="w-4 h-4" aria-hidden />
            <span className="hidden sm:inline">{t.export}</span>
            <span className="sr-only sm:hidden">{t.export}</span>
          </a>
          <button type="button" className={`${T.btnSecondary} min-h-[44px] w-11 px-0`} onClick={() => void load()} aria-label={t.refresh} title={t.refresh}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          </button>
          <button
            type="button"
            className={`${T.btnPrimary} min-h-[44px]`}
            onClick={() => setAdding(true)}
            aria-haspopup="dialog"
            aria-expanded={adding}
            data-serial-add-open
          >
            <Plus className="w-4 h-4" aria-hidden />
            {t.add}
          </button>
        </div>
      </header>

      <SerialGateCard />

      <AddSerialsPanel t={t} open={adding} onClose={() => setAdding(false)} onSaved={() => void load()} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-[var(--ap-text-3)]" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.search}
            aria-label={t.search}
            className={`${T.input} w-full ps-9 min-h-[44px]`}
            data-serial-search
          />
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.status}>
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={`${T.chip} h-11 px-3`} data-serial-filter={f}>
              {f === 'all' ? t.all : statusLabel(f, t, lang)}
              {counts && <span className={`${T.kbd} ms-1`}>{counts[f] ?? 0}</span>}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div role="alert" className="rounded-[var(--ap-radius-md)] border border-[var(--ap-danger-border)] bg-[var(--ap-danger-bg)] px-3 py-2.5 text-[13px] text-[var(--ap-danger)]">
          {err}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>{t.loading}</div>
      ) : rows.length === 0 ? (
        <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>{search || filter !== 'all' ? t.noResults : t.empty}</div>
      ) : (
        <>
          {/* phones */}
          <ul className="md:hidden space-y-2" data-serial-cards>
            {rows.map((row) => (
              <li key={row.serial_norm} className={`${T.surface} p-3`} data-serial-row={row.serial_norm}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[14px] font-semibold text-[var(--ap-text-1)] break-all" dir="ltr">
                      {row.serial}
                    </div>
                    <div className="mt-0.5 text-[12px] text-[var(--ap-text-2)] truncate" dir="auto">
                      {row.product ? productLabel(row) : modelLabel(row) ?? t.noProduct}
                      {row.model_code && (
                        <span className="text-[var(--ap-text-3)]" dir="ltr">
                          {' '}
                          · {row.model_code}
                        </span>
                      )}
                    </div>
                  </div>
                  <StatusBadge row={row} t={t} />
                </div>
                <div className="mt-1.5 text-[11px] text-[var(--ap-text-3)] space-y-0.5">
                  {(row.box_sn || row.ean) && (
                    <div dir="ltr" className="font-mono text-start">
                      {[row.box_sn && `BOX ${row.box_sn}`, row.ean && `EAN ${row.ean}`].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  <Whereabouts row={row} t={t} />
                  <div>
                    {t.added} {shortDate(row.created_at)} · {t.sources[row.source]}
                  </div>
                </div>
                <div className="mt-1 -mb-1 -me-1 flex items-center justify-between gap-2">
                  <div className="min-w-0">{!row.product && linkButton(row)}</div>
                  {actions(row)}
                </div>
              </li>
            ))}
          </ul>

          {/* tablets and up */}
          <div className={`${T.surface} overflow-x-auto hidden md:block`}>
            <table className={`w-full border-collapse min-w-[860px] ${T.stickyActionsColumn}`} data-serial-table>
              <thead className={T.tableHead}>
                <tr>
                  {[t.serial, t.model, t.product, t.status, t.added, t.actions].map((h, i) => (
                    <th key={i} scope="col" className="px-3 py-2.5 text-start font-semibold text-[11.5px] whitespace-nowrap">
                      {i === 5 ? <span className="sr-only">{h}</span> : h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ap-hairline)]">
                {rows.map((row) => (
                  <React.Fragment key={row.serial_norm}>
                    <tr className={T.tableRow} data-serial-row={row.serial_norm}>
                      <td className="px-3 py-2">
                        <span className="block font-mono text-[12.5px] text-[var(--ap-text-1)]" dir="ltr">
                          {row.serial}
                        </span>
                        {(row.box_sn || row.ean) && (
                          <span className="block font-mono text-[11px] text-[var(--ap-text-3)]" dir="ltr">
                            {[row.box_sn && `BOX ${row.box_sn}`, row.ean && `EAN ${row.ean}`].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[12.5px]">
                        <span className="block text-[var(--ap-text-1)] truncate max-w-[20ch]" dir="auto">
                          {modelLabel(row) ?? '—'}
                        </span>
                        <span className="block text-[11px] text-[var(--ap-text-3)] font-mono" dir="ltr">
                          {row.model_code}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[12.5px] text-[var(--ap-text-2)]">
                        {row.product ? (
                          <span className="block truncate max-w-[24ch]" dir="auto">
                            {productLabel(row)}
                          </span>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[var(--ap-warning)]">{t.noProduct}</span>
                            {linkButton(row)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge row={row} t={t} />
                        <Whereabouts row={row} t={t} />
                      </td>
                      <td className="px-3 py-2 text-[12px] text-[var(--ap-text-2)] whitespace-nowrap">
                        <span dir="ltr">{shortDate(row.created_at)}</span>
                        <span className="block text-[11px] text-[var(--ap-text-3)]">
                          {t.sources[row.source]} · <span dir="ltr">{row.created_by.email ?? row.created_by.username ?? ''}</span>
                        </span>
                      </td>
                      <td className="px-1 py-1">{actions(row)}</td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {cursor && (
            <div className="flex justify-center">
              <button type="button" className={`${T.btnSecondary} min-h-[44px]`} onClick={() => void more()} disabled={loadingMore}>
                {loadingMore ? t.loading : t.loadMore}
              </button>
            </div>
          )}
        </>
      )}

      <LinkProductDialog
        t={t}
        target={linking}
        onClose={() => setLinking(null)}
        onLinked={({ linked, productName }) => {
          setLinking(null);
          toast.success(linked > 0 ? t.linked(linked, productName) : t.linkedNone);
          void load();
        }}
      />

      {editing && (
        <EditSerialDialog
          t={t}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            replaceRow(row);
            setEditing(null);
            toast.success(t.saved);
          }}
        />
      )}
      <SerialDetail serial={detail} onClose={() => setDetail(null)} />
      {promptDialog}
    </div>
  );
}
