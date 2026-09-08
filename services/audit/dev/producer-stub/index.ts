/**
 * A stand-in for a PRODUCER (and for Identity's key registry), for LOCAL
 * multi-config `wrangler dev` only. Never deployed: no workflow references
 * `dev/`, and the governance tests read `services/<name>/wrangler.jsonc` and
 * `services/<name>/src`, which this is neither.
 *
 * It exists so `levonis-audit` can be exercised as a real Worker — inside
 * workerd, over a real service binding, against a real local D1 — rather than
 * only against the in-process stubs of `test/`. It carries the dark core's
 * NAME so the audit service's own `IDENTITY` binding resolves to it, and it
 * binds `AUDIT` the way the bus will.
 *
 * The signing key is GENERATED IN MEMORY on first use and published through
 * `IdentityEntrypoint.getPublicKeys()`, so the rig drives the whole
 * sign → verify → record chain with no key material in the repository, in a
 * var or on a command line.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { generateKeyPair, importSigningKey, type SigningKey } from '@levonis/platform-kit/keys';
import { signEnvelope } from '@levonis/platform-kit/eventSig';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import { AuditRecordedV1 } from '@levonis/contracts/events/v1/AuditRecorded';
import { RoleChangedV1 } from '@levonis/contracts/events/v1/RoleChanged';
import { sha256Hex } from '@levonis/contracts/canonical';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { DeliverResult, HealthReport } from '@levonis/contracts/rpc/common';
import type { AuditRecordResult, AuditRow } from '@levonis/contracts/rpc/audit';

interface AuditBinding {
  deliver(batch: EventEnvelope[]): Promise<DeliverResult>;
  record(entry: Record<string, unknown>): Promise<AuditRecordResult>;
  query(q: Record<string, unknown>): Promise<{ rows: AuditRow[]; next: string | null }>;
  verifyChain(): Promise<{ ok: boolean; checked: number; head: string; anchored_head: string | null }>;
  health(): Promise<HealthReport>;
}

interface StubEnv {
  AUDIT: AuditBinding;
}

/**
 * ONE KEY PER SERVICE. A `KeyRing` is keyed by `kid` and carries the service
 * that owns it, and `verifyEnvelope` refuses an envelope whose `source_service`
 * is not that service (`PRODUCER_KEY_MISMATCH`). Publishing one key under two
 * names therefore verifies for one of them and refuses the other — which is
 * exactly what production wants (a service's key is its identity) and exactly
 * what the first run of this rig caught.
 */
const signing = new Map<string, SigningKey>();
async function devKey(service: string): Promise<SigningKey> {
  const known = signing.get(service);
  if (known) return known;
  const pair = await generateKeyPair();
  const key = await importSigningKey(pair.privateKeyB64, pair.publicKeyB64);
  signing.set(service, key);
  return key;
}

/** The key registry Audit reads to verify producers (`IDENTITY.getPublicKeys`). */
export class IdentityEntrypoint extends WorkerEntrypoint {
  async getPublicKeys() {
    // Both producers the rig emits as, each with its own key.
    const keys = await Promise.all(
      ['core', 'identity'].map(async (service) => {
        const key = await devKey(service);
        return { kid: key.kid, alg: 'EdDSA' as const, public_key: key.publicKeyB64, service, not_after: null };
      })
    );
    return { keys };
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });

/** An `AuditRecorded` envelope, exactly as the core's `audit()` facade builds one. */
async function auditRecordedEnvelope(action: string, target: string, actorId: string | null): Promise<EventEnvelope> {
  const eventId = uuidv7();
  const detailHash = await sha256Hex(JSON.stringify({ action, target }));
  const unsigned = AuditRecordedV1.envelope({
    event_id: eventId,
    created_at: new Date().toISOString(),
    source_service: 'core',
    correlation_id: `cid_${eventId.slice(0, 8)}`,
    causation_id: null,
    actor_id: actorId,
    aggregate_id: eventId,
    aggregate_seq: 1,
    payload: { actor_id: actorId, action, target, detail_hash: detailHash, detail_ref: eventId, source_service: 'core' },
  });
  return signEnvelope(await devKey('core'), unsigned);
}

/** A `RoleChanged` envelope — a privilege change, the other thing an audit log is for. */
async function roleChangedEnvelope(userId: string, actorId: string): Promise<EventEnvelope> {
  const eventId = uuidv7();
  const unsigned = RoleChangedV1.envelope({
    event_id: eventId,
    created_at: new Date().toISOString(),
    source_service: 'identity',
    correlation_id: `cid_${eventId.slice(0, 8)}`,
    causation_id: null,
    actor_id: actorId,
    aggregate_id: userId,
    aggregate_seq: Date.now(),
    payload: { user_id: userId, role: 'admin', admin_scope: 'full', is_investor: false, actor_id: actorId },
  });
  return signEnvelope(await devKey('identity'), unsigned);
}

export default class ProducerStub extends WorkerEntrypoint<StubEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/emit/audit-recorded': {
          const envelope = await auditRecordedEnvelope(
            url.searchParams.get('action') ?? 'wallet.credit',
            url.searchParams.get('target') ?? 'wallet:usr_dev',
            url.searchParams.get('actor') ?? 'usr_admin'
          );
          return json({ event_id: envelope.event_id, result: await this.env.AUDIT.deliver([envelope]) });
        }
        case '/emit/role-changed': {
          const envelope = await roleChangedEnvelope(url.searchParams.get('user') ?? 'usr_dev', url.searchParams.get('actor') ?? 'usr_admin');
          return json({ event_id: envelope.event_id, result: await this.env.AUDIT.deliver([envelope]) });
        }
        case '/emit/twice': {
          // the same envelope delivered twice: the second must be `replayed`
          const envelope = await auditRecordedEnvelope('wallet.debit', 'wallet:usr_dev', 'usr_admin');
          const first = await this.env.AUDIT.deliver([envelope]);
          const second = await this.env.AUDIT.deliver([envelope]);
          return json({ event_id: envelope.event_id, first, second });
        }
        case '/emit/forged': {
          // a valid envelope whose signature has been broken: must be refused
          const envelope = await auditRecordedEnvelope('wallet.credit', 'wallet:usr_dev', 'usr_admin');
          const tampered = { ...envelope, payload: { ...(envelope.payload as object), action: 'wallet.steal' } } as EventEnvelope;
          return json({ result: await this.env.AUDIT.deliver([tampered]) });
        }
        case '/record':
          return json(
            await this.env.AUDIT.record({
              event_id: uuidv7(),
              actor_id: url.searchParams.get('actor') ?? 'usr_admin',
              action: url.searchParams.get('action') ?? 'admin.settings_changed',
              target: url.searchParams.get('target') ?? 'settings:exchangeRate',
              detail: { from: 1400, to: 1450 },
              source_service: 'core',
              correlation_id: 'cid_rig',
            })
          );
        case '/query':
          return json(await this.env.AUDIT.query({ limit: Number(url.searchParams.get('limit') ?? 10) }));
        case '/verify':
          return json(await this.env.AUDIT.verifyChain());
        case '/health':
          return json(await this.env.AUDIT.health());
        default:
          return json({ error: 'unknown rig path', paths: ['/emit/audit-recorded', '/emit/role-changed', '/emit/twice', '/emit/forged', '/record', '/query', '/verify', '/health'] }, 404);
      }
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
}
