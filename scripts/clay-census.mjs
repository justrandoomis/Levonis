#!/usr/bin/env node
/**
 * THE CLAY CENSUS — what the tokens cannot reach, file by file (read-only).
 *
 *   node scripts/clay-census.mjs                 families, then every file with a finding
 *   node scripts/clay-census.mjs --suggest       …plus a candidate rewrite for each finding
 *   node scripts/clay-census.mjs --suggest Tools only files whose path contains «Tools»
 *   node scripts/clay-census.mjs --json          the totals, as JSON
 *
 * WHY. The «Layered clay» tokens (docs/DECISIONS.md rows 207–209) restyle
 * every surface that names a semantic class: `lv-surface`, `lv-button`,
 * `lv-input`, `rounded-xl`, `shadow-sm`. They cannot reach a screen that
 * draws its own card out of `rounded-xl border border-zinc-800 bg-zinc-900`,
 * its own button out of `h-11 rounded-xl bg-gold`, its own field out of a
 * bare `<input className="bg-zinc-950 …">`, or its own corner as
 * `rounded-[14px]`. Those are converted by hand, family by family (build plan
 * §6 Phase 3). This script finds them and proposes the rewrite; a person
 * applies and reviews each one. IT NEVER WRITES A SOURCE FILE.
 *
 * THE RATCHET. tests/claySystem.test.ts imports `census()` from here and
 * fails when any of the four ratchet counts (legacy cards, ad-hoc buttons,
 * raw inputs, arbitrary radii) is above the number checked into the test. A
 * family push lowers the numbers in the same commit, so they never rise.
 *
 * The regexes are the judge's census (`families.mjs`, build plan §0) unchanged,
 * so the numbers here are the numbers the plan was written against.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The four counts the ratchet holds down, by key and by name. */
export const RATCHET = {
  legacy: 'legacy card strings',
  btn: 'ad-hoc button strings',
  rawIn: 'raw unstyled inputs',
  arbR: 'arbitrary radii (rounded-[Npx])',
};

/** The page family a file belongs to (build plan §6 Phase 3). */
export function familyOf(file) {
  const p = file.replace(/^src\//, '');
  if (/^components\/ui\//.test(p)) return 'ui-primitives';
  if (/^(pages\/Auth|components\/auth\/)/.test(p)) return 'auth';
  if (/^(pages\/(Admin|LegacyInvestment)|components\/(Admin|admin|DashboardLayout|financeWorkspace|financePeople)|components\/scanner)/.test(p)) return 'admin';
  if (/^(pages\/(Storefront|StorefrontProduct|StoreCheckout|MerchantStore|CommunityStorePage)\.tsx|components\/storefront\/)/.test(p)) return 'storefront-merchant-stores';
  if (/^(pages\/(MerchantDashboardPage|MerchantStart)\.tsx|components\/merchant\/)/.test(p)) return 'merchant-workspace';
  if (/^(pages\/(Community|Requests)\.tsx|pages\/community\/|components\/community\/)/.test(p)) return 'community';
  if (/^(pages\/(Profile|EditProfile|Settings|Addresses|Wallet|Rewards|Referrals|Subscription|Earnings|FollowedStores|Leaderboards|Support|Chats|Chat|Welcome)\.tsx|components\/(kyc|returns|profile|address|chat|membership|subscription|notifications|notify|onboarding|security|pwa)\/)/.test(p)) return 'account';
  if (/^(pages\/(games|farm|Games)|components\/(adminFarm)\/)/.test(p)) return 'games';
  return 'shop';
}

// ------------------------------------------------------------------ patterns
/** Every quoted string (', ", `), template literals across lines included. */
const STRING = /(["'`])((?:(?!\1)[^\\]|\\.)*?)\1/g;
const HAS_RADIUS = /\brounded-(lg|xl|2xl|3xl|\[(1[2-9]|2\d|3\d)px\])/;
const HAS_BORDER = /(^|\s)border(\s|$)|\bborder-(border-subtle|zinc|white\/)/;
const HAS_GROUND = /\bbg-(surface|zinc|white\/|black\/|canvas|charcoal)/;
const SEMANTIC_CARD = /bg-surface|border-border-subtle|bg-canvas/;
const BUTTON_HEIGHT = /\b(min-)?h-1[01]\b/;
const PAGE_WRAPPER = /\bmin-h-(screen|\[100dvh\]|full|dvh)/;
const ARB_RADIUS = /rounded(?:-[a-z]{1,2})?-\[\d+(?:\.\d+)?(?:px|rem)\]/g;
const ARB_SHADOW = /shadow-\[[^\]\s"'`]*\]/g;
const SHADOW_KEEPERS = /200vmax|0_0_0_3px|inset_0_0_0_1px|--ap-shadow|0_0_0_1px_var\(--color-text-primary\)/;
const RAW_INPUT = /<(input|select|textarea)\b(?![^>]*lv-input)(?![^>]*type=["'](?:checkbox|radio|hidden|file|range|color)["'])/g;
const ZINC = /\b(bg|border|ring|divide)-zinc-\d{2,3}(\/\d+)?\b/g;

/** Is this quoted class string a hand-drawn card (radius + border + ground, no semantic class)? */
export const isLegacyCard = (s) => HAS_RADIUS.test(s) && HAS_BORDER.test(s) && HAS_GROUND.test(s) && !SEMANTIC_CARD.test(s);
/** Is this quoted class string a hand-drawn 40–44px button (height + fill + radius, not lv-button)? */
export const isAdHocButton = (s) => BUTTON_HEIGHT.test(s) && /\bbg-/.test(s) && /\brounded/.test(s) && !/lv-button/.test(s);

/** A function from a character offset to its 1-based line number. */
function lineIndex(src) {
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The findings of one file's source, each with its line and its text. */
export function scanSource(src) {
  const lineAt = lineIndex(src);
  const found = { legacy: [], btn: [], rawIn: [], arbR: [], arbS: [], blur: [], wrap: [], zinc: 0 };
  for (const m of src.matchAll(STRING)) {
    const s = m[2];
    if (s.length > 600 || !/\s/.test(s)) continue;
    const at = () => ({ line: lineAt(m.index), text: s });
    if (isLegacyCard(s)) found.legacy.push(at());
    if (isAdHocButton(s)) found.btn.push(at());
    if (/\b(bg-canvas|bg-black)\b/.test(s) && PAGE_WRAPPER.test(s)) found.wrap.push(at());
  }
  for (const m of src.matchAll(ARB_RADIUS)) found.arbR.push({ line: lineAt(m.index), text: m[0] });
  for (const m of src.matchAll(ARB_SHADOW)) if (!SHADOW_KEEPERS.test(m[0])) found.arbS.push({ line: lineAt(m.index), text: m[0] });
  for (const m of src.matchAll(/backdrop-blur/g)) found.blur.push({ line: lineAt(m.index), text: m[0] });
  for (const m of src.matchAll(RAW_INPUT)) found.rawIn.push({ line: lineAt(m.index), text: src.slice(m.index, m.index + 120).split('\n')[0] });
  found.zinc = (src.match(ZINC) || []).length;
  return found;
}

/** Every .tsx file under src/, as a repo-relative path, sorted. */
export function sourceFiles(root = ROOT) {
  return readdirSync(join(root, 'src'), { recursive: true })
    .map((f) => String(f).split('\\').join('/'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `src/${f}`)
    .sort();
}

/**
 * The census of the whole tree: one row per file with a finding, and the
 * totals. `counts` has the four ratchet keys plus the informational ones.
 */
export function census(root = ROOT) {
  const rows = [];
  const totals = { legacy: 0, btn: 0, rawIn: 0, arbR: 0, arbS: 0, blur: 0, wrap: 0, zinc: 0 };
  for (const file of sourceFiles(root)) {
    const found = scanSource(readFileSync(join(root, file), 'utf8'));
    const counts = {
      legacy: found.legacy.length,
      btn: found.btn.length,
      rawIn: found.rawIn.length,
      arbR: found.arbR.length,
      arbS: found.arbS.length,
      blur: found.blur.length,
      wrap: found.wrap.length,
      zinc: found.zinc,
    };
    const score = counts.legacy * 3 + counts.btn * 2 + counts.rawIn + counts.arbR + counts.arbS * 2 + counts.blur * 2 + counts.zinc * 0.25 + counts.wrap;
    if (score === 0) continue;
    for (const k of Object.keys(totals)) totals[k] += counts[k];
    rows.push({ file, family: familyOf(file), counts, score, found });
  }
  return { rows, totals };
}

// ---------------------------------------------------------- the suggestions
/** The role radii (build plan §3.1), in px. */
const ROLE_RADII = [
  [4, 'rounded'],
  [10, 'rounded-sm'],
  [14, 'rounded-md'],
  [18, 'rounded-lg'],
  [22, 'rounded-xl'],
  [24, 'rounded-2xl'],
  [32, 'rounded-3xl'],
];

/** `rounded-t-[14px]` → `rounded-t-md`: the nearest role radius, side kept. */
export function nearestRadius(token) {
  const m = /^rounded(-[a-z]{1,2})?-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(token);
  if (!m) return null;
  const px = Number(m[2]) * (m[3] === 'rem' ? 16 : 1);
  const [, name] = ROLE_RADII.reduce((best, r) => (Math.abs(r[0] - px) < Math.abs(best[0] - px) ? r : best));
  const side = m[1] ?? '';
  return name === 'rounded' ? `rounded${side}` : name.replace('rounded', `rounded${side}`);
}

/** The house button variant a hand-drawn button most likely means. */
export function buttonVariant(s) {
  if (/\bbg-(red|rose|danger)\b|\bbg-(red|rose)-\d|\bbg-danger\//.test(s)) return 'danger';
  if (/\bbg-(gold|olive|primary-fill)\b|\bbg-gold\//.test(s)) return /\btext-(gold|accent)/.test(s) ? 'accent' : 'primary';
  if (/\bbg-transparent\b/.test(s)) return 'ghost';
  return 'secondary';
}

const clip = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One line per finding: where it is, what it is, what it could become. */
export function suggestions(row) {
  const out = [];
  for (const f of row.found.legacy) {
    const pad = (f.text.match(/\bp[xy]?-[\d.]+\b/g) || []).join(' ');
    out.push(`  ${row.file}:${f.line}  card    "${clip(f.text)}"\n      → lv-surface${pad ? ` ${pad}` : ''} (inside another card: a flat bg-surface-raised rounded-lg, an lv-well, or dividers)`);
  }
  for (const f of row.found.btn) {
    out.push(`  ${row.file}:${f.line}  button  "${clip(f.text)}"\n      → <Button variant="${buttonVariant(f.text)}"> (or lv-button lv-button-${buttonVariant(f.text)})`);
  }
  for (const f of row.found.rawIn) {
    out.push(`  ${row.file}:${f.line}  input   ${clip(f.text)}\n      → className="lv-input …" inside a <Field> (label, hint and error bound)`);
  }
  for (const f of row.found.arbR) {
    out.push(`  ${row.file}:${f.line}  radius  ${f.text} → ${nearestRadius(f.text) ?? '(nearest role radius)'}`);
  }
  for (const f of row.found.wrap) {
    out.push(`  ${row.file}:${f.line}  wrapper "${clip(f.text)}"\n      → drop the bg-canvas / bg-black fill so the shell's light shows (keep it on a store page)`);
  }
  return out;
}

// --------------------------------------------------------------------- CLI
function main(argv) {
  const json = argv.includes('--json');
  const suggestAt = argv.indexOf('--suggest');
  const suggest = suggestAt >= 0;
  const filter = suggest && argv[suggestAt + 1] && !argv[suggestAt + 1].startsWith('--') ? argv[suggestAt + 1] : null;
  const { rows, totals } = census();
  if (json) {
    process.stdout.write(`${JSON.stringify({ totals, files: rows.length }, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push('CLAY CENSUS (read-only) — src/**/*.tsx');
  lines.push(`ratchet: ${Object.entries(RATCHET).map(([k, name]) => `${name} ${totals[k]}`).join(' · ')}`);
  lines.push(`also: arbitrary shadows ${totals.arbS} · backdrop blur ${totals.blur} · canvas wrappers ${totals.wrap} · zinc utilities ${totals.zinc}`);
  const byFamily = new Map();
  for (const r of rows) {
    if (!byFamily.has(r.family)) byFamily.set(r.family, []);
    byFamily.get(r.family).push(r);
  }
  for (const [family, list] of [...byFamily.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sum = (k) => list.reduce((s, r) => s + r.counts[k], 0);
    lines.push('');
    lines.push(`## ${family}: ${list.length} files · cards ${sum('legacy')} · buttons ${sum('btn')} · inputs ${sum('rawIn')} · radii ${sum('arbR')} · shadows ${sum('arbS')} · blur ${sum('blur')} · wrappers ${sum('wrap')} · zinc ${sum('zinc')}`);
    for (const r of [...list].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))) {
      if (filter && !r.file.includes(filter)) continue;
      const c = r.counts;
      lines.push(`${r.file}\tcards ${c.legacy}\tbtn ${c.btn}\tin ${c.rawIn}\tr ${c.arbR}\ts ${c.arbS}\tblur ${c.blur}\twrap ${c.wrap}\tzinc ${c.zinc}`);
      if (suggest) lines.push(...suggestions(r));
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
