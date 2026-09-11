/**
 * Drizzle accessor for the Studio-only D1 database (`levonis-studio-db`).
 *
 * The worker API handlers (worker/api/*) receive the `DB` binding explicitly
 * through their env and issue prepared statements directly, matching the
 * conventions of worker/auth/session.ts — this module is the typed Drizzle
 * entry point for code that prefers the query builder, and the schema import
 * chain drizzle-kit uses to generate migrations into ./drizzle.
 *
 * The binding is passed in as a parameter (never read from a global): tests
 * and workers alike hand over whatever D1Database they hold.
 */
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type StudioDb = ReturnType<typeof createDb>;

export { schema };
