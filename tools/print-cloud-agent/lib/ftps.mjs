/**
 * A MINIMAL IMPLICIT-FTPS CLIENT — how a print file reaches a Bambu Lab
 * printer's storage in LAN mode (port 990, user `bblp`, the LAN access code).
 * Zero dependencies; one upload per connection (RFC 959, RFC 4217):
 *
 *   TLS from the first byte (implicit FTPS)       ← 220 greeting
 *   USER bblp                                     ← 331
 *   PASS <access code>                            ← 230
 *   PBSZ 0                                        ← 200
 *   PROT P   (the data channel is TLS too)        ← 200
 *   TYPE I   (binary)                             ← 200
 *   PASV                                          ← 227 (h1,h2,h3,h4,p1,p2)
 *   connect the data port, STOR <name>            ← 150 / 125
 *   TLS on the data socket (resuming the control
 *   session — many FTPS servers insist), the bytes, close
 *                                                 ← 226
 *   QUIT                                          ← 221
 *
 * The passive answer's port is used with the CONTROL host: printers have
 * been seen to announce an unroutable address. `connect` and `secure` are
 * injectable so the sequence can be tested over plain sockets.
 */
import net from 'node:net';
import { silentLogger } from './log.mjs';

export class FtpError extends Error {
  /**
   * @param {string} message
   * @param {number | null} [code]
   */
  constructor(message, code = null) {
    super(message);
    this.name = 'FtpError';
    this.code = code;
  }
}

/** Reads FTP replies (RFC 959 §4.2: «xyz-» opens a multi-line reply that «xyz » closes). */
class ReplyReader {
  constructor(socket, timeoutMs) {
    this.buf = '';
    this.lines = [];
    this.waiters = [];
    this.error = null;
    this.timeoutMs = timeoutMs;
    socket.setEncoding?.('utf8');
    socket.on('data', (d) => {
      this.buf += typeof d === 'string' ? d : d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.lines.push(this.buf.slice(0, i).replace(/\r$/, ''));
        this.buf = this.buf.slice(i + 1);
      }
      this.flush();
    });
    const fail = (e) => {
      this.error = e;
      this.flush();
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new FtpError('control connection closed')));
  }

  takeReply() {
    if (!this.lines.length) return null;
    const first = /^(\d{3})([ -])(.*)$/.exec(this.lines[0]);
    if (!first) throw new FtpError(`malformed reply: ${this.lines[0].slice(0, 120)}`);
    if (first[2] === ' ') {
      this.lines.shift();
      return { code: Number(first[1]), text: first[3] };
    }
    const end = this.lines.findIndex((l, idx) => idx > 0 && l.startsWith(`${first[1]} `));
    if (end < 0) return null;
    const text = this.lines.slice(0, end + 1).map((l) => l.replace(/^\d{3}[ -]?/, '')).join('\n');
    this.lines.splice(0, end + 1);
    return { code: Number(first[1]), text };
  }

  flush() {
    while (this.waiters.length) {
      let reply;
      try {
        reply = this.takeReply();
      } catch (e) {
        this.waiters.shift().reject(e);
        continue;
      }
      if (reply) this.waiters.shift().resolve(reply);
      else if (this.error) this.waiters.shift().reject(this.error);
      else break;
    }
  }

  /** @returns {Promise<{ code: number, text: string }>} */
  next() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new FtpError('no reply from the FTP server within the timeout')), this.timeoutMs);
      this.waiters.push({
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.flush();
    });
  }
}

/** «227 Entering Passive Mode (192,168,1,5,195,80).» → port 50000 (and the announced host). */
export function parsePasv(text) {
  const m = /(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/.exec(text);
  if (!m) throw new FtpError(`unreadable PASV reply: ${text.slice(0, 120)}`);
  const n = m.slice(1).map(Number);
  if (n.some((x) => x > 255)) throw new FtpError(`invalid PASV reply: ${text.slice(0, 120)}`);
  return { host: n.slice(0, 4).join('.'), port: n[4] * 256 + n[5] };
}

const tcp = ({ host, port, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new FtpError(`cannot reach ${host}:${port}`));
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

/**
 * Store `data` as `remoteName` on the server.
 *
 * @param {{
 *   host: string, port?: number, user: string, password: string, remoteName: string, data: Buffer,
 *   connect?: (p: { host: string, port: number, purpose: 'control' | 'data', timeoutMs: number }) => Promise<import('node:net').Socket>,
 *   secure: (socket: import('node:net').Socket, p: { purpose: 'control' | 'data', session?: Buffer }) => Promise<import('node:net').Socket>,
 *   timeoutMs?: number, log?: any
 * }} p
 * @returns {Promise<{ bytes: number, transcript: string[] }>}
 */
export async function ftpsStore(p) {
  const log = p.log ?? silentLogger;
  const timeoutMs = p.timeoutMs ?? 60_000;
  const connect = p.connect ?? tcp;
  if (!/^[A-Za-z0-9_.\-/]{1,200}$/.test(p.remoteName) || p.remoteName.includes('..')) throw new FtpError(`unsafe remote name: ${p.remoteName}`);
  const transcript = [];
  const raw = await connect({ host: p.host, port: p.port ?? 990, purpose: 'control', timeoutMs });
  let control;
  try {
    control = await p.secure(raw, { purpose: 'control' });
  } catch (e) {
    raw.destroy();
    throw e;
  }
  const replies = new ReplyReader(control, timeoutMs);
  const expect = async (codes, what) => {
    const r = await replies.next();
    transcript.push(`<- ${r.code}`);
    if (!codes.includes(r.code)) throw new FtpError(`${what}: unexpected reply ${r.code} ${r.text.slice(0, 160)}`, r.code);
    return r;
  };
  const send = async (cmd, codes, shown = cmd) => {
    transcript.push(`-> ${shown}`);
    control.write(`${cmd}\r\n`);
    return expect(codes, shown);
  };
  let data = null;
  try {
    await expect([220], 'greeting');
    await send(`USER ${p.user}`, [331, 230]);
    // The access code is the password: it is written to the socket and nowhere else.
    await send(`PASS ${p.password}`, [230, 202], 'PASS ****');
    await send('PBSZ 0', [200]);
    await send('PROT P', [200]);
    await send('TYPE I', [200]);
    const pasv = parsePasv((await send('PASV', [227])).text);
    const dataRaw = await connect({ host: p.host, port: pasv.port, purpose: 'data', timeoutMs });
    data = dataRaw;
    await send(`STOR ${p.remoteName}`, [125, 150]);
    const session = typeof (/** @type {any} */ (control).getSession) === 'function' ? /** @type {any} */ (control).getSession() : undefined;
    data = await p.secure(dataRaw, { purpose: 'data', session });
    const channel = data;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new FtpError('the data connection did not close after the upload')), timeoutMs);
      channel.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      channel.once('close', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      channel.end(p.data);
    });
    data = null;
    await expect([226, 250], 'transfer');
    try {
      await send('QUIT', [221]);
    } catch {
      // The file is stored; a server that hangs up without a goodbye changes nothing.
    }
    log.debug('ftps.stored', { host: p.host, name: p.remoteName, bytes: p.data.length });
    return { bytes: p.data.length, transcript };
  } finally {
    data?.destroy();
    control.destroy();
  }
}
