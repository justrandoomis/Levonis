/**
 * A product's pictures and videos, in the merchant's order (W2-F media rows).
 *
 * The main frame shows one item; the strip under it chooses. A video is a
 * plain `<video controls>` — never autoplaying, `preload="metadata"` so a
 * store visit does not download 40 MB nobody asked for, `playsInline` so an
 * iPhone does not throw it full-screen. `focusUrl` (the chosen variant's own
 * picture) moves the frame to that picture when the choice changes.
 *
 * Every URL here came from the server as `/files/<key>` of the merchant's own
 * upload; nothing a merchant typed becomes an attribute other than `alt`.
 */
import { useEffect, useState } from 'react';
import { Play, ShoppingBag } from 'lucide-react';

export interface GalleryItem {
  kind: 'image' | 'video';
  url: string;
  alt: string;
}

export function ProductGallery({
  items,
  focusUrl,
  productName,
  videoLabel,
  showLabel,
}: {
  items: GalleryItem[];
  focusUrl: string | null;
  productName: string;
  videoLabel: string;
  /** «Show item n» — the thumbnail button's accessible name. */
  showLabel: (n: number) => string;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!focusUrl) return;
    const i = items.findIndex((m) => m.url === focusUrl);
    if (i >= 0) setIndex(i);
  }, [focusUrl, items]);
  const current = items[Math.min(index, items.length - 1)];

  return (
    <div>
      <div className="aspect-square sm:aspect-[4/3] bg-black/40 overflow-hidden">
        {!current ? (
          <div className="w-full h-full flex items-center justify-center">
            <ShoppingBag className="w-12 h-12 text-zinc-700" aria-hidden="true" />
          </div>
        ) : current.kind === 'video' ? (
          <video
            key={current.url}
            src={current.url}
            controls
            playsInline
            preload="metadata"
            aria-label={current.alt || `${productName} — ${videoLabel}`}
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          <img src={current.url} alt={current.alt || productName} className="w-full h-full object-cover" />
        )}
      </div>
      {items.length > 1 && (
        <div className="flex gap-2 overflow-x-auto hide-scrollbar px-4 sm:px-6 py-3">
          {items.map((m, i) => (
            <button
              key={m.url}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={showLabel(i + 1)}
              aria-current={i === index ? 'true' : undefined}
              className={`relative w-16 h-16 rounded-xl overflow-hidden shrink-0 border ${i === index ? 'border-gold' : 'border-white/10'} focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold`}
            >
              {m.kind === 'video' ? (
                <span className="flex w-full h-full items-center justify-center bg-black/60">
                  <Play className="w-5 h-5 text-white" aria-hidden="true" />
                </span>
              ) : (
                <img src={m.url} alt="" loading="lazy" className="w-full h-full object-cover" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
