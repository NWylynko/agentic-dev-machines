#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(
  process.argv[2] ?? "node_modules/@earendil-works/pi-coding-agent",
);
const manifest = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "1.2.0")
  throw new Error(
    `ADM InteractiveMode patch requires @earendil-works/pi-coding-agent@1.2.0; got ${manifest.name}@${manifest.version}`,
  );

async function patch(relativePath, replacements) {
  const path = resolve(packageRoot, relativePath);
  let source = await readFile(path, "utf8");
  for (const [before, after, expected = 1] of replacements) {
    const count = source.split(before).length - 1;
    if (source.includes(after)) continue;
    if (count !== expected)
      throw new Error(
        `Expected ${expected} pinned Pi patch points in ${relativePath}, found ${count}: ${before.slice(0, 90)}`,
      );
    source = source.replaceAll(before, after);
  }
  await writeFile(path, source);
}

await patch("dist/modes/interactive/interactive-mode.js", [
  [
    "const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);",
    "const trustStore = this.runtimeHost.remotePorts?.projectTrust ?? new ProjectTrustStore(this.runtimeHost.services.agentDir);",
    2,
  ],
  [
    "onSelect: (selection) => {",
    "onSelect: async (selection) => {",
  ],
  [
    "trustStore.setMany(selection.updates);",
    "await trustStore.setMany(selection.updates);",
  ],
  [
    "maybeSaveImplicitProjectTrustAfterReload() {",
    "async maybeSaveImplicitProjectTrustAfterReload() {",
  ],
  [
    "if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {",
    "if (!this.settingsManager.isProjectTrusted() || !(await (this.runtimeHost.remotePorts?.projectTrust?.hasTrustRequiringResources(cwd) ?? hasTrustRequiringProjectResources(cwd)))) {",
  ],
  [
    "trustStore.set(cwd, true);",
    "await trustStore.set(cwd, true);",
  ],
  [
    "const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();",
    "const savedImplicitProjectTrust = await this.maybeSaveImplicitProjectTrustAfterReload();",
  ],
  [
    `if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
                this.anthropicSubscriptionWarningShown = true;
                this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
                return;
            }
            const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
            if (!isAnthropicSubscriptionAuthKey(apiKey)) {
                return;
            }`,
    `if (this.runtimeHost.remotePorts?.authMetadata) {
                if (!(await this.runtimeHost.remotePorts.authMetadata.isAnthropicSubscription())) {
                    return;
                }
            }
            else {
                if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
                    this.anthropicSubscriptionWarningShown = true;
                    this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
                    return;
                }
                const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
                if (!isAnthropicSubscriptionAuthKey(apiKey)) {
                    return;
                }
            }`,
  ],
]);

await patch("dist/modes/interactive/interactive-mode.d.ts", [
  [
    'import { type AgentSessionRuntime } from "../../core/agent-session-runtime.ts";',
    'import { type AgentSessionRuntime } from "../../core/agent-session-runtime.ts";\nimport type { AgentSession } from "../../core/agent-session.ts";\nimport type { AgentSessionServices } from "../../core/agent-session-services.ts";\nimport type { ProjectTrustDecision, ProjectTrustStoreEntry, ProjectTrustUpdate } from "../../core/trust-manager.ts";',
  ],
  [
    "/**\n * Options for InteractiveMode initialization.\n */",
    `/** A workspace-owned trust store used by remote InteractiveMode runtimes. */
export interface InteractiveModeProjectTrustPort {
    get(cwd: string): ProjectTrustDecision;
    getEntry(cwd: string): ProjectTrustStoreEntry | null;
    set(cwd: string, decision: ProjectTrustDecision): void | Promise<void>;
    setMany(decisions: ProjectTrustUpdate[]): void | Promise<void>;
    hasTrustRequiringResources(cwd: string): boolean | Promise<boolean>;
}
/** Nonsecret provider classification used by remote InteractiveMode. */
export interface InteractiveModeAuthMetadataPort {
    isAnthropicSubscription(): boolean | Promise<boolean>;
}
/** Remote runtime surface that preserves the Pi session API without owning a Pi session. */
export type RemoteInteractiveModeRuntime = {
    session: Pick<AgentSession, keyof AgentSession>;
    services: Pick<AgentSessionServices, "agentDir">;
    setBeforeSessionInvalidate(callback?: () => void): void;
    setRebindSession(callback?: (session: Pick<AgentSession, keyof AgentSession>) => Promise<void>): void;
    dispose(): Promise<void>;
    newSession(options?: Parameters<AgentSessionRuntime["newSession"]>[0]): ReturnType<AgentSessionRuntime["newSession"]>;
    fork(entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1]): ReturnType<AgentSessionRuntime["fork"]>;
    switchSession(sessionPath: string, options?: Parameters<AgentSessionRuntime["switchSession"]>[1]): ReturnType<AgentSessionRuntime["switchSession"]>;
    importFromJsonl(inputPath: string, cwdOverride?: string): ReturnType<AgentSessionRuntime["importFromJsonl"]>;
    remotePorts: {
        projectTrust: InteractiveModeProjectTrustPort;
        authMetadata: InteractiveModeAuthMetadataPort;
    };
};
/**
 * Options for InteractiveMode initialization.
 */`,
  ],
  [
    "constructor(runtimeHost: AgentSessionRuntime, options?: InteractiveModeOptions);",
    "constructor(runtimeHost: AgentSessionRuntime | RemoteInteractiveModeRuntime, options?: InteractiveModeOptions);",
  ],
]);

console.log(`Patched pinned InteractiveMode remote trust port in ${packageRoot}`);
