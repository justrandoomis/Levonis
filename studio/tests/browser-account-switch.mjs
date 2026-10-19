#!/usr/bin/env node
/**
 * ACCOUNT SWITCH, GUEST WORK AND SIGN-OUT PURGE, IN A REAL BROWSER (P1-09).
 *
 * The node tests pin the namespace logic and the API. These three things are
 * only true if the browser agrees, so this drives the built app in Chromium:
 *
 *   02  sign in as A, open «مشاريعي», switch to B in the SAME browser: no A
 *       project name, no A thumbnail (not rendered, not requested, and not
 *       servable from the HTTP cache even with `cache: "force-cache"`), no A
 *       draft;
 *   05  guest work left on the device survives sign-in, is OFFERED and not
 *       adopted, and becomes an account project only after the explicit
 *       «احفظ عملك في حسابي» click;
 *       the sign-out sheet's optional purge removes that account's drafts
 *       from the device — and nothing else.
 *
 * NOT part of `npm test`: it needs a built Studio, a local server, Chromium.
 *
 *   cd studio && npm run build
 *   npx wrangler dev --port 8799 --ip 127.0.0.1 --compatibility-date 2026-05-22
 *   node tests/browser-account-switch.mjs [http://127.0.0.1:8799/]
 *
 * Sign-in itself is the main site's handoff, which a local run does not have,
 * so the script seeds Studio sessions straight into the LOCAL D1 (the same
 * `.wrangler/state` wrangler dev serves) with `wrangler d1 execute --local`,
 * and switches accounts by swapping the session cookie after a real sign-out.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "browser-account-switch.latest.json");
const target = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8799/";
const origin = new URL(target).origin;
const host = new URL(target).hostname;

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(root)) return null;
  if (existsSync(join(root, "chromium"))) return join(root, "chromium");
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium")) continue;
    for (const c of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome"]) {
      const full = join(root, entry, c);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

const require = createRequire(import.meta.url);
let chromium;
for (const spec of ["playwright-core", "playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) {
  try { ({ chromium } = require(spec)); if (chromium) break; } catch { /* next */ }
}
if (!chromium) { console.error("account-switch: no playwright available"); process.exit(1); }

const checks = [];
let failures = 0;
const fail = (m, detail) => { failures++; checks.push({ ok: false, m, detail }); console.log(`  FAIL ${m}${detail ? ` — ${detail}` : ""}`); };
const ok = (m, detail) => { checks.push({ ok: true, m, detail }); console.log(`  ok   ${m}${detail ? ` — ${detail}` : ""}`); };
const assert = (cond, m, detail) => (cond ? ok(m, detail) : fail(m, detail));

// ---------------------------------------------------------------------------
// Sessions, seeded into the local D1
// ---------------------------------------------------------------------------

const run = randomBytes(4).toString("hex");
const USER_A = `browser-a-${run}`;
const USER_B = `browser-b-${run}`;
const token = () => randomBytes(32).toString("hex");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const TOKENS = { a1: token(), a2: token(), b: token() };
const expires = new Date(Date.now() + 3_600_000).toISOString();
const seedSql = [
  `CREATE TABLE IF NOT EXISTS studio_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', locale TEXT NOT NULL DEFAULT 'ar', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '')`,
  ...[["a1", USER_A, "Alpha"], ["a2", USER_A, "Alpha"], ["b", USER_B, "Bravo"]].map(
    ([k, user, name]) =>
      `INSERT INTO studio_sessions (id, user_id, display_name, locale, expires_at) VALUES ('${sha256(TOKENS[k])}', '${user}', '${name}', 'en', '${expires}')`
  ),
].join("; ");
execFileSync("npx", ["wrangler", "d1", "execute", "levonis-studio-db", "--local", "--command", seedSql], {
  cwd: STUDIO_ROOT,
  stdio: ["ignore", "ignore", "inherit"],
});
console.log(`seeded sessions for ${USER_A} (x2) and ${USER_B}`);

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

const PRINTER_KEY = "levo-studio-printer";
const LOCALE_KEY = "levo-studio-locale";
const browser = await chromium.launch({ executablePath: findChromium() ?? undefined, args: ["--no-sandbox"] });
// ONE context for the whole run: one browser, one IndexedDB, one HTTP cache —
// exactly what a shared device is.
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(([pk, pv, lk, lv]) => {
  try { window.localStorage.setItem(pk, pv); window.localStorage.setItem(lk, lv); } catch { /* ignore */ }
}, [PRINTER_KEY, "bbl-x2d-04", LOCALE_KEY, "en"]);

const useSession = (value) =>
  context.addCookies([{ name: "levo_studio_session", value, domain: host, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

async function api(method, path, data) {
  const res = await context.request.fetch(`${origin}${path}`, { method, data, headers: { Origin: origin } });
  let json = null;
  try { json = await res.json(); } catch { /* binary */ }
  return { status: res.status(), headers: res.headers(), json };
}

// 1×1 PNG, so the thumbnail <img> really decodes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function commitRevision(id, base, label) {
  const snapshot = Buffer.from(`3mf-${label}-${run}`);
  const open = await api("POST", `/api/projects/${id}/revisions`, {
    base_revision: base,
    content_hash: sha256(snapshot),
    snapshot_kind: "full",
    manifest: { version: 1, generator: "levo-studio", project: { name: label } },
    files: [
      { kind: "snapshot3mf", sha256: sha256(snapshot), size_bytes: snapshot.length, content_type: "model/3mf" },
      { kind: "thumbnail", sha256: sha256(PNG), size_bytes: PNG.length, content_type: "image/png" },
    ],
  });
  if (open.status !== 201) throw new Error(`open ${label}: ${open.status} ${JSON.stringify(open.json)}`);
  for (const file of open.json.files) {
    const res = await context.request.fetch(`${origin}${file.upload_url}`, {
      method: "PUT",
      data: file.kind === "thumbnail" ? PNG : snapshot,
      headers: { Origin: origin },
    });
    if (res.status() !== 200) throw new Error(`upload ${file.kind}: ${res.status()}`);
  }
  const done = await api("POST", `/api/projects/${id}/revisions/${open.json.revision_id}/commit`);
  if (done.status !== 200) throw new Error(`commit ${label}: ${done.status}`);
  return open.json.revision;
}

async function accountProject(name) {
  const created = await api("POST", "/api/projects", { name });
  if (created.status !== 201) throw new Error(`create ${name}: ${created.status}`);
  const id = created.json.project.id;
  await commitRevision(id, null, name);
  return id;
}

/** Writes a draft the way app/project-store.ts stores one (v2 schema). */
const seedDraft = (page, rec) =>
  page.evaluate(async (rec) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("levo-studio-projects", 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("drafts")) {
          d.createObjectStore("drafts", { keyPath: "key" }).createIndex("namespace", "namespace", { unique: false });
        }
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({
        key: `${rec.namespace}/${rec.id}`,
        namespace: rec.namespace,
        id: rec.id,
        name: rec.name,
        updatedAt: Date.now(),
        files: [new File([`3mf-${rec.id}`], `${rec.id}.3mf`, { type: "model/3mf" })],
        profileId: "bbl-x2d-04",
        quality: "standard",
        strength: "standard",
        support: false,
        snapshotVersion: 2,
        snapshotKind: "full",
        thumbnail: null,
        fullSnapshot: null,
        remote: null,
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, rec);

/** namespace → draft names, read straight from IndexedDB. */
const draftsOnDevice = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("levo-studio-projects", 2);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains("drafts")) { db.close(); return {}; }
    const all = await new Promise((res, rej) => {
      const req = db.transaction("drafts", "readonly").objectStore("drafts").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    const out = {};
    for (const r of all) (out[r.namespace] ??= []).push({ id: r.id, name: r.name, remote: r.remote?.projectId ?? null });
    return out;
  });

async function openProjects(page) {
  await page.locator('.studio-header button[title="Projects"]').click();
  await page.locator(".levo-projects-panel").waitFor({ timeout: 20_000 });
}
const accountTab = (page) => page.locator(".levo-projects-panel .lpp-tabs button").nth(0).click();
const deviceTab = (page) => page.locator(".levo-projects-panel .lpp-tabs button").nth(1).click();
async function closeSheet(page) {
  await page.locator('.studio-sheet > header button[aria-label="Close"]').click();
  await page.locator(".sheet-backdrop").waitFor({ state: "detached", timeout: 10_000 });
}

async function signOut(page, purge) {
  await page.locator(`.studio-header a[href^="/auth/logout"]`).click();
  const box = page.locator('[data-levo-signout="purge"]');
  await box.waitFor({ timeout: 10_000 });
  assert(!(await box.isChecked()), "the sign-out sheet offers the purge UNTICKED");
  if (purge) await box.check();
  // The page is already at "/", so waiting for the URL would resolve before
  // anything happened: wait for the document the logout REDIRECTS to.
  const landed = page.waitForResponse((res) => {
    const req = res.request();
    return req.isNavigationRequest() && new URL(res.url()).pathname === "/" && Boolean(req.redirectedFrom()?.url().includes("/auth/logout"));
  }, { timeout: 20_000 });
  const parsed = page.waitForEvent("domcontentloaded", { timeout: 20_000 });
  await page.locator('[data-levo-signout="confirm"]').click();
  await landed;
  await parsed;
}

const page = await context.newPage();
let phase = "A";
const thumbRequests = [];
page.on("request", (request) => {
  if (request.url().includes("/thumbnail")) thumbRequests.push({ phase, url: request.url() });
});

// =========================================================================
// A signs in, sees their own things
// =========================================================================
console.log("\naccount A");
await useSession(TOKENS.a1);
const idA = await accountProject("A-secret-project");
await page.goto(target, { waitUntil: "domcontentloaded" });
await seedDraft(page, { namespace: `user:${USER_A}`, id: "a-draft", name: "A-secret-draft" });
await seedDraft(page, { namespace: "guest", id: "guest-work-1", name: "Guest-work-before-sign-in" });
await openProjects(page);
await page.getByText("A-secret-project").first().waitFor({ timeout: 20_000 });
ok("A's account project is listed");
const thumbLoaded = await page
  .waitForFunction((id) => {
    const img = document.querySelector(`img[src*="${id}/thumbnail"]`);
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }, idA, { timeout: 15_000 })
  .then(() => true, () => false);
assert(thumbLoaded, "A's real thumbnail is rendered for A");
const thumbHeaders = (await api("GET", `/api/projects/${idA}/thumbnail`)).headers;
assert(/no-store/.test(thumbHeaders["cache-control"] ?? ""), "and it is served private, no-store", thumbHeaders["cache-control"]);
await deviceTab(page);
await page.getByText("A-secret-draft").first().waitFor({ timeout: 10_000 });
ok("A's local draft is listed on the device tab");
await accountTab(page);
assert(await page.getByText("Guest-work-before-sign-in").first().isVisible(), "the guest work is OFFERED to the signed-in user");
const afterA = await draftsOnDevice(page);
assert((afterA.guest ?? []).length === 1, "and stays a guest draft until someone says yes");

// Lifecycle UI on A's project: history restore, archive ≠ delete, trash.
console.log("\nlifecycle UI");
await commitRevision(idA, 1, "A-secret-project-v2");
const card = () => page.locator(".levo-projects-panel .lpp-card", { hasText: "A-secret-project" }).first();
await page.locator(".lpp-views button").nth(1).click(); // refresh by toggling views
await page.locator(".lpp-views button").nth(0).click();
await card().waitFor({ timeout: 10_000 });
await card().getByRole("button", { name: "History" }).click();
const versions = page.locator(".lpp-version");
await versions.first().waitFor({ timeout: 10_000 });
assert(await versions.count() === 2, "the history lists both kept versions", String(await versions.count()));
assert((await versions.first().innerText()).includes("Current"), "the newest is marked current");
await versions.nth(1).getByRole("button", { name: "Make this the current version" }).click();
await versions.nth(1).locator(".lpp-confirm button.lpp-primary").click();
await page.getByText("Version 1 is now the current version.").waitFor({ timeout: 15_000 });
await page.waitForFunction(() => document.querySelectorAll(".lpp-version").length === 3, null, { timeout: 10_000 });
assert((await versions.first().innerText()).includes("Version 3"), "the restore is a NEW head (version 3), history kept");
await versions.nth(2).getByRole("button", { name: "Keep this version" }).click();
await versions.nth(2).getByText("Kept by you").waitFor({ timeout: 10_000 });
ok("keep-this-version pins it and the history says so");
await page.getByRole("button", { name: "Back" }).click();
await card().getByRole("button", { name: "Archive" }).click();
await card().waitFor({ state: "detached", timeout: 10_000 });
ok("archive takes it out of the Projects list");
await page.locator(".lpp-views button").nth(1).click();
await card().waitFor({ timeout: 10_000 });
ok("and it is in Archived — not in the Trash");
await card().getByRole("button", { name: "Unarchive" }).click();
await card().waitFor({ state: "detached", timeout: 10_000 });
await page.locator(".lpp-views button").nth(0).click();
await card().getByRole("button", { name: "Delete" }).click();
await card().getByRole("button", { name: "Yes, move it" }).click();
await card().waitFor({ state: "detached", timeout: 10_000 });
await page.locator(".lpp-views button").nth(2).click();
await card().waitFor({ timeout: 10_000 });
assert((await card().innerText()).includes("Removed permanently on"), "the Trash says when it will be removed");
await card().getByRole("button", { name: "Restore" }).click();
await card().waitFor({ state: "detached", timeout: 10_000 });
await page.locator(".lpp-views button").nth(0).click();
await card().waitFor({ timeout: 10_000 });
ok("restored from the Trash back into Projects");
await closeSheet(page);

// =========================================================================
// A signs out (no purge), B signs in — same browser
// =========================================================================
console.log("\nswitch to account B");
await signOut(page, false);
phase = "B";
await useSession(TOKENS.b);
await accountProject("B-own-project");
await page.goto(target, { waitUntil: "domcontentloaded" });
await openProjects(page);
await page.getByText("B-own-project").first().waitFor({ timeout: 20_000 });
ok("B's own project is listed");
const bodyText = await page.locator(".levo-projects-panel").innerText();
assert(!bodyText.includes("A-secret-project"), "no A project name anywhere in B's panel");
assert(await page.locator(`img[src*="${idA}"]`).count() === 0, "no A thumbnail element in B's panel");
assert(!thumbRequests.some((r) => r.phase === "B" && r.url.includes(idA)), "and B's page never even requested A's thumbnail");
const forcedThumb = await page.evaluate(async (url) => (await fetch(url, { cache: "force-cache" })).status, `/api/projects/${idA}/thumbnail`);
assert(forcedThumb === 404, "A's thumbnail is not servable to B, not even from the HTTP cache", `force-cache → ${forcedThumb}`);
const forcedList = await page.evaluate(async () => (await fetch("/api/projects", { cache: "force-cache" })).text());
assert(!forcedList.includes("A-secret-project"), "no cached A project list is served to B");
await deviceTab(page);
await page.waitForTimeout(500);
assert(!(await page.locator(".levo-projects-panel").innerText()).includes("A-secret-draft"), "no A draft on B's device tab");

// =========================================================================
// 05 — B adopts the guest work only on the explicit click
// =========================================================================
console.log("\nguest work: offered, adopted only on consent");
await accountTab(page);
const offered = page.locator(".lpp-guestwork");
assert(await offered.isVisible(), "the guest work is offered to B");
const listBefore = await api("GET", "/api/projects");
assert(!JSON.stringify(listBefore.json).includes("Guest-work-before-sign-in"), "it is NOT in B's account before the click");
await offered.locator("button.lpp-primary").first().click();
await page.locator(".lpp-ok").waitFor({ timeout: 20_000 });
const listAfter = await api("GET", "/api/projects");
const adoptedProject = (listAfter.json?.projects ?? []).find((p) => p.name === "Guest-work-before-sign-in");
assert(Boolean(adoptedProject), "after the click it is an account project of B's");
assert(adoptedProject?.head_revision === 1, "with its bytes committed as revision 1");
const afterAdopt = await draftsOnDevice(page);
assert((afterAdopt.guest ?? []).length === 0, "and it left the guest namespace");
assert((afterAdopt[`user:${USER_B}`] ?? []).some((d) => d.remote === adoptedProject?.id), "into B's namespace, linked to the new project");
assert((afterAdopt[`user:${USER_A}`] ?? []).some((d) => d.name === "A-secret-draft"), "A's draft is still on the device (A did not ask to purge)");
await closeSheet(page);

// =========================================================================
// A comes back and signs out WITH the purge
// =========================================================================
console.log("\nsign-out purge");
await signOut(page, false);
phase = "A2";
await useSession(TOKENS.a2);
await page.goto(target, { waitUntil: "domcontentloaded" });
await seedDraft(page, { namespace: "guest", id: "guest-work-2", name: "Second-guest-work" });
await signOut(page, true);
const afterPurge = await draftsOnDevice(page);
assert((afterPurge[`user:${USER_A}`] ?? []).length === 0, "A's drafts are gone from the device");
assert((afterPurge[`user:${USER_B}`] ?? []).length === 1, "B's draft is untouched");
assert((afterPurge.guest ?? []).length === 1, "guest work is untouched");
const signedOut = await api("GET", "/api/quota");
assert(signedOut.status === 401, "and the session really ended", String(signedOut.status));

await browser.close();

writeFileSync(REPORT_PATH, JSON.stringify({ target, failures, checks }, null, 2) + "\n");
console.log(`\naccount-switch: ${checks.length - failures}/${checks.length} checks passed -> ${REPORT_PATH.slice(STUDIO_ROOT.length + 1)}`);
process.exit(failures ? 1 : 0);
