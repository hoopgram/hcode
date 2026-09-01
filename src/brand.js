// Terminal translation of the canonical HoopGram mark in nixos/apps/web/brand/hoop.svg.
// The outer cells keep that mark's open golden Hoop and inward curls; the quiet inner cells add
// hcode's robot face. This is geometry, not a second logo: SVG remains the brand source of truth.
export const HOOP_GOLD = Object.freeze({ light: "#FFD44F", middle: "#F5B301", dark: "#C9920A" });
export const ROBOT_HOOP_WIDTH = 16;
export const CHARGE_CELLS = 24;

const identity = value => String(value);
const ink = palette => ({
  gold: palette?.gold || identity,
  glow: palette?.glow || palette?.gold || identity,
  face: palette?.bold || identity,
  dim: palette?.dim || identity,
  sand: palette?.sand || identity,
});

export function robotHoopRows(palette) {
  const p = ink(palette);
  return [
    p.gold("   ╭────────╮   "),
    `${p.gold(" ╭─╯ ")}${p.face("┌────┐")}${p.gold(" ╰─╮ ")}`,
    `${p.gold(" │   ")}${p.face("│ ")}${p.glow("● ●")}${p.face("│")}${p.gold("   │ ")}`,
    `${p.gold(" ╰╮  ")}${p.face("│  ─ │")}${p.gold("  ╭╯ ")}`,
    `${p.gold("  ╰─╮")}${p.face("└────┘")}${p.gold("╭─╯  ")}`,
  ];
}

// Launch gets room to breathe; the dialog keeps the compact mark above. The outer eleven-row
// silhouette follows the same open-bottom Ω gesture as the SVG, with a separate robot face inside.
export function robotHoopSplashRows(palette) {
  const p = ink(palette); const mixed = (left, face, right) => `${p.gold(left)}${p.face(face)}${p.gold(right)}`;
  return [
    p.gold("       ╭────────────────────────╮       "),
    p.gold("    ╭──╯                        ╰──╮    "),
    mixed("  ╭─╯       ", "┌──────────────┐", "       ╰─╮  "),
    `${p.gold(" ╭╯         ")}${p.face("│  ")}${p.glow("●        ●")}${p.face("  │")}${p.gold("         ╰╮ ")}`,
    mixed(" │          ", "│              │", "          │ "),
    mixed(" │          ", "│      ──      │", "          │ "),
    mixed(" ╰╮         ", "└──────────────┘", "         ╭╯ "),
    p.gold("  ╰──╮                            ╭──╯  "),
    p.gold("     ╰────╮                  ╭────╯     "),
    p.gold("          ╰────╮        ╭────╯          "),
    p.gold("               ╰╮      ╭╯               "),
  ];
}

// The bright head moves with the filled edge. There is one state per frame and no timer here, so
// tests and reduced-motion callers can project the exact same identity without starting motion.
export function chargeBar(step, frames, palette, cells = CHARGE_CELLS) {
  const p = ink(palette); const count = Math.max(4, Number(cells) || CHARGE_CELLS);
  const total = Math.max(1, Number(frames) || 1); const index = Math.max(0, Math.min(total - 1, Number(step) || 0));
  const filled = Math.max(1, Math.round(((index + 1) / total) * count));
  let body = "";
  for (let cell = 0; cell < count; cell++) {
    if (cell < filled - 2) body += p.gold("█");
    else if (cell === filled - 2) body += p.sand("▓");
    else if (cell === filled - 1) body += p.glow("█");
    else body += p.dim("·");
  }
  return `${p.dim("╺")}${body}${p.dim("╸")}`;
}
