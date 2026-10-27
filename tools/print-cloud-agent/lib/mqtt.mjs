/**
 * A MINIMAL MQTT 3.1.1 CLIENT — what a Bambu Lab printer in LAN mode speaks
 * (OASIS MQTT 3.1.1, sections cited below). Zero dependencies: the packets
 * are encoded and decoded here, over any Duplex the caller connects (a TLS
 * socket to the printer, a plain socket to a test broker).
 *
 * Implemented: CONNECT / CONNACK (§3.1, §3.2), PUBLISH QoS 0 and 1 both ways
 * (§3.3, PUBACK §3.4), SUBSCRIBE / SUBACK (§3.8, §3.9), PINGREQ / PINGRESP
 * (§3.12, §3.13), DISCONNECT (§3.14). Not implemented (a printer never needs
 * them from this client): QoS 2, wills, retained-message handling, UNSUBSCRIBE.
 *
 * The fixed header's «remaining length» is the variable-length integer of
 * §2.2.3: seven bits per byte, low group first, the high bit saying another
 * byte follows, at most four bytes (268,435,455).
 */
import { EventEmitter } from 'node:events';
import { silentLogger } from './log.mjs';

export const TYPES = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };
const NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k.toLowerCase()]));
export const MAX_REMAINING_LENGTH = 268_435_455;

export class MqttError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MqttError';
  }
}

/** §2.2.3: the remaining length as 1–4 bytes. */
export function encodeRemainingLength(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_REMAINING_LENGTH) throw new MqttError(`remaining length out of range: ${n}`);
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

/**
 * §2.2.3 decoded from `buf` at `offset`: `{ value, bytes }`, or null when the
 * buffer ends before the integer does. A fifth length byte is malformed.
 */
export function decodeRemainingLength(buf, offset = 0) {
  let value = 0;
  let multiplier = 1;
  for (let i = 0; i < 4; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, bytes: i + 1 };
    multiplier *= 128;
  }
  throw new MqttError('malformed remaining length (more than four bytes)');
}

/** §1.5.3: a UTF-8 string with its two-byte length. */
function str(s) {
  const b = Buffer.from(s, 'utf8');
  if (b.length > 0xffff) throw new MqttError('string longer than 65535 bytes');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | (flags & 0x0f)]), encodeRemainingLength(body.length), body]);
}

/** §3.1 CONNECT, protocol level 4. */
export function encodeConnect({ clientId, username, password, keepalive = 30, clean = true }) {
  let flags = clean ? 0x02 : 0;
  if (username !== undefined && username !== null) flags |= 0x80;
  if (password !== undefined && password !== null) flags |= 0x40;
  const parts = [str('MQTT'), Buffer.from([4, flags]), u16(keepalive), str(clientId ?? '')];
  if (flags & 0x80) parts.push(str(String(username)));
  if (flags & 0x40) parts.push(str(String(password)));
  return packet(TYPES.CONNECT, 0, Buffer.concat(parts));
}

/** §3.2 CONNACK (a broker's packet; the test broker uses it). */
export function encodeConnack({ sessionPresent = false, returnCode = 0 } = {}) {
  return packet(TYPES.CONNACK, 0, Buffer.from([sessionPresent ? 1 : 0, returnCode]));
}

/** §3.3 PUBLISH. */
export function encodePublish({ topic, payload, qos = 0, packetId, retain = false, dup = false }) {
  if (qos !== 0 && qos !== 1) throw new MqttError('only QoS 0 and 1 are supported');
  const body = [str(topic)];
  if (qos > 0) {
    if (!Number.isInteger(packetId) || packetId < 1 || packetId > 0xffff) throw new MqttError('a QoS 1 PUBLISH needs a packet id');
    body.push(u16(packetId));
  }
  body.push(Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8'));
  return packet(TYPES.PUBLISH, (dup ? 0x08 : 0) | (qos << 1) | (retain ? 1 : 0), Buffer.concat(body));
}

export const encodePuback = (packetId) => packet(TYPES.PUBACK, 0, u16(packetId));

/** §3.8 SUBSCRIBE: fixed-header flags are 0b0010. */
export function encodeSubscribe({ packetId, topics }) {
  if (!topics.length) throw new MqttError('SUBSCRIBE needs a topic');
  const body = [u16(packetId)];
  for (const t of topics) body.push(str(t.topic), Buffer.from([t.qos ?? 0]));
  return packet(TYPES.SUBSCRIBE, 0x02, Buffer.concat(body));
}

/** §3.9 SUBACK (a broker's packet). */
export function encodeSuback({ packetId, granted }) {
  return packet(TYPES.SUBACK, 0, Buffer.concat([u16(packetId), Buffer.from(granted)]));
}

export const encodePingreq = () => Buffer.from([0xc0, 0x00]);
export const encodePingresp = () => Buffer.from([0xd0, 0x00]);
export const encodeDisconnect = () => Buffer.from([0xe0, 0x00]);

function readStr(buf, p) {
  if (p + 2 > buf.length) throw new MqttError('truncated string');
  const len = buf.readUInt16BE(p);
  if (p + 2 + len > buf.length) throw new MqttError('truncated string');
  return { value: buf.toString('utf8', p + 2, p + 2 + len), next: p + 2 + len };
}

/**
 * Decode ONE packet from the start of `buf`: `{ packet, length }`, or null
 * when the buffer does not yet hold the whole packet.
 */
export function decodePacket(buf, maxBytes = 4 * 1024 * 1024) {
  if (buf.length < 2) return null;
  const type = buf[0] >> 4;
  const flags = buf[0] & 0x0f;
  const rl = decodeRemainingLength(buf, 1);
  if (!rl) return null;
  if (rl.value > maxBytes) throw new MqttError(`packet of ${rl.value} bytes exceeds the ${maxBytes}-byte limit`);
  const start = 1 + rl.bytes;
  const end = start + rl.value;
  if (buf.length < end) return null;
  const body = buf.subarray(start, end);
  const name = NAMES[type];
  let p;
  switch (type) {
    case TYPES.CONNACK:
      if (body.length !== 2) throw new MqttError('malformed CONNACK');
      p = { type: name, sessionPresent: (body[0] & 1) === 1, returnCode: body[1] };
      break;
    case TYPES.PUBLISH: {
      const qos = (flags >> 1) & 3;
      if (qos > 1) throw new MqttError('QoS 2 is not supported');
      const topic = readStr(body, 0);
      let next = topic.next;
      let packetId;
      if (qos > 0) {
        if (next + 2 > body.length) throw new MqttError('truncated PUBLISH');
        packetId = body.readUInt16BE(next);
        next += 2;
      }
      p = { type: name, topic: topic.value, qos, packetId, dup: (flags & 8) !== 0, retain: (flags & 1) !== 0, payload: Buffer.from(body.subarray(next)) };
      break;
    }
    case TYPES.PUBACK:
      if (body.length !== 2) throw new MqttError('malformed PUBACK');
      p = { type: name, packetId: body.readUInt16BE(0) };
      break;
    case TYPES.SUBACK:
      if (body.length < 3) throw new MqttError('malformed SUBACK');
      p = { type: name, packetId: body.readUInt16BE(0), granted: [...body.subarray(2)] };
      break;
    case TYPES.CONNECT: {
      const proto = readStr(body, 0);
      if (proto.value !== 'MQTT' || body[proto.next] !== 4) throw new MqttError('not an MQTT 3.1.1 CONNECT');
      const cflags = body[proto.next + 1];
      const keepalive = body.readUInt16BE(proto.next + 2);
      let q = proto.next + 4;
      const clientId = readStr(body, q);
      q = clientId.next;
      let username;
      let password;
      if (cflags & 0x04) throw new MqttError('wills are not supported');
      if (cflags & 0x80) ({ value: username, next: q } = readStr(body, q));
      if (cflags & 0x40) ({ value: password, next: q } = readStr(body, q));
      p = { type: name, clientId: clientId.value, username, password, keepalive, clean: (cflags & 0x02) !== 0 };
      break;
    }
    case TYPES.SUBSCRIBE: {
      if (flags !== 0x02) throw new MqttError('malformed SUBSCRIBE flags');
      const packetId = body.readUInt16BE(0);
      const topics = [];
      let q = 2;
      while (q < body.length) {
        const t = readStr(body, q);
        if (t.next >= body.length) throw new MqttError('SUBSCRIBE topic without QoS');
        topics.push({ topic: t.value, qos: body[t.next] });
        q = t.next + 1;
      }
      p = { type: name, packetId, topics };
      break;
    }
    case TYPES.PINGREQ:
    case TYPES.PINGRESP:
    case TYPES.DISCONNECT:
      if (body.length !== 0) throw new MqttError(`malformed ${name}`);
      p = { type: name };
      break;
    default:
      throw new MqttError(`unsupported packet type ${type}`);
  }
  return { packet: p, length: end };
}

/** Accumulates a byte stream and yields whole packets, however TCP split them. */
export class PacketReader {
  constructor(maxBytes = 4 * 1024 * 1024) {
    this.buf = Buffer.alloc(0);
    this.maxBytes = maxBytes;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      const d = decodePacket(this.buf, this.maxBytes);
      if (!d) break;
      out.push(d.packet);
      this.buf = this.buf.subarray(d.length);
    }
    return out;
  }
}

const CONNACK_REFUSALS = { 1: 'unacceptable protocol version', 2: 'identifier rejected', 3: 'server unavailable', 4: 'bad user name or password', 5: 'not authorized' };

/**
 * The client. `connect()` returns a connected Duplex (already TLS-verified
 * for a printer); everything after that — CONNECT, keep-alive, subscriptions
 * — happens here. Emits 'message' (topic, payload) and 'close' (reason).
 */
export class MqttClient extends EventEmitter {
  /**
   * @param {{ connect: () => Promise<import('node:stream').Duplex>, clientId: string, username?: string, password?: string, keepaliveSeconds?: number, connectTimeoutMs?: number, maxPacketBytes?: number, log?: any }} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    this.keepalive = opts.keepaliveSeconds ?? 30;
    this.socket = null;
    this.nextId = 1;
    /** @type {Map<number, (granted: number[]) => void>} */
    this.pendingSubs = new Map();
    this.timer = null;
    this.lastReceived = 0;
    this.closed = false;
    this.connected = false;
  }

  async open() {
    const socket = await this.opts.connect();
    this.socket = socket;
    const reader = new PacketReader(this.opts.maxPacketBytes);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.teardown(err.message);
      };
      const connectTimer = setTimeout(() => fail(new MqttError('no CONNACK within the timeout')), this.opts.connectTimeoutMs ?? 10_000);
      socket.on('data', (chunk) => {
        this.lastReceived = Date.now();
        let packets;
        try {
          packets = reader.push(chunk);
        } catch (e) {
          clearTimeout(connectTimer);
          fail(/** @type {Error} */ (e));
          return;
        }
        for (const p of packets) {
          if (p.type === 'connack') {
            clearTimeout(connectTimer);
            if (p.returnCode !== 0) {
              fail(new MqttError(`connection refused: ${CONNACK_REFUSALS[p.returnCode] ?? `code ${p.returnCode}`}`));
              return;
            }
            this.connected = true;
            this.startKeepalive();
            settled = true;
            resolve(undefined);
          } else this.handle(p);
        }
      });
      socket.on('error', (e) => {
        clearTimeout(connectTimer);
        fail(e);
      });
      socket.on('close', () => {
        clearTimeout(connectTimer);
        fail(new MqttError('connection closed'));
      });
      socket.write(encodeConnect({ clientId: this.opts.clientId, username: this.opts.username, password: this.opts.password, keepalive: this.keepalive }));
    });
  }

  handle(p) {
    if (p.type === 'publish') {
      if (p.qos === 1 && p.packetId) this.write(encodePuback(p.packetId));
      this.emit('message', p.topic, p.payload);
    } else if (p.type === 'suback') {
      const done = this.pendingSubs.get(p.packetId);
      this.pendingSubs.delete(p.packetId);
      done?.(p.granted);
    }
    // PINGRESP and PUBACK only prove the line alive (lastReceived).
  }

  packetId() {
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;
    return id;
  }

  write(buf) {
    if (!this.socket || this.socket.destroyed) throw new MqttError('not connected');
    this.socket.write(buf);
  }

  /** Subscribe; resolves with the granted QoS (0x80 = refused). */
  subscribe(topic, qos = 0) {
    const id = this.packetId();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingSubs.delete(id);
        reject(new MqttError(`no SUBACK for ${topic}`));
      }, this.opts.connectTimeoutMs ?? 10_000);
      this.pendingSubs.set(id, (granted) => {
        clearTimeout(t);
        if (granted[0] === 0x80) reject(new MqttError(`subscription to ${topic} refused`));
        else resolve(granted[0]);
      });
      this.write(encodeSubscribe({ packetId: id, topics: [{ topic, qos }] }));
    });
  }

  publish(topic, payload, qos = 0) {
    this.write(encodePublish({ topic, payload, qos, packetId: qos ? this.packetId() : undefined }));
  }

  startKeepalive() {
    if (!this.keepalive) return;
    this.lastReceived = Date.now();
    this.timer = setInterval(() => {
      if (Date.now() - this.lastReceived > this.keepalive * 1500) {
        this.teardown('keep-alive timeout');
        return;
      }
      try {
        this.write(encodePingreq());
      } catch {
        this.teardown('write failed');
      }
    }, (this.keepalive * 1000) / 2);
    this.timer.unref?.();
  }

  teardown(reason, graceful = false) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const wasOpen = !this.closed;
    this.closed = true;
    this.connected = false;
    if (this.socket && !this.socket.destroyed) {
      if (graceful) {
        // Let DISCONNECT reach the broker, but never wait on it for long.
        const s = this.socket;
        s.end(encodeDisconnect());
        setTimeout(() => s.destroy(), 1000).unref?.();
      } else this.socket.destroy();
    }
    for (const done of this.pendingSubs.values()) done([0x80]);
    this.pendingSubs.clear();
    if (wasOpen) this.emit('close', reason);
  }

  /** Say goodbye (§3.14) and close. */
  close() {
    if (this.closed) return;
    this.teardown('closed by the agent', true);
  }
}
