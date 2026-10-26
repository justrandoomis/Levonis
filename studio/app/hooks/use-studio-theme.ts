/**
 * The Studio theme for this device (see app/theme.ts for the rule).
 *
 * Starts from what the boot script already applied, follows the operating
 * system while the preference is `system`, and writes every change onto the
 * document at once, so nothing waits for a re-render to change colour.
 */
import { useCallback, useEffect, useState } from "react";
import {
  applyThemeToDocument,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersDark,
  type ResolvedTheme,
  type ThemePreference,
} from "../theme";

export interface StudioThemeControl {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export function useStudioTheme(): StudioThemeControl {
  // Read at the first render, not in an effect: the editor mounts on the
  // client only (editor-boot.tsx), and a first render in the wrong theme would
  // undo what the boot script painted for one frame.
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredTheme);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(preference, prefersDark);
  useEffect(() => {
    applyThemeToDocument(resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    storeTheme(next);
  }, []);

  return { preference, resolved, setPreference };
}
