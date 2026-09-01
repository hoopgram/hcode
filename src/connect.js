// `hcode connect <name>`: use YOUR Hoop as the brain from another machine.
// Opens an SSH tunnel with your own SSH key (ssh's normal agent/keys — hcode never stores any),
// forwards localhost:18092 → the Hoop's keyproxy and localhost:18095 → its owner data API.
// A successful explicit connection may remember only the public Hoop name so
// plain `hcode` can reopen the tunnel; no API key, password, token or SSH key is stored.
//
// Some hardened Hoops set `AllowTcpForwarding no` in sshd_config. ssh still happily binds the
// local `-L` listener in that case (that bind is purely local), so waitPort() looks fine — but
// the moment a real connection is forwarded, sshd refuses the channel-open request with
// "administratively prohibited" and the local socket resets. When that happens we fall back to
// a stdio bridge: a plain `ssh ... node -e <BRIDGE>` exec per connection (exec is still allowed),
// piping the local TCP socket to that child's stdin/stdout byte for byte.
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function hoopHost(name) {
  if (!/^[a-z0-9]([a-z0-9-]{1,18}[a-z0-9])?$/.test(name) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(name)) throw new Error(`bad Hoop name ${name}`);
  return name.includes(".") ? name : `${name}.hoopgram.ai`;
}

function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true))).listen(port, "127.0.0.1");
  });
}

const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;

// Never reuse an unknown listener: it could impersonate the Hoop brain. When the
// owner did not choose explicit ports, find a fresh pair and let SSH authenticate
// the remote endpoint and own both forwards.
export async function chooseLocalPorts({ localPort = 18092, hoopLocalPort = 18095, dual = true, autoPort = false } = {}, isFree = portFree) {
  if (!validPort(localPort) || dual && !validPort(hoopLocalPort)) throw new Error("local tunnel ports must be integers from 1 to 65535");
  if (dual && localPort === hoopLocalPort) throw new Error("brain and Hoop data ports must be different");
  const available = async (brain, data) => await isFree(brain) && (!dual || brain !== data && await isFree(data));
  if (await available(localPort, hoopLocalPort)) return { localPort, ...(dual ? { hoopLocalPort } : {}), reassigned: false };
  if (!autoPort) {
    if (!(await isFree(localPort))) throw new Error(`local port ${localPort} is busy — choose another with --port`);
    throw new Error(`local port ${hoopLocalPort} is busy — choose another with --hoop-port`);
  }
  for (let offset = 1; offset <= 200; offset++) {
    const brain = localPort + offset, data = hoopLocalPort + offset;
    if (!validPort(brain) || dual && !validPort(data)) break;
    if (await available(brain, data)) return { localPort: brain, ...(dual ? { hoopLocalPort: data } : {}), reassigned: true };
  }
  throw new Error("could not find free localhost ports for the SSH tunnel");
}

function waitPort(port, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => { sock.destroy(); if (Date.now() - t0 > ms) reject(new Error("tunnel did not come up")); else setTimeout(tick, 300); });
    };
    tick();
  });
}

// A TCP connect to the local forwarded port only proves ssh is listening — ssh opens that
// listener the moment it starts, whether or not anything answers on the far end. The only
// way to know the brain process itself is alive is to push an HTTP request all the way
// through the tunnel and see whether an HTTP response comes back (any status — even 401/404
// counts, since it proves something on 127.0.0.1:<remotePort> spoke HTTP back) versus the
// tunnel resetting/refusing/timing out because nothing is listening behind it.
export function probeBrain(url, { timeoutMs = 3000, path = "/v1/models" } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = alive => { if (settled) return; settled = true; resolve(alive); };
    let req;
    try { req = http.get(new URL(path, url), { timeout: timeoutMs }); }
    catch { finish(false); return; }
    req.once("response", res => { res.resume(); finish(true); });
    req.once("timeout", () => { req.destroy(); finish(false); });
    req.once("error", () => finish(false));
  });
}

// The next-step hint shown whenever a tunnel comes up but the brain behind it does not answer.
export function brainDownHint(host, user, remotePort) {
  return `tunnel is up, but the brain service on ${host}:${remotePort} refused/reset the connection — it is not running on ${host}.\n` +
    `next steps:\n  ssh ${user}@${host} 'ss -ltnp | grep ${remotePort}'\n  hcode doctor`;
}

const FORWARDING_FORBIDDEN = /administratively prohibited/i;
// ssh stderr that means "try again", not "you are not allowed": the far end dropped the
// connection before or during the handshake.
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One-shot: is anything listening on 127.0.0.1:port right now? (waitPort() is the retrying form.)
export function portListening(port, ms = 500) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), ms);
  });
}

export const TRANSIENT_SSH = /connection closed by|connection reset|kex_exchange_identification|connection timed out|broken pipe/i;

// Does ssh's stderr say sshd itself refused to forward (AllowTcpForwarding no)? Give the
// message a brief window to arrive: it is written by ssh only once the far end rejects a
// channel-open, which happens right as (not strictly before) the probe's socket resets.
async function forwardingForbidden(getErr, ms = 800) {
  if (FORWARDING_FORBIDDEN.test(getErr())) return true;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise(r => setTimeout(r, 40));
    if (FORWARDING_FORBIDDEN.test(getErr())) return true;
  }
  return false;
}

function controlSocketPath(user, host) {
  const hash = crypto.createHash("sha1").update(`${user}@${host}`).digest("hex").slice(0, 10);
  return path.join(os.tmpdir(), `hcode-ssh-${hash}`);
}

function cleanupControlSocket(cpath) {
  try { fs.unlinkSync(cpath); } catch { /* already gone */ }
}

// The ControlMaster takes a full SSH handshake (auth, key exchange) to stand up its control
// socket — commonly a couple of seconds over a real network. Without waiting for it, the
// very first per-connection ssh (ControlMaster=no) falls back to its own full handshake too
// and can blow straight through probeBrain()'s short timeout. Poll for the socket file
// instead of guessing a fixed delay; if it never shows up, per-connection ssh still works
// (just slower, one handshake per connection) so this is an optimization, not a requirement.
function waitControlSocket(cpath, ms = 8000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      if (fs.existsSync(cpath)) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Remote-side one-liner, exec'd as `ssh ... node -e BRIDGE <port>`: bridges its own
// stdin/stdout to a TCP connection on 127.0.0.1:<port> on the far end, byte for byte.
// CommonJS (ssh -e runs it with the remote's default `node`, no ESM guarantee).
export const BRIDGE = 'const n=require("net");const p=+process.argv[1];const s=n.connect(p,"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(2));s.on("close",()=>process.exit(0));process.stdin.on("end",()=>s.end());';

// Bridges every local TCP connection on `localPort` to a fresh child process from
// spawnRemote(remotePort), piping socket⇄child.stdin/stdout byte for byte (backpressure
// handled by .pipe() itself). Used both for real ssh (spawnRemote execs BRIDGE on the far
// end) and in tests (spawnRemote runs BRIDGE locally, in-process, against a plain TCP server).
export function startStdioBridge({ localPort, remotePort, spawnRemote, host = "127.0.0.1" }) {
  const children = new Set();
  const server = net.createServer(socket => {
    let child;
    try { child = spawnRemote(remotePort); }
    catch { socket.destroy(); return; }
    children.add(child);
    const done = () => { children.delete(child); try { child.kill(); } catch {} try { socket.destroy(); } catch {} };
    socket.on("error", done);
    socket.on("close", done);
    child.on("error", done);
    child.on("exit", done);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(localPort, host, () => resolve());
  });
  const close = () => new Promise(resolve => {
    for (const child of [...children]) { try { child.kill(); } catch {} }
    children.clear();
    server.close(() => resolve());
  });
  return { server, ready, close };
}

// Every ssh we spawn shares these; `extra` are the per-role options (-L, ControlMaster, …).
const sshArgs = ({ user, host, identity, extra = [], command = [] }) =>
  ["-o", "BatchMode=yes", ...extra, ...(identity ? ["-i", identity] : []), `${user}@${host}`, ...command];

export async function openTunnel({ name, user = "gram", localPort = 18092, remotePort = 8092, hoopLocalPort = 18095, identity, autoPort = false, bridge = false }) {
  const host = hoopHost(name);
  const dual = remotePort === 8092;
  const chosen = await chooseLocalPorts({ localPort, hoopLocalPort, dual, autoPort });
  localPort = chosen.localPort; if (dual) hoopLocalPort = chosen.hoopLocalPort;

  const sshProcesses = [];
  let cpath = null;
  let bridgeHandle = null;
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    bridgeHandle?.close();
    for (const p of sshProcesses) { try { p.kill("SIGTERM"); } catch {} }
    if (cpath) cleanupControlSocket(cpath);
  };

  const baseUrl = `http://127.0.0.1:${localPort}`;
  let brainAlive = false;
  let viaBridge = false;
  let hint;

  // A Hoop remembered as bridge-only (sshd AllowTcpForwarding no, seen on an earlier connect)
  // skips the -L attempt entirely: that attempt is a full SSH handshake whose only possible
  // outcome is "administratively prohibited", and back-to-back handshakes are exactly what
  // makes a hardened sshd (MaxStartups) start closing connections on us.
  if (!bridge) {
    const forwards = ["-L", `${localPort}:127.0.0.1:${remotePort}`, ...(dual ? ["-L", `${hoopLocalPort}:127.0.0.1:8095`] : [])];
    const spawnForward = () => {
      const child = spawn("ssh", sshArgs({ user, host, identity, extra: ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", ...forwards] }), { stdio: ["ignore", "ignore", "pipe"] });
      sshProcesses.push(child);
      child.err = "";
      child.stderr.on("data", d => { child.err += d.toString(); });
      child.exited = new Promise(resolve => child.once("exit", code => resolve(code)));
      return child;
    };
    const waitForward = child => Promise.race([
      Promise.all([waitPort(localPort), ...(dual ? [waitPort(hoopLocalPort)] : [])]),
      child.exited.then(code => { throw new Error(`ssh exited (${code}): ${child.err.trim() || "check your SSH key for " + user + "@" + host}`); }),
    ]);
    // The single retry policy for transient drops lives here (see TRANSIENT_SSH); callers do not retry again.
    let sshChild = spawnForward();
    try {
      try { await waitForward(sshChild); }
      catch (e) {
        if (!TRANSIENT_SSH.test(e.message)) throw e;
        await sleep(1500);
        sshChild = spawnForward();
        await waitForward(sshChild);
      }
    } catch (e) { close(); throw e; }
    const sshExited = sshChild.exited;

    brainAlive = await probeBrain(baseUrl);
    if (!brainAlive && await forwardingForbidden(() => sshChild.err)) {
      // sshd rejects the channel-open at the port-forward level; exec is still allowed, so
      // replace the (non-functional) -L forward with a stdio bridge. The old ssh child owns
      // the local port via its -L bind — it has to go before we can bind our own server there.
      try { sshChild.kill("SIGTERM"); } catch {}
      await sshExited;
      bridge = true;
    }
  }

  if (bridge) {
    cpath = controlSocketPath(user, host);
    let masterErr = "";
    const spawnMaster = () => {
      const master = spawn("ssh", sshArgs({ user, host, identity, extra: ["-N", "-o", "ExitOnForwardFailure=no", "-o", "ServerAliveInterval=30", "-o", "ControlMaster=yes", "-o", `ControlPath=${cpath}`, "-o", "ControlPersist=no"] }), { stdio: ["ignore", "ignore", "pipe"] });
      sshProcesses.push(master);
      master.stderr.on("data", d => { masterErr += d.toString(); });
      return master;
    };
    let master = spawnMaster();

    // Per connection: multiplex over the master's control socket (ControlMaster=no) so this
    // does not pay a full SSH handshake every time; falls back to a normal (slower) connection
    // if the control socket is not ready yet.
    const spawnRemote = port => {
      // ssh does not shell-quote a remote command for you: it joins every trailing argv
      // element with a bare space and hands the result to the remote's login shell, so the
      // BRIDGE source (parens, semicolons, `=>`, …) must already be one shell-safe token —
      // single-quoted, since BRIDGE itself contains no single quotes.
      return spawn("ssh", sshArgs({ user, host, identity, extra: ["-o", `ControlPath=${cpath}`, "-o", "ControlMaster=no"], command: ["node", "-e", `'${BRIDGE}'`, String(port)] }), { stdio: ["pipe", "pipe", "ignore"] });
    };

    const bridges = [startStdioBridge({ localPort, remotePort, spawnRemote })];
    if (dual) bridges.push(startStdioBridge({ localPort: hoopLocalPort, remotePort: 8095, spawnRemote }));
    bridgeHandle = { close: () => Promise.all(bridges.map(b => b.close())) };

    try {
      await Promise.all(bridges.map(b => b.ready));
      let ready = await waitControlSocket(cpath);
      // sshd closing the master mid-handshake ("Connection closed by <ip> port 22", a reset, a
      // kex failure) is almost always transient — MaxStartups pressure from our own handshakes
      // or a VPN/proxy hiccup — so one fresh master after a short pause is cheap and usually
      // enough. Bounded to a single retry; a real auth/host problem still surfaces below.
      if (!ready && master.exitCode !== null && TRANSIENT_SSH.test(masterErr)) {
        const firstErr = masterErr; masterErr = "";
        await sleep(1500);
        master = spawnMaster();
        ready = await waitControlSocket(cpath);
        if (!ready && !masterErr.trim()) masterErr = firstErr;
      }
      brainAlive = await probeBrain(baseUrl);
      viaBridge = brainAlive;
    } catch (e) {
      brainAlive = false;
      hint = `ssh stdio bridge failed to start: ${e.message}`;
    }

    if (!brainAlive && !hint) {
      const firstLine = masterErr.trim().split("\n")[0];
      hint = firstLine && !FORWARDING_FORBIDDEN.test(masterErr)
        ? `ssh exec to ${user}@${host} failed: ${firstLine}`
        : brainDownHint(host, user, remotePort);
    }
  }

  return { host, user, remotePort, localPort, reassigned: chosen.reassigned, baseUrl, brainAlive, viaBridge, ...(hint ? { hint } : {}), ...(dual ? { hoopLocalPort, hoopUrl: `http://127.0.0.1:${hoopLocalPort}` } : {}), close };
}
