/**
 * TRUSTING A PRINTER'S SELF-SIGNED CERTIFICATE — explicitly, never silently
 * (docs/PRINT_CLOUD_AGENT.md §Bambu, «TLS trust»).
 *
 * A Bambu Lab printer in LAN mode serves MQTT (8883) and FTPS (990) with a
 * certificate no public CA signed, so default verification always fails. The
 * way out must be a CHOICE the operator wrote down, one of:
 *
 *   pin       the SHA-256 fingerprint of THIS printer's certificate
 *             (`--print-fingerprint host:8883` prints it). The handshake runs
 *             without CA verification, then the presented certificate must
 *             match the pin BEFORE a single byte — the access code included —
 *             is written. A different certificate is refused.
 *   ca        a CA file the operator trusts (e.g. the printer vendor's CA)
 *             plus the name the certificate must carry (the printer's serial
 *             is its common name): full chain verification.
 *   insecure  no verification at all. Allowed only when written explicitly,
 *             and every connection logs a warning saying so.
 *
 * There is no default: a Bambu printer without a `tls.mode` is a
 * configuration error (config.mjs).
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { silentLogger } from './log.mjs';

export class TrustError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrustError';
  }
}

/** «aa:bb:…» or «AABB…» → «AA:BB:…» (64 hex digits); null when it is not a SHA-256 fingerprint. */
export function normalizeFingerprint(fp) {
  if (typeof fp !== 'string') return null;
  const hex = fp.replace(/[:\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g).join(':');
}

/**
 * Open a TCP connection (or wrap `socket`) in TLS under the configured trust.
 * Resolves only once the peer passed it.
 *
 * @param {{ host: string, port?: number, socket?: import('node:net').Socket, trust: { mode: 'pin' | 'ca' | 'insecure', fingerprint256?: string, ca_file?: string, ca_pem?: string, servername?: string }, session?: Buffer, timeoutMs?: number, log?: any }} p
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
export function connectTls(p) {
  const log = p.log ?? silentLogger;
  const trust = p.trust;
  /** @type {import('node:tls').ConnectionOptions} */
  const options = { host: p.host, port: p.port, socket: p.socket, session: p.session };
  let pin = null;
  if (trust.mode === 'pin') {
    pin = normalizeFingerprint(trust.fingerprint256);
    if (!pin) throw new TrustError('tls.mode "pin" needs fingerprint256: the SHA-256 fingerprint of the printer certificate');
    options.rejectUnauthorized = false;
  } else if (trust.mode === 'ca') {
    const ca = trust.ca_pem ?? (trust.ca_file ? readFileSync(trust.ca_file, 'utf8') : null);
    if (!ca) throw new TrustError('tls.mode "ca" needs ca_file');
    const expected = trust.servername ?? null;
    options.ca = [ca];
    options.rejectUnauthorized = true;
    if (expected) {
      options.servername = net.isIP(expected) ? undefined : expected;
      // The printer's certificate names its serial, not its LAN address.
      options.checkServerIdentity = (_host, cert) =>
        cert?.subject?.CN === expected || String(cert?.subjectaltname ?? '').split(/,\s*/).includes(`DNS:${expected}`)
          ? undefined
          : new TrustError(`certificate names ${cert?.subject?.CN ?? 'nothing'}, expected ${expected}`);
    }
  } else if (trust.mode === 'insecure') {
    options.rejectUnauthorized = false;
    log.warn('tls.insecure', { host: p.host, port: p.port, note: 'certificate NOT verified (tls.mode "insecure" in the configuration)' });
  } else {
    throw new TrustError(`unknown tls.mode ${String(trust?.mode)}: choose "pin", "ca" or "insecure"`);
  }
  return new Promise((resolve, reject) => {
    const s = tls.connect(options);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new TrustError(`TLS handshake with ${p.host} timed out`));
    }, p.timeoutMs ?? 10_000);
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.once('secureConnect', () => {
      clearTimeout(timer);
      if (pin) {
        const cert = s.getPeerCertificate();
        const presented = normalizeFingerprint(cert?.fingerprint256);
        // A resumed session (an FTPS data channel) re-presents no certificate: it continues one already pinned.
        if (!presented && s.isSessionReused()) return resolve(s);
        if (presented !== pin) {
          s.destroy();
          reject(new TrustError(`certificate fingerprint ${presented ?? 'none'} does not match the pinned ${pin} for ${p.host}`));
          return;
        }
      }
      resolve(s);
    });
  });
}

/** The SHA-256 fingerprint a host presents — for the operator to pin (`--print-fingerprint`). Sends nothing. */
export function peerFingerprint(host, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, rejectUnauthorized: false });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new TrustError(`no TLS handshake with ${host}:${port}`));
    }, timeoutMs);
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = s.getPeerCertificate();
      s.destroy();
      resolve({ fingerprint256: normalizeFingerprint(cert?.fingerprint256), subject: cert?.subject?.CN ?? null, issuer: cert?.issuer?.CN ?? null, valid_to: cert?.valid_to ?? null });
    });
  });
}
