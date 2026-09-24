/**
 * STORE THEME — the element every store page renders inside.
 *
 * It sets one data attribute per token on `[data-store-theme]` (the closed
 * tables in theme.ts), and theme.css — which a page imports through ./styles —
 * turns those into CSS custom properties and component classes. No merchant
 * string ever reaches CSS: a token is an enum, the attribute value is the
 * enum, and the stylesheet is ours.
 *
 * The context below hands blocks the resolved tokens and the accent's class
 * set, so a block never re-derives either.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { StoreAccent, ThemeTokens } from '../../../packages/storeLayout/src/tokens';
import { accentFor, ACCENTS, safeTokens, themeAttributes, type AccentClasses } from './theme';

export interface StoreThemeValue {
  tokens: ThemeTokens;
  accent: AccentClasses;
  accentName: StoreAccent;
}

const StoreThemeContext = createContext<StoreThemeValue>({
  tokens: safeTokens(null),
  accent: ACCENTS.default,
  accentName: 'default',
});

export function useStoreTheme(): StoreThemeValue {
  return useContext(StoreThemeContext);
}

export default function StoreTheme({
  tokens,
  storeAccent,
  className = '',
  children,
}: {
  tokens: Partial<ThemeTokens> | null | undefined;
  /** The accent from store settings, used when the token says `store`. */
  storeAccent: unknown;
  className?: string;
  children: ReactNode;
}) {
  const value = useMemo<StoreThemeValue>(() => {
    const safe = safeTokens(tokens);
    const accent = accentFor(safe, storeAccent);
    return { tokens: safe, accent: accent.classes, accentName: accent.name };
  }, [tokens, storeAccent]);
  return (
    <StoreThemeContext.Provider value={value}>
      <div {...themeAttributes(value.tokens)} className={className}>
        {children}
      </div>
    </StoreThemeContext.Provider>
  );
}
