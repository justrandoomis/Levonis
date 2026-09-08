/**
 * A stand-in for a PRODUCER, for LOCAL multi-config `wrangler dev` only.
 *
 * It exists so `levonis-ads` and `levonis-notifications` can be exercised as
 * real Workers — over real service bindings, inside workerd, against real local
 * D1 databases — without running the monolith. It is never deployed: no
 * workflow references it, `tests/leastPrivilege.test.ts` only reads
 * `services/<name>/wrangler.jsonc`, and `tests/serviceBoundaries.test.ts` only
 * scans `services/<name>/src` — this directory is neither.
 *
 * It has three jobs and no state:
 *
 *   POST /deliver/<ads|notifications>   body: EventEnvelope[]  -> `deliver()`
 *   POST /send                          body: SendCommand      -> `NOTIFICATIONS.send()`
 *   ALL  /http/<ads|notifications>/...                         -> the service's own `fetch`
 *   GET  /health/<ads|notifications>                           -> `health()`
 *
 * The envelopes come from the probe, which reads the COMMITTED contract
 * fixtures off disk. Their `sig` is the literal marker `fixture`, which the
 * dark environments accept (`ACCEPT_FIXTURE_SIG=on`) — so the rig needs no key
 * material, and none exists in this repository, in a var or on a command line.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

interface Consumer {
  deliver(batch: unknown[]): Promise<unknown>;
  health(): Promise<unknown>;
  send?(cmd: unknown): Promise<unknown>;
  fetch(request: Request): Promise<Response>;
}

interface StubEnv {
  ADS?: Consumer;
  NOTIFICATIONS?: Consumer;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default class ProducerStub extends WorkerEntrypoint<StubEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    const target = (name: string | undefined): Consumer | null => {
      if (name === 'ads') return this.env.ADS ?? null;
      if (name === 'notifications') return this.env.NOTIFICATIONS ?? null;
      return null;
    };

    if (parts[0] === 'deliver') {
      const svc = target(parts[1]);
      if (!svc) return json({ error: `no binding for ${parts[1]}` }, 404);
      const batch = (await request.json().catch(() => null)) as unknown[] | null;
      if (!Array.isArray(batch)) return json({ error: 'body must be an envelope array' }, 400);
      return json(await svc.deliver(batch));
    }

    if (parts[0] === 'send') {
      const svc = this.env.NOTIFICATIONS;
      if (!svc?.send) return json({ error: 'no NOTIFICATIONS binding' }, 404);
      return json(await svc.send(await request.json()));
    }

    if (parts[0] === 'health') {
      const svc = target(parts[1]);
      if (!svc) return json({ error: `no binding for ${parts[1]}` }, 404);
      return json(await svc.health());
    }

    if (parts[0] === 'http') {
      const svc = target(parts[1]);
      if (!svc) return json({ error: `no binding for ${parts[1]}` }, 404);
      const rest = `/${parts.slice(2).join('/')}${url.search}`;
      return svc.fetch(new Request(`https://internal.invalid${rest}`, request));
    }

    return json({ ok: true, bindings: { ads: !!this.env.ADS, notifications: !!this.env.NOTIFICATIONS } });
  }
}
