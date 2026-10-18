#!/usr/bin/env node
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { WorkspaceTerminal } from "./terminal.ts";
import { configureTerminalKeybindings } from "./keybindings.ts";
async function runTerminal() {
  await configureTerminalKeybindings();
  const args = process.argv.slice(2);
  let url = "http://127.0.0.1:7432",
    workspaceId = "",
    tokenFile: string | undefined,
    identityFile: string | undefined,
    adminExecutable: string | undefined,
    adminArgs: string[] = [],
    diagnostics = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "adm terminal --url URL --workspace ID [--identity-file PATH] [--admin-executable PATH --admin-args-json JSON] [--diagnostics]\nCtrl+C detaches. Agents keep running. Ctrl+R reconnects. /help lists commands.",
      );
      return;
    }
    if (args[i] === "--diagnostics") {
      diagnostics = true;
      continue;
    }
    if (
      args[i] === "--url" ||
      args[i] === "--workspace" ||
      args[i] === "--token-file" ||
      args[i] === "--identity-file" ||
      args[i] === "--admin-executable" ||
      args[i] === "--admin-args-json"
    ) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${args[i - 1]}`);
      if (args[i - 1] === "--url") url = value;
      else if (args[i - 1] === "--workspace") workspaceId = value;
      else if (args[i - 1] === "--token-file") tokenFile = value;
      else if (args[i - 1] === "--identity-file") identityFile = value;
      else if (args[i - 1] === "--admin-executable") adminExecutable = value;
      else {
        const parsed: unknown = JSON.parse(value);
        if (
          !Array.isArray(parsed) ||
          parsed.some((entry) => typeof entry !== "string")
        )
          throw new Error("--admin-args-json must be a JSON array of strings");
        adminArgs = parsed;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!workspaceId) throw new Error("--workspace ID is required");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Attachment requires an interactive terminal");
  const ui = new TuiMainScreen(new ProcessTerminal());
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const terminal = new WorkspaceTerminal({
    url,
    workspaceId,
    tokenFile,
    identityFile,
    ...(adminExecutable
      ? { adminCommand: { executable: adminExecutable, args: adminArgs } }
      : {}),
    diagnostics,
    tui: ui,
    onRender: () => ui.requestRender(),
    onDetach: finish,
  });
  ui.addChild(terminal);
  ui.setFocus(terminal);
  const detach = () => finish();
  process.on("SIGINT", detach);
  process.on("SIGTERM", detach);
  try {
    ui.start();
    void terminal.connect();
    await done;
  } finally {
    terminal.close();
    ui.stop();
    process.off("SIGINT", detach);
    process.off("SIGTERM", detach);
    process.stdin.pause();
  }
}
runTerminal().catch((error) => {
  console.error(
    `adm terminal: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
