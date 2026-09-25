/**
 * THE BUILDER'S CANVAS — the storefront's own renderer, laid out at a device
 * width and scaled to fit, with the block under the pointer selectable.
 *
 * NO IFRAME (the CSP forbids framing): the page is rendered in place inside a
 * container, and the blocks answer the CONTAINER's width (`@container`), so a
 * 360px frame lays out like a 360px phone. The page itself is `inert` — no
 * link, button or field in it can be focused or pressed; it is a live picture
 * of the page. Selecting a block is done by POSITION: a click on the canvas is
 * mapped to the `[data-block-id]` element under it, so nothing inside the
 * merchant's page ever needs a handler. The keyboard path to the same choice
 * is the block list beside it.
 *
 * A block that renders nothing yet (a text block with no words, a coupon
 * block with no coupon) is drawn as a dashed placeholder here only
 * (./builder.css) — the storefront shows nothing, and so does a visitor's.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLanguage } from '../../../LanguageContext';

export const DEVICE_WIDTHS = { phone: 360, tablet: 768, desktop: 1280 } as const;
export type Device = keyof typeof DEVICE_WIDTHS;

interface Ring {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function PreviewCanvas({
  width,
  children,
  selectedId,
  onSelect,
  maxHeight = 'min(72dvh, 760px)',
  className = '',
  label,
}: {
  width: number;
  children: ReactNode;
  selectedId?: string | null;
  onSelect?: (blockId: string) => void;
  maxHeight?: string;
  className?: string;
  label?: string;
}) {
  const { loc, dir } = useLanguage();
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(width);
  const [height, setHeight] = useState(480);
  const [ring, setRing] = useState<Ring | null>(null);
  const [hover, setHover] = useState<Ring | null>(null);
  const scale = Math.min(1, avail / width);

  // The empty-block placeholder speaks the editor's language; the words are ours, never the merchant's.
  const emptyWords = loc('قسم لا يظهر بعد — أكمل إعداداته', 'Not showing yet — complete its settings');

  const rectOf = useCallback((el: Element): Ring | null => {
    const o = outer.current;
    if (!o) return null;
    const r = el.getBoundingClientRect();
    const b = o.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { top: r.top - b.top + o.scrollTop, left: r.left - b.left + o.scrollLeft, width: r.width, height: r.height };
  }, []);

  const measureRing = useCallback(() => {
    const i = inner.current;
    if (!i || !selectedId) {
      setRing(null);
      return;
    }
    const el = i.querySelector(`[data-block-id="${CSS.escape(selectedId)}"]`);
    setRing(el ? rectOf(el) : null);
  }, [rectOf, selectedId]);

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setAvail(o.clientWidth);
      setHeight(i.scrollHeight);
      measureRing();
    });
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, [measureRing]);

  // A block chosen in the list is brought into view here.
  useLayoutEffect(() => {
    measureRing();
    const o = outer.current;
    const el = selectedId ? inner.current?.querySelector(`[data-block-id="${CSS.escape(selectedId)}"]`) : null;
    if (!o || !el) return;
    const r = rectOf(el);
    if (!r) return;
    if (r.top < o.scrollTop || r.top + Math.min(r.height, 120) > o.scrollTop + o.clientHeight) {
      o.scrollTo({ top: Math.max(0, r.top - 24), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }, [selectedId, width, children, measureRing, rectOf]);

  const blockAt = useCallback((x: number, y: number): Element | null => {
    const i = inner.current;
    if (!i) return null;
    let best: Element | null = null;
    let bestArea = Infinity;
    for (const el of i.querySelectorAll('[data-block-id]')) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width * r.height < bestArea) {
        best = el;
        bestArea = r.width * r.height;
      }
    }
    return best;
  }, []);

  const style = useMemo(
    () => ({ width: `${width}px`, transform: `scale(${scale})`, transformOrigin: 'top left', marginInline: scale === 1 ? 'auto' : undefined }),
    [width, scale]
  );

  return (
    <div
      ref={outer}
      dir="ltr"
      data-sd-canvas
      className={`relative w-full overflow-y-auto overflow-x-hidden rounded-2xl border border-border-subtle bg-canvas overscroll-contain ${onSelect ? 'cursor-pointer' : ''} ${className}`}
      style={{ maxHeight, ['--sd-empty' as string]: JSON.stringify(emptyWords) }}
      role="img"
      aria-label={label ?? loc('معاينة صفحة المتجر', 'Store page preview')}
      onClick={
        onSelect
          ? (e) => {
              const el = blockAt(e.clientX, e.clientY);
              const id = el?.getAttribute('data-block-id');
              if (id) onSelect(id);
            }
          : undefined
      }
      onPointerMove={
        onSelect
          ? (e) => {
              if (e.pointerType !== 'mouse') return;
              const el = blockAt(e.clientX, e.clientY);
              const r = el && el.getAttribute('data-block-id') !== selectedId ? rectOf(el) : null;
              setHover((prev) => (prev && r && prev.top === r.top && prev.height === r.height ? prev : r));
            }
          : undefined
      }
      onPointerLeave={() => setHover(null)}
    >
      <div style={{ height: `${Math.ceil(height * scale)}px` }}>
        <div ref={inner} style={style} inert>
          {/* Laid out left-to-right so the scale anchors at one known corner;
              the page inside keeps the reader's direction. */}
          <div dir={dir}>{children}</div>
        </div>
      </div>
      {hover && <div aria-hidden="true" className="sd-ring sd-ring-hover" style={hover} />}
      {ring && <div aria-hidden="true" className="sd-ring" style={ring} />}
    </div>
  );
}
