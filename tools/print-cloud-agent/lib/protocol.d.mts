import type { Logger } from './log.mjs';

export const AGENT_BASE: string;

export class CloudError extends Error {
  constructor(p: { status: number; code?: string | null; message?: string; details?: unknown; retryable: boolean; cause?: unknown });
  /** HTTP status; 0 for a network error or a timeout. */
  status: number;
  code: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details: any;
  retryable: boolean;
}

/** The cloud refused the token itself (AGENT_UNAUTHORIZED), not a door it does not have. */
export function tokenRejected(e: unknown): boolean;

export interface CloudClientOptions {
  baseUrl: string;
  token: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  maxDownloadBytes?: number;
  sleep?: (ms: number) => Promise<unknown>;
  random?: () => number;
  clock?: () => number;
  log?: Logger;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class CloudClient {
  constructor(opts: CloudClientOptions);
  request(
    method: string,
    path: string,
    opts?: { body?: unknown; query?: Record<string, string | null | undefined>; retryStateChanged?: boolean; download?: boolean; attempts?: number }
  ): Promise<{ status: number; data: any; headers: Headers; bytes?: Buffer }>;
  printers(): Promise<Array<Record<string, any>>>;
  telemetry(printerId: string, body: Record<string, unknown> | (() => Record<string, unknown>)): Promise<{ stored: boolean; superseded?: boolean; mismatch: boolean }>;
  jobEvent(jobId: string, body: Record<string, unknown>): Promise<{ status: number; data: any }>;
  job(jobId: string): Promise<any | null>;
  commands(since: string | null): Promise<{ commands: Array<Record<string, any>>; serverNow: number | null }>;
  claimSlicing(): Promise<any | null>;
  slicingResult(requestId: string, estimate: Record<string, unknown>): Promise<any>;
  slicingFailure(requestId: string, errorCode: string): Promise<any>;
  downloadFile(fileIdOrPath: string): Promise<{ bytes: Buffer; filename: string | null }>;
}
