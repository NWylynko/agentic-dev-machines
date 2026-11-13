// TASK-81: in a workspace with /repos, paths git ignores inside a checkout
// (node_modules, build output, .env, local databases) live on node-local disk
// and are deleted whenever the Pod is replaced. Coding agents are told, so they
// recreate them rather than assume they persist. image/adm-claude tells Claude
// Code the same.
import { defineExtension } from "@earendil-works/pi-durable";

export const IGNORED_FILES_NOTE =
  "Files git ignores inside /repos checkouts (node_modules, build output, .env, local databases) are kept on this machine's local disk, not with the workspace: they are deleted whenever this workspace's Pod is replaced (updates, moves to another node). When they are missing, reinstall dependencies and recreate ignored files such as .env. Put anything that must survive in a file git does not ignore.";

export const ignoredFilesExtension = defineExtension({
  name: "ignored-files",
  sections: [{ key: "ignored-files", render: () => IGNORED_FILES_NOTE }],
});
