export const VERSION: string;
export const EXIT: { OK: 0; FAILED: 1; USAGE: 64; NOPERM: 77; CONFIG: 78 };
export function parseArgs(argv: string[]): {
  config?: string;
  check: boolean;
  init: boolean;
  repair: boolean;
  bedCleared?: string;
  fingerprint?: string;
  help: boolean;
  version: boolean;
  error?: string;
};
export function main(argv: string[], io?: { env?: Record<string, string | undefined>; print?: (s: string) => void; signals?: boolean }): Promise<number>;
