import { parseArgs } from "node:util";
import { createProviderAuthAuthority } from "./provider-auth-authority.ts";

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
});
authority.server.listen(Number(values.port), values.host);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void authority.close());
