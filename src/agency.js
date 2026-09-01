import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.js";

export const AGENCY_CANON_SHA256 = "988cbfe084ba74b174d89e35b112ce91a697501d6c55791b8d5babae2dec22e3";
export const AGENCY_KINDS = ["overspend", "delete_owner_data", "constitution_wording", "new_public_exposure", "owner_intent_conflict", "technical_uncertainty"];

export function agencyCanonPath() {
  return fileURLToPath(new URL("../FULL-AGENCY.md", import.meta.url));
}

export function loadAgencyCanon(file = agencyCanonPath()) {
  const text = fs.readFileSync(file, "utf8");
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash !== AGENCY_CANON_SHA256) throw new Error(`FULL_AGENCY_RED canonical authorization hash ${hash} != ${AGENCY_CANON_SHA256}`);
  return text;
}

const missing = (...values) => values.some(value => value === undefined || value === null || value === "");

// This broker deliberately judges machine facts, never the model's adjective ("risky", "important", …).
// STOP is emitted only when the supplied facts prove one exact hard gate. Missing facts are UNOBSERVED.
export function classifyEscalation(input) {
  const base = { kind: input.kind, summary: input.summary, proposedAction: input.proposed_action, recommendation: input.recommendation };
  if (input.kind === "technical_uncertainty") return { ...base, state: "CONTINUE", reason: "not a 4+1 hard gate; decide within scope, act, verify, and ledger it" };
  if (input.kind === "overspend") {
    if (missing(input.spend_cents, input.authorized_cents)) return { ...base, state: "UNOBSERVED", reason: "spend and authorized cents are required; measure them before deciding" };
    return Number(input.spend_cents) > Number(input.authorized_cents)
      ? { ...base, state: "STOP", reason: "proposed real spend exceeds the recorded authorization" }
      : { ...base, state: "CONTINUE", reason: "recorded spend is within the recorded authorization" };
  }
  if (input.kind === "delete_owner_data") {
    if (missing(input.target, input.operation)) return { ...base, state: "UNOBSERVED", reason: "target and operation are required" };
    return input.operation === "delete" && input.target_class === "owner_data"
      ? { ...base, state: "STOP", reason: "the proposed operation deletes owner data" }
      : { ...base, state: "CONTINUE", reason: "facts do not describe deletion of owner data" };
  }
  if (input.kind === "constitution_wording") {
    if (missing(input.target, input.operation)) return { ...base, state: "UNOBSERVED", reason: "target and operation are required" };
    return /(^|\/)CONSTITUTION\.md$/.test(input.target) && input.operation === "change_wording"
      ? { ...base, state: "STOP", reason: "the proposed operation changes constitutional wording" }
      : { ...base, state: "CONTINUE", reason: "facts do not describe a constitutional wording change" };
  }
  if (input.kind === "new_public_exposure") {
    if (missing(input.public_before, input.public_after, input.target)) return { ...base, state: "UNOBSERVED", reason: "target and before/after public state are required" };
    return input.public_before === false && input.public_after === true
      ? { ...base, state: "STOP", reason: "the proposed operation creates a new public exposure" }
      : { ...base, state: "CONTINUE", reason: "facts do not create a new public exposure" };
  }
  if (input.kind === "owner_intent_conflict") {
    // Free text cannot prove semantic contradiction. decideEscalation sets this only after checking a local owner record.
    if (input.__owner_intent_verified !== true) return { ...base, state: "UNOBSERVED", reason: "the proposed action is not present in a machine-verified owner-intent record; do not guess a conflict" };
    return { ...base, state: "STOP", reason: `proposed action conflicts with registered owner intent ${input.owner_intent_id} (${input.owner_intent_digest})`, evidence: input.conflict_evidence };
  }
  return { ...base, state: "UNOBSERVED", reason: "unknown gate kind; it is not permitted to invent a sixth gate" };
}

export function persistEscalation(result, root = path.join(HOME, "escalations")) {
  if (result.state !== "STOP") return null;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const target = path.join(root, `${id}.json`); const tmp = `${target}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ v: 1, at: new Date().toISOString(), ...result }, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
  const dir = fs.openSync(root, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return target;
}

export function decideEscalation(input, options = {}) {
  let facts = input;
  if (input.kind === "owner_intent_conflict") {
    const safeId = /^[A-Za-z0-9._-]{1,120}$/.test(String(input.owner_intent_id || ""));
    const registry = options.intentRoot || path.join(HOME, "owner-intents");
    try {
      if (!safeId) throw new Error("invalid owner intent id");
      const raw = fs.readFileSync(path.join(registry, `${input.owner_intent_id}.json`));
      const digest = createHash("sha256").update(raw).digest("hex");
      const record = JSON.parse(raw.toString("utf8"));
      const actionDigest = createHash("sha256").update(String(input.proposed_action)).digest("hex");
      const verified = digest === input.owner_intent_digest && Array.isArray(record.forbiddenActionDigests) && record.forbiddenActionDigests.includes(actionDigest);
      facts = { ...input, __owner_intent_verified: verified };
    } catch { facts = { ...input, __owner_intent_verified: false }; }
  }
  const result = classifyEscalation(facts);
  const outbox = persistEscalation(result, options.root);
  return { ...result, ...(outbox ? { outbox } : {}) };
}

// One ruler for "what agency level N means for the permission gate" — the startup --agency flag,
// /permission, and --resume all map through this. Level >= 3 acts with auto/all semantics, but the
// hard edges (money, identity, secret paths, root/home, network policy) still ask or refuse in
// decide(): an agency grant buys autonomy inside the fence, never the fence itself.
// 2026-08-28 (张良's layer-one diagnosis): --agency 8 was honoured at startup, dropped on --resume
// (the supervisor's resume invocation does not re-pass it), and the gate silently fell back to
// ask-per-action with no human present — five stalls. The grant now lives in the session trail
// (Session.agencyGrant) and is re-applied on every resume.
export function applyAgencyGrant(cfg, grant) {
  if (!grant || !Number.isInteger(grant.agencyLevel) || grant.agencyLevel < 0 || grant.agencyLevel > 9) return cfg;
  cfg.agencyLevel = grant.agencyLevel;
  cfg.fullAgency = grant.agencyLevel >= 7;
  cfg.mode = grant.agencyLevel >= 3 ? "all" : "ask";
  cfg.modeExplicit = true;
  cfg.agencyBudgetUsd = grant.agencyLevel === 9 ? (grant.agencyBudgetUsd ?? null) : null;
  if (grant.unattended) cfg.unattended = true;
  return cfg;
}
