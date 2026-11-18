/**
 * «عروض مجمّعة» (printer phase 4, DECISIONS row 355): store bundles that already exist in the
 * bundles admin, shown WITH this printer, in the owner's order, at most MAX_STORE_BUNDLES. Each keeps
 * its own bundle price — no extra discount — so the before / after here is the bundle's own (its
 * components' total, then its price). Stored on THIS printer's mapping only
 * (`products[productId].store_bundle_ids`).
 */
import { useEffect, useState } from 'react';
import { api, formatIqd } from '../../lib/api';
import { MAX_STORE_BUNDLES, type PrinterServicesConfig } from '../../../packages/pricing/src/printerServices';
import { S, say, type Loc } from './adminPrinterStrings';
import type { Upd } from './itemToolkit';


export interface AdminBundleRow {
  id: string; slug: string; status: string; kind: string; name: string; name_ar: string; name_ku?: string;
  component_total_iqd: number | null; bundle_price_iqd: number | null; saving_percent: number | null;
}

export const bundleName = (b: AdminBundleRow, lang: string) => (lang === 'en' ? b.name || b.name_ar : lang === 'ckb' ? b.name_ku || b.name || b.name_ar : b.name_ar || b.name) || b.slug;

/** The store's bundles, read once for the editor and for «ما يراه الزبون» (null while loading, 'failed' when the read failed). */
let bundlesRead: Promise<AdminBundleRow[]> | null = null;
export function useStoreBundles(): AdminBundleRow[] | null | 'failed' {
  const [rows, setRows] = useState<AdminBundleRow[] | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    bundlesRead ??= api.get<{ bundles: AdminBundleRow[] }>('/api/admin/bundles?kind=bundle').then((r) => (r.bundles ?? []).filter((b) => b.kind === 'bundle'));
    bundlesRead.then((r) => { if (live) setRows(r); }, () => { bundlesRead = null; if (live) setRows('failed'); });
    return () => { live = false; };
  }, []);
  return rows;
}

export default function StoreBundlesPanel({ draft, upd, loc, lang, productId }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; lang: string; productId: string }) {
  const read = useStoreBundles();
  const rows = read === 'failed' ? null : read;
  const failed = read === 'failed';
  const [pick, setPick] = useState('');
  const mapped = Object.hasOwn(draft.products, productId);
  const chosen = (mapped ? draft.products[productId].store_bundle_ids : undefined) ?? [];
  const byId = new Map((rows ?? []).map((b) => [b.id, b]));
  const set = (next: string[]) => upd((d) => {
    const m = d.products[productId];
    if (m) m.store_bundle_ids = next;
  });
  const move = (i: number, by: -1 | 1) => {
    const next = [...chosen];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set(next);
  };
  const free = (rows ?? []).filter((b) => !chosen.includes(b.id));

  return (
    <section className="border-t border-border-subtle pt-3 text-[12px] text-text-secondary space-y-2" data-printer-services-store-bundles>
      <h3 className="text-[14px] font-bold text-text-primary">{say(loc, S.bundles)}</h3>
      <p className="leading-relaxed">{say(loc, S.bundlesHint)}</p>
      {!mapped ? <p className="text-warning" role="note">{say(loc, S.bundleNeedsMapping)}</p> : null}
      {failed ? <p role="alert">{say(loc, S.bundlesLoadFailed)}</p> : null}
      {chosen.length === 0 ? <p>{say(loc, S.noBundlesHere)}</p> : (
        <ol className="space-y-2" data-store-bundle-list>
          {chosen.map((id, i) => {
            const b = byId.get(id);
            const saving = b && b.component_total_iqd !== null && b.bundle_price_iqd !== null && b.component_total_iqd > b.bundle_price_iqd;
            return (
              <li key={id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle p-2" data-store-bundle={id}>
                <span className="tabular-nums text-text-muted">{i + 1}.</span>
                <span className="min-w-0 flex-1 text-[13px] text-text-primary">
                  {b ? bundleName(b, lang) : <span dir="ltr">{id}</span>}
                  {!rows ? null : !b ? <span className="ms-2 text-warning">· {say(loc, S.bundleGone)}</span>
                    : b.status !== 'active' ? <span className="ms-2 text-warning">· {say(loc, S.bundleHidden)}</span> : null}
                </span>
                {b && b.bundle_price_iqd !== null ? (
                  <span className="inline-flex items-baseline gap-1.5">
                    {saving ? <span dir="ltr" className="tabular-nums line-through text-text-muted">{formatIqd(b.component_total_iqd as number)}</span> : null}
                    <span dir="ltr" className="tabular-nums font-bold text-text-primary">{formatIqd(b.bundle_price_iqd)}</span>
                    {saving && b.saving_percent ? <span className="text-success">({say(loc, S.save)} {b.saving_percent}%)</span> : null}
                  </span>
                ) : null}
                <span className="flex gap-1">
                  <button type="button" className="lv-button lv-button-ghost lv-button-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${say(loc, S.moveUp)} · ${b ? bundleName(b, lang) : id}`}>↑</button>
                  <button type="button" className="lv-button lv-button-ghost lv-button-sm" disabled={i === chosen.length - 1} onClick={() => move(i, 1)} aria-label={`${say(loc, S.moveDown)} · ${b ? bundleName(b, lang) : id}`}>↓</button>
                  <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={() => set(chosen.filter((x) => x !== id))}>{say(loc, S.remove)}</button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {mapped && chosen.length < MAX_STORE_BUNDLES && rows ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            {say(loc, S.addBundle)}
            <select className="lv-input h-10 w-full px-2 text-[13px]" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{say(loc, S.choose)}</option>
              {free.map((b) => (
                <option key={b.id} value={b.id}>
                  {bundleName(b, lang)}{b.bundle_price_iqd !== null ? ` — ${formatIqd(b.bundle_price_iqd)}` : ''}{b.status !== 'active' ? ` (${say(loc, S.bundleHidden)})` : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={!pick} onClick={() => { set([...chosen, pick]); setPick(''); }}>
            + {say(loc, S.addBundle)}
          </button>
        </div>
      ) : null}
    </section>
  );
}
