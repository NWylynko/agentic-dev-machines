import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

type AuthorityOptions = {
  authPath: string;
  configure?: (runtime: any) => void;
};
type LoginOperation = {
  controller: AbortController;
  events: unknown[];
  waiters: ((value: unknown | undefined) => void)[];
  prompts: Map<string, (value: string) => void>;
};

function send(response: ServerResponse, status: number, value?: unknown) {
  response.writeHead(
    status,
    value === undefined ? {} : { "content-type": "application/json" },
  );
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cleanPrompt(prompt: AuthPrompt): Omit<AuthPrompt, "signal"> {
  const { signal: _signal, ...safe } = prompt;
  return safe;
}

export async function createProviderAuthAuthority({
  authPath,
  configure,
}: AuthorityOptions) {
  const authDirectory = dirname(authPath);
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(authDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
    throw new Error("Provider auth directory must be a real directory");
  await chmod(authDirectory, 0o700);
  try {
    const authInfo = await lstat(authPath);
    if (authInfo.isSymbolicLink() || !authInfo.isFile())
      throw new Error("Provider auth store must be a regular file");
    await chmod(authPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    authPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  configure?.(runtime);
  const operations = new Map<string, LoginOperation>();

  function publish(operation: LoginOperation, value: unknown) {
    const waiter = operation.waiters.shift();
    if (waiter) waiter(value);
    else operation.events.push(value);
  }

  function next(
    operation: LoginOperation,
    response: ServerResponse,
  ): Promise<unknown | undefined> {
    const queued = operation.events.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const finish = (value: unknown | undefined) => {
        response.off("close", closed);
        resolve(value);
      };
      const closed = () => {
        const index = operation.waiters.indexOf(finish);
        if (index >= 0) operation.waiters.splice(index, 1);
        finish(undefined);
      };
      operation.waiters.push(finish);
      response.once("close", closed);
    });
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health")
        return send(response, 200, { status: "ok" });
      if (
        request.method === "GET" &&
        url.pathname === "/v1/provider-auth/providers"
      ) {
        const credentials = new Map(
          (await runtime.listCredentials()).map(({ providerId, type }: any) => [
            providerId,
            type,
          ]),
        );
        return send(
          response,
          200,
          runtime.getProviders().map((provider: any) => ({
            provider: provider.id,
            name: provider.name,
            authTypes: [
              ...(provider.auth.apiKey?.login ? ["api_key"] : []),
              ...(provider.auth.oauth ? ["oauth"] : []),
            ],
            authenticated: credentials.get(provider.id) ?? null,
          })),
        );
      }
      const resolveMatch = /^\/v1\/provider-auth\/resolve\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && resolveMatch) {
        const provider = decodeURIComponent(resolveMatch[1]!);
        const resolved = await runtime.getAuth(provider);
        return resolved
          ? send(response, 200, resolved)
          : send(response, 401, {
              error: {
                code: "PROVIDER_AUTH_REQUIRED",
                message: `Provider ${provider} is not authenticated`,
              },
            });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/provider-auth/resolve"
      ) {
        const value = await body(request);
        if (typeof value.provider !== "string" || !value.provider)
          return send(response, 400, {
            error: { code: "INVALID_REQUEST", message: "provider is required" },
          });
        const resolved = await runtime.getAuth(value.provider);
        return resolved
          ? send(response, 200, resolved)
          : send(response, 401, {
              error: {
                code: "PROVIDER_AUTH_REQUIRED",
                message: `Provider ${value.provider} is not authenticated`,
              },
            });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/provider-auth/logout"
      ) {
        const value = await body(request);
        if (typeof value.provider !== "string" || !value.provider)
          return send(response, 400, {
            error: { code: "INVALID_REQUEST", message: "provider is required" },
          });
        await runtime.logout(value.provider);
        return send(response, 200, {});
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/provider-auth/login"
      ) {
        const value = await body(request);
        if (
          typeof value.provider !== "string" ||
          !value.provider ||
          !["api_key", "oauth"].includes(value.type)
        )
          return send(response, 400, {
            error: {
              code: "INVALID_REQUEST",
              message: "provider and a supported auth type are required",
            },
          });
        const id = randomUUID();
        const operation: LoginOperation = {
          controller: new AbortController(),
          events: [],
          waiters: [],
          prompts: new Map(),
        };
        operations.set(id, operation);
        void runtime
          .login(value.provider, value.type as AuthType, {
            signal: operation.controller.signal,
            prompt: async (prompt: AuthPrompt) => {
              const promptId = randomUUID();
              return new Promise<string>((resolve, reject) => {
                operation.prompts.set(promptId, resolve);
                const aborted = () => {
                  operation.prompts.delete(promptId);
                  reject(new Error("login cancelled"));
                };
                operation.controller.signal.addEventListener("abort", aborted, {
                  once: true,
                });
                publish(operation, {
                  type: "prompt",
                  promptId,
                  prompt: cleanPrompt(prompt),
                });
              });
            },
            notify: (event: AuthEvent) => publish(operation, event),
          })
          .then(
            async () => {
              await chmod(authPath, 0o600);
              publish(operation, { type: "complete" });
            },
            (_error: unknown) => {
              publish(operation, {
                type: "error",
                message: "Provider authentication failed",
              });
            },
          );
        return send(response, 202, { operationId: id });
      }
      const operationMatch =
        /^\/v1\/provider-auth\/login\/([0-9a-f-]+)(?:\/(events|reply))?$/.exec(
          url.pathname,
        );
      if (operationMatch) {
        const operation = operations.get(operationMatch[1]!);
        if (!operation)
          return send(response, 404, {
            error: {
              code: "LOGIN_NOT_FOUND",
              message: "login operation not found",
            },
          });
        if (request.method === "DELETE" && !operationMatch[2]) {
          operation.controller.abort();
          operation.prompts.clear();
          for (const waiter of operation.waiters.splice(0)) waiter(undefined);
          operations.delete(operationMatch[1]!);
          return send(response, 200, {});
        }
        if (request.method === "POST" && operationMatch[2] === "reply") {
          const value = await body(request);
          if (
            typeof value.value !== "string" ||
            typeof value.promptId !== "string"
          )
            return send(response, 400, {
              error: {
                code: "INVALID_REQUEST",
                message: "promptId and value are required",
              },
            });
          const resolve = operation.prompts.get(value.promptId);
          if (!resolve)
            return send(response, 409, {
              error: {
                code: "PROMPT_NOT_PENDING",
                message: "prompt is no longer pending",
              },
            });
          operation.prompts.delete(value.promptId);
          resolve(value.value);
          return send(response, 200, {});
        }
        if (request.method === "GET" && operationMatch[2] === "events") {
          const event = await next(operation, response);
          if (event === undefined) return;
          const value = event as { type?: string };
          const terminal = value.type === "complete" || value.type === "error";
          if (terminal) operations.delete(operationMatch[1]!);
          return send(response, 200, { event: value, done: terminal });
        }
      }
      send(response, 404, {
        error: { code: "NOT_FOUND", message: "provider auth route not found" },
      });
    } catch (error) {
      if (!response.headersSent)
        send(response, 400, {
          error: {
            code: "PROVIDER_AUTH_ERROR",
            message: "Provider authentication request failed",
          },
        });
      else response.end();
    }
  });
  return {
    server,
    close: async () => {
      for (const operation of operations.values()) operation.controller.abort();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
