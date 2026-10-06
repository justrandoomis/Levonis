/**
 * THE PURCHASE BAR AS ONE MORPHING CONTROL — «أضف إلى السلة» and ⚡ «شراء سريع»
 * (owner spec §4, over docs/GIFTS_QUICK_BUY.md §3.5).
 *
 * Two pill capsules, 6px apart, that read as one control:
 *
 *     cart mode    [ ⚡ ][ 🛒 أضف إلى السلة          ]
 *     quick mode   [ ⚡ شراء سريع           ][ 🛒 ]
 *
 * ⚡ sits at the inline START (the right in Arabic and Sorani, the left in
 * English) and grows toward the inline end, pushing the cart capsule aside
 * and taking its place. The bar's width never changes: the ⚡ capsule is
 * `C + D·p` wide and the cart capsule takes what is left, where `C` is the
 * compact circle (50px) and `D` the boundary's travel. ONE progress value
 * `p` ∈ [0, 1] drives everything at once — both widths, the cart label
 * clipped by its shrinking capsule and fading out over p ∈ [0, .45] while it
 * slides toward its icon, the cart icon gliding to the centre of the compact
 * circle, «شراء سريع» revealed from inside the growing capsule from p ≈ .3,
 * the ⚡ gliding from the centre to just before it, and the two looks (the
 * page's primary fill on the big cart capsule, the restrained gold accent on
 * the big quick one, each with a light elevation) crossfading. Nothing is
 * hidden and shown, and there is no state swap until the motion has settled.
 *
 * TAP. The compact ⚡ presses (0.97 → 1) and then pushes the boundary across
 * in 450ms on easeInOutCubic; the compact 🛒 does the exact reverse. A big
 * capsule does its own job — add to the cart, or buy — and never changes the
 * mode. Before ⚡ morphs, the page is asked whether the account is ready
 * (`requestQuick`): if it is not, the press plays with a small nudge and the
 * page opens the activation sheet, and when that completes the page sets
 * `quick` and the bar morphs on its own — no second tap.
 *
 * DRAG. The ⚡ capsule, compact or big, follows the finger horizontally:
 * p = clamp(p₀ + dx / D) along the inline axis. Released past 45% of the
 * travel (or flicked faster than 500px/s) it completes; otherwise it springs
 * back. A 6px slop tells a drag from a tap, a drag never buys or adds,
 * `touch-action: pan-y` leaves vertical scrolling to the page, and one light
 * haptic ticks when the drag crosses the threshold.
 *
 * NO RE-RENDER WHILE IT MOVES. `p` is a motion value; one subscriber writes
 * widths, transforms and opacities straight to the elements; React state is
 * committed once, when the motion settles (`onQuickChange`). The bar is
 * `contain: layout paint`, so the width animation lays out nothing outside
 * it (it keeps 4px inside its edge for the 2px+2px focus ring).
 *
 * REDUCED MOTION: no push and no travel — the layout changes at once and the
 * two looks crossfade in 180ms. Tapping always works; swiping is never needed.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { animate, useMotionValue } from 'motion/react';
import { Zap } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion, VelocityTracker } from '../../lib/motion';
import { quickBuyChrome } from './chromeStrings';

/** The compact capsule: a 50×50 circle. */
const C = 50;
/** The gap between the two capsules. */
const G = 6;
/** Room inside the bar's paint containment for the focus ring (2px + 2px offset). */
const PAD = 4;
const ICON = 20;
const ICON_GAP = 8;
/** Released past this share of the travel, a drag completes. */
const THRESHOLD = 0.45;
/** A flick faster than this (px/s) decides the end whatever the distance. */
const FLICK = 500;
/** Movement (px) before a press becomes a drag. */
const SLOP = 6;
const MORPH_S = 0.45;
const REDUCED_S = 0.18;
const EASE_IN_OUT: [number, number, number, number] = [0.65, 0, 0.35, 1];
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => x * x * (3 - 2 * x);

/** One short vibration where the device has one; nothing anywhere else. */
function haptic(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not allowed here: silence is the fallback */
  }
}

export interface QuickBuyBarProps {
  /** The mode the page has committed. */
  quick: boolean;
  /** A morph the customer made has settled: the page commits it (one render). */
  onQuickChange: (quick: boolean) => void;
  /**
   * Asked before ⚡ morphs. True: go. False: the account is not ready — the
   * page has opened the activation sheet and sets `quick` itself when it
   * completes, and the bar then morphs on its own.
   */
  requestQuick: () => Promise<boolean>;
  /** The finger or the focus is on ⚡: fetch the lazy chunks and the readiness now. */
  onWarm: () => void;
  cart: { icon: React.ReactNode; label: React.ReactNode; disabled: boolean; busy: boolean; onPress: () => void };
  buy: { disabled: boolean; busy: boolean; onPress: () => void };
}

interface Drag {
  id: number;
  x0: number;
  y0: number;
  p0: number;
  /** The mode the drag started from (true: quick). */
  from: boolean;
  travel: number;
  active: boolean;
  crossed: boolean;
  tracker: VelocityTracker;
}

export function QuickBuyBar(props: QuickBuyBarProps) {
  const { quick, cart, buy } = props;
  const { lang } = useLanguage();
  const words = quickBuyChrome(lang);
  const m = useMotion();
  const p = useMotionValue(quick ? 1 : 0);

  const bar = useRef<HTMLDivElement | null>(null);
  const quickCap = useRef<HTMLButtonElement | null>(null);
  const cartCap = useRef<HTMLButtonElement | null>(null);
  const accent = useRef<HTMLSpanElement | null>(null);
  const primary = useRef<HTMLSpanElement | null>(null);
  const bolt = useRef<HTMLSpanElement | null>(null);
  const boltFilled = useRef<HTMLSpanElement | null>(null);
  const quickLabel = useRef<HTMLSpanElement | null>(null);
  const cartIcon = useRef<HTMLSpanElement | null>(null);
  const cartIconOnPrimary = useRef<HTMLSpanElement | null>(null);
  const cartLabel = useRef<HTMLSpanElement | null>(null);

  /** The latest props and environment, for handlers that must not re-bind mid-gesture. */
  const live = useRef(props);
  live.current = props;
  const env = useRef({ dir: m.dir as number, reduced: m.reduced, dragging: false, cartW: 0, quickW: 0 });
  env.current.dir = m.dir;
  env.current.reduced = m.reduced;

  /** The mode the bar is resting in, or moving to. */
  const settled = useRef(quick);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const drag = useRef<Drag | null>(null);
  /** The page is being asked whether the account is ready. */
  const asking = useRef(false);
  const swallowClick = useRef(false);
  const alive = useRef(true);
  /** A polite live region, written only when the mode actually changes — never on arrival. */
  const said = useRef<HTMLSpanElement | null>(null);
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const announce = useCallback((on: boolean) => {
    if (said.current) said.current.textContent = on ? wordsRef.current.modeQuick : wordsRef.current.modeCart;
  }, []);

  /** Everything `p` decides, written straight to the elements. */
  const paint = useCallback((v: number) => {
    const q = quickCap.current;
    if (!q) return;
    const { dir, reduced, dragging, cartW, quickW } = env.current;
    // Reduced motion: the layout steps, only the looks fade (a finger's drag still moves it).
    const step = reduced && !dragging;
    const g = step ? (v >= 0.5 ? 1 : 0) : v;
    // The two looks trade places in the middle of the push, so neither capsule
    // lingers half-way between cream and dark: the motion carries the state.
    const fade = step ? v : smooth(clamp01((v - 0.25) / 0.5));
    const at = (el: HTMLElement | null, inline: number) => {
      if (el) el.style.transform = `translate(calc(-50% + ${(dir * inline).toFixed(2)}px), -50%)`;
    };
    const show = (el: HTMLElement | null, o: number) => {
      if (el) el.style.opacity = o.toFixed(3);
    };
    q.style.width = `calc(${C}px + (100% - ${G + 2 * C}px) * ${g.toFixed(4)})`;
    show(accent.current, fade);
    show(primary.current, 1 - fade);
    // ⚡ glides from the centre of the circle to just before «شراء سريع», and
    // gets there first: the words are revealed from behind it, never under it.
    at(bolt.current, (-(ICON_GAP + quickW) / 2) * (step ? g : smooth(clamp01(v / 0.7))));
    show(boltFilled.current, fade);
    const t = step ? v : clamp01((v - 0.3) / 0.7);
    show(quickLabel.current, t);
    at(quickLabel.current, (ICON + ICON_GAP) / 2 - (step ? 0 : 6 * (1 - t)));
    // 🛒 glides to the centre of the compact circle once its label has mostly
    // gone; the label, clipped by the shrinking capsule, leaves toward it.
    at(cartIcon.current, (-(ICON_GAP + cartW) / 2) * (1 - (step ? g : smooth(clamp01((v - 0.12) / 0.88)))));
    show(cartIconOnPrimary.current, 1 - fade);
    const f = step ? v : clamp01(v / 0.45);
    show(cartLabel.current, step ? 1 - v : (1 - f) * (1 - f));
    at(cartLabel.current, (ICON + ICON_GAP) / 2 - (step ? 0 : 6 * f));
  }, []);

  // Label widths decide where the icons rest. They are measured when a label
  // changes size — another language, «جارٍ الإضافة…», the Arabic font
  // arriving, the hidden copy of the bar being shown — and never per frame.
  useLayoutEffect(() => {
    const measure = () => {
      env.current.cartW = cartLabel.current?.offsetWidth ?? 0;
      env.current.quickW = quickLabel.current?.offsetWidth ?? 0;
      paint(p.get());
    };
    measure();
    const off = p.on('change', paint);
    if (typeof ResizeObserver === 'undefined') return off;
    const ro = new ResizeObserver(measure);
    for (const el of [cartLabel.current, quickLabel.current]) if (el) ro.observe(el);
    return () => {
      off();
      ro.disconnect();
    };
  }, [p, paint]);

  // The writing direction or the motion preference changed: draw again.
  useLayoutEffect(() => paint(p.get()), [m.dir, m.reduced, p, paint]);

  useEffect(() => {
    // Set on every mount: StrictMode mounts, unmounts and mounts again.
    alive.current = true;
    return () => {
      alive.current = false;
      anim.current?.stop();
      anim.current = null;
    };
  }, []);

  const run = useCallback(
    (target: number, how: 'tap' | 'settle' | 'nudge', onDone?: () => void, velocity = 0) => {
      anim.current?.stop();
      const from = p.get();
      const distance = Math.abs(target - from);
      const reduced = env.current.reduced;
      const options = reduced
        ? { duration: REDUCED_S, ease: 'linear' as const }
        : how === 'tap'
          ? { duration: MORPH_S * Math.max(0.35, distance), ease: EASE_IN_OUT }
          : how === 'nudge'
            ? { duration: 0.12, ease: EASE_OUT }
            : {
                // A release keeps some of the finger's speed: the faster the throw, the shorter the glide.
                duration: Math.min(0.42, Math.max(0.16, distance * (Math.abs(velocity) > FLICK ? 0.3 : 0.45))),
                ease: EASE_OUT,
              };
      anim.current = animate(p, target, {
        ...options,
        onComplete: () => {
          anim.current = null;
          onDone?.();
        },
      });
    },
    [p]
  );

  /** Rest in `target` and, once there, hand the mode to the page. */
  const settle = useCallback(
    (target: boolean, how: 'tap' | 'settle', velocity = 0) => {
      const changes = settled.current !== target || live.current.quick !== target;
      settled.current = target;
      run(
        target ? 1 : 0,
        how,
        () => {
          if (!changes) return;
          if (target) haptic(12);
          announce(target);
          if (live.current.quick !== target) live.current.onQuickChange(target);
        },
        velocity
      );
    },
    [run, announce]
  );

  /** Not ready: a small push that gives way, while the page opens the sheet. */
  const nudge = useCallback(() => {
    if (env.current.reduced) {
      run(0, 'settle');
      return;
    }
    run(0.06, 'nudge', () => run(0, 'settle'));
  }, [run]);

  const press = (el: HTMLElement | null) => {
    if (!el || env.current.reduced || typeof el.animate !== 'function') return;
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.97)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
  };

  /** ⚡ toward Quick Buy: the page says whether the account may go. */
  const goQuick = useCallback(
    async (how: 'tap' | 'settle', velocity = 0) => {
      asking.current = true;
      let ok = false;
      try {
        ok = await live.current.requestQuick();
      } finally {
        asking.current = false;
      }
      if (!alive.current) return;
      if (ok) settle(true, how, velocity);
      else {
        settled.current = false;
        nudge();
      }
    },
    [settle, nudge]
  );

  // The page changed the mode itself — activation completed, or a refusal
  // turned it back: morph there on our own. The page draws the bar twice (the
  // phone's bar and the desktop panel, one of them hidden by CSS): the hidden
  // copy follows at once, silently — no motion nobody sees, no second haptic.
  useEffect(() => {
    if (settled.current === quick || drag.current) return;
    settled.current = quick;
    if (!bar.current?.getClientRects().length) {
      anim.current?.stop();
      anim.current = null;
      p.set(quick ? 1 : 0);
      return;
    }
    run(quick ? 1 : 0, 'tap', () => {
      if (quick) haptic(12);
      announce(quick);
    });
  }, [quick, run, announce, p]);

  const busyMode = () => live.current.buy.busy || asking.current || !!anim.current || !!drag.current?.active;

  const onQuickClick = () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (busyMode()) return;
    if (settled.current) {
      // The big capsule buys; it never changes the mode.
      if (!live.current.buy.disabled) live.current.buy.onPress();
      return;
    }
    press(quickCap.current);
    haptic(8);
    void goQuick('tap');
  };

  const onCartClick = () => {
    if (busyMode()) return;
    if (!settled.current) {
      if (!live.current.cart.disabled) live.current.cart.onPress();
      return;
    }
    press(cartCap.current);
    haptic(8);
    settle(false, 'tap');
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    live.current.onWarm();
    swallowClick.current = false;
    if (!e.isPrimary || e.button !== 0 || live.current.buy.busy || asking.current) return;
    const width = (bar.current?.clientWidth ?? 0) - 2 * PAD;
    const travel = width - G - 2 * C;
    if (travel < 24) return;
    drag.current = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      p0: p.get(),
      from: settled.current,
      travel,
      active: false,
      crossed: false,
      tracker: new VelocityTracker(80),
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      // Mostly vertical: the page is being scrolled, not this control.
      if (Math.abs(dy) >= Math.abs(dx)) {
        drag.current = null;
        return;
      }
      d.active = true;
      anim.current?.stop();
      anim.current = null;
      d.p0 = p.get();
      env.current.dragging = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
    }
    const along = dx * env.current.dir;
    d.tracker.add(along, e.timeStamp);
    const v = clamp01(d.p0 + along / d.travel);
    const past = d.from ? v <= 1 - THRESHOLD : v >= THRESHOLD;
    if (past !== d.crossed) {
      d.crossed = past;
      if (past) haptic(6);
    }
    p.set(v);
  };

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (!d.active) return;
    env.current.dragging = false;
    // The click that follows a drag is not a tap (the next press clears this).
    swallowClick.current = !cancelled;
    if (cancelled) {
      settle(d.from, 'settle');
      return;
    }
    const v = p.get();
    const velocity = d.tracker.velocity();
    let toQuick = d.from ? v > 1 - THRESHOLD : v >= THRESHOLD;
    if (velocity > FLICK) toQuick = true;
    else if (velocity < -FLICK) toQuick = false;
    if (toQuick && !d.from) void goQuick('settle', velocity);
    else settle(toQuick, 'settle', velocity);
  };

  return (
    <div
      ref={bar}
      data-quick-buy-bar
      data-mode={quick ? 'quick' : 'cart'}
      className="relative flex items-stretch select-none"
      style={{ gap: G, padding: PAD, margin: -PAD, contain: 'layout paint' }}
    >
      <button
        ref={quickCap}
        type="button"
        data-quick-buy-capsule="quick"
        aria-label={quick ? undefined : words.turnOn}
        aria-disabled={(quick && buy.disabled) || undefined}
        aria-busy={(quick && buy.busy) || undefined}
        onClick={onQuickClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
        onKeyDown={() => {
          swallowClick.current = false;
        }}
        onFocus={() => live.current.onWarm()}
        className="lv-button relative shrink-0 overflow-hidden rounded-full px-0 min-h-[50px] text-[15px] text-gold"
        style={{ touchAction: 'pan-y', background: 'transparent', border: 0 }}
      >
        <span aria-hidden="true" className="absolute inset-0 rounded-full border border-border-subtle bg-surface-raised" />
        <span
          ref={accent}
          aria-hidden="true"
          className="absolute inset-0 rounded-full shadow-1"
          style={{
            background: 'color-mix(in oklab, var(--color-gold) 12%, var(--color-surface))',
            border: '1px solid color-mix(in oklab, var(--color-gold) 32%, transparent)',
          }}
        />
        <span ref={bolt} aria-hidden="true" className="absolute top-1/2 left-1/2 grid place-items-center">
          <Zap className="w-5 h-5" strokeWidth={1.9} style={{ gridArea: '1 / 1' }} />
          <span ref={boltFilled} className="flex" style={{ gridArea: '1 / 1' }}>
            <Zap className="w-5 h-5 fill-current" strokeWidth={1.9} />
          </span>
        </span>
        <span ref={quickLabel} className="absolute top-1/2 left-1/2 whitespace-nowrap">
          {buy.busy ? words.ctaBusy : words.cta}
        </span>
      </button>

      <button
        ref={cartCap}
        type="button"
        data-testid="product-cta"
        data-quick-buy-capsule="cart"
        aria-label={quick ? words.backToCart : undefined}
        disabled={!quick && cart.disabled}
        aria-busy={(!quick && cart.busy) || undefined}
        onClick={onCartClick}
        className="lv-button relative min-w-0 flex-1 overflow-hidden rounded-full px-0 min-h-[50px] text-[15px] active:scale-[0.985] [touch-action:manipulation]"
        style={{ background: 'transparent', border: 0, minWidth: C }}
      >
        <span aria-hidden="true" className="absolute inset-0 rounded-full border border-border-subtle bg-surface-raised" />
        <span ref={primary} aria-hidden="true" className="absolute inset-0 rounded-full shadow-1" style={{ background: 'var(--color-primary-fill)' }} />
        <span ref={cartIcon} aria-hidden="true" className="absolute top-1/2 left-1/2 grid place-items-center" style={{ color: 'var(--color-text-primary)' }}>
          <span className="flex" style={{ gridArea: '1 / 1' }}>
            {cart.icon}
          </span>
          <span ref={cartIconOnPrimary} className="flex" style={{ gridArea: '1 / 1', color: 'var(--color-canvas)' }}>
            {cart.icon}
          </span>
        </span>
        <span ref={cartLabel} className="absolute top-1/2 left-1/2 whitespace-nowrap" style={{ color: 'var(--color-canvas)' }}>
          {cart.label}
        </span>
      </button>

      <span ref={said} className="sr-only" aria-live="polite" />

    </div>
  );
}
