/**
 * «معاينة الأسعار الجديدة قبل الحفظ» — THE WRITER'S PREVIEW, SHOWN BEFORE ANY
 * PRICE IS WRITTEN (owner decision 8; USD design §5.4, §6.1-§6.5).
 *
 * One sheet for the three doors that write engine prices: the product form's
 * save (the save that completes a product adopts the engine), the stale list's
 * bulk re-save on «التسعير والشحن», and — through the same rows — the
 * purchase review. Per product: the six figures per model × channel as the
 * server answered them (PricingRowsTable), the notices the server raised (a
 * held exchange rate, the migrated minimum's 1,000 step, cash on delivery at
 * the direct price, a fall above 30%, the old route fee folded in, member
 * prices before → after) and, when a price moves more than 15%, the owner's
 * explicit tick; the save then sends the preview's hash (and the tick) and
 * nothing else. Every figure is the server's; the sheet formats.
 */
import { useState, type ReactNode } from 'react';
import { useLanguage } from '../../LanguageContext';
import { Modal } from '../adminProducts/ui';
import * as T from '../adminProducts/theme';
import { PricingRowsTable } from './ProcurementPricingReview';
import { adoptionRows, type EngineAdoption } from './procurementPricing';
import { procurementPricingStrings } from './procurementPricingStrings';
import { ENGINE_SAVE_STRINGS, engineNotices, engineSaveStrings } from './engineSaveStrings';

export interface EngineSaveProduct {
  product_id: string;
  /** Shown above the product's rows when the sheet carries more than one product. */
  label: string;
  adoption: EngineAdoption;
}

export default function EngineSaveSheet({ products, busy, error, onConfirm, onCancel, saveLabel, cancelLabel, note, extra }: {
  products: readonly EngineSaveProduct[];
  busy: boolean;
  error: string;
  onConfirm: (confirmLarge: boolean) => void;
  onCancel: () => void;
  /** The confirm's words when the sheet carries several products («حفظ الكل»). */
  saveLabel?: string;
  /** The cancel's words when cancelling loses nothing (the product form's data is already stored: «لاحقًا»). */
  cancelLabel?: string;
  /** One line under the intro: what is already saved, and what the confirm adds. */
  note?: string;
  /** Beside the error line: the way out of it (a fresh sign-in). */
  extra?: ReactNode;
}) {
  const { lang } = useLanguage();
  const s = engineSaveStrings(lang);
  const ps = procurementPricingStrings(lang);
  const [ticked, setTicked] = useState(false);
  const large = products.some((p) => p.adoption.large_change);
  const adopting = products.some((p) => p.adoption.kind === 'adopt');
  const several = products.length > 1;
  return (
    <Modal
      titleAr={s.sheetTitle}
      titleEn={lang === 'en' ? '' : ENGINE_SAVE_STRINGS.en.sheetTitle}
      onClose={() => { if (!busy) onCancel(); }}
      wide
      footer={
        <div className="flex flex-wrap items-center gap-2" data-engine-save-actions>
          <button type="button" className={T.btnPrimary} disabled={busy || (large && !ticked)} onClick={() => onConfirm(large && ticked)} data-engine-save-confirm>
            {busy ? s.saving : saveLabel ?? (adopting ? s.saveAdopt : s.saveReprice)}
          </button>
          <button type="button" className={T.btnSecondary} disabled={busy} onClick={onCancel} data-engine-save-cancel>{cancelLabel ?? s.cancel}</button>
        </div>
      }
    >
      <div className="grid gap-3" data-engine-save-sheet>
        <p className={`text-[13px] ${T.text2}`}>{adopting ? s.adoptIntro : s.repriceIntro}</p>
        {note && <p className={`text-[13px] ${T.text2}`} data-engine-save-note>{note}</p>}
        {products.map((p) => {
          const notices = engineNotices(p.adoption, lang);
          return (
            <article key={p.product_id} className="grid gap-2" data-engine-save-product={p.product_id}>
              {several && <strong className={T.text1}>{p.label}</strong>}
              {notices.length > 0 && (
                <ul className={`grid gap-1 text-[13px] ${T.text2}`}>
                  {notices.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
              {p.adoption.rows.length > 0 ? <PricingRowsTable rows={adoptionRows(p.adoption)} /> : <p className={`text-[13px] ${T.text3}`}>{ps.computing}</p>}
            </article>
          );
        })}
        {large && (
          <div className="grid gap-1 rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] px-3 py-2.5">
            <label className="flex items-center gap-2 text-sm text-[var(--ap-text-1)]">
              <input type="checkbox" checked={ticked} disabled={busy} onChange={(e) => setTicked(e.target.checked)} data-engine-save-large />
              {s.largeTick}
            </label>
            <span className={`text-[12px] ${T.text2}`}>{s.largeNote}</span>
          </div>
        )}
        {error && <p role="alert" className="text-[13px] text-[var(--ap-danger)]">{error}</p>}
        {extra}
      </div>
    </Modal>
  );
}
