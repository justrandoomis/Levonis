import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

export class TrustError extends Error {}

export function normalizeFingerprint(fp: unknown): string | null;

export function connectTls(p: {
  host: string;
  port?: number;
  socket?: Socket;
  trust: { mode: 'pin' | 'ca' | 'insecure'; fingerprint256?: string; ca_file?: string; ca_pem?: string; servername?: string };
  session?: Buffer;
  timeoutMs?: number;
  log?: unknown;
}): Promise<TLSSocket>;

export function peerFingerprint(
  host: string,
  port: number,
  timeoutMs?: number
): Promise<{ fingerprint256: string | null; subject: string | null; issuer: string | null; valid_to: string | null }>;
