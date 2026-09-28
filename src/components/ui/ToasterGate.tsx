/**
 * THE CUSTOMER SHELL'S TOASTER, ON DEMAND — the twin of CompareTrayGate.
 *
 * It renders nothing and downloads nothing until the first toast is raised
 * (lib/toastStore.ts); from then on the Toaster (./Toast.tsx) stays mounted for
 * the visit, so every later message has somewhere to appear. The Toaster used
 * to live only inside the compare tray, which mounts when the tray first holds
 * a product — on any other visit the customer pages' toasts went nowhere.
 *
 * `aboveNav` while the floating BottomNav is on screen: the stack sits above
 * it (the tray used to say so through `--shell-bottom-inset`, only while it
 * was mounted).
 *
 * The admin console and the merchant workspace mount their own; the shell
 * keeps this one off their paths (and a second Toaster would wait its turn
 * anyway). A failed chunk renders nothing rather than taking the page down.
 */
import React, { Suspense, useState, useSyncExternalStore } from 'react';
import { subscribeToasts, toastQueue } from '../../lib/toastStore';

type ToasterLike = React.ComponentType<{ aboveNav?: boolean }>;
const Nothing: ToasterLike = () => null;
const Toaster = React.lazy<ToasterLike>(() =>
  import('./Toast').then((m) => ({ default: m.Toaster })).catch(() => ({ default: Nothing }))
);

export default function ToasterGate({ aboveNav = false }: { aboveNav?: boolean }) {
  const waiting = useSyncExternalStore(subscribeToasts, () => toastQueue().length > 0, () => false);
  const [armed, setArmed] = useState(false);
  if (waiting && !armed) setArmed(true);
  if (!armed && !waiting) return null;
  return (
    <Suspense fallback={null}>
      <Toaster aboveNav={aboveNav} />
    </Suspense>
  );
}
