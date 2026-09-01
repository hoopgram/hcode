// One way to ask the owner to pick from a list. With a composer (`select`), it is the
// arrow-key menu: title between rules, options with descriptions, Enter confirms, Esc goes
// back. Without one (readline, pipes, --print) it falls back to a numbered list and a typed
// answer, accepting the number or any of an option's `keys`. Resolves the chosen index or
// null when the owner backs out (Esc, empty answer, or an answer that matches nothing).
// A `subtitle` is machine detail the question does not depend on (which sandbox, which file):
// it rides under the title rather than inside it, so the question stays one short line.
export async function selectOption({ title = "", subtitle = "", options = [], initial = 0, hint = "", select, ask, show = () => {}, fallbackPrompt = "Choose a number, or Enter to go back\n> " }) {
  if (!options.length) return null;
  if (select) {
    const index = await select({ title, subtitle, options, initial, hint });
    return Number.isInteger(index) && index >= 0 && index < options.length ? index : null;
  }
  show([title, ...(subtitle ? [subtitle] : []), ...options.map((option, i) => `  ${i + 1}. ${option.label}${option.current ? " (current)" : ""}${option.description ? `\n     ${option.description}` : ""}`)].join("\n"));
  const raw = String(await ask(fallbackPrompt) || "").trim().toLowerCase();
  if (!raw) return null;
  const number = Number(raw);
  if (Number.isInteger(number) && number >= 1 && number <= options.length) return number - 1;
  const byKey = options.findIndex(option => (option.keys || []).map(key => String(key).toLowerCase()).includes(raw));
  return byKey >= 0 ? byKey : null;
}
