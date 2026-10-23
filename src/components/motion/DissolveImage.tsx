// Lucian UX/UI Prompt #349 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#349
import React, { useEffect, useRef, useState } from 'react';
import SafeImage from '../ui/SafeImage';
import { useMediaQuery } from '../../lib/useMediaQuery';
import './media.css';

type Photo = { src: string; url: string; width: number; height: number };
type Reveal = { src: string; old: Photo; next: Photo; width: number; height: number; padding: number };

/** Wait for the selected image's actual load event; rapid selections replace the pending reveal. */
export default function DissolveImage(props: React.ComponentProps<typeof SafeImage>) {
  const root = useRef<HTMLDivElement>(null);
  const [last, setLast] = useState<Photo | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [failed, setFailed] = useState('');
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const src = props.src?.trim() ?? '';
  useEffect(() => {
    if (!reveal) return;
    if (reduced || reveal.src !== src) { setReveal(null); return; }
    const timer = window.setTimeout(() => setReveal(null), 1080);
    const resize = () => setReveal(null);
    window.addEventListener('resize', resize, { once: true });
    return () => { clearTimeout(timer); window.removeEventListener('resize', resize); };
  }, [reveal, reduced, src]);

  const background = (photo: Photo, width: number, height: number, padding = 12): React.CSSProperties => {
    const w = Math.max(1, width - padding * 2), h = Math.max(1, height - padding * 2);
    const scale = props.fit === 'cover' ? Math.max(w / photo.width, h / photo.height) : Math.min(w / photo.width, h / photo.height);
    return { backgroundImage: `url(${JSON.stringify(photo.url)})`, backgroundSize: `${photo.width * scale}px ${photo.height * scale}px`, backgroundPosition: `${(width - photo.width * scale) / 2}px ${(height - photo.height * scale) / 2}px`, backgroundColor: 'var(--color-surface)' };
  };
  const previous = !reduced && src && failed !== src && last && last.src !== src ? last : reveal?.src === src ? reveal.old : null;
  return <div className="u349" ref={root}>
    <SafeImage {...props} key={src} onStatus={(status, loadedSrc) => {
      props.onStatus?.(status, loadedSrc);
      if (loadedSrc !== src) return;
      if (status === 'error') { setFailed(src); setReveal(null); return; }
      if (status !== 'loaded') return;
      const image = root.current?.querySelector<HTMLImageElement>('img[data-main-image]');
      if (!image || !image.naturalWidth || last?.src === src) return;
      const next = { src, url: image.currentSrc || image.src, width: image.naturalWidth, height: image.naturalHeight };
      const box = root.current!.getBoundingClientRect();
      if (last && !reduced) setReveal({ src, old: last, next, width: box.width, height: box.height, padding: parseFloat(getComputedStyle(image).paddingTop) || 0 });
      setLast(next);
      setFailed('');
    }} />
    {previous && <div aria-hidden="true" className="u349-previous" style={{ backgroundImage: `url(${JSON.stringify(previous.url)})`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundColor: 'var(--color-surface)', backgroundOrigin: 'content-box', padding: 12 }} />}
    {reveal?.src === src && !reduced && <div key={src} className="u349-cells" aria-hidden="true">
      {Array.from({ length: 108 }, (_, i) => {
        const x = i % 12, y = Math.floor(i / 12);
        const bg = background(reveal.next, reveal.width, reveal.height, reveal.padding);
        const [left, top] = String(bg.backgroundPosition).split(' ').map(parseFloat);
        return <i key={i} style={{ ...bg, backgroundPosition: `${left - x * reveal.width / 12}px ${top - y * reveal.height / 9}px`, animationDelay: `${x * 45 + y * 12 + (i * 17 % 60)}ms` }} />;
      })}
    </div>}
  </div>;
}
