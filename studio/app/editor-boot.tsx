"use client";

import { useEffect, useState, type ComponentType } from "react";

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

  if (failed) {
    // Honest failure — no fake progress. Reload is the real recovery action.
    return (
      <div dir="rtl" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", background: "#0a0a0a", color: "#e4e4e7", fontFamily: "system-ui" }}>
        <div style={{ textAlign: "center", padding: "1rem" }}>
          <p style={{ marginBottom: "0.75rem" }}>تعذر تحميل المحرر — تحقق من الاتصال ثم أعد المحاولة / Failed to load the editor.</p>
          <button onClick={() => window.location.reload()} style={{ padding: "0.6rem 1.4rem", borderRadius: "0.75rem", border: "1px solid #3f3f46", background: "#18181b", color: "#fff" }}>
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
      <div aria-busy="true" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", background: "#0a0a0a", color: "#a1a1aa", fontFamily: "system-ui" }}>
        <p>جارٍ تحميل LEVO Studio…</p>
      </div>
    );
  }

  return <Editor user={user} />;
}
