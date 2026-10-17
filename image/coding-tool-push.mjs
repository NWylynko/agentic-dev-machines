import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const env = new NodeExecutionEnv({ cwd: `/workspace/${process.argv[2]}` });
const bash = CodingTools.tools.find((tool) => tool.name === "bash");
if (!bash) throw new Error("Pinned CodingTools extension has no bash tool");
const result = await bash.execute(
  { command: "GIT_TERMINAL_PROMPT=0 git push origin HEAD:main" },
  {
    env,
    output() {},
    retainedOutput: () => ({ text: "", truncated: false }),
    diagnostic() {},
  },
  BACKGROUND_CONTEXT,
);
if (result.isError) throw new Error("CodingTools bash push failed");
await env.cleanup(BACKGROUND_CONTEXT);
