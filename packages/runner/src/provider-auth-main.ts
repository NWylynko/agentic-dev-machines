import { parseArgs } from "node:util";
import {
  createOwnerEpochGuard,
  createProviderAuthAuthority,
} from "./provider-auth-authority.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "7434" },
    "auth-path": {
      type: "string",
      default: "/var/lib/adm/provider-auth/auth.json",
    },
  },
});
const authority = await createProviderAuthAuthority({
  authPath: values["auth-path"]!,
  ownerGuard: createOwnerEpochGuard(async () => {
    try {
      const response = await fetch("http://127.0.0.1:7433/health");
      if (!response.ok) return undefined;
      const health = (await response.json()) as { ownerEpoch?: unknown };
      return typeof health.ownerEpoch === "number" ? health.ownerEpoch : undefined;
    } catch {
      return undefined;
    }
  }),
});
authority.server.listen(Number(values.port), values.host);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void authority.close());
