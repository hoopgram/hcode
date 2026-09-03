// Deterministic JSON serialization: object keys sorted so the same value always canonicalizes to the
// same string, regardless of insertion order. Shared by session.js (idemKey) and coordinator.js
// (contractHash / verificationReceipt) — hashing needs a stable byte string, not just deep equality.
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
