/**
 * THE PRODUCTS TAB (merchant platform W2-F) — find, act on many, open one.
 *
 *   · the list is the server's (search incl. variant SKUs, state, stock,
 *     collection, sort) paged by CURSOR with «show more»; the counts on the
 *     state switcher are real aggregates (`/products/stats`);
 *   · one DataList: a table where there is room, cards on a phone;
 *   · BULK actions answer per product — «done for 3 of 5» and, for the rest,
 *     the reason in words (a product Levonis hid cannot be published, one with
 *     orders cannot be deleted…). Ownership is the server's (every statement
 *     carries `merchant_id`), so a stale id is simply «no longer exists»;
 *   · destructive steps ask in the shared ConfirmDialog, never `confirm()`,
 *     and results are toasts, never `alert()`.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Copy, Download, ExternalLink, Eye, EyeOff, FileUp, MoreHorizontal, Package, Pencil, Plus, RefreshCcw, Star, Trash2, Archive, Search } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Button, IconButton } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { DataList, type DataListColumn } from '../../ui/DataList';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { Segmented } from '../../ui/Segmented';
import { StatusChip } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import type { MerchantStore } from '../../../lib/merchant';
import { useMainSiteHref } from '../dashboard/ui';
import { catalogApi, type BulkAction, type CatalogProduct, type CatalogStats, type Collection } from './catalogApi';
import { catalogRefusalText, catalogStrings } from './strings';
import { StateChip, readRefusal } from './parts';
import BulkValueSheet, { type BulkValueKind } from './BulkValueSheet';

const ProductEditorSheet = lazy(() => import('./ProductEditorSheet'));
const InsightsSheet = lazy(() => import('./InsightsSheet'));
const ImportSheet = lazy(() => import('./ImportSheet'));

type StateFilter = '' | 'published' | 'draft' | 'hidden' | 'archived';

export interface CatalogManagerProps {
  canSell: boolean;
  store: MerchantStore;
  /**
   * The product a workspace address names (`/merchant/products/<id>`) — its
   * editor opens — or `'new'` for the quick-create door (`?new=1`). W3-A.
   */
  focusProductId?: string | null;
  /** The list opened on a filter (`?state=`, `?stock=` — the Command Center's «running low»). */
  initialState?: string;
  initialStock?: string;
  /** The editor opened for `focusProductId` closed: the address goes back to the list. */
  onEditorClose?: () => void;
}

export function CatalogManager({ canSell, store, focusProductId = null, initialState, initialStock, onEditorClose }: CatalogManagerProps) {
  const { loc, lang } = useLanguage();
  const s = catalogStrings(loc);
  const toast = useToast();
  const mainHref = useMainSiteHref();
  const [confirm, confirmDialog] = useConfirm();

  const [qLive, setQLive] = useState('');
  const [q, setQ] = useState('');
  const [state, setState] = useState<StateFilter>(() => (['published', 'draft', 'hidden', 'archived'].includes(initialState ?? '') ? (initialState as StateFilter) : ''));
  const [stock, setStock] = useState(() => (['in', 'low', 'out', 'untracked'].includes(initialStock ?? '') ? initialStock! : ''));
  const [collection, setCollection] = useState('');
  const [sort, setSort] = useState('newest');

  const [rows, setRows] = useState<CatalogProduct[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  // An address that names a product (or «new») opens its editor — a new
  // product only when this store may take one on.
  useEffect(() => {
    if (!focusProductId) return;
    if (focusProductId === 'new') {
      if (canSell) setEditing({ id: null });
    } else setEditing({ id: focusProductId });
  }, [focusProductId, canSell]);
  const [insightsFor, setInsightsFor] = useState<CatalogProduct | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkValue, setBulkValue] = useState<BulkValueKind | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(qLive.trim()), 300);
    return () => clearTimeout(t);
  }, [qLive]);

  // A newer request wins: the debounced search and the filters overlap.
  const seq = useRef(0);
  const query = useMemo(() => ({ q, state, stock, collection, sort }), [q, state, stock, collection, sort]);

  const load = useCallback(() => {
    const n = ++seq.current;
    setError(null);
    catalogApi
      .list(query)
      .then((d) => {
        if (n !== seq.current) return;
        setRows(d.products);
        setTotal(d.total);
        setCursor(d.next_cursor);
        setSelected((sel) => new Set([...sel].filter((id) => d.products.some((p) => p.id === id))));
      })
      .catch((e) => n === seq.current && setError(e));
  }, [query]);

  const loadMeta = useCallback(() => {
    catalogApi.stats().then(setStats).catch(() => {});
    catalogApi.collections().then((d) => setCollections(d.collections)).catch(() => {});
  }, []);

  useEffect(load, [load]);
  useEffect(loadMeta, [loadMeta]);
  const reload = useCallback(() => {
    load();
    loadMeta();
  }, [load, loadMeta]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    const n = seq.current;
    try {
      const d = await catalogApi.list({ ...query, cursor });
      if (n !== seq.current) return;
      setRows((r) => [...(r ?? []), ...d.products.filter((p) => !(r ?? []).some((x) => x.id === p.id))]);
      setCursor(d.next_cursor);
    } catch (e) {
      toast.error(readRefusal(e, loc, s.loadFailed).message || s.loadFailed);
    } finally {
      setLoadingMore(false);
    }
  }

  async function bulk(action: BulkAction, ids: string[], extra: Record<string, unknown> = {}) {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const r = await catalogApi.bulk(action, ids, extra);
      const failed = r.results.filter((x) => !x.ok);
      if (!failed.length) toast.success(s.bulkDone(r.done, ids.length));
      else {
        const reasons = [...new Set(failed.map((f) => catalogRefusalText(f.code, loc, s.saveFailed)))].join(' ');
        toast.error(s.bulkDone(r.done, ids.length), { description: reasons });
      }
      if (ids.length > 1) setSelected(new Set());
      reload();
    } catch (e) {
      toast.error(readRefusal(e, loc, s.saveFailed).message || s.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: CatalogProduct) {
    const ok = await confirm({ title: s.deleteTitle(p.name), consequence: s.deleteConsequence, confirmLabel: s.remove, cancelLabel: s.cancel, destructive: true });
    if (!ok) return;
    try {
      const r = await catalogApi.remove(p.id);
      toast.success(r.archived ? s.archivedInstead : s.deleted);
      reload();
    } catch (e) {
      toast.error(readRefusal(e, loc, s.saveFailed).message || s.saveFailed);
    }
  }

  async function bulkDelete(ids: string[]) {
    const ok = await confirm({ title: s.bulkDeleteTitle(ids.length), consequence: s.bulkDeleteConsequence, confirmLabel: s.remove, cancelLabel: s.cancel, destructive: true });
    if (ok) await bulk('delete', ids);
  }

  async function duplicate(p: CatalogProduct) {
    try {
      await catalogApi.duplicate(p.id);
      toast.success(s.duplicated);
      reload();
    } catch (e) {
      toast.error(readRefusal(e, loc, s.saveFailed).message || s.saveFailed);
    }
  }

  async function exportCsv() {
    try {
      const res = await fetch('/api/merchant/products/export.csv', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('export');
      const truncatedAt = res.headers.get('X-Levonis-Truncated');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'products.csv';
      a.click();
      URL.revokeObjectURL(url);
      if (truncatedAt) toast.info(s.exportTruncated(truncatedAt));
    } catch {
      toast.error(s.exportFailed);
    }
  }

  const storefrontUrl = (p: CatalogProduct) =>
    /^https?:\/\//.test(store.url) ? `${store.url.replace(/\/$/, '')}/p/${p.slug}` : mainHref(`/community/store/${store.slug}/p/${p.slug}`);

  const name = (p: CatalogProduct) => (lang === 'en' ? p.name || p.name_ar : p.name_ar || p.name);
  const t = stats?.totals;
  const stateItems = [
    { id: '', label: s.all, badge: t?.total },
    { id: 'published', label: s.state('published'), badge: t?.published },
    { id: 'draft', label: s.state('draft'), badge: t?.draft },
    { id: 'hidden', label: s.state('hidden'), badge: t ? t.hidden - t.archived : undefined },
    { id: 'archived', label: s.state('archived'), badge: t?.archived },
  ].map((x) => ({ ...x, badge: x.badge === undefined ? undefined : <span className="tabular-nums">{x.badge}</span> }));

  const columns: DataListColumn<CatalogProduct>[] = [
    {
      id: 'product',
      header: s.product,
      card: 'title',
      cell: (p) => (
        <button type="button" onClick={() => setEditing({ id: p.id })} className="flex min-w-0 items-center gap-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold rounded-lg">
          <span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-border-subtle bg-black/40">
            {p.images[0] ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Package className="m-3 h-5 w-5 text-text-muted" aria-hidden="true" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-text-primary">{name(p)}</span>
            <span className="block truncate text-[12px] text-text-muted">
              {p.variant_mode === 'variants' ? s.variantsCount(p.variant_count) : p.variant_mode === 'legacy' ? s.legacyChoices : p.sku || p.category || ''}
            </span>
          </span>
        </button>
      ),
    },
    { id: 'state', header: s.status, card: 'badge', cell: (p) => <StateChip p={p} s={s} /> },
    {
      id: 'price',
      header: s.price,
      numeric: true,
      card: 'field',
      cell: (p) =>
        p.price_range && p.price_range.min !== p.price_range.max ? (
          <span className="tabular-nums"><Money iqd={p.price_range.min} /> – <Money iqd={p.price_range.max} /></span>
        ) : (
          <Money iqd={p.price_range?.min ?? p.price_iqd} />
        ),
    },
    {
      id: 'stock',
      header: s.stock,
      numeric: true,
      card: 'field',
      cell: (p) =>
        !p.track_stock ? (
          <span className="text-text-muted">{s.untracked}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            {p.stock}
            {p.sold_out ? <StatusChip tone="danger" dot={false} className="whitespace-nowrap">{s.outOfStock}</StatusChip> : p.low_stock ? <StatusChip tone="warning" dot={false} className="whitespace-nowrap">{s.lowStock}</StatusChip> : null}
          </span>
        ),
    },
    { id: 'sales', header: s.sales, numeric: true, card: 'field', cell: (p) => <span className="tabular-nums">{(p.sold_count ?? 0).toLocaleString('en-US')}</span> },
  ];

  const rowActions = (p: CatalogProduct): MenuEntry[] => {
    const admin = !!p.moderation?.hidden_by_admin;
    const list: MenuEntry[] = [
      { id: 'edit', label: s.edit, icon: <Pencil className="h-4 w-4" />, onSelect: () => setEditing({ id: p.id }) },
      { id: 'insights', label: s.insights, icon: <BarChart3 className="h-4 w-4" />, onSelect: () => setInsightsFor(p) },
      { id: 'duplicate', label: s.duplicate, icon: <Copy className="h-4 w-4" />, onSelect: () => duplicate(p), disabled: !canSell },
    ];
    if (p.state === 'published' && !admin) list.push({ id: 'open', label: s.openInStore, icon: <ExternalLink className="h-4 w-4" />, href: storefrontUrl(p) });
    list.push({ id: 'sep1', separator: true });
    if (p.state !== 'published') list.push({ id: 'publish', label: s.publish, icon: <Eye className="h-4 w-4" />, onSelect: () => bulk('publish', [p.id]), disabled: !canSell || admin });
    if (p.state === 'published') list.push({ id: 'hide', label: s.hide, icon: <EyeOff className="h-4 w-4" />, onSelect: () => bulk('hide', [p.id]) });
    list.push(p.featured
      ? { id: 'unfeature', label: s.unfeature, icon: <Star className="h-4 w-4" />, onSelect: () => bulk('unfeature', [p.id]) }
      : { id: 'feature', label: s.feature, icon: <Star className="h-4 w-4" />, onSelect: () => bulk('feature', [p.id]), disabled: !canSell });
    if (p.state !== 'archived') list.push({ id: 'archive', label: s.archive, icon: <Archive className="h-4 w-4" />, onSelect: () => bulk('archive', [p.id]) });
    list.push({ id: 'sep2', separator: true });
    list.push({ id: 'delete', label: s.remove, icon: <Trash2 className="h-4 w-4" />, destructive: true, onSelect: () => remove(p) });
    return list;
  };

  const ids = [...selected];
  const bulkMenu: MenuEntry[] = [
    { id: 'draft', label: s.toDraft, onSelect: () => bulk('draft', ids) },
    { id: 'archive', label: s.archive, onSelect: () => bulk('archive', ids) },
    { id: 'feature', label: s.feature, onSelect: () => bulk('feature', ids), disabled: !canSell },
    { id: 'unfeature', label: s.unfeature, onSelect: () => bulk('unfeature', ids) },
    { id: 'sep', separator: true },
    { id: 'price', label: s.setPrice, onSelect: () => setBulkValue('price'), disabled: !canSell },
    { id: 'stock', label: s.setStock, onSelect: () => setBulkValue('stock'), disabled: !canSell },
    { id: 'add', label: s.addToCollection, onSelect: () => setBulkValue('add_to_collection'), disabled: !canSell },
    { id: 'removec', label: s.removeFromCollection, onSelect: () => setBulkValue('remove_from_collection') },
    { id: 'sep2', separator: true },
    { id: 'delete', label: s.remove, destructive: true, onSelect: () => bulkDelete(ids) },
  ];

  const filtered = !!(q || state || stock || collection);

  return (
    <div className="space-y-4" data-catalog-manager>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[20px] font-bold text-text-primary">
          {s.products}
          {t && <span className="ms-2 text-[14px] font-medium text-text-muted tabular-nums">{t.total}</span>}
        </h2>
        <div className="flex items-center gap-2">
          <Menu
            label={s.importExport}
            items={[
              { id: 'export', label: s.exportCsv, icon: <Download className="h-4 w-4" />, onSelect: exportCsv },
              { id: 'import', label: s.importCsv, icon: <FileUp className="h-4 w-4" />, onSelect: () => setImportOpen(true), disabled: !canSell },
              { id: 'refresh', label: s.refresh, icon: <RefreshCcw className="h-4 w-4" />, onSelect: reload },
            ]}
            trigger={(props) => <IconButton {...props} label={s.importExport} variant="secondary" icon={<MoreHorizontal className="h-4 w-4" />} />}
          />
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ id: null })} disabled={!canSell} data-new-product>
            {s.newProduct}
          </Button>
        </div>
      </div>

      {!canSell && <p className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-[12.5px] text-text-primary" role="note">{s.cannotSell}</p>}

      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <Input type="search" value={qLive} onChange={(e) => setQLive(e.target.value)} placeholder={s.search} aria-label={s.search} className="ps-9" enterKeyHint="search" />
        </div>
        <div className="-mx-1 -mt-2 overflow-x-auto px-1 py-2 hide-scrollbar">
          <Segmented items={stateItems} value={state} onChange={(id) => setState(id as StateFilter)} label={s.stateFilter} group="catalog-state" size="sm" className="min-w-max sm:min-w-0" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Select value={stock} onChange={(e) => setStock(e.target.value)} aria-label={s.stock}>
            <option value="">{s.allStock}</option>
            <option value="in">{s.inStock}</option>
            <option value="low">{s.lowStock}</option>
            <option value="out">{s.outOfStock}</option>
            <option value="untracked">{s.untracked}</option>
          </Select>
          <Select value={collection} onChange={(e) => setCollection(e.target.value)} aria-label={s.collectionFilter}>
            <option value="">{s.allCollections}</option>
            <option value="none">{s.noCollection}</option>
            {collections.filter((c) => c.kind === 'manual').map((c) => (
              <option key={c.id} value={c.id}>{lang === 'en' ? c.name : c.name_ar || c.name}</option>
            ))}
          </Select>
          <div className="col-span-2 sm:col-span-1">
          <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label={s.sort}>
            <option value="newest">{s.sortNewest}</option>
            <option value="oldest">{s.sortOldest}</option>
            <option value="updated">{s.sortUpdated}</option>
            <option value="price_asc">{s.sortPriceAsc}</option>
            <option value="price_desc">{s.sortPriceDesc}</option>
            <option value="sales">{s.sortSales}</option>
            <option value="views">{s.sortViews}</option>
            <option value="stock">{s.sortStock}</option>
          </Select>
          </div>
        </div>
      </div>

      <DataList
        label={s.products}
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id}
        error={rows === null ? error : undefined}
        onRetry={load}
        rowActions={rowActions}
        rowLabel={name}
        empty={
          filtered
            ? { title: s.noMatch }
            : { title: s.noProducts, description: s.noProductsHint, action: canSell ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ id: null })}>{s.newProduct}</Button> : undefined }
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => bulk('publish', ids)} disabled={busy || !canSell}>{s.publish}</Button>
              <Button size="sm" variant="secondary" onClick={() => bulk('hide', ids)} disabled={busy}>{s.hide}</Button>
              <Menu label={s.bulkMore} items={bulkMenu} trigger={(props) => <Button {...props} size="sm" variant="ghost" disabled={busy}>{s.bulkMore}</Button>} />
            </div>
          ),
        }}
        wideAt={720}
      />

      {rows && rows.length > 0 && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-[12px] text-text-muted tabular-nums">{s.shownOf(rows.length, total)}</p>
          {cursor && (
            <Button variant="secondary" onClick={more} loading={loadingMore} data-load-more>
              {s.loadMore}
            </Button>
          )}
        </div>
      )}

      <Suspense fallback={null}>
        {editing && (
          <ProductEditorSheet
            open={!!editing}
            productId={editing.id}
            canSell={canSell}
            collections={collections}
            onClose={() => {
              setEditing(null);
              if (focusProductId) onEditorClose?.();
            }}
            onSaved={reload}
          />
        )}
        {insightsFor && <InsightsSheet product={insightsFor} onClose={() => setInsightsFor(null)} />}
        {importOpen && <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} onImported={reload} />}
      </Suspense>
      <BulkValueSheet
        kind={bulkValue}
        count={ids.length}
        collections={collections.filter((c) => c.kind === 'manual')}
        onClose={() => setBulkValue(null)}
        onApply={async (extra) => {
          const action: BulkAction = bulkValue === 'price' ? 'set_price' : bulkValue === 'stock' ? 'set_stock' : (bulkValue as BulkAction);
          setBulkValue(null);
          await bulk(action, ids, extra);
        }}
      />
      {confirmDialog}
    </div>
  );
}
