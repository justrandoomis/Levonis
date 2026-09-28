/**
 * «احفظ» AND «شارك» ON A STORE'S PRODUCT PAGE (review of Levo Community,
 * 2026-09-28). The store's product cards had the heart and the store had its
 * share, but the product page — the one a customer sends to a friend or comes
 * back to — had neither.
 *
 * The heart is the cards' own (`/api/community-favorites`, per viewer): it
 * shows the saved state once the viewer's saved ids answer, a second tap while
 * the first is in flight is dropped, and a refusal puts it back. Share opens
 * the system sheet, else copies the address and says so.
 *
 * A lazy chunk of its own: the store pages keep to their budget
 * (tests/bundleBudget.test.ts), and these two buttons can arrive a moment
 * after the product does.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Heart, Link2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { communityFavoritesApi } from '../../lib/storefrontApi';

export default function ProductActions({ productId, name }: { productId: string; name: string }) {
  const { loc } = useLanguage();
  const { user } = useAuth();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    communityFavoritesApi
      .ids()
      .then((d) => alive && setSaved(d.product_ids.includes(productId)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user, productId]);

  function toggle() {
    if (!user) {
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    if (busy.current) return;
    busy.current = true;
    const want = !saved;
    setSaved(want);
    (want ? communityFavoritesApi.add(productId) : communityFavoritesApi.remove(productId))
      .catch(() => setSaved(!want))
      .finally(() => {
        busy.current = false;
      });
  }

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: name, url });
        return;
      }
    } catch {
      return; // the sheet was closed — not a reason to copy as well
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  const round =
    'flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-200 transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  return (
    <div className="flex shrink-0 items-center gap-2" data-product-actions>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={saved}
        aria-label={saved ? loc('إزالة من المحفوظات', 'Remove from saved', 'لابردن') : loc('حفظ المنتج', 'Save product', 'پاشەکەوتکردن')}
        className={round}
        data-product-save={saved ? 'on' : 'off'}
      >
        <Heart aria-hidden="true" className={`h-[18px] w-[18px] ${saved ? 'fill-rose-500 text-rose-500' : ''}`} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={share}
        // OWNER: Sorani to be written by hand.
        aria-label={copied ? loc('نُسخ الرابط', 'Link copied') : loc('مشاركة المنتج', 'Share the product')}
        className={round}
        data-product-share
      >
        {copied ? (
          <Check aria-hidden="true" className="h-[18px] w-[18px] text-emerald-400" strokeWidth={1.75} />
        ) : (
          <Link2 aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.75} />
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? loc('نُسخ الرابط', 'Link copied') : ''}
      </span>
    </div>
  );
}
