/**
 * The Studio Simple/Advanced mode for the current account (P1-10; S6/S7).
 *
 * Starts in Simple (the default for everyone, and what the server render
 * shows), applies this device's mirror for the account at once, then the
 * server's answer when signed in — see app/studio-mode.ts for the rule. A
 * choice made while that answer is still in flight wins over it: the person
 * clicked last.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { namespaceForUser } from "../project-store";
import {
  DEFAULT_STUDIO_MODE,
  clearModeMirror,
  createStudioPrefsApi,
  loadStudioMode,
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
    void loadStudioMode({ namespace, signedIn, api }).then(apply);
    return () => {
      active = false;
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
