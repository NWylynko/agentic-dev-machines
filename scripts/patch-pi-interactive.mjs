#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Reproducible minimal patch to MIT-licensed @earendil-works/pi-coding-agent 1.2.0.
// Its upstream LICENSE is preserved in dependency installs and release archives.

const packageRoot = resolve(
  process.argv[2] ?? "node_modules/@earendil-works/pi-coding-agent",
);
const manifest = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
if (
  manifest.name !== "@earendil-works/pi-coding-agent" ||
  manifest.version !== "1.2.0"
)
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
    `const [fdPath] = await Promise.all([
            ensureTool("fd", (status) => this.showManagedToolStatus(status)),
            ensureTool("rg", (status) => this.showManagedToolStatus(status)),
        ]);`,
    `const [fdPath] = this.runtimeHost.remotePorts?.isRemote ? [undefined] : await Promise.all([
            ensureTool("fd", (status) => this.showManagedToolStatus(status)),
            ensureTool("rg", (status) => this.showManagedToolStatus(status)),
        ]);`,
  ],
  [
    'rawKeyHint("!", "to run bash"),',
    '...(this.runtimeHost.remotePorts?.supportsBash === false ? [] : [rawKeyHint("!", "to run bash")]),',
  ],
  [
    '...(this.runtimeHost.remotePorts?.isRemote ? [] : [rawKeyHint("!", "to run bash")]),',
    '...(this.runtimeHost.remotePorts?.supportsBash === false ? [] : [rawKeyHint("!", "to run bash")]),',
    0,
  ],
  [
    'rawKeyHint("!!", "to run bash (no context)"),',
    '...(this.runtimeHost.remotePorts?.supportsBash === false ? [] : [rawKeyHint("!!", "to run bash (no context)")]),',
  ],
  [
    '...(this.runtimeHost.remotePorts?.isRemote ? [] : [rawKeyHint("!!", "to run bash (no context)")]),',
    '...(this.runtimeHost.remotePorts?.supportsBash === false ? [] : [rawKeyHint("!!", "to run bash (no context)")]),',
    0,
  ],
  [
    'rawKeyHint("!", "bash"),',
    '...(this.runtimeHost.remotePorts?.supportsBash === false ? [] : [rawKeyHint("!", "bash")]),',
  ],
  [
    '...(this.runtimeHost.remotePorts?.isRemote ? [] : [rawKeyHint("!", "bash")]),',
    '...(this.runtimeHost.remotePorts?.supportsBash === false ? [] : [rawKeyHint("!", "bash")]),',
    0,
  ],
  [
    `checkForNewPiVersion(this.version).then((newRelease) => {
            if (newRelease) {
                this.showNewVersionNotification(newRelease);
            }
        });`,
    `if (!this.runtimeHost.remotePorts?.isRemote) {
            checkForNewPiVersion(this.version).then((newRelease) => {
                if (newRelease) {
                    this.showNewVersionNotification(newRelease);
                }
            });
        }`,
  ],
  [
    `this.checkForPackageUpdates()
            .then((updates) => {`,
    `Promise.resolve(this.runtimeHost.remotePorts?.isRemote ? [] : this.checkForPackageUpdates())
            .then((updates) => {`,
  ],
  [
    "const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);",
    "const trustStore = this.runtimeHost.remotePorts?.projectTrust ?? new ProjectTrustStore(this.runtimeHost.services.agentDir);",
    2,
  ],
  ["onSelect: (selection) => {", "onSelect: async (selection) => {"],
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
  ["trustStore.set(cwd, true);", "await trustStore.set(cwd, true);"],
  [
    "const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();",
    "const savedImplicitProjectTrust = await this.maybeSaveImplicitProjectTrustAfterReload();",
  ],
  [
    "if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {",
    "if (this.settingsManager.isProjectTrusted() || !(this.runtimeHost.remotePorts?.projectTrust ? this.runtimeHost.remotePorts.projectTrust.hasTrustRequiringResources(this.sessionManager.getCwd()) : hasTrustRequiringProjectResources(this.sessionManager.getCwd()))) {",
  ],
  [
    "this.settingsManager.isProjectTrusted()",
    "isProjectTrusted(this.runtimeHost, this.sessionManager, this.settingsManager)",
    4,
  ],
  [
    "this.restoreQueuedMessagesToEditor({ abort: true });",
    'void this.restoreQueuedMessagesToEditor({ abort: true }).catch((error) => this.showError(`Failed to restore queued messages: ${error instanceof Error ? error.message : String(error)}`));',
    3,
  ],
  [
    'this.restoreQueuedMessagesToEditor();\n                    await this.session.abort();',
    'await this.restoreQueuedMessagesToEditor();\n                    await this.session.abort();',
  ],
  [
    'const restored = this.restoreQueuedMessagesToEditor();',
    'const restored = await this.restoreQueuedMessagesToEditor();',
  ],
  [
    'this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());',
    'this.defaultEditor.onAction("app.message.dequeue", () => { void this.handleDequeue(); });',
  ],
  [
    'handleDequeue() {\n        const restored = this.restoreQueuedMessagesToEditor();',
    'async handleDequeue() {\n        const restored = await this.restoreQueuedMessagesToEditor();',
  ],
  ["clearAllQueues() {", "async clearAllQueues() {"],
  [
    "const { steering, followUp } = this.session.clearQueue();",
    "const { steering, followUp } = await this.session.clearQueue();",
  ],
  [
    "restoreQueuedMessagesToEditor(options) {\n        const { steering, followUp } = this.clearAllQueues();",
    "async restoreQueuedMessagesToEditor(options) {\n        const { steering, followUp } = await this.clearAllQueues();",
  ],
  [
    "this.session.clearQueue();\n            this.compactionQueuedMessages = queuedMessages;",
    'void this.session.clearQueue().catch((clearError) => this.showError(`Failed to restore queue after compaction error: ${clearError instanceof Error ? clearError.message : String(clearError)}`));\n            this.compactionQueuedMessages = queuedMessages;',
  ],
  [
    "function isEmbeddedStatus(editor) {",
    `function isProjectTrusted(runtimeHost, sessionManager, settingsManager) {
    if (runtimeHost.remotePorts?.projectTrust) {
        return runtimeHost.remotePorts.projectTrust.get(sessionManager.getCwd()) === true;
    }
    return settingsManager.isProjectTrusted();
}
function isEmbeddedStatus(editor) {`,
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
  [
    "(onProgress, signal) => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, signal)",
    "(onProgress, signal) => this.runtimeHost.remotePorts?.isRemote ? this.runtimeHost.listSessions() : SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, signal)",
  ],
  [
    "(onProgress, signal) => this.sessionManager.usesDefaultSessionDir()\n                ? SessionManager.listAll(onProgress, signal)\n                : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal)",
    "(onProgress, signal) => this.runtimeHost.remotePorts?.isRemote ? this.runtimeHost.listSessions() : this.sessionManager.usesDefaultSessionDir()\n                ? SessionManager.listAll(onProgress, signal)\n                : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal)",
  ],
  [
    '    async showOAuthSelector(mode) {\n        if (mode === "login") {',
    '    async showOAuthSelector(mode) {\n        if (mode === "login" && this.runtimeHost.remotePorts?.authActions) {\n            this.ui.stop();\n            try {\n                await this.runtimeHost.remotePorts.authActions.login();\n                await this.updateAvailableProviderCount();\n                this.showStatus("Provider authentication updated");\n            }\n            catch (error) {\n                this.showError(`Provider login failed: ${error instanceof Error ? error.message : String(error)}`);\n            }\n            finally {\n                this.ui.start();\n            }\n            return;\n        }\n        if (mode === "login") {',
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
    hasTrustRequiringResources(cwd: string): boolean;
}
/** Nonsecret provider classification used by remote InteractiveMode. */
export interface InteractiveModeAuthMetadataPort {
    isAnthropicSubscription(): boolean | Promise<boolean>;
}
/** Durable-backed session surface consumed by the pinned InteractiveMode implementation. */
export type RemoteInteractiveModeSession = {
    agent: object;
    sessionManager: Pick<SessionManager, "getCwd" | "getSessionName" | "getSessionFile" | "getSessionDir" | "usesDefaultSessionDir" | "getSessionId" | "getEntries" | "getEntryCount" | "getLeafId" | "getLeafEntry" | "getBranch" | "buildContextEntries" | "getTree">;
    settingsManager: AgentSession["settingsManager"];
    modelRuntime: object;
    resourceLoader: object;
    extensionRunner: object;
    scopedModels: ReadonlyArray<{ model: import("@earendil-works/pi-ai").Model<any>; thinkingLevel?: import("@earendil-works/pi-agent-core").ThinkingLevel }>;
    setScopedModels(models: Array<{ model: import("@earendil-works/pi-ai").Model<any>; thinkingLevel?: import("@earendil-works/pi-agent-core").ThinkingLevel }>): void | Promise<void>;
    clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
};
/** Remote runtime surface that preserves the Pi session API without owning a Pi session. */
export type RemoteInteractiveModeRuntime = {
    session: RemoteInteractiveModeSession;
    services: Pick<AgentSessionServices, "agentDir">;
    setBeforeSessionInvalidate(callback?: () => void): void;
    setRebindSession(callback?: (session: RemoteInteractiveModeSession) => Promise<void>): void;
    dispose(): Promise<void>;
    newSession(options?: Parameters<AgentSessionRuntime["newSession"]>[0]): ReturnType<AgentSessionRuntime["newSession"]>;
    fork(entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1]): ReturnType<AgentSessionRuntime["fork"]>;
    switchSession(sessionPath: string, options?: Parameters<AgentSessionRuntime["switchSession"]>[1]): ReturnType<AgentSessionRuntime["switchSession"]>;
    importFromJsonl(inputPath: string, cwdOverride?: string): ReturnType<AgentSessionRuntime["importFromJsonl"]>;
    listSessions(): Promise<import("../../core/session-manager.ts").SessionInfo[]>;
    remotePorts: {
        isRemote: true;
        projectTrust: InteractiveModeProjectTrustPort;
        authMetadata: InteractiveModeAuthMetadataPort;
        authActions: { login(): Promise<void> };
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

await patch("dist/modes/interactive/theme/theme.js", [
  [
    `export function loadThemeFromPath(themePath, mode) {
    const content = fs.readFileSync(themePath, "utf-8");
    const themeJson = parseThemeJsonContent(themePath, content);
    return createTheme(themeJson, mode, themePath);
}`,
    `export function loadThemeFromPath(themePath, mode) {
    const content = fs.readFileSync(themePath, "utf-8");
    const themeJson = parseThemeJsonContent(themePath, content);
    return createTheme(themeJson, mode, themePath);
}
/** Create an upstream Pi theme from Pod-provided JSON without reading a local file. */
export function createThemeFromJson(json, mode, sourcePath, sourceInfo) {
    const theme = createTheme(parseThemeJson(sourcePath ?? "remote theme", json), mode, sourcePath);
    theme.sourceInfo = sourceInfo;
    return theme;
}`,
  ],
]);

await patch("dist/modes/interactive/theme/theme.d.ts", [
  [
    "export declare function loadThemeFromPath(themePath: string, mode?: TerminalColorMode): Theme;",
    "export declare function loadThemeFromPath(themePath: string, mode?: TerminalColorMode): Theme;\n/** Create a Pi theme from trusted remote JSON without reading the local filesystem. */\nexport declare function createThemeFromJson(json: unknown, mode?: TerminalColorMode, sourcePath?: string, sourceInfo?: SourceInfo): Theme;",
  ],
]);

await patch("dist/core/export-html/index.js", [
  [
    "function generateHtml(sessionData, themeName) {",
    "export function renderSessionHtml(sessionData, themeName) {",
  ],
  ["generateHtml(sessionData, opts.themeName)", "renderSessionHtml(sessionData, opts.themeName)", 2],
]);
await patch("dist/core/export-html/index.d.ts", [
  [
    "export declare function exportSessionToHtml(",
    "export declare function renderSessionHtml(sessionData: unknown, themeName?: string): string;\nexport declare function exportSessionToHtml(",
  ],
]);
for (const path of ["dist/index.js", "dist/index.d.ts"]) {
  const sourceMap = path.endsWith(".js") ? "//# sourceMappingURL=index.js.map" : "//# sourceMappingURL=index.d.ts.map";
  await patch(path, [[sourceMap, `export { renderSessionHtml } from "./core/export-html/index.js";\n${sourceMap}`]]);
}

for (const path of ["dist/index.js", "dist/index.d.ts"]) {
  await patch(path, [
    [
      "getLanguageFromPath, getMarkdownTheme, getSelectListTheme, getSettingsListTheme, highlightCode, initTheme, Theme,",
      "createThemeFromJson, getLanguageFromPath, getMarkdownTheme, getSelectListTheme, getSettingsListTheme, highlightCode, initTheme, Theme,",
    ],
  ]);
}

console.log(
  `Patched pinned InteractiveMode remote trust port in ${packageRoot}`,
);
