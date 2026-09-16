"use client";

import { useEffect, useState, type ComponentType } from "react";
import { LEVONIS_TOKENS, STUDIO_SURFACES } from "./editor-theme";

/**
 * THE FIRST FRAME IS PART OF THE APP, AND IT WAS NOT DRESSED LIKE IT.
 *
 * These two screens — the bundle still loading, and the bundle refusing to
 * load — are the only thing on screen for the whole engine download on a cold
 * cache. They were written with Tailwind's zinc scale spelled out inline
 * (#0a0a0a, #e4e4e7, #a1a1aa, #3f3f46, #18181b) and `fontFamily: system-ui`.
 *
 * So the first thing a visitor saw was a DIFFERENT near-black than the app
 * that follows, with Arabic set in whatever face the operating system picks
 * rather than Cairo — and then the page changed underneath them when the real
 * shell mounted. The values come from the same tokens as everything else now,
 * imported rather than copied, so they cannot drift again.
 *
 * `globals.css` is not loaded yet at this point, which is why these are inline
 * styles and not classes, and why the tokens are read from TypeScript.
 */
const BOOT_SCREEN = {
  minHeight: "100dvh",
  display: "grid",
  placeItems: "center",
  background: STUDIO_SURFACES.shell,
  color: STUDIO_SURFACES.text,
  fontFamily: LEVONIS_TOKENS.fontSans,
} as const;

const BOOT_MUTED = STUDIO_SURFACES.muted;

const BOOT_RETRY = {
  // 44px is the touch floor the rest of the app keeps; the recovery control on
  // a failure screen is the last place to go below it.
  minHeight: "44px",
  padding: "0.6rem 1.4rem",
  borderRadius: "12px",
  border: `1px solid ${STUDIO_SURFACES.line}`,
  background: STUDIO_SURFACES.surface,
  color: STUDIO_SURFACES.text,
  fontFamily: "inherit",
  fontSize: "13px",
  cursor: "pointer",
} as const;

type EditorUser = { id?: string; displayName: string } | null;
type EditorComponent = ComponentType<{ user?: EditorUser }>;

/**
 * Client-only boundary for the whole editor subtree.
 *
 * Why this exists: the editor's module graph (slicer-client -> model-loaders
 * -> three / three-slicer / the occt WASM ?url asset) is browser-only, but a
 * static import from the SSR-rendered page pulls ~20 MiB of engine chunks
 * into the WORKER bundle — which is what pushed the deploy over Cloudflare's
 * Workers size limit. The dynamic import below sits behind an
 * import.meta.env.SSR guard, which Vite replaces with a constant at build
 * time, so the server bundle drops the entire subtree while the client
 * bundle keeps it unchanged.
 */
export default function EditorBoot({ user = null }: { user?: EditorUser }) {
  const [Editor, setEditor] = useState<EditorComponent | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    // The dynamic import must sit INSIDE the statically-dead SSR branch —
    // Rollup only drops the chunk edge when the import expression itself is
    // inside an `if (false) …` block after Vite's define replacement. An
    // early-return guard above the import keeps the edge and re-bundles the
    // whole ~20 MiB engine subtree into the worker.
    if (!import.meta.env.SSR) {
      import("./slicer-client")
        .then((mod) => {
          if (active) setEditor(() => mod.default as EditorComponent);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    }
    return () => {
      active = false;
    };
  }, []);

  /**
   * PUT A STRAY ROOT SCROLL BACK.
   *
   * `.studio-app` is `position: fixed` (globals.css) so a scrolled root can no
   * longer carry the header off-screen — but the document would still be
   * sitting at a non-zero offset, which moves the engine's own shadow-root
   * chrome and leaves the page in a state `body { overflow: hidden }` forbids
   * the user from correcting. WebKit can apply such an offset on its own:
   * revealing a focused control, settling a collapsing URL bar, or restoring a
   * remembered position after a reload.
   *
   * So this listens rather than polls, and only acts when the offset is real.
   * `scrollRestoration = "manual"` stops the reload case at the source.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

    let frame = 0;
    const settle = () => {
      frame = 0;
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    const onMove = () => {
      // Coalesce: WebKit fires these in bursts while a keyboard animates.
      if (frame === 0) frame = window.requestAnimationFrame(settle);
    };

    onMove();
    window.addEventListener("scroll", onMove, { passive: true });
    window.visualViewport?.addEventListener("resize", onMove);
    window.visualViewport?.addEventListener("scroll", onMove);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onMove);
      window.visualViewport?.removeEventListener("resize", onMove);
      window.visualViewport?.removeEventListener("scroll", onMove);
    };
  }, []);

  if (failed) {
    // Honest failure — no fake progress. Reload is the real recovery action.
    return (
      <div dir="rtl" style={BOOT_SCREEN}>
        <div style={{ textAlign: "center", padding: "1rem", maxWidth: "34ch" }}>
          <p style={{ marginBottom: "0.75rem", lineHeight: 1.7 }}>تعذر تحميل المحرر — تحقق من الاتصال ثم أعد المحاولة / Failed to load the editor.</p>
          <button onClick={() => window.location.reload()} style={BOOT_RETRY}>
            إعادة المحاولة / Retry
          </button>
        </div>
      </div>
    );
  }

  if (!Editor) {
    // Minimal shell while the editor bundle loads — mirrors the editor's own
    // dark ground so there is no white flash; no fake progress numbers.
    return (
      <div aria-busy="true" style={{ ...BOOT_SCREEN, color: BOOT_MUTED }}>
        <p style={{ lineHeight: 1.7 }}>جارٍ تحميل LEVO Studio…</p>
      </div>
    );
  }

  return <Editor user={user} />;
}
