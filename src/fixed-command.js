// A bounded subprocess primitive for fixed product commands only. Callers own
// both the executable and every argument; this is never exposed as an arbitrary
// command or URL surface.
import { spawn } from "node:child_process";

export function runFixedCommand(binary, args, { cwd = process.cwd(), env = process.env, timeoutMs = 5000, maxBytes = 64_000 } = {}) {
  return new Promise(resolve => {
    let output = ""; let bytes = 0; let settled = false; let reason = "";
    let timer = null; let hardTimer = null;
    const detached = process.platform !== "win32";
    let child;
    try { child = spawn(binary, args, { cwd, env, shell: false, detached, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ output, code: null, ok: false, reason: error.message }); return; }
    const stop = signal => {
      try { detached && child.pid ? process.kill(-child.pid, signal) : child.kill(signal); } catch { /* already gone */ }
    };
    const finish = (result = {}) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hardTimer);
      resolve({ output, code: result.code ?? null, ok: !reason && result.code === 0, reason: reason || result.reason || "" });
    };
    const collect = chunk => {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes <= maxBytes) output += buffer.toString("utf8");
      else if (!reason) { reason = `output exceeded ${maxBytes} bytes`; stop("SIGTERM"); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", error => finish({ reason: error.message }));
    child.on("close", code => finish({ code }));
    timer = setTimeout(() => { reason = `timed out after ${timeoutMs}ms`; stop("SIGTERM"); }, timeoutMs);
    hardTimer = setTimeout(() => { stop("SIGKILL"); finish({ reason: reason || "did not stop" }); }, timeoutMs + 1000);
    timer.unref?.(); hardTimer.unref?.();
  });
}
