/**
 * THE TASTE FUNCTIONS, AFTER FIRST PAINT (the engine budget: `personalize-
 * taste`, ≤ 5 KB gzip). Themes, «Choose for me», «Make it better» and
 * «Surprise me» (packages/catalog/src/personalize/{themes,suggest}.ts) are
 * never imported statically by the studio: the studio renders, prices and
 * checks without them, asks for them when the browser is idle after its first
 * paint, and the ✨ chips and the Look panel's themes wait for them.
 *
 * Only dynamic imports here — a static one would put the taste chunk back in
 * the studio's first paint.
 */
import { useEffect, useState } from 'react';

export type Taste = typeof import('../../../packages/catalog/src/personalize/themes') & typeof import('../../../packages/catalog/src/personalize/suggest');

let loaded: Taste | null = null;
let loading: Promise<Taste> | null = null;
const waiting = new Set<(t: Taste) => void>();

/** The taste functions, fetched once per page (a failed fetch is asked again next time). */
export function loadTaste(): Promise<Taste> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= Promise.all([import('../../../packages/catalog/src/personalize/themes'), import('../../../packages/catalog/src/personalize/suggest')])
    .then(([themes, suggest]) => {
      loaded = { ...themes, ...suggest };
      for (const w of waiting) w(loaded);
      return loaded;
    })
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

/** The taste functions once they are here (null before); asked for when the browser is idle after the first paint. */
export function useTaste(): Taste | null {
  const [taste, setTaste] = useState<Taste | null>(loaded);
  useEffect(() => {
    if (loaded) return;
    waiting.add(setTaste);
    const w = window as IdleWindow;
    const ask = () => void loadTaste().catch(() => undefined);
    const idle = !!w.requestIdleCallback && !!w.cancelIdleCallback;
    const id = idle ? w.requestIdleCallback!(ask, { timeout: 2000 }) : window.setTimeout(ask, 1200);
    return () => {
      waiting.delete(setTaste);
      if (idle) w.cancelIdleCallback!(id);
      else window.clearTimeout(id);
    };
  }, []);
  return taste;
}
