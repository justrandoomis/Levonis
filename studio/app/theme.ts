/**
 * THE STUDIO THEME: A DEVICE-LOCAL CHOICE BETWEEN SYSTEM, LIGHT AND DARK.
 *
 * The owner asked for the reference screens in dark AND light (DECISIONS row
 * 271, plan item C6, decision D-14). The Studio is a separate origin from
 * levonis-iq.com, so it cannot read the site's own `levonis.theme.v1` value,
 * and `/api/prefs` stores only the editor mode: adding a column would be an
 * ALTER, which the Studio migration gate does not admit (worker/api/prefs.ts).
 * So the theme is what it is on the site itself, a preference kept on this
 * device, defaulting to the operating system's choice.
 *
 * The same three values and the same default as the site (src/lib/theme.ts):
 * `system` follows `prefers-color-scheme`; `light` and `dark` pin it.
 *
 * `THEME_BOOT_SCRIPT` applies the stored choice before the first paint, beside
 * the locale boot script in layout.tsx, so a light-theme reader never sees a
 * dark frame first. It must stay dependency-free: it runs as an inline script.
 *
 * WHAT A THEME DOES NOT CHANGE. The 3D viewport stays a dark island in both
 * themes: the vendored engine clears its canvas to a fixed colour
 * (`setClearColor(1448478)`, #16191E, in viewer/dist/Viewport.js) and no
 * engine patch is made for it in this pass. The card around the canvas is
 * themed; the canvas inside it is not.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

/** localStorage key, shared with THEME_BOOT_SCRIPT below. */
export const THEME_STORAGE_KEY = "levo-studio-theme";

/**
 * The colour the BROWSER paints its own chrome in, per theme. Each one is the
 * page ground of that theme (globals.css `--shell`), so the strip above the
 * app is never a different colour from the app under it.
 */
export const THEME_CHROME_COLORS: Record<ResolvedTheme, string> = {
  dark: "#121619",
  light: "#e3dacb",
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** The stored preference, or `system` when nothing valid is stored. */
export function readStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Persists the preference; storage failures keep the in-memory choice. */
export function storeTheme(preference: ThemePreference): void {
  if (typeof window === "undefined") return;
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private browsing / storage-denied: the choice lasts for this session.
  }
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/**
 * Writes the resolved theme onto the document: `data-theme` drives every
 * token block in globals.css, `color-scheme` drives native controls and
 * scrollbars, and the theme-color metas follow the page ground.
 */
export function applyThemeToDocument(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute("content", THEME_CHROME_COLORS[theme]);
  }
}

/**
 * Applied before hydration. Mirrors the functions above: key
 * `levo-studio-theme`, values light|dark (anything else means system).
 */
export const THEME_BOOT_SCRIPT = `try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");var d=p==="dark"||(p!=="light"&&(!window.matchMedia||window.matchMedia("(prefers-color-scheme: dark)").matches));var t=d?"dark":"light";var r=document.documentElement;r.setAttribute("data-theme",t);r.style.colorScheme=t;if(p==="dark"||p==="light"){var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++)m[i].setAttribute("content",t==="dark"?"${THEME_CHROME_COLORS.dark}":"${THEME_CHROME_COLORS.light}");}}catch(e){}`;
