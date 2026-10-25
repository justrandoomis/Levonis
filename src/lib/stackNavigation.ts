import { ownsProductNavigation } from '../components/motion/ProductTransition';
import { cssTimeMs } from './motionTime';
import './stackNavigation.css';

type Destination = { key: string; pathname: string; search: string };
type Transition = { finished: Promise<void>; ready: Promise<void>; skipTransition(): void };
type ViewDocument = Document & { startViewTransition?: (update: () => Promise<void>) => Transition };

/** Browser snapshots preserve the outgoing page without mounting a second
 * router, copying form controls or changing the fixed bars' containing block.
 * Slow Suspense loads retain the existing pending-route/busy behavior. */
export function createStackNavigation() {
  const root = document.documentElement;
  let path = location.pathname + location.search;
  let index = Number(history.state?.idx ?? 0);
  let keyboard = false;
  let serial = 0;
  let current: { key: string; done(): void; cancel(): void } | undefined;
  const onKey = (event: KeyboardEvent) => { if (!event.metaKey && !event.ctrlKey && !event.altKey) keyboard = true; };
  const onPointer = () => { keyboard = false; };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);

  return {
    begin(action: string, to: Destination, commit: () => void) {
      const previous = path, next = to.pathname + to.search;
      const nextIndex = Number(history.state?.idx ?? index);
      const back = action === 'POP' && nextIndex < index;
      path = next; index = nextIndex;
      current?.cancel();
      const id = ++serial;
      const doc = document as ViewDocument;
      if (action === 'REPLACE' || previous.split('?')[0] === to.pathname || keyboard || document.hidden ||
          window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
          ownsProductNavigation(previous, next) || !doc.startViewTransition ||
          /lv-(?:lang-vt|theme-)/.test(root.className)) {
        commit();
        return;
      }

      let resolve: () => void = () => {};
      const committed = new Promise<void>((done) => { resolve = done; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let transition: Transition | undefined;
      const cleanup = () => {
        clearTimeout(timer); resolve();
        if (serial === id) { root.classList.remove('lv-stack-vt'); root.removeAttribute('data-stack-back'); current = undefined; }
      };
      root.classList.add('lv-stack-vt');
      root.toggleAttribute('data-stack-back', back);
      current = {
        key: to.key,
        done() {
          // Child effects have restored scroll. Do not wait for rAF here:
          // native snapshots suppress painting until this promise resolves.
          clearTimeout(timer);
          resolve();
        },
        cancel() { transition?.skipTransition(); cleanup(); },
      };
      try {
        transition = doc.startViewTransition(() => {
          // skipTransition still invokes this callback. Never commit a route
          // superseded by a second tap, Back, or an authentication redirect.
          if (serial !== id) return Promise.resolve();
          commit();
          return committed;
        });
        // Do not freeze rendering over the existing 250ms route-busy overlay.
        timer = setTimeout(() => { transition?.skipTransition(); cleanup(); }, cssTimeMs(getComputedStyle(root).getPropertyValue('--duration-ui'), 250));
        void transition.ready.catch(() => {});
        void transition.finished.then(cleanup, cleanup);
      } catch {
        cleanup();
        commit();
      }
    },
    committed(key: string) { if (current?.key === key) current.done(); },
    dispose() {
      current?.cancel(); ++serial;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    },
  };
}
