/**
 * The boundaries scanner behind `tests/serviceBoundaries.test.ts`
 * (`01-TARGET.md` §2.3 item 2, `02-MIGRATION-PLAN.md` §11). Pure functions
 * over source text so the rules can be unit-tested against inline samples and
 * then run over every `services/<name>/src` file.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tablesInSql } from '@levonis/platform-kit/db';
import { platformTableOwner } from '@levonis/contracts/ownership';

export interface OwnershipManifest {
  service?: string;
  owns: string[];
  reads: string[];
  calls?: string[];
  publishes?: string[];
  consumes?: string[];
  secrets?: string[];
  legacyRoutes?: string[];
}

export const MANIFEST_NAMES = ['OWNERSHIP.json', 'ownership.json'] as const;

export function listServices(root: string): string[] {
  const dir = join(root, 'services');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory() && !d.startsWith('.'))
    .filter((d) => existsSync(join(dir, d, 'package.json')) || existsSync(join(dir, d, 'wrangler.jsonc')) || existsSync(join(dir, d, 'src')))
    .sort();
}

export function manifestPath(serviceDir: string): string | null {
  for (const name of MANIFEST_NAMES) {
    const p = join(serviceDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function readManifest(serviceDir: string): OwnershipManifest | null {
  const p = manifestPath(serviceDir);
  if (!p) return null;
  const m = JSON.parse(readFileSync(p, 'utf8')) as Partial<OwnershipManifest>;
  return { ...m, owns: m.owns ?? [], reads: m.reads ?? [] };
}

export function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.(ts|tsx|mts)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(p);
  }
  return out.sort();
}

/** Every static/dynamic import specifier in a source file. */
export function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

/** String and template literals that look like SQL. `${…}` expressions are blanked so an interpolated table name is not mistaken for a literal one. */
export function sqlLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  for (const m of src.matchAll(re)) {
    const text = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ? ');
    if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE)\b/i.test(text)) out.push(text);
  }
  return out;
}

export interface CheckContext {
  root: string; // repo root
  service: string; // directory name under services/
  file: string; // absolute path of the file being checked
  manifest: OwnershipManifest;
}

const CORE_LIB_FACADES = /worker\/lib\/(ratelimit|audit|session)\b/;
const EVENT_KEY_FROM_REQUEST = /eventKey\s*[:=]\s*[^,;]*(c\.req\.header|body\.|req\.)/;
const BARE_FETCH = /(?<![.\w])fetch\s*\(/;

/** True for the one allowed cross-package import inside a deployable: a sibling's statement descriptors (ADR-004). */
export function isSiblingStatementsImport(resolved: string, serviceRoot: string): boolean {
  const rel = relative(serviceRoot, resolved).split(sep).join('/');
  return /^src\/[^/]+\/statements(\.ts)?$/.test(rel);
}

export function checkSource(ctx: CheckContext, src: string): string[] {
  const violations: string[] = [];
  const serviceRoot = join(ctx.root, 'services', ctx.service);
  const fileRel = relative(ctx.root, ctx.file).split(sep).join('/');
  const owner = ctx.manifest.service ?? ctx.service;
  const allowed = new Set([...ctx.manifest.owns, ...ctx.manifest.reads]);
  const writable = new Set(ctx.manifest.owns);
  const isOwnPlatform = (t: string) => {
    const o = platformTableOwner(t);
    return o === owner || o === 'platform';
  };

  for (const sql of sqlLiterals(src)) {
    const { reads, writes } = tablesInSql(sql);
    for (const t of writes) if (!writable.has(t) && !isOwnPlatform(t)) violations.push(`${fileRel}: writes table "${t}" outside the ownership manifest`);
    for (const t of reads) if (!allowed.has(t) && !isOwnPlatform(t)) violations.push(`${fileRel}: reads table "${t}" outside the ownership manifest`);
  }

  for (const spec of importSpecifiers(src)) {
    if (CORE_LIB_FACADES.test(spec)) violations.push(`${fileRel}: imports a core lib (${spec}) — use the platform kit facade`);
    if (spec.startsWith('.')) {
      const resolved = resolve(dirname(ctx.file), spec);
      const rel = relative(ctx.root, resolved).split(sep).join('/');
      if (rel.startsWith('worker/')) violations.push(`${fileRel}: imports the core (${spec})`);
      else if (rel.startsWith('services/') && !rel.startsWith(`services/${ctx.service}/`)) violations.push(`${fileRel}: imports another service (${spec})`);
      else if (rel.startsWith(`services/${ctx.service}/`)) {
        // inside the deployable: another package's code is allowed only through its statements.ts
        const parts = rel.split('/');
        const mine = relative(ctx.root, ctx.file).split(sep).join('/').split('/');
        if (parts[2] === 'src' && mine[2] === 'src' && parts[3] !== mine[3] && parts.length > 4 && mine.length > 4 && !isSiblingStatementsImport(resolved, serviceRoot)) {
          violations.push(`${fileRel}: imports a sibling package's internals (${spec}) — only statements.ts may cross packages`);
        }
      }
    } else if (/^(worker|services)\//.test(spec) || /^@\/(worker|services)\//.test(spec)) {
      violations.push(`${fileRel}: imports the core or another service (${spec})`);
    }
  }

  if (BARE_FETCH.test(src) && !/platform-kit\/src\/httpx/.test(fileRel)) violations.push(`${fileRel}: uses bare fetch( — use fetchWithBudget`);
  if (EVENT_KEY_FROM_REQUEST.test(src)) violations.push(`${fileRel}: builds an eventKey from request input`);
  return violations;
}

export interface ToleranceEntry {
  table: string;
  writer: string; // '<file>#<symbol>' or '<file>#<METHOD> <route path>'
  reason: string;
  removed_in: string;
}

/** True when the writer symbol named by a tolerance entry exists in its file (a route path literal or a declared symbol). */
export function writerExists(root: string, entry: ToleranceEntry): { ok: boolean; why?: string } {
  const [file, symbol] = entry.writer.split('#');
  const path = join(root, file);
  if (!existsSync(path)) return { ok: false, why: `${file} does not exist` };
  const src = readFileSync(path, 'utf8');
  const route = /^(GET|POST|PUT|PATCH|DELETE) (.+)$/.exec(symbol);
  if (route) {
    const [, method, p] = route;
    const re = new RegExp(`\\.${method.toLowerCase()}\\(\\s*['"\`]${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
    return re.test(src) ? { ok: true } : { ok: false, why: `${file} has no ${method} ${p} route` };
  }
  const re = new RegExp(`(function\\s+${symbol}\\b|(const|let|class)\\s+${symbol}\\b|\\b${symbol}\\s*[:=]\\s*(async\\s*)?\\()`);
  return re.test(src) ? { ok: true } : { ok: false, why: `${file} does not declare ${symbol}` };
}
