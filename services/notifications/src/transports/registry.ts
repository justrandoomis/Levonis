/**
 * The transport registry: the outbox pump asks it for the adapter that owns a
 * row's `kind`, and gets back `null` when nothing can send it.
 *
 * A transport whose secret NAMES are absent is not "off" in the sense of a
 * flag — it is not called at all. `enabled()` is the whole of the
 * "delivery disabled unless the secret names exist" rule, and the pump records
 * a `dropped` row with the transport's own `disabledReason` rather than
 * pretending to have tried.
 */
import { EmailTransport } from './email';
import { TelegramTransport } from './telegram';
import type { Transport } from '../types';

export function buildTransports(): Transport[] {
  return [new EmailTransport(), new TelegramTransport()];
}

export class TransportRegistry {
  private readonly byChannel = new Map<string, Transport>();

  constructor(transports: Transport[] = buildTransports()) {
    for (const t of transports) this.byChannel.set(t.channel, t);
  }

  channels(): string[] {
    return [...this.byChannel.keys()];
  }

  get(kind: string): Transport | null {
    return this.byChannel.get(kind) ?? null;
  }

  /** True when this kind has an adapter AND every secret name that adapter needs is present. */
  enabled(kind: string, env: Record<string, string | undefined>): boolean {
    const t = this.get(kind);
    return !!t && t.configured(env);
  }
}
