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
  /**
   * ONE COPY OF THE 6 MB KERNEL, NOT TWO — AND A HEAP RESERVATION A PHONE CAN
   * ACTUALLY MAKE.
   *
   * Both of these live here rather than in `patches/` for one boring reason:
   * `slicer_core.mt.js` is 5.28 MB on a SINGLE LINE, so patch-package would
   * write a ten-megabyte patch file to change two expressions in it. A build
   * transform is the only sane tool. It is held to the same standard as the
   * patches, though — each replacement asserts it matched exactly once, so an
   * engine upgrade FAILS THE BUILD instead of silently going back to the old
   * behaviour. `tests/single-kernel.test.mjs` checks the result in `dist/`.
   *
   * ── 1. THE DUPLICATE KERNEL ──────────────────────────────────────────────
   *
   * The threaded kernel spawns its pthread pool from its own module:
   *
   *     new Worker(new URL("slicer_core.mt.js", import.meta.url), { … })
   *
   * Vite's `vite:worker-import-meta-url` plugin rewrites that pattern to a
   * bundled worker asset. It has a branch that recognises a worker module
   * referencing ITSELF and rewrites the URL to `self.location.href` — but it
   * decides that by comparing the file against the last entry of the bundle
   * chain, which here is `slicer.worker.js` (the module that dynamically
   * imports the core), not the core. So the self-reference is missed and Vite
   * emits A WHOLE SECOND COPY:
   *
   *     slicer_core.mt-CzWwNuLo.js   6,235,835 bytes   ← the slice worker loads this
   *     slicer_core.mt-DbNgvolI.js   6,235,768 bytes   ← every pool worker loads this
   *
   * Byte-for-byte the same module at two URLs, which to a browser is two
   * different scripts: two downloads, two parses, two code caches, nothing
   * shared. A phone slicing one small model was pulling 12.5 MB of JavaScript
   * and parsing ~6 MB of it three times over — all of it before a triangle is
   * touched, because the pool is a blocking run dependency.
   *
   * `import.meta.url` IS the core's own URL, in the built chunk exactly as in
   * the source, so handing it to `new Worker` directly is both simpler and
   * correct. Vite's pattern only matches `new URL("…", import.meta.url)`, so
   * the rewritten form is left alone and no second asset is emitted. It cannot
   * become `self.location.href`: inside the slice worker that is
   * `slicer.worker-*.js`, a different script entirely.
   *
   * ── 2. THE 4 GiB SHARED RESERVATION ──────────────────────────────────────
   *
   * The threaded kernel asks for its heap like this:
   *
   *     wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true })
   *
   * 65536 pages is 4 GiB. A SHARED memory cannot be relocated when it grows,
   * so the engine must reserve the whole maximum as contiguous address space
   * at construction — and there is no host hook for it anywhere: the worker
   * calls the factory with no module argument, and the glue exposes neither
   * `Module.wasmMemory` nor `Module.INITIAL_MEMORY`. The single-threaded core
   * never does this; it takes the module's own memory and grows it.
   *
   * On a 64-bit browser that reservation is cheap. On 32-bit Chrome for
   * Android — still most of the low end — four gigabytes of address space is
   * not merely expensive, it is more than the process HAS, and the constructor
   * throws before the kernel has done anything. What the page shows when the
   * kernel's own worker dies during boot is the engine's `onerror` text:
   * "Worker terminated (likely out of memory): worker error" — on an empty
   * bed, and again on the economy rung, because every rung boots the same
   * kernel. That is both of the owner's screenshots.
   *
   * THIS IS THE ONE CHANGE HERE THAT IS A HYPOTHESIS RATHER THAN A
   * MEASUREMENT, so it is made the cheap way round: handhelds only, and a
   * ceiling (1 GiB) that is 64× the 16 MiB the kernel starts with and far
   * beyond what a phone tab is ever allowed to commit. If a model somehow
   * needs more, the kernel aborts and the viewer's retry ladder takes over —
   * a slice that finishes in economy mode instead of one that is killed.
   * Desktops are untouched.
   */
  const KERNEL_SRC = /three-slicer[\\/]engine[\\/]src[\\/]slicer_core\.mt\.js$/;

  const POOL_WORKER_FROM =
    'new Worker(new URL("slicer_core.mt.js",import.meta.url),{type:"module",workerData:"em-pthread",name:"em-pthread"})';
  const POOL_WORKER_TO =
    'new Worker(import.meta.url,{type:"module",workerData:"em-pthread",name:"em-pthread"})';

  const HEAP_FROM = "maximum:65536,shared:true";
  /** 16384 pages = 1 GiB. Handhelds only; every other browser keeps 4 GiB. */
  const HEAP_TO =
    "maximum:/Android|iPhone|iPad|iPod/i.test(typeof navigator==\"undefined\"?\"\":navigator.userAgent||\"\")?16384:65536,shared:true";

  const replaceOnce = (code: string, from: string, to: string, what: string) => {
    const hits = code.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `levo-studio-single-kernel: expected exactly one "${what}" in slicer_core.mt.js, found ${hits}. `
          + "three-slicer changed; re-read vite.config.ts before touching this.",
      );
    }
    return code.replace(from, to);
  };

  const singleKernel: import("vite").Plugin = {
    name: "levo-studio-single-kernel",
    // Before vite:worker-import-meta-url, which is what emits the second copy.
    enforce: "pre",
    transform(code: string, id: string) {
      if (!KERNEL_SRC.test(id.split("?")[0])) return null;
      let out = replaceOnce(code, POOL_WORKER_FROM, POOL_WORKER_TO, "pthread pool worker URL");
      out = replaceOnce(out, HEAP_FROM, HEAP_TO, "shared heap reservation");
      // No source map: the input is one 5.28 MB generated line, so a map buys
      // nothing and costs the build a copy of it.
      return { code: out, map: null };
    },
  };

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
      // `config.plugins` does NOT reach worker bundles in a production build —
      // Vite builds them with `worker.plugins` alone. The kernel is imported
      // by `slicer.worker.js`, so it lives entirely in that bundle, and a
      // transform registered only above would silently do nothing. (It did:
      // the first attempt left both 6.24 MB copies in `dist/` untouched.)
      plugins: () => [singleKernel],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      singleKernel,
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
