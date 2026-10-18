import { mkdir, readFile, chmod } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
  type PromptTemplate,
  type Skill,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import { ApiError, type WorkspaceConfig } from "./types.ts";

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
  extensions: { name: string; path: string; active: false }[];
  diagnostics: { type: string; message: string; path?: string }[];
  systemPrompt?: string;
  systemPromptSource?: { path: string };
  appendSystemPrompt: string[];
  appendSystemPromptSources: { path: string }[];
};

/** Discovers files in the owning workspace; it never creates an agent/session or activates extension code. */
export class WorkspaceResources {
  private snapshot?: WorkspaceResourceSnapshot;
  private readonly cwd: string;
  private readonly agentDir: string;

  constructor(config: WorkspaceConfig, sessionDirectory: string) {
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
    new ProjectTrustStore(this.agentDir).setMany(updates);
    await chmod(join(this.agentDir, "trust.json"), 0o600);
    return this.reload();
  }

  private async prepare() {
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    await chmod(this.agentDir, 0o700);
  }

  async reload(): Promise<WorkspaceResourceSnapshot> {
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
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
    });
    await loader.reload();
    const skills = loader.getSkills();
    const prompts = loader.getPrompts();
    const themes = loader.getThemes();
    const extensions = resolved.extensions
      .filter((extension) => extension.enabled)
      .map((extension) => ({
        name: basename(extension.path),
        path: extension.path,
        active: false as const,
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
    if (extensions.length)
      diagnostics.push({
        type: "warning",
        message:
          "Discovered extensions are not activated in Durable; extension execution requires the workspace extension bridge.",
      });
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
