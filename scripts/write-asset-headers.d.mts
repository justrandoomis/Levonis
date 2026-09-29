/**
 * Types for scripts/write-asset-headers.mjs, so tests/documentPreloads.test.ts
 * can import its pure helpers under tests/tsconfig.json (which typechecks the
 * scripts tree). The script itself stays plain JavaScript because `npm run
 * build` runs it under plain `node`.
 */
export const ARABIC_FONT_PRELOAD: string;
export function entryStylesheets(manifest: unknown): string[];
export function earlyHintsLink(styles: string[], font?: string | null): string;
export function earlyHintsLine(manifestPath?: string): string | null;
export function withEarlyHints(text: string, link: string | null): string;
