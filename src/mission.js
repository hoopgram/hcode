// Durable objective runner: a model turn is a checkpoint, never the mission boundary.
export function ensureObjective(session, mission, acceptance = ["finish the requested outcome", "verify it with reproducible evidence"]) {
  if (session.objective) return session.objective;
  const objective = { v: 1, mission: String(mission).trim(), acceptance, checkpoint: "continue from the latest durable session evidence" };
  session.emit("objective.started", { objective });
  session.objective = objective;
  return objective;
}

export function objectivePrompt(objective) {
  if (!objective) return "";
  return ["# Durable objective (survives turns, compaction and restart)", `Mission: ${objective.mission}`,
    "Acceptance:", ...objective.acceptance.map(x => `- ${x}`), `Checkpoint rule: ${objective.checkpoint}`].join("\n");
}

export async function runMission({ session, mission, runTurn, budget, now = Date.now }) {
  const objective = ensureObjective(session, mission);
  const startedAt = now(); let steps = 0; let tokens = 0; let continuations = 0; let result;
  let prompt = mission;
  while (true) {
    result = await runTurn(prompt);
    steps += Number(result.steps || 0);
    tokens += Number(result.usage?.input || 0) + Number(result.usage?.output || 0);
    if (!result.truncated || result.cancelled) return { ...result, steps, tokens, continuations };
    const elapsedMs = Math.max(0, now() - startedAt);
    const exhausted = steps >= budget.steps ? "steps" : tokens >= budget.tokens ? "tokens" : elapsedMs >= budget.wallMs ? "wall" : null;
    if (exhausted) {
      const nextStep = `resume objective ${session.id} with more ${exhausted} budget`;
      session.emit("objective.stopped", { objective: objective.mission, reason: "budget", budget: exhausted, used: { steps, tokens, wallMs: elapsedMs }, nextStep });
      return { ...result, stopped: true, stopReason: "budget", budget: exhausted, nextStep, steps, tokens, continuations };
    }
    continuations++;
    session.emit("objective.checkpoint", { objective: objective.mission, reason: "truncated", continuation: continuations, used: { steps, tokens, wallMs: elapsedMs } });
    prompt = `Continue the durable objective. Do not restart or wait for a human. Read the objective and latest checkpoint from the session, then take the next smallest action.\n\n${objectivePrompt(objective)}`;
  }
}
