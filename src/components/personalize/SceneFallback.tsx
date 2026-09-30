/**
 * THE LOOK CARD ON THE STAGE — painted at once, before (or instead of) the
 * live model (docs/LEVO_PROJECT_PROGRAMME.md §B.2 «Fallback — the look
 * card»; survey «States»). A model product paints its captured poster
 * through the region-id map in the configuration's colours with each area's
 * artwork in its quad (./lookcard.ts); a photo-only product paints the
 * merchant's own photo for the chosen colour and size, the artwork in the
 * area's quad drawn on it. Deterministic: the same choices, the same pixels.
 *
 * It is what a phone without WebGL, a lost context, a browser that cannot
 * inflate the model (iOS < 16.4) and Save-Data see — every control still
 * works, and the choices are kept exactly.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignConfig, PublicBlueprint, PublicPhoto } from '../../../packages/catalog/src/personalize/types';
import { decodeIdMap, paintCard, type CardLayer, type Rgb255 } from './lookcard';
import { loadImage } from './art';

/**
 * The merchant's photo for these choices: every value it names must be chosen
 * (its colour is a part's colour — a text's own colour never picks a photo);
 * the most specific wins.
 */
export function photoFor(pub: PublicBlueprint, made: DesignConfig): PublicPhoto | null {
  const chosen = new Set(Object.values(pub.variants.find((v) => v.id === made.variant)?.values ?? {}));
  const colours = new Set(pub.regions.map((r) => made.colors[r.id]));
  let best: PublicPhoto | null = null;
  let score = -1;
  for (const p of pub.photos) {
    if ((p.colour && !colours.has(p.colour)) || (p.value_id && !chosen.has(p.value_id))) continue;
    const s = (p.colour ? 2 : 0) + (p.value_id ? 1 : 0);
    if (s > score) [best, score] = [p, s];
  }
  return best ?? pub.photos[0] ?? null;
}

export interface SceneFallbackProps {
  pub: PublicBlueprint;
  made: DesignConfig;
  /** Region index → 0–255 RGB. */
  colours: readonly Rgb255[];
  /** Area id → its artwork (./art.ts), null while empty. */
  arts: Record<string, HTMLCanvasElement | null>;
  onPainted?: (painted: boolean) => void;
  /** While the live model covers it, the card is not repainted (it catches up when shown again). */
  paused?: boolean;
  className?: string;
}

export function SceneFallback({ pub, made, colours, arts, onPainted, paused = false, className = '' }: SceneFallbackProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const photo = pub.look ? null : photoFor(pub, made);
  const url = pub.look?.poster_url ?? photo?.url ?? null;
  const [loaded, setLoaded] = useState<{ url: string; img: HTMLImageElement } | null>(null);
  const ids = useMemo(() => (pub.look ? decodeIdMap(pub.look.idmap) : null), [pub.look]);
  const painted = useRef(onPainted);
  painted.current = onPainted;

  useEffect(() => {
    let live = true;
    if (!url) {
      painted.current?.(false);
      return;
    }
    loadImage(url).then(
      (img) => live && setLoaded({ url, img }),
      () => live && painted.current?.(false)
    );
    return () => {
      live = false;
    };
  }, [url]);

  useEffect(() => {
    const el = canvas.current;
    const img = loaded?.url === url ? loaded.img : null;
    if (!el || !img || paused) return;
    const layers: CardLayer[] = [];
    for (const a of pub.areas) {
      const art = arts[a.id];
      const quad = pub.look ? pub.look.quads[a.id] : a.photo_frame?.quad;
      if (art && quad) layers.push({ quad, art });
    }
    paintCard(el, { image: img, w: pub.look?.w ?? img.naturalWidth, h: pub.look?.h ?? img.naturalHeight }, ids, colours, layers);
    painted.current?.(true);
  }, [loaded, url, ids, colours, arts, pub, paused]);

  return <canvas ref={canvas} aria-hidden="true" data-look-card className={`h-full w-full object-contain ${className}`} />;
}
