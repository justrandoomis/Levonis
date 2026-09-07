/**
 * Realtime behind an adapter (`01-TARGET.md` §7, ADR-008): producers always
 * call `hub.publish(channel, msg)`; `NoopHub` today, `DoHub` when Durable
 * Objects are approved, `MemoryHub` for tests.
 */
export interface RealtimeMessage {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface RealtimeHub {
  publish(channel: string, msg: RealtimeMessage): Promise<void>;
}

export class NoopHub implements RealtimeHub {
  async publish(): Promise<void> {
    /* polling stays; nothing to push */
  }
}

export class MemoryHub implements RealtimeHub {
  readonly published: Array<{ channel: string; msg: RealtimeMessage }> = [];
  async publish(channel: string, msg: RealtimeMessage): Promise<void> {
    this.published.push({ channel, msg });
  }
}

/** The DO namespace shape `DoHub` needs; the object per channel fans out to its sockets. */
export interface HubNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export class DoHub implements RealtimeHub {
  constructor(private readonly ns: HubNamespaceLike) {}
  async publish(channel: string, msg: RealtimeMessage): Promise<void> {
    const stub = this.ns.get(this.ns.idFromName(channel));
    await stub.fetch('https://do/publish', { method: 'POST', body: JSON.stringify(msg) });
  }
}

/** Picks the adapter by binding presence — a config switch, not a rewrite. */
export function selectHub(ns: HubNamespaceLike | undefined): RealtimeHub {
  return ns ? new DoHub(ns) : new NoopHub();
}
