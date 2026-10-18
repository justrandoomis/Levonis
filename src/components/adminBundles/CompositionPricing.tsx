/**
 * ٣ «السعر» OF A BUNDLE OR A MYSTERY BOX — THE PRODUCT FORM'S OWN SECTION ٣
 * (the owner's decision of 2026-10-18, DECISIONS row 251).
 *
 * A composition is priced like an ordinary product: from its cost («من
 * التكلفة») or a dollar price («سعر بالدولار»), with its minimum profit, the
 * rounding rule and the dollar as the base. So this is not a second editor:
 * it mounts the same `PricesSectionV2` over the same `useV2Pricing` state, and
 * saves through the same prices-only door every product has
 * (`PUT /api/admin/products-v2/:id/pricing`), with the same review sheet when
 * a customer price moves. The composition has one SKU sold direct: no models,
 * no colours, no structure of its own to send (its contents are section ٢).
 *
 * NO PRICING MATHS RUNS IN THE BROWSER: every figure is the server's answer.
 */
import { useCallback, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import PricesSectionV2 from '../adminProducts/form/v2/PricesSectionV2';
import ReviewSheetV2 from '../adminProducts/form/v2/ReviewSheetV2';
import { useV2Pricing, V2PricingProvider } from '../adminProducts/form/v2/useV2Pricing';
import { previewOf } from '../adminProducts/form/v2/v2Model';
import { btnPrimary } from '../adminProducts/form/formUi';

const NO_LIVE = { options: new Set<string>(), models: new Set<string>(), colours: new Set<string>() };
const NO_PACKAGES = {};
const NO_STRUCTURE = () => ({ doc: {}, relations: {} });
const NO_NAMES = () => null;
const NO_JUMP = () => undefined;
const REVIEW_CODES = new Set(['PRICING_PREVIEW_REQUIRED', 'PRICING_PREVIEW_STALE', 'PRICING_LARGE_CHANGE_CONFIRM']);

export default function CompositionPricing({
  productId,
  loc,
  onSaved,
}: {
  /** The saved composition (a new one is priced after its first save). */
  productId: string;
  loc: (ar: string, en: string, ckb: string) => string;
  /** After a price write: the panel reads the bundle again («يحتاج تسعيرًا» clears once it is priced). */
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const v2 = useV2Pricing({
    enabled: true,
    productId,
    draftId: productId,
    ownerHint: user?.can_view_cost === true,
    structureOf: NO_STRUCTURE,
    structureKey: '',
    structureDirty: false,
    live: NO_LIVE,
    packageDims: null,
    optionPackages: NO_PACKAGES,
  });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const save = useCallback(
    async (confirm?: { hash: string; confirmLarge: boolean }) => {
      const block = v2.saveBlock('active', confirm);
      const stored = v2.stored;
      if (!block || !stored) return;
      setBusy(true);
      setNote('');
      setError('');
      try {
        await api.put(`/api/admin/products-v2/${encodeURIComponent(productId)}/pricing`, { seq: stored.seq, ...block });
        v2.afterSave();
        setNote(loc('حُفظت الأسعار', 'Prices saved', 'نرخەکان پاشەکەوت کران'));
        onSaved();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // THE ONE SHEET: prices move — the server's preview of exactly what this write publishes.
        const preview = e instanceof ApiError ? previewOf(e.details) : null;
        if (e instanceof ApiError && preview && REVIEW_CODES.has(e.code ?? '')) {
          v2.openReview(preview, 'active');
          if (e.code === 'PRICING_PREVIEW_STALE' && confirm) v2.reviewError(message);
          return;
        }
        if (v2.review) v2.reviewError(message, e instanceof ApiError && e.code === 'REAUTH_REQUIRED');
        else setError(message);
      } finally {
        setBusy(false);
      }
    },
    [v2, productId, loc, onSaved]
  );

  return (
    <V2PricingProvider value={v2}>
      <PricesSectionV2 modelNames={NO_NAMES} firstModelId={null} packageDims={null} onJump={NO_JUMP} productId={productId} />
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3">
        <button type="button" className={btnPrimary} disabled={busy || !v2.stored || !v2.money} onClick={() => void save()} data-composition-pricing-save>
          {loc('احفظ الأسعار', 'Save prices', 'نرخەکان پاشەکەوت بکە')}
        </button>
        <span className="min-w-0 text-[12px]" aria-live="polite">
          {error ? <span className="text-red-400">{error}</span> : note ? <span className="text-text-secondary">{note}</span> : null}
        </span>
      </div>
      {v2.review && (
        <ReviewSheetV2
          key={v2.review.preview.review_hash ?? 'review'}
          preview={v2.review.preview}
          busy={busy}
          error={v2.review.error}
          reauth={v2.review.reauth}
          onConfirm={(confirmLarge) => {
            const hash = v2.review?.preview.review_hash;
            if (hash) void save({ hash, confirmLarge });
          }}
          onCancel={v2.closeReview}
          onSignIn={() => window.location.assign(`/auth?next=${encodeURIComponent(`/admin?tab=bundles&edit=${productId}`)}`)}
        />
      )}
    </V2PricingProvider>
  );
}
