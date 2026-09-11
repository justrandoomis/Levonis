import vinext from "vinext";
import { defineConfig } from "vite";

// The old Sites hosting identity (./.openai/hosting.json) is gone on purpose:
// LEVO Studio deploys as its own Cloudflare Worker ("levonis-studio") and all
// binding names / resource names now live in ./wrangler.jsonc, which the
// Cloudflare Vite plugin discovers automatically. Deploy-time database IDs are
// substituted into wrangler.jsonc by scripts/set-deploy-ids.mjs from the
// GitHub Actions workflows — no hosting-platform identifiers are re-created
// here (implementation prompt §13).

// macOS Seatbelt blocks FSEvents, so sandboxed previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  // The editor subtree (slicer-client -> engine adapter -> three /
  // three-slicer / the 7 MiB occt WASM ?url asset) is browser-only, but
  // vinext server-renders client components, so the rsc/ssr environments
  // bundle ~20 MiB of engine chunks into the WORKER script — which is what
  // pushed the deploy past Cloudflare's Workers size limit. editor-boot.tsx
  // mounts the editor only after hydration (useEffect), so the server never
  // executes it; this plugin makes that a BUILD-time guarantee by resolving
  // the module to an inert stub in every server environment. The client
  // build is untouched.
  const EDITOR_STUB_ID = "\0levo-editor-ssr-stub";
  const serverStubEditor: import("vite").Plugin = {
    name: "levo-studio-ssr-editor-stub",
    resolveId(source: string, importer: string | undefined) {
      if (
        this.environment?.config?.consumer === "server" &&
        /(^|[\\/])slicer-client$/.test(source.replace(/\.tsx?$/, "")) &&
        importer &&
        /editor-boot/.test(importer)
      ) {
        return EDITOR_STUB_ID;
      }
      return null;
    },
    load(id: string) {
      if (id === EDITOR_STUB_ID) {
        // Never rendered: editor-boot only imports this after hydration in
        // the browser, where the real module is served from the client build.
        return "export default function EditorServerStub(){return null;}";
      }
      return null;
    },
  };

  return {
    worker: {
      // three-slicer's Emscripten worker uses top-level await and must remain
      // an ES module in the production bundle.
      format: "es" as const,
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      serverStubEditor,
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        // Worker name, bindings (DB / BUCKET / IMAGES / ASSETS) and the
        // staging environment come from ./wrangler.jsonc. Select the build
        // target with CLOUDFLARE_ENV=staging (default: production top level).
      }),
    ],
  };
});
