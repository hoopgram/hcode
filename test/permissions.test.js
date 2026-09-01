import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { choosePermissionMode, chooseStartupPermission, confirmPermissionMode, permissionMenu } from "../src/permissions.js";
import { loadPolicy, savePolicyMode } from "../src/policy.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-permissions-"));

test("permission menu explains all as no-more-asking with fixed boundaries", () => {
  const menu = permissionMenu("ask", "auto → sandbox-exec");
  assert.match(menu, /recommended/); assert.match(menu, /act end to end/);
  assert.match(menu, /secret paths, money\/identity/); assert.match(menu, /root\/home deletion/); assert.match(menu, /Public search is query-only/);
  assert.equal(menu.split("\n")[0], "Permissions", "the title is the question, not the scope");
  assert.match(menu, /sandbox: auto → sandbox-exec/, "machine detail stays a subordinate line");
  assert.ok(menu.split("\n").every(line => line.length <= 88), "one sentence per mode, no wrapping");
});

test("all requires the exact owner yes and a decline returns to ask", async () => {
  const shown = [];
  const accepted = await choosePermissionMode({ current: "ask", sandbox: "sandbox-exec", show: value => shown.push(value), ask: async prompt => /Choose/.test(prompt) ? "4" : "yes" });
  assert.deepEqual(accepted, { mode: "all", changed: true, confirmed: true });
  assert.ok(shown.some(value => /powerful/.test(value)));
  const declined = await confirmPermissionMode({ current: "auto", mode: "all", show: () => {}, ask: async () => "y" });
  assert.deepEqual(declined, { mode: "ask", changed: true, declined: true }, "abbreviated consent is not enough for all");
});

test("ordinary modes are explicit, never need the dangerous confirmation, and default to this session", async () => {
  const asked = [];
  const result = await choosePermissionMode({ current: "ask", show: () => {}, ask: async prompt => { asked.push(prompt); return /How long/.test(prompt) ? "" : "3"; } });
  assert.deepEqual(result, { mode: "auto", changed: true }, "a bare Enter on the scope question keeps the change session-only");
  assert.equal(asked.length, 2, "the mode, then how long it holds");
  assert.match(asked[1], /How long/);
  const invalid = await confirmPermissionMode({ current: "read", mode: "yolo", ask: async () => "yes" });
  assert.equal(invalid.mode, "read"); assert.match(invalid.error, /read, ask, auto or all/);
});

test("'from now on' writes read/ask/auto to the project policy the next start reads", async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".hcode"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, network: { default: "on" } }));
  const answer = async prompt => /How long/.test(prompt) ? "2" : "3";
  const saved = await choosePermissionMode({ current: "ask", cwd, show: () => {}, ask: answer });
  assert.equal(saved.mode, "auto");
  assert.equal(saved.saved, path.join(cwd, ".hcode", "policy.json"));
  const reloaded = loadPolicy(cwd, { home: tmp() });
  assert.equal(reloaded.mode, "auto", "the next start opens on what the owner chose");
  assert.equal(reloaded.network.default, "on", "everything around the mode is still the owner's");

  // full access is now offered the same scope question as the other three — but persisting it takes
  // a second, separate typed-yes on top of the first, since "from now on" means every future session
  // opens already unlocked.
  const askAllScoped = reply => async prompt => {
    if (/Choose/.test(prompt)) return "4";
    if (/Enable full access/.test(prompt)) return "yes";
    if (/How long/.test(prompt)) return "2";
    if (/standing/.test(prompt)) return reply;
    throw new Error(`unexpected prompt: ${prompt}`);
  };
  const scoped = [];
  const declinedStanding = await choosePermissionMode({ current: "ask", cwd, show: () => {}, ask: async prompt => { scoped.push(prompt); return askAllScoped("no")(prompt); } });
  assert.equal(declinedStanding.mode, "all"); assert.equal(declinedStanding.confirmed, true);
  assert.equal(declinedStanding.saved, undefined, "declining the second, standing confirmation keeps it session-only");
  assert.ok(scoped.some(prompt => /How long/.test(prompt)), "all is now offered the scope question too");
  assert.equal(loadPolicy(cwd, { home: tmp() }).mode, "auto", "a declined standing confirmation never reaches the file");

  // an unanswered standing confirmation defaults to No, same as the first confirmation
  const silentStanding = await choosePermissionMode({ current: "ask", cwd, show: () => {}, ask: askAllScoped("") });
  assert.equal(silentStanding.saved, undefined, "the standing confirmation defaults to No, not to yes");

  // an explicit typed yes at every step is what it takes to make full access standing for a project
  const standing = await choosePermissionMode({ current: "ask", cwd, show: () => {}, ask: askAllScoped("yes") });
  assert.equal(standing.mode, "all"); assert.equal(standing.confirmed, true);
  assert.equal(standing.saved, path.join(cwd, ".hcode", "policy.json"));
  const reloadedAll = loadPolicy(cwd, { home: tmp() });
  assert.equal(reloadedAll.mode, "all", "a standing full-access decision is now something all can also do");
  assert.equal(reloadedAll.network.default, "on", "everything around the mode is still the owner's");

  // nowhere to write is said out loud rather than silently downgraded
  const homeless = await choosePermissionMode({ current: "ask", show: () => {}, ask: answer });
  assert.equal(homeless.mode, "auto");
  assert.match(homeless.saveError, /this session only/);
});

test("full access's standing confirmation defaults to No on the arrow path too, and savePolicyMode now accepts all", async () => {
  const cwd = tmp();
  const seen = [];
  const pick = answers => async spec => { seen.push(spec); return answers.shift(); };
  // 3 = all in the mode menu, 1 = "Yes, enable" for this session, then Enter (undefined) on both the
  // scope and standing menus — Enter must never turn into a "yes" on a menu that opens on "No".
  const silentSelect = await choosePermissionMode({ current: "ask", cwd, select: pick([3, 1]), ask: async () => { throw new Error("no typed prompt in menu mode"); } });
  assert.equal(silentSelect.mode, "all"); assert.equal(silentSelect.saved, undefined);
  const standingSelect = await choosePermissionMode({ current: "ask", cwd, select: pick([3, 1, 1, 1]), ask: async () => { throw new Error("no typed prompt in menu mode"); } });
  assert.equal(standingSelect.saved, path.join(cwd, ".hcode", "policy.json"));
  assert.match(seen.at(-1).title, /every session, from now on/i);
  assert.equal(loadPolicy(cwd, { home: tmp() }).mode, "all");

  assert.equal(savePolicyMode(cwd, "all"), path.join(cwd, ".hcode", "policy.json"));
  assert.throws(() => savePolicyMode(cwd, "bypass"), /read\|ask\|auto\|all/);
});

test("with a composer the modes are an arrow-key menu, and full access is a second explicit menu", async () => {
  const seen = [];
  const pick = answers => async spec => { seen.push(spec); return answers.shift(); };
  const auto = await choosePermissionMode({ current: "ask", sandbox: "sandbox-exec", select: pick([2, 0]), ask: async () => { throw new Error("no typed prompt in menu mode"); } });
  assert.deepEqual(auto, { mode: "auto", changed: true });
  assert.equal(seen[0].options[1].current, true, "the current mode is marked");
  assert.equal(seen[0].initial, 1, "the menu opens on the current mode");
  assert.equal(seen[0].title, "Permissions"); assert.match(seen[0].subtitle, /sandbox: sandbox-exec/);
  assert.match(seen[1].title, /How long/); assert.equal(seen[1].initial, 0, "the smaller promise is the default");
  const declined = await choosePermissionMode({ current: "ask", select: pick([3, 0]), ask: async () => "yes" });
  assert.deepEqual(declined, { mode: "ask", changed: false, declined: true }, "Enter on the default 'No' row never enables full access");
  assert.match(seen.at(-1).title, /full access/i);
  const enabled = await choosePermissionMode({ current: "ask", select: pick([3, 1]), ask: async () => "no" });
  assert.deepEqual(enabled, { mode: "all", changed: true, confirmed: true });
  const escaped = await choosePermissionMode({ current: "auto", select: pick([null]), ask: async () => "1" });
  assert.deepEqual(escaped, { mode: "auto", changed: false }, "Esc keeps the current mode");
});

test("菊与刀 startup defaults to full agency and can remember or ask again", async () => {
  const cwd = tmp(); const seen = [];
  const remembered = await chooseStartupPermission({ cwd, select: async spec => { seen.push(spec); return 0; }, ask: async () => "" });
  assert.equal(remembered.mode, "all"); assert.equal(loadPolicy(cwd, { home: tmp() }).mode, "all");
  assert.match(seen[0].subtitle, /菊守边界，刀行其事/); assert.match(seen[0].options[0].label, /recommended/);
  const another = tmp(); const answers = [1, 1];
  const everyTime = await chooseStartupPermission({ cwd: another, select: async () => answers.shift(), ask: async () => "" });
  assert.equal(everyTime.mode, "ask"); assert.equal(everyTime.saved, undefined); assert.equal(loadPolicy(another, { home: tmp() }).mode, null);
});

test("/permissions can forget only the project mode and ask again next startup", async () => {
  const cwd = tmp(); savePolicyMode(cwd, "all");
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, mode: "all", network: { default: "on" } }));
  const result = await confirmPermissionMode({ current: "all", mode: "ask", cwd, select: async () => 2, ask: async () => "" });
  assert.ok(result.cleared); const policy = loadPolicy(cwd, { home: tmp() });
  assert.equal(policy.mode, null); assert.equal(policy.network.default, "on");
});
