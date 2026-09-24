/**
 * The store page's header and footer, by the layout's variant.
 *
 * `overlay` (classic): the way back on the physical top-LEFT as a bare glyph,
 * and the ⋯ menu on the top-RIGHT — fixed corners, not writing-direction ones —
 * floating over whatever the first block is (the classic cover). `bar`: the
 * same two controls in an in-flow top bar with the store's logo and name.
 * Both controls are the host's (runtime `Back` / `Menu`): they act.
 */
import { Store } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { FooterVariant, HeaderVariant } from '../../../packages/storeLayout/src/schema';
import { useStorefrontRuntime } from './runtime';
import { useStoreTheme } from './StoreTheme';
import { Column, sinceLine } from './parts';
import type { StorefrontStore } from './types';

export function StoreHeader({ variant, store }: { variant: HeaderVariant; store: StorefrontStore }) {
  const rt = useStorefrontRuntime();
  const { accent } = useStoreTheme();
  if (variant === 'none') return null;
  if (variant === 'bar') {
    return (
      <div className="border-b border-white/[0.06]">
        <Column className="h-14 flex items-center gap-3">
          <div dir="ltr" className="shrink-0">
            <rt.Back />
          </div>
          <div className={`w-8 h-8 rounded-full sf-bg border ${accent.ring} overflow-hidden flex items-center justify-center shrink-0`}>
            {store.logoUrl ? (
              <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <Store className="w-4 h-4 text-gold" strokeWidth={1.5} aria-hidden="true" />
            )}
          </div>
          <span className="flex-1 min-w-0 truncate text-white text-[14px] font-bold" dir="auto">
            {store.name}
          </span>
          <rt.Menu />
        </Column>
      </div>
    );
  }
  // overlay: two corner controls over the page top, above every block.
  return (
    <div className="absolute inset-x-0 top-0 z-20 pointer-events-none">
      <div className="absolute top-3 left-3 pointer-events-auto">
        <rt.Back />
      </div>
      <div className="absolute top-3 right-3 pointer-events-auto">
        <rt.Menu />
      </div>
    </div>
  );
}

export function StoreFooter({ variant, store }: { variant: FooterVariant; store: StorefrontStore }) {
  const rt = useStorefrontRuntime();
  const { loc, lang } = useLanguage();
  if (variant === 'none') return null;
  return (
    <Column className="mt-6">
      <rt.InstallCard />
      {variant === 'standard' && (
        <div className="mt-6 pt-4 border-t border-white/[0.06] text-center">
          <p className="text-zinc-300 text-[12.5px] font-semibold" dir="auto">
            {store.name}
          </p>
          {store.created_at && <p className="text-zinc-600 text-[11px] mt-0.5">{sinceLine(store.created_at, loc, lang)}</p>}
        </div>
      )}
    </Column>
  );
}
