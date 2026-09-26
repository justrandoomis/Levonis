/**
 * THE LANGUAGE CHANGE, PLAYED IN — «عند اختيار لغة انجليزية او عربي في اختلاف
 * ال RTL و LTR يكون هنالك انيميشن سلس وبهدوء ينتقل الكلام من اليمين الى اليسار
 * … انتقال بشكل بسيط وسلس وهدوء تام».
 *
 * `LanguageProvider.setLang` hands its commit to `runLanguageSwap`, so every
 * switcher in the shop (the header sheet, Settings, the auth shell, the
 * welcome page) gets the same motion without knowing about it.
 *
 * THREE WAYS, picked by what the browser can do and what the reader asked for:
 *
 *  - 'vt': View Transitions. The browser snapshots the page, the new language
 *    is committed synchronously (flushSync) inside the update, and the old
 *    snapshot fades out drifting a few pixels toward the side it read from
 *    while the new one fades in from the side IT reads from. Arabic ↔ Sorani
 *    share a direction, so there it is only a cross-fade. The CSS is
 *    src/index.css, THE LANGUAGE ARRIVING — the classes below only select it.
 *    The update waits (briefly) for the new language's fonts, so the new
 *    snapshot is not taken in a fallback face.
 *  - 'css': no View Transitions (older Safari). The language commits as it
 *    always did and `data-lang-swap` on <html> plays `main` in — the one
 *    fallback that already existed; LanguageContext sets it.
 *  - 'instant': reduced motion, a hidden tab, or no DOM (tests, SSR).
 *
 * Nothing here writes a style into the document: a class, a data attribute and
 * the browser's own View Transition — the CSP is exactly what it was.
 */
import { flushSync } from 'react-dom';

export type LangDir = 'rtl' | 'ltr';
export type LangSwapMode = 'vt' | 'css' | 'instant';

type ViewTransitionLike = { ready: Promise<void>; finished: Promise<void> };
type DocumentWithViewTransition = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => ViewTransitionLike;
};

/** How long the new snapshot may wait for its fonts before it is taken anyway. */
export const LANG_FONT_WAIT_MS = 180;
/** The View Transition's length (index.css keeps the same numbers). */
export const LANG_SWAP_MS = 420;

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

function reducedMotion(): boolean {
  try {
    return window.matchMedia(REDUCE_QUERY).matches;
  } catch {
    return false;
  }
}

/** Which of the three ways a change made right now would take. */
export function languageSwapMode(): LangSwapMode {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 'instant';
  if (reducedMotion() || document.visibilityState === 'hidden') return 'instant';
  const doc = document as DocumentWithViewTransition;
  return typeof doc.startViewTransition === 'function' ? 'vt' : 'css';
}

/**
 * The flow of a change: 'to-ltr' (Arabic/Sorani → English), 'to-rtl' (the
 * reverse), or 'same' (Arabic ↔ Sorani — a cross-fade, nothing travels).
 */
export function languageFlow(from: LangDir, to: LangDir): 'to-ltr' | 'to-rtl' | 'same' {
  if (from === to) return 'same';
  return to === 'ltr' ? 'to-ltr' : 'to-rtl';
}

/** Resolves when the fonts are ready, or after `ms` — whichever is first. */
function fontsSettled(ms: number): Promise<void> {
  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  if (!fonts?.ready) return Promise.resolve();
  return Promise.race([
    fonts.ready.then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
  ]).catch(() => undefined);
}

/**
 * Commit a language change the way `mode` says. `commit` must update React
 * state; in the 'vt' way it is run inside `flushSync` so the DOM holds the new
 * language before the browser takes its second snapshot.
 */
export function runLanguageSwap(mode: LangSwapMode, from: LangDir, to: LangDir, commit: () => void): void {
  if (mode !== 'vt') {
    commit();
    return;
  }
  const root = document.documentElement;
  const doc = document as DocumentWithViewTransition;
  root.classList.add('lv-lang-vt');
  root.setAttribute('data-lang-flow', languageFlow(from, to));
  const clear = () => {
    root.classList.remove('lv-lang-vt');
    root.removeAttribute('data-lang-flow');
  };
  let vt: ViewTransitionLike;
  try {
    vt = doc.startViewTransition!(async () => {
      flushSync(commit);
      // The provider's effect sets these too; set here so the snapshot never
      // depends on when React flushes its passive effects.
      root.dir = to;
      await fontsSettled(LANG_FONT_WAIT_MS);
    });
  } catch {
    clear();
    commit();
    return;
  }
  vt.finished.finally(clear).catch(() => {});
}
