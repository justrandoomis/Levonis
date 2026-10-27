export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  addSecret(secret: string): void;
  child(fields: Record<string, unknown>): Logger;
}
export function createLogger(opts?: {
  level?: 'debug' | 'info' | 'warn' | 'error';
  sink?: (line: string) => void;
  clock?: () => number;
  secrets?: string[];
  fields?: Record<string, unknown>;
}): Logger;
export const silentLogger: Logger;
