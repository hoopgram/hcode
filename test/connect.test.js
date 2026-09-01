import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { chooseLocalPorts, probeBrain } from "../src/connect.js";

test("default dual tunnel chooses fresh ports instead of trusting a busy listener", async () => {
  const busy = new Set([18092]);
  const chosen = await chooseLocalPorts({ localPort: 18092, hoopLocalPort: 18095, dual: true, autoPort: true }, async port => !busy.has(port));
  assert.deepEqual(chosen, { localPort: 18093, hoopLocalPort: 18096, reassigned: true });
});

test("default single data tunnel can move without inventing a second port", async () => {
  const chosen = await chooseLocalPorts({ localPort: 18095, dual: false, autoPort: true }, async port => port !== 18095);
  assert.deepEqual(chosen, { localPort: 18096, reassigned: true });
});

test("explicit ports never move silently and invalid pairs are rejected", async () => {
  await assert.rejects(chooseLocalPorts({ localPort: 18092, hoopLocalPort: 18095, dual: true }, async port => port !== 18092), /--port/);
  await assert.rejects(chooseLocalPorts({ localPort: 18092, hoopLocalPort: 18092, dual: true, autoPort: true }), /must be different/);
  await assert.rejects(chooseLocalPorts({ localPort: 0, dual: false, autoPort: true }), /1 to 65535/);
});

// probeBrain distinguishes "ssh is listening locally" from "the process on the other end of the
// tunnel actually speaks HTTP" — the real bug this closes (ssh -L listens immediately even when
// the remote port is dead, so a bare TCP connect can never tell the two apart).
test("probeBrain: a real HTTP server behind the tunnel counts as alive, even on a non-2xx path", async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end("no such route"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { assert.equal(await probeBrain(`http://127.0.0.1:${port}`), true); }
  finally { server.close(); }
});

test("probeBrain: a listener that resets the connection counts as dead", async () => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { assert.equal(await probeBrain(`http://127.0.0.1:${port}`), false); }
  finally { server.close(); }
});

test("probeBrain: nothing listening (connection refused) counts as dead", async () => {
  // Reserve a port, close it, then probe the now-empty port: guaranteed nothing answers there.
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  assert.equal(await probeBrain(`http://127.0.0.1:${port}`), false);
});

test("probeBrain: a listener that never responds is dead once the timeout elapses", async () => {
  const server = net.createServer(() => { /* accept the connection, then say nothing forever */ });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { assert.equal(await probeBrain(`http://127.0.0.1:${port}`, { timeoutMs: 200 }), false); }
  finally { server.close(); }
});
