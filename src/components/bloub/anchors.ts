/** Shared layout registry. Only real mounted DOM anchors participate. */
/**
 * `stage` is a destination that OWNS the screen for a moment — today, the
 * order-confirmation panel. It outranks every dock because when it exists the
 * character's whole job is to be there; the header and the navigation are
 * still on screen, and without a higher priority the character would stay
 * docked in one of them while the page it belongs on waited for it.
 *
 * It is deliberately not `top-header`. Reusing that kind would have worked by
 * accident (nothing else on a full-screen route competes with it) and would
 * have made `anchor-travel` announce the journey as `navigating`, which is the
 * wrong thing for the character to feel on arriving somewhere to celebrate.
 */
export type AnchorKind = 'bottom-home' | 'top-header' | 'top-fallback' | 'stage';
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

/**
 * Whether the character is standing in the middle of the screen as the boot
 * loader right now — `AppIntro`'s `loading` phase, visible, on a route that
 * shows it.
 *
 * It exists for the busy overlay (src/components/ui/AppBusy.tsx). The shell's
 * first wait — resolving the host, reading the session — is held as a `route`
 * busy by `RouteFallback`, and a cold load on a phone takes longer than the
 * overlay's show delay. So the overlay used to draw its dimmed spinner OVER
 * the character, which is the site's own loading animation, on every cold
 * load: the one screen the character exists for, replaced by a generic
 * spinner. The overlay reads this and lets a route wait be the character's to
 * show while it is booting. It stays false when the intro never mounted (its
 * chunk failed, or has not arrived yet), so a route wait is never left with no
 * indicator at all.
 */
let booting = false;

export const characterLayout = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => revision,
  serverSnapshot: () => 0,
  pending: () => routeLoads > 0,
  hasPageAnchor: () => [...anchors.values()].some((a) => a.kind !== 'top-fallback'),
  renderFailed: () => renderFailed,
  booting: () => booting,
  serverBooting: () => false,
};

export function setCharacterRenderFailed(value: boolean): void {
  if (renderFailed === value) return;
  renderFailed = value;
  emit();
}

export function setCharacterBooting(value: boolean): void {
  if (booting === value) return;
  booting = value;
  emit();
}

/**
 * A STAGE IS APPEARED AT, NEVER FLOWN TO — AND NEVER FLOWN AWAY FROM.
 *
 * The confirmation panel raises a `stage`, and until now the character reached
 * it the way it reaches every dock: a journey from the header down the page,
 * with a wind-up that first moves AGAINST the travel, a straight descent and
 * a growth from header size to stage size on the way. The owner's verdict on
 * exactly that: «غير مناسب وغير مرح ويظهر الانيميشن عندما ينتقل من فوق الى
 * الاسفل بشكل خاطئ وبشكل يظهر فيه lagging». It was also the most expensive
 * thing the character ever does — the body is re-rasterised every frame while
 * its scale changes — started on the same frame the checkout tree unmounts.
 *
 * So a journey whose destination OR origin is a stage is not a journey. The
 * character vanishes from where it was and pops into being where it is going
 * (`character/entrance.ts`), which is transform and opacity on a compositor
 * layer and nothing else. A route change between two ordinary docks is still
 * the walk it always was; this answers only for the stage.
 */
export function appearsInsteadOfTravelling(from: AnchorKind | null, to: AnchorKind): boolean {
  return to === 'stage' || from === 'stage';
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

/**
 * ONE COORDINATE SPACE, AND IT IS THE LAYOUT VIEWPORT.
 *
 * Everything the character positions itself with is expressed in LAYOUT-
 * viewport coordinates: the rectangles `getBoundingClientRect()` reports, the
 * `left`/`top` origin of a `position: fixed` element with `transform-origin:
 * 0 0`, and the `clientX`/`clientY` the pointer arrives with.
 *
 * `window.visualViewport` is a DIFFERENT space. It describes the part of that
 * layout viewport the user can currently see, once the URL bar, the software
 * keyboard or a pinch-zoom have had their say — and `offsetLeft`/`offsetTop`
 * are exactly the vector that converts one space into the other.
 *
 * So the rule, and the reason both helpers below exist: read the visual
 * viewport only when the question is genuinely "what can the user SEE",
 * convert it with the offsets in the same expression, and never let a visual
 * measurement reach arithmetic that also involves a client rectangle. Mixing
 * them is invisible on a desktop, where the two spaces coincide, and offsets
 * the whole character by the visual offset on the one device — an iPad with a
 * collapsing URL bar or a pinched page — where they do not.
 */
export interface ViewportHost {
  innerWidth: number;
  innerHeight: number;
  visualViewport?: { width: number; height: number; offsetLeft: number; offsetTop: number } | null;
  document?: { documentElement?: { clientWidth: number; clientHeight: number } | null } | null;
}

const viewportHost = (win?: ViewportHost): ViewportHost | null =>
  win ?? (typeof window === 'undefined' ? null : (window as unknown as ViewportHost));

/**
 * The area the user can see, ALREADY IN LAYOUT COORDINATES — the offsets are
 * carried out, not discarded, so the result can be compared with an anchor
 * rectangle without a conversion step anyone can forget.
 */
export function visibleViewport(win?: ViewportHost): { width: number; height: number; offsetLeft: number; offsetTop: number } {
  const w = viewportHost(win);
  if (!w) return { width: 0, height: 0, offsetLeft: 0, offsetTop: 0 };
  const vv = w.visualViewport;
  // No visual viewport means the two spaces are the same one, so there is
  // nothing to offset from — a zero here is correct, not a missing value.
  if (!vv) return { width: w.innerWidth, height: w.innerHeight, offsetLeft: 0, offsetTop: 0 };
  return { width: vv.width, height: vv.height, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop };
}

/**
 * The LAYOUT viewport's size. This is the denominator for anything divided
 * into a distance that came from a client rectangle — the gaze's falloff,
 * above all. Using the visual viewport's size there instead put two spaces in
 * one fraction: a pinch-zoom shrinks the visual viewport while leaving every
 * client coordinate exactly where it was, so the character's reach silently
 * changed without anything it was measuring having moved.
 */
export function layoutViewport(win?: ViewportHost): { w: number; h: number } {
  const w = viewportHost(win);
  if (!w) return { w: 0, h: 0 };
  const root = w.document?.documentElement;
  return { w: root?.clientWidth || w.innerWidth, h: root?.clientHeight || w.innerHeight };
}

/**
 * THE ABSOLUTE FRAME FOR A MEASURED RECTANGLE.
 *
 * A pure function of the rectangle handed in and of nothing else — no previous
 * frame, no delta, no remembered offset. That is what makes a re-measurement a
 * CORRECTION rather than another increment: feeding the same rectangle twice
 * produces the same frame, and feeding a rectangle that moved produces the
 * frame for where it moved to, never for how far it travelled.
 *
 * The frame is the largest square centred in the rectangle, so a non-square
 * anchor still docks the character on the anchor's own centre.
 */
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
  const priority: Record<AnchorKind, number> = { stage: 4, 'top-header': 3, 'bottom-home': 2, 'top-fallback': 1 };
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
 *
 * The offsets are the coordinate-space conversion described above, NOT a
 * nudge: `viewport` is the visible area, and adding its origin expresses the
 * result in the same layout coordinates every anchor rectangle is already in.
 * Dropping them would place the character at the centre of the LAYOUT viewport
 * while claiming to centre it in what the user can see, which on a pinched or
 * keyboard-shortened iPad is somewhere off screen.
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
