import { mkdir, readFile, chmod } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
  type PromptTemplate,
  type Skill,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import { ApiError, type WorkspaceConfig } from "./types.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { LoadedPiExtension } from "./extensions.ts";

export type WorkspaceResourceSnapshot = {
  cwd: string;
  trust: { trusted: boolean; trustRequired: boolean; source: string | null };
  themes: {
    name: string;
    path: string;
    sourceInfo?: SourceInfo;
    json: unknown;
  }[];
  prompts: PromptTemplate[];
  skills: (Skill & { content: string })[];
  agentsFiles: { path: string; content: string }[];
  extensions: {
    name: string;
    path: string;
    active: boolean;
    tools: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
    }[];
    commands: { name: string; path: string; description?: string }[];
    shortcuts: { name: string; key: string; description?: string }[];
  }[];
  diagnostics: { type: string; message: string; path?: string }[];
  systemPrompt?: string;
  systemPromptSource?: { path: string };
  appendSystemPrompt: string[];
  appendSystemPromptSources: { path: string }[];
};

/** Discovers workspace resources and loads extension code only under persisted project trust. */
export class WorkspaceResources {
  private snapshot?: WorkspaceResourceSnapshot;
  private loadedExtensions: LoadedPiExtension[] = [];
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly assertActive: () => Promise<void>;

  constructor(
    config: WorkspaceConfig,
    sessionDirectory: string,
    assertActive: () => Promise<void> = async () => {},
  ) {
    if (config.role !== "coding")
      throw new ApiError(
        403,
        "CODING_RESOURCES_REQUIRED",
        "Bots cannot inspect coding resources or change project trust",
      );
    if (config.environment === "kubernetes")
      throw new ApiError(
        409,
        "POD_RESOURCES_REQUIRED",
        "Resource discovery must run inside the owning workspace Pod",
      );
    this.cwd = config.cwd ?? config.localRoot!;
    this.agentDir = join(sessionDirectory, "pi");
    this.assertActive = assertActive;
  }

  trust(): WorkspaceResourceSnapshot["trust"] {
    const source = new ProjectTrustStore(this.agentDir).getEntry(this.cwd);
    const trustRequired = hasTrustRequiringProjectResources(this.cwd);
    return {
      trusted: source?.decision ?? !trustRequired,
      trustRequired,
      source: source?.path ?? null,
    };
  }

  async get() {
    return this.snapshot ?? this.reload();
  }

  extensions() {
    return this.loadedExtensions;
  }

  async requestMessages(
    input: readonly Message[],
  ): Promise<readonly Message[]> {
    const resources = await this.get();
    const extra = [
      ...resources.agentsFiles.map(
        (file) => `# ${file.path}\n\n${file.content}`,
      ),
      ...resources.appendSystemPrompt,
      formatSkillsForPrompt(resources.skills),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (resources.systemPrompt === undefined && !extra) return input;
    const messages = [...input];
    const leading = messages[0]?.role === "system" ? messages[0] : undefined;
    const base =
      resources.systemPrompt ??
      (leading
        ? typeof leading.content === "string"
          ? leading.content
          : leading.content.map((part) => part.text).join("\n")
        : "");
    const system: Message = {
      ...leading,
      role: "system",
      content: [base, extra].filter(Boolean).join("\n\n"),
      timestamp: leading?.timestamp ?? 0,
    };
    if (leading) messages[0] = system;
    else messages.unshift(system);
    return messages;
  }

  async setTrust(trusted: boolean) {
    return this.setTrustUpdates([{ path: this.cwd, decision: trusted }]);
  }

  async setTrustUpdates(updates: { path: string; decision: boolean | null }[]) {
    if (
      !updates.length ||
      updates.length > 16 ||
      updates.some(
        (update) =>
          !update ||
          typeof update.path !== "string" ||
          !isAbsolute(update.path) ||
          update.path.includes("\0") ||
          (update.decision !== true &&
            update.decision !== false &&
            update.decision !== null) ||
          !(
            this.cwd === resolve(update.path) ||
            this.cwd.startsWith(resolve(update.path).replace(/\/$/, "") + sep)
          ),
      )
    )
      throw new ApiError(
        400,
        "INVALID_TRUST",
        "Trust updates must select this workspace cwd or its ancestors with boolean or null decisions",
      );
    await this.prepare();
    await this.assertActive();
    new ProjectTrustStore(this.agentDir).setMany(updates);
    await chmod(join(this.agentDir, "trust.json"), 0o600);
    return this.reload();
  }

  private async prepare() {
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    await chmod(this.agentDir, 0o700);
  }

  async reload(): Promise<WorkspaceResourceSnapshot> {
    this.snapshot = undefined;
    await this.prepare();
    const trust = this.trust();
    const settingsManager = SettingsManager.create(this.cwd, this.agentDir, {
      projectTrusted: trust.trusted,
    });
    const packages = new DefaultPackageManager({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager,
    });
    // Discovery must not install a missing configured package as a side effect of reading a screen.
    const resolved = await packages.resolve(async () => "error");
    await this.assertActive();
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: !trust.trusted,
    });
    await loader.reload();
    const skills = loader.getSkills();
    const prompts = loader.getPrompts();
    const themes = loader.getThemes();
    const loaded = trust.trusted ? loader.getExtensions() : undefined;
    this.loadedExtensions =
      (loaded?.extensions as unknown as LoadedPiExtension[] | undefined) ?? [];
    const extensions = loaded
      ? loaded.extensions.map((extension) => ({
          name: basename(extension.path),
          path: extension.path,
          active: true,
          tools: [...extension.tools.values()].map(({ definition: tool }) => ({
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
          })),
          commands: [...extension.commands.values()].map((command) => ({
            name: command.name,
            path: command.name,
            ...(command.description
              ? { description: command.description }
              : {}),
          })),
          shortcuts: [...extension.shortcuts.values()].map((shortcut) => ({
            name: `${extension.path}:${shortcut.shortcut}`,
            key: shortcut.shortcut,
            ...(shortcut.description ? { description: shortcut.description } : {}),
          })),
        }))
      : resolved.extensions
          .filter((extension) => extension.enabled)
          .map((extension) => ({
            name: basename(extension.path),
            path: extension.path,
            active: false,
            tools: [],
            commands: [],
            shortcuts: [],
          }));
    const diagnostics = [
      ...skills.diagnostics,
      ...prompts.diagnostics,
      ...themes.diagnostics,
    ];
    for (const error of settingsManager.drainErrors())
      diagnostics.push({
        type: "error",
        message: error.error.message,
        path: error.path,
      });
    for (const error of loaded?.errors ?? [])
      diagnostics.push({
        type: "error",
        message: error.error,
        path: error.path,
      });
    if (extensions.some((extension) => !extension.active))
      diagnostics.push({
        type: "warning",
        message:
          "Workspace extensions are inactive until this project is trusted.",
      });
    if (loaded?.warnings)
      for (const warning of loaded.warnings)
        diagnostics.push({
          type: "warning",
          message: warning.warning,
          path: warning.path,
        });
    for (const extension of loaded?.extensions ?? []) {
      const unsupported: string[] = [];
      const supportedHooks = new Set(["context", "tool_call", "tool_result"]);
      const unsupportedHooks = [...extension.handlers.keys()].filter(
        (name) => !supportedHooks.has(name),
      );
      if (unsupportedHooks.length)
        unsupported.push(`hooks (${unsupportedHooks.join(", ")})`);
      if (extension.flags.size) unsupported.push("CLI flags");
      if (unsupported.length)
        diagnostics.push({
          type: "warning",
          message: `Extension ${basename(extension.path)} registered unsupported capabilities: ${unsupported.join(", ")}. Durable activation supports tools, commands, remote UI requests, keyboard shortcuts, and hooks: ${[...supportedHooks].join(", ")}.`,
          path: extension.path,
        });
    }
    const snapshot: WorkspaceResourceSnapshot = {
      cwd: this.cwd,
      trust,
      themes: await Promise.all(
        themes.themes.map(async (theme) => {
          if (!theme.name || !theme.sourcePath)
            throw new Error(
              "Workspace theme is missing its name or source file",
            );
          return {
            name: theme.name,
            path: theme.sourcePath,
            sourceInfo: theme.sourceInfo,
            json: JSON.parse(
              await readFile(theme.sourcePath, "utf8"),
            ) as unknown,
          };
        }),
      ),
      prompts: prompts.prompts,
      skills: await Promise.all(
        skills.skills.map(async (skill) => ({
          ...skill,
          content: await readFile(skill.filePath, "utf8"),
        })),
      ),
      agentsFiles: loader.getAgentsFiles().agentsFiles,
      extensions,
      diagnostics,
      ...(loader.getSystemPrompt() === undefined
        ? {}
        : { systemPrompt: loader.getSystemPrompt() }),
      systemPromptSource: loader.getSystemPromptSource(),
      appendSystemPrompt: loader.getAppendSystemPrompt(),
      appendSystemPromptSources: loader.getAppendSystemPromptSources(),
    };
    this.snapshot = snapshot;
    return snapshot;
  }
}
