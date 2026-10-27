import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

export const TYPES: { CONNECT: 1; CONNACK: 2; PUBLISH: 3; PUBACK: 4; SUBSCRIBE: 8; SUBACK: 9; PINGREQ: 12; PINGRESP: 13; DISCONNECT: 14 };
export const MAX_REMAINING_LENGTH: number;
export class MqttError extends Error {}

export function encodeRemainingLength(n: number): Buffer;
export function decodeRemainingLength(buf: Buffer, offset?: number): { value: number; bytes: number } | null;
export function encodeConnect(p: { clientId: string; username?: string; password?: string; keepalive?: number; clean?: boolean }): Buffer;
export function encodeConnack(p?: { sessionPresent?: boolean; returnCode?: number }): Buffer;
export function encodePublish(p: { topic: string; payload: Buffer | string | object; qos?: 0 | 1; packetId?: number; retain?: boolean; dup?: boolean }): Buffer;
export function encodePuback(packetId: number): Buffer;
export function encodeSubscribe(p: { packetId: number; topics: Array<{ topic: string; qos?: number }> }): Buffer;
export function encodeSuback(p: { packetId: number; granted: number[] }): Buffer;
export function encodePingreq(): Buffer;
export function encodePingresp(): Buffer;
export function encodeDisconnect(): Buffer;

export type MqttPacket =
  | { type: 'connack'; sessionPresent: boolean; returnCode: number }
  | { type: 'publish'; topic: string; qos: number; packetId?: number; dup: boolean; retain: boolean; payload: Buffer }
  | { type: 'puback'; packetId: number }
  | { type: 'suback'; packetId: number; granted: number[] }
  | { type: 'connect'; clientId: string; username?: string; password?: string; keepalive: number; clean: boolean }
  | { type: 'subscribe'; packetId: number; topics: Array<{ topic: string; qos: number }> }
  | { type: 'pingreq' }
  | { type: 'pingresp' }
  | { type: 'disconnect' };

export function decodePacket(buf: Buffer, maxBytes?: number): { packet: MqttPacket; length: number } | null;

export class PacketReader {
  constructor(maxBytes?: number);
  push(chunk: Buffer): MqttPacket[];
}

export class MqttClient extends EventEmitter {
  constructor(opts: {
    connect: () => Promise<Duplex>;
    clientId: string;
    username?: string;
    password?: string;
    keepaliveSeconds?: number;
    connectTimeoutMs?: number;
    maxPacketBytes?: number;
    log?: unknown;
  });
  connected: boolean;
  open(): Promise<void>;
  subscribe(topic: string, qos?: number): Promise<number>;
  publish(topic: string, payload: Buffer | string | object, qos?: 0 | 1): void;
  close(): void;
}
