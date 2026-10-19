/**
 * The Studio Simple/Advanced mode for the current account (P1-10; S6/S7).
 *
 * Starts in Simple (the default for everyone, and what the server render
 * shows), applies this device's mirror for the account at once, then the
 * server's answer when signed in — see app/studio-mode.ts for the rule. A
 * choice made while that answer is still in flight wins over it: the person
 * clicked last, and the load then neither rewrites the mirror nor pushes its
 * stale answer to the server. A choice the server did not receive stays
 * pending on this device and is sent again when the browser is back online
 * (and on the next load), so it is never silently reverted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { namespaceForUser } from "../project-store";
import {
  DEFAULT_STUDIO_MODE,
  clearModeMirror,
  createStudioPrefsApi,
  loadStudioMode,
  pushPendingMode,
  readModeMirror,
  saveStudioMode,
  type StudioMode,
} from "../studio-mode";

export interface StudioModeControl {
  mode: StudioMode;
  setMode: (mode: StudioMode) => void;
  /** Sign-out purge: forget this account's mirrored choice on this device. */
  clearLocalMirror: () => void;
}

export function useStudioMode(userId: string | null): StudioModeControl {
  const namespace = useMemo(() => namespaceForUser(userId), [userId]);
  const signedIn = Boolean(userId);
  const api = useMemo(() => createStudioPrefsApi(), []);
  const [mode, setModeState] = useState<StudioMode>(DEFAULT_STUDIO_MODE);
  /** Bumped by every explicit choice, so a slower load cannot undo it. */
  const choiceRef = useRef(0);

  useEffect(() => {
    let active = true;
    const choiceAtStart = choiceRef.current;
    const apply = (next: StudioMode) => {
      if (active && choiceRef.current === choiceAtStart) setModeState(next);
    };
    // Two answers, in order: this device's mirror (a microtask away, so the
    // editor is right before the network is), then the account's own.
    void Promise.resolve().then(() => apply(readModeMirror(namespace) ?? DEFAULT_STUDIO_MODE));
    void loadStudioMode({
      namespace,
      signedIn,
      api,
      stillCurrent: () => active && choiceRef.current === choiceAtStart,
    }).then(apply);
    // A choice the server could not take (offline, 429, 5xx) goes up again
    // as soon as the browser is back online.
    const onOnline = () => void pushPendingMode({ namespace, signedIn, api });
    if (typeof window !== "undefined") window.addEventListener("online", onOnline);
    return () => {
      active = false;
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    };
  }, [api, namespace, signedIn]);

  const setMode = useCallback(
    (next: StudioMode) => {
      choiceRef.current += 1;
      setModeState(next);
      void saveStudioMode({ namespace, signedIn, api, mode: next });
    },
    [api, namespace, signedIn]
  );

  const clearLocalMirror = useCallback(() => clearModeMirror(namespace), [namespace]);

  return { mode, setMode, clearLocalMirror };
}
