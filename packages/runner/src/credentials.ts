import type { Models } from "@earendil-works/pi-ai/models";
import { join } from "node:path";

/** The private workspace volume is the single writable owner of Pi OAuth state. */
export function workspacePiAuthPath(workspaceRoot = "/workspace"): string {
  return join(workspaceRoot, ".adm", "pi", "auth.json");
}

/** Create Pi's normal runtime against the workspace-owned, restart-persistent auth store. */
export async function workspaceCredentialRuntime(
  workspaceRoot = "/workspace",
): Promise<Models> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create({
    authPath: workspacePiAuthPath(workspaceRoot),
    modelsStorePath: join(workspaceRoot, ".adm", "pi", "models-store.json"),
    allowModelNetwork: false,
  });
}
