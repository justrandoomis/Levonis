/** Shared layout registry. Only real mounted DOM anchors participate. */
export type AnchorKind = 'bottom-home' | 'top-header' | 'top-fallback';
export type CharacterFrame = { x: number; y: number; size: number };
export type CharacterAnchor = { element: HTMLElement; kind: AnchorKind; busy: boolean };
const anchors = new Map<HTMLElement, CharacterAnchor>();
const listeners = new Set<() => void>();
let revision = 0;
let routeLoads = 0;
const emit = () => { revision += 1; for (const listener of listeners) listener(); };

export const characterLayout = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => revision,
  serverSnapshot: () => 0,
  pending: () => routeLoads > 0,
  hasPageAnchor: () => [...anchors.values()].some((a) => a.kind !== 'top-fallback'),
};

export function registerCharacterAnchor(element: HTMLElement, kind: AnchorKind, busy = false): () => void {
  const entry = { element, kind, busy };
  anchors.set(element, entry);
  emit();
  return () => {
    if (anchors.get(element) !== entry) return;
    anchors.delete(element);
    element.removeAttribute('data-bloub-occupied');
    emit();
  };
}

/** A Suspense fallback is actual pending work, not an invented intro delay. */
export function beginCharacterRouteLoad(): () => void {
  routeLoads += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    routeLoads = Math.max(0, routeLoads - 1);
    emit();
  };
}

export function frameFromRect(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): CharacterFrame | null {
  const { left, top, width, height } = rect;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const size = Math.min(width, height);
  return { x: left + (width - size) / 2, y: top + (height - size) / 2, size };
}

/** Retained for existing callers; physical coordinates work in RTL and LTR. */
export function measureHomeTarget(root?: ParentNode): CharacterFrame | null {
  const parent = root ?? (typeof document !== 'undefined' ? document : null);
  const element = parent?.querySelector<HTMLElement>('[data-bloub-home-target]');
  return element ? frameFromRect(element.getBoundingClientRect()) : null;
}

export function measureCharacterAnchor(): (CharacterAnchor & { frame: CharacterFrame }) | null {
  const priority: Record<AnchorKind, number> = { 'top-header': 3, 'bottom-home': 2, 'top-fallback': 1 };
  for (const anchor of [...anchors.values()].sort((a, b) => priority[b.kind] - priority[a.kind])) {
    if (!anchor.element.isConnected) continue;
    const style = window.getComputedStyle(anchor.element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const frame = frameFromRect(anchor.element.getBoundingClientRect());
    if (frame) return { ...anchor, frame };
  }
  return null;
}

export function bootstrapCharacterFrame(viewport: { width: number; height: number; offsetLeft?: number; offsetTop?: number }): CharacterFrame {
  const size = Math.min(240, Math.max(144, viewport.width * 0.38), Math.max(44, viewport.height * 0.45));
  return {
    x: (viewport.offsetLeft ?? 0) + (viewport.width - size) / 2,
    y: (viewport.offsetTop ?? 0) + (viewport.height - size) / 2,
    size,
  };
}

export const CHARACTER_CANVAS = 128;
export function characterTransform(frame: CharacterFrame): string {
  return `translate3d(${frame.x}px, ${frame.y}px, 0) scale(${frame.size / CHARACTER_CANVAS})`;
}
