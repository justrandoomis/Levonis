/**
 * QUICK BUY — the typed client of `/api/quick-buy` (docs/GIFTS_QUICK_BUY.md §3.2).
 *
 * Every shape here is the contract the server lane codes against, and nothing
 * on this side computes a price, a fee, a stock figure or a deadline: the
 * page shows what the server answered. Every answer that carries a session is
 * published to the one store the app reads it from (src/lib/quickBuyStore.ts),
 * so the orders card, the navigation chip and the product page's toast move
 * together the moment a write lands.
 *
 * IDEMPOTENCY. Every write sends an `idempotencyKey`, and a retry of the SAME
 * user action resends the SAME key: a network that drops the answer to an add
 * must not turn the customer's second tap into a second item and a second
 * hold. `IdempotentAction` holds one key per action until the server has
 * answered it for good (a success, or a refusal it will not change its mind
 * about); a different request — another quantity, another product — is a
 * different action and gets a new key, so `IDEMPOTENCY_KEY_REUSED` is never
 * provoked by this client.
 *
 * ACCOUNT. Every call takes the signed-in account's id (`owner`) so what it
 * publishes is filed under that account (src/lib/quickBuyStore.ts).
 *
 * Lazy: the product page, the orders card and the settings section import
 * this when they first need it; nothing of Quick Buy is in the first paint.
 */
import { api, ApiError, type RequestOptions } from './api';
import {
  publishQuickBuySession,
  refreshQuickBuySession,
  rememberQuickBuyProfile,
  rememberedQuickBuyProfile,
  type QuickBuyOwner,
  type QuickBuySnapshot,
} from './quickBuyStore';

// ------------------------------------------------------------------ shapes
// As built on the server: worker/routes/quickBuy.ts, worker/lib/quickBuy/*,
// docs/GIFTS_QUICK_BUY.md §3.6.

export type QuickBuyPolicyKey = 'terms' | 'privacy' | 'quick_buy';

/** The default delivery address, as the profile carries it. */
export interface QuickBuyAddress {
  id: string;
  /** The customer's own name for it («البيت»), when they gave one. */
  label?: string;
  name: string;
  phone: string;
  governorate: string;
  area: string;
  address: string;
  landmark: string;
}

/**
 * What was accepted, by version. The server answers `consent: null` for an
 * account that never activated; `profileOf` reads that as every field null.
 */
export interface QuickBuyConsent {
  terms_version: number | null;
  privacy_version: number | null;
  policy_version: number | null;
  consented_at: string | null;
  wallet_consent_at: string | null;
}

/** The policy versions an activation must accept today. */
export interface QuickBuyRequired {
  terms: number;
  privacy: number;
  quick_buy: number;
}

export interface QuickBuyProfile {
  enabled: boolean;
  /** Enabled, consent current and the address still exists: an add may go through. */
  active: boolean;
  address: QuickBuyAddress | null;
  /** The saved address was deleted since: Quick Buy asks for a new one. */
  address_missing: boolean;
  consent: QuickBuyConsent;
  required: QuickBuyRequired;
  /** Never accepted, or a required version moved past the accepted one: consent (again) before the next add. */
  needs_consent: boolean;
}

export interface QuickBuyItemView {
  id: string;
  product_id: string;
  slug: string;
  /** The English name; Arabic and Sorani (may be '') beside it — `quickBuyItemName` picks by language. */
  name: string;
  name_ar?: string;
  name_ku?: string;
  image: string;
  /** The selection as checkout resolved it — option values and colour in one label. */
  variant?: string;
  /** The same label as `variant`. */
  option_label: string;
  /** '' as built: the colour is inside `option_label`. */
  color_label: string;
  sku: string;
  qty: number;
  unit_price_iqd: number;
  line_total_iqd: number;
  /** The «+» ceiling: what the line holds plus what the shelf has free now, at most 99. */
  max_qty: number;
}

export type QuickBuySessionState = 'open' | 'submitted' | 'cancelled' | 'failed';

/** The wallet waiver: `label` in the request's language when applied, `labels` in all three. */
export interface QuickBuyFreeDelivery {
  applied: boolean;
  label: string | Partial<Record<'ar' | 'en' | 'ckb', string>> | null;
  labels?: Partial<Record<'ar' | 'en' | 'ckb', string>>;
}

export interface QuickBuySessionView {
  id: string;
  state: QuickBuySessionState;
  started_at: string;
  expires_at: string;
  remaining_ms: number;
  server_now: string;
  /** Edits are accepted only while this is true — false once the time ran out (the server re-checks it in the batch). */
  editable?: boolean;
  items: QuickBuyItemView[];
  items_iqd: number;
  discount_iqd: number;
  shipping_iqd: number;
  shipping_before_iqd: number;
  free_delivery: QuickBuyFreeDelivery;
  total_iqd: number;
  /** What the wallet holds for it now; 0 once it is no longer open. */
  held_iqd: number;
  address: Omit<QuickBuyAddress, 'id' | 'label'>;
  delivery_method: 'standard';
  /** Set once the session became an order (submitted only). */
  order_id: string | null;
  submitted_at?: string | null;
  /** Why the automatic submission gave up (failed only). */
  finalize_error?: string | null;
  rev: number;
}

/** The last session that ended — submitted or failed, within a day — with its order when there is one. */
export type QuickBuyRecent = QuickBuySessionView & {
  order?: { id: string; status: string; total_iqd: number } | null;
};

export interface QuickBuySessionResponse {
  /** The OPEN session (its time may have run out while it is being submitted), or null. */
  session: QuickBuySessionView | null;
  /** Only while nothing is open. */
  recent: QuickBuyRecent | null;
  server_now: string;
}

/** What every line write answers (POST /items, PATCH and DELETE /items/:id). */
export interface QuickBuyChangeResponse {
  /** The open session after the change; null when none is open any more. */
  session: QuickBuySessionView | null;
  /** The session this change ended (its last line removed: cancelled), or null. */
  ended: QuickBuySessionView | null;
  added: { item_id: string; qty: number } | null;
  /** The server had already applied this key; this is its stored answer. */
  replay: boolean;
  server_now: string;
}

/** The printer standard-delivery warning, `details.policy` of its refusal (packages/shipping/src/printerDeliveryPolicy.ts). */
export interface QuickBuyPrinterPolicy {
  key: string;
  version: number;
  text_ar: string;
}

/** The customer's explicit acceptance of that warning — once per session, with an add. */
export interface QuickBuyPrinterAcceptance {
  accepted: true;
  version: number;
}

/** What the product page adds: the selection exactly as the cart would send it. */
export interface QuickBuyAddInput {
  productId: string;
  qty: number;
  optionId?: string;
  optionValueIds?: string[];
  colorId?: string;
  warrantyPlanId?: string;
  /** Sent as `printerStandardDeliveryAcceptance`, only after the customer accepted the warning. */
  printerAcceptance?: QuickBuyPrinterAcceptance;
}

/**
 * Every refusal the server sends (`ApiError.code`), as built. Stock refusals
 * are `OUT_OF_STOCK` — 400 with `details.available` from the checkout's own
 * check, or 409 with `details.product_id` when a reservation lost a race;
 * `QTY_UNAVAILABLE` is never sent and is kept only as a spelling of the same
 * refusal.
 */
export const QUICK_BUY_REFUSAL_CODES = [
  'QUICK_BUY_NOT_ACTIVE',
  'QUICK_BUY_RECONSENT_REQUIRED',
  'QUICK_BUY_DIRECT_ONLY',
  'QUICK_BUY_UNSUPPORTED_PRODUCT',
  'OUT_OF_STOCK',
  'QTY_UNAVAILABLE',
  'QUICK_BUY_INSUFFICIENT_BALANCE',
  'QUICK_BUY_EXPIRED',
  'QUICK_BUY_BUSY',
  'QUICK_BUY_PREVIOUS_PENDING',
  'QUICK_BUY_NO_SESSION',
  'QUICK_BUY_FULL',
  'QUICK_BUY_ITEM_NOT_FOUND',
  'QUICK_BUY_ADDRESS_INVALID',
  'QUICK_BUY_WALLET_CONSENT_REQUIRED',
  'PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED',
  'SHIPPING_NEEDS_CONFIG',
  'POLICY_ACCEPTANCE_REQUIRED',
  'VALIDATION',
  'IDEMPOTENCY_KEY_REUSED',
] as const;

export type QuickBuyRefusalCode = (typeof QUICK_BUY_REFUSAL_CODES)[number];

export function isQuickBuyRefusal(code: string | undefined | null): code is QuickBuyRefusalCode {
  return !!code && (QUICK_BUY_REFUSAL_CODES as readonly string[]).includes(code);
}

// ------------------------------------------------------------ idempotency

/** A fresh key: `crypto.randomUUID()`, or the same v4 shape from random bytes where it is missing. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** «A moment»: the session is being changed (`QUICK_BUY_BUSY`) or the previous one submitted (`QUICK_BUY_PREVIOUS_PENDING`). */
const isMomentary = (err: unknown) =>
  err instanceof ApiError && (err.code === 'QUICK_BUY_BUSY' || err.code === 'QUICK_BUY_PREVIOUS_PENDING');

/**
 * The answer leaves the outcome unknown or merely postponed — a network
 * failure, a timeout, a 5xx, `QUICK_BUY_BUSY` or `QUICK_BUY_PREVIOUS_PENDING`
 * — so the retry must carry the same key. Anything else is the server's
 * settled answer.
 */
export function isQuickBuyRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.code === 'ABORTED') return false;
  return err.status === 0 || err.status >= 500 || isMomentary(err);
}

/**
 * The same action goes on: retryable, or the printer warning — the request
 * wrote nothing, and once the customer accepts, the SAME request is sent
 * again with the acceptance (the server's request hash leaves the acceptance
 * out, so the key still matches it).
 */
function keepsQuickBuyKey(err: unknown): boolean {
  return isQuickBuyRetryable(err) || (err instanceof ApiError && err.code === 'PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED');
}

/** One user action's key, kept across its retries and dropped once it is settled. */
export class IdempotentAction {
  private pending: { signature: string; key: string } | null = null;

  /** The key for this request: the outstanding one if this is a retry of it, a new one otherwise. */
  key(signature: string): string {
    if (!this.pending || this.pending.signature !== signature) this.pending = { signature, key: newIdempotencyKey() };
    return this.pending.key;
  }

  /** The server has answered this action for good: the next press is a new action. */
  settle(): void {
    this.pending = null;
  }

  /** Run `send` with this action's key; keep the key only while the action is still going on. */
  async run<T>(signature: string, send: (key: string) => Promise<T>): Promise<T> {
    const key = this.key(signature);
    try {
      const out = await send(key);
      this.settle();
      return out;
    } catch (err) {
      if (!keepsQuickBuyKey(err)) this.settle();
      throw err;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `QUICK_BUY_BUSY` means another write to the same session is being applied
 * (two devices, a double tap); `QUICK_BUY_PREVIOUS_PENDING`, that the last
 * session's time ran out and it is being submitted. Either way: wait a moment
 * and send the SAME request again, twice at most, before telling the customer.
 */
export async function withBusyRetry<T>(send: () => Promise<T>, waits: readonly number[] = [350, 900]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!isMomentary(err) || attempt >= waits.length) throw err;
      await sleep(waits[attempt]);
    }
  }
}

// ---------------------------------------------------------------- reads

const PROFILE_PATH = '/api/quick-buy/profile';

type ProfileWire = Partial<Omit<QuickBuyProfile, 'consent'>> & { consent?: Partial<QuickBuyConsent> | null };

function profileOf(data: ProfileWire & { profile?: ProfileWire }, owner: QuickBuyOwner): QuickBuyProfile {
  // Every route answers `{ profile }`; a bare profile is read the same way.
  const p: ProfileWire = data.profile ?? data;
  const enabled = !!p.enabled;
  const needs = p.needs_consent !== false;
  const address = p.address ?? null;
  const profile: QuickBuyProfile = {
    enabled,
    active: typeof p.active === 'boolean' ? p.active : enabled && !needs && !!address,
    address,
    address_missing: !!p.address_missing,
    // `null` until the first activation: every field reads as not accepted.
    consent: {
      terms_version: p.consent?.terms_version ?? null,
      privacy_version: p.consent?.privacy_version ?? null,
      policy_version: p.consent?.policy_version ?? null,
      consented_at: p.consent?.consented_at ?? null,
      wallet_consent_at: p.consent?.wallet_consent_at ?? null,
    },
    required: {
      terms: Number(p.required?.terms) || 0,
      privacy: Number(p.required?.privacy) || 0,
      quick_buy: Number(p.required?.quick_buy) || 0,
    },
    needs_consent: needs,
  };
  rememberQuickBuyProfile(profile, owner);
  return profile;
}

/**
 * GET /api/quick-buy/profile. `maxAgeMs` > 0 accepts the profile this tab
 * read or wrote for the same account within that window instead of asking
 * again.
 */
export async function getQuickBuyProfile(owner: QuickBuyOwner, options: { maxAgeMs?: number } & RequestOptions = {}): Promise<QuickBuyProfile> {
  const { maxAgeMs = 0, ...opts } = options;
  if (maxAgeMs > 0) {
    const kept = rememberedQuickBuyProfile(owner, maxAgeMs);
    if (kept) return kept;
  }
  return profileOf(await api.get<{ profile?: ProfileWire }>(PROFILE_PATH, opts), owner);
}

/** Whether the profile lets an add through: on, nothing left to accept, and its address still there (`active`). */
export function quickBuyReady(p: QuickBuyProfile): boolean {
  return p.active;
}

/** GET /api/quick-buy/session, published to the store; resolves to what the store now holds. */
export function getQuickBuySession(owner: QuickBuyOwner): Promise<QuickBuySnapshot> {
  return refreshQuickBuySession(owner);
}

// ---------------------------------------------------------------- writes

/** POST /api/quick-buy/activate — the three policies at today's versions, the wallet consent, the address. */
export async function activateQuickBuy(input: { addressId: string; required: QuickBuyRequired; idempotencyKey: string; owner: QuickBuyOwner }): Promise<QuickBuyProfile> {
  const { addressId, required, idempotencyKey, owner } = input;
  const data = await api.post<{ profile: ProfileWire }>('/api/quick-buy/activate', {
    policyAcceptance: [
      { key: 'terms', version: required.terms },
      { key: 'privacy', version: required.privacy },
      { key: 'quick_buy', version: required.quick_buy },
    ],
    walletConsent: true,
    addressId,
    idempotencyKey,
  });
  return profileOf(data, owner);
}

/** PUT /api/quick-buy/profile — the switch, or the default address (a new one applies to the NEXT session). */
export async function updateQuickBuyProfile(patch: { enabled?: boolean; addressId?: string }, idempotencyKey: string, owner: QuickBuyOwner): Promise<QuickBuyProfile> {
  const data = await api.put<{ profile: ProfileWire }>(PROFILE_PATH, { ...patch, idempotencyKey });
  return profileOf(data, owner);
}

/**
 * POST /api/quick-buy/items — starts the session on the first add. A printer
 * is refused with `PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED` until the
 * customer accepts the standard-delivery warning once in the session; the
 * acceptance then rides on the same request (`printerAcceptance`).
 */
export async function addQuickBuyItem(input: QuickBuyAddInput, idempotencyKey: string, owner: QuickBuyOwner): Promise<QuickBuyChangeResponse> {
  const body: Record<string, unknown> = { productId: input.productId, qty: input.qty, idempotencyKey };
  if (input.optionId) body.optionId = input.optionId;
  if (input.optionValueIds?.length) body.optionValueIds = input.optionValueIds;
  if (input.colorId) body.colorId = input.colorId;
  if (input.warrantyPlanId) body.warrantyPlanId = input.warrantyPlanId;
  if (input.printerAcceptance) body.printerStandardDeliveryAcceptance = input.printerAcceptance;
  const data = await api.post<QuickBuyChangeResponse>('/api/quick-buy/items', body);
  publishQuickBuySession(data.session ?? null, owner, data.server_now);
  return data;
}

/** PATCH /api/quick-buy/items/:id — a new quantity; 0 removes, and removing the last line cancels the session. */
export async function updateQuickBuyItem(itemId: string, qty: number, idempotencyKey: string, owner: QuickBuyOwner): Promise<QuickBuySessionView | null> {
  const data = await api.patch<QuickBuyChangeResponse>(`/api/quick-buy/items/${encodeURIComponent(itemId)}`, { qty, idempotencyKey });
  publishQuickBuySession(data.session ?? null, owner, data.server_now);
  return data.session ?? null;
}

/**
 * Removes a line: `PATCH {qty: 0}`, which the server applies as the same
 * removal as DELETE /items/:id. (A DELETE would carry its key in an
 * `Idempotency-Key` header; `api` is in the first paint and is not widened
 * for one caller.)
 */
export function removeQuickBuyItem(itemId: string, idempotencyKey: string, owner: QuickBuyOwner): Promise<QuickBuySessionView | null> {
  return updateQuickBuyItem(itemId, 0, idempotencyKey, owner);
}

/** POST /api/quick-buy/session/cancel — releases every hold and reservation. */
export async function cancelQuickBuySession(idempotencyKey: string, owner: QuickBuyOwner): Promise<void> {
  const data = await api.post<{ session: null; server_now?: string }>('/api/quick-buy/session/cancel', { idempotencyKey });
  publishQuickBuySession(null, owner, data?.server_now);
}

/** A refusal's numbers, read defensively: the server sends them as numbers, a proxy may stringify them. */
export function refusalNumber(err: unknown, key: string): number | null {
  if (!(err instanceof ApiError)) return null;
  const raw = err.details?.[key] ?? err.body?.[key];
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The printer warning a `PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED` refusal carries (`details.policy`), or null. */
export function printerPolicyOf(err: unknown): QuickBuyPrinterPolicy | null {
  if (!(err instanceof ApiError) || err.code !== 'PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED') return null;
  const raw = (err.details?.policy ?? err.body?.policy) as Partial<QuickBuyPrinterPolicy> | undefined;
  const version = Number(raw?.version);
  if (!raw || !Number.isInteger(version) || version < 1) return null;
  return { key: String(raw.key ?? ''), version, text_ar: String(raw.text_ar ?? '') };
}
