export class ZipError extends Error {}
export function isZip(buf: Buffer): boolean;
export function readZip(buf: Buffer, opts?: { maxEntryBytes?: number }): { names: string[]; read: (name: string) => Buffer | null };
/** The same archive without the named entries; the kept entries' compressed bytes are copied as they are. */
export function zipWithout(buf: Buffer, drop: Set<string>): Buffer;
