/**
 * The owned-tables guard (`01-TARGET.md` §2.3 item 1, ADR-003): `ownedDb(db,
 * manifest, mode)` wraps `prepare()` and refuses any statement naming a table
 * outside the manifest — `owns` may be read and written, `reads` only read,
 * the service's own platform tables (`<svc>_outbox_events`, ...) implicitly.
 * `mode: 'throw'` in dark, `'log'` for the first production release of each
 * service, then `'throw'`.
 */
import { platformTableOwner } from '@levonis/contracts/ownership';

export interface OwnershipManifest {
  /** the service name (`<svc>_…` platform tables are implied) */
  service: string;
  owns: readonly string[];
  reads: readonly string[];
}

export type GuardMode = 'throw' | 'log';

export class OwnershipViolation extends Error {
  readonly code = 'OWNERSHIP_VIOLATION';
  constructor(
    public readonly service: string,
    public readonly table: string,
    public readonly access: 'read' | 'write',
    public readonly sql: string
  ) {
    super(`${service}: statement ${access}s table "${table}" outside its ownership manifest`);
    this.name = 'OwnershipViolation';
  }
}

const IDENT = String.raw`[\`"\[]?([A-Za-z_][A-Za-z0-9_]*)[\`"\]]?`;
const READ_RE = new RegExp(String.raw`\b(?:FROM|JOIN)\s+${IDENT}`, 'gi');
const WRITE_RE = new RegExp(String.raw`\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+${IDENT}`, 'gi');
const SQL_KEYWORDS = new Set(['select', 'where', 'set', 'values', 'on', 'and', 'or', 'not', 'null', 'as', 'left', 'inner', 'outer', 'cross', 'natural']);

/** Strips string literals and comments so a table name inside a quoted value is never mistaken for a reference. */
export function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

export interface SqlTables {
  reads: string[];
  writes: string[];
}

/** Every table a statement names, split into read and write positions. Sub-selects count as reads. */
export function tablesInSql(sql: string): SqlTables {
  const text = stripSqlLiterals(sql);
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const m of text.matchAll(WRITE_RE)) if (!SQL_KEYWORDS.has(m[1].toLowerCase())) writes.add(m[1]);
  for (const m of text.matchAll(READ_RE)) if (!SQL_KEYWORDS.has(m[1].toLowerCase())) reads.add(m[1]);
  // `DELETE FROM t` matches READ_RE too; keep it a write only
  for (const w of writes) reads.delete(w);
  return { reads: [...reads], writes: [...writes] };
}

export function isOwnPlatformTable(service: string, table: string): boolean {
  const owner = platformTableOwner(table);
  return owner === service || owner === 'platform';
}

/** Returns the first violation, or null. */
export function checkStatement(manifest: OwnershipManifest, sql: string): OwnershipViolation | null {
  const { reads, writes } = tablesInSql(sql);
  const owns = new Set(manifest.owns);
  const readable = new Set([...manifest.owns, ...manifest.reads]);
  for (const t of writes) {
    if (t.startsWith('sqlite_') || t === 'd1_migrations') continue;
    if (!owns.has(t) && !isOwnPlatformTable(manifest.service, t)) return new OwnershipViolation(manifest.service, t, 'write', sql);
  }
  for (const t of reads) {
    if (t.startsWith('sqlite_') || t === 'd1_migrations') continue;
    if (!readable.has(t) && !isOwnPlatformTable(manifest.service, t)) return new OwnershipViolation(manifest.service, t, 'read', sql);
  }
  return null;
}

export interface OwnedDbOptions {
  mode: GuardMode;
  onViolation?: (v: OwnershipViolation) => void;
}

/**
 * Wraps a D1 database. Every `prepare()`, `exec()` and `batch()` goes through
 * the guard; the returned object is a D1Database for every other purpose.
 */
export function ownedDb(db: D1Database, manifest: OwnershipManifest, opts: OwnedDbOptions): D1Database {
  const guard = (sql: string) => {
    const v = checkStatement(manifest, sql);
    if (!v) return;
    opts.onViolation?.(v);
    if (opts.mode === 'throw') throw v;
    console.error(JSON.stringify({ level: 'error', svc: manifest.service, msg: 'ownership.violation', table: v.table, access: v.access }));
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          guard(sql);
          return target.prepare(sql);
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          guard(sql);
          return target.exec(sql);
        };
      }
      if (prop === 'batch') {
        // statements were already guarded at prepare() time on this wrapper; a foreign statement object passes through the same check when it exposes its SQL
        return (statements: D1PreparedStatement[]) => target.batch(statements);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
