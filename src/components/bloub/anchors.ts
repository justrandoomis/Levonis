/** Shared layout registry. Only real mounted DOM anchors participate. */
export type AnchorKind = 'bottom-home' | 'top-header' | 'top-fallback';
export type CharacterFrame = { x: number; y: number; size: number };
export type CharacterAnchor = { element: HTMLElement; kind: AnchorKind; busy: boolean };
const anchors = new Map<HTMLElement, CharacterAnchor>();
const listeners = new Set<() => void>();
let revision = 0;
let routeLoads = 0;
const emit = () => { revision += 1; for (const listener of listeners) listener(); };

/**
 * Whether the drawn character is currently unavailable.
 *
 * This exists so the Home slot can show a plain letter when — and ONLY when —
 * the SVG has genuinely failed to render. It used to show that letter all the
 * time and merely hide it once the character docked, which meant the very
 * first thing a visitor saw in the navigation bar was a second, competing Home
 * mark that then blinked out as the character landed on it. That is the "one
 * mascot disappears and another appears" the brief rules out, seen from the
 * other side.
 */
let renderFailed = false;

export const characterLayout = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => revision,
  serverSnapshot: () => 0,
  pending: () => routeLoads > 0,
  hasPageAnchor: () => [...anchors.values()].some((a) => a.kind !== 'top-fallback'),
  renderFailed: () => renderFailed,
};

export function setCharacterRenderFailed(value: boolean): void {
  if (renderFailed === value) return;
  renderFailed = value;
  emit();
}

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

/**
 * WHERE THE CHARACTER STANDS BEFORE THERE IS A PAGE.
 *
 * The first visit is the one moment it has the screen to itself, and the brief
 * is explicit that it should be LARGE there. The previous sizing did not
 * deliver that on the device it matters most on: `width * 0.38` on a 390px
 * phone is 148px, so the floor decided the size and the character arrived
 * about as big as a large app icon.
 *
 * Reading from the SHORTER dimension fixes it. A phone is tall and narrow, a
 * tablet wide and short, and the thing that actually constrains a centred
 * circle is whichever side is smaller — so that is what it is a fraction of.
 * The cap is the only other guard, and it is there because past roughly this
 * size the character stops reading as a character and starts reading as a
 * splash screen.
 */
export function bootstrapCharacterFrame(viewport: { width: number; height: number; offsetLeft?: number; offsetTop?: number }): CharacterFrame {
  const short = Math.min(viewport.width, viewport.height);
  const size = Math.min(320, Math.max(180, short * 0.52));
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
