/* global require, URL, queueMicrotask */
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads run before ESM and must be CommonJS. */
// Preload for verification: a missed transport stub must not send mail,
// Telegram notifications or credentials. Child Node processes inherit it.
const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');
const local = (host) => !host || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host));
const blocked = () => Object.assign(new Error('OFFLINE_TEST_NETWORK_BLOCKED: inject a transport stub'), { code: 'ENETUNREACH' });
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  return local(url.hostname) ? fetchOriginal(input, options) : Promise.reject(blocked());
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let input = args[0];
  if (Array.isArray(input)) input = input[0];
  const host = typeof input === 'object' ? input?.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (!local(host)) throw blocked();
  return connect.apply(this, args);
};
const secureConnect = tls.connect;
tls.connect = function (...args) {
  const input = args[0];
  const host = typeof input === 'object' ? input?.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (!local(host)) throw blocked();
  return secureConnect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (!local(host)) {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') { queueMicrotask(() => callback(blocked())); return; }
    throw blocked();
  }
  return lookup.call(this, host, ...args);
};
