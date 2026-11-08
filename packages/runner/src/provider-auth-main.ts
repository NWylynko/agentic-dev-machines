import { createServer } from "node:http";
import { parseArgs } from "node:util";
import {
  createOwnerEpochGuard,
  createProviderAuthAuthority,
} from "./provider-auth-authority.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "7434" },
    "probe-port": { type: "string", default: "7435" },
    "lifecycle-url": { type: "string", default: "http://127.0.0.1:7433" },
    "auth-path": {
      type: "string",
      default: "/var/lib/adm/provider-auth/auth.json",
    },
  },
});
const authority = await createProviderAuthAuthority({
  authPath: values["auth-path"]!,
  ownerGuard: createOwnerEpochGuard(
    async () => {
      try {
        // A 503 still names the owner when only the lifecycle's database is
        // failing; a 503 for a lost Lease names none.
        const response = await fetch(`${values["lifecycle-url"]}/health`);
        const health = (await response.json()) as { ownerEpoch?: unknown };
        return typeof health.ownerEpoch === "number" ? health.ownerEpoch : undefined;
      } catch {
        return undefined;
      }
    },
    // This authority can never serve again, and its liveness probe stays green,
    // so exit: kubelet restarts the container against the current owner.
    () => {
      console.error("provider-auth exiting: the lifecycle owner changed or stopped answering");
      process.exit(1);
    },
  ),
});
authority.server.listen(Number(values.port), values.host);
// Kubelet probes connect to the Pod IP, but the authority (credentials) is
// loopback-only. This listener answers only liveness: a running event loop.
// It does not consult the lifecycle owner, so a slow lifecycle cannot get
// provider-auth restarted (TASK-94).
const providerAuthLivenessServer = createServer((request, response) => {
  const live = request.method === "GET" && request.url === "/health";
  response.writeHead(live ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(live ? { status: "live" } : { status: "not_found" }));
});
providerAuthLivenessServer.listen(Number(values["probe-port"]), "0.0.0.0", () =>
  console.log(`provider-auth liveness listening on 0.0.0.0:${values["probe-port"]}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    providerAuthLivenessServer.close();
    void authority.close();
  });
