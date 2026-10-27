export const STATE_FILE: string;
export const BOOT_JOURNAL: string;
export const LOCK_FILE: string;
export type StateErrorCode = 'STATE_UNREADABLE' | 'STATE_MISSING' | 'STATE_STALE' | 'STATE_LOCKED' | 'STATE_INVALID_NAME';
export class StateError extends Error {
  constructor(code: StateErrorCode, message: string);
  code: StateErrorCode;
}
export function atomicWriteFile(path: string, data: string | Buffer): void;
export function journalHighWater(dir: string): number | null;
export function readStateFile(dir: string): { version?: number; boot: number; started_at?: string } | null;
export class AgentState {
  static open(dir: string, opts?: { init?: boolean; repair?: boolean; clock?: () => number }): AgentState;
  private constructor(dir: string, boot: number, lockPath: string);
  readonly dir: string;
  /** The boot counter of this process run. */
  readonly boot: number;
  nextSeq(): number;
  readJson<T = unknown>(name: string, fallback?: T | null): T | null;
  writeJson(name: string, value: unknown): void;
  remove(name: string): void;
  list(dirName: string): string[];
  path(...parts: string[]): string;
  exists(name: string): boolean;
  close(): void;
}
