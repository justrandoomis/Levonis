/**
 * PAYMENT ADAPTERS (docs/PRINT_CLOUD.md §4.4).
 *
 *   manual          the workshop records a cash / bank-transfer receipt; a
 *                   full admin confirms it (money scope, audited). Always on.
 *   gateway         a signed webhook from a card/wallet processor:
 *                   `X-PrintCloud-Signature: t=<unix seconds>,v1=<hex>` where
 *                   v1 = HMAC-SHA256(secret, `${t}.${rawBody}`), five-minute
 *                   window. On only when PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET is
 *                   set. No processor is contracted yet: this is the contract
 *                   a processor integration must meet, and it is tested.
 *   dev             DEVELOPMENT ONLY. The customer «pays» their own order from
 *                   the API console. On only when PRINT_CLOUD_DEV_PAYMENTS is
 *                   exactly 'on' — never set in a deployed environment — and
 *                   every confirmation it produces is labelled provider 'dev'.
 *   levonis_wallet  NOT CONNECTED (adapters.ts): answers ADAPTER_NOT_CONNECTED.
 *
 * Whatever the adapter, a confirmation goes through ONE function,
 * `confirmPayment` (orders.ts): an event is recorded once per
 * (provider, event id), and an order is fulfilled once whatever arrives.
 */
import { timingSafeEqual } from '../crypto';
import type { Env } from '../types';
import { pcError } from './errors';

export type PaymentProvider = 'dev' | 'manual' | 'gateway' | 'levonis_wallet';
export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = ['dev', 'manual', 'gateway', 'levonis_wallet'];

export interface PcPaymentEnv {
  PRINT_CLOUD_DEV_PAYMENTS?: string;
  PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET?: string;
}

export function paymentAvailable(env: Partial<Env> & PcPaymentEnv, provider: PaymentProvider): boolean {
  switch (provider) {
    case 'manual':
      return true;
    case 'dev':
      return env.PRINT_CLOUD_DEV_PAYMENTS === 'on';
    case 'gateway':
      return typeof env.PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET === 'string' && env.PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET.length >= 32;
    case 'levonis_wallet':
      return false;
  }
}

export function assertPaymentAvailable(env: Partial<Env> & PcPaymentEnv, provider: PaymentProvider): void {
  if (provider === 'levonis_wallet') throw pcError('ADAPTER_NOT_CONNECTED', { adapter: 'wallet_payment' });
  if (!paymentAvailable(env, provider)) throw pcError('PAYMENT_ADAPTER_DISABLED', { provider });
}

/** What the customer is told to do next, per adapter. No secret, no internal id beyond the order's. */
export function paymentInstructions(provider: PaymentProvider, order: { id: string; total_iqd: number }) {
  switch (provider) {
    case 'manual':
      return {
        provider,
        action: 'pay_at_workshop',
        reference: order.id,
        amount_iqd: order.total_iqd,
        messages: {
          ar: `ادفع ${order.total_iqd} د.ع في الورشة أو بالتحويل مع ذكر رقم الطلب ${order.id}.`,
          en: `Pay ${order.total_iqd} IQD at the workshop or by transfer quoting order ${order.id}.`,
          ckb: `${order.total_iqd} دینار لە کارگە یان بە گواستنەوە بدە و ژمارەی داواکاری ${order.id} بنووسە.`,
        },
      };
    case 'gateway':
      return { provider, action: 'redirect_to_processor', reference: order.id, amount_iqd: order.total_iqd };
    case 'dev':
      return { provider, action: 'dev_confirm', reference: order.id, amount_iqd: order.total_iqd, development_only: true };
    case 'levonis_wallet':
      return { provider, action: 'not_connected', reference: order.id, amount_iqd: order.total_iqd };
  }
}

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build a signature header (used by tests and by a processor integration's own test harness). */
export async function signGatewayPayload(secret: string, rawBody: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacHex(secret, `${unixSeconds}.${rawBody}`)}`;
}

export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** True only for a fresh, correctly signed body. Constant-time comparison; never logs the secret. */
export async function verifyGatewaySignature(secret: string, rawBody: string, header: string | null | undefined, now: Date): Promise<boolean> {
  if (!header || secret.length < 32) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return i > 0 ? [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] : ['', ''];
    })
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isSafeInteger(t) || typeof v1 !== 'string' || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return timingSafeEqual(enc.encode(expected), enc.encode(v1));
}
