import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  type KeybindingsConfig,
  type KeyId,
} from "@earendil-works/pi-tui";
const PI_APP_KEYBINDINGS = {
  "app.thinking.cycle": {
    defaultKeys: "shift+tab",
    description: "Cycle thinking level",
  },
  "app.thinking.toggle": {
    defaultKeys: "ctrl+t",
    description: "Toggle thinking blocks",
  },
  "app.tools.expand": {
    defaultKeys: "ctrl+o",
    description: "Expand tool output",
  },
  "app.editor.external": {
    defaultKeys: "ctrl+g",
    description: "Open external editor",
  },
  "app.clipboard.pasteImage": {
    defaultKeys: ["alt+v", "ctrl+v"] as KeyId[],
    description: "Paste image from clipboard",
  },
} as const;
export const terminalKeybindings = new KeybindingsManager({
  ...TUI_KEYBINDINGS,
  ...PI_APP_KEYBINDINGS,
});
setKeybindings(terminalKeybindings);

export async function configureTerminalKeybindings() {
  let bindings: KeybindingsConfig = {};
  try {
    const parsed = JSON.parse(
      await readFile(join(getAgentDir(), "keybindings.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(
        "expected a JSON object of keybinding IDs to key or key arrays",
      );
    bindings = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        `Cannot read Pi keybindings: ${error instanceof Error ? error.message : error}`,
      );
  }
  // Detach is an ADM safety control and deliberately remains fixed at Ctrl+C.
  // Pi's app.clear binding is not included, so its Ctrl+C default cannot shadow detach.
  terminalKeybindings.setUserBindings(bindings);
  return terminalKeybindings;
}
