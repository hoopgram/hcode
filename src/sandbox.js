// OS sandbox adapters for `bash` (CONTRACTS-V027 §3): macOS sandbox-exec, Linux bwrap, else systemd-run.
// Each adapter turns {command, root, network} into an argv. `detect()` probes the adapter once per process with
// a real `true` and degrades honestly to "none" (sandboxDegraded) if the OS refuses — nothing is faked.
// Inside the sandbox: writes only under the project root and temp dirs; the secret directories are unreadable;
// the network is off unless the broker allowed it for this call. No npm, no daemons, no privileges.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = os.homedir();
const SECRET_DIRS = [".ssh", ".secrets", ".hoopgram", ".hcode", ".aws", ".gnupg", ".kube", ".codex", ".claude", ".config/gh", ".npmrc", ".netrc"].map(p => path.join(HOME, p));
const TMP = [os.tmpdir(), "/tmp", "/private/tmp", "/private/var/folders", "/var/folders"].filter((v, i, a) => a.indexOf(v) === i);

function has(bin) { return (process.env.PATH || "").split(path.delimiter).some(d => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } }); }
const q = s => '"' + String(s).replace(/["\\]/g, "\\$&") + '"';

function sandboxExecArgv({ root, network, argv }) {
  const writable = [root, ...TMP, path.join(HOME, ".npm"), path.join(HOME, ".cache"), path.join(HOME, "Library/Caches")].filter(p => fs.existsSync(p));
  const profile = [
    "(version 1)", "(allow default)",
    network ? "" : "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map(p => `(subpath ${q(fs.realpathSync(p))})`).join(" ")} (subpath "/dev") (literal "/dev/null") (regex #"^/private/var/run/"))`,
    SECRET_DIRS.some(p => fs.existsSync(p)) ? `(deny file-read* ${SECRET_DIRS.filter(p => fs.existsSync(p)).map(p => `(subpath ${q(p)})`).join(" ")})` : "",
  ].filter(Boolean).join("\n");
  return ["sandbox-exec", ["-p", profile, ...argv]];
}

function bwrapArgv({ root, network, argv }) {
  const a = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", root, root, "--die-with-parent", "--new-session"];
  for (const p of [path.join(HOME, ".cache"), path.join(HOME, ".npm")]) if (fs.existsSync(p)) a.push("--bind", p, p);
  for (const p of SECRET_DIRS) { try { const st = fs.statSync(p); a.push(st.isDirectory() ? "--tmpfs" : "--ro-bind", ...(st.isDirectory() ? [p] : ["/dev/null", p])); } catch { /* absent */ } }
  if (!network) a.push("--unshare-net");
  return ["bwrap", [...a, "--", ...argv]];
}

function systemdRunArgv({ root, network, argv }) {
  const props = ["ProtectSystem=strict", `ReadWritePaths=${root} /tmp`, "PrivateTmp=yes", "NoNewPrivileges=yes",
    `InaccessiblePaths=${SECRET_DIRS.filter(p => fs.existsSync(p)).map(p => "-" + p).join(" ")}`];
  if (!network) props.push("PrivateNetwork=yes");
  return ["systemd-run", ["--user", "--pipe", "--wait", "--quiet", "--collect", "--same-dir", ...props.flatMap(p => ["-p", p]), "--", ...argv]];
}

const ADAPTERS = { "sandbox-exec": sandboxExecArgv, bwrap: bwrapArgv, "systemd-run": systemdRunArgv };
let cached = null;

// detect({want}) → {adapter:"sandbox-exec|bwrap|systemd-run|none", degraded:bool, reason}
export function detect(want = "auto", { force = false } = {}) {
  if (cached && cached.want === want && !force) return cached;
  const candidates = want === "none" ? [] : want !== "auto" ? [want]
    : process.platform === "darwin" ? ["sandbox-exec"] : process.platform === "linux" ? ["bwrap", "systemd-run"] : [];
  let reason = want === "none" ? "policy says sandbox: none" : "no adapter for this OS";
  for (const name of candidates) {
    if (!has(name)) { reason = `${name} not installed`; continue; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-sb-"));
    const outside = path.join(HOME, ".hcode-sandbox-probe-" + process.pid);   // must NOT be writable from inside
    try {
      // the probe proves confinement, not just that the wrapper runs: a write inside the root must succeed and a
      // write outside it must fail (systemd-run --user, for example, accepts the properties and ignores them)
      const script = `echo ok >${q(path.join(root, "probe"))} && cat ${q(path.join(root, "probe"))}; (echo leak >${q(outside)}) 2>/dev/null && echo LEAK; true`;
      const [bin, args] = ADAPTERS[name]({ root, network: false, argv: ["sh", "-c", script] });
      const r = spawnSync(bin, args, { encoding: "utf8", timeout: 10000 });
      const leaked = fs.existsSync(outside) || /LEAK/.test(r.stdout || "");
      if (r.status === 0 && /ok/.test(r.stdout) && !leaked) { cached = { want, adapter: name, degraded: false, reason: "" }; return cached; }
      reason = leaked ? `${name} did not confine writes (this OS ignores its sandbox properties for an unprivileged user)`
        : `${name} refused a probe (${(r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n")[0].slice(0, 120)})`;
    } catch (e) { reason = `${name}: ${e.message}`; }
    finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { force: true }); }
  }
  cached = { want, adapter: "none", degraded: want !== "none", reason };
  return cached;
}

// wrap(argv, {root, network, adapter}) → [bin, args] to spawn
export function wrap(argv, { root, network = false, adapter }) {
  const fn = ADAPTERS[adapter];
  return fn ? fn({ root, network, argv }) : [argv[0], argv.slice(1)];
}

export function describe(status) {
  if (status.adapter !== "none") return `${status.adapter} (writes limited to the project, secrets unreadable, network ${"off unless approved"})`;
  return status.degraded ? `none — DEGRADED: ${status.reason}; commands run unconfined` : "none (by policy)";
}
