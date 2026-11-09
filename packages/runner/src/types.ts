export type WorkspaceConfig = {
  id: string;
  name: string;
  role: "coding" | "bot";
  environment: "kubernetes" | "local" | "pod";
  namespace?: string;
  container?: string;
  cwd?: string;
  localRoot?: string;
  kubectl?: string;
  kubeconfig?: string;
  remoteEnv?: string;
  model?: { provider: string; id: string };
  /** Runner-managed flag persisted only for newly registered bot conversations. */
  onboardingRequired?: boolean;
};
export type RunnerEvent = {
  seq: number;
  workspaceId: string;
  kind: "user" | "assistant" | "tool" | "message" | "status";
  data: Record<string, unknown>;
  timestamp: string;
};
/**
 * Storage policy shared by every ADM Durable document: store a change as a
 * delta, and a complete base once 32 deltas follow the newest one, so a read
 * replays at most 32 changes however long the document lives.
 */
export const admDocCheckpointWhen = (
  _value: unknown,
  _ops: unknown,
  info: { deltasSinceBase: number },
) => info.deltasSinceBase >= 32;
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
