/**
 * drizzle-kit config for the Studio-only D1 database (levonis-studio-db).
 * `npx drizzle-kit generate` (from studio/) regenerates ./drizzle from
 * db/schema.ts; the deploy workflows apply the generated SQL with
 * `wrangler d1 migrations apply` (migrations_dir "drizzle" in wrangler.jsonc).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "sqlite",
});
