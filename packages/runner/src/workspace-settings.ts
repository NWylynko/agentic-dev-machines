import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessSettings, QueueMode } from "@earendil-works/pi-durable";
import { ApiError } from "./types.ts";

export type WorkspaceBehaviorSettingsValue = {
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  autoCompact: boolean;
};

export type WorkspaceSettingsPatch = Partial<WorkspaceBehaviorSettingsValue> & {
  thinkingLevel?: string;
  sessionName?: string;
};

export const defaultWorkspaceBehaviorSettings: WorkspaceBehaviorSettingsValue =
  {
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompact: true,
  };

const thinkingLevels = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function parseWorkspaceSettingsPatch(
  value: unknown,
): WorkspaceSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidSettings();
  const data = value as Record<string, unknown>;
  const allowed = new Set([
    "thinkingLevel",
    "steeringMode",
    "followUpMode",
    "autoCompact",
    "sessionName",
  ]);
  const keys = Object.keys(data);
  if (!keys.length || keys.some((key) => !allowed.has(key)))
    throw invalidSettings();

  const patch: WorkspaceSettingsPatch = {};
  if ("sessionName" in data) {
    if (
      typeof data.sessionName !== "string" ||
      data.sessionName.length > 200 ||
      /[\x00-\x1f\x7f]/.test(data.sessionName)
    )
      throw invalidSettings();
    patch.sessionName = data.sessionName;
  }
  if ("thinkingLevel" in data) {
    if (
      typeof data.thinkingLevel !== "string" ||
      !thinkingLevels.has(data.thinkingLevel)
    )
      throw invalidSettings();
    patch.thinkingLevel = data.thinkingLevel;
  }
  if ("steeringMode" in data) {
    if (!isQueueMode(data.steeringMode)) throw invalidSettings();
    patch.steeringMode = data.steeringMode;
  }
  if ("followUpMode" in data) {
    if (!isQueueMode(data.followUpMode)) throw invalidSettings();
    patch.followUpMode = data.followUpMode;
  }
  if ("autoCompact" in data) {
    if (typeof data.autoCompact !== "boolean") throw invalidSettings();
    patch.autoCompact = data.autoCompact;
  }
  return patch;
}

export class WorkspaceBehaviorSettings {
  private value: WorkspaceBehaviorSettingsValue;
  readonly harness: HarnessSettings;
  private readonly path: string;
  private readonly assertActive: () => Promise<void>;

  private constructor(
    directory: string,
    value: WorkspaceBehaviorSettingsValue,
    assertActive: () => Promise<void>,
  ) {
    this.path = join(directory, "adm-settings.json");
    this.value = value;
    this.assertActive = assertActive;
    const current = this;
    this.harness = {
      get steeringMode() {
        return current.value.steeringMode;
      },
      get followUpMode() {
        return current.value.followUpMode;
      },
      get compaction() {
        return { enabled: current.value.autoCompact };
      },
    };
  }

  static async open(directory: string, assertActive: () => Promise<void>) {
    const path = join(directory, "adm-settings.json");
    let value = defaultWorkspaceBehaviorSettings;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      value = validateSavedSettings(parsed);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return new WorkspaceBehaviorSettings(directory, value, assertActive);
  }

  get current() {
    return { ...this.value };
  }

  async update(patch: WorkspaceSettingsPatch) {
    if (
      patch.steeringMode === undefined &&
      patch.followUpMode === undefined &&
      patch.autoCompact === undefined
    )
      return this.current;
    const next: WorkspaceBehaviorSettingsValue = {
      ...this.value,
      ...(patch.steeringMode === undefined
        ? {}
        : { steeringMode: patch.steeringMode }),
      ...(patch.followUpMode === undefined
        ? {}
        : { followUpMode: patch.followUpMode }),
      ...(patch.autoCompact === undefined
        ? {}
        : { autoCompact: patch.autoCompact }),
    };
    await writePrivateJson(this.path, next, this.assertActive);
    this.value = next;
    return this.current;
  }
}

function isQueueMode(value: unknown): value is QueueMode {
  return value === "all" || value === "one-at-a-time";
}

function validateSavedSettings(value: unknown): WorkspaceBehaviorSettingsValue {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isQueueMode((value as Record<string, unknown>).steeringMode) ||
    !isQueueMode((value as Record<string, unknown>).followUpMode) ||
    typeof (value as Record<string, unknown>).autoCompact !== "boolean" ||
    Object.keys(value).some(
      (key) => !["steeringMode", "followUpMode", "autoCompact"].includes(key),
    )
  )
    throw new Error("Workspace settings file is invalid");
  return value as WorkspaceBehaviorSettingsValue;
}

async function writePrivateJson(
  path: string,
  value: unknown,
  assertActive: () => Promise<void>,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await assertActive();
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function invalidSettings() {
  return new ApiError(
    400,
    "INVALID_SETTINGS",
    "Settings must contain supported thinkingLevel, steeringMode, followUpMode, autoCompact, or sessionName values",
  );
}
