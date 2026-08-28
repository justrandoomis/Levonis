import assert from "node:assert/strict";
import test from "node:test";

test("renders the production slicer shell and security policy", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
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
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");

  const html = await response.text();
  assert.doesNotMatch(html, /codex-preview/i);
  assert.match(html, /LEVO Studio/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /LEVO Studio/);
  assert.match(html, /X2D/);
  assert.match(html, /مشروع جديد/);
});
