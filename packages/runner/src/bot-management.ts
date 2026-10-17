import { readFile } from "node:fs/promises";

type RuntimeWorkspace = {
  id: string;
  name: string;
  role: "coding";
  phase: string;
  namespace: string;
  runtime_status?: {
    podIP?: string;
    ready?: boolean;
    activity?: { status?: string; error?: string };
  };
};

export type BotAgentManagement = {
  list(signal?: AbortSignal): Promise<RuntimeWorkspace[]>;
  status(id: string, signal?: AbortSignal): Promise<unknown>;
  history(
    id: string,
    after: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  prompt(
    id: string,
    message: string,
    requestId: string,
    whenBusy: "steer" | "followUp" | "reject",
    signal?: AbortSignal,
  ): Promise<unknown>;
  resume(id: string, signal?: AbortSignal): Promise<unknown>;
  abort(
    id: string,
    background: boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
  saveGoal(
    id: string,
    value: unknown,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  saveLoop(
    id: string,
    value: unknown,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  changeModel(
    id: string,
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  createAgent(
    operationId: string,
    spec: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  destroyAgent(
    operationId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

export function botAgentManagementFromEnvironment(config: {
  lifecycleUrl?: string;
  tokenFile?: string;
  runtimePort?: string;
}): BotAgentManagement {
  const lifecycleUrl = config.lifecycleUrl?.trim();
  const tokenFile = config.tokenFile;
  const runtimePort = Number(config.runtimePort ?? 7432);
  if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535)
    throw new Error("ADM_RUNTIME_PORT must be a valid TCP port");

  async function token() {
    if (!tokenFile)
      throw new Error(
        "Runner --token-file is required for bot agent management",
      );
    const value = (await readFile(tokenFile, "utf8")).trim();
    if (!value || value.includes("\n"))
      throw new Error("Projected lifecycle identity token is empty or invalid");
    return value;
  }

  async function request(
    url: string | undefined,
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ) {
    if (!url)
      throw new Error("ADM_LIFECYCLE_URL is required for bot agent management");
    const response = await fetch(new URL(path, url), {
      method,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let value: unknown = {};
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${path} returned invalid JSON`);
      }
    }
    if (!response.ok) {
      const detail =
        value && typeof value === "object" && "error" in value
          ? (value as { error?: { message?: unknown } }).error?.message
          : undefined;
      throw new Error(
        `${method} ${path} failed with HTTP ${response.status}${typeof detail === "string" ? `: ${detail}` : ""}`,
      );
    }
    return value;
  }

  async function target(
    id: string,
    action: string,
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const encodedId = encodeURIComponent(id);
    await request(
      lifecycleUrl,
      `/v1/workspaces/${encodedId}/runtime/authorize`,
      "POST",
      { action },
      signal,
    );
    const directory = await request(
      lifecycleUrl,
      "/v1/runtime/workspaces",
      "GET",
      undefined,
      signal,
    );
    if (!Array.isArray(directory))
      throw new Error(
        "Lifecycle runtime directory returned an invalid response",
      );
    const workspace = directory.find(
      (entry): entry is RuntimeWorkspace =>
        !!entry &&
        typeof entry === "object" &&
        (entry as RuntimeWorkspace).id === id,
    );
    const podIP = workspace?.runtime_status?.podIP;
    if (!podIP)
      throw new Error(`Coding workspace ${id} has no routable Pod IP`);
    const host = podIP.includes(":") ? `[${podIP}]` : podIP;
    return request(
      `http://${host}:${runtimePort}`,
      `/v1/workspaces/${encodedId}${path}`,
      method,
      body,
      signal,
    );
  }

  return {
    async list(signal) {
      const value = await request(
        lifecycleUrl,
        "/v1/runtime/workspaces",
        "GET",
        undefined,
        signal,
      );
      if (!Array.isArray(value))
        throw new Error(
          "Lifecycle runtime directory returned an invalid response",
        );
      return value as RuntimeWorkspace[];
    },
    status: (id, signal) => target(id, "read", "", "GET", undefined, signal),
    history: (id, after, limit, signal) =>
      target(
        id,
        "read",
        `/history?after=${after}&limit=${limit}&diagnostics=true`,
        "GET",
        undefined,
        signal,
      ),
    prompt: (id, message, requestId, whenBusy, signal) =>
      target(
        id,
        "prompt",
        "/input",
        "POST",
        { message, requestId, whenBusy },
        signal,
      ),
    resume: (id, signal) => target(id, "resume", "/resume", "POST", {}, signal),
    abort: (id, background, signal) =>
      target(id, "abort", "/abort", "POST", { background }, signal),
    saveGoal: (id, value, requestId, signal) =>
      target(id, "goal", "/goals", "POST", { requestId, value }, signal),
    saveLoop: (id, value, requestId, signal) =>
      target(id, "loop", "/loops", "POST", { requestId, value }, signal),
    changeModel: (id, provider, modelId, signal) =>
      target(id, "model", "/model", "PUT", { provider, modelId }, signal),
    createAgent: (operationId, spec, signal) =>
      request(
        lifecycleUrl,
        "/v1/runtime/operations",
        "POST",
        { operationId, kind: "create", spec },
        signal,
      ),
    destroyAgent: (operationId, workspaceId, signal) =>
      request(
        lifecycleUrl,
        "/v1/runtime/operations",
        "POST",
        { operationId, kind: "delete", workspaceId },
        signal,
      ),
  };
}
