/**
 * TEST-ONLY (loaded into the Electron MAIN process by the e2e harness via
 * `electron -r`, never part of the app): records every outbound
 * Node socket connection that is not local, so main-process networking
 * (http, https, fetch/undici, net, tls) cannot go unnoticed. Chromium
 * traffic is covered separately by --log-net-log. Each attempt is appended
 * as one JSON line to BENGKELIN_TEST_NET_GUARD_LOG and then refused.
 */
'use strict';
const fs = require('node:fs');
const net = require('node:net');

const logFile = process.env.BENGKELIN_TEST_NET_GUARD_LOG;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

function target(args) {
  const first = args[0];
  if (Array.isArray(first)) return target(first);
  if (first && typeof first === 'object') {
    if (first.path) return null; // IPC pipe / unix socket
    return { host: first.host || 'localhost', port: first.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null; // path
  return {
    host: typeof args[1] === 'string' ? args[1] : 'localhost',
    port: first,
  };
}

if (logFile) {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const dest = target(args);
    if (dest && !LOCAL.test(String(dest.host))) {
      try {
        fs.appendFileSync(
          logFile,
          `${JSON.stringify({ pid: process.pid, host: String(dest.host), port: dest.port })}\n`,
        );
      } catch {
        // Recording must never break the app under test.
      }
      const socket = this;
      process.nextTick(() =>
        socket.destroy(new Error('Network access refused in e2e tests')),
      );
      return socket;
    }
    return connect.apply(this, args);
  };
}
