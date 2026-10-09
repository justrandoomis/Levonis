import { useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { ApiError } from '../../lib/api';
import { COST_REFUSALS } from '../../../packages/contracts/src/costRefusals';
import { T, money } from './shared';
import { adoptionRows, applyPurchase, samePrices, writesPrices, type PricingChoices, type PricingPreview, type PricingPreviewRow, type PricingProduct } from './procurementPricing';
import { channelName, issueText, procurementPricingStrings, profileName } from './procurementPricingStrings';
import { engineNotices, engineSaveStrings } from './engineSaveStrings';

/**
 * THE REVIEW STEP'S «معاينة الأسعار الجديدة قبل الحفظ» (USD design §5.4, §6.3;
 * owner decision 8's six figures): per product, per model × channel, the
 * current replacement cost, the minimum profit, the new pre-order price, the
 * Direct Sale Extra, the new direct sale price, and old → new — with the
 * per-product choices and the notices the server raised. Every figure is the
 * server's; the screen formats.
 *
 * A product the purchase leaves complete (or one already engine-priced) shows
 * the prices the confirm WRITES (owner decision 8: the apply adopts the engine
 * in its own batch), with the tick a change above 15% needs.
 */
export default function ProcurementPricingReview({ preview, busy, usePurchase, prefer, onUsePurchase, onPrefer, confirmLarge = {}, onConfirmLarge }: {
  preview: PricingPreview | null;
  busy: boolean;
  usePurchase: Record<string, boolean>;
  prefer: Record<string, boolean>;
  onUsePurchase: (productId: string, value: boolean) => void;
  onPrefer: (productId: string, value: boolean) => void;
  confirmLarge?: Record<string, boolean>;
  onConfirmLarge?: (productId: string, value: boolean) => void;
}) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  if (!preview) return busy ? <p role="status" className={`mt-4 text-sm ${T.text3}`}>{s.computing}</p> : null;
  return (
    <section aria-labelledby="pricing-preview-title" className="mt-4 grid gap-3" data-pricing-review>
      <h4 id="pricing-preview-title" className={`font-semibold ${T.text1}`}>{s.previewTitle}</h4>
      {preview.rates.review_pending && preview.rates.usd_iqd_rate && <p role="status" className="rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] px-3 py-2.5 text-[13px] text-[var(--ap-text-1)]">{s.reviewBanner(preview.rates.usd_iqd_rate)}</p>}
      {preview.rates.derived_stale && <p role="alert" className="text-[13px] text-[var(--ap-danger)]">{COST_REFUSALS.FX_DERIVED_STALE[lang]}</p>}
      {preview.products.map((p) => (
        <ProductPreview
          key={p.product_id}
          p={p}
          use={usePurchase[p.product_id] !== false}
          prefer={prefer[p.product_id] === true}
          onUse={(v) => onUsePurchase(p.product_id, v)}
          onPrefer={(v) => onPrefer(p.product_id, v)}
          large={confirmLarge[p.product_id] === true}
          onLarge={onConfirmLarge ? (v) => onConfirmLarge(p.product_id, v) : undefined}
        />
      ))}
      <p className={`text-[12px] ${T.text3}`}>{s.savePc}</p>
    </section>
  );
}

function ProductPreview({ p, use, prefer, onUse, onPrefer, large, onLarge }: {
  p: PricingProduct;
  use: boolean;
  prefer: boolean;
  onUse: (v: boolean) => void;
  onPrefer: (v: boolean) => void;
  large: boolean;
  onLarge?: (v: boolean) => void;
}) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const es = engineSaveStrings(lang);
  const writes = writesPrices(p.adoption) && use ? p.adoption : null;
  const notices: string[] = [];
  if (p.reason === 'estimated') notices.push(s.estimated);
  if (p.shadowed.length) notices.push(s.shadowed);
  for (const x of p.proposals) notices.push(s.proposedProfile(profileName(x.shipping_profile, lang)));
  if (p.cod_priced_as_direct) notices.push(s.cod);
  if (p.missing_codes.length) notices.push(s.incomplete(p.missing_codes.map((c) => issueText(c, lang)).join(lang === 'en' ? '; ' : '؛ ')));
  return (
    <article className="inventory-line" data-pricing-product={p.product_id}>
      <strong className={T.text1}>{p.label}</strong>
      {p.feeds && <label className="mt-2 flex gap-2 text-sm"><input type="checkbox" checked={use} onChange={(e) => onUse(e.target.checked)} />{s.usePurchase}</label>}
      {p.entries.some((e) => e.narrow) && <label className="mt-1 flex gap-2 text-sm"><input type="checkbox" checked={prefer} onChange={(e) => onPrefer(e.target.checked)} />{s.preferPurchase}</label>}
      {notices.length > 0 && <ul className={`mt-2 grid gap-1 text-[13px] ${T.text2}`}>{notices.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {writes ? (
        <div className="mt-2 grid gap-2" data-pricing-adoption={writes.kind}>
          <p className={`text-[13px] ${T.text1}`}>{writes.kind === 'adopt' ? es.adoptIntro : es.repriceIntro}</p>
          {engineNotices(writes, lang).length > 0 && <ul className={`grid gap-1 text-[13px] ${T.text2}`}>{engineNotices(writes, lang).map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <PricingRowsTable rows={adoptionRows(writes)} />
          {writes.large_change && onLarge && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={large} onChange={(e) => onLarge(e.target.checked)} data-pricing-large={p.product_id} />
              {es.largeTick}
              <span className={`text-[12px] ${T.text3}`}>{es.largeNote}</span>
            </label>
          )}
        </div>
      ) : (
        p.rows.length > 0 && <PricingRowsTable rows={p.rows} />
      )}
    </article>
  );
}

/**
 * Owner decision 8's six figures per model × channel — the current
 * replacement cost, the minimum profit, the new pre-order price, the Direct
 * Sale Extra, the new direct sale price, and old → new — as the server
 * answered them (the procurement review and the product form's «المعاينة
 * والحفظ» alike). It formats; it never computes.
 */
export function PricingRowsTable({ rows }: { rows: readonly PricingPreviewRow[] }) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const arrow = lang === 'en' ? '→' : '←';
  const modelName = (r: PricingPreviewRow) => (lang === 'en' ? r.name_en || r.name_ar : lang === 'ckb' ? r.name_ckb || r.name_ar : r.name_ar || r.name_en) || '—';
  return (
    <div className="mt-3 overflow-x-auto" data-pricing-rows>
      <table className="w-full min-w-[640px] text-start text-[13px] tabular-nums">
        <thead>
          <tr className={T.text3}>
            {[s.colModel, s.colChannel, s.colReplacement, s.colMinProfit, s.colNewPreorder, s.colExtra, s.colNewDirect, s.colOldNew].map((h) => (
              <th key={h} scope="col" className="border-b border-[var(--ap-border)] px-2 py-1.5 text-start font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const direct = r.channel === 'direct_sale';
            const fig = (v: React.ReactNode) => <bdi dir="ltr" className="whitespace-nowrap">{v}</bdi>;
            return (
              <tr key={`${r.option_id}:${r.channel}`} className="border-b border-[var(--ap-border)] align-top">
                <td className="px-2 py-1.5">{modelName(r)}</td>
                <td className="px-2 py-1.5">{channelName(r.channel, lang)}</td>
                <td className="px-2 py-1.5">{fig(money(r.replacement_cost_iqd))}</td>
                <td className="px-2 py-1.5">{fig(r.target_profit_usd ? `$${r.target_profit_usd}` : money(r.target_profit_iqd))}</td>
                <td className="px-2 py-1.5">{fig(direct ? money(r.preorder_base_iqd) : money(r.computed_price_iqd))}</td>
                <td className="px-2 py-1.5">{fig(direct ? money(r.direct_sale_extra_iqd) : '—')}</td>
                <td className="px-2 py-1.5">{fig(direct ? money(r.computed_price_iqd) : '—')}</td>
                <td className="px-2 py-1.5">
                  {r.computed_price_iqd == null
                    ? <span className={T.text3}>{r.issue_codes.map((c) => issueText(c, lang)).join(lang === 'en' ? '; ' : '؛ ') || '—'}</span>
                    : fig(`${money(r.today_prepaid_iqd)} ${arrow} ${money(r.computed_price_iqd)}`)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A SAVED purchase's pricing state (USD design §5.4 "Saved-document view",
 * §6.3 step 3): a product whose cost was not applied yet offers «اعتمدها
 * الآن»; a failed apply after the confirm offers «إعادة المحاولة» with the
 * values just typed; a cost from a cancelled purchase says so.
 */
export function SavedPurchasePricing({ preview, purchaseId, failures, choices, onDone, confirmLarge = {} }: {
  preview: PricingPreview | null;
  purchaseId: string;
  failures: Array<{ product_id: string; label: string; message: string; purchase_id: string }>;
  choices: PricingChoices;
  onDone: () => Promise<void> | void;
  /** The ticks given in the review before the confirm (a retry carries them). */
  confirmLarge?: Record<string, boolean>;
}) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const es = engineSaveStrings(lang);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const run = async (productId: string, withChoices: PricingChoices) => {
    const product = preview?.products.find((p) => p.product_id === productId);
    if (!product) return;
    setBusy(productId);
    setError('');
    try {
      const large = ticks[productId] === true || confirmLarge[productId] === true;
      try {
        await applyPurchase(productId, purchaseId, product.preview_hash, withChoices, large);
      } catch (e) {
        // The choices typed before the save differ from this view's: the refusal carries the fresh hash —
        // taken only when the prices it would write are the ones shown (never new prices unseen).
        const shown = e instanceof ApiError && e.code === 'PRICING_PREVIEW_STALE' ? (e.details?.preview as PricingProduct | null) : null;
        if (!shown?.preview_hash || !samePrices(shown.adoption, product.adoption)) throw e;
        await applyPurchase(productId, purchaseId, shown.preview_hash, withChoices, large);
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };
  const pending = (preview?.products ?? []).filter((p) => p.feeds && p.eligible && !p.applied && p.entries.some((e) => Object.keys(e.changes).length > 0));
  const cancelled = (preview?.products ?? []).filter((p) => p.cancelled_source);
  const ownFailures = failures.filter((f) => f.purchase_id === purchaseId);
  if (!pending.length && !cancelled.length && !ownFailures.length) return null;
  const empty: PricingChoices = { minimums: [], optIn: [], usePurchase: {}, prefer: {} };
  return (
    <section className="mb-4 grid gap-2" data-saved-pricing>
      {ownFailures.length > 0 && <p role="alert" className="text-[13px] text-[var(--ap-danger)]">{s.partial(String(ownFailures.length))}</p>}
      {ownFailures.map((f) => (
        <div key={f.product_id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className={T.text1}>{f.label}</span>
          <button type="button" className={T.btnSecondary} disabled={!!busy} onClick={() => run(f.product_id, choices)}>{s.retry}</button>
        </div>
      ))}
      {pending.filter((p) => !ownFailures.some((f) => f.product_id === p.product_id)).map((p) => {
        // An apply that writes prices shows them first (owner decision 8), with the tick above 15%.
        const writes = writesPrices(p.adoption) ? p.adoption : null;
        const needsTick = !!writes?.large_change && ticks[p.product_id] !== true;
        return (
          <div key={p.product_id} className="grid gap-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)] px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={T.text1}>{p.label}</span>
              <span className={T.text2}>{s.notApplied}</span>
              <button type="button" className={T.btnSecondary} disabled={!!busy || needsTick} onClick={() => run(p.product_id, empty)}>{s.applyNow}</button>
            </div>
            {writes && (
              <>
                <p className={`text-[13px] ${T.text2}`}>{writes.kind === 'adopt' ? es.adoptIntro : es.repriceIntro}</p>
                <PricingRowsTable rows={adoptionRows(writes)} />
                {writes.large_change && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={ticks[p.product_id] === true} onChange={(e) => setTicks((m) => ({ ...m, [p.product_id]: e.target.checked }))} />
                    {es.largeTick}
                  </label>
                )}
              </>
            )}
          </div>
        );
      })}
      {cancelled.map((p) => <p key={p.product_id} role="status" className={`text-sm ${T.text2}`}>{p.label} — {s.cancelledSource}</p>)}
      {error && <p role="alert" className="text-[13px] text-[var(--ap-danger)]">{error}</p>}
    </section>
  );
}
