/**
 * Correlation (`01-TARGET.md` §11.2): the gateway mints a UUIDv7 `cid`; every
 * RPC passes `ctx.cid`; every envelope carries `correlation_id`; consumers set
 * `causation_id`; responses echo `x-correlation-id`. Browsers' values are ignored.
 */
import { CORRELATION_HEADER } from '@levonis/contracts/http/common';

export { CORRELATION_HEADER };

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** UUIDv7: 48-bit unix-ms timestamp, version nibble 7, variant 10, 74 random bits. Time-ordered. */
export function uuidv7(clock: Clock = systemClock, random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const ms = clock.now();
  const bytes = random(new Uint8Array(16));
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isUuidV7 = (s: unknown): s is string => typeof s === 'string' && UUID_V7.test(s);

/** The millisecond timestamp a UUIDv7 was minted at. */
export function uuidv7Time(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/**
 * The correlation id for an inbound request: accepted only from a trusted
 * internal caller (the gateway forwarding to a service); anything a browser
 * sends is ignored and a fresh id is minted.
 */
export function correlationFor(headers: Headers, opts: { trusted: boolean; clock?: Clock }): string {
  const given = headers.get(CORRELATION_HEADER);
  if (opts.trusted && isUuidV7(given)) return given;
  return uuidv7(opts.clock);
}

/** `req_<uuidv7>` — the per-request id logged next to the cid. */
export const newRequestId = (clock?: Clock) => `req_${uuidv7(clock)}`;

/** Headers a caller sets when forwarding a request or calling over a binding. */
export function correlationHeaders(cid: string): Record<string, string> {
  return { [CORRELATION_HEADER]: cid };
}
