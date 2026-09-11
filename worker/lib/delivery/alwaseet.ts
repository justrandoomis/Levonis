/**
 * The Al-Waseet Merchant API driver.
 *
 * ------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * Al-Waseet's documentation at https://al-waseet.com/apis-main/index sits
 * behind a Cloudflare WAF that refuses every automated client we can reach it
 * from — this development environment and GitHub's runners both get "Sorry,
 * you have been blocked". So the exact request field names for creating a
 * shipment, and the exact path for reading one back, could NOT be read.
 *
 * There were two ways to handle that. Write plausible-looking field names and
 * ship code that looks finished and fails on the first real order — or make
 * the wire shape a small piece of owner-supplied configuration and refuse to
 * pretend until it exists. This file does the second.
 *
 * What that means concretely:
 *
 *   * Credentials are Worker SECRETS (ALWASEET_BASE_URL / _USERNAME /
 *     _PASSWORD) and are never returned by any route, logged, or written to a
 *     settings row an admin screen could read. That part is not provisional.
 *   * The endpoint paths and field names live in the `deliveryConfig` setting.
 *     `GET /v1/merchant/statuses` is the one path the owner documented, so it
 *     is the default; the rest start EMPTY.
 *   * Anything not yet configured returns { ok: false, retryable: false } with
 *     a message naming exactly what is missing. It never sends a guessed body,
 *     and — because of the rules in sync.ts — it never moves an order.
 *
 * Filling the config in is a five-minute job for anyone who can open that
 * documentation page. Until then the integration is honestly, visibly off
 * rather than quietly wrong.
 * ------------------------------------------------------------------------
 */

import type { Env } from '../types';
import type {
  CreatedShipment,
  DeliveryDriver,
  DriverResult,
  DriverUnavailable,
  RemoteShipmentStatus,
  RemoteStatus,
  ShipmentRequest,
} from './types';

export const ALWASEET = 'alwaseet';

/**
 * The parts of the wire format that had to be read off their docs.
 *
 * Every path is relative to ALWASEET_BASE_URL. `createFields` maps OUR field
 * names to THEIRS, so the owner writes e.g. {"customerName": "client_name"}
 * once and never touches this file.
 */
export interface AlwaseetWireConfig {
  statusesPath: string;
  loginPath: string;
  createPath: string;
  /** `{id}` is replaced with the courier's shipment id. */
  shipmentPath: string;
  /** ourFieldName -> theirFieldName, for the create-shipment body. */
  createFields: Record<string, string>;
  /** Their name for the city/governorate id we must send. */
  governorateMap: Record<string, string>;
}

export const DEFAULT_WIRE: AlwaseetWireConfig = {
  // The one endpoint the owner's brief actually documented.
  statusesPath: '/v1/merchant/statuses',
  loginPath: '',
  createPath: '',
  shipmentPath: '',
  createFields: {},
  governorateMap: {},
};

export function resolveWire(stored: unknown): AlwaseetWireConfig {
  const out: AlwaseetWireConfig = { ...DEFAULT_WIRE, createFields: {}, governorateMap: {} };
  if (!stored || typeof stored !== 'object') return out;
  const raw = stored as Record<string, unknown>;
  for (const k of ['statusesPath', 'loginPath', 'createPath', 'shipmentPath'] as const) {
    if (typeof raw[k] === 'string' && raw[k]) out[k] = raw[k] as string;
  }
  for (const k of ['createFields', 'governorateMap'] as const) {
    const v = raw[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [a, b] of Object.entries(v as Record<string, unknown>)) {
        if (typeof b === 'string' && b) out[k][a] = b;
      }
    }
  }
  return out;
}

/** Names only — a caller may render these; a VALUE must never reach a screen. */
export function missingCredentials(env: Env): string[] {
  const missing: string[] = [];
  if (!env.ALWASEET_BASE_URL) missing.push('ALWASEET_BASE_URL');
  if (!env.ALWASEET_USERNAME) missing.push('ALWASEET_USERNAME');
  if (!env.ALWASEET_PASSWORD) missing.push('ALWASEET_PASSWORD');
  return missing;
}

const notConfigured = <T>(what: string): DriverResult<T> => ({
  ok: false,
  // Non-retryable on purpose: retrying a missing configuration forever would
  // fill the log with noise and hide the one message that matters.
  retryable: false,
  error: `Al-Waseet ${what} is not configured yet. Set it in Admin → Delivery once the Merchant API documentation has been read.`,
});

/**
 * Reads a list of statuses out of whatever envelope the API returns.
 *
 * This is defensive rather than speculative: it looks for a list in the
 * obvious places and for an id/label pair in the obvious keys, and returns
 * an empty list if it finds neither — it does not invent ids. Once the real
 * shape is known this can collapse to one line.
 */
export function parseStatusList(body: unknown): RemoteStatus[] {
  const arr = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as Record<string, unknown>).data ??
         (body as Record<string, unknown>).statuses ??
         (body as Record<string, unknown>).result)
      : null;
  if (!Array.isArray(arr)) return [];
  const out: RemoteStatus[] = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = r.id ?? r.status_id ?? r.state_id ?? r.value;
    const text = r.status ?? r.name ?? r.title ?? r.text ?? r.label ?? r.status_name;
    if (id === undefined || id === null || String(id) === '') continue;
    out.push({ id: String(id), text: String(text ?? '') });
  }
  return out;
}

export class AlwaseetDriver implements DeliveryDriver {
  readonly provider = ALWASEET;
  private token: string | null = null;

  constructor(
    private env: Env,
    private wire: AlwaseetWireConfig
  ) {}

  private base(): string {
    return (this.env.ALWASEET_BASE_URL ?? '').replace(/\/+$/, '');
  }

  /**
   * One place every outbound call goes through, so a timeout, a non-JSON
   * body and an HTTP error all come back as the same shape.
   *
   * `retryable` is the field that matters downstream: a 5xx or a network
   * failure is worth trying again on the next sweep, a 4xx is the courier
   * telling us the request itself is wrong and retrying will not fix it.
   */
  private async call<T>(path: string, init?: RequestInit): Promise<DriverResult<T>> {
    const url = `${this.base()}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      // The URL is safe to include; credentials never appear in it.
      return { ok: false, retryable: true, error: `Could not reach Al-Waseet (${e instanceof Error ? e.message : 'network error'})` };
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
        error: `Al-Waseet answered ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    try {
      return { ok: true, value: JSON.parse(text) as T };
    } catch {
      return { ok: false, retryable: false, error: `Al-Waseet returned a non-JSON body: ${text.slice(0, 200)}` };
    }
  }

  async listStatuses(): Promise<DriverResult<RemoteStatus[]>> {
    if (missingCredentials(this.env).length > 0) return notConfigured('credentials');
    if (!this.wire.statusesPath) return notConfigured('statuses endpoint');
    const res = await this.call<unknown>(this.wire.statusesPath);
    if (!res.ok) return res;
    const parsed = parseStatusList(res.value);
    if (parsed.length === 0) {
      // An empty list is not success. Mapping nothing would leave every order
      // unmapped, which is safe but silent — say so instead.
      return {
        ok: false, retryable: false,
        error: 'Al-Waseet answered, but no status ids could be read from the response. The response shape needs checking against their documentation.',
      };
    }
    return { ok: true, value: parsed };
  }

  async createShipment(_req: ShipmentRequest): Promise<DriverResult<CreatedShipment>> {
    if (missingCredentials(this.env).length > 0) return notConfigured('credentials');
    if (!this.wire.createPath || Object.keys(this.wire.createFields).length === 0) {
      return notConfigured('create-shipment endpoint and field mapping');
    }
    const body: Record<string, unknown> = {};
    const source = _req as unknown as Record<string, unknown>;
    for (const [ours, theirs] of Object.entries(this.wire.createFields)) {
      // The governorate is the one value that needs translating rather than
      // copying: they use their own city ids, not ours.
      body[theirs] = ours === 'governorate'
        ? (this.wire.governorateMap[_req.governorate] ?? _req.governorate)
        : source[ours];
    }
    const res = await this.call<Record<string, unknown>>(this.wire.createPath, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) return res;
    const d = (res.value.data ?? res.value) as Record<string, unknown>;
    const remoteId = String(d.id ?? d.order_id ?? d.qr_id ?? d.invoice_id ?? '');
    if (!remoteId) {
      // No id means no way to sync this shipment later. Reporting success
      // would strand the order: the admin would think it was sent and no
      // status would ever arrive.
      return { ok: false, retryable: false, error: 'Al-Waseet accepted the shipment but returned no id to track it by.' };
    }
    return {
      ok: true,
      value: {
        remoteId,
        trackingNo: String(d.tracking_number ?? d.tracking_no ?? d.qr_id ?? ''),
        statusId: String(d.status_id ?? d.status ?? ''),
        statusText: String(d.status_text ?? d.status_name ?? ''),
      },
    };
  }

  async getShipment(remoteId: string): Promise<DriverResult<RemoteShipmentStatus>> {
    if (missingCredentials(this.env).length > 0) return notConfigured('credentials');
    if (!this.wire.shipmentPath) return notConfigured('shipment-status endpoint');
    const res = await this.call<Record<string, unknown>>(
      this.wire.shipmentPath.replace('{id}', encodeURIComponent(remoteId))
    );
    if (!res.ok) return res;
    const d = (res.value.data ?? res.value) as Record<string, unknown>;
    const statusId = String(d.status_id ?? d.status ?? d.state_id ?? '');
    if (!statusId) {
      return { ok: false, retryable: false, error: 'Al-Waseet returned a shipment with no status id.' };
    }
    return {
      ok: true,
      value: {
        remoteId,
        statusId,
        statusText: String(d.status_text ?? d.status_name ?? d.state ?? ''),
        trackingNo: String(d.tracking_number ?? d.tracking_no ?? ''),
      },
    };
  }
}

/**
 * Builds the driver, or explains precisely why it cannot be built.
 *
 * The `missing` list is names only. A route may show it to an admin so they
 * know what to set; no code path anywhere returns a credential's value.
 */
export function alwaseetDriver(env: Env, storedWire: unknown): AlwaseetDriver | DriverUnavailable {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    return {
      configured: false,
      reason: 'Al-Waseet credentials are not set on this Worker.',
      missing,
    };
  }
  return new AlwaseetDriver(env, resolveWire(storedWire));
}
