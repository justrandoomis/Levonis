#!/usr/bin/env node
/**
 * Post-build prune of ORPHANED chunks from the server bundle.
 *
 * Why: dist/server/wrangler.json ships rules { ESModule: ["**\/*.js"] }, so
 * wrangler uploads every .js under dist/server as part of the worker script.
 * The browser-only engine worker bundles (slicer.worker + slicer_core ~18 MiB)
 * are emitted into dist/server/ssr/assets by the worker build pipeline even
 * though nothing in the server graph imports them — pushing the upload far
 * past the Workers size limit. This script removes files under
 * dist/server/ssr/assets that no OTHER server file references, iterating to a
 * fixpoint so reference chains (core <- worker <- nothing) fully disappear.
 * It never touches referenced files, so a future real server dependency is
 * safe; it fails loudly if the entry is missing.
 */
import { readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const root = new URL("../dist/server", import.meta.url).pathname;
const assetsDir = join(root, "ssr", "assets");
if (!existsSync(join(root, "index.js"))) {
  console.error("prune-server-orphans: dist/server/index.js missing — run the build first");
  process.exit(1);
}
if (!existsSync(assetsDir)) {
  console.log("prune-server-orphans: no ssr/assets dir — nothing to prune");
  process.exit(0);
}

function allServerFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allServerFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

let removedTotal = 0;
for (let pass = 0; pass < 10; pass++) {
  const files = allServerFiles(root);
  const corpus = files
    .filter((p) => /\.(js|mjs|json)$/.test(p))
    .map((p) => ({ p, text: readFileSync(p, "utf8") }));
  const candidates = allServerFiles(assetsDir);
  const removed = [];
  for (const cand of candidates) {
    const name = basename(cand);
    const referenced = corpus.some(({ p, text }) => p !== cand && text.includes(name));
    if (!referenced) {
      unlinkSync(cand);
      removed.push(name);
    }
  }
  removedTotal += removed.length;
  if (removed.length === 0) break;
  console.log(`prune-server-orphans pass ${pass + 1}: removed ${removed.length} orphan(s):`);
  for (const n of removed) console.log(`  - ${n}`);
}
console.log(`prune-server-orphans: done (${removedTotal} file(s) removed)`);
