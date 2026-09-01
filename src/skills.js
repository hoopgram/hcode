// SKILL.md — the smallest, most sovereign capability packaging (HCode Plan stage 2, item 1 only).
// <cwd>/.hcode/skills/<name>/SKILL.md: a markdown file the owner wrote (or copied) that teaches the agent a
// procedure. Nothing executes; it is text in the system prompt, listed so the owner can audit it. Each skill is
// capped at 8000 chars, at most 20 skills; no network, no registry, no auto-discovery outside the project.
import fs from "node:fs";
import path from "node:path";

export function loadSkills(cwd) {
  const dir = path.join(cwd, ".hcode", "skills");
  let names; try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; }
  const skills = [];
  for (const name of names.slice(0, 20)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) continue;
    const file = path.join(dir, name, "SKILL.md");
    let text; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const truncated = text.length > 8000; if (truncated) text = text.slice(0, 8000) + "\n… (truncated)";
    const m = text.match(/^#\s*(.+)$/m);
    skills.push({ name, title: m ? m[1].trim() : name, file, text, chars: text.length, truncated });
  }
  return skills;
}

export function skillsPrompt(skills) {
  if (!skills.length) return "";
  return "\n# Skills (from .hcode/skills/*/SKILL.md — follow when the task matches)\n" +
    skills.map(s => `## skill: ${s.name}\n${s.text}`).join("\n\n");
}
