import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const workerBuild = new URL("../dist/server/index.js", import.meta.url);

/**
 * `npm test` and workflow 8 build first. The repo-wide `npm run test:unit`
 * runs this suite WITHOUT a Studio build — it is there to catch source-level
 * breakage in minutes rather than in a deploy — so these two cases state that
 * they did not run instead of failing on a missing artifact. A visible skip is
 * the house answer; a green tick over an artifact nobody built is not.
 */
const needsBuild = { skip: existsSync(workerBuild) ? false : "dist/server is missing — run `npm run build` first" };

test("renders the production slicer shell and security policy", needsBuild, async () => {
  const workerUrl = new URL(workerBuild);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(response.headers.get("content-security-policy") ?? "", /wasm-unsafe-eval/);
  assert.match(response.headers.get("content-security-policy") ?? "", /'unsafe-eval'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  // A desktop browser stays cross-origin isolated, so the engine keeps its
  // threaded WASM core.
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");

  const html = await response.text();
  assert.doesNotMatch(html, /codex-preview/i);
  assert.match(html, /LEVO Studio/);
  assert.match(html, /manifest\.webmanifest/);
  // Contract change (worker-size fix): the editor subtree is client-only —
  // SSR delivers the app shell + loading state, and the editor UI (printer
  // grid, project actions) mounts after hydration. Rendering the editor on
  // the server is exactly what bundled ~20 MiB of engine chunks into the
  // worker script and broke the deploy, so the editor markup must NOT be in
  // the SSR HTML. Browser-side mounting is covered by the Playwright smoke.
  assert.match(html, /جارٍ تحميل LEVO Studio/);
  assert.doesNotMatch(html, /X2D/);
});

/**
 * The iPad case, which is the whole point of withholding isolation.
 *
 * three-slicer chooses its core on `crossOriginIsolated` alone. On iPadOS the
 * threaded core is killed by WebKit's tab memory budget, and the kill reaches
 * the page as an ErrorEvent with an empty message that the engine reports as
 * "Worker terminated (likely out of memory): worker error". Withholding the
 * two isolation headers makes the engine take its own single-threaded branch.
 */
test("iOS and iPadOS do not get cross-origin isolation", needsBuild, async () => {
  const workerUrl = new URL(workerBuild);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-ios`);
  const { default: worker } = await import(workerUrl.href);

  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const agents = {
    // iPadOS 17 requesting the desktop site — claims Macintosh.
    ipadDesktopClass:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    iphone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ipadClassic:
      "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  };

  for (const [name, ua] of Object.entries(agents)) {
    const res = await worker.fetch(
      new Request("http://localhost/", { headers: { accept: "text/html", "user-agent": ua } }),
      env,
      ctx,
    );
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get("cross-origin-opener-policy"), null, `${name} COOP`);
    assert.equal(res.headers.get("cross-origin-embedder-policy"), null, `${name} COEP`);
    // Everything else still applies — this withholds isolation, not security.
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${name} nosniff`);
    assert.equal(res.headers.get("x-frame-options"), "DENY", `${name} frame`);
    assert.match(res.headers.get("content-security-policy") ?? "", /wasm-unsafe-eval/, `${name} csp`);
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin", `${name} corp`);
  }

  // Chrome on macOS is not WebKit and keeps threads.
  const chromeMac = await worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    }),
    env,
    ctx,
  );
  assert.equal(chromeMac.headers.get("cross-origin-embedder-policy"), "require-corp");
});
