/**
 * A stand-in for a PRODUCER (and for Identity's key registry), for LOCAL
 * multi-config `wrangler dev` only. Never deployed: no workflow references
 * `dev/`, and the governance tests read `services/<name>/wrangler.jsonc` and
 * `services/<name>/src`, which this is neither.
 *
 * It carries the dark core's NAME so the analytics service's own `IDENTITY`
 * binding resolves to it, binds `ANALYTICS` the way the bus will, and — because
 * the read models are the point of this service — also mints a signed ADMIN
 * PRINCIPAL so the rig can drive the HTTP surface end to end through the
 * service's real authorisation path.
 *
 * Every key is generated in memory on first use. One key per service, because a
 * `KeyRing` is keyed by `kid` and a producer's key IS its identity: publishing
 * one key under two service names makes envelopes from the second name fail
 * with `PRODUCER_KEY_MISMATCH` (which is how the audit rig found this).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { generateKeyPair, importSigningKey, type SigningKey } from '@levonis/platform-kit/keys';
import { signEnvelope } from '@levonis/platform-kit/eventSig';
import { buildPrincipal, signPrincipal } from '@levonis/platform-kit/principal';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
import { OrderDeliveredV1 } from '@levonis/contracts/events/v1/OrderDelivered';
import { UserCreatedV1 } from '@levonis/contracts/events/v1/UserCreated';
import { RoleChangedV1 } from '@levonis/contracts/events/v1/RoleChanged';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { DeliverResult, HealthReport } from '@levonis/contracts/rpc/common';
import type { DailyMerchantPoint, DailyPlatformPoint } from '@levonis/contracts/http/analytics';

interface AnalyticsBinding {
  fetch(request: Request): Promise<Response>;
  deliver(batch: EventEnvelope[]): Promise<DeliverResult>;
  overview(range?: { from?: string; to?: string }): Promise<Record<string, unknown>>;
  daily(opts?: { metric?: string }): Promise<DailyPlatformPoint[]>;
  merchantDaily(merchantId: string, opts?: { metric?: string }): Promise<DailyMerchantPoint[]>;
  health(): Promise<HealthReport>;
}

interface StubEnv {
  ANALYTICS: AnalyticsBinding;
}

const signing = new Map<string, SigningKey>();
async function devKey(service: string): Promise<SigningKey> {
  const known = signing.get(service);
  if (known) return known;
  const pair = await generateKeyPair();
  const key = await importSigningKey(pair.privateKeyB64, pair.publicKeyB64);
  signing.set(service, key);
  return key;
}

const PRODUCER_SERVICES = ['core', 'identity', 'commerce'];

/** The key registry Analytics reads — for producers AND for the principal issuer. */
export class IdentityEntrypoint extends WorkerEntrypoint {
  async getPublicKeys() {
    const keys = await Promise.all(
      PRODUCER_SERVICES.map(async (service) => {
        const key = await devKey(service);
        return { kid: key.kid, alg: 'EdDSA' as const, public_key: key.publicKeyB64, service, not_after: null };
      })
    );
    return { keys };
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });

const base = {
  correlation_id: 'cid_rig',
  causation_id: null,
};

async function orderCreated(merchantId: string | null, totalIqd: number, at: string): Promise<EventEnvelope> {
  const orderId = `ord_${uuidv7().slice(0, 8)}`;
  const unsigned = OrderCreatedV1.envelope({
    ...base,
    event_id: uuidv7(),
    created_at: at,
    source_service: 'core',
    actor_id: 'usr_dev',
    aggregate_id: orderId,
    aggregate_seq: 1,
    payload: {
      order_id: orderId,
      user_id: 'usr_dev',
      user_hash: 'a'.repeat(64),
      seller_type: merchantId ? 'merchant' : 'platform',
      merchant_id: merchantId,
      store_id: merchantId ? `str_${merchantId}` : null,
      payment_state: 'cod',
      items: [{ order_item_id: 'oi_1', product_id: 'prd_1', qty: 1, unit_price_iqd: totalIqd, is_printer: false, warranty_plan_id: null, ops_policy_id: null }],
      totals: { merchandise_iqd: totalIqd, delivery_iqd: 0, discount_iqd: 0, total_iqd: totalIqd },
      payment: { method: 'cash', wallet_usd_cents: 0, points: 0, cod_iqd: totalIqd, exchange_rate: 1450 },
      shipping_type: 'standard',
      address_snapshot_ref: 'adr_1',
      coupon_code: null,
      membership_gift: false,
      referral_delivery_waived: false,
      idempotency_key: `idem_${orderId}`,
      created_at: at,
    },
  });
  return signEnvelope(await devKey('core'), unsigned);
}

async function orderDelivered(merchantId: string | null, at: string): Promise<EventEnvelope> {
  const orderId = `ord_${uuidv7().slice(0, 8)}`;
  const unsigned = OrderDeliveredV1.envelope({
    ...base,
    event_id: uuidv7(),
    created_at: at,
    source_service: 'commerce',
    actor_id: 'usr_admin',
    aggregate_id: orderId,
    aggregate_seq: 2,
    payload: {
      order_id: orderId,
      user_id: 'usr_dev',
      seller_type: merchantId ? 'merchant' : 'platform',
      merchant_id: merchantId,
      delivered_at: at,
      items: [{ order_item_id: 'oi_1', product_id: 'prd_1', qty: 1, unit_price_iqd: 1000, is_printer: false, warranty_plan_id: null, ops_policy_id: null }],
      payment_method: 'cash',
      cod_amount_iqd: 1000,
      by: 'admin',
    },
  });
  return signEnvelope(await devKey('commerce'), unsigned);
}

async function userCreated(at: string): Promise<EventEnvelope> {
  const userId = `usr_${uuidv7().slice(0, 8)}`;
  const unsigned = UserCreatedV1.envelope({
    ...base,
    event_id: uuidv7(),
    created_at: at,
    source_service: 'identity',
    actor_id: userId,
    aggregate_id: userId,
    aggregate_seq: 1,
    payload: { user_id: userId, method: 'password', locale: 'ar', referrer_code: null, email_verified: false, created_at: at },
  });
  return signEnvelope(await devKey('identity'), unsigned);
}

/** A `personal` envelope: Analytics must refuse it whatever the transport says. */
async function roleChanged(at: string): Promise<EventEnvelope> {
  const unsigned = RoleChangedV1.envelope({
    ...base,
    event_id: uuidv7(),
    created_at: at,
    source_service: 'identity',
    actor_id: 'usr_admin',
    aggregate_id: 'usr_dev',
    aggregate_seq: 3,
    payload: { user_id: 'usr_dev', role: 'admin', admin_scope: 'full', is_investor: false, actor_id: 'usr_admin' },
  });
  return signEnvelope(await devKey('identity'), unsigned);
}

/** A signed principal, so the rig can drive the HTTP surface through the real check. */
async function principalHeader(opts: { sub: string; role: 'admin' | 'merchant'; scope: 'full' | null; host: 'main' | 'merchant' }): Promise<string> {
  const key = await devKey('identity');
  return signPrincipal(
    key,
    buildPrincipal(
      {
        sub: opts.sub,
        sid_hash: 'sid_rig',
        role: opts.role,
        scope: opts.scope,
        investor: false,
        tier: null,
        locale: 'en',
        host_kind: opts.host,
        cid: 'cid_rig',
      },
      Math.floor(Date.now() / 1000)
    )
  );
}

export default class ProducerStub extends WorkerEntrypoint<StubEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const at = url.searchParams.get('at') ?? new Date().toISOString();
    try {
      switch (url.pathname) {
        case '/emit/seed': {
          // one platform order, one merchant order, one delivery, one signup
          const merchantId = url.searchParams.get('merchant') ?? 'mch_rig';
          const envelopes = [await orderCreated(null, 1000, at), await orderCreated(merchantId, 2500, at), await orderDelivered(merchantId, at), await userCreated(at)];
          return json({ count: envelopes.length, result: await this.env.ANALYTICS.deliver(envelopes) });
        }
        case '/emit/twice': {
          const envelope = await orderCreated(null, 7000, at);
          const first = await this.env.ANALYTICS.deliver([envelope]);
          const second = await this.env.ANALYTICS.deliver([envelope]);
          return json({ first, second });
        }
        case '/emit/personal':
          return json({ result: await this.env.ANALYTICS.deliver([await roleChanged(at)]) });
        case '/overview':
          return json(await this.env.ANALYTICS.overview({}));
        case '/daily':
          return json(await this.env.ANALYTICS.daily({ metric: url.searchParams.get('metric') ?? undefined }));
        case '/merchant':
          return json(await this.env.ANALYTICS.merchantDaily(url.searchParams.get('merchant') ?? 'mch_rig', {}));
        case '/health':
          return json(await this.env.ANALYTICS.health());
        case '/http': {
          // the same read model over HTTP, through the service's own principal check
          const path = url.searchParams.get('path') ?? '/api/v1/analytics/admin/overview';
          const who = url.searchParams.get('as') ?? 'admin';
          const header =
            who === 'none'
              ? null
              : await principalHeader(
                  who === 'admin'
                    ? { sub: 'usr_admin', role: 'admin', scope: 'full', host: 'main' }
                    : { sub: who, role: 'merchant', scope: null, host: 'merchant' }
                );
          const res = await this.env.ANALYTICS.fetch(
            new Request(`https://analytics.internal${path}`, { headers: header ? { [PRINCIPAL_HEADER]: header } : {} })
          );
          return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
        }
        default:
          return json({ error: 'unknown rig path', paths: ['/emit/seed', '/emit/twice', '/emit/personal', '/overview', '/daily', '/merchant', '/health', '/http'] }, 404);
      }
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
}
