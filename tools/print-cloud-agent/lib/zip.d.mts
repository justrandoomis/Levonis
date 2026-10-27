export class ZipError extends Error {}
export function isZip(buf: Buffer): boolean;
export function readZip(buf: Buffer, opts?: { maxEntryBytes?: number }): { names: string[]; read: (name: string) => Buffer | null };
