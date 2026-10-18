import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { join } from "node:path";

/** Workspace-local Pi auth storage remains for standalone/local runtimes. */
export function workspacePiAuthPath(workspaceRoot = "/workspace"): string {
  return join(workspaceRoot, ".adm", "pi", "auth.json");
}

/** Create a Pi runtime with local auth for standalone use and in-memory auth in-cluster. */
export async function workspaceCredentialRuntime(
  workspaceRoot = "/workspace",
  options: {
    allowModelNetwork?: boolean;
    authPath?: string;
    modelsStorePath?: string;
  } = {},
): Promise<ModelRuntime> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const sharedAuth = Boolean(process.env.ADM_LIFECYCLE_URL);
  return ModelRuntime.create({
    authPath: options.authPath ?? workspacePiAuthPath(workspaceRoot),
    modelsStorePath:
      options.modelsStorePath ??
      join(workspaceRoot, ".adm", "pi", "models-store.json"),
    ...(sharedAuth ? { credentials: new InMemoryCredentialStore() } : {}),
    allowModelNetwork: options.allowModelNetwork === true,
    ...(options.allowModelNetwork ? { refreshOnCreate: false } : {}),
  });
}
