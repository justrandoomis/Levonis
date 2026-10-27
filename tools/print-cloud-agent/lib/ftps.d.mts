import type { Socket } from 'node:net';

export class FtpError extends Error {
  constructor(message: string, code?: number | null);
  code: number | null;
}

export function parsePasv(text: string): { host: string; port: number };

export function ftpsStore(p: {
  host: string;
  port?: number;
  user: string;
  password: string;
  remoteName: string;
  data: Buffer;
  connect?: (p: { host: string; port: number; purpose: 'control' | 'data'; timeoutMs: number }) => Promise<Socket>;
  secure: (socket: Socket, p: { purpose: 'control' | 'data'; session?: Buffer }) => Promise<Socket>;
  timeoutMs?: number;
  log?: unknown;
}): Promise<{ bytes: number; transcript: string[] }>;
