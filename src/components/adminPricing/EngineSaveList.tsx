/**
 * «منتجات تنتظر حفظ أسعارها الجديدة» — THE STALE LIST (owner decision 8; USD
 * design §6.5), on «التسعير والشحن» and in the rates panel.
 *
 * Two kinds of product wait for one save: an engine-priced product whose
 * stored price was computed at a confirmed exchange or shipping rate that has
 * changed since (stale), and a product whose pricing data is complete but is
 * still priced by hand (ready). The owner sees the count, previews the new
 * prices of up to 20 at once (the same sheet as the product form) and saves
 * them in one bulk request — each product its own atomic, fenced, audited
 * write on the server, each answered saved / unchanged / refused. Automatic
 * repricing on a rate change is the next package (FX-5); nothing here prices.
 *
 * Owner only: mounted inside the pricing tab (`can_write_cost`), every route
 * behind it refuses everyone but the verified owner.
 */
import { useEffect, useState } from 'react';
import { ApiError, isAborted } from '../../lib/api';
import { Button } from '../ui/Button';
import { contractRefusal, refusalLang } from '../../lib/refusalStrings';
import type { Language } from '../../translations';
import { profileName } from '../adminOperations/procurementPricingStrings';
import { writesPrices } from '../adminOperations/procurementPricing';
import EngineSaveSheet from '../adminOperations/EngineSaveSheet';
import { engineSaveStrings } from '../adminOperations/engineSaveStrings';
import { fetchSaveList, firstBatch, previewSaveList, saveBulk, type SaveListAnswer, type SaveListItem, type SaveListPreviewItem } from './api';

const PROFILES = new Set(['GERMANY_LAND', 'CHINA_AIR', 'CHINA_SEA']);

const nameOf = (x: { name_ar: string; name_en: string; name_ckb: string; slug?: string }, lang: Language) =>
  (lang === 'en' ? x.name_en || x.name_ar : lang === 'ckb' ? x.name_ckb || x.name_ar : x.name_ar || x.name_en) || x.slug || '—';

export default function EngineSaveList({ lang, compact = false, reloadKey = 0 }: { lang: Language; compact?: boolean; reloadKey?: number }) {
  const s = engineSaveStrings(lang);
  const [list, setList] = useState<SaveListAnswer | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [sheet, setSheet] = useState<SaveListPreviewItem[] | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'save'>('');
  const [sheetError, setSheetError] = useState('');
  const [outcome, setOutcome] = useState<string[]>([]);
  const said = (e: unknown) => contractRefusal(e, refusalLang(lang), e instanceof Error ? e.message : String(e));

  useEffect(() => {
    const ac = new AbortController();
    fetchSaveList(ac.signal)
      .then((r) => {
        if (!ac.signal.aborted) {
          setList(r);
          setError('');
        }
      })
      .catch((e) => {
        // The list is a helper beside the page: a refusal (an engine not installed yet) shows nothing.
        if (!ac.signal.aborted && !isAborted(e) && !(e instanceof ApiError && e.code === 'PRICING_NOT_INSTALLED')) setError(said(e));
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `said` follows `lang`, which does not refetch
  }, [reload, reloadKey]);

  const preview = async () => {
    if (!list || busy) return;
    setBusy('preview');
    setOutcome([]);
    setSheetError('');
    try {
      const r = await previewSaveList(firstBatch(list));
      const waiting = r.items.filter((i) => writesPrices(i.preview) && i.preview.preview_hash);
      if (waiting.length) setSheet(waiting);
      else {
        setOutcome([s.nothing]);
        setReload((n) => n + 1);
      }
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy('');
    }
  };

  const save = async (confirmLarge: boolean) => {
    if (!sheet || busy) return;
    setBusy('save');
    setSheetError('');
    try {
      const r = await saveBulk(sheet.map((i) => ({ product_id: i.product_id, preview_hash: i.preview.preview_hash! })), confirmLarge);
      const done = r.results.filter((x) => x.status === 'saved' || x.status === 'already').length;
      const refused = r.results
        .filter((x) => x.status === 'refused')
        .map((x) => {
          const item = sheet.find((i) => i.product_id === x.product_id);
          return s.refusedLine(item ? nameOf(item, lang) : x.product_id, contractRefusal({ code: x.code }, refusalLang(lang), x.code ?? ''));
        });
      setSheet(null);
      setOutcome([s.savedCount(String(done), String(r.results.length)), ...refused]);
      setReload((n) => n + 1);
    } catch (e) {
      setSheetError(e instanceof ApiError && e.code === 'REAUTH_REQUIRED' ? s.reauth : said(e));
    } finally {
      setBusy('');
    }
  };

  const total = list ? list.stale.count + list.ready.count : 0;
  if (!list && !error) return null;
  if (list && total === 0 && !outcome.length) return null;

  const reasonText = (i: SaveListItem) => s.reasons(i.reasons.map((r) => (PROFILES.has(r) ? profileName(r, lang) : r)).join(lang === 'en' ? ', ' : '، '));

  return (
    <section data-engine-save-list={compact ? 'compact' : 'full'} className={compact ? 'mt-4 rounded-xl border border-border-subtle p-3' : 'lv-surface min-w-0 p-4'}>
      <h3 className="text-[15px] font-bold leading-snug text-text-primary">{s.listTitle}</h3>
      {error && <p role="alert" className="mt-1 text-[13px] text-danger">{error}</p>}
      {list && total > 0 && (
        <>
          <ul className="mt-1 grid gap-0.5 text-[13px] text-text-muted">
            {list.stale.count > 0 && <li data-engine-stale-count={list.stale.count}>{s.staleCount(String(list.stale.count))}</li>}
            {list.ready.count > 0 && <li data-engine-ready-count={list.ready.count}>{s.readyCount(String(list.ready.count))}</li>}
          </ul>
          {list.stale.count > 0 && <p className="mt-1 max-w-[68ch] text-[12px] leading-relaxed text-text-muted">{s.staleHint}</p>}
          {!compact && (
            <ul className="mt-2 grid gap-1 text-[13px]">
              {list.stale.items.slice(0, 20).map((i) => (
                <li key={`s:${i.product_id}`} className="text-text-primary">
                  {nameOf(i, lang)} <span className="text-text-muted">— {reasonText(i)}</span>
                </li>
              ))}
              {list.ready.items.slice(0, 20).map((i) => (
                <li key={`r:${i.product_id}`} className="text-text-primary">
                  {nameOf(i, lang)} <span className="text-text-muted">— {s.readyHint}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            <Button size="sm" variant="primary" loading={busy === 'preview'} disabled={!!busy && busy !== 'preview'} onClick={() => void preview()} data-engine-preview-all>
              {s.previewAll}
            </Button>
          </div>
        </>
      )}
      {outcome.length > 0 && (
        <ul role="status" className="mt-2 grid gap-0.5 text-[13px] text-text-primary">
          {outcome.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
      {sheet && (
        <EngineSaveSheet
          products={sheet.map((i) => ({ product_id: i.product_id, label: nameOf(i, lang), adoption: i.preview }))}
          busy={busy === 'save'}
          error={sheetError}
          saveLabel={sheet.length > 1 ? s.saveAll : undefined}
          onConfirm={(confirmLarge) => void save(confirmLarge)}
          onCancel={() => {
            setSheet(null);
            setSheetError('');
          }}
        />
      )}
    </section>
  );
}
