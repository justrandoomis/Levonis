/**
 * THE TOAST QUEUE — what components/ui/Toast.tsx draws, kept apart from the
 * drawing and free of React, so a shell can watch it from the entry chunk
 * (components/ui/ToasterGate.tsx) and download the Toaster only the first time
 * there is something to say.
 *
 * The customer shell's only Toaster used to live inside the compare tray,
 * which mounts the first time the tray holds a product — so on a visit that
 * compared nothing, every toast the customer pages raised («تعذّر تحديث
 * المتابعة», an offer's refusal, a request's retry) was queued and never shown
 * (review of Levo Community, 2026-09-28).
 */
export type ToastTone = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  description?: string;
  /** One verb: «تراجع», «إعادة المحاولة», «عرض». Pressing it also dismisses the toast. */
  action?: ToastAction;
  /** Milliseconds on screen; `Infinity` keeps it until dismissed. */
  duration?: number;
  /** Replace the toast with this id instead of adding one. */
  id?: string;
}

export interface ToastRecord {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  duration: number;
}

const DEFAULT_MS: Record<ToastTone, number> = { success: 4000, info: 4000, error: 8000 };
const ACTION_MIN_MS = 6000;

let toasts: ToastRecord[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function show(tone: ToastTone, title: string, options: ToastOptions = {}): string {
  const id = options.id ?? `t${++seq}`;
  const base = options.duration ?? DEFAULT_MS[tone];
  const record: ToastRecord = {
    id,
    tone,
    title,
    description: options.description,
    action: options.action,
    duration: options.action ? Math.max(base, ACTION_MIN_MS) : base,
  };
  const at = toasts.findIndex((t) => t.id === id);
  toasts = at >= 0 ? toasts.map((t, i) => (i === at ? record : t)) : [...toasts, record];
  emit();
  return id;
}

export function dismissToast(id?: string): void {
  toasts = id === undefined ? [] : toasts.filter((t) => t.id !== id);
  emit();
}

/** The toast API. Stable: safe in dependency arrays and outside components. */
export const toast = Object.freeze({
  show,
  success: (title: string, options?: ToastOptions) => show('success', title, options),
  error: (title: string, options?: ToastOptions) => show('error', title, options),
  info: (title: string, options?: ToastOptions) => show('info', title, options),
  dismiss: dismissToast,
});

/** The queue as it stands, oldest first (the Toaster shows the first three). */
export function toastQueue(): readonly ToastRecord[] {
  return toasts;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ------------------------------------------------ one Toaster on screen
/*
 * Two Toasters would draw every message twice. A shell mounts its own (the
 * merchant workspace, the admin console) and the customer shell's gate mounts
 * one on demand; if two are ever mounted at once, the first to mount draws and
 * the others wait their turn.
 */
const hosts: symbol[] = [];
const hostListeners = new Set<() => void>();

export function claimToasterHost(me: symbol): () => void {
  hosts.push(me);
  for (const l of hostListeners) l();
  return () => {
    const at = hosts.indexOf(me);
    if (at >= 0) hosts.splice(at, 1);
    for (const l of hostListeners) l();
  };
}

export function isToasterHost(me: symbol): boolean {
  return hosts[0] === me;
}

export function subscribeToasterHosts(listener: () => void): () => void {
  hostListeners.add(listener);
  return () => {
    hostListeners.delete(listener);
  };
}
