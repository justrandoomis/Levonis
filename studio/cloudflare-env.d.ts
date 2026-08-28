// Bindings for the LEVO Studio worker (levonis-studio / levonis-studio-staging).
// Keep in sync with studio/wrangler.jsonc — this is the single Studio worker
// environment; the store worker's bindings are defined at the repo root and
// are deliberately NOT available here.
declare namespace Cloudflare {
  interface Env {
    /** Built client assets (dist/client). HTML stays worker-rendered. */
    ASSETS: Fetcher;
    /** Studio-only project database (levonis-studio-db / -staging). */
    DB: D1Database;
    /** Private project-file storage (levonis-studio-files / -staging). */
    BUCKET: R2Bucket;
    /** Cloudflare Images binding for /_vinext/image optimization. */
    IMAGES: ImagesBinding;
    /** Studio's own trusted origin (empty until set by the deploy workflow). */
    APP_ORIGIN: string;
    /** Main-site worker origin for the server-to-server handoff exchange.
     *  Empty string = login handoff honestly disabled. */
    MAIN_SITE_ORIGIN: string;
  }
}
