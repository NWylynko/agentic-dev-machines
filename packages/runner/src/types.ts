export type WorkspaceConfig = {
  id: string;
  name: string;
  role: "coding" | "bot";
  environment: "kubernetes" | "local";
  namespace?: string;
  container?: string;
  cwd?: string;
  localRoot?: string;
  kubectl?: string;
  remoteEnv?: string;
  model?: { provider: string; id: string };
  allowedAgents?: string[];
  /** Runner-managed flag persisted only for newly registered bot conversations. */
  onboardingRequired?: boolean;
  mcpServers?: {
    id: string;
    command: string;
    args?: string[];
    tools: string[];
    secretEnv?: Record<string, string>;
  }[];
};
export type RunnerEvent = {
  seq: number;
  workspaceId: string;
  kind: "user" | "assistant" | "tool" | "message" | "status";
  data: Record<string, unknown>;
  timestamp: string;
};
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const workspaceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
