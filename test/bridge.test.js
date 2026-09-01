import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { BRIDGE, startStdioBridge } from "../src/connect.js";

// These tests never touch ssh: spawnRemote runs the exact remote BRIDGE script locally
// (`node -e BRIDGE <port>`) against a plain local HTTP server, which is exactly what a real
// `ssh ... node -e BRIDGE <port>` would do on the far end of a hardened Hoop.

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { await fn(port); } finally { server.close(); }
}

function get(port, path = "/") {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, res => {
      let body = "";
      res.on("data", d => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

test("startStdioBridge: a single HTTP GET through the bridge returns the server's real response", async () => {
  await withServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("hello from behind the bridge"); }, async remotePort => {
    // pick a free local port for the bridge itself
    const probe = net.createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
    const localPort = probe.address().port; await new Promise(r => probe.close(r));
    const bridge = startStdioBridge({ localPort, remotePort, spawnRemote: port => spawn(process.execPath, ["-e", BRIDGE, String(port)], { stdio: ["pipe", "pipe", "ignore"] }) });
    await bridge.ready;
    try {
      const { status, body } = await get(localPort);
      assert.equal(status, 200);
      assert.equal(body, "hello from behind the bridge");
    } finally { await bridge.close(); }
  });
});

test("startStdioBridge: multiple sequential connections each get a fresh child and correct response", async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; res.writeHead(200); res.end(`hit ${hits}`); }, async remotePort => {
    const probe = net.createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
    const localPort = probe.address().port; await new Promise(r => probe.close(r));
    const bridge = startStdioBridge({ localPort, remotePort, spawnRemote: port => spawn(process.execPath, ["-e", BRIDGE, String(port)], { stdio: ["pipe", "pipe", "ignore"] }) });
    await bridge.ready;
    try {
      const r1 = await get(localPort);
      const r2 = await get(localPort);
      const r3 = await get(localPort);
      assert.deepEqual([r1.body, r2.body, r3.body], ["hit 1", "hit 2", "hit 3"]);
    } finally { await bridge.close(); }
  });
});

test("startStdioBridge: concurrent connections are each answered independently", async () => {
  await withServer((req, res) => { setTimeout(() => { res.writeHead(200); res.end(req.url); }, 20); }, async remotePort => {
    const probe = net.createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
    const localPort = probe.address().port; await new Promise(r => probe.close(r));
    const bridge = startStdioBridge({ localPort, remotePort, spawnRemote: port => spawn(process.execPath, ["-e", BRIDGE, String(port)], { stdio: ["pipe", "pipe", "ignore"] }) });
    await bridge.ready;
    try {
      const [a, b, c] = await Promise.all([get(localPort, "/a"), get(localPort, "/b"), get(localPort, "/c")]);
      assert.deepEqual([a.body, b.body, c.body], ["/a", "/b", "/c"]);
    } finally { await bridge.close(); }
  });
});

test("startStdioBridge: closing the bridge kills bridge children and frees the local port", async () => {
  await withServer((req, res) => { res.writeHead(200); res.end("ok"); }, async remotePort => {
    const probe = net.createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
    const localPort = probe.address().port; await new Promise(r => probe.close(r));
    let spawnedChild;
    const bridge = startStdioBridge({
      localPort, remotePort,
      spawnRemote: port => { spawnedChild = spawn(process.execPath, ["-e", BRIDGE, String(port)], { stdio: ["pipe", "pipe", "ignore"] }); return spawnedChild; },
    });
    await bridge.ready;
    await get(localPort); // establish and finish one connection so a child exists
    await bridge.close();
    // the local port must be free again
    const again = net.createServer();
    await new Promise((resolve, reject) => { again.once("error", reject); again.listen(localPort, "127.0.0.1", resolve); });
    await new Promise(r => again.close(r));
  });
});
