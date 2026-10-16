#!/usr/bin/env node
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { WorkspaceTerminal } from "./terminal.ts";
async function runTerminal() {
  const args = process.argv.slice(2);
  let url = "http://127.0.0.1:7432",
    workspaceId = "",
    diagnostics = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "adm terminal --url URL --workspace ID [--diagnostics]\nCtrl+C detaches. Agents keep running. Ctrl+R reconnects. /help lists commands.",
      );
      return;
    }
    if (args[i] === "--diagnostics") {
      diagnostics = true;
      continue;
    }
    if (args[i] === "--url" || args[i] === "--workspace") {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${args[i - 1]}`);
      if (args[i - 1] === "--url") url = value;
      else workspaceId = value;
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
