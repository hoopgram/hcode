// Pure owner-facing projection of durable task/work facts. It never reads panes
// and never writes coordinator gates; owner decisions remain external events.
const SESSION = /^[a-z][a-z0-9-]{0,63}$/;
const WORK = /^work-[a-z0-9]{8,32}$/;
const allowedStatus = new Set(["running", "waiting-owner", "waiting-agent", "needs-review", "completed", "failed", "cancelled"]);
const freeze = state => Object.freeze({ ...state, sessions: Object.freeze(Object.fromEntries(Object.entries(state.sessions).map(([id, row]) => [id, Object.freeze({ ...row, gates: Object.freeze(row.gates.map(g => Object.freeze({ ...g }))), receipts: Object.freeze([...row.receipts]) })]))) });

export function createSessionTree(items = []) {
  const sessions = {};
  for (const item of items) {
    if (!item || !SESSION.test(item.id || "") || !WORK.test(item.workId || "") || sessions[item.id]) throw new Error("invalid or duplicate session tree item");
    if (!allowedStatus.has(item.status)) throw new Error(`invalid session status: ${item.status}`);
    sessions[item.id] = { id: item.id, workId: item.workId, runner: String(item.runner || "hcode"), status: item.status, waitingOn: item.waitingOn || null,
      owner: "hcode", control: "observed", gates: (item.gates || []).map(g => ({ id: String(g.id), status: String(g.status) })), receipts: (item.receipts || []).map(String) };
  }
  return freeze({ v: 1, revision: 0, followed: null, sessions });
}

export function reduceSessionTree(state, event) {
  if (!state || state.v !== 1 || !event || typeof event !== "object") throw new Error("invalid session tree event");
  const sessions = structuredClone(state.sessions); const row = event.id ? sessions[event.id] : null;
  if (event.type === "follow") { if (!row) throw new Error("unknown session"); return freeze({ ...state, revision: state.revision + 1, followed: row.id, sessions }); }
  if (!row) throw new Error("unknown session");
  if (event.type === "takeover") {
    if (event.by !== "owner") throw new Error("only the owner may take over");
    row.control = "owner";
  } else if (event.type === "release") {
    if (event.by !== "owner" || row.control !== "owner") throw new Error("only the current owner may release");
    row.control = "observed";
  } else if (event.type === "gate.updated") {
    const gate = row.gates.find(g => g.id === event.gateId); if (!gate) throw new Error("unknown gate");
    if (gate.status === "requested" && event.status === "approved" && event.by !== "owner") throw new Error("session tree cannot auto-approve an owner gate");
    gate.status = String(event.status);
  } else if (event.type === "receipt.added") {
    if (!/^sha256:[a-f0-9]{64}$/.test(event.receiptId || "")) throw new Error("invalid receipt id");
    if (!row.receipts.includes(event.receiptId)) row.receipts.push(event.receiptId);
  } else throw new Error(`unknown session tree event: ${event.type}`);
  return freeze({ ...state, revision: state.revision + 1, sessions });
}

export function projectSessionTree(state) {
  return Object.freeze({ v: 1, followed: state.followed, sessions: Object.freeze(Object.values(state.sessions).map(row => Object.freeze({ id: row.id, workId: row.workId,
    runner: row.runner, status: row.status, waitingOn: row.waitingOn, control: row.control, gates: row.gates, receipts: row.receipts }))) });
}
