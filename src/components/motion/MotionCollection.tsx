// Lucian UX/UI Prompts #292, #308, #317 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/
import React from 'react';

type Item = { rect: DOMRect; photo?: DOMRect; copy: HTMLElement; index: number };
type Snapshot = Map<string, Item>;
type Props = { children: React.ReactNode; version: string; view?: string; className?: string };

/** Measure before React mutates the list, then animate only visible cards.
 * Actual DOM order always follows the server's order; departing copies are inert.
 * No initial entrance, polling or motion bundle; at most 24 cards animate. */
export default class MotionCollection extends React.Component<Props> {
  private root = React.createRef<HTMLDivElement>();
  private animations = new Set<Animation>();
  private ghosts = new Set<HTMLElement>();
  private media?: MediaQueryList;
  private hasItems = false;

  componentDidMount() {
    this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.media.addEventListener('change', this.cancel);
    this.hasItems = this.rows().length > 0;
  }

  componentWillUnmount() {
    this.media?.removeEventListener('change', this.cancel);
    this.cancel();
  }

  private cancel = () => {
    this.animations.forEach((a) => a.cancel());
    this.animations.clear();
    this.ghosts.forEach((el) => el.remove());
    this.ghosts.clear();
  };

  private rows() {
    return Array.from(this.root.current?.querySelectorAll<HTMLElement>('[data-motion-key]') ?? []);
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (previous.version === this.props.version || this.media?.matches) return null;
    const rows = this.rows();
    this.hasItems ||= rows.length > 0;
    if (!this.hasItems) return null;
    const snapshot: Snapshot = new Map();
    for (const [index, el] of rows.entries()) {
      if (snapshot.size >= 24) break;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) continue;
      snapshot.set(el.dataset.motionKey!, {
        rect, index, copy: el.cloneNode(true) as HTMLElement,
        photo: el.querySelector('[data-motion-photo]')?.getBoundingClientRect(),
      });
    }
    // Read the interrupted position first, then cancel so the next FLIP starts there.
    this.cancel();
    return snapshot;
  }

  private play(el: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions, done?: () => void) {
    if (!el.animate) { done?.(); return; }
    const a = el.animate(frames, { fill: 'backwards', ...options });
    this.animations.add(a);
    a.onfinish = () => { this.animations.delete(a); done?.(); };
  }

  componentDidUpdate(previous: Props, _state: unknown, snapshot: Snapshot | null) {
    if (!snapshot || this.media?.matches) return;
    const morph = previous.view !== this.props.view;
    const rows = this.rows();
    const ids = new Set(rows.map((el) => el.dataset.motionKey));
    let visible = 0;
    rows.forEach((el, index) => {
      if (visible >= 24) return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) return;
      const delay = visible++ * (morph ? 25 : 35);
      const old = snapshot.get(el.dataset.motionKey!);
      if (!old) {
        this.play(el, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'none', opacity: 1 }],
          { duration: 600, delay, easing: 'cubic-bezier(.3,1.25,.4,1)' });
      } else if (morph && old.photo) {
        const photo = el.querySelector<HTMLElement>('[data-motion-photo]');
        if (photo) {
          const next = photo.getBoundingClientRect();
          if (next.width && next.height) this.play(photo, [
            { transformOrigin: '0 0', transform: `translate(${old.photo.x - next.x}px,${old.photo.y - next.y}px) scale(${old.photo.width / next.width},${old.photo.height / next.height})` },
            { transformOrigin: '0 0', transform: 'none' },
          ], { duration: 560, delay, easing: 'cubic-bezier(.3,1.15,.4,1)' });
        }
        const text = el.querySelector<HTMLElement>('[data-motion-copy]');
        if (text) this.play(text, [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }],
          { duration: 320, delay: 300 + visible * 30 });
      } else {
        const x = old.rect.x - rect.x, y = old.rect.y - rect.y;
        if (Math.abs(x) < 1 && Math.abs(y) < 1) return;
        const up = old.index > index;
        this.play(el, [
          { transform: `translate(${x}px,${y}px)`, opacity: 1, zIndex: up ? 2 : 0 },
          { transform: `translate(${x * .35}px,${y * .35}px) scale(${up ? 1.02 : .98})`, opacity: up ? 1 : .9, zIndex: up ? 2 : 0, offset: .45 },
          { transform: 'none', opacity: 1 },
        ], { duration: 600, easing: 'cubic-bezier(.3,1.1,.4,1)' });
        const price = el.querySelector<HTMLElement>('[data-motion-price]');
        if (price) this.play(price, [{ backgroundColor: 'var(--color-surface-selected)' }, { backgroundColor: 'transparent' }], { duration: 600 });
      }
    });
    snapshot.forEach(({ rect, copy }, id) => {
      if (ids.has(id)) return;
      copy.inert = true;
      copy.setAttribute('aria-hidden', 'true');
      copy.removeAttribute('id');
      copy.removeAttribute('data-motion-key');
      copy.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      Object.assign(copy.style, { position: 'fixed', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', pointerEvents: 'none', zIndex: '25' });
      document.body.appendChild(copy);
      this.ghosts.add(copy);
      this.play(copy, [{ transform: 'none', opacity: 1 }, { transform: 'scale(.2)', opacity: 0 }],
        { duration: 350, easing: 'ease' }, () => { copy.remove(); this.ghosts.delete(copy); });
    });
  }

  render() {
    return <div ref={this.root} className={`u292 u308 u317 ${this.props.className ?? ''}`}>{this.props.children}</div>;
  }
}
